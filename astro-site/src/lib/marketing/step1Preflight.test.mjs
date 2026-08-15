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

/** 候補の DeliveryKey を名指し確認した結果（重複なし） */
const okDuplicate = (over = {}) => ({
  mode: 'duplicate-check',
  sideEffects: 'none',
  campaignId: CAMPAIGN,
  version: 1,
  step: 1,
  candidates: 10,
  resolved: 10,
  unresolved: 0,
  alreadyDelivered: 0,
  byStatus: {},
  linkedJobs: 0,
  linkedJobStatus: {},
  pendingLinkedJobs: 0,
  // 配信行が欠けた orphan PENDING も見るため、ジョブ側からの突き合わせ結果を持つ
  pendingOverlap: { jobs: 0, candidates: 0, sameStep: 0, otherStep: 0, unknownStep: 0 },
  pendingCandidates: 0,
  ...over,
});

const okJobs = (over = {}) => ({
  jobs: [{ jobId: 'mkt-dormant-reactivation-v2-x-1', campaignId: 'dormant-reactivation', status: 'SENT' }],
  // 2026-08-15〜: `jobs` は新しい順に一部だけ返す。取得範囲も一緒に返る
  jobsTotal: 1,
  jobsShown: 1,
  jobsTruncated: false,
  sendEnabled: false,
  dispatchEnabled: false,
  ...over,
});

const run = (over = {}) => evaluateStep1Preflight({
  sequence: okSequence(), trialGrant: okTrialGrant(), jobs: okJobs(), duplicateCheck: okDuplicate(),
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

test('【重要】候補にその通が既に出ていたら止まる（二重案内の防止）', () => {
  const r = run({ duplicateCheck: okDuplicate({ alreadyDelivered: 3, byStatus: { queued: 3 } }) });
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((l) => l.includes('その通はまだ出ていない')), JSON.stringify(failed(r)));
});

test('【重要】過去コホートが同じ campaign で受け取り済みでも、それだけでは止めない', () => {
  // 母集団には前回の 10 名も含まれる。sentByStep が 0 でないのは**正常**
  const seq = okSequence();
  seq.summary.total = 20;
  seq.summary.sentByStep[1] = 10;
  seq.summary.byCurrentStep = { 0: 10, 1: 10 };
  seq.summary.waiting = 10;
  const r = run({ sequence: seq });
  assert.equal(r.ok, true, `過去実績だけで落ちている: ${JSON.stringify(failed(r))}`);
  const row = r.checks.find((c) => c.label.includes('受け取り済みの人数'));
  assert.ok(row, '過去実績を表に出していない');
  assert.match(row.detail, /10 名/);
});

test('【重要】実送信ゲートが開いていたら止まる（登録した瞬間に飛ぶ）', () => {
  const r = run({ jobs: okJobs({ dispatchEnabled: true }) });
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((l) => l.includes('実送信ゲート')));
});

test('【重要】同じ campaign の過去ジョブがあるだけでは止めない（次のコホートを塞がない）', () => {
  const r = run({ jobs: okJobs({ jobs: [{ jobId: 'mkt-x', campaignId: CAMPAIGN, status: 'SENT' }] }) });
  assert.equal(r.ok, true, `過去ジョブだけで落ちている: ${JSON.stringify(failed(r))}`);
  const row = r.checks.find((c) => c.label.includes('過去ジョブ'));
  assert.equal(row.severity, SEVERITY.INFO, '過去ジョブを critical にしている');
});

test('【重要】候補が送信待ちのジョブに載っていたら止まる（orphan PENDING の検知）', () => {
  const r = run({
    duplicateCheck: okDuplicate({
      linkedJobs: 1, linkedJobStatus: { PENDING: 1 }, pendingLinkedJobs: 1,
      pendingOverlap: { jobs: 1, candidates: 10, sameStep: 1, otherStep: 0, unknownStep: 0 },
      pendingCandidates: 10,
    }),
  });
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((l) => l.includes('送信待ちのジョブに載っていない')));
});

test('PENDING が残っていることは表に出すが、それだけでは止めない', () => {
  const r = run({ jobs: okJobs({ jobs: [{ jobId: 'mkt-z', campaignId: 'dormant-reactivation', status: 'PENDING' }] }) });
  assert.equal(r.ok, true, `落ちた項目: ${JSON.stringify(failed(r))}`);
  const row = r.checks.find((c) => c.label.includes('PENDING が無い'));
  assert.equal(row.ok, false, '見えないまま通している');
  assert.equal(row.severity, SEVERITY.INFO);
  assert.match(row.detail, /一緒に飛ぶ/);
});

test('【重要】人数が事前合意と違えば止まる（増えていても止める）', () => {
  for (const n of [9, 11]) {
    const seq = okSequence();
    seq.next.recipients = n;
    seq.next.recordIds = Array.from({ length: n }, (_, i) => `rec${i}`);
    seq.summary.due = n; seq.summary.dueByStep[1] = n;
    const tg = okTrialGrant(); tg.barrier.outstandingStep1 = n;
    const r = run({ sequence: seq, trialGrant: tg, duplicateCheck: okDuplicate({ candidates: n, resolved: n }) });
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
  for (const key of ['sequence', 'trialGrant', 'jobs', 'duplicateCheck']) {
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
  seq.next.recipients = 0; seq.next.recordIds = []; seq.summary.due = 0; seq.summary.dueByStep[1] = 0;
  const tg = okTrialGrant(); tg.barrier.outstandingStep1 = 0;
  const r = run({ sequence: seq, trialGrant: tg, duplicateCheck: null, expectRecipients: null });
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

// ══════════════════════════════════════════════════════════════
//  重複判定は campaign 単位ではなく **cohort 単位**（2026-08-15 設計是正）
//
//  「この campaign のジョブが 1 つでもあれば止める」は、1 回でも Step1 を
//  流したら二度と通らない。コホートは何度も来るので、それでは 2 回目以降を
//  永久に承認できない。見るのは候補ごとの DeliveryKey
//  （campaign × version × step × 受信者 = 不変キー）。
//  `jobs` の 30 件窓からは「無い」を推測しない。
// ══════════════════════════════════════════════════════════════

/** 本番同等: 過去コホートの SENT ジョブが多数あり、一覧は窓で切られている */
const productionLikeJobs = (over = {}) => okJobs({
  jobs: [
    { jobId: 'mkt-dormant-reactivation-v2-a-1', campaignId: 'dormant-reactivation', status: 'SENT' },
    { jobId: 'mkt-light-trial-to-premium-sequence-v1-af3acf8c-1', campaignId: CAMPAIGN, status: 'SENT' },
  ],
  jobsTotal: 152,
  jobsShown: 30,
  jobsTruncated: true,
  ...over,
});

test('【重要】一覧が窓で切られていても、候補の重複は DeliveryKey で判定できるので通る', () => {
  const r = run({ jobs: productionLikeJobs() });
  assert.equal(r.ok, true, `窓の推測で落ちている: ${JSON.stringify(failed(r))}`);
});

test('取得範囲は参考として必ず表に出す（重複判定には使わない）', () => {
  const r = run({ jobs: productionLikeJobs() });
  const row = r.checks.find((c) => c.label.includes('ジョブ一覧の取得範囲'));
  assert.ok(row, '取得範囲を出していない');
  assert.equal(row.severity, SEVERITY.INFO);
  assert.match(row.detail, /30 \/ 152 件/);
  assert.match(row.detail, /一部のみ/);
  assert.match(row.label, /重複判定には使わない/);
});

test('【重要】重複判定を取れなければ ok にしない（窓の推測で代用しない）', () => {
  const r = run({ jobs: productionLikeJobs(), duplicateCheck: null });
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((l) => l.includes('重複確認')));
});

test('【重要】重複確認が別のキャンペーン / 別ステップを見ていたら止まる', () => {
  assert.equal(run({ duplicateCheck: okDuplicate({ campaignId: 'other' }) }).ok, false);
  assert.equal(run({ duplicateCheck: okDuplicate({ step: 2 }) }).ok, false);
});

test('【重要】鍵を作れなかった候補があれば止まる（不明を安全と読まない）', () => {
  const r = run({ duplicateCheck: okDuplicate({ resolved: 8, unresolved: 2 }) });
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((l) => l.includes('全候補の重複を判定できた')));
});

test('【重要】重複確認の対象数が送信対象数と違えば止まる', () => {
  const r = run({ duplicateCheck: okDuplicate({ candidates: 9, resolved: 9 }) });
  assert.equal(r.ok, false);
  assert.ok(failed(r).some((l) => l.includes('重複確認の対象数')));
});

test('【重要】書き込み経路の応答を重複確認に取り違えたら止まる', () => {
  const r = run({ duplicateCheck: okDuplicate({ sideEffects: 'queued' }) });
  assert.equal(r.ok, false);
});

// ══════════════════════════════════════════════════════════════
//  実運用の 2 局面（本番同等の条件で固定）
//    A. いまの 10 名（2026-08-14 に queue 登録済み）→ **必ず止まる**
//    B. 次のコホート（未 queue・100 名）→ **通る**
//  preflight は 1 回きりの道具ではなく、次の Step1 でも使う安全装置。
// ══════════════════════════════════════════════════════════════

/** 2026-08-15 の本番実測そのもの（10 名は既に queued / 一覧は 152 件中 30 件） */
const queuedState = () => {
  const seq = okSequence();
  seq.next = { step: null, recipients: 0, truncated: false, cap: 500, recordIds: [] };
  seq.summary = {
    total: 10, due: 0, waiting: 10, completed: 0, stopped: 0,
    byStopReason: {}, dueByStep: { 1: 0, 2: 0, 3: 0, 4: 0 },
    sentByStep: { 1: 10, 2: 0, 3: 0, 4: 0 }, byCurrentStep: { 1: 10 }, balanced: true,
  };
  const tg = okTrialGrant();
  tg.barrier = { granted: 10, outstandingStep1: 0, resolved: 10, nextBatchAllowed: true, byReason: {} };
  return {
    sequence: seq,
    trialGrant: tg,
    jobs: productionLikeJobs({
      jobs: [{ jobId: 'mkt-light-trial-to-premium-sequence-v1-af3acf8c-1', campaignId: CAMPAIGN, status: 'PENDING' }],
    }),
    // 候補が 0 名なので重複確認は呼べない（呼んでも判定できない）
    duplicateCheck: null,
  };
};

test('【重要】いまの 10 名（queue 済み）で走らせたら止まる', () => {
  const r = run({ ...queuedState(), expectRecipients: 10 });
  assert.equal(r.ok, false, '既に queue 済みなのに通している');
  const labels = failed(r);
  assert.ok(labels.some((l) => l.includes('Step1')), '次が Step1 でないことを見ていない');
  assert.ok(labels.some((l) => l.includes('対象が 1 名以上')), '対象 0 名を見ていない');
});

test('【重要】同じ 10 名を無理に候補へ入れても、重複確認が止める', () => {
  // 「次は step2」なのに step1 を流そうとした場合でも、鍵の重複で必ず落ちる
  const st = queuedState();
  st.sequence.next = {
    step: 1, recipients: 10, truncated: false, cap: 500,
    recordIds: Array.from({ length: 10 }, (_, i) => `rec${i}`),
  };
  st.sequence.summary.dueByStep[1] = 10;
  st.trialGrant.barrier.outstandingStep1 = 10;
  const r = run({
    ...st,
    duplicateCheck: okDuplicate({
      alreadyDelivered: 10, byStatus: { queued: 10 },
      linkedJobs: 1, linkedJobStatus: { PENDING: 1 }, pendingLinkedJobs: 1,
      pendingOverlap: { jobs: 1, candidates: 10, sameStep: 1, otherStep: 0, unknownStep: 0 },
      pendingCandidates: 10,
    }),
    expectRecipients: 10,
  });
  assert.equal(r.ok, false);
  const labels = failed(r);
  assert.ok(labels.some((l) => l.includes('その通はまだ出ていない')), '鍵の重複を見ていない');
  assert.ok(labels.some((l) => l.includes('送信待ちのジョブ')), '送信待ちジョブを見ていない');
});

/** 次のコホート（100 名・まだ 1 通も出していない）。**本番同等の周辺状態**を与える */
const freshCohort = (n = 100) => {
  const seq = okSequence();
  seq.next = {
    step: 1, recipients: n, truncated: false, cap: 500,
    recordIds: Array.from({ length: n }, (_, i) => `recNEW${i}`),
  };
  seq.summary = {
    // 母集団には**前回の 10 名も含まれる**（既に Step1 受領済み）
    total: n + 10, due: n, waiting: 10, completed: 0, stopped: 0,
    byStopReason: {}, dueByStep: { 1: n, 2: 0, 3: 0, 4: 0 },
    sentByStep: { 1: 10, 2: 0, 3: 0, 4: 0 }, byCurrentStep: { 0: n, 1: 10 }, balanced: true,
  };
  seq.engagement = { applied: true, blocked: 0, counts: { unknown: n } };
  const tg = okTrialGrant();
  tg.barrier = { granted: n, outstandingStep1: n, resolved: 0, nextBatchAllowed: false, byReason: {} };
  return {
    sequence: seq,
    trialGrant: tg,
    // 過去コホートの SENT ジョブがあり、一覧は 152 件中 30 件しか見えない
    jobs: productionLikeJobs(),
    duplicateCheck: okDuplicate({ candidates: n, resolved: n }),
  };
};

test('【重要】次の未 queue コホートは、過去ジョブ有り・窓切れでも通る', () => {
  const r = run({ ...freshCohort(100), expectRecipients: 100 });
  assert.equal(r.ok, true, `落ちた項目: ${JSON.stringify(failed(r))}`);
  assert.equal(r.plan.step, 1);
  assert.equal(r.plan.recipients, 100);
  // 100 名 = 1 ジョブ（1 ジョブ最大 100 宛先）
  assert.equal(r.plan.writes.scheduledEmails.rows, 1);
  assert.equal(r.plan.writes.campaignDeliveries.rows, 100);
  assert.equal(r.plan.writes.customers.rows, 0);
});

test('【重要】次のコホートでも、一部にでも鍵があれば止まる', () => {
  const st = freshCohort(100);
  const r = run({
    ...st,
    duplicateCheck: okDuplicate({ candidates: 100, resolved: 100, alreadyDelivered: 1, byStatus: { sent: 1 } }),
    expectRecipients: 100,
  });
  assert.equal(r.ok, false, '1 名でも重複していたら押してはいけない');
});

test('次のコホートでもゲート・関所の条件は同じように効く', () => {
  const st = freshCohort(100);
  assert.equal(run({ ...st, jobs: productionLikeJobs({ dispatchEnabled: true }), expectRecipients: 100 }).ok, false);
  const c = { ...st, trialGrant: { ...st.trialGrant, barrier: { ...st.trialGrant.barrier, outstandingStep1: 42 } } };
  assert.equal(run({ ...c, expectRecipients: 100 }).ok, false);
});

test('【重要】配信行が無い orphan PENDING でも止まる（ジョブ側の Recipients で検知）', () => {
  // CampaignDeliveries は空（alreadyDelivered=0 / linkedJobs=0）なのに、
  // 送信待ちジョブの宛先に候補が載っている = 本当の orphan
  const r = run({
    duplicateCheck: okDuplicate({
      alreadyDelivered: 0, byStatus: {}, linkedJobs: 0, linkedJobStatus: {}, pendingLinkedJobs: 0,
      pendingOverlap: { jobs: 1, candidates: 4, sameStep: 1, otherStep: 0, unknownStep: 0 },
      pendingCandidates: 4,
    }),
  });
  assert.equal(r.ok, false, '配信行が無い orphan PENDING を見逃している');
  const row = r.failures.find((f) => f.label.includes('配信行が無い場合も含む'));
  assert.ok(row, JSON.stringify(failed(r)));
  assert.match(row.detail, /候補=4 名/);
});

test('【重要】orphan 判定が取れないときは ok にしない', () => {
  const r = run({ duplicateCheck: okDuplicate({ pendingCandidates: null }) });
  assert.equal(r.ok, false, '不明を安全と読んでいる');
});
