/**
 * importedCohort.test.mjs — 「CSV 取り込みの会員か」の判定
 *   node --test src/lib/crm/importedCohort.test.mjs
 *
 * 重点:
 *   - 正本は取り込み時に書いた `Source`（**新しい旗を作らない**）
 *   - 判別できなければコホート外（fail closed）
 *   - 取り込みの痕跡が 0 件なら「確認できない」として扱う
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isImportedCustomer, resolveImportBatchId, matchesImportCohort,
  summarizeCohort, assertCohortObservable, COHORT_SKIP, COHORT_SOURCE_PREFIX,
} from './importedCohort.js';
import { IMPORT_SOURCE_PREFIX, buildCreateFields } from './importWritePlan.js';

test('接頭辞は取り込み側の正本と一致する（複製しない）', () => {
  assert.equal(COHORT_SOURCE_PREFIX, `${IMPORT_SOURCE_PREFIX}:`);
});

test('取り込みが実際に書く fields をそのまま判定できる', () => {
  const fields = buildCreateFields({
    email: 'a@example.com', batchId: 'imp-2026-08-04-001', nowIso: '2026-08-04T00:00:00.000Z',
  });
  assert.equal(isImportedCustomer(fields), true);
  assert.equal(resolveImportBatchId(fields), 'imp-2026-08-04-001');
});

test('従来からの会員はコホート外', () => {
  assert.equal(isImportedCustomer({ Email: 'a@example.com' }), false);
  const m = matchesImportCohort({ Email: 'a@example.com' });
  assert.equal(m.ok, false);
  assert.equal(m.reason, COHORT_SKIP.NOT_IMPORTED);
});

test('監査列だけでも判定できる（Source が無い環境）', () => {
  assert.equal(isImportedCustomer({ ImportBatchId: 'imp-x' }), true);
  assert.equal(isImportedCustomer({ CreatedBy: IMPORT_SOURCE_PREFIX }), true);
});

test('別の Source は取り込み扱いしない', () => {
  assert.equal(isImportedCustomer({ Source: 'newsletter-form' }), false);
  assert.equal(isImportedCustomer({ Source: 'customer-import' }), false, '接頭辞だけで batch が無い形は採らない');
});

test('バッチを指定すると他バッチは外れる', () => {
  const f = { Source: 'customer-import:imp-A' };
  assert.equal(matchesImportCohort(f, { batchIds: ['imp-A'] }).ok, true);
  const other = matchesImportCohort(f, { batchIds: ['imp-B'] });
  assert.equal(other.ok, false);
  assert.equal(other.reason, COHORT_SKIP.OTHER_BATCH);
});

test('集計はバッチ別と理由別を返す', () => {
  const s = summarizeCohort([
    { fields: { Source: 'customer-import:imp-A' } },
    { fields: { Source: 'customer-import:imp-A' } },
    { fields: { Source: 'customer-import:imp-B' } },
    { fields: { Email: 'old@example.com' } },
  ]);
  assert.equal(s.total, 4);
  assert.equal(s.inCohort, 3);
  assert.equal(s.byBatch['imp-A'], 2);
  assert.equal(s.byReason[COHORT_SKIP.NOT_IMPORTED], 1);
});

test('【重要】痕跡が 0 件なら「確認できない」として中止させる', () => {
  const none = summarizeCohort([{ fields: { Email: 'a@example.com' } }]);
  const v = assertCohortObservable(none);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'cohort_unverifiable');

  const some = summarizeCohort([{ fields: { Source: 'customer-import:imp-A' } }]);
  assert.equal(assertCohortObservable(some).ok, true);
});
