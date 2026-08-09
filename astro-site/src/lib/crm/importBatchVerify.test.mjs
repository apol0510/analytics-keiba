/**
 * importBatchVerify.test.mjs — per-batch 検証と全体突合の頻度を固定する
 *   node --test src/lib/crm/importBatchVerify.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyWrittenBatch, shouldRunFullReconcile, BATCH_VERIFY } from './importBatchVerify.js';

const SRC = 'customer-import:imp-2026-08-09-001';
const rec = (email, source = SRC, id = Math.random().toString(36).slice(2)) =>
  ({ id, fields: { Email: email, Source: source } });

test('全部書けていれば OK', () => {
  const r = verifyWrittenBatch({
    writtenEmails: ['a@x.com', 'b@x.com'],
    records: [rec('a@x.com'), rec('b@x.com')], expectedSource: SRC,
  });
  assert.equal(r.ok, true);
  assert.equal(r.code, BATCH_VERIFY.OK);
  assert.equal(r.found, 2);
});

test('書いたはずの行が無ければ missing', () => {
  const r = verifyWrittenBatch({
    writtenEmails: ['a@x.com', 'b@x.com'], records: [rec('a@x.com')], expectedSource: SRC,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, BATCH_VERIFY.MISSING);
  assert.equal(r.missing, 1);
});

test('**二重 CREATE** を検知する', () => {
  const r = verifyWrittenBatch({
    writtenEmails: ['a@x.com'], records: [rec('a@x.com'), rec('a@x.com')], expectedSource: SRC,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, BATCH_VERIFY.DUPLICATE);
  assert.equal(r.duplicates, 1);
});

test('二重は missing より優先して報告する（重い方を出す）', () => {
  const r = verifyWrittenBatch({
    writtenEmails: ['a@x.com', 'b@x.com'],
    records: [rec('a@x.com'), rec('a@x.com')], expectedSource: SRC,
  });
  assert.equal(r.code, BATCH_VERIFY.DUPLICATE);
});

test('自分の Source 以外に当たったら foreign_source', () => {
  const r = verifyWrittenBatch({
    writtenEmails: ['a@x.com'], records: [rec('a@x.com', 'nankan-analytics')], expectedSource: SRC,
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, BATCH_VERIFY.FOREIGN_SOURCE);
});

test('引けなかったら OK にしない（fail closed）', () => {
  for (const records of [null, undefined]) {
    const r = verifyWrittenBatch({ writtenEmails: ['a@x.com'], records, expectedSource: SRC });
    assert.equal(r.ok, false);
    assert.equal(r.code, BATCH_VERIFY.UNAVAILABLE);
  }
});

test('書いた行が 0 件なら OK（何も書いていない batch）', () => {
  const r = verifyWrittenBatch({ writtenEmails: [], records: [], expectedSource: SRC });
  assert.equal(r.ok, true);
});

test('大文字小文字・前後空白の差を同一視する', () => {
  const r = verifyWrittenBatch({
    writtenEmails: [' A@X.com '], records: [rec('a@x.com')], expectedSource: SRC,
  });
  assert.equal(r.ok, true);
});

// ── 全体突合の頻度 ──────────────────────────────────────────
test('完了時は必ず全体突合する（一度も通さず COMPLETED にしない）', () => {
  assert.equal(shouldRunFullReconcile({ isFinal: true, childIndex: 1 }), true);
  assert.equal(shouldRunFullReconcile({ isFinal: true, childIndex: 7 }), true);
});

test('途中は cadence ごとに全体突合する', () => {
  assert.equal(shouldRunFullReconcile({ isFinal: false, childIndex: 25, cadence: 25 }), true);
  assert.equal(shouldRunFullReconcile({ isFinal: false, childIndex: 50, cadence: 25 }), true);
  assert.equal(shouldRunFullReconcile({ isFinal: false, childIndex: 24, cadence: 25 }), false);
  assert.equal(shouldRunFullReconcile({ isFinal: false, childIndex: 1, cadence: 25 }), false);
});

test('143 バッチなら全体突合は 6 回程度に収まる', () => {
  let n = 0;
  for (let i = 1; i <= 143; i += 1) if (shouldRunFullReconcile({ isFinal: i === 143, childIndex: i, cadence: 25 })) n += 1;
  assert.ok(n <= 8, `全体突合が ${n} 回`);
  assert.ok(n >= 2, `全体突合が ${n} 回では少なすぎる`);
});
