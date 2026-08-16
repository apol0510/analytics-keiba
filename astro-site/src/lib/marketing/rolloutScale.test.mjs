/**
 * rolloutScale.test.mjs — 14,500 名規模でも計算が打ち切られないこと
 *   node --test src/lib/marketing/rolloutScale.test.mjs
 *
 * ── なぜ規模のテストが要るか ────────────────────────────────
 * 本番で繰り返し起きた事故は「**大きくなった瞬間に黙って打ち切る**」形だった:
 *   - Customers 15,962 件 → 先頭 4,000 件で打ち切り、8 名へ案内が飛ばなかった
 *   - CampaignDeliveries 14,426 行 → 4,000 行で打ち切り、進行表示が過少
 * どちらも「小さいうちは正しく動く」ので、小さい fixture では捕まらない。
 * ここでは**本番と同じ桁**の入力を作って、計算が最後まで走ることを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planRolloutTick, applyRolloutRun, defaultRolloutState, ROLLOUT_STAGE, estimateRemainingDays } from './rolloutPlan.js';
import { buildFunnel, buildStepView, classifyMember } from './rolloutView.js';
import { decideNext, NEXT_ACTION, STOP_REASON } from './sequencePolicy.js';
import { createSendBudget, summarizeSendRun, estimateChunkSize } from './sendBudget.js';

const NOW = Date.parse('2026-08-16T00:00:00Z');
const DAY = 24 * 3600_000;
/** 本番のコホート実測（2026-08-15） */
const COHORT = 14_489;

/** 本番相当の母集団を作る（購入・停止・進行中を混ぜる） */
function makeCohort(n) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const mod = i % 100;
    if (mod < 60) rows.push({ sentCount: 0 });                                   // 未開始 60%
    else if (mod < 85) rows.push({ sentCount: (i % 20) + 1 });                    // 進行中 25%
    else if (mod < 90) rows.push({ sentCount: 5, purchased: true });              // 購入 5%
    else if (mod < 95) rows.push({ sentCount: 2, stopped: true, stopReason: 'unsubscribed' });
    else rows.push({ sentCount: 24 });                                            // 完了 5%
  }
  return rows;
}

test('【重要】14,489 名の分類が打ち切られない（合計が母数と一致）', () => {
  const rows = makeCohort(COHORT);
  const f = buildFunnel({ rows, maxSends: 24, cohortTotal: COHORT });
  assert.equal(f.observed, COHORT);
  const sum = Object.values(f.counts).reduce((a, b) => a + b, 0);
  assert.equal(sum, COHORT, `分類の合計が ${sum}（母数 ${COHORT}）`);
  assert.equal(f.balanced, true);
  assert.equal(f.partial, false);
});

test('【重要】14,489 名の Step 別集計が打ち切られない', () => {
  const rows = Array.from({ length: COHORT }, (_, i) => ({
    sentSteps: Array.from({ length: i % 25 }, (_, k) => k + 1),
    dueStep: (i % 25) + 1,
    openedSteps: i % 3 === 0 ? [1] : [],
    clickedSteps: i % 7 === 0 ? [1] : [],
  }));
  const steps = Array.from({ length: 24 }, (_, i) => i + 1);
  const v = buildStepView({ steps, rows });
  assert.equal(v.length, 24);
  // Step1 は「1 通以上送った人」全員が持つ
  const expectedStep1 = rows.filter((r) => r.sentSteps.includes(1)).length;
  assert.equal(v[0].sent, expectedStep1);
  assert.ok(expectedStep1 > 10_000, `Step1 の母数が ${expectedStep1}（打ち切られている）`);
});

test('【重要】100 / 500 / 1000 名のチャンクで進行しても総数が合う', () => {
  for (const daily of [100, 500, 1000]) {
    let state = { ...defaultRolloutState(), stage: ROLLOUT_STAGE.STEADY, alwaysArmed: true, dailyLimit: daily };
    let remaining = COHORT;
    let day = 0;
    let granted = 0;
    while (remaining > 0 && day < 1000) {
      const nowMs = NOW + day * DAY;
      const plan = planRolloutTick({
        state, nowMs, remainingCandidates: remaining, previousOutstanding: 0, envEnabled: true,
      });
      assert.equal(plan.ok, true, `${daily}/日 の ${day} 日目で止まった: ${plan.reason}`);
      const n = plan.allowance;
      assert.ok(n > 0 && n <= daily);
      state = applyRolloutRun({ state, nowMs, granted: n });
      remaining -= n;
      granted += n;
      day += 1;
    }
    assert.equal(remaining, 0, `${daily}/日 で配り切れていない`);
    assert.equal(granted, COHORT);
    assert.equal(state.totalGranted, COHORT);
    assert.equal(day, Math.ceil(COHORT / daily), `${daily}/日 の日数が想定と違う`);
    assert.equal(estimateRemainingDays({ remainingCandidates: COHORT, dailyLimit: daily }), day);
  }
});

test('【重要】数十 Step を 14,489 名ぶん回しても計算が終わる', () => {
  const policy = {
    maxSends: 24, minIntervalDays: 3,
    frequencyCap: { windowDays: 7, maxSends: 2 }, stopAfterNoEngagement: null,
  };
  // 1 人ぶんを最後まで回し、それが全員に同じ形で適用できることを確かめる
  let sent = 0; let now = NOW; const history = [];
  let guard = 0;
  while (guard < 2000) {
    guard += 1;
    const r = decideNext({
      policy,
      state: {
        campaignEnabled: true, purchased: false, unsubscribed: false, hardBounced: false,
        complained: false, providerSuppressed: false, eligible: true,
        sentCount: sent, lastSentAtMs: history[history.length - 1] ?? null,
        recentSendAtMs: history, consecutiveNoEngagement: 0,
      },
      nowMs: now,
    });
    if (r.action === NEXT_ACTION.STOP) { assert.equal(r.reason, STOP_REASON.MAX_SENDS); break; }
    if (r.action === NEXT_ACTION.WAIT) { now += DAY; continue; }
    sent += 1; history.push(now); now += DAY;
  }
  assert.equal(sent, 24);
  // 分類も 14,489 名ぶん一括で通る
  const rows = Array.from({ length: COHORT }, () => ({ sentCount: 24, maxSends: 24 }));
  const classified = rows.map(classifyMember);
  assert.equal(classified.filter((s) => s === 'completed').length, COHORT);
});

test('【重要】1000 通のジョブでも時間予算で分割され、再開で完走する', () => {
  const TOTAL = 1000;
  const PER_SEND = 300;           // 1 通 300ms（本番で起こりうる遅さ）
  const BUDGET = 18_000;          // 同期 Function の予算
  let sentTotal = 0;
  let runs = 0;
  let clock = 0;

  while (sentTotal < TOTAL && runs < 100) {
    runs += 1;
    const budget = createSendBudget({ limitMs: BUDGET, nowMs: clock, initialPerSendMs: PER_SEND, safetyFactor: 1 });
    let sentThisRun = 0;
    // 既送信はスキップされる（`already_sent_in_job` 相当）
    for (let i = sentTotal; i < TOTAL; i += 1) {
      if (!budget.canSendAnother(clock)) break;
      clock += PER_SEND;
      budget.record(clock);
      sentThisRun += 1;
    }
    sentTotal += sentThisRun;
    assert.ok(sentThisRun > 0, `${runs} 回目で 1 通も進まなかった（無限ループになる）`);
    // 1 回の実行が予算を大きく超えていないこと
    assert.ok(budget.elapsedMs(clock) <= BUDGET + PER_SEND,
      `1 回の実行が ${budget.elapsedMs(clock)}ms（予算 ${BUDGET}ms）`);
    clock += 1000; // 次の実行までの間隔
  }

  assert.equal(sentTotal, TOTAL, '1000 通を送り切れていない');
  assert.ok(runs >= 2, '分割されていない（同期 Function で 1000 通を 1 回で送ろうとしている）');
  const summary = summarizeSendRun({ total: TOTAL, sent: sentTotal });
  assert.equal(summary.complete, true);
  assert.equal(summary.remaining, 0);
});

test('【重要】途中失敗しても既送信を再送しない（残りから再開する）', () => {
  const TOTAL = 500;
  // 1 回目: 120 通で落ちた（応答なし）
  const afterCrash = summarizeSendRun({ total: TOTAL, sent: 120, stoppedByBudget: true });
  assert.equal(afterCrash.complete, false);
  assert.equal(afterCrash.remaining, 380);
  assert.match(afterCrash.resumeHint, /残りから再開/);

  // 2 回目: 既送信 120 は skipped として数え、残り 380 を送る
  const afterResume = summarizeSendRun({ total: TOTAL, sent: 380, skipped: 120 });
  assert.equal(afterResume.complete, true);
  assert.equal(afterResume.remaining, 0);
});

test('チャンクの目安が桁として妥当（運用の期待値を作れる）', () => {
  // 同期 Function（予算 18 秒）
  assert.ok(estimateChunkSize({ limitMs: 18_000, perSendMs: 300 }) <= 60);
  // Background Function（予算 8 分）なら数百〜千通規模
  const bg = estimateChunkSize({ limitMs: 8 * 60_000, perSendMs: 300 });
  assert.ok(bg >= 1000, `background の目安が ${bg} 通（小さすぎる）`);
});

test('【重要】cron が重複起動しても二重に配らない（関所が止める）', () => {
  // 1 日上限 2000 / 1 バッチ 500 → 上限にはまだ余裕がある状態で二重起動を試す
  let state = {
    ...defaultRolloutState(), stage: ROLLOUT_STAGE.SCALE, alwaysArmed: true,
    dailyLimit: 2000, batchSize: 500,
  };
  const nowMs = NOW;
  const first = planRolloutTick({ state, nowMs, remainingCandidates: COHORT, previousOutstanding: 0, envEnabled: true });
  assert.equal(first.ok, true);
  assert.equal(first.allowance, 500);
  state = applyRolloutRun({ state, nowMs, granted: first.allowance, batchSeq: first.batchSeq });

  // 直後は前バッチの Step1 が未処理 → **関所**が次を止める
  for (const t of [nowMs, nowMs + 60_000, nowMs + 3600_000]) {
    const again = planRolloutTick({
      state, nowMs: t, remainingCandidates: COHORT, previousOutstanding: 500, envEnabled: true,
    });
    assert.equal(again.ok, false, '前バッチが片付く前に次を配っている');
    assert.equal(again.reason, 'waiting_previous_step1');
  }

  // 片付けば同じ日でも次のバッチへ進む（グループ配信）
  const second = planRolloutTick({
    state, nowMs: nowMs + 2 * 3600_000, remainingCandidates: COHORT - 500, previousOutstanding: 0, envEnabled: true,
  });
  assert.equal(second.ok, true);
  assert.equal(second.batchSeq, 2);
});

test('【重要】1 日の合計が上限に達したら、その日はもう配らない', () => {
  let state = {
    ...defaultRolloutState(), stage: ROLLOUT_STAGE.STEADY, alwaysArmed: true,
    dailyLimit: 500, batchSize: 500,
  };
  const first = planRolloutTick({ state, nowMs: NOW, remainingCandidates: COHORT, previousOutstanding: 0, envEnabled: true });
  state = applyRolloutRun({ state, nowMs: NOW, granted: first.allowance, batchSeq: first.batchSeq });

  for (const t of [NOW, NOW + 3600_000, NOW + 8 * 3600_000]) {
    const again = planRolloutTick({ state, nowMs: t, remainingCandidates: COHORT, previousOutstanding: 0, envEnabled: true });
    assert.equal(again.ok, false, '上限を超えて配っている');
    assert.equal(again.reason, 'daily_limit_reached');
  }
  // 翌日は進める
  const next = planRolloutTick({
    state, nowMs: NOW + DAY, remainingCandidates: COHORT - 500, previousOutstanding: 0, envEnabled: true,
  });
  assert.equal(next.ok, true);
});

test('【重要】前回ぶんの Step1 が残っている限り、何日経っても次を配らない', () => {
  const state = { ...defaultRolloutState(), stage: ROLLOUT_STAGE.STEADY, alwaysArmed: true };
  for (let d = 0; d < 30; d += 1) {
    const r = planRolloutTick({
      state, nowMs: NOW + d * DAY, remainingCandidates: COHORT, previousOutstanding: 7, envEnabled: true,
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'waiting_previous_step1');
  }
});
