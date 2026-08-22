/**
 * stageTeaserPaused.smoke.test.mjs — 三連複ページの導線を**販売停止中も消さない**
 *
 * ## 直した障害（2026-08-22）
 *
 * 販売を止めると `resolveUpsellForCustomer` の channel が `none` になり、
 * `/api/premium-plus-stage.json` が 404 → **三連複ページの導線ごと消えていた**。
 * 導線が無いので「買おうとする」ことすらできず、
 *
 * > お申し込みが殺到しております → 代わりにクーポンをどうぞ
 *
 * に**到達できなかった**（MK 報告「ないぞ」）。
 *
 * ## 固定する仕様
 *
 *   - 停止中でも Plus 対象会員には**販売中と同じ見た目**で枠と導線を出す
 *   - サーバーは `paused: true` と「押した先の文言」を返す（クライアントに文言を書かせない）
 *   - 対象外・非会員には停止中でも 404（存在秘匿は変えない）
 *   - この API は**読むだけ**（PATCH を 1 回も出さない）
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionV2 } from '../auth/session.js';
import { SESSION_COOKIE_NAME } from '../auth/constants.js';
import { clearAnchorCache } from './purchaseAnchorLookup.js';

const SECRET = 'test-secret-value-at-least-32-characters-long!!';
const BASE = 'appTEST123';

/** 三連複保有の Plus 対象会員（PHASE 4 = 導線が出る段階） */
const PLUS_MEMBER = Object.freeze({
  'プラン': 'Premium Sanrenpuku',
  'Status': 'active',
  '有効期限': '2099-12-31',
  'SanrenpukuPaidAt': '2020-01-01T00:00:00.000Z',
  'PremiumPlusEligibility': 'eligible',
  'PremiumPlusReleaseOverride': 'phase4',
});

let calls = [];
let realFetch;
let realEnv;

function stubAirtable(recordsById, { reopenStartsAt = null } = {}) {
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method || 'GET';
    const u = String(url);
    calls.push({ url: u, method });
    if (u.includes('redis.example.invalid')) {
      const args = JSON.parse(init.body || '[]');
      // この API は開始日時を読むだけ（HGET / HMGET）
      const result = (args[0] === 'HGET' || args[0] === 'HMGET')
        ? (reopenStartsAt ? JSON.stringify({ startsAt: reopenStartsAt, actor: 'MK' }) : null)
        : null;
      return { ok: true, status: 200, json: async () => ({ result }) };
    }
    const id = u.split('/').pop();
    if (method === 'GET' && recordsById[id]) {
      return { ok: true, status: 200, json: async () => ({ id, fields: recordsById[id] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
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

async function get(cookie) {
  const mod = await import('../../pages/api/premium-plus-stage.json.js');
  return mod.GET({
    request: new Request('https://analytics.keiba.link/api/premium-plus-stage.json', {
      headers: cookie ? { cookie } : {},
    }),
  });
}

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
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token-test';
  delete process.env.PREMIUM_PLUS_FUNNEL_ANCHOR;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in realEnv)) delete process.env[k];
  Object.assign(process.env, realEnv);
});

// ── 障害そのもの ────────────────────────────────────────────
test('停止中でも導線が消えない（本番障害「ないぞ」の再現）', async () => {
  stubAirtable({ recPAUSED00000110: { ...PLUS_MEMBER, PremiumPlusSalePaused: true } });
  const res = await get(await cookieFor('recPAUSED00000110'));
  assert.equal(res.status, 200, '停止中に 404 = 導線ごと消えている');
  const d = await res.json();
  assert.ok(d.teaser && d.teaser.title, '枠の文言が無い');
  assert.ok(d.productHref, '押せる導線が無い');
  assert.equal(d.paused, true);
});

test('停止中の見た目は販売中と同じ（押すまで違いが分からない）', async () => {
  stubAirtable({ recLIVE0000000120: { ...PLUS_MEMBER } });
  const live = await (await get(await cookieFor('recLIVE0000000120'))).json();

  clearAnchorCache();
  stubAirtable({ recPAUSED00000120: { ...PLUS_MEMBER, PremiumPlusSalePaused: true } });
  const paused = await (await get(await cookieFor('recPAUSED00000120'))).json();

  assert.deepEqual(paused.teaser, live.teaser, '停止中だけ文言が変わっている');
  assert.equal(paused.productHref, live.productHref);
  assert.equal(live.paused, false);
  assert.equal(live.pausedNotice, null, '販売中に案内を配らない');
});

// ── 押した先（サーバーが文言を持つ）────────────────────────
test('押した先の文言とクーポンをサーバーが返す', async () => {
  stubAirtable({ recPAUSED00000130: { ...PLUS_MEMBER, PremiumPlusSalePaused: true } });
  const d = await (await get(await cookieFor('recPAUSED00000130'))).json();
  const n = d.pausedNotice;

  assert.ok(n, '押した先の内容が無い');
  assert.match(n.title, /殺到/, '「殺到しており案内できない」が伝わらない');
  assert.ok(n.couponLead && n.couponAsk, 'クーポンのご案内が無い');
  assert.ok(n.discountText && n.priceText, '割引条件が無い');
  assert.equal(n.canClaim, true, '停止中の未取得会員が受け取れない');
  assert.equal(n.claimed, false);
  // クライアントに文言を書かせないため、ラベルもサーバーが持つ
  for (const k of ['claimLabel', 'thanksLabel', 'errorLabel', 'claimedHref', 'claimedHrefLabel']) {
    assert.ok(String(n[k] || '').length > 0, `${k} が無い`);
  }
});

test('取得済みなら受け取りボタンではなく確認先を出す', async () => {
  stubAirtable({
    recPAUSED00000140: {
      ...PLUS_MEMBER,
      PremiumPlusSalePaused: true,
      PremiumPlusReopenCouponClaimedAt: '2026-08-20T00:00:00.000Z',
      PremiumPlusReopenCouponId: 'premium-plus-reopen-priority@v1',
    },
  });
  const n = (await (await get(await cookieFor('recPAUSED00000140'))).json()).pausedNotice;
  assert.equal(n.claimed, true);
  assert.equal(n.canClaim, false, '二重取得を誘っている');
});

test('保存できない環境では「受け取れる」と言わない（fail closed）', async () => {
  delete process.env.PREMIUM_PLUS_REOPEN_COUPON_READY;
  stubAirtable({ recPAUSED00000150: { ...PLUS_MEMBER, PremiumPlusSalePaused: true } });
  const d = await (await get(await cookieFor('recPAUSED00000150'))).json();
  assert.equal(d.paused, true, '導線は出したままにする');
  assert.equal(d.pausedNotice.canClaim, false);
});

// ── 存在秘匿は変えない ──────────────────────────────────────
test('未ログインは停止中でも 404', async () => {
  stubAirtable({});
  assert.equal((await get('')).status, 404);
});

test('Plus の対象外は停止中でも 404（存在を知らせない）', async () => {
  stubAirtable({
    recOTHER000000160: {
      ...PLUS_MEMBER, PremiumPlusSalePaused: true, UpsellTarget: 'sanrenpuku',
    },
  });
  assert.equal((await get(await cookieFor('recOTHER000000160'))).status, 404);
});

test('資格が無い会員は停止中でも 404', async () => {
  stubAirtable({
    recBLOCKED0000170: {
      ...PLUS_MEMBER, PremiumPlusSalePaused: true, PremiumPlusEligibility: 'blocked',
    },
  });
  assert.equal((await get(await cookieFor('recBLOCKED0000170'))).status, 404);
});

// ── 副作用ゼロ ──────────────────────────────────────────────
test('この API は 1 バイトも書かない', async () => {
  stubAirtable({ recPAUSED00000180: { ...PLUS_MEMBER, PremiumPlusSalePaused: true } });
  await get(await cookieFor('recPAUSED00000180'));
  assert.equal(calls.filter((c) => c.method !== 'GET' && !c.url.includes('redis')).length, 0);
});
