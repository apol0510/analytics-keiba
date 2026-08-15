/**
 * dispatchBackground.smoke.test.mjs — Background 送信のハンドラを実際に起動する
 *   node --test src/lib/marketing/dispatchBackground.smoke.test.mjs
 *
 * 守る性質:
 *   - 大きいジョブを**チャンクで繰り返して完走**する（同期の 26 秒に縛られない）
 *   - 送信経路は同期版と同じ（自前の送信ループを持たない）
 *   - 排他を取れなければ 1 通も送らない
 *   - ゲートが閉じていれば 1 通も送らない
 *   - ログ・応答に PII を出さない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SECRET = 'test-admin-secret';
const JOB_ID = 'mkt-expired-comeback-v2-abc12345-1';
const CONTENT = '<p>本文</p><p><a href="{{unsubscribeUrl}}">配信停止</a></p>';

const key64 = (seed) => seed.padEnd(64, '0').slice(0, 64).replace(/[^a-f0-9]/g, 'a');
const recId = (seed) => ('rec' + seed.replace(/[^A-Za-z0-9]/g, '')).padEnd(17, '0').slice(0, 17);

function makeFakeRedis(store = new Map(), counters = { fence: 0 }) {
  return (args) => {
    const op = String(args[0] || '').toUpperCase();
    if (op === 'INCR') { counters.fence += 1; return String(counters.fence); }
    if (op === 'SET') {
      const [, k, v, ...rest] = args;
      if (rest.map((x) => String(x).toUpperCase()).includes('NX') && store.has(k)) return null;
      store.set(k, String(v)); return 'OK';
    }
    if (op === 'EVAL') {
      const script = String(args[1] || ''); const k = args[3]; const tok = String(args[4]);
      const cur = store.get(k);
      if (cur === undefined) return 'LOST';
      if (cur !== tok) return 'STOLEN';
      if (script.includes("redis.call('DEL'")) store.delete(k);
      return 'OK';
    }
    if (op === 'GET') return store.get(args[1]) ?? null;
    return null;
  };
}

/** N 名ぶんの fixture（Customers / CampaignDeliveries / ScheduledEmails） */
function fixture(n) {
  const people = Array.from({ length: n }, (_, i) => ({
    email: `m${i}@example.com`, cus: recId(`CUS${i}`), del: recId(`DEL${i}`),
  }));
  return {
    people,
    scheduled: [{
      id: 'recJOB0000000001',
      fields: {
        JobId: JOB_ID, Status: 'PENDING', CreatedBy: 'admin-marketing',
        TargetPlan: 'campaign:expired-comeback',
        Recipients: people.map((p) => p.email).join(', '),
        Subject: 'テスト', Content: CONTENT, RecipientCount: n,
        Notes: 'marketing campaign expired-comeback v2 shell:v1',
      },
    }],
    customers: people.map((p) => ({ id: p.cus, fields: { Email: p.email, 'プラン': 'Free' } })),
    deliveries: people.map((p, i) => ({
      id: p.del,
      fields: {
        ScheduledEmailJobId: JOB_ID, RecipientEmail: p.email, DeliveryKey: key64(`abc${i}`),
        CustomerRecordId: p.cus, CampaignType: 'expired-comeback:v2',
        EmailType: 'campaign', Status: 'queued',
      },
    })),
  };
}

/**
 * 偽 Airtable / SendGrid。**送信ごとに時間を進める**ので、
 * 予算で切られてチャンクが分かれることを再現できる。
 */
function stub({ n = 5, redis = null, perSendMs = 0, failAfter = null } = {}) {
  const fx = fixture(n);
  const sentSet = new Set();
  const calls = { sendgridSend: 0, patches: 0, urls: [] };
  const redisCmd = redis || makeFakeRedis();
  let clock = Date.parse('2026-08-16T00:00:00Z');
  const origNow = Date.now;
  Date.now = () => clock;

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    calls.urls.push(`${method} ${u.split('?')[0]}`);
    if (u.includes('fake-redis.local')) {
      return { ok: true, status: 200, json: async () => ({ result: await redisCmd(JSON.parse(init.body || '[]')) }) };
    }
    if (u.includes('api.sendgrid.com/v3/mail/send')) {
      calls.sendgridSend += 1;
      clock += perSendMs;
      if (failAfter !== null && calls.sendgridSend > failAfter) return { ok: false, status: 500 };
      const to = JSON.parse(init.body || '{}')?.personalizations?.[0]?.to?.[0]?.email;
      if (to) sentSet.add(to);
      return { ok: true, status: 202 };
    }
    if (u.includes('api.sendgrid.com')) return { ok: true, status: 200, json: async () => [] };
    if (u.includes('api.airtable.com')) {
      if (u.includes('/listRecords')) {
        const formula = String(JSON.parse(init.body || '{}').filterByFormula || '');
        const want = new Set([...formula.matchAll(/LOWER\(\{(?:Email|RecipientEmail)\}\)='([^']*)'/g)].map((m) => m[1]));
        if (u.includes('Customers')) {
          return { ok: true, status: 200, json: async () => ({ records: fx.customers.filter((r) => want.has(String(r.fields.Email).toLowerCase())) }) };
        }
        if (u.includes('CampaignDeliveries')) {
          const rows = fx.deliveries
            .filter((r) => want.size === 0 || want.has(String(r.fields.RecipientEmail).toLowerCase()))
            // 送信済みは status を sent にして返す（再開時の冪等性を再現）
            .map((r) => (sentSet.has(r.fields.RecipientEmail)
              ? { ...r, fields: { ...r.fields, Status: 'sent' } } : r));
          return { ok: true, status: 200, json: async () => ({ records: rows }) };
        }
        return { ok: true, status: 200, json: async () => ({ records: [] }) };
      }
      if (method !== 'GET') { calls.patches += 1; return { ok: true, status: 200, json: async () => ({}) }; }
      if (u.includes('ScheduledEmails')) {
        return { ok: true, status: 200, json: async () => ({ records: fx.scheduled }) };
      }
      if (u.includes('EmailBlacklist')) return { ok: true, status: 200, json: async () => ({ records: [] }) };
      // `patchDeliveriesByEmail` は **GET で 1 件引いてから PATCH** する。
      // ここを空で返すと PATCH が 1 回も起きず、「記録していない」を見逃す。
      if (u.includes('CampaignDeliveries')) {
        const f = decodeURIComponent(u);
        const m = /LOWER\(\{RecipientEmail\}\)='([^']*)'/.exec(f);
        const rows = m ? fx.deliveries.filter((r) => String(r.fields.RecipientEmail).toLowerCase() === m[1]) : [];
        return { ok: true, status: 200, json: async () => ({ records: rows }) };
      }
      return { ok: true, status: 200, json: async () => ({ records: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return { calls, sentSet, restoreNow: () => { Date.now = origNow; } };
}

async function invoke(body, env = {}) {
  process.env.PREMIUM_PLUS_ADMIN_SECRET = SECRET;
  process.env.AIRTABLE_API_KEY = 'test-key';
  process.env.AIRTABLE_BASE_ID = 'appTEST';
  process.env.SENDGRID_API_KEY = 'SG.test';
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.local';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  process.env.MARKETING_CAMPAIGN_DISPATCH_ENABLED = 'true';
  for (const [k, v] of Object.entries(env)) {
    if (v === null) delete process.env[k]; else process.env[k] = v;
  }
  const mod = await import('../../../netlify/functions/marketing-campaign-dispatch-background.js');
  const res = await mod.handler({
    httpMethod: 'POST', headers: { 'x-admin-secret': SECRET }, body: JSON.stringify(body),
  });
  return res;
}

test('【重要】大きいジョブをチャンクで繰り返して完走する', async () => {
  // 1 通 5 秒 → 1 チャンク（予算 60 秒）で 10 通前後。50 通なら複数チャンクになる
  const s = stub({ n: 50, perSendMs: 5_000 });
  try {
    const res = await invoke({ jobId: JOB_ID, expectedWillSend: 50 });
    assert.equal(res.statusCode, 202, 'Background は 202 即返し');
    assert.equal(s.calls.sendgridSend, 50, `送れたのは ${s.calls.sendgridSend} 通（50 通のはず）`);
    assert.equal(s.sentSet.size, 50, '同じ相手へ二重に送っている');
  } finally { s.restoreNow(); }
});

test('【重要】1 通ずつ台帳へ書くので、途中で止まっても再送されない', async () => {
  const s = stub({ n: 20, perSendMs: 5_000 });
  try {
    await invoke({ jobId: JOB_ID, expectedWillSend: 20 });
    // 送信数と PATCH 数が対応している（1 通 = 1 記録）
    assert.equal(s.calls.sendgridSend, 20);
    assert.ok(s.calls.patches >= 20, `PATCH が ${s.calls.patches} 回（送信ごとに記録していない）`);
  } finally { s.restoreNow(); }
});

test('【重要】ゲートが閉じていれば 1 通も送らない', async () => {
  const s = stub({ n: 5 });
  try {
    const res = await invoke({ jobId: JOB_ID, expectedWillSend: 5 },
      { MARKETING_CAMPAIGN_DISPATCH_ENABLED: null });
    assert.equal(res.statusCode, 202);
    assert.equal(s.calls.sendgridSend, 0, 'ゲート閉鎖なのに送信した');
    assert.equal(s.calls.patches, 0);
  } finally { s.restoreNow(); }
});

test('【重要】jobId / expectedWillSend が無ければ 1 通も送らない', async () => {
  const a = stub({ n: 5 });
  try {
    await invoke({ expectedWillSend: 5 });
    assert.equal(a.calls.sendgridSend, 0, 'jobId 無しで送信した');
  } finally { a.restoreNow(); }
  const b = stub({ n: 5 });
  try {
    await invoke({ jobId: JOB_ID });
    assert.equal(b.calls.sendgridSend, 0, 'expectedWillSend 無しで送信した');
  } finally { b.restoreNow(); }
});

test('【重要】排他を取れなければ 1 通も送らない', async () => {
  const store = new Map();
  // 先に鍵を埋めておく（別実行が処理中）
  store.set(`ak:marketing-dispatch:lock:${JOB_ID}`, '999');
  const s = stub({ n: 5, redis: makeFakeRedis(store) });
  try {
    const res = await invoke({ jobId: JOB_ID, expectedWillSend: 5 });
    assert.equal(res.statusCode, 202);
    assert.equal(s.calls.sendgridSend, 0, 'ロック中なのに送信した');
  } finally { s.restoreNow(); }
});

test('【重要】Redis へ届かなければ 1 通も送らない（fail closed）', async () => {
  const s = stub({ n: 5, redis: () => { throw new Error('unreachable'); } });
  try {
    await invoke({ jobId: JOB_ID, expectedWillSend: 5 });
    assert.equal(s.calls.sendgridSend, 0, '排他を確認できないのに送信した');
  } finally { s.restoreNow(); }
});

test('実行後に鍵を解放する（次の実行が塞がれない）', async () => {
  const store = new Map();
  const s = stub({ n: 3, redis: makeFakeRedis(store) });
  try {
    await invoke({ jobId: JOB_ID, expectedWillSend: 3 });
    assert.equal(store.size, 0, '鍵を解放していない');
  } finally { s.restoreNow(); }
});

test('【重要】ログにアドレスを出さない', async () => {
  const s = stub({ n: 3 });
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.map((a) => JSON.stringify(a)).join(' ')); };
  try {
    await invoke({ jobId: JOB_ID, expectedWillSend: 3 });
  } finally {
    console.log = orig;
    s.restoreNow();
  }
  const dump = lines.join('\n');
  assert.equal(/@example\.com/.test(dump), false, 'ログにアドレスが出ている');
  assert.equal(/fake-token|fake-redis\.local/.test(dump), false, 'ログに接続情報が出ている');
});

test('送信経路を二重に持たない（同期版の runDispatch を使う）', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../../../netlify/functions/marketing-campaign-dispatch-background.js', import.meta.url), 'utf8',
  ));
  assert.match(src, /runDispatch/, '同期版の送信経路を使っていない');
  assert.equal(/api\.sendgrid\.com/.test(src), false, '自前の送信経路を持っている');
});
