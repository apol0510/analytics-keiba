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
  TRANSIENT_DENY_REASONS,
  isTransientDenyReason,
  loginReasonCode,
  LOGIN_REASON_CODE,
  PUBLIC_LOGIN_REASON_CODES,
  DEFAULT_LOGIN_REASON_CODE,
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
  assert.equal(g.response.headers.get('Location'), '/login/?r=no_session');
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

// ── 5. 一時障害を認証失敗と分離する（2026-08-10 / A）─────────────
//
// 有効な有料会員が Airtable の一時障害で `/login` に飛ばされると、
// 「ログインが切れた」と誤認して再ログインを繰り返す（再ログインしても直らない）。
// 一時障害は 503 で返し、**再ログインを促さない**。
const UNAVAILABLE = async () => ({ ok: false, reason: 'unavailable' });
const THROWS = async () => { throw new Error('airtable down'); };

test('Airtable 一時障害 → 503。/login へ飛ばさない', async () => {
  for (const [label, lookup] of [['unavailable', UNAVAILABLE], ['例外', THROWS]]) {
    const g = await gatePaidPage({
      request: await signedRequest({ plan: 'premium' }),
      requiredPlan: 'premium', env, now: NOW, lookup,
    });
    assert.equal(g.ok, false, label);
    assert.equal(g.response.status, 503, `${label}: 503 ではない`);
    assert.equal(g.response.headers.get('Location'), null, `${label}: /login へ飛ばしている`);
    assert.equal(g.response.headers.get('Retry-After'), '30', `${label}: Retry-After が無い`);
    assert.equal(g.response.headers.get('Cache-Control'), 'private, no-store');
  }
});

test('一時障害ページは「ログインし直せ」と言わない', async () => {
  const g = await gatePaidPage({
    request: await signedRequest({ plan: 'premium' }),
    requiredPlan: 'premium', env, now: NOW, lookup: UNAVAILABLE,
  });
  const html = await g.response.text();
  assert.match(html, /ログイン状態は保持されています/, '「切れていない」と伝えていない');
  assert.match(html, /ログインし直す必要はありません/);
  // 再ログインへの導線そのものを置かない（押させない）
  assert.ok(!html.includes('/login'), '一時障害ページに /login への導線がある');
  assert.ok(!/ログインしてください|再度ログイン(?!が)/.test(html),
    '一時障害なのに再ログインを促している');
});

test('notFound:true でも一時障害は 503（存在は漏れない）', async () => {
  // ここへ到達できるのは**有効な署名 Cookie を持つ許可プランの利用者だけ**。
  // 匿名アクセスは前段の session 検証で 404 になるため、503 で存在は漏れない。
  const g = await gatePaidPage({
    request: await signedRequest({ plan: 'premium' }),
    requiredPlan: 'premium', env, now: NOW, notFound: true, lookup: UNAVAILABLE,
  });
  assert.equal(g.response.status, 503);

  const anon = await gatePaidPage({
    request: bareRequest(), requiredPlan: 'premium', env, now: NOW, notFound: true, lookup: UNAVAILABLE,
  });
  assert.equal(anon.response.status, 404, '匿名に 404 以外を返している（存在が漏れる）');
});

test('SESSION_SIGNING_SECRET 欠落も 503（利用者は再ログインしても直せない）', async () => {
  const g = await gatePaidPage({
    request: await signedRequest({ plan: 'premium' }),
    requiredPlan: 'premium', env: {}, now: NOW, lookup: lookupOf(PLAIN_PREMIUM),
  });
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'key_missing');
  assert.equal(g.response.status, 503);
});

test('設定ミス（env / requiredPlan）も /login へ飛ばさない', async () => {
  const g1 = await gatePaidPage({
    request: await signedRequest({ plan: 'premium' }),
    requiredPlan: 'premium', env: undefined, now: NOW, lookup: lookupOf(PLAIN_PREMIUM),
  });
  assert.equal(g1.response.status, 503);
  const g2 = await gatePaidPage({
    request: await signedRequest({ plan: 'premium' }),
    requiredPlan: 'admin', env, now: NOW, lookup: lookupOf(PLAIN_PREMIUM),
  });
  assert.equal(g2.response.status, 503);
});

test('customer_not_found は認証側（302）のまま', async () => {
  // Customers に居ない = セッションが指す会員が消えている。再ログインで解決しうる。
  const g = await gatePaidPage({
    request: await signedRequest({ plan: 'premium' }),
    requiredPlan: 'premium', env, now: NOW, lookup: lookupOf(null),
  });
  assert.equal(g.response.status, 302);
  assert.equal(g.response.headers.get('Location'), '/login/?r=no_session');
});

// ── 6. /login へ渡す reason code（C）────────────────────────────
test('期限切れセッションは r=session_expired', async () => {
  const THIRTY_ONE_DAYS = 31 * 24 * 60 * 60 * 1000;
  const g = await gatePaidPage({
    request: await signedRequest({ plan: 'premium' }),
    requiredPlan: 'premium', env, now: NOW + THIRTY_ONE_DAYS, lookup: lookupOf(PLAIN_PREMIUM),
  });
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'session_expired');
  assert.equal(g.response.headers.get('Location'), '/login/?r=session_expired');
});

test('権利不足は r=not_entitled（「ログインが切れた」と誤解させない）', async () => {
  const g = await gatePaidPage({
    request: await signedRequest({ plan: 'light' }),
    requiredPlan: 'premium', env, now: NOW, lookup: lookupOf(LIGHT),
  });
  assert.equal(g.reason, 'entitlement_denied');
  assert.equal(g.response.headers.get('Location'), '/login/?r=not_entitled');
});

test('未知 reason は既定コードへ丸める（Location へ注入されない）', () => {
  assert.equal(loginReasonCode('totally_unknown'), DEFAULT_LOGIN_REASON_CODE);
  assert.equal(loginReasonCode(undefined), DEFAULT_LOGIN_REASON_CODE);
  assert.equal(loginReasonCode('../../evil?x=1'), DEFAULT_LOGIN_REASON_CODE);
  for (const code of PUBLIC_LOGIN_REASON_CODES) {
    assert.match(code, /^[a-z_]+$/, `URL に出せない文字を含む: ${code}`);
  }
});

test('公開コードの集合が login.astro の表示側と一致する', () => {
  assert.deepEqual([...PUBLIC_LOGIN_REASON_CODES].sort(),
    ['no_session', 'not_entitled', 'session_expired']);
});

test('一時障害の reason は /login コードへ写像しない（分離の担保）', () => {
  for (const r of TRANSIENT_DENY_REASONS) {
    assert.ok(isTransientDenyReason(r), `${r} が一時障害扱いになっていない`);
    assert.ok(!Object.prototype.hasOwnProperty.call(LOGIN_REASON_CODE, r),
      `${r} が /login 用コードにも入っている（分離が壊れている）`);
  }
  assert.equal(isTransientDenyReason('entitlement_denied'), false);
  assert.equal(isTransientDenyReason('no_cookie'), false);
});
