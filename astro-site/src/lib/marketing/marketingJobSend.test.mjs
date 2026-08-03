/**
 * marketingJobSend.test.mjs
 *   node --test src/lib/marketing/marketingJobSend.test.mjs
 *
 * 送信は取り消せない。**確認していない / 別のジョブ / 人数が違う**ときに
 * 押せてしまわないことを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  JOB_SEND_BLOCK, JOB_SEND_BLOCK_LABEL, SENDABLE_STATUS,
  buildJobPreflight, canSendJob, verifyJobSendPrecondition,
  buildJobSendConfirmation, summarizeJobSendResult,
} from './marketingJobSend.js';

const JOB = 'mkt-comeback-light-30d-granted-v2-d9678b3d-1';
const OTHER = 'mkt-other-v2-aaaaaaaa-1';

const row = (over = {}) => ({
  jobId: JOB, campaignId: 'comeback-light-30d-granted', version: '2',
  shellVersion: 1, contentHash: '23e4b66cba22', status: 'PENDING',
  queued: 28, total: 28, willSend: 26, willSkip: 2, alreadySent: 0,
  skipByReason: { unsubscribed: 1, provider_suppressed: 1 },
  ...over,
});
const result = (rows, over = {}) => ({
  mode: 'dry-run', jobResults: rows,
  providerSuppression: { available: true, total: 61 },
  ...over,
});

// ── 確認結果の取り出し ──────────────────────────────────────────

test('指定したジョブの確認結果を取り出す', () => {
  const pf = buildJobPreflight(result([row(), row({ jobId: OTHER })]), JOB);
  assert.equal(pf.ok, true);
  assert.equal(pf.jobId, JOB);
  assert.equal(pf.willSend, 26);
  assert.equal(pf.willSkip, 2);
  assert.equal(pf.queued, 28);
  assert.equal(pf.campaignId, 'comeback-light-30d-granted');
  assert.equal(pf.version, '2');
  assert.equal(pf.shellVersion, 1);
  assert.equal(pf.contentHash, '23e4b66cba22');
  assert.deepEqual(pf.skipByReason, { unsubscribed: 1, provider_suppressed: 1 });
});

test('該当ジョブが無い / 重複していれば送らせない', () => {
  assert.equal(buildJobPreflight(result([row({ jobId: OTHER })]), JOB).reason, JOB_SEND_BLOCK.JOB_MISMATCH);
  assert.equal(buildJobPreflight(result([row(), row()]), JOB).reason, JOB_SEND_BLOCK.JOB_MISMATCH);
  assert.equal(buildJobPreflight(result([]), JOB).reason, JOB_SEND_BLOCK.JOB_MISMATCH);
  assert.equal(buildJobPreflight(result([row()]), '').reason, JOB_SEND_BLOCK.JOB_MISMATCH);
  assert.equal(buildJobPreflight(null, JOB).reason, JOB_SEND_BLOCK.JOB_MISMATCH);
});

test('版が合わないジョブは送らせない（fail closed）', () => {
  const pf = buildJobPreflight(result([{
    jobId: JOB, blocked: 'shell_version_mismatch',
    jobShellVersion: 0, expectedShellVersion: 1, note: '別の組み立て方で作られています',
    willSend: 0, willSkip: 28, total: 28,
  }]), JOB);
  assert.equal(pf.ok, false);
  assert.equal(pf.reason, JOB_SEND_BLOCK.BLOCKED);
  assert.equal(pf.jobShellVersion, 0);
  assert.equal(pf.expectedShellVersion, 1);
});

test('送信対象 0 名なら送らせない', () => {
  const pf = buildJobPreflight(result([row({ willSend: 0, willSkip: 28 })]), JOB);
  assert.equal(pf.ok, false);
  assert.equal(pf.reason, JOB_SEND_BLOCK.NO_RECIPIENTS);
});

// ── 押せるかどうか ──────────────────────────────────────────────

const okPf = () => buildJobPreflight(result([row()]), JOB);
const base = (over = {}) => ({
  busy: false, dispatchEnabled: true, status: 'PENDING', preflight: okPf(), sent: false, ...over,
});

test('確認済み・PENDING・gate 有効なら押せる', () => {
  assert.equal(canSendJob(base()).allowed, true);
});

test('確認していなければ押せない', () => {
  assert.equal(canSendJob(base({ preflight: null })).reason, JOB_SEND_BLOCK.NO_CHECK);
});

test('送信済み / 失敗 / 取消済みのジョブは押せない', () => {
  for (const st of ['SENT', 'FAILED', 'CANCELLED', '']) {
    assert.equal(canSendJob(base({ status: st })).reason, JOB_SEND_BLOCK.NOT_PENDING, `${st} で押せてしまう`);
  }
  assert.equal(SENDABLE_STATUS, 'PENDING');
});

test('gate が閉じていれば押せない', () => {
  assert.equal(canSendJob(base({ dispatchEnabled: false })).reason, JOB_SEND_BLOCK.GATE_CLOSED);
});

test('実行中は押せない（二重クリック防止）', () => {
  assert.equal(canSendJob(base({ busy: true })).reason, JOB_SEND_BLOCK.BUSY);
});

test('このカードから送信済みなら再送できない', () => {
  assert.equal(canSendJob(base({ sent: true })).reason, JOB_SEND_BLOCK.ALREADY_SENT);
});

test('確認結果が NG のときはその理由で止まる', () => {
  const ng = buildJobPreflight(result([row({ willSend: 0 })]), JOB);
  assert.equal(canSendJob(base({ preflight: ng })).reason, JOB_SEND_BLOCK.NO_RECIPIENTS);
});

// ── 送信直前の照合 ──────────────────────────────────────────────

test('人数の入力が一致しなければ送らない', () => {
  const pf = okPf();
  assert.equal(
    verifyJobSendPrecondition({ preflight: pf, latest: result([row()]), typedCount: '25' }).reason,
    JOB_SEND_BLOCK.CONFIRM_MISMATCH,
  );
  assert.equal(
    verifyJobSendPrecondition({ preflight: pf, latest: result([row()]), typedCount: '' }).reason,
    JOB_SEND_BLOCK.CONFIRM_MISMATCH,
  );
});

test('確認後に対象が変わっていたら送らない', () => {
  const pf = okPf();
  // 直前に取り直したら 26 → 24 名に減っていた
  const later = result([row({ willSend: 24, willSkip: 4 })]);
  assert.equal(
    verifyJobSendPrecondition({ preflight: pf, latest: later, typedCount: '26' }).reason,
    JOB_SEND_BLOCK.CHECK_STALE,
  );
});

test('確認後に内容 hash / 版が変わっていたら送らない', () => {
  const pf = okPf();
  for (const changed of [{ contentHash: 'ffffffffffff' }, { shellVersion: 2 }]) {
    assert.equal(
      verifyJobSendPrecondition({ preflight: pf, latest: result([row(changed)]), typedCount: '26' }).reason,
      JOB_SEND_BLOCK.CHECK_STALE,
      `${JSON.stringify(changed)} で通ってしまう`,
    );
  }
});

test('直前の確認で別ジョブになっていたら送らない', () => {
  const pf = okPf();
  assert.equal(
    verifyJobSendPrecondition({ preflight: pf, latest: result([row({ jobId: OTHER })]), typedCount: '26' }).reason,
    JOB_SEND_BLOCK.JOB_MISMATCH,
  );
});

test('すべて一致していれば通る', () => {
  const pf = okPf();
  const v = verifyJobSendPrecondition({ preflight: pf, latest: result([row()]), typedCount: '26' });
  assert.equal(v.ok, true);
  assert.equal(v.jobId, JOB);
  assert.equal(v.willSend, 26);
});

test('確認していなければ照合そのものが通らない', () => {
  assert.equal(verifyJobSendPrecondition({ preflight: null, latest: result([row()]), typedCount: '26' }).reason,
    JOB_SEND_BLOCK.NO_CHECK);
  assert.equal(verifyJobSendPrecondition({}).reason, JOB_SEND_BLOCK.NO_CHECK);
});

// ── 確認ダイアログ ──────────────────────────────────────────────

test('確認ダイアログに何が起きるかを全部出す', () => {
  const c = buildJobSendConfirmation({ preflight: okPf(), operationId: 'jobsend-x-1' });
  assert.equal(c.jobId, JOB);
  assert.equal(c.campaign, 'comeback-light-30d-granted v2');
  assert.equal(c.willSend, 26);
  assert.equal(c.willSkip, 2);
  assert.equal(c.contentHash, '23e4b66cba22');
  assert.equal(c.shellVersion, 1);
  assert.match(c.effect, /取り消せません/);
  assert.match(c.reverify, /1 通ずつ/);
  assert.match(c.failClosed, /1 通も送りません/);
  assert.match(c.afterSend, /再送できません/);
});

// ── 結果のまとめ ────────────────────────────────────────────────

test('部分失敗を成功と読ませない', () => {
  const r = summarizeJobSendResult({ sent: 20, failed: 6, skipped: 2, jobResults: [row()] }, JOB);
  assert.equal(r.outcome, 'PARTIAL');
  assert.match(r.note, /自動で再送しません/);
});

test('全件送信 / 全件失敗 / 対象なしを区別する', () => {
  assert.equal(summarizeJobSendResult({ sent: 26, failed: 0, skipped: 2, jobResults: [row()] }, JOB).outcome, 'SENT');
  assert.equal(summarizeJobSendResult({ sent: 0, failed: 26, skipped: 0, jobResults: [row()] }, JOB).outcome, 'FAILED');
  assert.equal(summarizeJobSendResult({ sent: 0, failed: 0, skipped: 28, jobResults: [row()] }, JOB).outcome, 'NONE');
});

test('受理と実配信を混同させない注記がある', () => {
  const r = summarizeJobSendResult({ sent: 26, failed: 0, skipped: 2, jobResults: [row()] }, JOB);
  assert.match(r.note, /配信基盤が受理した状態/);
});

test('すべての理由コードに文言がある', () => {
  for (const code of Object.values(JOB_SEND_BLOCK)) {
    assert.ok(JOB_SEND_BLOCK_LABEL[code], `${code} の文言が無い`);
  }
});
