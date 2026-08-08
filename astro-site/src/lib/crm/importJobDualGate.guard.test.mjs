/**
 * importJobDualGate.guard.test.mjs — 本実行の二重ゲートを固定する
 *   node --test src/lib/crm/importJobDualGate.guard.test.mjs
 *
 * 書き込み経路は **CUSTOMER_IMPORT_JOB_APPROVED と CUSTOMER_IMPORT_WRITE_ENABLED が
 * 両方 'true' のときだけ**開く。どちらも production 未設定なので、コードを merge しても
 * **env を開けるまで書き込みは構造的に不可能**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { canStartImportJob, canStepImportJob, JOB_REJECT, JOB_STATUS } from './importJobModel.js';

const FN = fileURLToPath(new URL('../../../netlify/functions/admin-customer-import-job.js', import.meta.url));
const code = readFileSync(FN, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── 1. Function 入口のゲート ───────────────────────────────────
test('start / step は 2 つの env を両方見る', () => {
  assert.match(code, /CUSTOMER_IMPORT_JOB_APPROVED\s*===\s*'true'/);
  assert.match(code, /CUSTOMER_IMPORT_WRITE_ENABLED\s*===\s*'true'/);
  assert.match(code, /if\s*\(\s*!approved\s*\|\|\s*!writeOn\s*\)/,
    '片方だけで通す実装になっている（両方必須にすること）');
});

test('ゲートが閉じているときは 403 / blocked_by_design で止める', () => {
  const i = code.indexOf("if (!approved || !writeOn)");
  assert.ok(i > -1);
  const body = code.slice(i, i + 500);
  assert.match(body, /json\(403/, '403 以外で返している');
  assert.match(body, /blocked_by_design/);
  assert.match(body, /written:\s*0/, '書き込み 0 を明示していない');
});

test('ゲートは start / step の両方に掛かる', () => {
  assert.match(code, /action === 'start' \|\| action === 'step'/);
});

test('ゲートは Redis / Airtable クライアントを作る前に置かれている', () => {
  const gate = code.indexOf('CUSTOMER_IMPORT_JOB_APPROVED');
  const claims = code.indexOf('createClaimStore(');
  const authority = code.indexOf('createJobAuthority(');
  assert.ok(gate > -1 && claims > gate, 'claim store がゲートより前に作られている');
  assert.ok(authority > gate, 'authority がゲートより前に作られている');
});

test('env を既定で true 扱いする書き方をしていない', () => {
  assert.doesNotMatch(code, /CUSTOMER_IMPORT_JOB_APPROVED\s*!==\s*'false'/);
  assert.doesNotMatch(code, /CUSTOMER_IMPORT_WRITE_ENABLED\s*!==\s*'false'/);
  assert.doesNotMatch(code, /CUSTOMER_IMPORT_JOB_APPROVED\s*\|\|\s*'true'/);
});

// ── 2. 判定の単一源にも同じゲートが残っていること（2 段目）──────
test('canStartImportJob は write env が閉じていれば必ず拒否する', () => {
  for (const env of [{}, { CUSTOMER_IMPORT_WRITE_ENABLED: 'false' }, { CUSTOMER_IMPORT_WRITE_ENABLED: '1' }]) {
    const r = canStartImportJob({
      env, confirmation: 'x', batchId: 'b', plannedTotal: 10,
      providerOk: true, lockAcquired: true,
    });
    assert.equal(r.allowed, false);
    assert.equal(r.reason, JOB_REJECT.WRITE_DISABLED);
  }
});

test('canStepImportJob も write env が閉じていれば必ず拒否する', () => {
  const r = canStepImportJob({
    env: {}, job: { status: JOB_STATUS.RUNNING, plannedTotal: 10, created: 0 },
    providerOk: true, lockAcquired: true,
  });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, JOB_REJECT.WRITE_DISABLED);
});

// ── 3. UPDATE / 送信が構造的に無いこと ────────────────────────
test('Function は PATCH を組み立てない（既存 Customers を更新しない）', () => {
  assert.doesNotMatch(code, /method:\s*'PATCH'/);
  assert.doesNotMatch(code, /method:\s*"PATCH"/);
});

test('Function はメール送信 API を呼ばない', () => {
  assert.doesNotMatch(code, /mail\/send/);
  // SendGrid は suppression の **読み取り**だけ
  const sg = code.match(/SENDGRID_API_KEY/g) || [];
  assert.ok(sg.length <= 1, `SendGrid 参照が多すぎる: ${sg.length}`);
});
