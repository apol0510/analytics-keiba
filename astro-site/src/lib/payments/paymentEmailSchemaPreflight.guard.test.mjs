/**
 * paymentEmailSchemaPreflight.guard.test.mjs — schema preflight の「配線」を実ファイル検査で固定する。
 *
 * 2026-07-20 カナリア事故: provider 後に書くフィールドがテスト Base に無く、
 * **SendGrid 送信後**の PATCH が 422 で落ちた。結果「メールは届いたが受理を記録できない」状態になった。
 * ロジックが正しくても、プローブが書込みへ戻ったり、片方の deps だけ検証を省いたら再発するため固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const DEPS = readFileSync(here('./paymentEmailDeps.js'), 'utf8');
const WORKER = readFileSync(here('./paymentEmailWorker.js'), 'utf8');
const STATE = readFileSync(here('./paymentEmailState.js'), 'utf8');

function probeBody() {
  const m = DEPS.match(/async function verifyWritableFieldsFrom\([\s\S]*?\n\}/);
  assert.ok(m, 'verifyWritableFieldsFrom が見つからない');
  return m[0];
}

test('guard: プローブは read-only（PATCH / POST / DELETE を発行しない）', () => {
  const body = probeBody();
  assert.ok(!/method:\s*'(PATCH|POST|DELETE|PUT)'/.test(body), 'プローブが書込みメソッドを使っている');
  assert.ok(!/patchRecordFrom|typecast/.test(body), 'プローブがレコードを書き換えている（no-op PATCH 方式は禁止）');
});

test('guard: プローブは Meta API（schema.bases:read）に依存しない', () => {
  const body = probeBody();
  assert.ok(!/meta\/bases/.test(body), 'Meta API に依存している（カナリア PAT では 403 になる）');
  assert.ok(/fields%5B%5D=|fields\[\]/.test(body), 'fields[] による存在判定を使っていない');
});

test('guard: 判定不能（非 200 / 非 422 / 例外）は fail closed', () => {
  const body = probeBody();
  assert.ok(/undetermined:\s*true/.test(body), '判定不能を表現していない');
  const oks = body.match(/ok:\s*true/g) || [];
  assert.equal(oks.length, 1, 'ok:true を返す経路は「全フィールド 200」の 1 つだけであるべき');
  assert.ok(/catch\s*\{[\s\S]*?ok:\s*false/.test(body), '例外時に fail closed していない');
});

test('guard: 本番 deps とカナリア deps の双方に preflight が配線されている', () => {
  const prod = DEPS.match(/export function makeWorkerDeps\(\)[\s\S]*?\n\}/)[0];
  const canary = DEPS.match(/export function makeCanaryWorkerDeps\(\)[\s\S]*?\n\}/)[0];
  assert.ok(/verifyWritableFields:/.test(prod), '本番 deps に preflight が無い');
  assert.ok(/verifyWritableFields:/.test(canary), 'カナリア deps に preflight が無い');
  assert.ok(/verifyWritableFieldsFrom\(productionTarget\(\)/.test(prod), '本番 deps が本番 target を使っていない');
  assert.ok(/verifyWritableFieldsFrom\(target/.test(canary), 'カナリア deps が専用 target を使っていない');
});

test('guard: preflight は ロック取得・PATCH・送信より前に実行される', () => {
  const iProbe = WORKER.indexOf('deps.verifyWritableFields');
  const iLock = WORKER.indexOf('deps.acquireLock');
  const iPatch = WORKER.indexOf('deps.patchRecord');
  const iSend = WORKER.indexOf('deps.sendMail');
  assert.ok(iProbe > 0, 'worker が preflight を呼んでいない');
  assert.ok(iProbe < iLock && iProbe < iPatch && iProbe < iSend,
    'preflight が lock / patch / send より後にある（送信前 fail closed になっていない）');
});

test('guard: provider 後 PATCH の失敗を握って unknown_after_attempt を維持する', () => {
  const i = WORKER.indexOf('await deps.patchRecord(recordId, decision.fields);');
  assert.ok(i > 0, 'provider 後 PATCH が見つからない');
  // 直前に try、直後に catch があること（= 失敗を握れる形）
  assert.ok(/try\s*\{\s*$/.test(WORKER.slice(Math.max(0, i - 40), i)),
    'provider 後 PATCH が try で保護されていない');
  const after = WORKER.slice(i);
  assert.ok(/^\s*\}\s*catch/m.test(after.slice(0, 200)), 'provider 後 PATCH に catch が無い');
  const body = after.slice(0, after.indexOf('return { ok: true'));
  assert.ok(/STATE_WRITE_FAILED/.test(body), 'STATE_WRITE_FAILED として扱っていない');
  assert.ok(/providerAccepted: outcome\.providerAccepted/.test(body), 'provider 受理事実を返していない');
  assert.ok(/autoResend: false/.test(body), '自動再送禁止を明示していない');
  assert.ok(/needsReconcile: true/.test(body), 'reconcile 対象として識別できない');
  assert.ok(/UNKNOWN_AFTER_ATTEMPT/.test(body), 'unknown_after_attempt を維持していない');
  // 例外本文（Airtable 応答）を戻り値・ログへ出さない
  assert.ok(!/catch\s*\(\s*e\s*\)/.test(body), '例外オブジェクトを捕捉している（本文流出の恐れ）');
});

test('guard: worker のログに recordId を出さない', () => {
  const logs = WORKER.match(/deps\.log\(\{[^}]*\}\)/g) || [];
  assert.ok(logs.length > 0, 'ログ呼び出しが無い');
  for (const l of logs) {
    assert.ok(!/recordId/.test(l), `ログに recordId が含まれている: ${l}`);
  }
});

test('guard: 必須フィールド一覧に provider 後に書く全フィールドが含まれる', () => {
  const m = STATE.match(/export const REQUIRED_PROVIDER_RESULT_FIELDS = Object\.freeze\(\[[\s\S]*?\]\);/);
  assert.ok(m, 'REQUIRED_PROVIDER_RESULT_FIELDS が無い');
  for (const f of ['PaymentEmailStatus', 'PaymentEmailAcceptedAt', 'PaymentEmailProviderMessageId',
    'PaymentEmailFailureStage', 'PaymentEmailLastError', 'PaymentEmailSent']) {
    assert.ok(m[0].includes(f), `必須フィールドに ${f} が無い`);
  }
});
