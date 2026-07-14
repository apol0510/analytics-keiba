import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addMonthsJst,
  addOneYearJst,
  buildApplicationFields,
  buildConfirmationFields,
  computeExpiration,
  evaluateMailOutcome,
  isActiveStatus,
  LIFETIME_EXPIRATION,
  MAIL_FAILURE_STAGE,
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
  // emailSent を渡さない = メール未送信 → PaymentEmailSent は false
  // （旧実装は無条件 true。メール 0 通でも true になる欠陥があった）
  assert.equal(r.fields['PaymentEmailSent'], false);
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

// ─── メール送信状態: PaymentEmailSent は「送信できた証拠」────────────
//
// 旧実装は昇格 PATCH に PaymentEmailSent=true を無条件で含めており、
// 送信を試みる前に true が立ち、送信失敗も握り潰していた。その結果
// 「メールが 1 通も出ていないのに PaymentEmailSent=true」が起きていた（2026-07-14）。

const CONFIRMED_AT = new Date('2026-07-14T05:00:00Z'); // JST 14:00
const REQ = { requestedPlan: 'Premium', requestedPlanType: 'Annual', confirmedAt: CONFIRMED_AT };

/** メール結果から昇格 PATCH の fields を組み立てる（Function と同じ経路） */
function confirmWithMail(outcomeInput) {
  const mail = evaluateMailOutcome(outcomeInput);
  const confirmation = buildConfirmationFields({ ...REQ, emailSent: mail.providerAccepted });
  return { mail, confirmation };
}

/** 昇格そのものは常に成立する（メール失敗で巻き戻さない） */
function assertPromoted(confirmation) {
  assert.equal(confirmation.fields['プラン'], 'Premium');
  assert.equal(confirmation.fields['PlanType'], 'Annual');
  assert.equal(confirmation.fields['Status'], 'active');
  assert.equal(confirmation.fields['有効期限'], '2027-07-14');
  assert.equal(typeof confirmation.fields['PaidAt'], 'string');
  // Requested* クリアは維持（再チェックによる二重延長を防ぐ）
  assert.equal(confirmation.fields['RequestedPlan'], '');
  assert.equal(confirmation.fields['RequestedPlanType'], '');
  assert.equal(confirmation.fields['RequestedAmount'], null);
}

test('provider 2xx: 昇格成功 + PaymentEmailSent=true', () => {
  const { mail, confirmation } = confirmWithMail({ hasApiKey: true, hasEmail: true, providerStatus: 202 });
  assert.equal(mail.providerAttempted, true);
  assert.equal(mail.providerAccepted, true);
  assert.equal(mail.failureStage, null);
  assertPromoted(confirmation);
  assert.equal(confirmation.fields['PaymentEmailSent'], true);
});

test('provider 非2xx: 昇格成功 + PaymentEmailSent=false', () => {
  const { mail, confirmation } = confirmWithMail({ hasApiKey: true, hasEmail: true, providerStatus: 401 });
  assert.equal(mail.providerAttempted, true);
  assert.equal(mail.providerAccepted, false);
  assert.equal(mail.failureStage, MAIL_FAILURE_STAGE.PROVIDER_REJECTED);
  assertPromoted(confirmation);
  assert.equal(confirmation.fields['PaymentEmailSent'], false);
});

test('provider 例外: 昇格成功 + PaymentEmailSent=false', () => {
  const { mail, confirmation } = confirmWithMail({ hasApiKey: true, hasEmail: true, threw: true });
  assert.equal(mail.providerAttempted, true);
  assert.equal(mail.providerAccepted, false);
  assert.equal(mail.failureStage, MAIL_FAILURE_STAGE.PROVIDER_EXCEPTION);
  assertPromoted(confirmation);
  assert.equal(confirmation.fields['PaymentEmailSent'], false);
});

test('API key 欠如: 送信を試行せず 昇格成功 + PaymentEmailSent=false', () => {
  const { mail, confirmation } = confirmWithMail({ hasApiKey: false, hasEmail: true });
  assert.equal(mail.providerAttempted, false);
  assert.equal(mail.providerAccepted, false);
  assert.equal(mail.failureStage, MAIL_FAILURE_STAGE.NO_API_KEY);
  assertPromoted(confirmation);
  assert.equal(confirmation.fields['PaymentEmailSent'], false);
});

test('email 欠如: 送信を試行せず 昇格成功 + PaymentEmailSent=false', () => {
  const { mail, confirmation } = confirmWithMail({ hasApiKey: true, hasEmail: false });
  assert.equal(mail.providerAttempted, false);
  assert.equal(mail.providerAccepted, false);
  assert.equal(mail.failureStage, MAIL_FAILURE_STAGE.NO_EMAIL);
  assertPromoted(confirmation);
  assert.equal(confirmation.fields['PaymentEmailSent'], false);
});

test('境界: 2xx の端（200 / 299）は受理、300 / 199 は非受理', () => {
  for (const s of [200, 299]) {
    assert.equal(evaluateMailOutcome({ hasApiKey: true, hasEmail: true, providerStatus: s }).providerAccepted, true, `status ${s}`);
  }
  for (const s of [199, 300, 500]) {
    assert.equal(evaluateMailOutcome({ hasApiKey: true, hasEmail: true, providerStatus: s }).providerAccepted, false, `status ${s}`);
  }
});

test('providerStatus 欠落（null / 非整数）は非受理（fail closed）', () => {
  for (const s of [null, undefined, NaN, '202']) {
    assert.equal(evaluateMailOutcome({ hasApiKey: true, hasEmail: true, providerStatus: s }).providerAccepted, false);
  }
});

test('二重送信防止: provider 受理時は Status=active と PaymentEmailSent=true が同一 PATCH に載る', () => {
  // Status 変化で発火する Automation (send-payment-confirmation-auto) が
  // PaymentEmailSent=true を見てスキップできるよう、両者は同じ fields に無ければならない。
  const { confirmation } = confirmWithMail({ hasApiKey: true, hasEmail: true, providerStatus: 202 });
  assert.equal(confirmation.fields['Status'], 'active');
  assert.equal(confirmation.fields['PaymentEmailSent'], true);
});
