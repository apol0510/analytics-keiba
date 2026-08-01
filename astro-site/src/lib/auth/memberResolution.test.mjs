/**
 * memberResolution.test.mjs — 会員判定（resolveMembership）のテーブル駆動テスト
 *   node --test src/lib/auth/memberResolution.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveMembership,
  resolveSessionVersion,
  MEMBER_TYPE,
  MEMBER_REASON,
} from './memberResolution.js';

const NOW = 1_750_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const past = new Date(NOW - DAY).toISOString();
const future = new Date(NOW + 30 * DAY).toISOString();

function resolve(fields, over = {}) {
  return resolveMembership({ fields, recordId: 'recTEST', now: NOW, ...over });
}

// =========================================================================
// 有効な会員（free / paid）
// =========================================================================

test('明確な Free → free（plan 名は free 固定・venueAccess 空）', () => {
  const r = resolve({ 'プラン': 'Free', Status: 'active' });
  assert.equal(r.memberType, MEMBER_TYPE.FREE);
  assert.equal(r.normalizedPlan, 'free');
  assert.deepEqual(r.venueAccess, []);
  assert.equal(r.recordId, 'recTEST');
});

const PAID_OK = [
  ['Light', 'Light', 'light'],
  ['Premium', 'Premium', 'premium'],
  ['三連複 Premium Sanrenpuku', 'Premium Sanrenpuku', 'premium-sanrenpuku'],
  ['三連単 Premium Sanrentan', 'Premium Sanrentan', 'premium-sanrentan'],
  ['Premium Combo', 'Premium Combo', 'premium-combo'],
  ['Premium Plus', 'Premium Plus', 'premium-plus'],
];
for (const [name, raw, expected] of PAID_OK) {
  test(`有効な有料 ${name} → paid（正規 plan=${expected}）`, () => {
    const r = resolve({ 'プラン': raw, Status: 'active', '有効期限': future });
    assert.equal(r.memberType, MEMBER_TYPE.PAID);
    assert.equal(r.normalizedPlan, expected);
    assert.equal(r.reason, MEMBER_REASON.ACTIVE_PAID);
  });
}

test('Status 未設定でも期限内の有料は paid（互換: 旧データに Status なし）', () => {
  const r = resolve({ 'プラン': 'Premium' });
  assert.equal(r.memberType, MEMBER_TYPE.PAID);
});

test('venueAccess: jra 文字列 → ["jra"]', () => {
  const r = resolve({ 'プラン': 'Premium', Status: 'active', VenueAccess: 'jra' });
  assert.deepEqual(r.venueAccess, ['jra']);
});
test('venueAccess: all → ["jra","nankan"]', () => {
  const r = resolve({ 'プラン': 'Premium', Status: 'active', VenueAccess: 'all' });
  assert.deepEqual(r.venueAccess, ['jra', 'nankan']);
});
test('venueAccess: 未指定 → 両会場デフォルト', () => {
  const r = resolve({ 'プラン': 'Premium', Status: 'active' });
  assert.deepEqual(r.venueAccess, ['jra', 'nankan']);
});
test('venueAccess: 未知値 → denied(unknown_venue)', () => {
  const r = resolve({ 'プラン': 'Premium', Status: 'active', VenueAccess: 'mars' });
  assert.equal(r.memberType, MEMBER_TYPE.DENIED);
  assert.equal(r.reason, MEMBER_REASON.UNKNOWN_VENUE);
});

// =========================================================================
// 拒否系
// =========================================================================

test('plan 欠落（フィールド自体なし）→ denied(missing_plan)', () => {
  const r = resolve({ Status: 'active' });
  assert.equal(r.memberType, MEMBER_TYPE.DENIED);
  assert.equal(r.reason, MEMBER_REASON.MISSING_PLAN);
});

test('未知 plan 値 → denied(unknown_plan)', () => {
  const r = resolve({ 'プラン': 'wizard', Status: 'active' });
  assert.equal(r.memberType, MEMBER_TYPE.DENIED);
  assert.equal(r.reason, MEMBER_REASON.UNKNOWN_PLAN);
});

test('ForceLogout=true → denied', () => {
  assert.equal(resolve({ 'プラン': 'Premium', Status: 'active', ForceLogout: true }).reason, MEMBER_REASON.FORCE_LOGOUT);
  assert.equal(resolve({ 'プラン': 'Premium', Status: 'active', ForceLogout: 1 }).memberType, MEMBER_TYPE.DENIED);
});

const SUSPENDED = ['suspended', 'inactive', 'Inactive', '停止', '解約'];
for (const s of SUSPENDED) {
  test(`Status=${s} → denied(status_suspended)`, () => {
    const r = resolve({ 'プラン': 'Premium', Status: s });
    assert.equal(r.memberType, MEMBER_TYPE.DENIED);
    assert.equal(r.reason, MEMBER_REASON.STATUS_SUSPENDED);
  });
}

test('入金待ち Status=pending + 有料プラン名 → free（有料化しない）', () => {
  const r = resolve({ 'プラン': 'Light', Status: 'pending' });
  assert.equal(r.memberType, MEMBER_TYPE.FREE);
  assert.equal(r.reason, MEMBER_REASON.PENDING_PAYMENT_FREE);
});

test('プラン(有料) と Plan(無料) が食い違う → denied(plan_conflict)', () => {
  const r = resolve({ 'プラン': 'Premium', Plan: 'Free', Status: 'active' });
  assert.equal(r.memberType, MEMBER_TYPE.DENIED);
  assert.equal(r.reason, MEMBER_REASON.PLAN_CONFLICT);
});

test('クライアント由来の plan は引数に無い（fields のみ参照）', () => {
  // plan を渡さず email だけ相当 → missing_plan（推測しない）
  const r = resolve({ Email: 'x@y.z' });
  assert.equal(r.memberType, MEMBER_TYPE.DENIED);
  assert.equal(r.reason, MEMBER_REASON.MISSING_PLAN);
});

// =========================================================================
// SessionVersion
// =========================================================================

test('SessionVersion 欠落 → 0', () => {
  assert.equal(resolve({ 'プラン': 'Free' }).sessionVersion, 0);
});
test('SessionVersion 空文字 → 0', () => {
  assert.equal(resolve({ 'プラン': 'Free', SessionVersion: '' }).sessionVersion, 0);
});
test('SessionVersion 正の整数を保持', () => {
  assert.equal(resolve({ 'プラン': 'Premium', Status: 'active', SessionVersion: 5 }).sessionVersion, 5);
});
test('SessionVersion 文字列数値 "3" → 3', () => {
  assert.equal(resolve({ 'プラン': 'Premium', Status: 'active', SessionVersion: '3' }).sessionVersion, 3);
});
test('SessionVersion 負数 → denied(invalid_session_version)', () => {
  const r = resolve({ 'プラン': 'Premium', Status: 'active', SessionVersion: -1 });
  assert.equal(r.memberType, MEMBER_TYPE.DENIED);
  assert.equal(r.reason, MEMBER_REASON.INVALID_SESSION_VERSION);
});
test('SessionVersion 非整数 → denied', () => {
  assert.equal(resolve({ 'プラン': 'Premium', Status: 'active', SessionVersion: 1.5 }).reason, MEMBER_REASON.INVALID_SESSION_VERSION);
});
test('SessionVersion 異常型（オブジェクト）→ denied', () => {
  assert.equal(resolve({ 'プラン': 'Premium', Status: 'active', SessionVersion: {} }).reason, MEMBER_REASON.INVALID_SESSION_VERSION);
});

test('resolveSessionVersion 単体', () => {
  assert.deepEqual(resolveSessionVersion(undefined), { ok: true, value: 0 });
  assert.deepEqual(resolveSessionVersion(''), { ok: true, value: 0 });
  assert.deepEqual(resolveSessionVersion(7), { ok: true, value: 7 });
  assert.equal(resolveSessionVersion(-1).ok, false);
  assert.equal(resolveSessionVersion(2.5).ok, false);
  assert.equal(resolveSessionVersion('-3').ok, false);
});

// =========================================================================
// 契約終了（期限切れ / 退会申請）→ 無料会員（2026-08-01 / PR-B の後退を復元）
//
// 旧 auth-user は期限切れでも 200 + 「無料会員としてご利用いただけます」だった。
// PR-B で denied になり、元有料会員がマイページ・ポイント・再契約導線へ到達できなくなった。
// ここでは「free になること」と「有料権限が 1 つも漏れないこと」を両方固定する。
// =========================================================================

const ENDED_CONTRACTS = [
  ['期限切れ Premium', { 'プラン': 'Premium', Status: 'active', '有効期限': past }, MEMBER_REASON.EXPIRED],
  ['期限切れ Light', { 'プラン': 'Light', Status: 'active', '有効期限': past }, MEMBER_REASON.EXPIRED],
  ['期限切れ Premium Sanrenpuku（Lifetime なし）',
    { 'プラン': 'Premium Sanrenpuku', Status: 'active', '有効期限': past, LifetimeSanrenpuku: false },
    MEMBER_REASON.EXPIRED],
  ['期限切れ Premium Plus', { 'プラン': 'Premium Plus', Status: 'active', '有効期限': past }, MEMBER_REASON.EXPIRED],
  ['期限切れ（ExpirationDate 別名）', { 'プラン': 'Premium', ExpirationDate: past }, MEMBER_REASON.EXPIRED],
  ['退会申請（期限内）', { 'プラン': 'Premium', Status: 'active', '有効期限': future, WithdrawalRequested: true },
    MEMBER_REASON.WITHDRAWAL_REQUESTED],
  ['退会申請（期限切れ）', { 'プラン': 'Premium', Status: 'active', '有効期限': past, WithdrawalRequested: true },
    MEMBER_REASON.WITHDRAWAL_REQUESTED],
  ['退会申請（数値フラグ 1）', { 'プラン': 'Light', Status: 'active', WithdrawalRequested: 1 },
    MEMBER_REASON.WITHDRAWAL_REQUESTED],
];

for (const [name, fields, reason] of ENDED_CONTRACTS) {
  test(`${name} → free（plan 'free' 固定・有料権限なし）`, () => {
    const r = resolve(fields);
    assert.equal(r.memberType, MEMBER_TYPE.FREE);
    assert.equal(r.reason, reason);
    // 元のプラン名を絶対に返さない（返すと権限判定に使われうる）
    assert.equal(r.normalizedPlan, 'free');
    assert.deepEqual(r.venueAccess, []);
    assert.equal(r.lifetimeSanrenpuku, false);
    assert.equal(r.entitlementSource, 'none');
    // 値のどこにも Premium / Light 等の元プラン名が混ざっていないこと
    // （キー名 `lifetimeSanrenpuku` に反応しないよう **値だけ**を見る）
    const values = JSON.stringify(Object.values(r));
    assert.ok(!/premium|light|sanrenpuku|combo|plus/i.test(values),
      `plan 名が漏れている: ${values}`);
  });
}

test('退会申請は無料特典（promotional grant）で有料へ戻らない', () => {
  const r = resolve({
    'プラン': 'Premium', Status: 'active', '有効期限': past, WithdrawalRequested: true,
    PremiumGrantUntil: future, LightGrantLifetime: true,
  });
  assert.equal(r.memberType, MEMBER_TYPE.FREE);
  assert.equal(r.reason, MEMBER_REASON.WITHDRAWAL_REQUESTED);
  assert.equal(r.normalizedPlan, 'free');
});

test('期限切れでも UnsubscribedAnalyticsKeiba はログイン判定に影響しない（メール配信のみ）', () => {
  const r = resolve({ 'プラン': 'Premium', Status: 'active', '有効期限': past, UnsubscribedAnalyticsKeiba: true });
  assert.equal(r.memberType, MEMBER_TYPE.FREE);
  const active = resolve({ 'プラン': 'Premium', Status: 'active', '有効期限': future, UnsubscribedAnalyticsKeiba: true });
  assert.equal(active.memberType, MEMBER_TYPE.PAID);
});

test('契約終了でも 停止 / 強制ログアウト / 未知プランは denied のまま', () => {
  assert.equal(resolve({ 'プラン': 'Premium', Status: 'suspended', '有効期限': past }).memberType, MEMBER_TYPE.DENIED);
  assert.equal(resolve({ 'プラン': 'Premium', '有効期限': past, ForceLogout: true }).memberType, MEMBER_TYPE.DENIED);
  assert.equal(resolve({ 'プラン': 'Premium', WithdrawalRequested: true, ForceLogout: true }).memberType, MEMBER_TYPE.DENIED);
  assert.equal(resolve({ 'プラン': 'Test', Status: 'active' }).reason, MEMBER_REASON.UNKNOWN_PLAN);
  assert.equal(resolve({ 'プラン': 'Test', Status: 'active', WithdrawalRequested: true }).reason,
    MEMBER_REASON.UNKNOWN_PLAN, '未知プランは退会・期限に関係なく denied のまま');
  assert.equal(resolve({ 'プラン': 'Test', Status: 'active', '有効期限': past }).memberType, MEMBER_TYPE.DENIED);
});

test('契約終了 free は Airtable の課金フィールドを結果へ持ち出さない', () => {
  const r = resolve({
    'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': past,
    PaymentConfirmed: true, PaidAt: past, PaymentEmailSent: true, RequestedPlan: 'Premium Annual',
  });
  assert.equal(r.memberType, MEMBER_TYPE.FREE);
  const keys = Object.keys(r).sort();
  assert.deepEqual(keys, [
    'entitlementSource', 'lifetimeSanrenpuku', 'memberType', 'normalizedPlan',
    'reason', 'recordId', 'sessionVersion', 'venueAccess',
  ]);
});

// =========================================================================
// LifetimeSanrenpuku（永久三連複）
// =========================================================================

test('LifetimeSanrenpuku=true + 期限切れ base → paid(premium-sanrenpuku)', () => {
  const r = resolve({ 'プラン': 'Premium', Status: 'active', '有効期限': past, LifetimeSanrenpuku: true });
  assert.equal(r.memberType, MEMBER_TYPE.PAID);
  assert.equal(r.normalizedPlan, 'premium-sanrenpuku');
  assert.equal(r.lifetimeSanrenpuku, true);
});
test('LifetimeSanrenpuku でも ForceLogout は denied を優先', () => {
  const r = resolve({ 'プラン': 'Premium', Status: 'active', LifetimeSanrenpuku: true, ForceLogout: true });
  assert.equal(r.memberType, MEMBER_TYPE.DENIED);
});

// =========================================================================
// 異常入力
// =========================================================================

test('now 不正 → denied(invalid_now)', () => {
  assert.equal(resolveMembership({ fields: { 'プラン': 'Premium' }, now: NaN }).reason, MEMBER_REASON.INVALID_NOW);
  assert.equal(resolveMembership({ fields: { 'プラン': 'Premium' } }).reason, MEMBER_REASON.INVALID_NOW);
});
test('fields が配列/非オブジェクト → denied', () => {
  assert.equal(resolveMembership({ fields: [1, 2], now: NOW }).memberType, MEMBER_TYPE.DENIED);
  assert.equal(resolveMembership({ fields: null, now: NOW }).memberType, MEMBER_TYPE.DENIED);
});
