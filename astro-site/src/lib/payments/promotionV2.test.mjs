/**
 * promotionV2.test.mjs — v2 昇格フィールド組み立ての純粋関数テスト。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildV2ConfirmationFields, buildManualPromotionFields } from './promotionV2.js';
import { EMAIL_STATUS } from './paymentEmailState.js';

const CONFIRMED_AT = new Date('2026-07-14T05:00:00.000Z'); // JST 14:00
const REQ = { requestedPlan: 'Premium', requestedPlanType: 'Annual', confirmedAt: CONFIRMED_AT, recordId: 'recABC123' };

test('v2 昇格: 昇格情報は維持しつつ PaymentEmailSent を書かず pending を同梱', () => {
  const r = buildV2ConfirmationFields(REQ);
  assert.equal(r.fields['プラン'], 'Premium');
  assert.equal(r.fields['PlanType'], 'Annual');
  assert.equal(r.fields['Status'], 'active');
  assert.equal(r.fields['有効期限'], '2027-07-14');
  assert.equal(typeof r.fields['PaidAt'], 'string');
  // v2 の核心: PaymentEmailSent は書かない
  assert.equal('PaymentEmailSent' in r.fields, false);
  // pending を同一 PATCH で同梱（原子化）
  assert.equal(r.fields['PaymentEmailStatus'], EMAIL_STATUS.PENDING);
  assert.match(r.fields['PaymentEmailIdempotencyKey'], /^[0-9a-f]{32}$/);
  assert.equal(r.fields['PaymentEmailAttemptCount'], 0);
  // Requested* クリアも維持（二重延長防止）
  assert.equal(r.fields['RequestedPlan'], '');
  assert.equal(r.fields['RequestedAmount'], null);
});

test('v2 昇格: RequestedPlan 空なら null（fail closed）', () => {
  assert.equal(buildV2ConfirmationFields({ ...REQ, requestedPlan: '' }), null);
  assert.equal(buildV2ConfirmationFields({ ...REQ, requestedPlanType: '' }), null);
});

test('v2 昇格: 冪等キーは recordId + PaidAt から決定論的', () => {
  const a = buildV2ConfirmationFields(REQ).fields['PaymentEmailIdempotencyKey'];
  const b = buildV2ConfirmationFields({ ...REQ, recordId: 'recOTHER' }).fields['PaymentEmailIdempotencyKey'];
  assert.notEqual(a, b);
  // PaidAt = confirmedAt.toISOString() なので同一入力なら同一
  assert.equal(a, buildV2ConfirmationFields(REQ).fields['PaymentEmailIdempotencyKey']);
});

test('手動昇格: 操作者/理由/日時を付与し、v2 と同じ pending を作る', () => {
  const r = buildManualPromotionFields({ ...REQ, operator: 'MK', reason: '銀行入金 7/14' });
  assert.equal(r.fields['PromotedBy'], 'MK');
  assert.equal(r.fields['PromotionReason'], '銀行入金 7/14');
  assert.equal(r.fields['PromotedAt'], CONFIRMED_AT.toISOString());
  assert.equal(r.fields['PaymentEmailStatus'], EMAIL_STATUS.PENDING);
  assert.equal('PaymentEmailSent' in r.fields, false);
});

test('手動昇格: 操作者が空なら null（監査のため fail closed）', () => {
  assert.equal(buildManualPromotionFields({ ...REQ, operator: '' }), null);
  assert.equal(buildManualPromotionFields({ ...REQ, operator: '   ' }), null);
});

test('手動昇格: 昇格内容が決まらなければ null（fail closed）', () => {
  assert.equal(buildManualPromotionFields({ ...REQ, requestedPlan: '', operator: 'MK' }), null);
});
