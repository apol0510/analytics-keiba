/**
 * paymentEmailReconciler.test.mjs — reconciler コアのテスト（実 IO なし・fake 注入・dry-run 重視）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileOne, reconcileUnknownBatch } from './paymentEmailReconciler.js';
import { EMAIL_STATUS, RECONCILE_ZERO_MIN_WAIT_MS } from './paymentEmailState.js';

const T0 = Date.UTC(2026, 6, 16, 0, 0, 0);

function unknownRecord(over = {}) {
  return {
    id: 'recR1',
    fields: {
      PaymentEmailStatus: EMAIL_STATUS.UNKNOWN_AFTER_ATTEMPT,
      PaymentEmailIdempotencyKey: 'idemR1',
      PaymentEmailAttemptedAt: new Date(T0).toISOString(),
      PaymentEmailAttemptCount: 1,
      ...over,
    },
  };
}

function makeDeps(activity) {
  const calls = { patch: [], search: [] };
  const deps = {
    searchActivity: async (idk) => { calls.search.push(idk); return activity; },
    patchRecord: async (id, fields) => { calls.patch.push({ id, fields }); },
  };
  return { deps, calls };
}

test('reconcile dry-run: 書き込まず wouldWrite を返す', async () => {
  const { deps, calls } = makeDeps({ httpStatus: 200, messages: [{ msg_id: 'MID' }] });
  const r = await reconcileOne({ record: unknownRecord(), now: T0 + 120_000, dryRun: true, deps });
  assert.equal(r.action, 'accept');
  assert.equal(r.dryRun, true);
  assert.equal(r.wouldWrite.PaymentEmailStatus, EMAIL_STATUS.ACCEPTED);
  assert.equal(r.wouldWrite.PaymentEmailProviderMessageId, 'MID');
  // dry-run なので patch は呼ばれない
  assert.equal(calls.patch.length, 0);
});

test('reconcile 本番: 1件ヒット → accepted を書く', async () => {
  const { deps, calls } = makeDeps({ httpStatus: 200, messages: [{ msg_id: 'MID' }] });
  const r = await reconcileOne({ record: unknownRecord(), now: T0 + 120_000, dryRun: false, deps });
  assert.equal(r.action, 'accept');
  assert.equal(calls.patch.length, 1);
  assert.equal(calls.patch[0].fields.PaymentEmailStatus, EMAIL_STATUS.ACCEPTED);
  assert.equal(calls.patch[0].fields.PaymentEmailSent, true);
});

test('reconcile: HTTP エラーは 0件扱いせず wait（書き込まない）', async () => {
  const { deps, calls } = makeDeps({ httpStatus: 503, messages: [] });
  const r = await reconcileOne({ record: unknownRecord(), now: T0 + 60 * 60_000, dryRun: false, deps });
  assert.equal(r.action, 'wait');
  assert.equal(calls.patch.length, 0);
});

test('reconcile: 0件が 30分未満は wait（反映遅延で再送しない）', async () => {
  const { deps, calls } = makeDeps({ httpStatus: 200, messages: [] });
  const r = await reconcileOne({ record: unknownRecord(), now: T0 + 10 * 60_000, dryRun: false, deps });
  assert.equal(r.action, 'wait');
  assert.equal(calls.patch.length, 0);
});

test('reconcile: 0件が 30分継続 && attempt<3 → resend（pending へ）', async () => {
  const { deps, calls } = makeDeps({ httpStatus: 200, messages: [] });
  const r = await reconcileOne({ record: unknownRecord(), now: T0 + RECONCILE_ZERO_MIN_WAIT_MS + 1, dryRun: false, deps });
  assert.equal(r.action, 'resend');
  assert.equal(calls.patch[0].fields.PaymentEmailStatus, EMAIL_STATUS.PENDING);
});

test('reconcile: 複数件ヒット → needs_admin（自動再送しない）', async () => {
  const { deps, calls } = makeDeps({ httpStatus: 200, messages: [{ msg_id: 'a' }, { msg_id: 'b' }] });
  const r = await reconcileOne({ record: unknownRecord(), now: T0 + 60 * 60_000, dryRun: false, deps });
  assert.equal(r.action, 'escalate');
  assert.equal(calls.patch[0].fields.PaymentEmailStatus, EMAIL_STATUS.NEEDS_ADMIN);
});

test('reconcile: unknown_after_attempt 以外は skip（IO しない）', async () => {
  const { deps, calls } = makeDeps({ httpStatus: 200, messages: [] });
  const r = await reconcileOne({ record: { id: 'x', fields: { PaymentEmailStatus: EMAIL_STATUS.PENDING } }, now: T0, dryRun: false, deps });
  assert.equal(r.action, 'skip');
  assert.equal(r.skipped, true);
  assert.equal(calls.search.length, 0);
  assert.equal(calls.patch.length, 0);
});

test('batch: 複数レコードを集計（dry-run で書き込まない）', async () => {
  const records = [
    unknownRecord({ PaymentEmailIdempotencyKey: 'a' }),
    { id: 'recR2', fields: { PaymentEmailStatus: EMAIL_STATUS.UNKNOWN_AFTER_ATTEMPT, PaymentEmailIdempotencyKey: 'b', PaymentEmailAttemptedAt: new Date(T0).toISOString(), PaymentEmailAttemptCount: 1 } },
  ];
  const calls = { patch: [] };
  const deps = {
    listUnknownAfterAttempt: async () => records,
    searchActivity: async () => ({ httpStatus: 200, messages: [{ msg_id: 'MID' }] }),
    patchRecord: async (id, fields) => { calls.patch.push({ id, fields }); },
  };
  const r = await reconcileUnknownBatch({ now: T0 + 120_000, dryRun: true, deps });
  assert.equal(r.count, 2);
  assert.equal(r.byAction.accept, 2);
  assert.equal(calls.patch.length, 0); // dry-run
});
