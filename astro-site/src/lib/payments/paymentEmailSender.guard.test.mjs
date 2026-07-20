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

test('guard: 送信元不一致は terminal 扱い（無限リトライで送信を試み続けない）', () => {
  assert.ok(/SENDER_UNVERIFIED: 'sender_unverified'/.test(STATE), 'SENDER_UNVERIFIED stage が無い');
  const m = STATE.match(/export function evaluateMailOutcome\([\s\S]*?\n\}/);
  assert.ok(/if \(!hasVerifiedSender\) return/.test(m[0]), 'evaluateMailOutcome が送信元未検証を判定していない');
  // retryable 判定に SENDER_UNVERIFIED を含めない（= failed_terminal になる）
  const d = STATE.match(/export function decideAfterProvider\([\s\S]*?\n\}/);
  assert.ok(!/SENDER_UNVERIFIED/.test(d[0]), '送信元不一致が retryable 側に入っている');
});
