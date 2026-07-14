/**
 * Functions 側の配線を固定する guard テスト。
 * bankPaymentFlow.js のロジックが正しくても、Function が旧コードのまま
 * プランや有効期限を直接書いていたら意味がないため、実ファイルを検査する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fn = (name) => fileURLToPath(new URL(`../../../netlify/functions/${name}`, import.meta.url));
const APPLICATION = readFileSync(fn('bank-transfer-application.js'), 'utf8');
const CONFIRM = readFileSync(fn('confirm-bank-payment.js'), 'utf8');
const AUTO = readFileSync(fn('send-payment-confirmation-auto.js'), 'utf8');

test('guard: 申込 Function は単一源 buildApplicationFields を使う', () => {
  assert.ok(
    APPLICATION.includes("from '../../src/lib/payments/bankPaymentFlow.js'"),
    '単一源を import していない',
  );
  assert.ok(APPLICATION.includes('buildApplicationFields({'), 'buildApplicationFields を呼んでいない');
});

test('guard: 申込 Function は プラン / 有効期限 / Status=active を直接書かない', () => {
  // Airtable へ書く fields リテラルに現れてはいけないキー
  for (const forbidden of ["'プラン':", "'有効期限':", "'Status': 'active'"]) {
    assert.ok(
      !APPLICATION.includes(forbidden),
      `申込 Function が ${forbidden} を直接書いている（入金確認前に昇格する）`,
    );
  }
  // 申込時の有効期限計算が復活していないこと
  assert.ok(
    !/setFullYear\(.*\+ 1\)/.test(APPLICATION),
    '申込 Function に有効期限の +1年 計算が復活している',
  );
});

test('guard: 申込 Function は退会フラグを申込時にリセットしない', () => {
  assert.ok(
    !APPLICATION.includes("'WithdrawalRequested': false"),
    '未入金の申込だけで退会申請が取り消されてしまう',
  );
});

test('guard: 昇格は confirm-bank-payment.js だけが行う', () => {
  assert.ok(CONFIRM.includes('buildConfirmationFields'), 'confirm が単一源を使っていない');
  assert.ok(CONFIRM.includes("'Status': 'active'") === false, 'confirm はフィールドを直書きしない');
  // 昇格の中身は bankPaymentFlow が返す confirmation.fields を PATCH するだけ
  assert.ok(CONFIRM.includes('fields: confirmation.fields'), 'confirm が単一源の結果を PATCH していない');
});

test('guard: confirm は PaymentConfirmed=true を認可根拠にする（公開 URL のため必須）', () => {
  assert.ok(
    CONFIRM.includes("fields['PaymentConfirmed'] !== true"),
    'PaymentConfirmed の検証が無い（誰でも Premium 昇格を叩ける）',
  );
  assert.ok(CONFIRM.includes('403'), '未チェック時に 403 を返していない');
});

test('guard: confirm は申込内容が無ければ昇格しない（fail closed）', () => {
  // 昇格内容は buildConfirmationFields が null を返したら中断する（変数名は planned）
  assert.ok(CONFIRM.includes('if (!planned)'), 'fail closed 分岐が無い');
  assert.ok(CONFIRM.includes('skipped: true'), 'スキップ結果を返していない');
  assert.ok(CONFIRM.includes('ADMIN_EMAIL'), '管理者通知が無い');
});

test('guard: 二重メール防止 — confirm が PaymentEmailSent を立て、auto 側がガードを持つ', () => {
  // confirm 側は bankPaymentFlow 経由で PaymentEmailSent を含める（ロジック側でテスト済み）
  assert.ok(
    AUTO.includes('paymentEmailSent') && AUTO.includes('再送信スキップ'),
    'send-payment-confirmation-auto.js の二重送信ガードが失われている',
  );
});

test('guard: confirm はメール結果を単一源 evaluateMailOutcome で判定する', () => {
  assert.ok(CONFIRM.includes('evaluateMailOutcome'), 'confirm がメール結果判定の単一源を使っていない');
  assert.ok(
    CONFIRM.includes('emailSent: mail.providerAccepted'),
    'PaymentEmailSent が provider の受理結果から決まっていない（送信前に true が立つ旧欠陥）',
  );
});

test('guard: confirm はメール送信を昇格 PATCH より先に行う（二重送信防止の要）', () => {
  // Status='active' と PaymentEmailSent=true を同じ PATCH に載せるため、送信は PATCH の前。
  // 分割すると Status 変化で発火する Automation が「未送信」と誤認し二重送信する。
  const sendIdx = CONFIRM.indexOf('await sendMail({');
  const patchIdx = CONFIRM.indexOf("method: 'PATCH'");
  assert.ok(sendIdx > 0, 'confirm がメールを送っていない');
  assert.ok(patchIdx > 0, 'confirm が昇格 PATCH をしていない');
  assert.ok(
    sendIdx < patchIdx,
    'メール送信が昇格 PATCH より後にある（PaymentEmailSent を provider 結果で決められない）',
  );
});

test('guard: confirm はメール失敗を握り潰さず構造化ログを残す', () => {
  for (const key of ['providerAttempted', 'providerAccepted', 'failureStage', 'hasProviderMessageId']) {
    assert.ok(CONFIRM.includes(key), `構造化ログに ${key} が無い`);
  }
});

test('guard: confirm は API key / Authorization / メール本文をログへ出さない', () => {
  // console.* の引数に秘密情報が混ざっていないこと（雑な混入の検知）
  for (const line of CONFIRM.split('\n')) {
    if (!/console\.(log|warn|error)/.test(line)) continue;
    for (const forbidden of ['SENDGRID_API_KEY', 'AIRTABLE_API_KEY', 'CONFIRM_SECRET', 'Authorization', 'apiKey', 'html']) {
      assert.ok(!line.includes(forbidden), `ログに ${forbidden} が出力されている: ${line.trim()}`);
    }
  }
});

test('guard: メール失敗でも昇格・Requested* クリアは維持される（巻き戻さない）', () => {
  // 昇格 PATCH は confirmation.fields をそのまま送る（メール結果で分岐しない）
  assert.ok(CONFIRM.includes('fields: confirmation.fields'), '昇格 PATCH が単一源の結果を送っていない');
  assert.ok(
    !/if \(!mail\.providerAccepted\)[\s\S]{0,80}return/.test(CONFIRM),
    'メール失敗で昇格を中断している（権限・有効期限が付与されない）',
  );
});

test('guard: confirm は Airtable PATCH 失敗を握りつぶさない', () => {
  assert.ok(CONFIRM.includes("error: 'Airtable update failed'"), 'PATCH 失敗が握りつぶされている');
});
