/**
 * sequenceTickLock.test.mjs — **同じ tick を重ねて走らせない**
 *   node --test src/lib/marketing/sequenceTickLock.test.mjs
 *
 * ## なぜ要るか（2026-09-14 の本番実測）
 *
 * `MARKETING_SEQUENCE_MAX_PER_TICK=50` を置いて再開したところ、
 * **1 つの tick 枠で 3 回起動**し、50×3 = **150 名**が積まれた。
 *
 *   07:10:13 / 07:10:35 / 07:10:52 に別々のジョブ（各 50 名）
 *
 * 上限は「1 起動あたり」に効くので、多重起動すると速度制御が効かない
 * （全開なら 500×3 = 1,500 名/tick）。`cron-marketing-rollout` と同じ tick 鍵を入れる。
 *
 * ## 固定すること
 *
 *   1. 同時に起動しても **enqueue へ進むのは 1 本だけ**
 *   2. 鍵が取れなければ **Airtable へ 1 リクエストも出さない**
 *   3. Redis へ到達できなければ **何も積まない**（多重起動を防げない状態で走らせない）
 *   4. 終わったら鍵を返す（次の tick が走れる）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ENDPOINT = 'https://fake-upstash.test';

/** SET NX / INCR / EVAL だけを実物と同じ意味で再現する偽 Redis */
function makeRedisState() {
  const store = new Map();
  let fence = 0;
  const handle = (args) => {
    const op = String(args[0] || '').toUpperCase();
    if (op === 'INCR') { fence += 1; return { result: fence }; }
    if (op === 'SET') {
      const [, k, v, ...rest] = args;
      const nx = rest.map((x) => String(x).toUpperCase()).includes('NX');
      if (nx && store.has(k)) return { result: null };
      store.set(k, String(v));
      return { result: 'OK' };
    }
    if (op === 'EVAL') {
      const script = String(args[1] || '');
      const k = args[3];
      const tok = String(args[4]);
      const cur = store.get(k);
      if (cur === undefined) return { result: 'LOST' };
      if (cur !== tok) return { result: 'STOLEN' };
      if (script.includes("redis.call('DEL'")) store.delete(k);
      return { result: 'OK' };
    }
    if (op === 'GET') return { result: store.has(args[1]) ? store.get(args[1]) : null };
    return { result: null };
  };
  return { store, handle };
}

/**
 * handler を読み込んで実行する。
 * @returns {{results: object[], airtableCalls: number}}
 */
async function runHandler({ redis, concurrency = 1, env = {} }) {
  const original = globalThis.fetch;
  let airtableCalls = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(ENDPOINT)) {
      let args = [];
      try { args = JSON.parse((init && init.body) || '[]'); } catch { args = []; }
      // pipeline（配列の配列）は使わない前提。単発コマンドのみ
      const out = redis ? redis.handle(args) : null;
      return new Response(JSON.stringify(out ?? { result: null }), { status: 200 });
    }
    if (u.includes('api.airtable.com')) {
      airtableCalls += 1;
      return new Response(JSON.stringify({ records: [] }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };

  const prev = {};
  const applied = {
    UPSTASH_REDIS_REST_URL: redis ? ENDPOINT : '',
    UPSTASH_REDIS_REST_TOKEN: redis ? 'fake-token' : '',
    AIRTABLE_API_KEY: 'key',
    AIRTABLE_BASE_ID: 'base',
    // ゲートは開けておく（鍵の判定より後ろに居ることを確かめるため）
    MARKETING_SEQUENCE_SCHEDULER_ENABLED: 'true',
    MARKETING_CAMPAIGN_ENABLED: 'true',
    MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true',
    MARKETING_SEQUENCE_CAMPAIGN_ID: 'campaign-discount-free',
    ...env,
  };
  for (const [k, v] of Object.entries(applied)) { prev[k] = process.env[k]; process.env[k] = v; }

  try {
    const mod = await import(`../../../netlify/functions/cron-campaign-sequence.js?t=${Date.now()}${Math.random()}`);
    const calls = Array.from({ length: concurrency }, () => mod.default());
    const responses = await Promise.all(calls);
    const results = await Promise.all(responses.map(async (r) => {
      try { return JSON.parse(await r.text()); } catch { return null; }
    }));
    return { results, airtableCalls };
  } finally {
    globalThis.fetch = original;
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

test('【重要】同時に 3 回起動しても、tick へ進むのは 1 本だけ', async () => {
  const redis = makeRedisState();
  const { results } = await runHandler({ redis, concurrency: 3 });
  const skipped = results.filter((r) => r && r.action === 'skip' && r.reason === 'tick_busy');
  const proceeded = results.filter((r) => !(r && r.action === 'skip'));
  assert.equal(results.length, 3);
  assert.equal(proceeded.length, 1, `tick へ進んだ本数が 1 でない: ${JSON.stringify(results)}`);
  assert.equal(skipped.length, 2, '弾かれた本数が 2 でない');
  for (const s of skipped) assert.equal(s.sideEffects, 'none');
});

test('【重要】鍵が取れなければ Airtable へ 1 リクエストも出さない', async () => {
  const redis = makeRedisState();
  // 先に鍵を握っておく（他の実行が走っている状態）
  redis.handle(['INCR', 'x']);
  redis.handle(['SET', 'ak:marketing-tick:lock:tick:campaign-sequence', '999', 'NX', 'EX', '240']);
  const { results, airtableCalls } = await runHandler({ redis, concurrency: 1 });
  assert.equal(results[0].action, 'skip');
  assert.equal(results[0].reason, 'tick_busy');
  assert.equal(airtableCalls, 0, 'Airtable を叩いてしまっている');
});

test('【重要】Redis へ到達できなければ何も積まない', async () => {
  const { results, airtableCalls } = await runHandler({ redis: null, concurrency: 1 });
  assert.equal(results[0].action, 'skip');
  assert.equal(results[0].reason, 'tick_lock_unavailable');
  assert.equal(results[0].sideEffects, 'none');
  assert.equal(airtableCalls, 0, 'Redis が無いのに Airtable を叩いている');
});

test('終わったら鍵を返す（次の tick が走れる）', async () => {
  const redis = makeRedisState();
  const first = await runHandler({ redis, concurrency: 1 });
  assert.notEqual(first.results[0].action, 'skip');
  const second = await runHandler({ redis, concurrency: 1 });
  assert.notEqual(second.results[0].action, 'skip', '鍵を返していない（次の tick が塞がれる）');
});

test('鍵の名前と寿命が意図どおり（次の tick より短い）', async () => {
  const mod = await import('../../../netlify/functions/cron-campaign-sequence.js');
  assert.equal(mod.SEQUENCE_TICK_LOCK_ID, 'tick:campaign-sequence');
  assert.ok(mod.SEQUENCE_TICK_LOCK_TTL_SEC > 0);
  // cron は 10 分ごと。TTL がそれ以上だと、落ちたとき次の tick まで再開できない
  assert.ok(mod.SEQUENCE_TICK_LOCK_TTL_SEC < 600, 'TTL が tick 間隔以上になっている');
});
