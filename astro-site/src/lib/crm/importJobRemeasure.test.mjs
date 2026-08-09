/**
 * importJobRemeasure.test.mjs — 過少計測で誤って BLOCKED にしない
 *   node --test src/lib/crm/importJobRemeasure.test.mjs
 *
 * 2026-08-09 の本実行: 43 バッチ目で `created_matches_airtable: 4400 vs 4333` により
 * BLOCKED になった。書き込みを止めてから数え直すと **4,400 で完全一致**しており、
 * Airtable 一覧のページングが書き込み中に**少なく数えた**だけだった（重複も 0 のまま）。
 * 1 回のスナップショットを正本にしないようにする。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { shouldRemeasureBeforeBlock } from './importJobReconcile.js';

test('件数系だけが落ち、実測が記録より少ないときは測り直す（本番の再現）', () => {
  assert.equal(shouldRemeasureBeforeBlock({
    failedChecks: ['created_matches_airtable', 'claims_created_matches_airtable'],
    created: 4400, airtableSourceCount: 4333,
  }), true);
});

test('実測が記録より多いときは測り直さない（本当に増えている）', () => {
  assert.equal(shouldRemeasureBeforeBlock({
    failedChecks: ['created_matches_airtable'], created: 4400, airtableSourceCount: 4500,
  }), false);
});

test('重複が増えていたら測り直さずに止める', () => {
  assert.equal(shouldRemeasureBeforeBlock({
    failedChecks: ['no_new_duplicates'], created: 4400, airtableSourceCount: 4333,
  }), false);
  assert.equal(shouldRemeasureBeforeBlock({
    failedChecks: ['created_matches_airtable', 'no_new_duplicates'],
    created: 4400, airtableSourceCount: 4333,
  }), false, '重複が混ざっているのに測り直そうとしている');
});

test('会計が崩れているときは測り直さずに止める', () => {
  assert.equal(shouldRemeasureBeforeBlock({
    failedChecks: ['counters_balanced'], created: 4400, airtableSourceCount: 4333,
  }), false);
});

test('計画超過は測り直さずに止める', () => {
  assert.equal(shouldRemeasureBeforeBlock({
    failedChecks: ['within_plan'], created: 99999, airtableSourceCount: 4333,
  }), false);
});

test('落ちている検査が無ければ何もしない', () => {
  assert.equal(shouldRemeasureBeforeBlock({ failedChecks: [], created: 100, airtableSourceCount: 100 }), false);
});

test('実測が取れていない（null）ときは測り直さない', () => {
  assert.equal(shouldRemeasureBeforeBlock({
    failedChecks: ['created_matches_airtable'], created: 100, airtableSourceCount: null,
  }), false);
});

// ── Function 側の配線 ───────────────────────────────────────
const FN = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/admin-customer-import-job.js', import.meta.url)), 'utf8');

test('測り直しは 1 回だけで、2 回目の結果で判定する', () => {
  assert.match(FN, /shouldRemeasureBeforeBlock\(\{/);
  const i = FN.indexOf('shouldRemeasureBeforeBlock({');
  const body = FN.slice(i, i + 1400);
  assert.match(body, /fetchAllReadOnly\(/, '測り直していない');
  assert.match(body, /recon2 = reconcileImportJob\(/, '2 回目で突合し直していない');
  assert.equal((body.match(/fetchAllReadOnly\(/g) || []).length, 1, '測り直しが 1 回を超えている');
});

test('最終判定は測り直し後の結果を使う', () => {
  assert.match(FN, /next\.reconciliation = recon2;/);
  assert.match(FN, /if \(recon2\.verdict === RECONCILE_VERDICT\.BLOCKED\)/);
});

test('測り直しても NG なら BLOCKED にする（検査を無効化しない）', () => {
  const i = FN.indexOf('if (recon2.verdict === RECONCILE_VERDICT.BLOCKED)');
  assert.ok(i > -1);
  assert.match(FN.slice(i, i + 160), /markJobBlocked/);
});
