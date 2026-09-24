/**
 * prospectWindowFallback.behavior.test.mjs — **実際に `runSequenceTick` を動かして**確かめる
 *   node --test src/lib/marketing/prospectWindowFallback.behavior.test.mjs
 *
 * ## なぜソース文字列の一致では足りないか
 *
 * 配線 guard（`prospectWindowStepSafety.test.mjs`）は「その行が書いてあるか」しか見ない。
 * 書いてあっても**実行されない**／**別の分岐に食われる**なら意味がない。
 * 最重要仕様は**実行結果**で固定する。
 *
 * ## 仕掛け
 *
 * Redis（Upstash REST）も Airtable も **`fetch` 経由**なので、`globalThis.fetch` を
 * 差し替えるだけで実経路を通せる。送信（SendGrid）は**呼ばれたら即失敗**にして、
 * 「1 通も送っていない」を**構造的に**確かめる。
 *
 * ⚠️ 本番へは 1 バイトも触らない（すべてメモリ上の偽物）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runSequenceTick } from '../../../netlify/functions/cron-campaign-sequence.js';
import { getCampaign } from './campaignCatalog.js';
import { getSequenceSteps, resolveSequenceStep } from './campaignSequence.js';
import { computeCampaignDeliveryKey } from './campaignSend.js';
import { buildProspect, applySend, applyDelivered } from './prospectPolicy.js';
import { emailHash } from './prospectStore.js';
import { buildDeliveredSetKey } from './deliveryKeyStore.js';
import { prospectCursorKey, DEFAULT_PROSPECT_PER_TICK } from './prospectScanWindow.js';
import { CAMPAIGN_WINDOW } from '../promotions/campaignOffers.js';

const BRAND = 'analytics-keiba';
const FROM = 'noreply@keiba.link';
const CAMPAIGN_ID = 'campaign-discount-free';
const CAMPAIGN = getCampaign(CAMPAIGN_ID, { includeDisabled: true });
const CAMPAIGN_TYPE = `${CAMPAIGN.campaignId}:v${CAMPAIGN.version}`;
const STEPS = getSequenceSteps(CAMPAIGN);
const DAY = 86400000;

/**
 * この test の「いま」。**開催期間の真ん中**（固定の日付を書かない）。
 *
 * ⚠️ `campaign-discount-free` は `get enabled() { return isCampaignActive(); }` で、
 *    **実時計**が開催期間の外へ出た瞬間に catalog から消える（= tick は `not_a_sequence`）。
 *    日付を直書きすると、期間が終わった翌日から **本文を 1 行も変えていないのに**
 *    この test が落ちる（2026-09-24 に実際に CI が赤になった）。
 *    正本（`CAMPAIGN_WINDOW`）から導出して、期間をどう引き直しても中に居るようにする。
 */
const NOW = Math.floor(
  (Date.parse(CAMPAIGN_WINDOW.startsAtIso) + Date.parse(CAMPAIGN_WINDOW.endsAtIso)) / 2,
);

const keyFor = (email, step) => computeCampaignDeliveryKey({
  campaign: resolveSequenceStep(CAMPAIGN, step), recipientEmail: email, brand: BRAND, fromEmail: FROM,
});

/** ゲートを全部開けた env（Redis / Airtable / SendGrid は偽物を指す） */
const ENV = Object.freeze({
  MARKETING_SEQUENCE_SCHEDULER_ENABLED: 'true',
  MARKETING_CAMPAIGN_ENABLED: 'true',
  MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true',
  AIRTABLE_API_KEY: 'fake-key',
  AIRTABLE_BASE_ID: 'appFAKE',
  UPSTASH_REDIS_REST_URL: 'https://fake-redis.local',
  UPSTASH_REDIS_REST_TOKEN: 'fake-token',
  SENDGRID_API_KEY: 'fake-sg',
  MARKETING_SEQUENCE_MAX_PER_TICK: '50',
});

/**
 * メモリ上の Redis + Airtable + SendGrid。
 *
 * @param {{prospects: Array, cursor?: object, activeKeys?: Set<string>,
 *          redisFail?: (cmd)=>string|null}} input
 */
function makeWorld({ prospects, cursor = null, activeKeys = new Set(), redisFail = null }) {
  const store = new Map();          // Redis
  const sets = new Map();           // Redis の集合
  const calls = { sendgridSend: 0, airtableWrite: 0, airtableWriteUrls: [], redisSet: [] };

  // prospect 索引とレコード
  sets.set('ak:prospect:index:active', new Set(prospects.map((p) => p.hash)));
  for (const p of prospects) store.set(`ak:prospect:p:${p.hash}`, JSON.stringify(p));
  if (cursor) store.set(prospectCursorKey(CAMPAIGN_TYPE), JSON.stringify(cursor));

  // 「送信済み」鍵の集合（prospect 台帳）
  const deliveredSet = new Set();
  for (const p of prospects) {
    for (const n of (p.__sentSteps || [])) deliveredSet.add(keyFor(p.email, n));
  }
  sets.set(buildDeliveredSetKey({ brand: BRAND, campaignId: CAMPAIGN.campaignId, version: CAMPAIGN.version }), deliveredSet);

  const redis = async (cmd) => {
    const [op, ...rest] = cmd;
    if (redisFail) { const f = redisFail(cmd); if (f) throw new Error(f); }
    if (op === 'SMEMBERS') return [...(sets.get(rest[0]) || new Set())];
    if (op === 'GET') return store.get(rest[0]) ?? null;
    if (op === 'SET') { calls.redisSet.push({ key: rest[0], val: rest[1] }); store.set(rest[0], rest[1]); return 'OK'; }
    if (op === 'DEL') { store.delete(rest[0]); return 1; }
    if (op === 'MGET') return rest.map((k) => store.get(k) ?? null);
    if (op === 'SMISMEMBER') {
      const set = sets.get(rest[0]) || new Set();
      return rest.slice(1).map((m) => (set.has(m) ? 1 : 0));
    }
    if (op === 'SADD') {
      const set = sets.get(rest[0]) || new Set();
      const added = rest.slice(1).map((m) => (set.has(m) ? 0 : (set.add(m), 1)));
      sets.set(rest[0], set);
      return added.reduce((a, b) => a + b, 0);
    }
    if (op === 'SREM' || op === 'EXPIRE') return 1;
    if (op === 'SCARD') return (sets.get(rest[0]) || new Set()).size;
    return null;
  };

  const fetchImpl = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : {};
    // ── Redis ────────────────────────────────────────────────
    if (u.startsWith('https://fake-redis.local')) {
      // pipeline（配列の配列）にも対応
      if (Array.isArray(body) && Array.isArray(body[0])) {
        const out = [];
        for (const c of body) out.push({ result: await redis(c) });
        return { ok: true, status: 200, json: async () => out };
      }
      return { ok: true, status: 200, json: async () => ({ result: await redis(body) }) };
    }
    // ── Airtable ─────────────────────────────────────────────
    if (u.includes('api.airtable.com')) {
      if (u.endsWith('/listRecords')) {
        // 「既に queued / sent の鍵」を問い合わせているなら、その鍵を返す
        const formula = String(body.filterByFormula || '');
        const hit = [...activeKeys].filter((k) => formula.includes(k));
        if (hit.length > 0) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              records: hit.map((k, i) => ({ id: `rec${String(i).padStart(14, '0')}`, fields: { DeliveryKey: k, Status: 'queued' } })),
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ records: [] }) };
      }
      // ⚠️ 読み（`GET` の一覧取得）は書き込みではない。**変更だけ**を数える
      const method = String(opts.method || 'GET').toUpperCase();
      if (method === 'GET') return { ok: true, status: 200, json: async () => ({ records: [] }) };
      calls.airtableWrite += 1;
      calls.airtableWriteUrls.push(`${opts.method || 'GET'} ${u.replace(/^https:\/\/api\.airtable\.com\/v0\/[^/]+\//, '')}`);
      return { ok: true, status: 200, json: async () => ({ records: [] }) };
    }
    // ── SendGrid ─────────────────────────────────────────────
    if (u.includes('sendgrid')) {
      if (u.includes('/mail/send')) { calls.sendgridSend += 1; return { ok: true, status: 202, text: async () => '' }; }
      return { ok: true, status: 200, json: async () => [] };   // suppression: 空
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  return { fetchImpl, calls, store, sets };
}

/**
 * `fetch` と `process.env` を差し替えて 1 tick 動かす。
 *
 * ⚠️ tick の一部（Redis 接続）は引数の env ではなく **`process.env` を直接読む**ので、
 *    両方に同じ偽物を入れる。終わったら必ず戻す。
 */
async function runTick(world, extra = {}) {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const originalEnv = {};
  for (const k of Object.keys(ENV)) originalEnv[k] = process.env[k];
  globalThis.fetch = world.fetchImpl;
  // ⚠️ tick 内の `getCampaign()` は `enabled` を**実時計**で評価する（`isCampaignActive()`）。
  //    引数の `now` は届かないので、`Date.now` ごと `NOW` に合わせる。
  //    こうしないと開催期間が終わった翌日から全件 `not_a_sequence` で落ちる。
  Date.now = () => NOW;
  for (const [k, v] of Object.entries(ENV)) process.env[k] = v;
  try {
    return await runSequenceTick({ env: { ...ENV }, now: NOW, campaignId: CAMPAIGN_ID, ...extra });
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const readCursor = (world) => {
  const raw = world.store.get(prospectCursorKey(CAMPAIGN_TYPE));
  return raw ? JSON.parse(raw) : null;
};

/**
 * `upTo` 通目まで送って届いた prospect を作る（実際の状態遷移関数を通す）。
 *
 * ⚠️ 形を手書きしない。`buildProspect` → `applySend` → `applyDelivered` を通すことで、
 *    本番と同じ状態・カウンタになる。
 */
function prospectSent(email, upTo) {
  let p = buildProspect({ email, nowMs: NOW - 60 * DAY, batchId: 'behavior-test', source: 'csv' });
  p.hash = emailHash(email);
  const sentSteps = [];
  for (let n = 1; n <= upTo; n += 1) {
    const at = NOW - (60 - n * 10) * DAY;        // 最後の送信から十分に日を空ける
    p = applySend({ prospect: p, nowMs: at, runId: `behavior-${n}` });
    p = applyDelivered({ prospect: p, nowMs: at }).prospect;
    sentSteps.push(n);
  }
  p.__sentSteps = sentSteps;
  return p;
}

/**
 * **本番と同じ並び**でアドレスを 2 つの窓へ分ける。
 *
 * ⚠️ 索引の並びは `stableIndexOrder`（**hash の昇順**）で決まる。
 *    作った順ではないので、`sort` してから切らないと「窓 A に置いたつもり」が崩れる。
 */
function splitByIndexOrder(sizeA, sizeB) {
  const all = [];
  for (let i = 0; i < sizeA + sizeB; i += 1) all.push(`w${String(i).padStart(5, '0')}@example.invalid`);
  all.sort((x, y) => (emailHash(x) < emailHash(y) ? -1 : 1));
  return { windowA: all.slice(0, sizeA), windowB: all.slice(sizeA) };
}

/**
 * 窓 A / 窓 B を作る。
 *
 * - 窓 A（索引の先頭 `DEFAULT_PROSPECT_PER_TICK` 件）:
 *     step2 due が居るが、その step2 鍵は **すべて Airtable 側で `queued`**（送信不可）。
 *     step3 due は送信可能。
 * - 窓 B（その後ろ）: **送信可能な step2** が居る。
 */
function buildWindowedWorld({ cursor = null, redisFail = null } = {}) {
  const per = DEFAULT_PROSPECT_PER_TICK;
  const { windowA, windowB } = splitByIndexOrder(per, 100);
  const prospects = [];
  const activeKeys = new Set();

  // 窓 A の先頭 5 人: step2 待ち（ただし step2 の鍵は Airtable 側で予約済み＝送れない）
  for (const email of windowA.slice(0, 5)) {
    prospects.push(prospectSent(email, 1));
    activeKeys.add(keyFor(email, 2));            // ← すでに queued
  }
  // 窓 A の残り: step3 待ち（送れる）
  for (const email of windowA.slice(5)) prospects.push(prospectSent(email, 2));
  // 窓 B: 送信可能な step2
  for (const email of windowB) prospects.push(prospectSent(email, 1));
  return makeWorld({ prospects, cursor, activeKeys, redisFail });
}

// ══════════════════════════════════════════════════════════════════
//  A. 窓の最小 step が後段条件で 0 人 → 送らず、印だけ残す
// ══════════════════════════════════════════════════════════════════

test('【最重要】A: 窓の step2 が全員送信不可なら、step3 を送らず 0 件で終わる', async () => {
  const world = buildWindowedWorld();
  const r = await runTick(world);

  assert.equal(r.ok, false, '送ってしまっている');
  assert.equal(r.abort, 'window_needs_full_reload', `abort が違う: ${r.abort}`);
  // step3 を選んでいない
  assert.notEqual(r.step, 3, 'step3 を先行させている');
  // 送信・queue・予約・Airtable 書き込みはゼロ
  assert.equal(world.calls.sendgridSend, 0, 'メールを送っている');
  assert.deepEqual(world.calls.airtableWriteUrls, [], 'Airtable へ書き込んでいる');
  assert.equal(r.enqueued ?? 0, 0, 'queue 登録が発生している');
});

test('【最重要】A: 印（fullRequired）だけが保存され、sideEffects が事実と一致する', async () => {
  const world = buildWindowedWorld();
  const r = await runTick(world);

  const cur = readCursor(world);
  assert.ok(cur, 'カーソルが書かれていない');
  assert.equal(cur.fullRequired, true, '次の tick を全件で始める印が立っていない');
  assert.equal(r.markedForFullReload, true, '印を書けたことが応答から分からない');
  assert.equal(r.sideEffects, 'cursor_state_only', `sideEffects が事実と違う: ${r.sideEffects}`);
});

test('【最重要】A2: 窓に step2 が 1 人も居なくても、窓の中だけで step3 を選ばない', async () => {
  // 窓 A は step3 待ちだけ・窓 B に step2 待ちが居る（窓の最小 step は 3）
  const per = DEFAULT_PROSPECT_PER_TICK;
  const { windowA, windowB } = splitByIndexOrder(per, 100);
  const prospects = [
    ...windowA.map((e) => prospectSent(e, 2)),
    ...windowB.map((e) => prospectSent(e, 1)),
  ];
  const world = makeWorld({ prospects });
  const r = await runTick(world);

  assert.equal(r.abort, 'window_needs_full_reload', `abort が違う: ${r.abort}`);
  assert.equal(r.reason, 'lower_step_may_exist_outside_window', `理由が違う: ${r.reason}`);
  assert.equal(r.windowMinStep, 3, '窓の最小 step を取り違えている');
  assert.equal(world.calls.sendgridSend, 0, 'メールを送っている');
  assert.deepEqual(world.calls.airtableWriteUrls, [], 'Airtable へ書き込んでいる');
  assert.equal(readCursor(world).fullRequired, true, '印が立っていない');
});

// ══════════════════════════════════════════════════════════════════
//  B. 次の tick は全件だけを読み、global の step2 を選ぶ
// ══════════════════════════════════════════════════════════════════

test('【最重要】B: 印が立った次の tick は全件を読み、step2 を選ぶ（step3 を先行しない）', async () => {
  // 印が立った状態から始める
  const world = buildWindowedWorld({ cursor: { offset: 0, pass: 0, fullRequired: true } });
  const r = await runTick(world);

  // 全体の最小 due step は 2（窓 B に送れる step2 が居る）
  assert.equal(r.step, 2, `step2 以外を選んでいる: step=${r.step} abort=${r.abort}`);
  assert.notEqual(r.step, 3, 'step3 を先行させている');
  assert.equal(r.ok, true, `全件の tick で進めていない: ${r.abort}`);
});

test('【最重要】B: 全件の tick では窓のカーソルを進めない／印が外れる', async () => {
  const world = buildWindowedWorld({ cursor: { offset: 0, pass: 0, fullRequired: true } });
  await runTick(world);
  const cur = readCursor(world);
  assert.equal(cur.fullRequired, false, '全件を読めたのに印が残っている');
  // 窓のカーソル前進（offset が窓幅ぶん進む）は起きていない
  assert.notEqual(cur.offset, DEFAULT_PROSPECT_PER_TICK, '全件の tick で窓のカーソルを進めている');
});

// ══════════════════════════════════════════════════════════════════
//  C. 印の保存に失敗しても、後段 step へ進まない
// ══════════════════════════════════════════════════════════════════

test('【最重要】C: 印を保存できなくても step3 へ進まず 0 件で終わる', async () => {
  const world = buildWindowedWorld({
    // カーソルの SET だけ失敗させる
    redisFail: (cmd) => (cmd[0] === 'SET' && String(cmd[1]).includes('prospect-scan') ? 'redis_down' : null),
  });
  const r = await runTick(world);

  assert.equal(r.abort, 'window_needs_full_reload', '印が書けないと別の道へ進んでいる');
  assert.notEqual(r.step, 3, '印が書けないのに step3 を送っている');
  assert.equal(r.markedForFullReload, false, '書けていないのに成功扱いしている');
  assert.equal(r.sideEffects, 'none', '書けていないのに状態変更ありと言っている');
  assert.equal(world.calls.sendgridSend, 0, 'メールを送っている');
  assert.deepEqual(world.calls.airtableWriteUrls, [], 'Airtable へ書き込んでいる');
});

// ══════════════════════════════════════════════════════════════════
//  D. 全件の読み込みに失敗 → 送信 0
// ══════════════════════════════════════════════════════════════════

test('【最重要】D: 全件の tick で索引を読めなければ 1 件も送らない', async () => {
  const world = buildWindowedWorld({
    cursor: { offset: 0, pass: 0, fullRequired: true },
    redisFail: (cmd) => (cmd[0] === 'SMEMBERS' ? 'redis_down' : null),
  });
  const r = await runTick(world);

  assert.equal(r.ok, false, '読めていないのに進んでいる');
  assert.equal(r.abort, 'prospect_full_reload_failed', `abort が違う: ${r.abort}`);
  assert.equal(world.calls.sendgridSend, 0, 'メールを送っている');
  assert.deepEqual(world.calls.airtableWriteUrls, [], 'Airtable へ書き込んでいる');
});

// ══════════════════════════════════════════════════════════════════
//  E. 同一 tick で窓 + 全件を二重走査しない
// ══════════════════════════════════════════════════════════════════

/**
 * ⚠️ 二重走査は「窓で時間を使ったあとに全件を読む」＝ `claimDelivered` のあと
 *    締切に達して**予約だけ残る**危険を開く。実行回数で確かめる。
 */
test('【最重要】E: 窓が詰まった tick で索引を 2 度読まない（走査は 1 回だけ）', async () => {
  let smembers = 0;
  const world = buildWindowedWorld({
    redisFail: (cmd) => { if (cmd[0] === 'SMEMBERS') smembers += 1; return null; },
  });
  await runTick(world);
  assert.equal(smembers, 1, `同じ tick で索引を ${smembers} 回読んでいる（窓+全件の二重走査）`);
});

test('【最重要】E: 全件の tick でも索引の読み込みは 1 回だけ', async () => {
  let smembers = 0;
  const world = buildWindowedWorld({
    cursor: { offset: 0, pass: 0, fullRequired: true },
    redisFail: (cmd) => { if (cmd[0] === 'SMEMBERS') smembers += 1; return null; },
  });
  await runTick(world);
  assert.equal(smembers, 1, `全件の tick で索引を ${smembers} 回読んでいる`);
});

// ══════════════════════════════════════════════════════════════════
//  F. 通常運用（窓で送れるとき）は従来どおり進む
// ══════════════════════════════════════════════════════════════════

test('【重要】窓に送れる step2 が居れば、従来どおり step2 を積む', async () => {
  // 窓 A の step2 を「送信可能」にした世界（activeKeys 無し）
  const per = DEFAULT_PROSPECT_PER_TICK;
  const prospects = [];
  for (let i = 0; i < per; i += 1) prospects.push(prospectSent(`ok-step2-${i}@example.invalid`, 1));
  const world = makeWorld({ prospects });
  const r = await runTick(world);
  assert.equal(r.step, 2, `step2 を選んでいない: step=${r.step} abort=${r.abort}`);
  assert.notEqual(r.abort, 'window_needs_full_reload', '送れるのに全件へ落ちている');
});

test('【重要】step の数え方（第 1 期は 3 step）が前提どおり', () => {
  assert.equal(STEPS.length, 3, '第 1 期の step 数が変わった（このテストの前提が崩れる）');
});
