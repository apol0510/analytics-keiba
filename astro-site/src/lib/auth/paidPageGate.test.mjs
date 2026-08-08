/**
 * paidPageGate.test.mjs — 有料ページのサーバー側認可
 *   node --test src/lib/auth/paidPageGate.test.mjs
 *
 * 恒久的な回帰条件:
 *   1. localStorage は判定に一切関与しない（Cookie が無ければ必ず拒否）
 *   2. 権利は `resolveEntitlements` の正本で決める。session の plan だけで決めない
 *      → `プラン=Premium` + `LifetimeSanrenpuku=true` の三連複会員を締め出さない
 *   3. 未知の requiredPlan / Airtable 引けず / customer 無し は fail closed
 *   4. 有料本文を共有キャッシュへ載せない（`private, no-store` + `Vary: Cookie`）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  gatePaidPage,
  resolveEntitlementFlag,
  PAID_DOOR_PLANS,
  PAID_PAGE_HEADERS,
  REQUIRED_PLAN_ENTITLEMENT,
} from './paidPageGate.js';
import { issuePaidSessionCookie } from './sessionIssuance.js';
import { MEMBER_TYPE } from './memberResolution.js';

const SECRET = 'test-only-fixed-hmac-secret-DO-NOT-USE-IN-PROD-0123456789';
const NOW = Date.parse('2026-08-08T03:00:00.000Z');
const env = { SESSION_SIGNING_SECRET: SECRET };

/** 署名済み ak_session を持つ Request を作る。 */
async function signedRequest({ plan, sub = 'recPAID' }) {
  const issued = await issuePaidSessionCookie({
    membership: {
      memberType: MEMBER_TYPE.PAID, normalizedPlan: plan,
      venueAccess: ['jra', 'nankan'], sessionVersion: 0, recordId: sub,
    },
    secret: SECRET, now: NOW, subtle: globalThis.crypto.subtle,
  });
  assert.ok(issued.ok, `session 発行に失敗: ${issued.reason}`);
  return new Request('https://example.test/premium-sanrenpuku-jra/', {
    headers: { cookie: issued.cookie.split(';')[0] },
  });
}
const bareRequest = () => new Request('https://example.test/premium-sanrenpuku-jra/');

/** Airtable の fields を返す差し替え。 */
const lookupOf = (fields) => async () => fields;

const SANRENPUKU_LIFETIME = {
  'プラン': 'Premium', PlanType: 'Annual', Status: 'active',
  '有効期限': '2027-07-14', LifetimeSanrenpuku: true,
};
const PLAIN_PREMIUM = {
  'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2027-07-14',
};
const LIGHT = {
  'プラン': 'Light', PlanType: 'Annual', Status: 'active', '有効期限': '2027-07-14',
};

// ── 1. Cookie が無ければ必ず拒否 ────────────────────────────────
test('Cookie 無し → 拒否（localStorage は判定に関与しない）', async () => {
  const g = await gatePaidPage({
    request: bareRequest(), requiredPlan: 'Premium Sanrenpuku', env, now: NOW,
    lookup: lookupOf(SANRENPUKU_LIFETIME),
  });
  assert.equal(g.ok, false);
  assert.ok(g.response, '拒否応答が無い');
  assert.equal(g.response.status, 302);
  assert.equal(g.response.headers.get('Location'), '/login/');
});

test('notFound:true なら 404（存在秘匿が要るページ用）', async () => {
  const g = await gatePaidPage({
    request: bareRequest(), requiredPlan: 'premium', env, now: NOW, notFound: true,
    lookup: lookupOf(PLAIN_PREMIUM),
  });
  assert.equal(g.response.status, 404);
});

test('署名が違う Cookie は通らない', async () => {
  const req = new Request('https://example.test/', { headers: { cookie: 'ak_session=forged.value' } });
  const g = await gatePaidPage({
    request: req, requiredPlan: 'premium', env, now: NOW, lookup: lookupOf(PLAIN_PREMIUM),
  });
  assert.equal(g.ok, false);
});

// ── 2. 権利は entitlement 正本で決める ──────────────────────────
test('プラン=Premium + LifetimeSanrenpuku=true は三連複ページを閲覧できる', async () => {
  // session の plan は 'premium'。**session だけで判定すると締め出してしまう会員**。
  const g = await gatePaidPage({
    request: await signedRequest({ plan: 'premium' }),
    requiredPlan: 'Premium Sanrenpuku', env, now: NOW,
    lookup: lookupOf(SANRENPUKU_LIFETIME),
  });
  assert.equal(g.ok, true, `拒否された: ${g.reason}`);
  assert.equal(g.response, null);
  assert.equal(g.entitlements.canViewSanrenpuku, true);
});

test('三連複を持たない通常 Premium は三連複ページを閲覧できない', async () => {
  const g = await gatePaidPage({
    request: await signedRequest({ plan: 'premium' }),
    requiredPlan: 'Premium Sanrenpuku', env, now: NOW,
    lookup: lookupOf(PLAIN_PREMIUM),
  });
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'entitlement_denied');
});

test('旧 tier（Premium Sanrenpuku）も閲覧できる', async () => {
  const legacy = { 'プラン': 'Premium Sanrenpuku', PlanType: 'Annual', Status: 'active', '有効期限': '2027-01-31' };
  const g = await gatePaidPage({
    request: await signedRequest({ plan: 'premium-sanrenpuku' }),
    requiredPlan: 'Premium Sanrenpuku', env, now: NOW, lookup: lookupOf(legacy),
  });
  assert.equal(g.ok, true, g.reason);
});

test('Premium / Light の境界が entitlement と一致する', async () => {
  const cases = [
    ['premium', PLAIN_PREMIUM, 'premium', true],
    ['premium', PLAIN_PREMIUM, 'standard', true],   // Premium は Light の内容も見られる
    ['light', LIGHT, 'standard', true],
    ['light', LIGHT, 'premium', false],             // Light は Premium を見られない
    ['light', LIGHT, 'Premium Sanrenpuku', false],
  ];
  for (const [sessionPlan, fields, requiredPlan, expected] of cases) {
    const g = await gatePaidPage({
      request: await signedRequest({ plan: sessionPlan }),
      requiredPlan, env, now: NOW, lookup: lookupOf(fields),
    });
    assert.equal(g.ok, expected,
      `session=${sessionPlan} required=${requiredPlan} → ${g.ok}（期待 ${expected} / ${g.reason}）`);
  }
});

test('契約が切れていれば拒否（期限は entitlement 正本が見る）', async () => {
  const expired = { ...PLAIN_PREMIUM, '有効期限': '2025-01-01' };
  const g = await gatePaidPage({
    request: await signedRequest({ plan: 'premium' }),
    requiredPlan: 'premium', env, now: NOW, lookup: lookupOf(expired),
  });
  assert.equal(g.ok, false);
});

// ── 3. fail closed ──────────────────────────────────────────────
test('未知の requiredPlan は通さない', async () => {
  for (const bad of ['', 'Premium Plus', 'admin', null, undefined, 'free']) {
    const g = await gatePaidPage({
      request: await signedRequest({ plan: 'premium' }),
      requiredPlan: bad, env, now: NOW, lookup: lookupOf(PLAIN_PREMIUM),
    });
    assert.equal(g.ok, false, `requiredPlan=${String(bad)} を通した`);
    assert.equal(g.reason, 'unknown_required_plan');
  }
});

test('Airtable を引けない / customer が無い → 拒否', async () => {
  const boom = async () => { throw new Error('airtable down'); };
  const g1 = await gatePaidPage({
    request: await signedRequest({ plan: 'premium' }),
    requiredPlan: 'premium', env, now: NOW, lookup: boom,
  });
  assert.equal(g1.ok, false);
  assert.equal(g1.reason, 'lookup_failed');

  const g2 = await gatePaidPage({
    request: await signedRequest({ plan: 'premium' }),
    requiredPlan: 'premium', env, now: NOW, lookup: lookupOf(null),
  });
  assert.equal(g2.ok, false);
  assert.equal(g2.reason, 'customer_not_found');
});

test('env 未注入は通さない（process.env を掴まない）', async () => {
  for (const bad of [undefined, null, 'x', 0]) {
    const g = await gatePaidPage({
      request: await signedRequest({ plan: 'premium' }),
      requiredPlan: 'premium', env: bad, now: NOW, lookup: lookupOf(PLAIN_PREMIUM),
    });
    assert.equal(g.ok, false, `env=${String(bad)} を通した`);
    assert.equal(g.reason, 'env_missing');
  }
});

test('SESSION_SIGNING_SECRET が無ければ通さない', async () => {
  const g = await gatePaidPage({
    request: await signedRequest({ plan: 'premium' }),
    requiredPlan: 'premium', env: {}, now: NOW, lookup: lookupOf(PLAIN_PREMIUM),
  });
  assert.equal(g.ok, false);
});

// ── 4. キャッシュ・設定 ─────────────────────────────────────────
test('有料本文を共有キャッシュへ載せない', () => {
  assert.equal(PAID_PAGE_HEADERS['Cache-Control'], 'private, no-store');
  assert.equal(PAID_PAGE_HEADERS.Vary, 'Cookie');
});

test('入口プランに free を含めない', () => {
  assert.ok(!PAID_DOOR_PLANS.includes('free'));
  assert.ok(PAID_DOOR_PLANS.includes('light'));
});

test('requiredPlan → entitlement の対応が既存 3 種を網羅する', () => {
  assert.deepEqual(Object.keys(REQUIRED_PLAN_ENTITLEMENT).sort(),
    ['Premium Sanrenpuku', 'premium', 'standard']);
  assert.equal(resolveEntitlementFlag('PREMIUM'), 'canViewPremium', '表記ゆれを吸収していない');
  assert.equal(resolveEntitlementFlag('nope'), null);
});
