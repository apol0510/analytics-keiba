/**
 * rolloutOperationalState.js — 運用者が見る「いまどの状態か」の単一源（純粋・I/O なし）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * `stage` と `blockedReason` の組み合わせは 30 通り以上あり、運用者には読めない。
 * とくに **「1 日上限に達しただけ（翌日に自動で続く）」** と
 * **「異常で止まった（人が直すまで動かない）」** を混同すると、
 * 毎日 resume を押す運用になったり、逆に壊れたまま放置されたりする。
 *
 * ⚠️ ここは判定するだけ。状態は変えない。
 */

import { normalizeRolloutState, ROLLOUT_STAGE, ROLLOUT_BLOCK } from './rolloutPlan.js';

/** 運用者へ見せる状態（**この 6 つだけ**） */
export const OPERATIONAL_STATE = Object.freeze({
  /** 終端。もう配る相手が居ない（翌日も動かない） */
  COMPLETED: 'completed',
  /** 異常で自動停止。**人が原因を直して開始し直すまで動かない** */
  AUTO_STOPPED: 'auto_stopped',
  /** 人が止めた（異常ではない） */
  PAUSED: 'paused',
  /** 前のバッチの Step1 が片付くのを待っている（**正常**・そのまま進む） */
  WAITING_PREVIOUS: 'waiting_previous',
  /** 今日の上限まで配った（**正常**・日付が変わればそのまま続く） */
  DAILY_LIMIT_REACHED: 'daily_limit_reached',
  /** 動いている */
  RUNNING: 'running',
});

export const OPERATIONAL_STATE_LABEL = Object.freeze({
  completed: '完了（配る相手はもういません）',
  auto_stopped: '**異常停止**（原因を直して開始し直すまで動きません）',
  paused: '一時停止中（人が止めています）',
  waiting_previous: '前のバッチの送信待ち（そのまま進みます）',
  daily_limit_reached: '今日の上限に到達（**日付が変われば自動で続きます**）',
  running: '展開中',
});

/** 人の操作が要るか（画面で赤く出すのはこれだけ） */
export const NEEDS_HUMAN = Object.freeze([
  OPERATIONAL_STATE.AUTO_STOPPED, OPERATIONAL_STATE.PAUSED,
]);

/**
 * @param {{state: object, plan?: object|null}} input
 *   `plan` … `planRolloutTick()` の結果（無ければ状態だけで判断する）
 * @returns {{state: string, label: string, needsHuman: boolean,
 *            autoContinues: boolean, reason: string|null}}
 */
export function resolveOperationalState({ state, plan = null } = {}) {
  const s = normalizeRolloutState(state);
  const reason = plan && plan.ok !== true ? (plan.reason || null) : null;

  const out = (code, extra = {}) => ({
    state: code,
    label: OPERATIONAL_STATE_LABEL[code] || code,
    needsHuman: NEEDS_HUMAN.includes(code),
    /** 人が触らなくても続きが進むか */
    autoContinues: code === OPERATIONAL_STATE.RUNNING
      || code === OPERATIONAL_STATE.WAITING_PREVIOUS
      || code === OPERATIONAL_STATE.DAILY_LIMIT_REACHED,
    reason,
    ...extra,
  });

  if (s.stage === ROLLOUT_STAGE.COMPLETED) return out(OPERATIONAL_STATE.COMPLETED);
  // 緊急停止は「人が直すまで動かない」側（異常停止と同じ扱いで赤く出す）
  if (s.killed === true) return out(OPERATIONAL_STATE.AUTO_STOPPED, { stopReason: 'kill_switch' });
  if (s.stage === ROLLOUT_STAGE.PAUSED) {
    return s.autoStopped === true
      ? out(OPERATIONAL_STATE.AUTO_STOPPED, { stopReason: s.stopReason })
      : out(OPERATIONAL_STATE.PAUSED);
  }
  if (reason === ROLLOUT_BLOCK.DAILY_LIMIT_REACHED) return out(OPERATIONAL_STATE.DAILY_LIMIT_REACHED);
  if (reason === ROLLOUT_BLOCK.WAITING_PREVIOUS) return out(OPERATIONAL_STATE.WAITING_PREVIOUS);
  return out(OPERATIONAL_STATE.RUNNING);
}

export default resolveOperationalState;
