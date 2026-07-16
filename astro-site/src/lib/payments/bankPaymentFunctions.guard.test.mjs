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
  assert.ok(CONFIRM.includes('if (!confirmation)'), 'fail closed 分岐が無い');
  assert.ok(CONFIRM.includes('skipped: true'), 'スキップ結果を返していない');
  assert.ok(CONFIRM.includes('ADMIN_EMAIL'), '管理者通知が無い');
});

test('guard: 二重メール防止 — confirm が PaymentEmailSent を立て、auto 側がガードを持つ', () => {
  // confirm 側は bankPaymentFlow 経由で PaymentEmailSent=true を含める（ロジック側でテスト済み）
  assert.ok(
    AUTO.includes('paymentEmailSent') && AUTO.includes('再送信スキップ'),
    'send-payment-confirmation-auto.js の二重送信ガードが失われている',
  );
});

test('guard: confirm は Airtable PATCH 失敗を握りつぶさない', () => {
  assert.ok(CONFIRM.includes("error: 'Airtable update failed'"), 'PATCH 失敗が握りつぶされている');
});

// ── v2 配線（gate OFF=legacy で本番挙動を変えない）─────────────────
test('guard: confirm の v2 分岐は gate 経由で、legacy 経路も残る', () => {
  assert.ok(CONFIRM.includes('shouldConfirmUseV2'), 'gate による v2 判定が無い');
  assert.ok(CONFIRM.includes('buildV2ConfirmationFields'), 'v2 昇格ビルダーを使っていない');
  // legacy 経路（buildConfirmationFields + inline sendMail）が消えていないこと
  assert.ok(CONFIRM.includes('buildConfirmationFields'), 'legacy 昇格経路が消えた');
  assert.ok(/const useV2 = shouldConfirmUseV2\(/.test(CONFIRM), 'useV2 が gate から導出されていない');
});

test('guard: v2 confirm は inline 送信を useV2=false のときだけ行う（三項/分岐）', () => {
  // Step 5 が useV2 で分岐し、v2 では送信しない設計であること
  assert.ok(CONFIRM.includes('if (useV2)'), 'Step5 の useV2 分岐が無い（v2 で inline 送信してしまう）');
});
