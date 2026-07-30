/**
 * promotionalGrantsRuntime.test.mjs — 特典が runtime 判定へどう効くか
 *   node --test src/lib/entitlements/promotionalGrantsRuntime.test.mjs
 *
 * ここが本機能の心臓部。守る性質:
 *   - Light 永久無料 → Light が見える / ログインできる（課金フィールドは一切変えていない）
 *   - Premium 30日無料 → 期間中だけ Premium が見える。終了後は Light 永久無料へ戻る
 *   - 有料契約を短縮・上書きしない（強い方を採用するだけ）
 *   - LifetimeSanrenpuku・三連複購入資格・Premium Plus 販売資格は不変
 *   - 停止 / 退会 / 強制ログアウトは特典があっても権限を得ない（拒否ゲートが優先）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveEntitlements, fromAirtableFields } from './resolveEntitlements.js';
import { PROMO_FIELDS } from './promotionalGrants.js';
const L = PROMO_FIELDS.light;
const P = PROMO_FIELDS.premium;
import { resolveMembership, MEMBER_TYPE, MEMBER_REASON } from '../auth/memberResolution.js';
import { resolvePlusMemberFromFields } from '../premiumPlus/premiumPlusMember.js';
import { checkGrantable, CB_SKIP } from '../comeback/comebackGrantPlan.js';

const NOW = Date.parse('2026-07-30T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const E = (fields) => resolveEntitlements(fromAirtableFields(fields), NOW);
const M = (fields, now = NOW) => resolveMembership({ fields, recordId: 'rec1', now });

/** 期限切れ Premium 会員（カムバックの主対象） */
const EXPIRED_PREMIUM = {
  Email: 'ex@example.com', 'プラン': 'Premium', PlanType: 'Annual',
  Status: 'active', '有効期限': '2026-03-01',
};
/** Light 永久無料（カムバックのベース特典） */
const LIGHT_GRANT = {
  [L.LIFETIME]: true,
  [L.GRANTED_AT]: iso(NOW - DAY),
};
/** Premium の期限付き無料権利 */
const premiumGrant = (untilMs) => ({
  [P.UNTIL]: iso(untilMs),
  [P.GRANTED_AT]: iso(NOW - DAY),
});
/** Premium の無期限無料権利（買い切り相当） */
const PREMIUM_LIFETIME_GRANT = {
  [P.LIFETIME]: true,
  [P.GRANTED_AT]: iso(NOW - DAY),
};

// ═══ 前提: 特典なしの挙動が変わっていない ══════════════════════════════

test('特典フィールドが無ければ従来と完全に同じ（期限切れ Premium は閲覧不可・ログイン拒否）', () => {
  const e = E(EXPIRED_PREMIUM);
  assert.equal(e.canViewPremium, false);
  assert.equal(e.canViewLight, false);
  assert.equal(e.premiumExpired, true);
  assert.equal(M(EXPIRED_PREMIUM).memberType, MEMBER_TYPE.DENIED);
  assert.equal(M(EXPIRED_PREMIUM).reason, MEMBER_REASON.EXPIRED);
});

// ═══ A. Light 永久無料 ═══════════════════════════════════════════════

test('A. Light 永久無料: Light が見える / Premium は見えない', () => {
  const e = E({ ...EXPIRED_PREMIUM, ...LIGHT_GRANT });
  assert.equal(e.canViewLight, true);
  assert.equal(e.canViewPremium, false);
  assert.equal(e.promo.lightActive, true);
  assert.equal(e.promo.lightLifetime, true);
  assert.equal(e.effectiveTier, 'light');
  assert.equal(e.paidPremiumActive, false, '有料判定は期限切れのまま');
});

test('A. Light 永久無料: ログインできる（plan=light）', () => {
  const m = M({ ...EXPIRED_PREMIUM, ...LIGHT_GRANT });
  assert.equal(m.memberType, MEMBER_TYPE.PAID);
  assert.equal(m.normalizedPlan, 'light');
  assert.equal(m.reason, MEMBER_REASON.PROMO_LIGHT_GRANT);
});

test('A. Light 永久無料は 3 年後も有効（期限を持たない）', () => {
  const later = NOW + 1100 * DAY;
  const m = resolveMembership({ fields: { ...EXPIRED_PREMIUM, ...LIGHT_GRANT }, recordId: 'r', now: later });
  assert.equal(m.normalizedPlan, 'light');
});

test('A. 無料会員へ付与しても Light になる（課金フィールドは Free のまま）', () => {
  const fields = { Email: 'f@example.com', 'プラン': 'Free', ...LIGHT_GRANT };
  assert.equal(E(fields).canViewLight, true);
  assert.equal(M(fields).normalizedPlan, 'light');
  assert.equal(fields['プラン'], 'Free', 'プラン欄を書き換えていない');
});

// ═══ B. Premium 30日無料 ═════════════════════════════════════════════

test('B. Premium 無料期間中は Premium が見える', () => {
  const e = E({ ...EXPIRED_PREMIUM, ...premiumGrant(NOW + 29 * DAY) });
  assert.equal(e.canViewPremium, true);
  assert.equal(e.canViewLight, true, 'Premium は Light を包含する');
  assert.equal(e.paidPremiumActive, false, '有料 Premium が有効になってはいけない');
  assert.equal(M({ ...EXPIRED_PREMIUM, ...premiumGrant(NOW + 29 * DAY) }).normalizedPlan, 'premium');
});

test('B. 無料期間が終わると Premium は消える（元の状態へ戻る）', () => {
  const fields = { ...EXPIRED_PREMIUM, ...premiumGrant(NOW - 1) };
  const e = E(fields);
  assert.equal(e.canViewPremium, false);
  assert.equal(e.canViewLight, false);
  assert.equal(M(fields).memberType, MEMBER_TYPE.DENIED, '終了後は期限切れ会員に戻る');
});

test('B. 有料 Premium が有効な会員の権利を縮めない', () => {
  const paid = { ...EXPIRED_PREMIUM, '有効期限': '2099-01-01' };
  const withTrial = { ...paid, ...premiumGrant(NOW + 30 * DAY) };
  assert.equal(E(paid).canViewPremium, true);
  assert.equal(E(withTrial).canViewPremium, true);
  assert.equal(E(withTrial).paidPremiumActive, true);
  assert.equal(withTrial['有効期限'], '2099-01-01', '有効期限が書き換わっていない');
  // 無料期間が切れても有料契約は生きている
  const after = resolveEntitlements(fromAirtableFields(withTrial), NOW + 60 * DAY);
  assert.equal(after.canViewPremium, true);
});

test('B-2. Premium 無期限無料（買い切り相当）は期限なしで Premium が見える', () => {
  const fields = { ...EXPIRED_PREMIUM, ...PREMIUM_LIFETIME_GRANT };
  const e = resolveEntitlements(fromAirtableFields(fields), NOW + 2000 * DAY);
  assert.equal(e.canViewPremium, true);
  assert.equal(e.effectiveTier, 'premium');
  // ⚠️ 三連複買い切り（LifetimeSanrenpuku）とは別権利。混同していないこと
  assert.equal(e.canViewSanrenpuku, false);
  assert.equal(e.lifetimeSanrenpuku, false);
});

// ═══ C. 複合オファー ═════════════════════════════════════════════════

test('C. Light 永久無料（ベース）＋ Premium 30日無料 → 期間中 Premium / 終了後 Light', () => {
  const fields = { ...EXPIRED_PREMIUM, ...LIGHT_GRANT, ...premiumGrant(NOW + 30 * DAY) };

  const during = resolveEntitlements(fromAirtableFields(fields), NOW + 10 * DAY);
  assert.equal(during.canViewPremium, true);
  assert.equal(during.canViewLight, true);

  const after = resolveEntitlements(fromAirtableFields(fields), NOW + 31 * DAY);
  assert.equal(after.canViewPremium, false, 'trial 終了後も Premium が残っている');
  assert.equal(after.canViewLight, true, 'trial 終了後に Light 永久無料へ戻っていない');

  const mAfter = resolveMembership({ fields, recordId: 'r', now: NOW + 31 * DAY });
  assert.equal(mAfter.memberType, MEMBER_TYPE.PAID);
  assert.equal(mAfter.normalizedPlan, 'light');
});

// ═══ 不変であるべきもの ═══════════════════════════════════════════════

test('三連複（LifetimeSanrenpuku）は特典の影響を受けない', () => {
  const noSrp = E({ ...EXPIRED_PREMIUM, ...LIGHT_GRANT, ...premiumGrant(NOW + 10 * DAY) });
  assert.equal(noSrp.canViewSanrenpuku, false, '特典で三連複が見えてしまった');

  const withSrp = E({ ...EXPIRED_PREMIUM, LifetimeSanrenpuku: true, ...LIGHT_GRANT });
  assert.equal(withSrp.canViewSanrenpuku, true, '買い切り三連複が特典付与で失われた');
  assert.equal(withSrp.lifetimeSanrenpuku, true);
});

test('三連複の購入資格は無料特典では開かない（有料 Premium だけ）', () => {
  const trial = E({ ...EXPIRED_PREMIUM, ...premiumGrant(NOW + 10 * DAY) });
  assert.equal(trial.canViewPremium, true);
  assert.equal(trial.canPurchaseSanrenpuku, false, '無料特典で購入 CTA が開いてしまう');

  const paid = E({ ...EXPIRED_PREMIUM, '有効期限': '2099-01-01' });
  assert.equal(paid.canPurchaseSanrenpuku, true, '有料会員の購入資格が壊れた');
});

test('Premium Plus 販売資格は無料特典で動かない（premiumActive は有料のみ）', () => {
  const base = { ...EXPIRED_PREMIUM, PaidAt: iso(NOW - 200 * DAY) };
  const before = resolvePlusMemberFromFields(base, { nowMs: NOW });
  const withTrial = resolvePlusMemberFromFields({ ...base, ...premiumGrant(NOW + 20 * DAY) }, { nowMs: NOW });
  assert.equal(before.premiumActive, false);
  assert.equal(withTrial.premiumActive, false, '無料特典で ROUTE B の前提が成立してしまう');
  assert.equal(withTrial.eligibility, before.eligibility);

  // 有料 Premium 会員の判定は従来どおり
  const paid = resolvePlusMemberFromFields({ ...base, '有効期限': '2099-01-01' }, { nowMs: NOW });
  assert.equal(paid.premiumActive, true);
});

// ═══ 拒否ゲートが優先される ══════════════════════════════════════════

test('停止・退会・強制ログアウトは特典があっても権限を得ない', () => {
  const grants = { ...LIGHT_GRANT, ...premiumGrant(NOW + 20 * DAY) };
  for (const bad of [
    { Status: 'suspended' },
    { Status: 'banned' },
    { WithdrawalRequested: true },
    { ForceLogout: true },
  ]) {
    const fields = { ...EXPIRED_PREMIUM, ...grants, ...bad };
    const e = E(fields);
    assert.equal(e.canLogin, false, `${JSON.stringify(bad)} で canLogin が true`);
    assert.equal(e.canViewPremium, false, `${JSON.stringify(bad)} で Premium が見える`);
    assert.equal(e.canViewLight, false, `${JSON.stringify(bad)} で Light が見える`);
    assert.equal(M(fields).memberType, MEMBER_TYPE.DENIED, `${JSON.stringify(bad)} でログインできる`);
  }
});

test('テストアカウントは閲覧権限を得ず、そもそも付与対象にならない', () => {
  const fields = { ...EXPIRED_PREMIUM, Status: 'test', ...LIGHT_GRANT, ...premiumGrant(NOW + 20 * DAY) };
  const e = E(fields);
  assert.equal(e.canLogin, false, 'テストアカウントに閲覧権限が付いた');
  assert.equal(e.canViewLight, false);
  // ⚠️ memberResolution はテストアカウントを denied にしない（本機能以前からの挙動。
  //    ログイン経路の既存仕様は変更しない）。付与そのものを checkGrantable で止める。
  assert.equal(checkGrantable(fields).ok, false, 'テストアカウントへ付与できてしまう');
  assert.equal(checkGrantable(fields).reason, CB_SKIP.ACCOUNT_SUSPENDED);
});

test('入金待ち（pending）でも特典自体は有効（無料なので支払いと無関係）', () => {
  const fields = { ...EXPIRED_PREMIUM, Status: 'pending', '有効期限': '', ...LIGHT_GRANT };
  assert.equal(E(fields).canViewLight, true);
  assert.equal(M(fields).normalizedPlan, 'light');
});

test('壊れた特典データ（取り消し済みなのに値が残る）では権限を与えない', () => {
  const fields = {
    ...EXPIRED_PREMIUM,
    [L.LIFETIME]: true,
    [L.GRANTED_AT]: iso(NOW - 10 * DAY),
    [L.REVOKED_AT]: iso(NOW - DAY),
  };
  assert.equal(E(fields).canViewLight, false);
  assert.equal(E(fields).promo.inconsistent, true);
  assert.equal(M(fields).memberType, MEMBER_TYPE.DENIED);
});
