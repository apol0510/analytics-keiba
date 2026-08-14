/**
 * step1Preflight.test.mjs — Step1 キュー登録の直前確認
 *   node --test src/lib/marketing/step1Preflight.test.mjs
 *
 * 守る性質:
 *   - **確認できないものを ok にしない**（応答欠損・不明値は critical で落ちる）
 *   - Step1 が既に出ている / キューが汚れている / 実送信が開いている 場合は必ず止まる
 *   - 「押したら何が増えるか」を件数で説明でき、Customers は 0 のまま
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluateStep1Preflight, describeStep1Writes, readStep1Gates, resolveStep1Stage,
  STEP1_STAGE, SEVERITY,
} from './step1Preflight.js';

const CAMPAIGN = 'light-trial-to-premium-sequence';

/** 2026-08-15 の本番実測をそのまま形にした「通るはずの入力」 */
const okSequence = () => ({
  mode: 'sequence-status',
  sideEffects: 'none',
  campaignId: CAMPAIGN,
  version: 1,
  enabled: true,
  auto: { enabled: false, missing: ['MARKETING_SEQUENCE_SCHEDULER_ENABLED'] },
  maxSends: 4,
  next: { step: 1, recipients: 10, truncated: false, cap: 500, recordIds: Array.from({ length: 10 }, (_, i) => `rec${i}`) },
  summary: {
    total: 10, due: 10, waiting: 0, completed: 0, stopped: 0,
    byStopReason: {}, dueByStep: { 1: 10 }, sentByStep: { 1: 0, 2: 0, 3: 0, 4: 0 },
    byCurrentStep: { 0: 10 }, balanced: true,
  },
  engagement: { applied: true, blocked: 0, counts: { unknown: 10 } },
  providerSuppression: { available: true, error: null, total: 405 },
});

const okTrialGrant = () => ({
  mode: 'trial-grant-preview',
  sideEffects: 'none',
  barrier: { granted: 10, outstandingStep1: 10, resolved: 0, nextBatchAllowed: false, byReason: {} },
  abort: 'waiting_for_step1',
});

const okJobs = (over = {}) => ({
  jobs: [{ jobId: 'mkt-dormant-reactivation-v2-x-1', campaignId: 'dormant-reactivation', status: 'SENT' }],
  sendEnabled: false,
  dispatchEnabled: false,
  ...over,
});

const run = (over = {}) => evaluateStep1Preflight({
  sequence: okSequence(), trialGrant: okTrialGrant(), jobs: okJobs(),
  campaignId: CAMPAIGN, expectRecipients: 10, stage: STEP1_STAGE.PRE,
  ...over,
});

const failed = (r) => r.failures.map((f) => f.label);

// ── 通る場合 ────────────────────────────────────────────────

test('本番実測どおりの状態なら ok（10 名・Step1・両ゲート閉）', () => {
  const r = run();
  assert.equal(r.ok, true, `落ちた項目: ${JSON.stringify(failed(r))}`);
  assert.equal(r.plan.step, 1);
  assert.equal(r.plan.recipients, 10);
  assert.equal(r.stage, STEP1_STAGE.PRE);
});

test('押したときに増える行を件数で説明できる（Customers は 0）', () => {
  const w = run().plan.writes;
  assert.equal(w.scheduledEmails.rows, 1);      // 10 名 → 1 ジョブ
  assert.equal(w.scheduledEmails.status, 'PENDING');
  assert.equal(w.campaignDeliveries.rows, 10);
  assert.equal(w.campaignDeliveries.status, 'queued');
  assert.equal(w.customers.rows, 0, '送信側が Customers を書くことになっている');
});

test('ジョブ分割は送信側の単位に従う（101 名なら 2 ジョブ）', () => {
  assert.equal(describeStep1Writes({ recipients: 100 }).scheduledEmails.rows, 1);
  assert.equal(describeStep1Writes({ recipients: 101 }).scheduledEmails.rows, 2);
  assert.equal(describeStep1Writes({ recipients: 0 }).scheduledEmails.rows, 0);
  assert.equal(describeStep1Writes({ recipients: null }).scheduledEmails.rows, null);
});

// ── 止まるべき場合（ここが本体）──────────────────────────────

test('【重要】Step1 が既に出ていたら止まる（二重案内の防止）', () => {
  const seq = okSequence();
  seq.summary.sentByStep[1] = 3;
  const r = run({ sequence: seq });
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((l) => l.includes('既送信')), JSON.stringify(failed(r)));
});

test('【重要】実送信ゲートが開いていたら止まる（登録した瞬間に飛ぶ）', () => {
  const r = run({ jobs: okJobs({ dispatchEnabled: true }) });
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((l) => l.includes('実送信ゲート')));
});

test('【重要】同じキャンペーンのジョブが既にあれば止まる', () => {
  const r = run({ jobs: okJobs({ jobs: [{ jobId: 'mkt-x', campaignId: CAMPAIGN, status: 'SENT' }] }) });
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((l) => l.includes('既存ジョブ')));
});

test('【重要】PENDING が残っていれば止まる', () => {
  const r = run({ jobs: okJobs({ jobs: [{ jobId: 'mkt-y', campaignId: CAMPAIGN, status: 'PENDING' }] }) });
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((l) => l.includes('PENDING')));
});

test('他キャンペーンの PENDING は止めないが必ず表に出す', () => {
  const r = run({ jobs: okJobs({ jobs: [{ jobId: 'mkt-z', campaignId: 'dormant-reactivation', status: 'PENDING' }] }) });
  assert.equal(r.ok, true, `落ちた項目: ${JSON.stringify(failed(r))}`);
  const row = r.checks.find((c) => c.label.includes('他キャンペーン由来'));
  assert.equal(row.ok, false, '見えないまま通している');
  assert.equal(row.severity, SEVERITY.INFO);
  assert.match(row.detail, /一緒に飛ぶ/);
});

test('【重要】人数が事前合意と違えば止まる（増えていても止める）', () => {
  for (const n of [9, 11]) {
    const seq = okSequence();
    seq.next.recipients = n;
    seq.next.recordIds = Array.from({ length: n }, (_, i) => `rec${i}`);
    seq.summary.due = n;
    const tg = okTrialGrant(); tg.barrier.outstandingStep1 = n;
    const r = run({ sequence: seq, trialGrant: tg });
    assert.equal(r.ok, false, `${n} 名で通ってしまった`);
    assert.ok(failed(r).some((l) => l.includes('事前合意')));
  }
});

test('【重要】関所の未処理件数と対象数がズレたら止まる', () => {
  const tg = okTrialGrant();
  tg.barrier.outstandingStep1 = 2; // 4,000 件打ち切り事故と同じ形（一部しか見えていない）
  const r = run({ trialGrant: tg });
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((l) => l.includes('関所')));
});

test('【重要】上限で切り捨てられていたら止まる', () => {
  const seq = okSequence();
  seq.next.truncated = true;
  const r = run({ sequence: seq });
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((l) => l.includes('切り捨て')));
});

test('【重要】recordId の数と人数が食い違えば止まる', () => {
  const seq = okSequence();
  seq.next.recordIds = ['rec0', 'rec1'];
  const r = run({ sequence: seq });
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((l) => l.includes('recordId')));
});

test('【重要】Step2 以降が次に来ていたら止まる（Step1 の承認で別の文面を送らない）', () => {
  const seq = okSequence();
  seq.next.step = 2;
  const r = run({ sequence: seq });
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((l) => l.includes('Step1')));
});

test('【重要】自動配信が動いていたら止まる', () => {
  const seq = okSequence();
  seq.auto.enabled = true;
  const r = run({ sequence: seq });
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((l) => l.includes('自動配信')));
});

test('【重要】配信基盤の停止リストを確認できなければ止まる（fail closed）', () => {
  const seq = okSequence();
  seq.providerSuppression = { available: false, error: 'timeout' };
  const r = run({ sequence: seq });
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((l) => l.includes('停止リスト')));
});

test('【重要】検算が合わない進行は通さない', () => {
  const seq = okSequence();
  seq.summary.balanced = false;
  const r = run({ sequence: seq });
  assert.equal(r.ok, false);
});

test('【重要】応答が欠けていれば ok にしない（沈黙を成功にしない）', () => {
  for (const key of ['sequence', 'trialGrant', 'jobs']) {
    const r = run({ [key]: null });
    assert.equal(r.ok, false, `${key} が無くても通っている`);
    assert.ok(r.failures.length > 0);
  }
});

test('【重要】書き込みを伴うアクションの応答を取り違えたら止まる', () => {
  const seq = okSequence();
  seq.sideEffects = 'queued';   // 誤って send を叩いた形
  seq.mode = 'queued';
  const r = run({ sequence: seq });
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((l) => l.includes('副作用なし')));
});

test('対象 0 名なら止まる（押す意味が無い）', () => {
  const seq = okSequence();
  seq.next.recipients = 0; seq.next.recordIds = []; seq.summary.due = 0;
  const tg = okTrialGrant(); tg.barrier.outstandingStep1 = 0;
  const r = run({ sequence: seq, trialGrant: tg, expectRecipients: null });
  assert.equal(r.ok, false);
});

// ── 段階（gate をどこまで開けたか）────────────────────────────

test('段階ごとにキュー登録ゲートの期待値が変わる（実送信は常に閉）', () => {
  // pre: まだ閉じているべき
  assert.equal(run({ stage: STEP1_STAGE.PRE }).ok, true);
  assert.equal(run({ stage: STEP1_STAGE.PRE, jobs: okJobs({ sendEnabled: true }) }).ok, false);
  // enqueue: 開いているべき（開けた直後の再確認）
  assert.equal(run({ stage: STEP1_STAGE.ENQUEUE, jobs: okJobs({ sendEnabled: true }) }).ok, true);
  assert.equal(run({ stage: STEP1_STAGE.ENQUEUE }).ok, false);
  // どちらの段階でも実送信が開いていたら不可
  assert.equal(run({ stage: STEP1_STAGE.ENQUEUE, jobs: okJobs({ sendEnabled: true, dispatchEnabled: true }) }).ok, false);
});

test('gate は真偽値だけを返す（値を持ち回らない）', () => {
  const g = readStep1Gates({ MARKETING_CAMPAIGN_ENABLED: 'true', MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'false' });
  assert.deepEqual(g, { enqueue: true, dispatch: false });
  assert.deepEqual(readStep1Gates({}), { enqueue: false, dispatch: false });
  // 'true' 以外は全部 OFF（'1' / 'yes' を有効にしない）
  for (const v of ['1', 'yes', 'TRUE', ' true']) {
    assert.equal(readStep1Gates({ MARKETING_CAMPAIGN_ENABLED: v }).enqueue, v === ' true');
  }
});

test('段階は gate から自動判定し、明示指定を優先する', () => {
  assert.equal(resolveStep1Stage({}), STEP1_STAGE.PRE);
  assert.equal(resolveStep1Stage({ MARKETING_CAMPAIGN_ENABLED: 'true' }), STEP1_STAGE.ENQUEUE);
  assert.equal(resolveStep1Stage({ STEP1_STAGE: 'pre', MARKETING_CAMPAIGN_ENABLED: 'true' }), STEP1_STAGE.PRE);
  assert.equal(resolveStep1Stage({ STEP1_STAGE: 'でたらめ' }), STEP1_STAGE.PRE);
});

// ── 出力に個人情報を入れない ──────────────────────────────────

test('判定結果にアドレス・recordId を含めない', () => {
  const dump = JSON.stringify(run());
  assert.equal(dump.includes('@'), false, 'アドレスが出ている');
  assert.equal(/rec\d/.test(dump), false, 'recordId が出ている');
});
