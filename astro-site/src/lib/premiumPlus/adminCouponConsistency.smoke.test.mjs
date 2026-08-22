/**
 * adminCouponConsistency.smoke.test.mjs — 管理画面の見立てと**実際の挙動**を一致させる
 *
 * 管理画面が「いま受け取れる」と出しているのに、お客様が導線を押すと受け取れない
 * （またはその逆）という食い違いは、運営者の判断そのものを誤らせる。
 *
 * そこでこのテストは**同じ 1 人の会員**に対して
 *
 *   1. 管理 Function（`lookup`）が返す `reopenCouponAccess.canClaim`
 *   2. お客様側の取得 API（`POST /api/premium-plus-coupon.json`）が実際に受け付けるか
 *
 * を**両方とも本物のハンドラで**動かし、**一致すること**を検査する。
 *
 * 併せて、この機能の目的（買おうとした → 売っていない → 代わりにクーポン）を
 * 管理画面の表示側でも固定する:
 *   - 販売中の会員には配らない（埋め合わせが要らない）
 *   - 販売停止中の会員には配る（**再募集が未開始でも**）
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { createSessionV2 } from '../auth/session.js';
import { SESSION_COOKIE_NAME } from '../auth/constants.js';
import { clearAnchorCache } from './purchaseAnchorLookup.js';
import { PP_SALE_PAUSE_FIELDS } from './premiumPlusRelease.js';
import { REOPEN_MEMBERS_KEY } from './premiumPlusReopenStartStore.js';

const FN = fileURLToPath(new URL('../../../netlify/functions/premium-plus-eligibility.js', import.meta.url));
const ADMIN_SECRET = 'admin-secret-for-test';
const SESSION_SECRET = 'test-secret-value-at-least-32-characters-long!!';

const PLUS_MEMBER = Object.freeze({
  'プラン': 'Premium Sanrenpuku',
  'Status': 'active',
  '有効期限': '2099-12-31',
  'SanrenpukuPaidAt': '2020-01-01T00:00:00.000Z',
  'PremiumPlusEligibility': 'eligible',
  'PremiumPlusReleaseOverride': 'phase4',
});

let db;
let redisStore;
let realFetch;
let realEnv;

/** HSETNX / HGET / HMGET / SET NX / EVAL を本物どおりに実装した合成 Redis */
function redisCmd(args) {
  const [op, ...rest] = args;
  if (op === 'SET') {
    const [key, value, ...opts] = rest;
    if (opts.includes('NX') && redisStore.has(key)) return null;
    redisStore.set(key, value);
    return 'OK';
  }
  if (op === 'HSETNX') {
    const [key, field, value] = rest;
    const h = redisStore.get(key) instanceof Map ? redisStore.get(key) : new Map();
    redisStore.set(key, h);
    if (h.has(field)) return 0;
    h.set(field, value);
    return 1;
  }
  if (op === 'HGET') {
    const h = redisStore.get(rest[0]);
    return h instanceof Map && h.has(rest[1]) ? h.get(rest[1]) : null;
  }
  if (op === 'HMGET') {
    const [key, ...fs] = rest;
    const h = redisStore.get(key);
    return fs.map((f) => (h instanceof Map && h.has(f) ? h.get(f) : null));
  }
  if (op === 'EVAL') {
    const [script, , key, token] = rest;
    const cur = redisStore.get(key);
    if (cur === undefined) return 'LOST';
    if (cur !== token) return 'STOLEN';
    if (script.includes('DEL')) redisStore.delete(key);
    return 'OK';
  }
  if (op === 'INCR') {
    const n = Number(redisStore.get(rest[0]) || 0) + 1;
    redisStore.set(rest[0], String(n));
    return n;
  }
  return null;
}

function stubFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    const ok = (b) => ({ ok: true, status: 200, json: async () => b, text: async () => JSON.stringify(b) });
    const err = (s) => ({ ok: false, status: s, json: async () => ({}), text: async () => 'error' });

    if (u.includes('redis.example.invalid')) {
      try { return ok({ result: redisCmd(JSON.parse(init.body || '[]')) }); } catch { return err(500); }
    }
    if (u.includes('/Customers/listRecords')) {
      return ok({ records: Object.entries(db).map(([id, fields]) => ({ id, fields })) });
    }
    if (u.includes('/CouponOperationHistory') || u.includes('/PromotionalOffers')) {
      if (method === 'POST' && !u.endsWith('/listRecords')) return ok({ records: [] });
      return ok({ records: [] });
    }
    if (u.includes('/CampaignDeliveries')) return ok({ records: [] });
    if (u.includes('/Customers/')) {
      const id = u.split('/Customers/')[1];
      if (!db[id]) return err(404);
      if (method === 'PATCH') {
        Object.assign(db[id], JSON.parse(init.body || '{}').fields);
        return ok({ id, fields: db[id] });
      }
      return ok({ id, fields: db[id] });
    }
    return err(403);
  };
}

let handlerPromise = null;
function loadHandler() {
  if (!handlerPromise) {
    globalThis.exports = {};
    globalThis.module = { exports: globalThis.exports };
    handlerPromise = import(FN).then(() => globalThis.exports.handler);
  }
  return handlerPromise;
}

/** 管理画面が見ている 1 行を取る */
async function adminRow(recordId) {
  const handler = await loadHandler();
  const res = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-secret': ADMIN_SECRET },
    body: JSON.stringify({ action: 'lookup', recordId }),
  });
  const body = JSON.parse(res.body);
  return (body.rows || []).find((r) => r.recordId === recordId) || null;
}

/** お客様が導線を押して受け取ろうとする */
async function customerClaim(recordId) {
  clearAnchorCache();
  const now = Date.now();
  const { token } = await createSessionV2({
    sub: recordId, plan: 'premium-sanrenpuku', venueAccess: ['jra', 'nankan'],
    sessionVersion: 1, now, ttlMs: 20 * 60 * 1000, sessionStart: now, secret: SESSION_SECRET,
  });
  const mod = await import('../../pages/api/premium-plus-coupon.json.js');
  const res = await mod.POST({
    request: new Request('https://analytics.keiba.link/api/premium-plus-coupon.json', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'sanrenpuku-cta' }),
    }),
  });
  // 存在秘匿の 404 は JSON を返さない（本文で理由を語らない）ので、素で読む
  let body = {};
  try { body = await res.json(); } catch { body = {}; }
  return { status: res.status, body };
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  realEnv = { ...process.env };
  process.env.PREMIUM_PLUS_ADMIN_SECRET = ADMIN_SECRET;
  process.env.SESSION_SIGNING_SECRET = SESSION_SECRET;
  process.env.AIRTABLE_API_KEY = 'key-test';
  process.env.AIRTABLE_BASE_ID = 'app-test';
  process.env.PREMIUM_PLUS_FIELDS_READY = '1';
  process.env.PREMIUM_PLUS_REOPEN_COUPON_READY = '1';
  process.env.PREMIUM_PLUS_SALE_PAUSE_READY = '1';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token-test';
  delete process.env.PREMIUM_PLUS_FUNNEL_ANCHOR;
  redisStore = new Map();
  db = {};
  clearAnchorCache();
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in realEnv)) delete process.env[k];
  Object.assign(process.env, realEnv);
});

function seedStart(recordId, startsAtIso = '2026-08-22T00:00:00.000Z') {
  const h = redisStore.get(REOPEN_MEMBERS_KEY) instanceof Map
    ? redisStore.get(REOPEN_MEMBERS_KEY) : new Map();
  redisStore.set(REOPEN_MEMBERS_KEY, h);
  h.set(recordId, JSON.stringify({ startsAt: startsAtIso, actor: 'MK' }));
}

// ── 管理画面の見立て = 実際の挙動 ───────────────────────────
const CASES = [
  {
    label: '販売停止中・未開始',
    id: 'recCONSIST0000010',
    fields: { [PP_SALE_PAUSE_FIELDS.PAUSED]: true },
    expectClaim: true,
  },
  {
    label: '販売停止中・開始済み',
    id: 'recCONSIST0000020',
    fields: { [PP_SALE_PAUSE_FIELDS.PAUSED]: true },
    start: true,
    expectClaim: true,
  },
  {
    label: '販売中（買えるので配らない）',
    id: 'recCONSIST0000030',
    fields: {},
    start: true,
    expectClaim: false,
  },
  {
    label: '販売停止中だが取得済み',
    id: 'recCONSIST0000040',
    fields: {
      [PP_SALE_PAUSE_FIELDS.PAUSED]: true,
      PremiumPlusReopenCouponClaimedAt: '2026-08-20T00:00:00.000Z',
      PremiumPlusReopenCouponId: 'premium-plus-reopen-priority@v1',
    },
    expectClaim: false,
  },
  {
    label: 'Plus の対象外（導線を三連複に固定）',
    id: 'recCONSIST0000050',
    fields: { [PP_SALE_PAUSE_FIELDS.PAUSED]: true, UpsellTarget: 'sanrenpuku' },
    expectClaim: false,
  },
];

for (const c of CASES) {
  test(`管理画面の「いま受け取れるか」＝実際の取得可否: ${c.label}`, async () => {
    db[c.id] = { ...PLUS_MEMBER, ...c.fields };
    if (c.start) seedStart(c.id);

    const row = await adminRow(c.id);
    assert.ok(row, '管理画面がこの会員を見つけられない');
    assert.ok(row.reopenCouponAccess, '管理画面に「いま受け取れるか」が無い');
    assert.equal(row.reopenCouponAccess.canClaim, c.expectClaim, '管理画面の見立てが違う');

    // ⚠️ ここが本題。**同じ会員に本物の取得 API を当てて突き合わせる**
    const claim = await customerClaim(c.id);
    const actuallyClaimed = claim.status === 200 && claim.body.alreadyClaimed !== true;
    assert.equal(
      actuallyClaimed, c.expectClaim,
      `管理画面は ${c.expectClaim ? '受け取れる' : '受け取れない'} と出しているのに実際は逆`,
    );
    // 運営者向けの一行も必ず埋まっている（画面で組み立てない）
    assert.ok(String(row.reopenCouponAccess.label || '').length > 0);
  });
}

// ── 目的そのものを管理画面側でも固定する ────────────────────
test('販売中の会員には配らない（クーポンは買えなかった方への埋め合わせ）', async () => {
  const id = 'recCONSIST0000060';
  db[id] = { ...PLUS_MEMBER };
  seedStart(id);
  const a = (await adminRow(id)).reopenCouponAccess;
  assert.equal(a.canClaim, false);
  assert.match(a.why, /購入できる/, '配らない理由が運営者に伝わらない');
});

test('販売停止中は**再募集が未開始でも**配る（開始は取得の条件ではない）', async () => {
  const id = 'recCONSIST0000070';
  db[id] = { ...PLUS_MEMBER, [PP_SALE_PAUSE_FIELDS.PAUSED]: true };
  const a = (await adminRow(id)).reopenCouponAccess;
  assert.equal(a.canClaim, true, '「買える人だけ取得できる」へ逆戻りしている');
});

test('取得済みで再募集が未開始なら「取得済み・いまは使えない」', async () => {
  const id = 'recCONSIST0000080';
  db[id] = {
    ...PLUS_MEMBER,
    [PP_SALE_PAUSE_FIELDS.PAUSED]: true,
    PremiumPlusReopenCouponClaimedAt: '2026-08-20T00:00:00.000Z',
    PremiumPlusReopenCouponId: 'premium-plus-reopen-priority@v1',
  };
  const a = (await adminRow(id)).reopenCouponAccess;
  assert.equal(a.canUse, false);
  assert.match(a.label, /取得済み/);
});

test('取得済み・開始済み・期限内なら「いま使える」', async () => {
  const id = 'recCONSIST0000090';
  db[id] = {
    ...PLUS_MEMBER,
    PremiumPlusReopenCouponClaimedAt: '2026-08-20T00:00:00.000Z',
    PremiumPlusReopenCouponId: 'premium-plus-reopen-priority@v1',
  };
  seedStart(id, new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  const a = (await adminRow(id)).reopenCouponAccess;
  assert.equal(a.canUse, true);
  assert.match(a.label, /使える/);
});
