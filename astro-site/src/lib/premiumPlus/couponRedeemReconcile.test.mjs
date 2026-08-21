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
/**
 * 承認済み（confirm-bank-payment 完了後）の姿。
 * `Requested*` はクリアされ、`PaymentConfirmed` は**痕跡として残る**。
 */
const SETTLED = {
  'Email': 'a@example.invalid', 'プラン': 'Premium Plus', 'Status': 'active',
  'RequestedPlan': '', 'PaymentConfirmed': true,
};
/**
 * **申込直後**（入金確認待ち）の姿。既存 active 会員なので `Status` は active のまま、
 * `RequestedPlan` が入り `PaymentConfirmed=false`。
 */
const APPLIED = {
  'Email': 'a@example.invalid', 'プラン': 'Premium Sanrenpuku', 'Status': 'active',
  'RequestedPlan': 'Premium Plus', 'RequestedPlanType': 'Single', 'RequestedAmount': 58000,
  'PaymentConfirmed': false,
};

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
/**
 * ⚠️ **`Status='active'` だけで settled と判定しない。**
 * 正本（`docs/BANK_TRANSFER_FLOW.md` / `payments/bankPaymentFlow.js`）に合わせ、
 * `Status=active` + `RequestedPlan` 空 + `PaymentConfirmed=true` の 3 つが揃ったときだけ確定。
 */
test('settled は Status=active + RequestedPlan 空 + PaymentConfirmed=true の 3 条件', () => {
  const base = { 'プラン': 'Premium Plus', 'Status': 'active' };

  // ① 申込直後: active + RequestedPlan あり + PaymentConfirmed=false → 確定しない
  assert.equal(isCustomerSettled(APPLIED), false);
  assert.equal(isCustomerSettled({ ...base, RequestedPlan: 'Premium Plus', PaymentConfirmed: false }), false);

  // ② 申込は残っていないが入金確認を経ていない → **確定しない**（fail closed）
  assert.equal(isCustomerSettled({ ...base, RequestedPlan: '', PaymentConfirmed: false }), false);
  assert.equal(isCustomerSettled({ ...base, RequestedPlan: '' }), false, 'PaymentConfirmed 未設定を確定にしている');

  // ③ 承認済み: active + RequestedPlan 空 + PaymentConfirmed=true → 確定
  assert.equal(isCustomerSettled({ ...base, RequestedPlan: '', PaymentConfirmed: true }), true);
  assert.equal(isCustomerSettled(SETTLED), true);

  // 承認済みでも申込が再び入っていれば未確定（次の申込の入金確認待ち）
  assert.equal(isCustomerSettled({ ...SETTLED, RequestedPlan: 'Premium Plus' }), false);

  // チェックボックスは**厳密に true** のみ（confirm-bank-payment の認可と同じ読み方）
  for (const v of ['true', 1, 'checked', {}]) {
    assert.equal(isCustomerSettled({ ...base, RequestedPlan: '', PaymentConfirmed: v }), false, String(v));
  }

  assert.equal(isCustomerSettled({ 'プラン': 'Premium Plus', 'Status': 'pending' }), false);
  assert.equal(isCustomerSettled({ 'Status': 'active' }), false);
  assert.equal(isCustomerSettled(null), false);
});

test('申込直後（active のまま）は waiting であって要修復ではない', () => {
  const v = resolveRedeemState({ fields: APPLIED, reservation: res('issued') });
  assert.equal(v.state, REDEEM_STATE.WAITING);
  assert.equal(v.needsRepair, false, '入金確認待ちを要修復にしている');
  assert.equal(v.customerSettled, false);
  // この段階では redeem しない（入金確認前に使用済みにしない）
  const p = planRedeemAfterConfirm({ fields: APPLIED, reservation: res('issued') });
  assert.equal(p.action, REDEEM_ACTION.NONE);
  assert.equal(p.reason, 'customer_not_settled');
});

test('confirm 完了後（Requested* クリア + PaymentConfirmed=true）は REDEEM_ONLY へ進む', () => {
  // confirm の PATCH 後に読み直したレコード
  const afterConfirm = {
    ...APPLIED, 'プラン': 'Premium Plus', 'RequestedPlan': '', 'RequestedPlanType': '',
    'RequestedAmount': null, 'PaymentConfirmed': true,
  };
  const v = resolveRedeemState({ fields: afterConfirm, reservation: res('issued') });
  assert.equal(v.state, REDEEM_STATE.NEEDS_REDEEM);
  const p = planRedeemAfterConfirm({ fields: afterConfirm, reservation: res('issued') });
  assert.equal(p.action, REDEEM_ACTION.REDEEM_ONLY);
  assert.equal(p.reason, 'settled_pending_redeem');

  // ⚠️ 触るのは offer 台帳の 2 列だけ。**Customers を書かない**ので
  //    二重昇格・有効期限の再延長・二重メールは起きない
  const out = buildReservationRedeemFields({ record: res('issued'), nowMs: Date.parse('2026-09-10T00:00:00Z') });
  assert.deepEqual(Object.keys(out.fields).sort(), ['RedeemedAt', 'Status'],
    'offer 台帳の 2 列以外を書こうとしている');
  // 再実行しても二重 redeem しない
  assert.equal(buildReservationRedeemFields({ record: res('redeemed'), nowMs: Date.now() }).skipped, 'already_redeemed');
});

test('確定判定は他会員のレコードを参照しない（渡された 1 件だけを見る）', () => {
  const others = [
    { id: 'recX', fields: { ...SETTLED, Email: 'x@example.invalid' }, reservation: res('issued') },
    { id: 'recY', fields: APPLIED, reservation: res('issued') },
  ];
  const targets = listRepairTargets(others);
  // APPLIED（入金確認待ち）は修復対象に入らない。SETTLED の 1 件だけ
  assert.deepEqual(targets.map((t) => t.id), ['recX']);
  // 関数は fields を破壊しない
  assert.equal(others[1].fields.PaymentConfirmed, false);
});

// ── 台帳を読めていない（確認できない）────────────────────────
test('台帳を読めていなければ「予約なし」と判定しない', () => {
  const v = resolveRedeemState({ fields: SETTLED, reservation: null, ledgerAvailable: false });
  assert.equal(v.state, REDEEM_STATE.UNKNOWN);
  assert.notEqual(v.state, REDEEM_STATE.NO_RESERVATION, '確認できないを「予約なし」にしている');
  assert.equal(v.ledgerAvailable, false);
  // 「要修復」とも「対応不要」とも断定しない
  assert.equal(v.needsRepair, false);
  assert.ok(v.repair.includes('確定'), '判断を止める文言が出ていない');
});

test('台帳を読めていない回は redeem しない（読めないまま書かない）', () => {
  const p = planRedeemAfterConfirm({
    fields: SETTLED, reservation: null, customerUpdateOk: true, ledgerAvailable: false,
  });
  assert.equal(p.action, REDEEM_ACTION.NONE);
  assert.equal(p.reason, 'ledger_unavailable');
});

test('ライフサイクルも「確認できない」と「0 件」を分ける', () => {
  const held = { PremiumPlusReopenCouponClaimedAt: '2026-08-18T00:00:00Z' };
  // 読めた結果 0 件 = 所持中
  const zero = describeCouponLifecycle({ fields: held, offerRows: [], customerRecordId: 'recA' });
  assert.equal(zero.state, COUPON_LIFECYCLE.HELD);
  assert.equal(zero.ledgerAvailable, true);
  assert.equal(zero.reservationCount, 0);
  // 読めていない = 所持中と断定しない・件数も 0 にしない
  for (const arg of [
    { fields: held, offerRows: null, customerRecordId: 'recA' },
    { fields: held, offerRows: [], ledgerAvailable: false, customerRecordId: 'recA' },
    { fields: held, customerRecordId: 'recA' },
  ]) {
    const v = describeCouponLifecycle(arg);
    assert.equal(v.state, COUPON_LIFECYCLE.UNKNOWN, JSON.stringify(Object.keys(arg)));
    assert.equal(v.ledgerAvailable, false);
    assert.equal(v.reservationCount, null);
    assert.equal(v.needsRepair, false);
    // 取得の事実（Customers 側）は読めているので残す
    assert.equal(v.claimed, true);
    assert.ok(v.ledgerNote.length > 0, '確認できない理由が出ていない');
  }
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

test('予約台帳を読めないときは 0 件と断定しない（gate off / 失敗 / 打ち切り）', () => {
  const fn = read('../../../netlify/functions/premium-plus-eligibility.js');
  // 3 つの理由すべてを「確認できない」として返す（null / [] へ潰さない）
  assert.match(fn, /unavailable\(LEDGER_UNAVAILABLE\.GATE_OFF\)/);
  assert.match(fn, /unavailable\(LEDGER_UNAVAILABLE\.READ_FAILED\)/);
  assert.match(fn, /unavailable\(LEDGER_UNAVAILABLE\.PAGE_LIMIT\)/);
  // ⚠️ 「読めなかった」を空配列へ潰す書き方を復活させない
  assert.doesNotMatch(fn, /reservationRows \|\| \[\]/, 'null を [] へ潰している');
  // 一覧と個別検索が**同じ台帳**を読む（片方だけ読まないと状態がズレる）
  const lookup = fn.slice(fn.indexOf('async function handleLookup'), fn.indexOf('async function readReservationLedger'));
  assert.match(lookup, /readReservationLedger\(\{ KEY, BASE \}\)/, '個別検索が台帳を読んでいない');
  // 第 3 引数は台帳、第 4 引数は再募集の開始状態（どちらも一覧と同じものを渡す）
  assert.match(lookup, /buildAdminRow\(rec, now, ledger[,)]/, '個別検索が台帳を渡していない');
});

test('台帳の状態は画面にも出す（「確認できない」を無言で 0 件表示にしない）', () => {
  const page = read('../../pages/admin/premium-plus-eligibility.astro');
  assert.match(page, /couponLifecycle\.ledgerAvailable === false/);
  assert.match(page, /確認できない/);
  assert.match(page, /couponLifecycle\.ledgerNote/);
});

// ── まだ本番へ接続しない ────────────────────────────────────
test('confirm-bank-payment へはまだ配線しない（本番 write 未接続）', () => {
  const confirm = read('../../../netlify/functions/confirm-bank-payment.js');
  assert.doesNotMatch(confirm, /planRedeemAfterConfirm|buildReservationRedeemFields/);
});
