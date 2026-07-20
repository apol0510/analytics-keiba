/**
 * paymentEmailWorker.test.mjs — 送信 worker コアのテスト（実 IO なし・fake 注入）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkerOnce } from './paymentEmailWorker.js';
import { EMAIL_STATUS } from './paymentEmailState.js';

const T0 = Date.UTC(2026, 6, 16, 0, 0, 0);

/** Airtable / Redis / SendGrid の fake を組み立てる。patch は record にマージし呼び出しを記録。 */
function makeDeps({ initial, sendMail, lockOk = true, hasApiKey = true }) {
  const record = { id: 'recW1', fields: { PaymentEmailStatus: EMAIL_STATUS.PENDING, Email: 'x@example.com', PaymentEmailAttemptCount: 0, PaymentEmailIdempotencyKey: 'idem123', ...initial } };
  const calls = { patch: [], sendMail: [], lock: [], release: [] };
  let tokenSeq = 100;
  const deps = {
    hasApiKey,
    getRecord: async () => ({ id: record.id, fields: { ...record.fields } }),
    patchRecord: async (id, fields) => { calls.patch.push(fields); Object.assign(record.fields, fields); },
    acquireLock: async (key) => { calls.lock.push(key); return { ok: lockOk, token: ++tokenSeq }; },
    releaseLock: async (key, token) => { calls.release.push({ key, token }); },
    sendMail: async (args) => { calls.sendMail.push(args); return sendMail ? sendMail(args) : { status: 202, messageId: 'MID' }; },
  };
  return { deps, record, calls };
}

test('worker: 正常送信 → accepted + PaymentEmailSent=true、custom_args に idempotency_key', async () => {
  const { deps, record, calls } = makeDeps({});
  const r = await runWorkerOnce({ recordId: 'recW1', now: T0, deps });
  assert.equal(r.ok, true);
  assert.equal(r.status, EMAIL_STATUS.ACCEPTED);
  assert.equal(record.fields.PaymentEmailStatus, EMAIL_STATUS.ACCEPTED);
  assert.equal(record.fields.PaymentEmailSent, true);
  assert.equal(record.fields.PaymentEmailProviderMessageId, 'MID');
  // sendMail に冪等キーが渡る
  assert.equal(calls.sendMail[0].idempotencyKey, 'idem123');
  assert.equal(calls.sendMail[0].recordId, 'recW1');
  // ロックは必ず解放される
  assert.equal(calls.release.length, 1);
});

test('worker: 送信前に attempting_pre_send → unknown_after_attempt の順で write-ahead する', async () => {
  const { deps, calls } = makeDeps({});
  await runWorkerOnce({ recordId: 'recW1', now: T0, deps });
  const statuses = calls.patch.map((p) => p.PaymentEmailStatus).filter(Boolean);
  const iPre = statuses.indexOf(EMAIL_STATUS.ATTEMPTING_PRE_SEND);
  const iUnknown = statuses.indexOf(EMAIL_STATUS.UNKNOWN_AFTER_ATTEMPT);
  const iAccepted = statuses.indexOf(EMAIL_STATUS.ACCEPTED);
  assert.ok(iPre >= 0 && iUnknown > iPre && iAccepted > iUnknown, `順序が不正: ${statuses.join(',')}`);
});

test('worker: ロックを取れなければ何もしない（送信もしない）', async () => {
  const { deps, calls } = makeDeps({ lockOk: false });
  const r = await runWorkerOnce({ recordId: 'recW1', now: T0, deps });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'lock');
  assert.equal(calls.sendMail.length, 0);
  assert.equal(calls.patch.length, 0);
});

test('worker: unknown_after_attempt は worker では拾わない（reconciler 専管）', async () => {
  const { deps, calls } = makeDeps({ initial: { PaymentEmailStatus: EMAIL_STATUS.UNKNOWN_AFTER_ATTEMPT } });
  const r = await runWorkerOnce({ recordId: 'recW1', now: T0, deps });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'lease');
  assert.equal(calls.sendMail.length, 0);
});

test('worker: 5xx → failed_retryable（PaymentEmailSent は立てない）', async () => {
  const { deps, record } = makeDeps({ sendMail: () => ({ status: 503 }) });
  const r = await runWorkerOnce({ recordId: 'recW1', now: T0, deps });
  assert.equal(r.status, EMAIL_STATUS.FAILED_RETRYABLE);
  assert.equal(record.fields.PaymentEmailStatus, EMAIL_STATUS.FAILED_RETRYABLE);
  assert.notEqual(record.fields.PaymentEmailSent, true);
});

test('worker: 4xx → failed_terminal', async () => {
  const { deps, record } = makeDeps({ sendMail: () => ({ status: 400, error: 'bad request' }) });
  const r = await runWorkerOnce({ recordId: 'recW1', now: T0, deps });
  assert.equal(r.status, EMAIL_STATUS.FAILED_TERMINAL);
  assert.equal(record.fields.PaymentEmailStatus, EMAIL_STATUS.FAILED_TERMINAL);
});

test('worker: 送信例外 → failed_retryable', async () => {
  const { deps, record } = makeDeps({ sendMail: () => ({ threw: true }) });
  await runWorkerOnce({ recordId: 'recW1', now: T0, deps });
  assert.equal(record.fields.PaymentEmailStatus, EMAIL_STATUS.FAILED_RETRYABLE);
});

test('worker: email 欠如は送信せず failed_terminal', async () => {
  const { deps, record, calls } = makeDeps({ initial: { Email: '' } });
  const r = await runWorkerOnce({ recordId: 'recW1', now: T0, deps });
  assert.equal(calls.sendMail.length, 0);
  assert.equal(record.fields.PaymentEmailStatus, EMAIL_STATUS.FAILED_TERMINAL);
  assert.equal(r.providerAccepted, false);
});

test('worker: API key 無しは送信せず failed_terminal', async () => {
  const { deps, record, calls } = makeDeps({ hasApiKey: false });
  await runWorkerOnce({ recordId: 'recW1', now: T0, deps });
  assert.equal(calls.sendMail.length, 0);
  assert.equal(record.fields.PaymentEmailStatus, EMAIL_STATUS.FAILED_TERMINAL);
});

test('worker: 送信元が AK 正式値でなければ送信せず failed_terminal（送信前 fail closed）', async () => {
  const { deps, record, calls } = makeDeps({});
  deps.hasVerifiedSender = false; // env 未設定 / 空 / noreply 等
  await runWorkerOnce({ recordId: 'recW1', now: T0, deps });
  assert.equal(calls.sendMail.length, 0, '送信元不一致なのに SendGrid を呼んでいる');
  assert.equal(record.fields.PaymentEmailStatus, EMAIL_STATUS.FAILED_TERMINAL);
  assert.equal(record.fields.PaymentEmailFailureStage, 'sender_unverified');
  assert.notEqual(record.fields.PaymentEmailSent, true, '未送信なのに送信済みを立てている');
});

test('worker: 送信元が検証済みなら通常どおり送信する（カナリア経路も同じ deps 契約）', async () => {
  const { deps, record, calls } = makeDeps({});
  deps.hasVerifiedSender = true;
  await runWorkerOnce({ recordId: 'recW1', now: T0, deps });
  assert.equal(calls.sendMail.length, 1);
  assert.equal(record.fields.PaymentEmailStatus, EMAIL_STATUS.ACCEPTED);
});

test('worker: read-back で token が奪われていたら送信しない（fencing）', async () => {
  // patch 後の getRecord が別 token を返すように仕込む
  const record = { id: 'recW1', fields: { PaymentEmailStatus: EMAIL_STATUS.PENDING, Email: 'x@example.com', PaymentEmailAttemptCount: 0 } };
  let getCount = 0;
  const calls = { sendMail: [] };
  const deps = {
    getRecord: async () => {
      getCount += 1;
      // 1回目=初期取得、2回目=read-back（別 token を返して横取りを再現）
      if (getCount >= 2) return { id: record.id, fields: { ...record.fields, PaymentEmailAttemptToken: '999999' } };
      return { id: record.id, fields: { ...record.fields } };
    },
    patchRecord: async (id, fields) => { Object.assign(record.fields, fields); },
    acquireLock: async () => ({ ok: true, token: 100 }),
    releaseLock: async () => {},
    sendMail: async (a) => { calls.sendMail.push(a); return { status: 202 }; },
  };
  const r = await runWorkerOnce({ recordId: 'recW1', now: T0, deps });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'fencing');
  assert.equal(calls.sendMail.length, 0);
});

test('worker: attempt 上限では lease を取れず送信しない', async () => {
  const { deps, calls } = makeDeps({ initial: { PaymentEmailAttemptCount: 3 } });
  const r = await runWorkerOnce({ recordId: 'recW1', now: T0, deps });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'lease');
  assert.equal(calls.sendMail.length, 0);
});
