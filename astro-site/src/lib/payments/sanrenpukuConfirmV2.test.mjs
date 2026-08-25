/**
 * sanrenpukuConfirmV2.test.mjs — 三連複（買い切り）の入金確認が v2 で完走すること
 *   node --test src/lib/payments/sanrenpukuConfirmV2.test.mjs
 *
 * ## 本番で起きた事故（2026-08-25）
 *
 * 三連複 ¥68,000 の入金確認で `PaymentConfirmed` を押したところ、
 * `confirm-bank-payment` が **例外で落ちて昇格が丸ごと失敗**した。
 *
 *     ERROR buildPendingEmailFields: recordId と paidAtIso は必須
 *       at buildV2ConfirmationFields → exports.handler
 *
 * 原因は `buildV2ConfirmationFields` が冪等キーの基準時刻を `base.fields.PaidAt`
 * から取っていたこと。**三連複の確認は `PaidAt` を書かない**（`有効期限` も触らない）ため
 * `undefined` になり throw していた。結果:
 *
 *   - `LifetimeSanrenpuku` が付かない（三連複を買ったのに見られない）
 *   - `Requested*` が消えない（未入金の申込が残ったまま／再実行で再昇格しうる）
 *   - 入金確認メールが送られない（pending 行が作られないので worker が拾えない）
 *
 * **これは 1 人の事故ではなく、v2 切替後のすべての三連複購入で再現する。**
 * よってここで逐語的に固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildV2ConfirmationFields, buildManualPromotionFields } from './promotionV2.js';
import { buildConfirmationFields } from './bankPaymentFlow.js';
import { buildSanrenpukuPlusInitFields } from '../premiumPlus/premiumPlusEligibility.js';
import { EMAIL_STATUS } from './paymentEmailState.js';

const AT = new Date('2026-08-25T09:03:26.000Z');
const REC = 'rec1zljY6Ozb23gd1';

const SANRENPUKU = [
  ['Premium Sanrenpuku', 'Lifetime'],
  ['Premium Combo', 'Lifetime'],
  // 実際の申込は PlanType 無しでも来る（productName の分解結果に依存しない）
  ['Premium Sanrenpuku', ''],
];

// ── 1. 落ちないこと（事故の再発防止）────────────────────────────
test('【回帰】三連複の入金確認が例外で落ちない', () => {
  for (const [plan, type] of SANRENPUKU) {
    const r = buildV2ConfirmationFields({
      requestedPlan: plan, requestedPlanType: type, confirmedAt: AT, recordId: REC,
    });
    assert.ok(r, `${plan}/${type}: 昇格内容を作れていない`);
  }
});

test('【回帰】三連複でも送信対象（pending）が作られる＝確認メールが出る', () => {
  for (const [plan, type] of SANRENPUKU) {
    const { fields } = buildV2ConfirmationFields({
      requestedPlan: plan, requestedPlanType: type, confirmedAt: AT, recordId: REC,
    });
    assert.equal(fields.PaymentEmailStatus, EMAIL_STATUS.PENDING, `${plan}: pending になっていない`);
    assert.ok(fields.PaymentEmailIdempotencyKey, `${plan}: 冪等キーが無い`);
    assert.equal(fields.PaymentEmailAttemptCount, 0);
    // v2 は PaymentEmailSent を立てない（worker が accepted 到達時に書く）
    assert.equal('PaymentEmailSent' in fields, false, `${plan}: v2 なのに PaymentEmailSent を書いている`);
  }
});

test('【回帰】三連複の昇格内容が正しい（権利が付き、申込が消える）', () => {
  for (const [plan, type] of SANRENPUKU) {
    const { fields, expiration } = buildV2ConfirmationFields({
      requestedPlan: plan, requestedPlanType: type, confirmedAt: AT, recordId: REC,
    });
    assert.equal(fields.LifetimeSanrenpuku, true, `${plan}: 三連複の恒久権が付いていない`);
    assert.equal(fields.RequestedPlan, '', `${plan}: 申込が消えていない`);
    assert.equal(fields.RequestedPlanType, '');
    assert.equal(fields.RequestedAmount, null);
    // 会員ランク・期限・課金は触らない（三連複はランクではない）
    assert.equal(expiration, null, `${plan}: 有効期限を書き換えている`);
    for (const f of ['プラン', 'PlanType', '有効期限', 'Status']) {
      assert.equal(f in fields, false, `${plan}: ${f} を書き換えている`);
    }
  }
});

test('冪等キーは確認日時から導く（三連複は PaidAt を持たないため）', () => {
  const a = buildV2ConfirmationFields({
    requestedPlan: 'Premium Sanrenpuku', requestedPlanType: 'Lifetime', confirmedAt: AT, recordId: REC,
  }).fields.PaymentEmailIdempotencyKey;
  // 同じ確認日時・同じレコードなら同じ鍵（同一 PATCH のやり直しで二重送信を作らない）
  const again = buildV2ConfirmationFields({
    requestedPlan: 'Premium Sanrenpuku', requestedPlanType: 'Lifetime', confirmedAt: new Date(AT), recordId: REC,
  }).fields.PaymentEmailIdempotencyKey;
  assert.equal(a, again);
  // 別レコードなら別の鍵
  const other = buildV2ConfirmationFields({
    requestedPlan: 'Premium Sanrenpuku', requestedPlanType: 'Lifetime', confirmedAt: AT, recordId: 'recOTHER00000000',
  }).fields.PaymentEmailIdempotencyKey;
  assert.notEqual(a, other);
});

// ── 2. 通常プランは従来どおり ──────────────────────────────────
test('通常プランの昇格は従来どおり（PaidAt から鍵を作る）', () => {
  for (const [plan, type] of [['Premium', 'Annual'], ['Premium', 'Monthly'], ['Light', 'Monthly']]) {
    const base = buildConfirmationFields({ requestedPlan: plan, requestedPlanType: type, confirmedAt: AT });
    const v2 = buildV2ConfirmationFields({ requestedPlan: plan, requestedPlanType: type, confirmedAt: AT, recordId: REC });
    assert.ok(base && v2, `${plan}/${type}`);
    assert.equal(v2.fields.PaidAt, base.fields.PaidAt, `${plan}: PaidAt が変わっている`);
    assert.equal(v2.fields['プラン'], plan, `${plan}: 会員ランクを書いていない`);
    assert.equal(v2.expiration, base.expiration, `${plan}: 有効期限が変わっている`);
    assert.equal(v2.fields.PaymentEmailStatus, EMAIL_STATUS.PENDING);
  }
});

test('判定できない申込は昇格しない（fail closed）', () => {
  for (const plan of ['', null, undefined, '   ']) {
    assert.equal(
      buildV2ConfirmationFields({ requestedPlan: plan, requestedPlanType: 'Lifetime', confirmedAt: AT, recordId: REC }),
      null, `RequestedPlan=${JSON.stringify(plan)} で昇格している`,
    );
  }
});

test('手動昇格（管理画面）でも三連複が落ちない', () => {
  const r = buildManualPromotionFields({
    requestedPlan: 'Premium Sanrenpuku', requestedPlanType: 'Lifetime',
    confirmedAt: AT, recordId: REC, operator: 'admin', reason: '入金確認',
  });
  assert.ok(r, '手動昇格を作れていない');
  assert.equal(r.fields.LifetimeSanrenpuku, true);
  assert.equal(r.fields.PaymentEmailStatus, EMAIL_STATUS.PENDING);
  assert.equal(r.fields.PromotedBy, 'admin');
});

// ── 3. Premium Plus の販売資格を自動で付ける（2026-08-25 MK 確定）──
test('【要件】三連複を買ったら Premium Plus の販売資格が自動で付く', () => {
  const r = buildSanrenpukuPlusInitFields({ fields: {}, confirmedAt: AT });
  assert.ok(r, '初期化内容を作れていない');
  assert.equal(r.fields.PremiumPlusEligibility, 'eligible', '毎回手作業が必要な review のままになっている');
  assert.equal(r.fields.PremiumPlusEligibleAt, AT.toISOString(), '段階公開の起点が無い');
  assert.equal(r.fields.SanrenpukuPaidAt, AT.toISOString(), '購入日時が残らない');
  assert.equal(r.fields.PremiumPlusEligibilityUpdatedBy, 'system:sanrenpuku-confirm');
});

test('【安全】すでに資格が設定されている会員は上書きしない（blocked を戻さない）', () => {
  for (const status of ['blocked', 'review', 'eligible']) {
    const r = buildSanrenpukuPlusInitFields({
      fields: { PremiumPlusEligibility: status, SanrenpukuPaidAt: '2026-01-01T00:00:00.000Z' },
      confirmedAt: AT,
    });
    assert.equal(r, null, `${status} を上書きしている`);
  }
});

test('【安全】購入日時が既にあれば上書きしない（最初の購入日を残す）', () => {
  const r = buildSanrenpukuPlusInitFields({
    fields: { SanrenpukuPaidAt: '2026-01-01T00:00:00.000Z' }, confirmedAt: AT,
  });
  assert.ok(r);
  assert.equal('SanrenpukuPaidAt' in r.fields, false, '購入日時を上書きしている');
  assert.equal(r.fields.PremiumPlusEligibility, 'eligible');
});

test('【安全】段階公開の起点は既存値があれば触らない', () => {
  const r = buildSanrenpukuPlusInitFields({
    fields: { PremiumPlusEligibleAt: '2026-01-01T00:00:00.000Z' }, confirmedAt: AT,
  });
  assert.ok(r);
  assert.equal('PremiumPlusEligibleAt' in r.fields, false, '段階公開の起点を上書きしている');
});

test('資格を自動で付けても、その場で売れるわけではない（段階公開は効く）', async () => {
  const { resolvePremiumPlusRelease } = await import('../premiumPlus/premiumPlusRelease.js');
  const r = resolvePremiumPlusRelease({
    hasSanrenpuku: true, premiumActive: true, eligibility: 'eligible',
    eligibleAtMs: AT.getTime(), sanrenpukuPaidAtMs: AT.getTime(),
    nowMs: AT.getTime() + 60 * 1000, // 購入直後
  });
  assert.equal(r.showPurchaseCta, false, '購入直後に販売してしまっている（段階公開が効いていない）');
});
