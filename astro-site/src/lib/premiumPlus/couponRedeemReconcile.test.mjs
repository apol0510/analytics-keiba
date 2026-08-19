/**
 * couponRedeemReconcile.test.mjs — 入金確認と redeem の部分成功
 *
 * 確定した順序: **Customers の入金確認・昇格が成功 → その後で redeem**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const {
  REDEEM_STATE, REDEEM_ACTION, resolveRedeemState, planRedeemAfterConfirm,
  isCustomerSettled, listRepairTargets,
} = await import('./couponRedeemReconcile.js');
const { RESERVATION_SOURCE } = await import('../promotions/couponReservationSource.js');
const { buildReservationRedeemFields, describeCouponLifecycle, COUPON_LIFECYCLE } =
  await import('./premiumPlusCouponReservation.js');

const res = (status, over = {}) => ({
  id: 'recOFFER1', fields: {
    Source: RESERVATION_SOURCE, CustomerRecordId: 'recA', OfferId: 'premium-plus-reopen-priority@v1',
    Status: status, StartsAt: '2026-09-01T00:00:00.000Z', ExpiresAt: '2026-09-15T00:00:00.000Z', ...over,
  },
});
const UNSETTLED = { 'Email': 'a@example.invalid' };
const SETTLED = { 'Email': 'a@example.invalid', 'プラン': 'Premium Plus', 'Status': 'active' };

// ── 4 状態 ──────────────────────────────────────────────────
test('Customers 未確定 + issued → 通常の確認待ち', () => {
  const v = resolveRedeemState({ fields: UNSETTLED, reservation: res('issued') });
  assert.equal(v.state, REDEEM_STATE.WAITING);
  assert.equal(v.needsRepair, false);
});

test('Customers 確定 + issued → redeem 未完了（修復対象）', () => {
  const v = resolveRedeemState({ fields: SETTLED, reservation: res('issued') });
  assert.equal(v.state, REDEEM_STATE.NEEDS_REDEEM);
  assert.equal(v.needsRepair, true);
  assert.match(v.repair, /入金確認をもう一度/);
});

test('Customers 確定 + redeemed → 正常完了', () => {
  const v = resolveRedeemState({ fields: SETTLED, reservation: res('redeemed') });
  assert.equal(v.state, REDEEM_STATE.COMPLETE);
  assert.equal(v.needsRepair, false);
});

test('Customers 未確定 + redeemed → 異常として検出する', () => {
  const v = resolveRedeemState({ fields: UNSETTLED, reservation: res('redeemed') });
  assert.equal(v.state, REDEEM_STATE.ANOMALY);
  assert.equal(v.needsRepair, true);
  assert.match(v.repair, /自動修復しません/);
});

// ── 順序 ────────────────────────────────────────────────────
test('Customers 更新が失敗した回は redeem しない', () => {
  const p = planRedeemAfterConfirm({ fields: SETTLED, reservation: res('issued'), customerUpdateOk: false });
  assert.equal(p.action, REDEEM_ACTION.NONE);
  assert.equal(p.reason, 'customer_update_failed');
});

test('Customers が確定していなければ redeem しない（先に redeem しない）', () => {
  const p = planRedeemAfterConfirm({ fields: UNSETTLED, reservation: res('issued') });
  assert.equal(p.action, REDEEM_ACTION.NONE);
  assert.equal(p.reason, 'customer_not_settled');
});

test('Customers 成功 → redeem する', () => {
  const p = planRedeemAfterConfirm({ fields: SETTLED, reservation: res('issued') });
  assert.equal(p.action, REDEEM_ACTION.REDEEM_ONLY);
});

// ── 再実行 ──────────────────────────────────────────────────
test('Customers 成功 / redeem 失敗の状態から、再実行で redeem だけ完了する', () => {
  // 1 回目: redeem が失敗して issued のまま残った
  const stuck = { fields: SETTLED, reservation: res('issued') };
  const v1 = resolveRedeemState(stuck);
  assert.equal(v1.state, REDEEM_STATE.NEEDS_REDEEM, '昇格は維持されたまま issued が残る');

  // 2 回目（再実行）: redeem だけを行う計画になる
  const p = planRedeemAfterConfirm(stuck);
  assert.equal(p.action, REDEEM_ACTION.REDEEM_ONLY, 'redeem 以外の副作用を含んでいる');

  // 実際の更新はクーポン台帳の 2 列だけ（Customers を再更新しない）
  const out = buildReservationRedeemFields({ record: res('issued'), nowMs: Date.now() });
  assert.deepEqual(Object.keys(out.fields).sort(), ['RedeemedAt', 'Status']);
});

test('再実行で二重昇格・有効期限の再延長・二重メールを起こさない（Customers を触らない）', () => {
  const p = planRedeemAfterConfirm({ fields: SETTLED, reservation: res('issued') });
  assert.equal(p.action, REDEEM_ACTION.REDEEM_ONLY);
  // 計画に Customers 側の操作が含まれない
  const src = read('./couponRedeemReconcile.js');
  const fn = src.slice(src.indexOf('export function planRedeemAfterConfirm'));
  assert.doesNotMatch(fn.slice(0, 1200), /プラン|有効期限|PaymentEmailSent|sendgrid|昇格させる/i);
  // 更新対象は offer 台帳の 2 列だけ
  const out = buildReservationRedeemFields({ record: res('issued'), nowMs: Date.now() });
  for (const k of Object.keys(out.fields)) {
    assert.doesNotMatch(k, /プラン|PlanType|有効期限|PaidAt|PaymentConfirmed|PaymentEmailSent/);
  }
});

test('二重 redeem しない（redeemed なら何もしない）', () => {
  const p = planRedeemAfterConfirm({ fields: SETTLED, reservation: res('redeemed') });
  assert.equal(p.action, REDEEM_ACTION.NONE);
  const out = buildReservationRedeemFields({ record: res('redeemed'), nowMs: Date.now() });
  assert.equal(out.skipped, 'already_redeemed');
});

// ── 異常は自動修復しない ────────────────────────────────────
test('異常（redeemed なのに未確定）を自動で直さない', () => {
  const p = planRedeemAfterConfirm({ fields: UNSETTLED, reservation: res('redeemed') });
  assert.equal(p.action, REDEEM_ACTION.NONE, '自動で何かしている');
  assert.equal(p.reason, 'anomaly_requires_operator');
  // 昇格させる・redeemed を戻す実装が無い
  const src = read('./couponRedeemReconcile.js');
  assert.doesNotMatch(src, /Status:\s*'issued'/, 'redeemed を issued へ戻している');
  assert.doesNotMatch(src, /'プラン':|Status:\s*'active'/, 'Customers を昇格させている');
});

// ── 修復対象の抽出 ──────────────────────────────────────────
test('修復対象だけを抽出でき、他会員へ影響しない', () => {
  const entries = [
    { id: 'recA', fields: SETTLED, reservation: res('issued') },      // 要修復
    { id: 'recB', fields: SETTLED, reservation: res('redeemed') },    // 正常
    { id: 'recC', fields: UNSETTLED, reservation: res('issued') },    // 待ち
    { id: 'recD', fields: UNSETTLED, reservation: res('redeemed') },  // 異常
  ];
  const targets = listRepairTargets(entries);
  assert.deepEqual(targets.map((t) => t.id), ['recA', 'recD']);
  // 元の配列を壊していない
  assert.equal(entries.length, 4);
  assert.equal(entries[1].view, undefined);
});

// ── 判定材料 ────────────────────────────────────────────────
test('Customers の確定判定はプラン + Status=active で決まる', () => {
  assert.equal(isCustomerSettled(SETTLED), true);
  assert.equal(isCustomerSettled({ 'プラン': 'Premium Plus', 'Status': 'pending' }), false);
  assert.equal(isCustomerSettled({ 'Status': 'active' }), false);
  assert.equal(isCustomerSettled(null), false);
});

// ── admin 表示 ──────────────────────────────────────────────
test('admin は要修復を独立した状態として出す', () => {
  const held = { PremiumPlusReopenCouponClaimedAt: '2026-08-18T00:00:00Z' };
  const life = describeCouponLifecycle({
    fields: { ...held, ...SETTLED }, offerRows: [res('issued')], customerRecordId: 'recA',
  });
  assert.equal(life.state, COUPON_LIFECYCLE.NEEDS_REPAIR);
  assert.equal(life.needsRepair, true);
  assert.ok(life.repair.length > 0, '修復方針が出ていない');

  // 管理画面に表示配線がある（Airtable を直接見に行かせない）
  const page = read('../../pages/admin/premium-plus-eligibility.astro');
  assert.match(page, /couponLifecycle\.label/);
  assert.match(page, /couponLifecycle\.needsRepair/);
  assert.match(page, /couponLifecycle\.repair/);
});

test('予約台帳を読めないときは 0 件と断定しない', () => {
  const fn = read('../../../netlify/functions/premium-plus-eligibility.js');
  assert.match(fn, /if \(!isOfferTableEnabled\(process\.env\)\) return null;/);
  assert.match(fn, /pages >= MAX_PAGES && offset\) return null/);
});

// ── まだ本番へ接続しない ────────────────────────────────────
test('confirm-bank-payment へはまだ配線しない（本番 write 未接続）', () => {
  const confirm = read('../../../netlify/functions/confirm-bank-payment.js');
  assert.doesNotMatch(confirm, /planRedeemAfterConfirm|buildReservationRedeemFields/);
});
