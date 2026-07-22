/**
 * paymentEmailSender.guard.test.mjs — 決済メール送信元の「配線」を実ファイル検査で固定する。
 *
 * ロジックが正しくても、deps が noreply へ戻ったり、カナリアだけ別の送信元契約を
 * 使う実装に戻ったら意味がないため、ソースを直接検査して固定する。
 * （paymentEmailDeps.canary.guard.test.mjs と同じ方式）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const DEPS = readFileSync(here('./paymentEmailDeps.js'), 'utf8');
const WORKER = readFileSync(here('./paymentEmailWorker.js'), 'utf8');
const SENDER = readFileSync(here('./senderIdentity.js'), 'utf8');
const STATE = readFileSync(here('./paymentEmailState.js'), 'utf8');

// legacy 経路（gate=legacy へ rollback したときに実際に送信する 2 ファイル）
const CONFIRM = readFileSync(here('../../../netlify/functions/confirm-bank-payment.js'), 'utf8');
const AUTO = readFileSync(here('../../../netlify/functions/send-payment-confirmation-auto.js'), 'utf8');

/** コメント / JSDoc を除いた実コード。 */
const stripComments = (src) => src.replace(/^\s*\*.*$/gm, '').replace(/^\s*\/\/.*$/gm, '');

test('guard: 決済メール経路は email-config の FROM_EMAIL を import しない（noreply 混入の遮断）', () => {
  assert.ok(!/import\s*\{[^}]*\bFROM_EMAIL\b[^}]*\}\s*from\s*'[^']*email-config\.js'/.test(DEPS),
    'paymentEmailDeps.js が FROM_EMAIL を import している（noreply へ戻る経路）');
  assert.ok(!/\bFROM_EMAIL\b/.test(DEPS.replace(/^.*senderIdentity.*$/gm, '').replace(/^\s*\/\/.*$/gm, '')),
    'paymentEmailDeps.js のコード中に FROM_EMAIL 参照が残っている');
});

test('guard: 決済メール経路のソースに noreply アドレスを直書きしない', () => {
  for (const [name, src] of [['deps', DEPS], ['worker', WORKER], ['senderIdentity', SENDER]]) {
    const code = src.replace(/^\s*\*.*$/gm, '').replace(/^\s*\/\/.*$/gm, ''); // コメント/JSDoc 除外
    assert.ok(!/noreply@/.test(code), `${name} に noreply@ が直書きされている`);
  }
});

test('guard: sendMail は senderIdentity で解決した from を使う', () => {
  const m = DEPS.match(/async function sendMail\([\s\S]*?\n\}/);
  assert.ok(m, 'sendMail が見つからない');
  assert.ok(m[0].includes('resolveVerifiedSender'), 'sendMail が送信元契約を解決していない');
  assert.ok(/from:\s*\{\s*email:\s*sender\.email/.test(m[0]), 'from に解決済み送信元を使っていない');
  assert.ok(/if \(!sender\.ok\) return/.test(m[0]), '送信元不一致で fail closed していない（POST 前に返していない）');
});

test('guard: worker は送信元未検証なら sendMail を呼ばない', () => {
  assert.ok(/deps\.hasVerifiedSender !== false/.test(WORKER), 'worker が deps.hasVerifiedSender を見ていない');
  assert.ok(/if \(hasApiKey && hasEmail && senderVerified\)/.test(WORKER),
    '送信条件に senderVerified が含まれていない（送信前 fail closed になっていない）');
  assert.ok(/hasVerifiedSender: senderVerified/.test(WORKER), 'outcome 判定へ送信元検証結果を渡していない');
});

test('guard: 通常 worker deps とカナリア deps が同一の送信元契約を使う', () => {
  const prod = DEPS.match(/export function makeWorkerDeps\(\)[\s\S]*?\n\}/);
  const canary = DEPS.match(/export function makeCanaryWorkerDeps\(\)[\s\S]*?\n\}/);
  assert.ok(prod && canary, 'deps ファクトリが見つからない');
  for (const [name, m] of [['makeWorkerDeps', prod], ['makeCanaryWorkerDeps', canary]]) {
    assert.ok(/hasVerifiedSender: hasVerifiedSender\(process\.env\)/.test(m[0]),
      `${name} が送信元契約を注入していない`);
  }
  assert.ok(!/canarySender|CANARY_FROM|PAYMENT_EMAIL_CANARY_FROM/.test(DEPS),
    'カナリア専用の別送信元が導入されている（契約は 1 つに保つ）');
});

test('guard: 送信元契約は正式値 support@keiba.link のみを許可し fallback を持たない', () => {
  assert.ok(/OFFICIAL_FROM_EMAIL = 'support@keiba\.link'/.test(SENDER), '正式送信元が support@keiba.link でない');
  assert.ok(!/\|\|\s*'[^']*@/.test(SENDER), '送信元に || fallback が存在する');
  assert.ok(/SENDGRID_FROM_EMAIL/.test(SENDER), 'env SENDGRID_FROM_EMAIL を検証していない');
});

// ── legacy 経路（2026-07-21 追加）────────────────────────────────
// gate=v2-full では通常発火しないが、FLOW_VERSION=legacy へ rollback すると
// この 2 ファイルが実際に送信する。noreply へ戻る経路をここで塞ぐ。

test('guard: legacy 経路も email-config の FROM_EMAIL を import しない', () => {
  for (const [name, src] of [['confirm-bank-payment', CONFIRM], ['send-payment-confirmation-auto', AUTO]]) {
    assert.ok(!/import\s*\{[^}]*\bFROM_EMAIL\b[^}]*\}\s*from\s*'[^']*email-config\.js'/.test(src),
      `${name} が FROM_EMAIL を import している（rollback 時に noreply へ戻る）`);
    assert.ok(!/\bFROM_EMAIL\b/.test(stripComments(src)),
      `${name} のコード中に FROM_EMAIL 参照が残っている`);
    assert.ok(!/noreply@/.test(stripComments(src)),
      `${name} に noreply@ が直書きされている`);
  }
});

test('guard: legacy 経路は senderIdentity で解決した from を使う', () => {
  for (const [name, src] of [['confirm-bank-payment', CONFIRM], ['send-payment-confirmation-auto', AUTO]]) {
    assert.ok(/from '[^']*senderIdentity\.js'/.test(src),
      `${name} が送信元契約の単一源を import していない`);
    assert.ok(/resolveVerifiedSender\(process\.env\)/.test(src),
      `${name} が送信元を解決していない`);
    assert.ok(/from:\s*\{\s*email:\s*sender\.email,\s*name:\s*sender\.name\s*\}/.test(src),
      `${name} が解決済み送信元を from に使っていない`);
  }
});

test('guard: legacy 経路は送信元未検証なら SendGrid へ POST する前に fail closed', () => {
  for (const [name, src] of [['confirm-bank-payment', CONFIRM], ['send-payment-confirmation-auto', AUTO]]) {
    const code = stripComments(src);
    const senderIdx = code.indexOf('resolveVerifiedSender(process.env)');
    const guardIdx = code.indexOf('if (!sender.ok)');
    const postIdx = code.indexOf('api.sendgrid.com/v3/mail/send');
    assert.ok(senderIdx > -1 && guardIdx > -1 && postIdx > -1, `${name}: 想定の構造が見つからない`);
    assert.ok(senderIdx < guardIdx, `${name}: 解決前に fail closed 判定をしている`);
    assert.ok(guardIdx < postIdx, `${name}: SendGrid へ POST した後に送信元を検証している`);
    assert.ok(/throw new Error\(`sender_unverified: \$\{sender\.reason\}`\)/.test(code),
      `${name}: fail closed で理由コードを投げていない`);
  }
});

test('guard: legacy 経路の fail closed 理由に env の値を含めない', () => {
  for (const [name, src] of [['confirm-bank-payment', CONFIRM], ['send-payment-confirmation-auto', AUTO]]) {
    assert.ok(!/sender_unverified[^\n]*SENDGRID_FROM_EMAIL/.test(src),
      `${name}: 例外に env の値を含めている`);
  }
});

test('guard: legacy 送信失敗で PaymentEmailSent を true にしない（auto 経路の順序固定）', () => {
  const code = stripComments(AUTO);
  const guardIdx = code.indexOf('if (!sender.ok)');
  const sentIdx = code.indexOf("'PaymentEmailSent': true");
  assert.ok(guardIdx > -1 && sentIdx > -1, '想定の構造が見つからない');
  assert.ok(guardIdx < sentIdx,
    '送信元 fail closed より前に PaymentEmailSent=true を書いている（未送信なのに送信済みになる）');
});

test('guard: 送信元不一致は terminal 扱い（無限リトライで送信を試み続けない）', () => {
  assert.ok(/SENDER_UNVERIFIED: 'sender_unverified'/.test(STATE), 'SENDER_UNVERIFIED stage が無い');
  const m = STATE.match(/export function evaluateMailOutcome\([\s\S]*?\n\}/);
  assert.ok(/if \(!hasVerifiedSender\) return/.test(m[0]), 'evaluateMailOutcome が送信元未検証を判定していない');
  // retryable 判定に SENDER_UNVERIFIED を含めない（= failed_terminal になる）
  const d = STATE.match(/export function decideAfterProvider\([\s\S]*?\n\}/);
  assert.ok(!/SENDER_UNVERIFIED/.test(d[0]), '送信元不一致が retryable 側に入っている');
});
