/**
 * marketingSendNow.test.mjs — 「今すぐ送信」に到達できる条件
 *
 * ここだけが実際に顧客へメールを出す操作で、押した瞬間から取り消せない。
 * **確認した対象と送る対象がズレたら押させない**ことを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEND_BLOCK, SEND_BLOCK_LABEL,
  buildDispatchPreflight, canSendNow, verifySendPrecondition,
  buildSendNowConfirmation, classifySendOutcome, summarizeSendResult,
} from './marketingSendNow.js';

const JOB = 'mkt-expired-comeback-v2-abc12345-1';
const dispatchOk = (over = {}) => ({
  mode: 'dry-run',
  jobs: 1,
  jobResults: [{ jobId: JOB, total: 10, willSend: 7, willSkip: 3, ...over }],
});
const campaign = { campaignId: 'expired-comeback', version: 2, name: '期限切れカムバック' };
const ready = (over = {}) => ({
  busy: false,
  dispatchEnabled: true,
  dryRun: { selected: 10, excluded: 3, willSend: 7 },
  dryRunStale: false,
  enqueued: true,
  preflight: buildDispatchPreflight(dispatchOk()),
  sent: false,
  campaign,
  ...over,
});

// ── 送信直前の 1 件特定 ─────────────────────────────────────
test('送信待ちジョブが 1 件でなければ送れない（0 件 / 2 件以上）', () => {
  assert.equal(buildDispatchPreflight({ jobResults: [] }).reason, SEND_BLOCK.JOB_NOT_UNIQUE);
  assert.equal(buildDispatchPreflight({ jobResults: [{ jobId: 'a', willSend: 1 }, { jobId: 'b', willSend: 1 }] }).reason,
    SEND_BLOCK.JOB_NOT_UNIQUE);
  assert.equal(buildDispatchPreflight(dispatchOk()).ok, true);
});

test('送信対象 0 通の確認結果からは送れない', () => {
  const pf = buildDispatchPreflight(dispatchOk({ willSend: 0 }));
  assert.equal(pf.ok, false);
  assert.equal(pf.reason, SEND_BLOCK.NO_RECIPIENTS);
  assert.equal(canSendNow(ready({ preflight: pf })).reason, SEND_BLOCK.NO_RECIPIENTS);
});

// ── 各段を飛ばせない ────────────────────────────────────────
test('dry-run 未実施では送れない', () => {
  assert.equal(canSendNow(ready({ dryRun: null })).reason, SEND_BLOCK.NO_DRY_RUN);
});

test('dry-run 結果が失効していれば送れない', () => {
  assert.equal(canSendNow(ready({ dryRunStale: true })).reason, SEND_BLOCK.DRY_RUN_STALE);
});

test('キュー未登録では送れない', () => {
  assert.equal(canSendNow(ready({ enqueued: false })).reason, SEND_BLOCK.NOT_ENQUEUED);
});

test('送信直前の確認（dispatcher dryRun:true）が無ければ送れない', () => {
  assert.equal(canSendNow(ready({ preflight: null })).reason, SEND_BLOCK.NO_PREFLIGHT);
});

test('gate が閉じていれば送れない', () => {
  assert.equal(canSendNow(ready({ dispatchEnabled: false })).reason, SEND_BLOCK.GATE_CLOSED);
});

test('実行中は送れない（二重クリックで 2 回走らせない）', () => {
  assert.equal(canSendNow(ready({ busy: true })).reason, SEND_BLOCK.BUSY);
});

test('送信済みなら再送できない（同じ画面から二度押せない）', () => {
  assert.equal(canSendNow(ready({ sent: true })).reason, SEND_BLOCK.ALREADY_SENT);
});

test('すべて満たしたときだけ送れる', () => {
  assert.deepEqual(canSendNow(ready()), { allowed: true, reason: null });
});

// ── 確認と送信のズレ ────────────────────────────────────────
test('確認したジョブと違うジョブなら送らない', () => {
  const v = verifySendPrecondition({
    preflight: buildDispatchPreflight(dispatchOk()),
    latest: dispatchOk({ jobId: 'other-job' }),
    confirmedCount: 7, typedCount: '7', campaign,
  });
  assert.deepEqual(v, { ok: false, reason: SEND_BLOCK.JOB_MISMATCH });
});

test('確認後に内容が変わっていたら送らない（人数が動いた）', () => {
  const v = verifySendPrecondition({
    preflight: buildDispatchPreflight(dispatchOk()),
    latest: dispatchOk({ willSend: 6, willSkip: 4 }),
    confirmedCount: 7, typedCount: '7', campaign,
  });
  assert.deepEqual(v, { ok: false, reason: SEND_BLOCK.STATE_CHANGED });
});

test('確認後にジョブが消えていたら送らない', () => {
  const v = verifySendPrecondition({
    preflight: buildDispatchPreflight(dispatchOk()),
    latest: { jobResults: [] },
    confirmedCount: 7, typedCount: '7', campaign,
  });
  assert.equal(v.reason, SEND_BLOCK.JOB_NOT_UNIQUE);
});

test('通常配信は送信予定人数の入力一致を必須にする', () => {
  const pf = buildDispatchPreflight(dispatchOk());
  assert.equal(verifySendPrecondition({ preflight: pf, latest: dispatchOk(), confirmedCount: 7, typedCount: '6', campaign }).reason,
    SEND_BLOCK.CONFIRM_MISMATCH);
  assert.equal(verifySendPrecondition({ preflight: pf, latest: dispatchOk(), confirmedCount: 7, typedCount: '7', campaign }).ok, true);
});

test('テスト専用は人数入力を省略できる（対象はテスト受信者のみ）', () => {
  const pf = buildDispatchPreflight(dispatchOk({ willSend: 1, willSkip: 0, total: 1 }));
  const v = verifySendPrecondition({
    preflight: pf, latest: { jobResults: [{ jobId: JOB, willSend: 1, willSkip: 0, total: 1 }] },
    confirmedCount: 1, typedCount: '', campaign: { ...campaign, testOnly: true },
  });
  assert.equal(v.ok, true);
});

// ── 最終確認の内容 ──────────────────────────────────────────
test('最終確認に必要な情報がすべて載る', () => {
  const conf = buildSendNowConfirmation({
    campaign, dryRun: { selected: 10, excluded: 3, willSend: 7 },
    preflight: buildDispatchPreflight(dispatchOk()),
    dispatchEnabled: true, sendEnabled: true, operationId: 'send-abc',
  });
  assert.equal(conf.campaignName, '期限切れカムバック');
  assert.equal(conf.version, '2');
  assert.equal(conf.kind, '通常配信');
  assert.equal(conf.audience, '実顧客');
  assert.equal(conf.selected, 10);
  assert.equal(conf.targeted, 7);
  assert.equal(conf.excluded, 3);
  assert.equal(conf.willSend, 7);
  assert.equal(conf.operationId, 'send-abc');
  assert.equal(conf.jobId, JOB);
  assert.deepEqual(conf.gate, { enqueue: true, dispatch: true });
  assert.match(conf.duplicateGuard, /DeliveryKey/);
  assert.match(conf.afterSend, /取り消せません/);
  assert.match(conf.effect, /実顧客へ実際にメールが届きます/);
  assert.equal(conf.requiresTypedCount, true);
});

test('テスト専用は「テスト受信者のみ」と明示し、実顧客と書かない', () => {
  const conf = buildSendNowConfirmation({
    campaign: { ...campaign, testOnly: true },
    dryRun: { selected: 1, excluded: 0, willSend: 1 },
    preflight: buildDispatchPreflight(dispatchOk({ willSend: 1 })),
    dispatchEnabled: true, sendEnabled: true, operationId: 'op',
  });
  assert.equal(conf.kind, '運用テスト専用');
  assert.equal(conf.audience, 'テスト受信者のみ');
  assert.equal(conf.effect.includes('実顧客'), false);
  assert.equal(conf.requiresTypedCount, false);
});

// ── 送信結果 ────────────────────────────────────────────────
test('部分成功は PARTIAL として示し、巻き戻さない・自動再送しない', () => {
  const r = summarizeSendResult({ sent: 5, failed: 2, skipped: 1, skippedByReason: { unsubscribed: 1 } },
    { completedAt: '2026-08-02T06:00:00.000Z' });
  assert.equal(r.outcome.key, 'PARTIAL');
  assert.equal(r.sent, 5);
  assert.equal(r.failed, 2);
  assert.equal(r.providerAccepted, 5);
  assert.deepEqual(r.skippedReasons, [{ reason: 'unsubscribed', count: 1 }]);
  assert.equal(r.cancelable, false);
  assert.match(r.cancelNote, /取消不可/);
  assert.match(r.partialNote, /巻き戻しません/);
  assert.equal(r.autoRetry, false);
  assert.equal(r.completedAt, '2026-08-02T06:00:00.000Z');
});

test('全滅は FAILED、成功のみは SENT', () => {
  assert.equal(classifySendOutcome({ sent: 0, failed: 3 }).key, 'FAILED');
  assert.equal(classifySendOutcome({ sent: 3, failed: 0 }).key, 'SENT');
  assert.equal(classifySendOutcome({ sent: 0, failed: 0 }).key, 'NONE');
});

test('provider 受理と実配信を混同させない注記がある', () => {
  const r = summarizeSendResult({ sent: 1 });
  assert.match(r.deliveredNote, /delivered/);
  assert.match(r.deliveredNote, /受理/);
});

// ── PII ─────────────────────────────────────────────────────
test('確認内容・結果にメールアドレスを持たせない', () => {
  const conf = buildSendNowConfirmation({
    campaign, dryRun: { selected: 1, excluded: 0, willSend: 1 },
    preflight: buildDispatchPreflight(dispatchOk({ willSend: 1 })),
    dispatchEnabled: true, sendEnabled: true, operationId: 'op',
  });
  const res = summarizeSendResult({ sent: 1, skippedByReason: { unsubscribed: 1 } });
  for (const obj of [conf, res]) {
    assert.equal(/@[a-z0-9.-]+\.[a-z]{2,}/i.test(JSON.stringify(obj)), false, 'アドレスが混ざっている');
  }
});

test('理由コードには必ず文言がある', () => {
  for (const code of Object.values(SEND_BLOCK)) {
    assert.equal(typeof SEND_BLOCK_LABEL[code], 'string', `${code} の文言が無い`);
  }
});
