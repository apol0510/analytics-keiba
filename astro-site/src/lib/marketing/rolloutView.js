/**
 * rolloutView.js — 運用画面に出す「いまどこまで進んだか」（純粋・I/O なし）
 *
 * ── 何のためか ────────────────────────────────────────────────
 * 14,479 名を段階展開するとき、運用者が知りたいのは次の 6 つだけ:
 *   母集団 / 未開始・進行中・購入・停止・完了 / Step 別の状況 /
 *   次回予定 / バッチ進行 / kill switch の状態
 *
 * ⚠️ **数えられないものは数えない。** 母集団が読み切れていないときは
 *    `partial: true` を返し、「全体の 3%」のような**嘘の割合を作らない**。
 * ⚠️ アドレス・recordId は 1 つも持たない（件数だけ）。
 */

import { normalizeRolloutState, resolveDailyLimit, estimateRemainingDays, ROLLOUT_BLOCK_LABEL } from './rolloutPlan.js';
import { resolveOperationalState } from './rolloutOperationalState.js';
import { describeTargetGap } from './rolloutTarget.js';
import { STOP_REASON_LABEL } from './sequencePolicy.js';

/** 1 人の進行状態（画面の 5 分類） */
export const MEMBER_STATE = Object.freeze({
  NOT_STARTED: 'not_started',
  IN_PROGRESS: 'in_progress',
  PURCHASED: 'purchased',
  STOPPED: 'stopped',
  COMPLETED: 'completed',
});

export const MEMBER_STATE_LABEL = Object.freeze({
  not_started: '未開始',
  in_progress: '進行中',
  purchased: '購入',
  stopped: '停止',
  completed: '完了',
});

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  return Number.isFinite(Number(v)) ? Number(v) : null;
};

/**
 * 1 人の分類。**購入が最優先**（購入者を「停止」に混ぜない）。
 *
 * @param {{purchased?: boolean, stopped?: boolean, stopReason?: string|null,
 *          sentCount?: number, maxSends?: number}} row
 */
export function classifyMember(row) {
  const r = row || {};
  if (r.purchased === true) return MEMBER_STATE.PURCHASED;
  const sent = Math.max(0, num(r.sentCount) ?? 0);
  const max = num(r.maxSends);
  if (max !== null && sent >= max) return MEMBER_STATE.COMPLETED;
  if (r.stopped === true) return MEMBER_STATE.STOPPED;
  if (sent === 0) return MEMBER_STATE.NOT_STARTED;
  return MEMBER_STATE.IN_PROGRESS;
}

/**
 * ファネルの集計。
 *
 * @param {{rows: object[], maxSends?: number, cohortTotal?: number|null, cohortPartial?: boolean}} input
 */
export function buildFunnel({ rows, maxSends, cohortTotal = null, cohortPartial = false }) {
  const list = Array.isArray(rows) ? rows : [];
  const counts = {
    not_started: 0, in_progress: 0, purchased: 0, stopped: 0, completed: 0,
  };
  const byStopReason = {};
  for (const r of list) {
    const s = classifyMember({ ...r, maxSends });
    counts[s] += 1;
    if (s === MEMBER_STATE.STOPPED && r && r.stopReason) {
      const k = String(r.stopReason);
      byStopReason[k] = (byStopReason[k] || 0) + 1;
    }
  }
  const observed = list.length;
  const total = num(cohortTotal);
  // ⚠️ 母集団を読み切れていないなら割合を作らない
  const partial = cohortPartial === true || total === null;
  return {
    observed,
    cohortTotal: total,
    partial,
    counts,
    byStopReason,
    stopReasonLabels: STOP_REASON_LABEL,
    /** 「まだ 1 通も出していない人」。展開の残りはここから来る */
    notStarted: counts.not_started,
    balanced: observed === Object.values(counts).reduce((a, b) => a + b, 0),
  };
}

/**
 * Step 別の状況。**送信済み・いま送れる・待機**を分けて数える。
 *
 * @param {{steps: number[], rows: object[]}} input
 *   rows: `{ sentSteps: number[], dueStep: number|null, failedSteps?: number[],
 *            openedSteps?: number[], clickedSteps?: number[] }`
 */
export function buildStepView({ steps, rows }) {
  const list = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const step of Array.isArray(steps) ? steps : []) {
    let sent = 0; let due = 0; let waiting = 0; let failed = 0; let opened = 0; let clicked = 0;
    for (const r of list) {
      const sentSteps = Array.isArray(r && r.sentSteps) ? r.sentSteps : [];
      if (sentSteps.includes(step)) sent += 1;
      if (num(r && r.dueStep) === step) due += 1;
      else if (num(r && r.waitingStep) === step) waiting += 1;
      if (Array.isArray(r && r.failedSteps) && r.failedSteps.includes(step)) failed += 1;
      if (Array.isArray(r && r.openedSteps) && r.openedSteps.includes(step)) opened += 1;
      if (Array.isArray(r && r.clickedSteps) && r.clickedSteps.includes(step)) clicked += 1;
    }
    out.push({
      step, sent, due, waiting, failed, opened, clicked,
      // 反応率は**送信済みが母数**。0 通なら率を作らない
      openRate: sent > 0 ? opened / sent : null,
      clickRate: sent > 0 ? clicked / sent : null,
    });
  }
  return out;
}

/**
 * 運用画面が必要とするものを 1 つにまとめる。
 *
 * @param {{state: object, envEnabled: boolean, plan: object|null,
 *          funnel: object, stepView: object[], remainingCandidates: number|null,
 *          nextScheduledAtMs: number|null}} input
 */
export function buildRolloutView({
  state, envEnabled, plan, funnel, stepView,
  remainingCandidates = null, nextScheduledAtMs = null,
}) {
  const s = normalizeRolloutState(state);
  const dailyLimit = resolveDailyLimit(s);
  const remaining = num(remainingCandidates);
  return {
    /** ① kill switch と許可の状態（**最初に見せる**） */
    control: {
      envEnabled: envEnabled === true,
      killed: s.killed === true,
      stage: s.stage,
      dailyLimit,
      alwaysArmed: s.alwaysArmed === true,
      armedFor: s.armedFor,
      /** 実際に「いま進めるか」と、進めないなら理由 */
      canProceed: !!(plan && plan.ok),
      blockedReason: plan && !plan.ok ? plan.reason : null,
      blockedLabel: plan && !plan.ok ? (ROLLOUT_BLOCK_LABEL[plan.reason] || plan.reason) : null,
      /**
       * 運用者が最初に見る 1 語（`rolloutOperationalState.js` が単一源）。
       * ⚠️ **「今日の上限に到達」と「異常停止」を混同しない**。
       *    前者は日付が変われば自動で続く（人の操作は要らない）。
       */
      operational: resolveOperationalState({ state: s, plan }),
      autoStopped: s.autoStopped === true,
      stopReason: s.stopReason || null,
      /**
       * **完成条件（正本 `rolloutTarget.js`）との差**。
       * 目標より小さい設定で走っていること自体は異常ではないが、
       * 「絞ったまま気づかず放置」を防ぐため必ず画面へ出す。
       */
      target: describeTargetGap(s),
      batchGrantedCount: s.batchGrantedCount,
      note: s.note || null,
    },
    /** ② バッチ進行 */
    batch: {
      lastRunDay: s.lastRunDay,
      lastRunCount: s.lastRunCount,
      totalGranted: s.totalGranted,
      allowanceToday: plan && plan.ok ? plan.allowance : 0,
      remainingCandidates: remaining,
      estimatedDays: estimateRemainingDays({ remainingCandidates: remaining, dailyLimit }),
    },
    /** ③ 母集団と 5 分類 */
    funnel,
    /** ④ Step 別 */
    steps: stepView,
    /** ⑤ 次回予定 */
    nextScheduledAt: nextScheduledAtMs ? new Date(nextScheduledAtMs).toISOString() : null,
    labels: { memberState: MEMBER_STATE_LABEL },
  };
}

/** 応答に PII が混ざっていないかの自己点検（テストと画面の両方で使う） */
export function assertNoPii(view) {
  const dump = JSON.stringify(view ?? {});
  if (/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(dump)) return { ok: false, reason: 'email' };
  if (/rec[A-Za-z0-9]{14}/.test(dump)) return { ok: false, reason: 'record_id' };
  return { ok: true, reason: null };
}

export default buildRolloutView;
