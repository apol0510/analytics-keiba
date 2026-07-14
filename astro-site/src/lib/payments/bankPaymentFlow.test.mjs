import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addMonthsJst,
  addOneYearJst,
  buildApplicationFields,
  buildConfirmationFields,
  computeExpiration,
  isActiveStatus,
  LIFETIME_EXPIRATION,
} from './bankPaymentFlow.js';

const PREMIUM_ANNUAL = { planName: 'Premium', planType: 'Annual', amount: 44820 };

// ─── 申込時: 有料権限を付与しない ───────────────────────────────

test('active Light 会員が振込報告しても即 Premium にならない', () => {
  const f = buildApplicationFields({
    currentStatus: 'active',
    fullName: '山田 太郎',
    ...PREMIUM_ANNUAL,
  });

  // プラン / PlanType / 有効期限 / Status を一切書かない = Light active のまま維持
  for (const forbidden of ['プラン', 'PlanType', '有効期限', 'Status']) {
    assert.equal(forbidden in f, false, `申込時に ${forbidden} を書いてはいけない`);
  }
  assert.equal(f.RequestedPlan, 'Premium');
  assert.equal(f.RequestedPlanType, 'Annual');
  assert.equal(f.RequestedAmount, 44820);
  assert.equal(f.PaymentConfirmed, false);
});

test('新規ユーザーが振込報告しても即 active にならない', () => {
  const f = buildApplicationFields({
    currentStatus: null,
    fullName: '新規 太郎',
    email: 'new@example.com',
    isNewRecord: true,
    ...PREMIUM_ANNUAL,
  });

  assert.equal(f.Status, 'pending');
  assert.notEqual(f.Status, 'active');
  assert.equal(f.Email, 'new@example.com');
  for (const forbidden of ['プラン', 'PlanType', '有効期限']) {
    assert.equal(forbidden in f, false, `申込時に ${forbidden} を書いてはいけない`);
  }
});

test('無料 / 期限切れ / 退会済みの既存ユーザーは pending になる（active にはしない）', () => {
  for (const status of ['', null, 'expired', 'cancelled', 'withdrawn', 'suspended']) {
    const f = buildApplicationFields({ currentStatus: status, fullName: 'X', ...PREMIUM_ANNUAL });
    assert.equal(f.Status, 'pending', `status=${status}`);
  }
});

test('申込時に退会フラグをリセットしない（未入金で退会申請が消えない）', () => {
  const f = buildApplicationFields({ currentStatus: 'active', fullName: 'X', ...PREMIUM_ANNUAL });
  assert.equal('WithdrawalRequested' in f, false);
});

test('金額が数値でなければ RequestedAmount を書かない', () => {
  const f = buildApplicationFields({
    currentStatus: 'active', fullName: 'X', planName: 'Premium', planType: 'Annual', amount: null,
  });
  assert.equal('RequestedAmount' in f, false);
});

// ─── 入金確認時: そのときだけ昇格する ───────────────────────────

test('入金確認時だけ Premium / Annual / active / 有効期限1年後になる', () => {
  const confirmedAt = new Date('2026-07-10T05:00:00Z'); // JST 14:00
  const r = buildConfirmationFields({
    requestedPlan: 'Premium',
    requestedPlanType: 'Annual',
    confirmedAt,
  });

  assert.notEqual(r, null);
  assert.equal(r.fields['プラン'], 'Premium');
  assert.equal(r.fields['PlanType'], 'Annual');
  assert.equal(r.fields['Status'], 'active');
  assert.equal(r.fields['有効期限'], '2027-07-10');
  assert.equal(r.expiration, '2027-07-10');
  assert.equal(r.fields['PaymentEmailSent'], true); // 既存 Automation の二重送信ガード
  assert.equal(r.fields['WithdrawalRequested'], false);
});

test('有効期限は入金確認日（JST）基準の1年後', () => {
  // JST 00:30（= UTC 前日 15:30）。UTC 基準だと前日になってしまうケース
  const jstEarlyMorning = new Date('2026-07-09T15:30:00Z');
  const r = buildConfirmationFields({
    requestedPlan: 'Premium', requestedPlanType: 'Annual', confirmedAt: jstEarlyMorning,
  });
  assert.equal(r.fields['有効期限'], '2027-07-10', 'JST の暦日 7/10 を基準にすること');

  // 参考: 既存実装の UTC 基準だと 1 日ズレる
  const utcBased = new Date(jstEarlyMorning);
  utcBased.setFullYear(utcBased.getFullYear() + 1);
  assert.equal(utcBased.toISOString().split('T')[0], '2027-07-09');
});

test('承認時に Requested* をクリアし、二重実行で有効期限が再延長されない', () => {
  const first = buildConfirmationFields({
    requestedPlan: 'Premium', requestedPlanType: 'Annual', confirmedAt: new Date('2026-07-10T05:00:00Z'),
  });
  assert.equal(first.fields['RequestedPlan'], '');
  assert.equal(first.fields['RequestedPlanType'], '');
  assert.equal(first.fields['RequestedAmount'], null);
  // PaymentConfirmed は承認済みの痕跡として残す（Automation の再発火も起きない）
  assert.equal('PaymentConfirmed' in first.fields, false);

  // クリア後にもう一度 PaymentConfirmed を押しても昇格処理は走らない
  const second = buildConfirmationFields({
    requestedPlan: first.fields['RequestedPlan'],
    requestedPlanType: first.fields['RequestedPlanType'],
    confirmedAt: new Date('2027-01-01T05:00:00Z'),
  });
  assert.equal(second, null, '二重実行で有効期限が再延長されてはいけない');
});

test('申込内容が無い / PlanType 不明なら昇格しない（fail closed）', () => {
  const at = new Date('2026-07-10T05:00:00Z');
  assert.equal(buildConfirmationFields({ requestedPlan: '', requestedPlanType: 'Annual', confirmedAt: at }), null);
  assert.equal(buildConfirmationFields({ requestedPlan: 'Premium', requestedPlanType: '', confirmedAt: at }), null);
  assert.equal(buildConfirmationFields({ requestedPlan: null, requestedPlanType: null, confirmedAt: at }), null);
  assert.equal(buildConfirmationFields({ requestedPlan: 'Premium', requestedPlanType: 'Weekly', confirmedAt: at }), null);
});

// ─── 有効期限の計算 ─────────────────────────────────────────

test('computeExpiration: PlanType ごとの有効期限', () => {
  const at = new Date('2026-07-10T05:00:00Z');
  assert.equal(computeExpiration('Annual', at), '2027-07-10');
  assert.equal(computeExpiration('Monthly', at), '2026-08-10');
  assert.equal(computeExpiration('Lifetime', at), LIFETIME_EXPIRATION);
  assert.equal(computeExpiration('annual', at), '2027-07-10'); // 大小文字非依存
  assert.equal(computeExpiration('unknown', at), null);
  assert.equal(computeExpiration(null, at), null);
});

test('addOneYearJst: 閏日 2/29 は 2/28 に丸める（3/1 へ繰り上げない）', () => {
  assert.equal(addOneYearJst(new Date('2028-02-29T05:00:00Z')), '2029-02-28');

  // 参考: setFullYear は 3/1 に繰り上がる
  const naive = new Date('2028-02-29T05:00:00Z');
  naive.setFullYear(naive.getFullYear() + 1);
  assert.equal(naive.toISOString().split('T')[0], '2029-03-01');
});

test('addMonthsJst: 月末の繰り上がりを丸める / 年跨ぎ', () => {
  assert.equal(addMonthsJst(new Date('2026-01-31T05:00:00Z'), 1), '2026-02-28');
  assert.equal(addMonthsJst(new Date('2026-12-15T05:00:00Z'), 1), '2027-01-15');
  assert.equal(addMonthsJst(new Date('2026-12-31T15:30:00Z'), 12), '2028-01-01'); // JST で 2027-01-01
});

test('isActiveStatus: 大小文字・空白に依存しない', () => {
  assert.equal(isActiveStatus('active'), true);
  assert.equal(isActiveStatus(' Active '), true);
  assert.equal(isActiveStatus('pending'), false);
  assert.equal(isActiveStatus(null), false);
});

// ─── 乗り換えキャンペーンとの整合 ────────────────────────────

test('Premium Annual - Campaign も planName=Premium / planType=Annual として扱われる', () => {
  // bank-transfer-application.js の正規化結果を入力として受け取る
  const productName = 'Premium Annual - Campaign (¥44,820/年)';
  const fullPlanName = productName.replace(/\s*\(.*\)$/, '').trim();
  const planType = fullPlanName.includes('Annual') ? 'Annual' : 'Monthly';
  const planName = fullPlanName
    .replace(/\s*\(Standard Upgrade\)/, '')
    .replace(/\s*-\s*Campaign/, '')
    .replace(/\s+(Lifetime|Annual|Monthly|買い切り|年払い|30日)$/, '')
    .trim();

  const applied = buildApplicationFields({
    currentStatus: 'active', fullName: 'Light 会員', planName, planType, amount: 44820,
  });
  assert.equal(applied.RequestedPlan, 'Premium');
  assert.equal(applied.RequestedPlanType, 'Annual');
  assert.equal(applied.RequestedAmount, 44820);

  const confirmed = buildConfirmationFields({
    requestedPlan: applied.RequestedPlan,
    requestedPlanType: applied.RequestedPlanType,
    confirmedAt: new Date('2026-07-10T05:00:00Z'),
  });
  assert.equal(confirmed.fields['プラン'], 'Premium');
  assert.equal(confirmed.fields['PlanType'], 'Annual');
  assert.equal(confirmed.fields['有効期限'], '2027-07-10');
});
