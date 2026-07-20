/**
 * paymentEmailWorker.test.mjs — 送信 worker コアのテスト（実 IO なし・fake 注入）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkerOnce } from './paymentEmailWorker.js';
import { EMAIL_STATUS, FAILURE_STAGE, REQUIRED_PROVIDER_RESULT_FIELDS } from './paymentEmailState.js';

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

// ── schema preflight（2026-07-20 カナリア事故の恒久対策）────────────────────
test('worker: 必須フィールド欠落なら 送信も書込みもせず停止（送信前 fail closed）', async () => {
  const { deps, record, calls } = makeDeps({});
  const probed = [];
  deps.verifyWritableFields = async (names) => { probed.push(names); return { ok: false, missing: ['PaymentEmailAcceptedAt'] }; };
  const r = await runWorkerOnce({ recordId: 'recW1', now: T0, deps });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'schema');
  assert.equal(r.reason, FAILURE_STAGE.SCHEMA_INCOMPLETE);
  assert.deepEqual(r.missingFields, ['PaymentEmailAcceptedAt']);
  assert.equal(calls.sendMail.length, 0, 'schema 不備なのに SendGrid を呼んでいる');
  assert.equal(calls.patch.length, 0, 'schema 不備なのにレコードを書き換えている');
  assert.equal(calls.lock.length, 0, 'ロックより前に停止していない');
  assert.equal(record.fields.PaymentEmailStatus, EMAIL_STATUS.PENDING, '状態が変化している');
  assert.deepEqual(probed[0], [...REQUIRED_PROVIDER_RESULT_FIELDS], 'provider 後に書く全フィールドを検証していない');
});

test('worker: schema 判定不能（undetermined）でも fail closed で送信しない', async () => {
  const { deps, calls } = makeDeps({});
  deps.verifyWritableFields = async () => ({ ok: false, missing: null, undetermined: true });
  const r = await runWorkerOnce({ recordId: 'recW1', now: T0, deps });
  assert.equal(r.stage, 'schema');
  assert.equal(calls.sendMail.length, 0);
  assert.equal(calls.patch.length, 0);
});

test('worker: schema OK なら従来どおり送信する', async () => {
  const { deps, record, calls } = makeDeps({});
  deps.verifyWritableFields = async () => ({ ok: true, missing: [] });
  await runWorkerOnce({ recordId: 'recW1', now: T0, deps });
  assert.equal(calls.sendMail.length, 1);
  assert.equal(record.fields.PaymentEmailStatus, EMAIL_STATUS.ACCEPTED);
});

test('worker: verifyWritableFields 未提供の deps でも動く（後方互換）', async () => {
  const { deps, calls } = makeDeps({});
  assert.equal(deps.verifyWritableFields, undefined);
  const r = await runWorkerOnce({ recordId: 'recW1', now: T0, deps });
  assert.equal(r.ok, true);
  assert.equal(calls.sendMail.length, 1);
});

// ── provider 受理後の state write 失敗（2026-07-20 実事故の再現）──────────────
test('worker: provider 後 PATCH が失敗しても受理事実を失わず unknown_after_attempt を維持する', async () => {
  const { deps, record, calls } = makeDeps({});
  let patchCount = 0;
  const orig = deps.patchRecord;
  deps.patchRecord = async (id, fields) => {
    patchCount += 1;
    if (patchCount === 3) throw new Error('Airtable PATCH 422'); // 実事故と同じ段
    return orig(id, fields);
  };
  const r = await runWorkerOnce({ recordId: 'recW1', now: T0, deps });
  assert.equal(r.ok, false);
  assert.equal(r.stage, 'state_write');
  assert.equal(r.reason, FAILURE_STAGE.STATE_WRITE_FAILED);
  assert.equal(r.providerAccepted, true, 'provider 受理の事実が失われている');
  assert.equal(r.status, EMAIL_STATUS.UNKNOWN_AFTER_ATTEMPT);
  assert.equal(r.autoResend, false, '自動再送を許可している');
  assert.equal(r.needsReconcile, true, 'reconcile 対象として識別できない');
  // レコードは unknown_after_attempt のまま（pending へ戻さない = 再送されない）
  assert.equal(record.fields.PaymentEmailStatus, EMAIL_STATUS.UNKNOWN_AFTER_ATTEMPT);
  assert.equal(calls.sendMail.length, 1, '送信は 1 回だけ');
});

test('worker: state write 失敗時のログに Email / recordId / secret を出さない', async () => {
  const { deps } = makeDeps({});
  const logs = [];
  deps.log = (o) => logs.push(o);
  let n = 0;
  const orig = deps.patchRecord;
  deps.patchRecord = async (id, f) => { n += 1; if (n === 3) throw new Error('Airtable PATCH 422'); return orig(id, f); };
  await runWorkerOnce({ recordId: 'recW1', now: T0, deps });
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes('recW1'), 'ログに recordId が含まれている');
  assert.ok(!serialized.includes('@'), 'ログに Email らしき値が含まれている');
  assert.ok(!serialized.includes('422'), 'ログに Airtable 応答本文が含まれている');
});

test('worker: 成功時のログにも recordId を含めない', async () => {
  const { deps } = makeDeps({});
  const logs = [];
  deps.log = (o) => logs.push(o);
  await runWorkerOnce({ recordId: 'recW1', now: T0, deps });
  assert.ok(!JSON.stringify(logs).includes('recW1'), 'ログに recordId が含まれている');
});
