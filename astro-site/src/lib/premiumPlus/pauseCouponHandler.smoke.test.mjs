/**
 * pauseCouponHandler.smoke.test.mjs — クーポン取得 API を**実際に呼んで**挙動を固定する
 *
 * 構造 guard（pauseCouponWiring.guard.test.mjs）と違い、ここは本物のハンドラを動かす。
 * Airtable は fetch をスタブし、**送られた PATCH の中身をそのまま検査**する。
 *
 * 固定する仕様:
 *   - 停止中の対象会員 → 取得成功（PATCH はクーポン 3 フィールドだけ・1 レコードだけ）
 *   - 同じ会員がもう一度呼んでも PATCH は増えない（二重取得なし）
 *   - 停止していない会員 / 販売対象外 / 無料会員 / 未ログイン → 404（PATCH なし）
 *   - gate 未設定 → 503 で「取得した」と言わない（PATCH なし）
 *   - GET では取得できない
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionV2 } from '../auth/session.js';
import { SESSION_COOKIE_NAME } from '../auth/constants.js';
import { clearAnchorCache } from './purchaseAnchorLookup.js';
import { PP_REOPEN_COUPON_FIELDS } from './premiumPlusReopenCoupon.js';

const SECRET = 'test-secret-value-at-least-32-characters-long!!';
const BASE = 'appTEST123';

/** 三連複保有の販売可会員（停止していない状態） */
const SALEABLE = Object.freeze({
  'プラン': 'Premium Sanrenpuku',
  'Status': 'active',
  '有効期限': '2099-12-31',
  'SanrenpukuPaidAt': '2020-01-01T00:00:00.000Z',
  'PremiumPlusEligibility': 'eligible',
});

let calls = [];
let realFetch;
let realEnv;
let redis;
/** CouponOperationHistory（append-only。テストでは配列で持つ）*/
let history = [];
let historyCreateFails = false;

/** SET NX / EVAL の意味を本物どおりに実装した合成 Redis（排他の検証に使う）*/
function makeRedis({ down = false } = {}) {
  const store = new Map();
  return {
    store,
    cmd: async (args) => {
      if (down) throw new Error('redis_down');
      const [op, ...rest] = args;
      if (op === 'INCR') {
        const n = Number(store.get(rest[0]) || 0) + 1;
        store.set(rest[0], String(n));
        return n;
      }
      if (op === 'SET') {
        const [key, value, ...opts] = rest;
        if (opts.includes('NX') && store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }
      if (op === 'EVAL') {
        const [script, , key, token] = rest;
        const cur = store.get(key);
        if (cur === undefined) return 'LOST';
        if (cur !== token) return 'STOLEN';
        if (script.includes('DEL')) store.delete(key);
        return 'OK';
      }
      return null;
    },
  };
}

function stubAirtable(recordsById) {
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : null });
    const u = String(url);
    // 合成 Redis（排他）
    if (u.includes('redis.example.invalid')) {
      try { return { ok: true, status: 200, json: async () => ({ result: await redis.cmd(JSON.parse(init.body || '[]')) }) }; }
      catch { return { ok: false, status: 500, json: async () => ({}) }; }
    }
    // 合成 CouponOperationHistory（append-only）
    if (u.includes('/CouponOperationHistory')) {
      if (u.endsWith('/listRecords')) {
        const body = JSON.parse(init.body || '{}');
        const eq = String(body.filterByFormula || '').match(/\{(\w+)\}\s*=\s*'([^']*)'/);
        const rows = history.filter((r) => !eq || String(r.fields[eq[1]] || '') === eq[2]);
        return { ok: true, status: 200, json: async () => ({ records: rows }) };
      }
      if (method === 'POST') {
        if (historyCreateFails) return { ok: false, status: 500, json: async () => ({}) };
        for (const r of (JSON.parse(init.body || '{}').records || [])) {
          history.push({ id: `recH${history.length + 1}`, fields: r.fields });
        }
        return { ok: true, status: 200, json: async () => ({ records: [] }) };
      }
      return { ok: false, status: 405, json: async () => ({}) };
    }
    const id = String(url).split('/').pop();
    if (method === 'GET') {
      const fields = recordsById[id];
      if (!fields) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ id, fields }) };
    }
    if (method === 'PATCH') {
      // 実際の Airtable と同じく、更新後の fields をマージして返す
      recordsById[id] = { ...recordsById[id], ...(JSON.parse(init.body).fields) };
      return { ok: true, status: 200, json: async () => ({ id, fields: recordsById[id] }) };
    }
    return { ok: false, status: 405, json: async () => ({}) };
  };
}

async function cookieFor(sub, plan = 'premium-sanrenpuku') {
  const now = Date.now();
  const { token } = await createSessionV2({
    sub, plan, venueAccess: ['jra', 'nankan'], sessionVersion: 1,
    now, ttlMs: 20 * 60 * 1000, sessionStart: now, secret: SECRET,
  });
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function request({ cookie, body = {} }) {
  return new Request('https://analytics.keiba.link/api/premium-plus-coupon.json', {
    method: 'POST',
    headers: cookie ? { cookie, 'content-type': 'application/json' } : { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function post(args) {
  const mod = await import('../../pages/api/premium-plus-coupon.json.js');
  return mod.POST({ request: request(args) });
}

const patches = () => calls.filter((c) => c.method === 'PATCH' && !String(c.url).includes('redis'));

beforeEach(() => {
  calls = [];
  clearAnchorCache();
  realFetch = globalThis.fetch;
  realEnv = { ...process.env };
  process.env.SESSION_SIGNING_SECRET = SECRET;
  process.env.AIRTABLE_API_KEY = 'key-test';
  process.env.AIRTABLE_BASE_ID = BASE;
  process.env.PREMIUM_PLUS_FIELDS_READY = '1';
  process.env.PREMIUM_PLUS_REOPEN_COUPON_READY = '1';
  // 排他は Redis 必須（fail closed）。合成 Redis を使えるよう env を立てる
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token-test';
  redis = makeRedis();
  history = [];
  historyCreateFails = false;
  delete process.env.COUPON_HISTORY_TABLE_READY;
  delete process.env.PREMIUM_PLUS_FUNNEL_ANCHOR;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in realEnv)) delete process.env[k];
  Object.assign(process.env, realEnv);
});

// ── 取得成功 ────────────────────────────────────────────────
test('停止中の対象会員は取得できる（クーポン 3 フィールドだけを 1 レコードへ）', async () => {
  const db = { recPAUSED0000001: { ...SALEABLE, PremiumPlusSalePaused: true } };
  stubAirtable(db);
  const res = await post({ cookie: await cookieFor('recPAUSED0000001') });
  const json = await res.json();

  assert.equal(res.status, 200);
  assert.equal(json.claimed, true);
  assert.equal(json.alreadyClaimed, false);

  assert.equal(patches().length, 1, 'PATCH は 1 回だけ');
  const p = patches()[0];
  assert.match(p.url, /\/Customers\/recPAUSED0000001$/);
  assert.deepEqual(Object.keys(p.body.fields).sort(), [
    PP_REOPEN_COUPON_FIELDS.CLAIMED_AT,
    PP_REOPEN_COUPON_FIELDS.COUPON_ID,
    PP_REOPEN_COUPON_FIELDS.SOURCE,
  ].sort());
});

test('取得しても資格 / 停止 / 会員権 / 決済は 1 つも変わらない', async () => {
  const before = { ...SALEABLE, PremiumPlusSalePaused: true, PremiumPlusReleaseOverride: 'phase4' };
  const db = { recPAUSED0000002: { ...before } };
  stubAirtable(db);
  await post({ cookie: await cookieFor('recPAUSED0000002') });

  for (const k of Object.keys(before)) {
    assert.deepEqual(db.recPAUSED0000002[k], before[k], `${k} が変わっている`);
  }
});

test('二重取得しない（2 回目は PATCH せず取得日時も変わらない）', async () => {
  const db = { recPAUSED0000003: { ...SALEABLE, PremiumPlusSalePaused: true } };
  stubAirtable(db);
  const first = await (await post({ cookie: await cookieFor('recPAUSED0000003') })).json();
  const claimedAt = db.recPAUSED0000003[PP_REOPEN_COUPON_FIELDS.CLAIMED_AT];
  assert.equal(patches().length, 1);

  clearAnchorCache();
  const second = await (await post({ cookie: await cookieFor('recPAUSED0000003') })).json();
  assert.equal(second.claimed, true);
  assert.equal(second.alreadyClaimed, true);
  assert.equal(patches().length, 1, '2 回目に PATCH している（二重取得）');
  assert.equal(db.recPAUSED0000003[PP_REOPEN_COUPON_FIELDS.CLAIMED_AT], claimedAt);
  assert.equal(first.claimed, true);
});

test('他会員のレコードには一切触れない', async () => {
  const other = { ...SALEABLE, PremiumPlusSalePaused: true };
  const db = {
    recPAUSED0000004: { ...SALEABLE, PremiumPlusSalePaused: true },
    recOTHER00000005: { ...other },
  };
  stubAirtable(db);
  await post({ cookie: await cookieFor('recPAUSED0000004') });

  assert.deepEqual(db.recOTHER00000005, other, '他会員のレコードが変わっている');
  for (const c of calls) assert.doesNotMatch(c.url, /recOTHER00000005/);
});

test('body で他人の recordId / email を指定しても自分のレコードしか触らない', async () => {
  const db = {
    recPAUSED0000006: { ...SALEABLE, PremiumPlusSalePaused: true },
    recVICTIM0000007: { ...SALEABLE, PremiumPlusSalePaused: true },
  };
  stubAirtable(db);
  const res = await post({
    cookie: await cookieFor('recPAUSED0000006'),
    body: { recordId: 'recVICTIM0000007', id: 'recVICTIM0000007', email: 'someone@example.com' },
  });
  assert.equal(res.status, 200);
  assert.equal(patches().length, 1);
  assert.match(patches()[0].url, /recPAUSED0000006$/);
  assert.equal(PP_REOPEN_COUPON_FIELDS.CLAIMED_AT in db.recVICTIM0000007, false);
});

// ── 取得できない ────────────────────────────────────────────
test('停止していない会員は 404（取得も PATCH もしない）', async () => {
  const db = { recACTIVE0000001: { ...SALEABLE } };
  stubAirtable(db);
  const res = await post({ cookie: await cookieFor('recACTIVE0000001') });
  assert.equal(res.status, 404);
  assert.equal(patches().length, 0);
});

test('販売対象外(blocked)は停止中でも 404', async () => {
  const db = { recBLOCKED000001: { ...SALEABLE, PremiumPlusSalePaused: true, PremiumPlusEligibility: 'blocked' } };
  stubAirtable(db);
  const res = await post({ cookie: await cookieFor('recBLOCKED000001') });
  assert.equal(res.status, 404);
  assert.equal(patches().length, 0);
});

test('Plus の候補ではない会員（Premium 加入直後）は 404', async () => {
  const db = {
    recNOTPLUS000001: {
      'プラン': 'Premium', 'Status': 'active', '有効期限': '2099-12-31',
      'PaidAt': new Date().toISOString(), PremiumPlusSalePaused: true,
    },
  };
  stubAirtable(db);
  const res = await post({ cookie: await cookieFor('recNOTPLUS000001', 'premium') });
  assert.equal(res.status, 404);
  assert.equal(patches().length, 0);
});

test('未ログイン（Cookie なし）は 404', async () => {
  stubAirtable({});
  const res = await post({ cookie: '' });
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0, 'Airtable を触っている');
});

test('署名が違う Cookie は 404', async () => {
  stubAirtable({ recPAUSED0000008: { ...SALEABLE, PremiumPlusSalePaused: true } });
  const cookie = await cookieFor('recPAUSED0000008');
  const res = await post({ cookie: `${cookie}tampered` });
  assert.equal(res.status, 404);
  assert.equal(patches().length, 0);
});

test('保存先 gate が未設定なら 503（PATCH せず「取得した」と言わない）', async () => {
  delete process.env.PREMIUM_PLUS_REOPEN_COUPON_READY;
  const db = { recPAUSED0000009: { ...SALEABLE, PremiumPlusSalePaused: true } };
  stubAirtable(db);
  const res = await post({ cookie: await cookieFor('recPAUSED0000009') });
  const json = await res.json();
  assert.equal(res.status, 503);
  assert.equal(json.claimed, false);
  assert.equal(json.sideEffects, 'none');
  assert.equal(patches().length, 0);
});

test('Airtable の PATCH が失敗したら 503（成功と言わない）', async () => {
  const db = { recPAUSED0000010: { ...SALEABLE, PremiumPlusSalePaused: true } };
  stubAirtable(db);
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if ((init.method || 'GET') === 'PATCH') {
      calls.push({ url: String(url), method: 'PATCH', body: JSON.parse(init.body) });
      return { ok: false, status: 422, json: async () => ({}) };
    }
    return inner(url, init);
  };
  const res = await post({ cookie: await cookieFor('recPAUSED0000010') });
  const json = await res.json();
  assert.equal(res.status, 503);
  assert.equal(json.claimed, false);
  assert.equal(PP_REOPEN_COUPON_FIELDS.CLAIMED_AT in db.recPAUSED0000010, false);
});

test('GET では取得できない（プリフェッチで勝手に取得しない）', async () => {
  stubAirtable({ recPAUSED0000011: { ...SALEABLE, PremiumPlusSalePaused: true } });
  const mod = await import('../../pages/api/premium-plus-coupon.json.js');
  const res = mod.GET();
  assert.equal(res.status, 404);
  assert.equal(patches().length, 0);
});

// ── 共通クーポン基盤への配線（entity lock / 履歴 / repair）─────────
const REC = 'recPAUSED0000001';
const paused = () => ({ [REC]: { ...SALEABLE, PremiumPlusSalePaused: true } });
const P = await import('../coupons/couponPlatform.js');

test('claim も entity lock を通り、同時 2 本でも PATCH 1 回・取得日時を二重更新しない', async () => {
  const db = paused();
  stubAirtable(db);
  const cookie = await cookieFor(REC);
  const [a, b] = await Promise.all([post({ cookie }), post({ cookie })]);
  const bodies = await Promise.all([a.json(), b.json()]);

  assert.equal(patches().length, 1, `Customers PATCH が ${patches().length} 回`);
  // 片方は取得成功、もう片方は「既取得」か「進行中」。**失敗扱いにしない／二重に書かない**
  const claimedAt = db[REC][PP_REOPEN_COUPON_FIELDS.CLAIMED_AT];
  assert.ok(claimedAt, '取得日時が記録されていない');
  for (const [i, res] of [a, b].entries()) {
    if (res.status === 200) assert.equal(bodies[i].claimed, true);
    else assert.equal(bodies[i].sideEffects, 'none');
  }
  // 取得日時は 1 回しか書かれていない
  assert.equal(patches()[0].body.fields[PP_REOPEN_COUPON_FIELDS.CLAIMED_AT], claimedAt);
});

test('Redis が使えないときは state を書かず 503（fail closed）', async () => {
  const db = paused();
  stubAirtable(db);
  redis = makeRedis({ down: true });
  const res = await post({ cookie: await cookieFor(REC) });
  const json = await res.json();
  assert.equal(res.status, 503);
  assert.equal(json.code, 'coupon_lock_unavailable');
  assert.equal(json.sideEffects, 'none');
  assert.equal(patches().length, 0, '排他できないのに書いている');
});

test('claim → 履歴 1 件（gate ON のとき）', async () => {
  process.env.COUPON_HISTORY_TABLE_READY = '1';
  const db = paused();
  stubAirtable(db);
  const res = await post({ cookie: await cookieFor(REC) });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.historyRecorded, true);
  assert.equal(history.length, 1);
  const f = history[0].fields;
  assert.equal(f.OperationType, 'claim');
  assert.equal(f.Actor, 'customer');
  assert.equal(f.CustomerRecordId, REC);
  assert.equal(f.ProductKey, 'premium_plus');
  assert.equal(f.BeforeState, 'none');
  assert.equal(f.AfterState, 'held');
  assert.ok(!('Email' in f), '履歴にアドレスを書いている');
});

test('gate UNSET なら claim の履歴は 0 件（取得自体は成功）', async () => {
  const db = paused();
  stubAirtable(db);
  const res = await post({ cookie: await cookieFor(REC) });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.claimed, true);
  assert.equal(json.historyRecorded, false);
  assert.equal(history.length, 0);
});

test('履歴 create 失敗でも claim を rollback しない（op= から復元できる）', async () => {
  process.env.COUPON_HISTORY_TABLE_READY = '1';
  historyCreateFails = true;
  const db = paused();
  stubAirtable(db);
  const res = await post({ cookie: await cookieFor(REC) });
  const json = await res.json();

  // 取得は成功したまま
  assert.equal(res.status, 200);
  assert.equal(json.claimed, true);
  assert.equal(json.historyRecorded, false);
  assert.equal(history.length, 0);
  assert.ok(db[REC][PP_REOPEN_COUPON_FIELDS.CLAIMED_AT], '取得が巻き戻っている');

  // ⚠️ durable marker: Source から OperationId を復元できる
  const audit = P.parseCouponAudit(db[REC][PP_REOPEN_COUPON_FIELDS.SOURCE]);
  assert.ok(audit.operationId, 'op= が残っていない（repair できない）');
  // 論理的な取得元も失っていない
  assert.equal(audit.kind, 'pause-notice');
  // 期待どおりの安定キー（時計に依存しない）
  assert.equal(audit.operationId, P.computeCouponOperationId({
    productKey: 'premium_plus', couponId: 'premium-plus-reopen-priority', version: 1,
    customerRecordId: REC, operationType: 'claim', anchor: 'none',
  }));
});

test('旧データ（素の pause-notice）もそのまま読める（後方互換）', async () => {
  const { readReopenCoupon } = await import('./premiumPlusReopenCoupon.js');
  const legacy = readReopenCoupon({
    [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-18T22:07:54.803Z',
    [PP_REOPEN_COUPON_FIELDS.SOURCE]: 'pause-notice',
  });
  assert.equal(legacy.claimed, true);
  assert.equal(legacy.sourceKind, 'pause-notice');
  assert.equal(legacy.operationId, '', '旧データに op= は無い');
  // 構造化後も論理的な取得元は同じ
  const structured = readReopenCoupon({
    [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-20T00:00:00.000Z',
    [PP_REOPEN_COUPON_FIELDS.SOURCE]: 'coupon-page|by=customer|at=2026-08-20T00:00:00.000Z|op=abc|why=',
  });
  assert.equal(structured.sourceKind, 'coupon-page');
  assert.equal(structured.operationId, 'abc');
});

test('取得元を偽装できない（admin-* を送っても顧客経路の値になる）', async () => {
  process.env.COUPON_HISTORY_TABLE_READY = '1';
  const db = paused();
  stubAirtable(db);
  const res = await post({
    cookie: await cookieFor(REC),
    body: { source: 'admin-grant' },
  });
  assert.equal(res.status, 200);
  const audit = P.parseCouponAudit(db[REC][PP_REOPEN_COUPON_FIELDS.SOURCE]);
  assert.equal(audit.kind, 'pause-notice', '管理者操作を騙れている');
  assert.equal(audit.byAdmin, false);
  assert.equal(history[0].fields.OperationType, 'claim');
  assert.equal(history[0].fields.Actor, 'customer');
});

test('claim は資格 / 停止 / 会員権 / 決済を 1 つも変更しない（履歴 ON でも）', async () => {
  process.env.COUPON_HISTORY_TABLE_READY = '1';
  const db = paused();
  stubAirtable(db);
  await post({ cookie: await cookieFor(REC) });
  const written = Object.keys(patches()[0].body.fields);
  assert.deepEqual(written.sort(), [
    PP_REOPEN_COUPON_FIELDS.CLAIMED_AT,
    PP_REOPEN_COUPON_FIELDS.COUPON_ID,
    PP_REOPEN_COUPON_FIELDS.SOURCE,
  ].sort());
  for (const k of ['プラン', 'Status', '有効期限', 'PaidAt', 'PaymentConfirmed',
    'PremiumPlusEligibility', 'PremiumPlusSalePaused', 'LifetimeSanrenpuku']) {
    assert.ok(!written.includes(k), `${k} を書いている`);
  }
  // 履歴にも課金・権限の列は無い
  for (const k of Object.keys(history[0].fields)) {
    assert.doesNotMatch(k, /プラン|Status|有効期限|PaidAt|Payment|Lifetime/);
  }
});
