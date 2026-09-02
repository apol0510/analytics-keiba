/**
 * viewerEntitlements.test.mjs — 「いま見ているのは誰か」の単一源
 *   node --test src/lib/auth/viewerEntitlements.test.mjs
 *
 * 恒久的な回帰条件（2026-09-02 の Light 会員導線事故）:
 *   1. **localStorage は判定に一切関与しない**。根拠は ak_session + Airtable だけ
 *   2. 無料会員・Light 会員を `anonymous` に落とさない（入口は会員全員）
 *   3. 「ログインしていない」と「判定できなかった」を潰さない
 *      → 一時障害を `anonymous` にすると、有効な会員へ再ログインを促してしまう
 *   4. 権利ゼロ（期限切れ・退会）でも `member` ではあるが、権利は 1 つも立たない
 *   5. 画面へ渡すのは列挙した項目だけ（Customers の内部列を素通しにしない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveViewer, viewerProfile, VIEWER_STATE, isUnknownReason } from './viewerEntitlements.js';
import { issuePaidSessionCookie } from './sessionIssuance.js';
import { MEMBER_TYPE } from './memberResolution.js';

const SECRET = 'test-only-fixed-hmac-secret-DO-NOT-USE-IN-PROD-0123456789';
const NOW = Date.parse('2026-09-02T07:00:00.000Z');
const env = { SESSION_SIGNING_SECRET: SECRET };

async function signedRequest({ plan, sub = 'recMEMBER' }) {
  const issued = await issuePaidSessionCookie({
    membership: {
      memberType: MEMBER_TYPE.PAID, normalizedPlan: plan,
      venueAccess: ['jra', 'nankan'], sessionVersion: 0, recordId: sub,
    },
    secret: SECRET, now: NOW, subtle: globalThis.crypto.subtle,
  });
  assert.ok(issued.ok, `session 発行に失敗: ${issued.reason}`);
  return new Request('https://example.test/dashboard/', {
    headers: { cookie: issued.cookie.split(';')[0] },
  });
}
const bareRequest = () => new Request('https://example.test/dashboard/');
const lookupOf = (fields) => async () => ({ ok: true, fields });

const LIGHT = { 'プラン': 'Light', PlanType: 'Annual', Status: 'active', '有効期限': '2027-07-14' };
const PREMIUM = { 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2027-07-14' };
const EXPIRED_PREMIUM = { 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2026-01-01' };

// ── 1. localStorage は関与しない / Cookie が無ければ anonymous ──────────
test('Cookie 無し → anonymous（localStorage を持ち出す余地が無い）', async () => {
  const v = await resolveViewer({ request: bareRequest(), env, now: NOW, lookup: lookupOf(PREMIUM) });
  assert.equal(v.state, VIEWER_STATE.ANONYMOUS);
  assert.equal(v.isMember, false);
  assert.equal(v.entitlements.canViewLight, false);
  assert.equal(v.entitlements.canViewPremium, false);
  assert.equal(v.profile, null);
});

test('署名が壊れた Cookie → anonymous（内訳は verify_failed のみ）', async () => {
  const req = new Request('https://example.test/dashboard/', { headers: { cookie: 'ak_session=not-a-real-token' } });
  const v = await resolveViewer({ request: req, env, now: NOW, lookup: lookupOf(PREMIUM) });
  assert.equal(v.state, VIEWER_STATE.ANONYMOUS);
});

// ── 2. Light 会員を締め出さない（入口は会員全員）────────────────────
test('Light 会員 → member かつ canViewLight（Premium は立たない）', async () => {
  const v = await resolveViewer({
    request: await signedRequest({ plan: 'light' }), env, now: NOW, lookup: lookupOf(LIGHT),
  });
  assert.equal(v.state, VIEWER_STATE.MEMBER);
  assert.equal(v.isMember, true);
  assert.equal(v.entitlements.canViewLight, true);
  assert.equal(v.entitlements.canViewPremium, false);
  assert.equal(v.recordId, 'recMEMBER');
});

test('Premium 会員 → canViewPremium と canViewLight の両方', async () => {
  const v = await resolveViewer({
    request: await signedRequest({ plan: 'premium' }), env, now: NOW, lookup: lookupOf(PREMIUM),
  });
  assert.equal(v.entitlements.canViewPremium, true);
  assert.equal(v.entitlements.canViewLight, true);
});

// ── 3. 「判定できなかった」を anonymous に潰さない ──────────────────
test('鍵未設定 → unknown（ログアウトとは言わない）', async () => {
  const v = await resolveViewer({ request: bareRequest(), env: {}, now: NOW, lookup: lookupOf(LIGHT) });
  assert.equal(v.state, VIEWER_STATE.UNKNOWN);
  assert.equal(v.reason, 'key_missing');
  assert.ok(isUnknownReason(v.reason));
  assert.equal(v.entitlements.canViewLight, false, 'unknown でも権利は与えない');
});

test('env 未注入 → unknown（既定値で process.env を掴まない）', async () => {
  const v = await resolveViewer({ request: bareRequest(), env: null, now: NOW });
  assert.equal(v.state, VIEWER_STATE.UNKNOWN);
  assert.equal(v.reason, 'env_missing');
});

test('Airtable 一時障害 → unknown（customer_not_found へ潰さない）', async () => {
  const v = await resolveViewer({
    request: await signedRequest({ plan: 'light' }), env, now: NOW,
    lookup: async () => ({ ok: false, reason: 'unavailable' }),
  });
  assert.equal(v.state, VIEWER_STATE.UNKNOWN);
  assert.equal(v.reason, 'lookup_unavailable');
});

test('lookup が例外を投げても落ちず unknown', async () => {
  const v = await resolveViewer({
    request: await signedRequest({ plan: 'light' }), env, now: NOW,
    lookup: async () => { throw new Error('boom'); },
  });
  assert.equal(v.state, VIEWER_STATE.UNKNOWN);
  assert.equal(v.reason, 'lookup_failed');
});

test('会員レコードが存在しない → anonymous（一時障害と区別する）', async () => {
  const v = await resolveViewer({
    request: await signedRequest({ plan: 'light' }), env, now: NOW,
    lookup: async () => ({ ok: false, reason: 'not_found' }),
  });
  assert.equal(v.state, VIEWER_STATE.ANONYMOUS);
  assert.equal(v.reason, 'customer_not_found');
});

// ── 4. 権利なし ────────────────────────────────────────────────
test('期限切れ会員 → member だが閲覧権はゼロ', async () => {
  const v = await resolveViewer({
    request: await signedRequest({ plan: 'premium' }), env, now: NOW, lookup: lookupOf(EXPIRED_PREMIUM),
  });
  assert.equal(v.state, VIEWER_STATE.MEMBER);
  assert.equal(v.entitlements.canViewPremium, false);
  assert.equal(v.entitlements.canViewLight, false);
});

test('退会申請済み → 閲覧権ゼロ', async () => {
  const v = await resolveViewer({
    request: await signedRequest({ plan: 'premium' }), env, now: NOW,
    lookup: lookupOf({ ...PREMIUM, WithdrawalRequested: true }),
  });
  assert.equal(v.entitlements.canViewPremium, false);
  assert.equal(v.entitlements.canViewLight, false);
});

// ── 5. 画面へ渡す項目を限定する ──────────────────────────────────
test('profile は列挙した項目だけ（内部列を素通しにしない）', () => {
  const p = viewerProfile({
    Email: 'a@example.test', '氏名': '末吉 太郎', 'プラン': 'Light', PlanType: 'Annual',
    '有効期限': '2026-10-01', 'ポイント': 3,
    // 以下は画面に出してはいけない内部列
    PaymentConfirmed: true, RequestedAmount: 4980, Source: 'customer-import:2026-08',
    LifetimeSanrenpuku: true, ForceLogout: false,
  });
  assert.deepEqual(Object.keys(p).sort(), ['email', 'name', 'planType', 'plan', 'points', 'validUntil'].sort());
  assert.equal(p.email, 'a@example.test');
  assert.equal(p.name, '末吉 太郎');
  assert.equal(p.plan, 'Light');
  assert.equal(p.points, 3);
});

test('profile は空欄を null にする（"undefined" 等を画面へ出さない）', () => {
  const p = viewerProfile({ Email: '', 'プラン': 'Light' });
  assert.equal(p.email, null);
  assert.equal(p.points, null);
  assert.equal(p.name, null);
});

test('member のときだけ profile を返す', async () => {
  const anon = await resolveViewer({ request: bareRequest(), env, now: NOW, lookup: lookupOf(LIGHT) });
  assert.equal(anon.profile, null);
  const member = await resolveViewer({
    request: await signedRequest({ plan: 'light' }), env, now: NOW,
    lookup: lookupOf({ ...LIGHT, Email: 'l@example.test' }),
  });
  assert.equal(member.profile.email, 'l@example.test');
});
