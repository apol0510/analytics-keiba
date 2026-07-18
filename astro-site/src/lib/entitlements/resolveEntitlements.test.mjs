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
