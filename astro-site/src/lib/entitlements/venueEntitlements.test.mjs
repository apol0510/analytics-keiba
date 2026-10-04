// 会場限定 Premium（Stripe 中央版・南関版 / 2026-10-02）の閲覧・購入資格
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEntitlements, fromAirtableFields, viewFromEntitlements } from './resolveEntitlements.js';

const NOW = Date.parse('2026-10-02T03:00:00Z');
const premium = (extra = {}) => resolveEntitlements(fromAirtableFields({
  'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', '有効期限': '2026-11-04', ...extra,
}), NOW);

test('VenueAccess 空 = 両会場（既存会員は従来どおり）', () => {
  const e = premium();
  assert.equal(e.canViewPremium, true);
  assert.equal(e.canViewPremiumJra, true);
  assert.equal(e.canViewPremiumNankan, true);
  assert.equal(e.paidPremiumActive, true);
  assert.equal(e.paidPremiumVenueActive, false);
  assert.equal(e.canPurchaseSanrenpuku, true);
  assert.equal(e.effectiveTier, 'premium');
});

test('中央版: JRA だけ・両会場の権利（Light・三連複購入）は付かない', () => {
  const e = premium({ VenueAccess: 'jra' });
  assert.equal(e.canViewPremiumJra, true);
  assert.equal(e.canViewPremiumNankan, false);
  assert.equal(e.canViewPremium, false);
  assert.equal(e.canViewLight, false);
  assert.equal(e.paidPremiumActive, false);
  assert.equal(e.paidPremiumVenueActive, true);
  assert.deepEqual(e.paidPremiumVenues, ['jra']);
  assert.equal(e.canPurchaseSanrenpuku, false);
  assert.equal(e.effectiveTier, 'premium-venue');
  const v = viewFromEntitlements(e);
  assert.equal(v.showPremiumVenueCard, true);
  assert.equal(v.premiumVenue, 'jra');
  assert.equal(v.showPremiumActiveCard, false);
  assert.equal(v.showFreeCard, false);
});

test('南関版: 南関だけ', () => {
  const e = premium({ VenueAccess: 'nankan' });
  assert.equal(e.canViewPremiumNankan, true);
  assert.equal(e.canViewPremiumJra, false);
  assert.equal(viewFromEntitlements(e).premiumVenue, 'nankan');
});

test('会場限定でも期限切れなら閉じる', () => {
  const e = premium({ VenueAccess: 'jra', '有効期限': '2026-09-30' });
  assert.equal(e.canViewPremiumJra, false);
  assert.equal(e.paidPremiumVenueActive, false);
});

test('解釈できない VenueAccess はどこも開けない（fail closed）', () => {
  const e = premium({ VenueAccess: 'osaka' });
  assert.equal(e.canViewPremiumJra, false);
  assert.equal(e.canViewPremiumNankan, false);
  assert.equal(e.canViewPremium, false);
});

test('all の明示は両会場（memberResolution と同じ語彙）', () => {
  assert.equal(premium({ VenueAccess: 'all' }).canViewPremium, true);
});

test('三連複買い切りは会場に関係なく閲覧できる', () => {
  const e = premium({ VenueAccess: 'jra', LifetimeSanrenpuku: true });
  assert.equal(e.canViewSanrenpuku, true);
});

test('VenueAccess は Light 契約には影響しない', () => {
  const e = resolveEntitlements(fromAirtableFields({
    'プラン': 'Light', PlanType: 'Monthly', Status: 'active', '有効期限': '2026-11-04', VenueAccess: 'jra',
  }), NOW);
  assert.equal(e.canViewLight, true);
  assert.equal(e.canViewPremiumJra, false);
});
