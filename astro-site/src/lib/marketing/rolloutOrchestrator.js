/**
 * rolloutOrchestrator.js — 1 tick で「付与 → キュー登録 → 送信の起動」まで進める（純粋）
 *
 * ── 解決する問題 ──────────────────────────────────────────────
 * `rolloutPlan` / `rolloutStore` を作っただけでは運用にならない。
 * 現行の `cron-light-trial-grant` は **付与しかしない**（キュー登録も送信もしない）ので、
 * 人が毎回 env の日付を書き換え、管理画面から queue を押し、dispatcher を叩いていた。
 * 14,479 名を配るには**この手順を 145 回**繰り返すことになる。
 *
 * ── このモジュールがやること ────────────────────────────────
 * **決めるだけ。** I/O は cron 側（`cron-marketing-rollout.js`）が持つ。
 * 「次に何をするか」を 1 つずつ返し、cron はそれを実行して結果を返す。
 * こうすると、順序・中断・再開・冪等の判断が**全部ここでテストできる**。
 *
 *   tick(state, facts) → { action, ... }
 *     'skip'    … 進めない（理由つき）
 *     'grant'   … N 名へ付与する
 *     'queue'   … 付与できた人へ Step1 をキュー登録する
 *     'dispatch'… キュー済みジョブを background へ渡す
 *     'settle'  … 台帳で完了を確認して状態を更新する
 *     'done'    … この tick でやることは無い
 *
 * ── 途中で落ちても続きから ────────────────────────────────────
 * 各段階の判断は**そのときの事実**（付与済み・queue 済み・PENDING ジョブ）から
 * 毎回導出する。前回の途中結果を覚えていなくても、次の tick が続きを拾う。
 */

import { planRolloutTick, applyRolloutRun, normalizeRolloutState, ROLLOUT_BLOCK } from './rolloutPlan.js';

/** 1 tick で返す指示 */
export const TICK_ACTION = Object.freeze({
  SKIP: 'skip',
  GRANT: 'grant',
  QUEUE: 'queue',
  DISPATCH: 'dispatch',
  SETTLE: 'settle',
  DONE: 'done',
});

/** 事実が読めないときの理由（**推測で進めない**） */
export const TICK_BLOCK = Object.freeze({
  FACTS_UNREADABLE: 'facts_unreadable',
  ...ROLLOUT_BLOCK,
});

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  return Number.isFinite(Number(v)) ? Number(v) : null;
};

/**
 * 1 tick の判断。
 *
 * @param {object} input
 * @param {object} input.state              展開状態（Redis）
 * @param {number} input.nowMs
 * @param {boolean} input.envEnabled        機能そのものの許可（既定 OFF）
 * @param {object} input.facts              **そのときの事実**（cron が読んで渡す）
 * @param {number|null} input.facts.remainingCandidates  未付与の候補数
 * @param {number|null} input.facts.grantedPendingQueue  付与済みだが Step1 未 queue の人数
 * @param {number|null} input.facts.pendingJobs          送信待ちジョブ数（この campaign）
 * @param {number|null} input.facts.outstandingStep1     関所（前回ぶんの未処理）
 * @returns {{action: string, reason?: string, count?: number, plan?: object}}
 */
export function tickRollout({ state, nowMs, envEnabled, facts }) {
  const f = facts && typeof facts === 'object' ? facts : {};
  const remaining = num(f.remainingCandidates);
  const pendingQueue = num(f.grantedPendingQueue);
  const pendingJobs = num(f.pendingJobs);
  const outstanding = num(f.outstandingStep1);

  // ⚠️ 事実が 1 つでも読めないなら**何もしない**（推測で付与・送信しない）
  if (remaining === null || pendingQueue === null || pendingJobs === null || outstanding === null) {
    return { action: TICK_ACTION.SKIP, reason: TICK_BLOCK.FACTS_UNREADABLE };
  }

  // ── ① 先に「積み残し」を片付ける ──────────────────────────────
  //    付与したのに queue していない人がいるなら、**新しく配る前に**そこを進める。
  //    ここを飛ばすと、付与だけが増えて案内が出ない人が溜まる。
  if (pendingQueue > 0) {
    return { action: TICK_ACTION.QUEUE, count: pendingQueue };
  }
  //    queue 済みで送信待ちのジョブがあるなら、送信を起動する。
  if (pendingJobs > 0) {
    return { action: TICK_ACTION.DISPATCH, count: pendingJobs };
  }

  // ── ② 新しく配ってよいか ───────────────────────────────────
  const plan = planRolloutTick({
    state, nowMs, remainingCandidates: remaining, previousOutstanding: outstanding, envEnabled,
  });
  if (!plan.ok) return { action: TICK_ACTION.SKIP, reason: plan.reason, plan };
  return { action: TICK_ACTION.GRANT, count: plan.allowance, plan };
}

/**
 * 付与のあと「この tick で何人 queue すべきか」。
 * **付与できた人だけ**（失敗した人は権利が無いので対象にならない）。
 */
export function planQueueAfterGrant({ grantedRecordIds }) {
  const ids = Array.isArray(grantedRecordIds) ? grantedRecordIds.filter(Boolean) : [];
  return { count: ids.length, recordIds: ids };
}

/**
 * 実行結果から次の状態を作る。
 *
 * ⚠️ **付与した数だけを `lastRun` に刻む。** queue / dispatch が途中で落ちても、
 *    同じ日に二重に配らないことはこれで守られる（続きは次の tick が拾う）。
 */
export function settleTick({ state, nowMs, granted }) {
  return applyRolloutRun({ state, nowMs, granted: Math.max(0, num(granted) ?? 0) });
}

/**
 * tick の結果を**画面とログに出す形**へ（PII を含めない）。
 */
export function describeTick({ action, reason, count, plan }) {
  return {
    action,
    reason: reason || null,
    count: num(count) ?? 0,
    stage: plan ? plan.stage : null,
    dailyLimit: plan ? plan.dailyLimit : null,
    day: plan ? plan.day : null,
  };
}

/**
 * 1 tick で**何段階まで進めてよいか**。
 *
 * Netlify の cron は 1 回の起動が短い（同期 Function）ので、
 * 付与 → queue → dispatch を**同じ tick で全部やろうとしない**。
 * 「1 tick 1 段階」にすると、途中で落ちても次の tick が同じ判断で続きを拾う。
 */
export const STEPS_PER_TICK = 1;

export default tickRollout;
