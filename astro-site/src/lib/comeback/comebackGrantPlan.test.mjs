/**
 * comebackGrantPlan.test.mjs — 実行計画（dry-run の中身）
 *   node --test src/lib/comeback/comebackGrantPlan.test.mjs
 *
 * 守る性質:
 *   - Light と Premium を独立に選べる（Light は Premium の fallback ではない）
 *   - 無料付与と割引オファーが混ざらない（offer では権利が増えない）
 *   - 理由別に必ず数える（黙って落とさない）
 *   - 複合は 1 顧客 1 PATCH（片方だけ付く状態が構造上作れない）
 *   - 同じ operationId の再実行で二重付与・二重発行しない
 *   - 有料契約を短縮しない
 *   - 退会者は無料付与しないが、割引オファーは発行できる
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildComebackPlan,
  buildRevokePlan,
  buildOfferRecordsForPlan,
  planCustomer,
  describeCustomerState,
  describeSelection,
  checkGrantable,
  checkOfferable,
  reconcileOperation,
  chunkTargets,
  assertPlanWritesOnlyGrantFields,
  computePlanFingerprint,
  CB_SKIP,
  MAX_GRANT_RECORDS,
} from './comebackGrantPlan.js';
import { PROMO_FIELDS, PROMO_TIER, resolvePromotionalGrants } from '../entitlements/promotionalGrants.js';
import { resolveOffer } from '../promotions/promotionOfferCatalog.js';

const NOW = Date.parse('2026-07-30T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const OP = 'cb-2026-07-30-abcd1234';
const L = PROMO_FIELDS.light;
const P = PROMO_FIELDS.premium;
const iso = (ms) => new Date(ms).toISOString();

const LIGHT_LIFETIME = resolveOffer('light-lifetime-free').offer;
const LIGHT_30D = resolveOffer('light-30d-free').offer;
const PREMIUM_30D = resolveOffer('premium-30d-free').offer;
const ANNUAL_HALF = resolveOffer('premium-annual-half').offer;
const LIFETIME_HALF = resolveOffer('premium-lifetime-half').offer;

const cust = (id, fields) => ({ recordId: id, fields });
const EXPIRED = {
  Email: 'ex@example.com', 'プラン': 'Premium', PlanType: 'Annual',
  Status: 'active', '有効期限': '2026-03-01',
};
const plan = (grantOffers, purchaseOffer, selected, over = {}) => buildComebackPlan({
  grantOffers, purchaseOffer, selected, nowMs: NOW, operationId: OP,
  actor: 'MK', source: 'comeback-2026-07', ...over,
});

// ═══ Light と Premium は独立 ═════════════════════════════════════════

test('Light 単独: Light だけ書き、Premium は触らない', () => {
  const p = plan([LIGHT_LIFETIME], null, [cust('rec1', EXPIRED)]);
  assert.equal(p.counts.willGrant, 1);
  const t = p.targets[0];
  assert.equal(t.grantFields[L.LIFETIME], true);
  assert.equal(P.LIFETIME in t.grantFields, false, 'Premium 側を書いている');
  assert.equal(p.counts.parts.lightGrant, 1);
  assert.equal(p.counts.parts.premiumGrant, 0);
});

test('Light 永久無料 ＋ Premium 30日無料: 1 顧客 1 PATCH で両方入る', () => {
  const p = plan([LIGHT_LIFETIME, PREMIUM_30D], null, [cust('rec1', EXPIRED)]);
  const t = p.targets[0];
  assert.equal(t.grantParts.length, 2);
  assert.equal(t.grantFields[L.LIFETIME], true);
  assert.equal(t.grantFields[P.UNTIL], iso(NOW + 30 * DAY));
  // 同一レコードの 1 PATCH ＝ 顧客単位で原子的
  assert.equal(t.grantFields[L.OP], OP);
  assert.equal(t.grantFields[P.OP], OP);
  assert.equal(assertPlanWritesOnlyGrantFields(p.targets), true);
});

test('付与後の状態（after）は runtime 判定と一致し、Premium 終了後に Light が残る', () => {
  const t = plan([LIGHT_LIFETIME, PREMIUM_30D], null, [cust('rec1', EXPIRED)]).targets[0];
  const merged = { ...EXPIRED, ...t.grantFields };
  const during = resolvePromotionalGrants(merged, NOW + 10 * DAY);
  assert.equal(during.premium.active, true);
  assert.equal(during.light.active, true);
  const after = resolvePromotionalGrants(merged, NOW + 40 * DAY);
  assert.equal(after.premium.active, false);
  assert.equal(after.light.active, true, 'Premium 終了で Light まで消えた');
  assert.match(t.after.text, /Light 永久無料/);
});

test('同じティアの無料付与を 2 つ選べない', () => {
  assert.equal(plan([LIGHT_LIFETIME, LIGHT_30D], null, [cust('rec1', EXPIRED)]).ok, false);
  assert.equal(plan([LIGHT_LIFETIME, LIGHT_30D], null, [cust('rec1', EXPIRED)]).error, 'duplicate_tier');
});

// ═══ 割引オファーは権利を増やさない ══════════════════════════════════

test('割引オファーは Customers を 1 バイトも書かない', () => {
  const p = plan([], ANNUAL_HALF, [cust('rec1', EXPIRED)]);
  assert.equal(p.counts.willOffer, 1);
  assert.equal(p.counts.willGrant, 0);
  const t = p.targets[0];
  assert.deepEqual(t.grantFields, {}, '割引なのに権限フィールドを書こうとしている');
  assert.equal(t.after.text, t.before.text, '割引だけで状態が変わっている');
  assert.equal(t.offer.offerPrice, 24900);
});

test('Light 無料 ＋ Premium 割引の組み合わせ', () => {
  const p = plan([LIGHT_LIFETIME], LIFETIME_HALF, [cust('rec1', EXPIRED)]);
  const t = p.targets[0];
  assert.equal(t.grantFields[L.LIFETIME], true);
  assert.equal(t.offer.offerId, 'premium-lifetime-half');
  assert.equal(t.offer.planType, 'Lifetime');
  assert.equal(p.counts.willGrant, 1);
  assert.equal(p.counts.willOffer, 1);
  // 付与後の状態に Premium は出てこない（買うまで権利は無い）
  assert.equal(t.after.canViewPremium, false);
});

test('offer 行は allowlist を通り、生トークンは行に入らない', () => {
  const p = plan([], ANNUAL_HALF, [cust('rec1', EXPIRED)]);
  const rows = buildOfferRecordsForPlan({
    targets: p.targets, nowMs: NOW, operationId: OP, secret: 'test-offer-secret-0123456789',
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fields.OfferPrice, 24900);
  assert.ok(rows[0].token);
  assert.equal(JSON.stringify(rows[0].fields).includes(rows[0].token), false);
});

// ═══ 除外の理由 ══════════════════════════════════════════════════════

test('除外は理由別に必ず数える', () => {
  const p = plan([LIGHT_LIFETIME, PREMIUM_30D], null, [
    cust('rec1', EXPIRED),                                  // 付与
    cust('recX', null),                                     // 不明
    cust('rec2', { ...EXPIRED, Email: '' }),                // データ不備
    cust('rec3', { ...EXPIRED, Status: 'suspended' }),      // 停止
    cust('rec4', { ...EXPIRED, WithdrawalRequested: true }),// 退会
    cust('rec5', { ...EXPIRED, Status: 'test' }),           // テスト
  ]);
  assert.equal(p.counts.willGrant, 1);
  assert.equal(p.counts.skipped, 5);
  assert.equal(p.counts.byReason[CB_SKIP.UNKNOWN_CUSTOMER], 1);
  assert.equal(p.counts.byReason[CB_SKIP.DATA_INCOMPLETE], 1);
  assert.equal(p.counts.byReason[CB_SKIP.ACCOUNT_SUSPENDED], 2);
  assert.equal(p.counts.byReason[CB_SKIP.WITHDRAWAL_BLOCKED], 1);
  assert.equal(p.counts.willGrant + p.counts.skipped, p.counts.selected);
});

test('退会者は無料付与しないが、割引オファーは発行できる', () => {
  const withdrawn = { ...EXPIRED, WithdrawalRequested: true };
  assert.equal(checkGrantable(withdrawn).reason, CB_SKIP.WITHDRAWAL_BLOCKED);
  assert.equal(checkOfferable(withdrawn).ok, true, '退会者に割引オファーを出せない');

  // 無料だけ → 対象外
  assert.equal(plan([LIGHT_LIFETIME], null, [cust('rec1', withdrawn)]).counts.willGrant, 0);
  // 割引を含む → offer は発行できる（権利は増えない）
  const p = plan([LIGHT_LIFETIME], ANNUAL_HALF, [cust('rec1', withdrawn)]);
  assert.equal(p.counts.willOffer, 1);
  assert.equal(p.counts.willGrant, 0);
  assert.equal(p.targets[0].partSkips[0].reason, CB_SKIP.WITHDRAWAL_BLOCKED);
  assert.equal(withdrawn.WithdrawalRequested, true, '退会フラグが書き換わっている');
});

test('停止アカウントは割引オファーも発行しない', () => {
  const suspended = { ...EXPIRED, Status: 'banned' };
  assert.equal(checkOfferable(suspended).reason, CB_SKIP.ACCOUNT_SUSPENDED);
  assert.equal(plan([], ANNUAL_HALF, [cust('rec1', suspended)]).counts.willOffer, 0);
});

// ═══ 冪等性 ══════════════════════════════════════════════════════════

test('同じ operationId で再実行しても二重付与しない', () => {
  const first = plan([LIGHT_LIFETIME, PREMIUM_30D], null, [cust('rec1', EXPIRED)]);
  const applied = { ...EXPIRED, ...first.targets[0].grantFields };
  const again = buildComebackPlan({
    grantOffers: [LIGHT_LIFETIME, PREMIUM_30D], purchaseOffer: null,
    selected: [cust('rec1', applied)], nowMs: NOW + 2 * DAY, operationId: OP, actor: 'MK',
  });
  assert.equal(again.counts.willGrant, 0);
  assert.equal(again.counts.byReason[CB_SKIP.ALREADY_APPLIED], 1);
});

test('同じ operationId で再実行しても二重発行しない（offer）', () => {
  const p = plan([], ANNUAL_HALF, [cust('rec1', EXPIRED)]);
  const rows = buildOfferRecordsForPlan({ targets: p.targets, nowMs: NOW, operationId: OP });
  const again = buildComebackPlan({
    grantOffers: [], purchaseOffer: ANNUAL_HALF, selected: [cust('rec1', EXPIRED)],
    existingOffers: rows.map((r) => ({ fields: r.fields })),
    nowMs: NOW + DAY, operationId: OP,
  });
  assert.equal(again.counts.willOffer, 0);
  assert.equal(again.counts.byReason[CB_SKIP.ALREADY_APPLIED], 1);
});

test('有効な同一 offer があれば別 operationId でも重複発行しない', () => {
  const p = plan([], ANNUAL_HALF, [cust('rec1', EXPIRED)]);
  const rows = buildOfferRecordsForPlan({ targets: p.targets, nowMs: NOW, operationId: OP });
  const again = buildComebackPlan({
    grantOffers: [], purchaseOffer: ANNUAL_HALF, selected: [cust('rec1', EXPIRED)],
    existingOffers: rows.map((r) => ({ fields: r.fields })),
    nowMs: NOW + DAY, operationId: 'another-op',
  });
  assert.equal(again.counts.byReason[CB_SKIP.ALREADY_OFFERED], 1);
});

test('部分適用からの再開: Light だけ入っている顧客は Premium だけが対象になる', () => {
  const half = {
    ...EXPIRED,
    [L.LIFETIME]: true, [L.GRANTED_AT]: iso(NOW), [L.OP]: OP,
  };
  const p = buildComebackPlan({
    grantOffers: [LIGHT_LIFETIME, PREMIUM_30D], purchaseOffer: null,
    selected: [cust('rec1', half)], nowMs: NOW, operationId: OP,
  });
  assert.equal(p.counts.willGrant, 1);
  const t = p.targets[0];
  assert.equal(t.grantParts.length, 1);
  assert.equal(t.grantParts[0].tier, PROMO_TIER.PREMIUM);
  assert.equal(L.LIFETIME in t.grantFields, false, '適用済みの Light を再度書いている');
});

// ═══ 有料契約を壊さない ═══════════════════════════════════════════════

test('有料 Premium が無料期間より後まで有効なら Premium 付与は no-op', () => {
  const paid = { ...EXPIRED, '有効期限': '2099-01-01' };
  const p = plan([PREMIUM_30D], null, [cust('rec1', paid)]);
  assert.equal(p.counts.willGrant, 0);
  assert.equal(p.counts.byReason[CB_SKIP.PAID_STRONGER], 1);
});

test('買い切り Premium 会員（PlanType=Lifetime）へは無料 Premium を付けない', () => {
  const lifetimePaid = { ...EXPIRED, PlanType: 'Lifetime', '有効期限': '2099-12-31' };
  const p = plan([PREMIUM_30D], null, [cust('rec1', lifetimePaid)]);
  assert.equal(p.counts.byReason[CB_SKIP.PAID_STRONGER], 1);
  const state = describeCustomerState(lifetimePaid, NOW);
  assert.match(state.paid, /買い切り/);
});

test('有料 Premium が先に切れるなら無料期間を付与する（延長になる）', () => {
  const soon = { ...EXPIRED, '有効期限': iso(NOW + 5 * DAY).slice(0, 10) };
  const p = plan([PREMIUM_30D], null, [cust('rec1', soon)]);
  assert.equal(p.counts.willGrant, 1);
  assert.equal(p.targets[0].grantFields[P.UNTIL], iso(NOW + 30 * DAY));
});

test('有効 Premium 会員への Light+Premium は Light だけ付与（設計どおりの no-op）', () => {
  const paid = { ...EXPIRED, '有効期限': '2099-01-01' };
  const p = plan([LIGHT_LIFETIME, PREMIUM_30D], null, [cust('rec1', paid)]);
  assert.equal(p.counts.willGrant, 1);
  const t = p.targets[0];
  assert.deepEqual(t.grantParts.map((g) => g.tier), [PROMO_TIER.LIGHT]);
  assert.equal(t.partSkips[0].reason, CB_SKIP.PAID_STRONGER);
});

test('計画は課金・契約・三連複・Plus のフィールドを 1 つも含まない', () => {
  const p = plan([LIGHT_LIFETIME, PREMIUM_30D], ANNUAL_HALF, [
    cust('rec1', EXPIRED), cust('rec2', { ...EXPIRED, Email: 'b@example.com' }),
  ]);
  for (const t of p.targets) {
    for (const k of Object.keys(t.grantFields)) {
      assert.equal(['プラン', 'Plan', 'PlanType', 'Status', '有効期限', 'PaidAt', 'PaymentConfirmed',
        'PaymentEmailSent', 'LifetimeSanrenpuku', 'PremiumPlusEligibility', 'WithdrawalRequested'].includes(k),
      false, `${k} を書こうとしている`);
    }
  }
});

// ═══ 入力検証 ════════════════════════════════════════════════════════

test('上限超過・空選択・未選択は計画を作らない', () => {
  const many = Array.from({ length: MAX_GRANT_RECORDS + 1 }, (_, i) => cust(`rec${i}`, EXPIRED));
  assert.match(plan([LIGHT_LIFETIME], null, many).error, /too_many_records/);
  assert.equal(plan([LIGHT_LIFETIME], null, []).error, 'empty_selection');
  assert.equal(plan([], null, [cust('rec1', EXPIRED)]).error, 'nothing_selected');
  assert.equal(buildComebackPlan({
    grantOffers: [LIGHT_LIFETIME], selected: [cust('rec1', EXPIRED)], nowMs: NOW, operationId: '',
  }).error, 'missing_operation_id');
});

// ═══ fingerprint ═════════════════════════════════════════════════════

test('対象・特典・価格のどれが変わっても fingerprint が変わる', () => {
  const a = plan([LIGHT_LIFETIME], null, [cust('rec1', EXPIRED)]);
  assert.equal(a.planFingerprint, plan([LIGHT_LIFETIME], null, [cust('rec1', EXPIRED)]).planFingerprint);
  // 対象が増えた
  assert.notEqual(a.planFingerprint,
    plan([LIGHT_LIFETIME], null, [cust('rec1', EXPIRED), cust('rec2', { ...EXPIRED, Email: 'b@example.com' })]).planFingerprint);
  // 特典が変わった
  assert.notEqual(a.planFingerprint, plan([LIGHT_30D], null, [cust('rec1', EXPIRED)]).planFingerprint);
  // 割引が付いた
  assert.notEqual(a.planFingerprint, plan([LIGHT_LIFETIME], ANNUAL_HALF, [cust('rec1', EXPIRED)]).planFingerprint);
  // 価格が変わった（任意価格）
  const custom1 = resolveOffer('premium-annual-custom', { customPrice: 20000 }).offer;
  const custom2 = resolveOffer('premium-annual-custom', { customPrice: 30000 }).offer;
  assert.notEqual(
    plan([], custom1, [cust('rec1', EXPIRED)]).planFingerprint,
    plan([], custom2, [cust('rec1', EXPIRED)]).planFingerprint,
    '価格を変えても fingerprint が同じ');
  // operationId
  assert.notEqual(a.planFingerprint, computePlanFingerprint({
    grantOffers: [LIGHT_LIFETIME], purchaseOffer: null, operationId: 'x', targets: a.targets,
  }));
});

// ═══ 取り消し ════════════════════════════════════════════════════════

test('取り消しは無料権利だけを消す（有料契約・三連複は不変）', () => {
  const granted = {
    ...EXPIRED, LifetimeSanrenpuku: true,
    ...plan([LIGHT_LIFETIME, PREMIUM_30D], null, [cust('rec1', EXPIRED)]).targets[0].grantFields,
  };
  const r = buildRevokePlan({
    tiers: [PROMO_TIER.LIGHT, PROMO_TIER.PREMIUM],
    selected: [cust('rec1', granted)], nowMs: NOW + DAY, actor: 'MK', reason: '誤付与',
  });
  assert.equal(r.counts.willRevoke, 1);
  const after = resolvePromotionalGrants({ ...granted, ...r.targets[0].grantFields }, NOW + 2 * DAY);
  assert.equal(after.light.active, false);
  assert.equal(after.premium.active, false);
  const state = describeCustomerState({ ...granted, ...r.targets[0].grantFields }, NOW + 2 * DAY);
  assert.equal(state.canViewSanrenpuku, true, '三連複買い切りが取り消しで消えた');
});

test('片方のティアだけ取り消せる', () => {
  const granted = { ...EXPIRED, ...plan([LIGHT_LIFETIME, PREMIUM_30D], null, [cust('rec1', EXPIRED)]).targets[0].grantFields };
  const r = buildRevokePlan({ tiers: [PROMO_TIER.PREMIUM], selected: [cust('rec1', granted)], nowMs: NOW + DAY });
  const after = resolvePromotionalGrants({ ...granted, ...r.targets[0].grantFields }, NOW + 2 * DAY);
  assert.equal(after.premium.active, false);
  assert.equal(after.light.active, true);
});

test('取り消しで有料プラン・三連複を指定できない', () => {
  for (const bad of [['premium-sanrenpuku'], ['LifetimeSanrenpuku'], [], ['paid_premium']]) {
    assert.equal(buildRevokePlan({ tiers: bad, selected: [cust('rec1', EXPIRED)], nowMs: NOW }).ok, false);
  }
});

// ═══ reconcile / 補助 ════════════════════════════════════════════════

test('reconcile は grant と offer の適用状況を数える', () => {
  const p = plan([LIGHT_LIFETIME], ANNUAL_HALF, [cust('rec1', EXPIRED)]);
  const applied = { ...EXPIRED, ...p.targets[0].grantFields };
  const offerRows = buildOfferRecordsForPlan({ targets: p.targets, nowMs: NOW, operationId: OP });
  const r = reconcileOperation({
    operationId: OP,
    records: [{ recordId: 'rec1', fields: applied }, { recordId: 'rec2', fields: EXPIRED }],
    offerRecords: offerRows.map((x) => ({ fields: x.fields })),
    nowMs: NOW,
  });
  assert.equal(r.counts.applied, 1);
  assert.equal(r.counts.missing, 1);
  assert.equal(r.counts.offersIssued, 1);
});

test('chunkTargets は 10 件ずつ（Airtable batch 上限）', () => {
  assert.deepEqual(chunkTargets(Array.from({ length: 23 }, (_, i) => ({ recordId: `r${i}` }))).map((c) => c.length),
    [10, 10, 3]);
});

test('describeSelection は選んだ内容を人が読める形で返す', () => {
  assert.equal(describeSelection({ grantOffers: [LIGHT_LIFETIME], purchaseOffer: null }), 'Light 永久無料');
  const s = describeSelection({ grantOffers: [LIGHT_LIFETIME], purchaseOffer: ANNUAL_HALF });
  assert.match(s, /Light 永久無料/);
  assert.match(s, /¥24,900/);
});

test('planCustomer は before / after を返す', () => {
  const t = planCustomer({
    recordId: 'rec1', fields: EXPIRED, grantOffers: [LIGHT_LIFETIME], purchaseOffer: null,
    nowMs: NOW, operationId: OP, actor: 'MK',
  });
  assert.match(t.before.text, /期限切れ/);
  assert.match(t.after.text, /Light 永久無料/);
  assert.notEqual(t.before.text, t.after.text);
});
