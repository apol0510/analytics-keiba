import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveEntitlements,
  fromAirtableFields,
  fromClientUserPlan,
} from './resolveEntitlements.js';

const NOW = Date.parse('2026-07-18T00:00:00Z');
const FUTURE = '2027-07-14'; // 有効
const PAST = '2026-07-01';   // 期限切れ

const R = (c, opts) => resolveEntitlements(c, NOW, opts);

// 1. Free
test('case1: Free 登録ユーザー', () => {
  const e = R({ tier: 'Free', accountStatus: 'active' });
  assert.equal(e.canLogin, true);
  assert.equal(e.canViewFree, true);
  assert.equal(e.canViewLight, false);
  assert.equal(e.canViewPremium, false);
  assert.equal(e.canPurchaseSanrenpuku, false);
  assert.equal(e.canViewSanrenpuku, false);
});

// 1b. Free + 永久権 → 三連複だけ可（設計表: Free 永久権があれば可）
test('case1b: Free + LifetimeSanrenpuku=true → 三連複閲覧可', () => {
  const e = R({ tier: 'Free', accountStatus: 'active', lifetimeSanrenpuku: true });
  assert.equal(e.canViewSanrenpuku, true);
  assert.equal(e.canViewPremium, false);
  assert.equal(e.canPurchaseSanrenpuku, false); // Premium 無効なので購入もできない
});

// 2. Light 有効
test('case2: Light 有効', () => {
  const e = R({ tier: 'Light', accountStatus: 'active', expiresAt: FUTURE });
  assert.equal(e.canViewLight, true);
  assert.equal(e.canViewPremium, false);
  assert.equal(e.canViewSanrenpuku, false);
  assert.equal(e.canPurchaseSanrenpuku, false);
});

// 3. Premium 有効・三連複未購入
test('case3: Premium有効・三連複未購入', () => {
  const e = R({ tier: 'Premium', planType: 'Annual', accountStatus: 'active', expiresAt: FUTURE });
  assert.equal(e.canViewPremium, true);
  assert.equal(e.canViewLight, true); // Premium は Light を包含
  assert.equal(e.canPurchaseSanrenpuku, true); // 未所有なので購入提示
  assert.equal(e.canViewSanrenpuku, false);     // まだ閲覧不可
});

// 4. Premium 有効・三連複購入済み（フラグ）
test('case4: Premium有効・三連複購入済み', () => {
  const e = R({ tier: 'Premium', planType: 'Annual', accountStatus: 'active', expiresAt: FUTURE, lifetimeSanrenpuku: true });
  assert.equal(e.canViewPremium, true);
  assert.equal(e.canViewSanrenpuku, true);
  assert.equal(e.canPurchaseSanrenpuku, false); // 既に所有→購入CTA非表示
});

// 5. Premium 期限切れ・三連複購入済み（★核心）
test('case5: Premium期限切れ・三連複購入済み → 馬単不可/三連複可', () => {
  const e = R({ tier: 'Premium', planType: 'Annual', accountStatus: 'active', expiresAt: PAST, lifetimeSanrenpuku: true });
  assert.equal(e.canLogin, true);            // ログインは可能
  assert.equal(e.premiumExpired, true);
  assert.equal(e.canViewPremium, false);     // 馬単は不可
  assert.equal(e.canViewSanrenpuku, true);   // 三連複は永久に可（フラグ）
  assert.equal(e.canPurchaseSanrenpuku, false);
});

// 6. Premium 期限切れ・三連複未購入
test('case6: Premium期限切れ・三連複未購入 → すべて不可（Free相当）', () => {
  const e = R({ tier: 'Premium', planType: 'Annual', accountStatus: 'active', expiresAt: PAST });
  assert.equal(e.canLogin, true);
  assert.equal(e.canViewPremium, false);
  assert.equal(e.canViewSanrenpuku, false);
  assert.equal(e.canPurchaseSanrenpuku, false); // Premium 無効なので購入不可
  assert.equal(e.canViewFree, true);
});

// 7. suspended・三連複購入済み
test('case7: suspended → ログイン不可・全不可（フラグがあっても）', () => {
  const e = R({ tier: 'Premium', accountStatus: 'suspended', expiresAt: FUTURE, lifetimeSanrenpuku: true });
  assert.equal(e.canLogin, false);
  assert.equal(e.canViewFree, false);
  assert.equal(e.canViewPremium, false);
  assert.equal(e.canViewSanrenpuku, false);
  assert.ok(e.reasons.includes('STATUS_SUSPENDED'));
});

// 8. 三連複入金確認前（pending・フラグ未設定）
test('case8: 入金確認前 pending → Free 扱い', () => {
  const e = R({ tier: 'Premium', accountStatus: 'pending', expiresAt: FUTURE });
  assert.equal(e.canLogin, true);
  assert.equal(e.canViewPremium, false); // pending は有料未確定
  assert.equal(e.canViewSanrenpuku, false);
  assert.ok(e.reasons.includes('PENDING'));
});

// 9. 三連複入金確認後（active + フラグ、Premium は年払い維持）
test('case9: 入金確認後 active + flag（馬単は年払い維持）', () => {
  const e = R({ tier: 'Premium', planType: 'Annual', accountStatus: 'active', expiresAt: FUTURE, lifetimeSanrenpuku: true });
  assert.equal(e.canViewSanrenpuku, true);
  assert.equal(e.canViewPremium, true);
  assert.equal(e.premiumExpired, false);
});

// 10. 改ざんされたクライアント値: resolver は与えられた入力のみで判定する（＝サーバーで再取得すれば偽装は無効）
test('case10: クライアントが plan=Premium を詐称しても、権威データが Free+フラグ無なら三連複不可', () => {
  // 攻撃者のブラウザ主張
  const clientClaim = R(fromClientUserPlan({ plan: 'Premium Sanrenpuku' }));
  assert.equal(clientClaim.canViewSanrenpuku, true); // クライアント値だけならこう見える（非権威）
  // サーバーが Airtable 権威データで再判定すると
  const authoritative = R(fromAirtableFields({ 'プラン': 'Free', 'Status': 'active' }));
  assert.equal(authoritative.canViewSanrenpuku, false); // 偽装は通らない
  assert.equal(authoritative.canViewPremium, false);
});

// 11. 旧 'Premium Sanrenpuku' 値（active・フラグ無）
test('case11: 旧 Premium Sanrenpuku（互換 ON で三連複可 / OFF で不可）', () => {
  const cust = { tier: 'Premium Sanrenpuku', accountStatus: 'active', expiresAt: FUTURE };
  const compatOn = R(cust); // 既定 legacySanrenpukuTierGrantsView=true
  assert.equal(compatOn.canViewSanrenpuku, true);
  assert.equal(compatOn.canViewPremium, true); // 旧値も馬単は可
  const compatOff = R(cust, { legacySanrenpukuTierGrantsView: false });
  assert.equal(compatOff.canViewSanrenpuku, false); // 移行後は旧値では三連複不可（フラグ必須）
});

// 12. 旧 'Premium Combo' 値
test('case12: 旧 Premium Combo（互換 ON で三連複可 / OFF で不可）', () => {
  const cust = { tier: 'Premium Combo', accountStatus: 'active', expiresAt: FUTURE };
  assert.equal(R(cust).canViewSanrenpuku, true);
  assert.equal(R(cust).canViewPremium, true);
  assert.equal(R(cust, { legacySanrenpukuTierGrantsView: false }).canViewSanrenpuku, false);
});

// 退会
test('withdrawal → ログイン不可', () => {
  const e = R({ tier: 'Premium', accountStatus: 'active', expiresAt: FUTURE, withdrawalRequested: true });
  assert.equal(e.canLogin, false);
  assert.equal(e.canViewSanrenpuku, false);
});

// lifetime billing（PlanType=Lifetime）は期限切れにしない
test('PlanType=Lifetime は expiresAt が過去でも有効', () => {
  const e = R({ tier: 'Premium', planType: 'Lifetime', accountStatus: 'active', expiresAt: PAST });
  assert.equal(e.canViewPremium, true);
  assert.equal(e.premiumExpired, false);
});

// adapter: Airtable
test('fromAirtableFields: 日本語フィールドを正しく読む', () => {
  const c = fromAirtableFields({ 'プラン': 'Premium', 'PlanType': 'Annual', '有効期限': FUTURE, 'LifetimeSanrenpuku': true, 'Status': 'active' });
  assert.equal(c.tier, 'Premium');
  assert.equal(c.lifetimeSanrenpuku, true);
  assert.equal(c.expiresAt, FUTURE);
  const e = R(c);
  assert.equal(e.canViewSanrenpuku, true);
});

// adapter: client user-plan + isExpired フラグ
test('fromClientUserPlan: isExpired フラグで強制期限切れ', () => {
  const c = fromClientUserPlan({ plan: 'Premium', lifetimeSanrenpuku: true }, { isExpired: true });
  const e = R(c);
  assert.equal(e.canViewPremium, false);     // isExpired で馬単不可
  assert.equal(e.canViewSanrenpuku, true);   // フラグは残る
});

// ── 棚卸しで判明した Status 網羅（拒否集合の追加）──────────────────
for (const st of ['withdrawn', 'expired', 'unpaidrefunded']) {
  test(`Status='${st}' → フラグがあっても通常商品アクセス不可（拒否集合）`, () => {
    const e = R({ tier: 'Premium', accountStatus: st, expiresAt: FUTURE, lifetimeSanrenpuku: true });
    assert.equal(e.canLogin, false);
    assert.equal(e.canViewPremium, false);
    assert.equal(e.canViewSanrenpuku, false);
    assert.equal(e.canPurchaseSanrenpuku, false);
    assert.ok(e.reasons.includes('STATUS_SUSPENDED'));
  });
}

test("Status='test' → 通常顧客権限を与えない", () => {
  const e = R({ tier: 'Premium', accountStatus: 'test', expiresAt: FUTURE, lifetimeSanrenpuku: true });
  assert.equal(e.canViewPremium, false);
  assert.equal(e.canViewSanrenpuku, false);
  assert.ok(e.reasons.includes('TEST_ACCOUNT'));
});

test("プラン='Test' → 通常顧客権限を与えない（Status空でも）", () => {
  const e = R({ tier: 'Test', accountStatus: '', expiresAt: FUTURE, lifetimeSanrenpuku: true });
  assert.equal(e.canViewPremium, false);
  assert.equal(e.canViewSanrenpuku, false);
  assert.ok(e.reasons.includes('TEST_ACCOUNT'));
});

// ── Status 空（本番の 1340 件）の互換扱い ────────────────────────
test('Status空 + Premium + 有効期限内 → 明示拒否でなく互換的に有効', () => {
  const e = R({ tier: 'Premium', accountStatus: '', expiresAt: FUTURE });
  assert.equal(e.canLogin, true);
  assert.equal(e.canViewPremium, true);       // 空Statusは拒否ではない
  assert.equal(e.canPurchaseSanrenpuku, true);
});

test('Status空 + Premium + 有効期限内 + フラグ → 三連複可', () => {
  const e = R({ tier: 'Premium', accountStatus: '', expiresAt: FUTURE, lifetimeSanrenpuku: true });
  assert.equal(e.canViewSanrenpuku, true);
  assert.equal(e.canPurchaseSanrenpuku, false); // 既所有
});

test('Status空 + Premium + 期限切れ + フラグ → 馬単不可/三連複可（設計表 C）', () => {
  const e = R({ tier: 'Premium', accountStatus: '', expiresAt: PAST, lifetimeSanrenpuku: true });
  assert.equal(e.canLogin, true);
  assert.equal(e.canViewPremium, false);
  assert.equal(e.premiumExpired, true);
  assert.equal(e.canViewSanrenpuku, true);
});

// ═══ dashboard 表示判定（resolveClientView）を直接検証 ═══════════════
import { resolveClientView, parseUserPlan } from './resolveEntitlements.js';

// localStorage 契約: 実際は JSON 文字列で入る（auth/verify.astro が JSON.stringify する）
const upStr = (obj) => JSON.stringify(obj);

test('UI-1: Premium有効・三連複未購入 → 馬単カード表示 / 三連複カード非表示 / 購入CTA表示', () => {
  const v = resolveClientView(upStr({ plan: 'Premium', planType: 'Annual' }), { validUntil: FUTURE }, NOW);
  assert.equal(v.showBaCard, true);
  assert.equal(v.showSanrenpukuCard, false);
  assert.equal(v.showPurchaseCta, true);
});

test('UI-2: Premium有効・三連複購入済み → 馬単表示 / 三連複表示 / 購入CTA非表示', () => {
  const v = resolveClientView(upStr({ plan: 'Premium', planType: 'Annual', lifetimeSanrenpuku: true }), { validUntil: FUTURE }, NOW);
  assert.equal(v.showBaCard, true);
  assert.equal(v.showSanrenpukuCard, true);
  assert.equal(v.showPurchaseCta, false);
});

test('UI-3: Premium期限切れ・購入済み → 馬単カード非表示 / 三連複カード表示 / 購入CTA非表示', () => {
  const v = resolveClientView(upStr({ plan: 'Premium', planType: 'Annual', lifetimeSanrenpuku: true }), { validUntil: PAST }, NOW);
  assert.equal(v.showBaCard, false);
  assert.equal(v.showSanrenpukuCard, true);
  assert.equal(v.showPurchaseCta, false);
});

test('UI-3b: isExpired フラグ("true"文字列)でも馬単非表示・三連複表示', () => {
  const v = resolveClientView(upStr({ plan: 'Premium', lifetimeSanrenpuku: true }), { isExpired: 'true' }, NOW);
  assert.equal(v.showBaCard, false);
  assert.equal(v.showSanrenpukuCard, true);
});

test('UI-4: Premium期限切れ・未購入 → すべて非表示', () => {
  const v = resolveClientView(upStr({ plan: 'Premium', planType: 'Annual' }), { validUntil: PAST }, NOW);
  assert.equal(v.showBaCard, false);
  assert.equal(v.showSanrenpukuCard, false);
  assert.equal(v.showPurchaseCta, false);
});

test('UI-5: Light → 購入CTA非表示 / 三連複カード非表示（フラグ無）', () => {
  const v = resolveClientView(upStr({ plan: 'Light', planType: 'Monthly' }), { validUntil: FUTURE }, NOW);
  assert.equal(v.showPurchaseCta, false);
  assert.equal(v.showSanrenpukuCard, false);
  assert.equal(v.showBaCard, false);
});

test('UI-5b: Free + LifetimeSanrenpuku=true → 三連複カード表示 / 購入CTA非表示 / 馬単非表示', () => {
  const v = resolveClientView(upStr({ plan: 'Free', lifetimeSanrenpuku: true }), {}, NOW);
  assert.equal(v.showSanrenpukuCard, true);
  assert.equal(v.showPurchaseCta, false);
  assert.equal(v.showBaCard, false);
});

// localStorage データ契約の頑健性（推測を排除）
test('契約: user-plan が生文字列(非JSON)でも throw せずプラン名として扱う', () => {
  assert.deepEqual(parseUserPlan('premium'), { plan: 'premium' });
  const v = resolveClientView('premium', { validUntil: FUTURE }, NOW);
  assert.equal(v.showBaCard, true); // 'premium' 生文字列でも判定できる
});

test('契約: user-plan が null / 空 → 何も表示しない（throw しない）', () => {
  assert.deepEqual(parseUserPlan(null), {});
  assert.deepEqual(parseUserPlan(''), {});
  const v = resolveClientView(null, {}, NOW);
  assert.equal(v.showBaCard, false);
  assert.equal(v.showSanrenpukuCard, false);
  assert.equal(v.showPurchaseCta, false);
});

test('契約: user-plan が壊れたJSON → throw せず空扱い', () => {
  assert.deepEqual(parseUserPlan('{bad json'), {});
  assert.equal(resolveClientView('{bad', {}, NOW).showBaCard, false);
});

test('契約: user-plan が object でもそのまま扱える', () => {
  const v = resolveClientView({ plan: 'Premium', lifetimeSanrenpuku: true }, { validUntil: FUTURE }, NOW);
  assert.equal(v.showSanrenpukuCard, true);
});

// ═══ 別アカウントへの三連複権限継承を防ぐ（persistLifetimeForUser）═══════════
import { persistLifetimeForUser } from './resolveEntitlements.js';

test('切替A(lifetime=true)→B(未指定): 別ユーザーには継承しない（fail closed）', () => {
  const existing = { email: 'a@example.com', lifetimeSanrenpuku: true };
  const incomingB = { email: 'b@example.com' }; // B のサーバーレスポンスに lifetime 無し
  assert.equal(persistLifetimeForUser(incomingB, existing), false);
});

test('サーバー true→false 訂正: incoming が false を明示 → 古い true を復活させない', () => {
  const existing = { email: 'a@example.com', lifetimeSanrenpuku: true };
  const incoming = { email: 'a@example.com', lifetimeSanrenpuku: false };
  assert.equal(persistLifetimeForUser(incoming, existing), false);
});

test('同一ユーザー再ログイン: サーバーが true → 付与', () => {
  assert.equal(persistLifetimeForUser({ email: 'a@example.com', lifetimeSanrenpuku: true }, {}), true);
});

test('同一ユーザー・incoming未指定: 直近の同一ユーザー値のみ引き継ぐ', () => {
  const existing = { email: 'a@example.com', lifetimeSanrenpuku: true };
  assert.equal(persistLifetimeForUser({ email: 'A@Example.com' }, existing), true); // 大小非依存で同一
  assert.equal(persistLifetimeForUser({ email: 'other@example.com' }, existing), false); // 別ユーザー
});

test('email 不明どうし: 継承しない（fail closed）', () => {
  assert.equal(persistLifetimeForUser({}, { lifetimeSanrenpuku: true }), false);
  assert.equal(persistLifetimeForUser(null, { email: 'a', lifetimeSanrenpuku: true }), false);
});
