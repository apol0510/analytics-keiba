/**
 * rolloutPlan.js — 大規模コホートの**段階展開**を決める（純粋・I/O なし）
 *
 * ── 解決する問題 ──────────────────────────────────────────────
 * 未付与が 14,479 名ある。100 名/日の固定運用だと **145 日**かかり、
 * しかも毎回 env を開閉して redeploy しないと動かない。これは運用ではない。
 *
 * ── 方針 ────────────────────────────────────────────────────
 * 1. **段階展開（ramp）**: 10 → 100 → 500 → … と、実績を見ながら増やす。
 *    いきなり数千通を出さない（バウンス率・苦情率が跳ねると送信ドメインが焼ける）。
 * 2. **1 日あたりの上限**は状態として持ち、**env の開閉・redeploy 無しで**変えられる。
 * 3. **kill switch は既定 OFF**。止めたいときは 1 つの状態を落とせば**次の tick から止まる**。
 * 4. 進めてよいかの判定は**毎回やり直す**（前回の結論を持ち越さない）。
 *
 * ⚠️ このモジュールは**決めるだけ**で、付与も送信もしない。
 *    実際に書くのは既存の付与経路（`cron-light-trial-grant`）と
 *    送信経路（`admin-marketing` / `marketing-campaign-dispatch`）のまま。
 */

/** 展開の段階。**実績を見て次へ上げる**（自動では上げない） */
export const ROLLOUT_STAGE = Object.freeze({
  /** 止まっている（既定）。kill switch が入っている状態もこれ */
  PAUSED: 'paused',
  /** 少数で経路を確かめる */
  CANARY: 'canary',
  /** 通常運用 */
  STEADY: 'steady',
  /** 拡大 */
  SCALE: 'scale',
  /** 対象を配り終えた */
  COMPLETED: 'completed',
});

/** 段階ごとの 1 日あたり既定上限（状態で上書きできる） */
export const STAGE_DEFAULT_DAILY = Object.freeze({
  paused: 0,
  canary: 10,
  steady: 100,
  scale: 500,
  completed: 0,
});

/** 1 日あたりの絶対上限。**状態が壊れてもこれを超えない** */
export const HARD_DAILY_MAX = 2000;

/** 進めない理由（固定コード。件数・理由だけを画面へ出す） */
export const ROLLOUT_BLOCK = Object.freeze({
  KILLED: 'kill_switch',
  PAUSED: 'paused',
  NOT_ARMED: 'not_armed',
  ALREADY_RAN_TODAY: 'already_ran_today',
  WAITING_PREVIOUS: 'waiting_previous_step1',
  NO_CANDIDATES: 'no_candidates',
  DAILY_LIMIT_REACHED: 'daily_limit_reached',
  STATE_UNREADABLE: 'state_unreadable',
  COMPLETED: 'completed',
});

export const ROLLOUT_BLOCK_LABEL = Object.freeze({
  kill_switch: '緊急停止が入っています',
  paused: '展開は一時停止中です',
  not_armed: '実行日の指定（armedFor）が今日と一致しません',
  already_ran_today: '今日はすでに実行済みです',
  waiting_previous_step1: '前回ぶんの Step1 がまだ片付いていません',
  no_candidates: '対象がいません',
  daily_limit_reached: '本日の上限に達しました',
  state_unreadable: '展開状態を読めません（安全側で停止）',
  completed: '対象を配り終えました',
});

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  return Number.isFinite(Number(v)) ? Number(v) : null;
};
const str = (v) => String(v ?? '').trim();

/** JST の暦日（`YYYY-MM-DD`）。**UTC 基準で切らない** */
export function jstDay(nowMs) {
  const d = new Date(Number(nowMs) + 9 * 3600_000);
  return d.toISOString().slice(0, 10);
}

/**
 * 既定の展開状態（**止まっている**）。
 * 状態が無い / 壊れているときはこれを使い、**動かさない**。
 */
export function defaultRolloutState() {
  return {
    version: 1,
    stage: ROLLOUT_STAGE.PAUSED,
    /** 緊急停止。true なら段階に関係なく止まる */
    killed: false,
    /** 1 日あたりの上限（未指定なら段階の既定） */
    dailyLimit: null,
    /**
     * 「今日動かしてよい」という明示。`YYYY-MM-DD`（JST）。
     * 置きっぱなしでも**翌日には効かなくなる**ので、暴走しない。
     * `alwaysArmed: true` なら日付を毎日置き直さずに継続運用できる。
     */
    armedFor: null,
    alwaysArmed: false,
    /** 最後に実行した JST 日と件数（同じ日に二重に走らせない） */
    lastRunDay: null,
    lastRunCount: 0,
    /** 累計（画面表示・進捗） */
    totalGranted: 0,
    updatedAtMs: null,
    note: '',
  };
}

/** 状態を安全に正規化する（壊れた値は既定へ倒す） */
export function normalizeRolloutState(raw) {
  const d = defaultRolloutState();
  if (!raw || typeof raw !== 'object') return d;
  const stage = Object.values(ROLLOUT_STAGE).includes(str(raw.stage)) ? str(raw.stage) : d.stage;
  const dailyRaw = num(raw.dailyLimit);
  const daily = dailyRaw !== null && dailyRaw >= 0 ? Math.min(Math.floor(dailyRaw), HARD_DAILY_MAX) : null;
  return {
    version: num(raw.version) || 1,
    stage,
    killed: raw.killed === true,
    dailyLimit: daily,
    armedFor: /^\d{4}-\d{2}-\d{2}$/.test(str(raw.armedFor)) ? str(raw.armedFor) : null,
    alwaysArmed: raw.alwaysArmed === true,
    lastRunDay: /^\d{4}-\d{2}-\d{2}$/.test(str(raw.lastRunDay)) ? str(raw.lastRunDay) : null,
    lastRunCount: Math.max(0, num(raw.lastRunCount) ?? 0),
    totalGranted: Math.max(0, num(raw.totalGranted) ?? 0),
    updatedAtMs: num(raw.updatedAtMs),
    note: str(raw.note).slice(0, 200),
  };
}

/** 段階に対する 1 日あたりの上限（状態の指定 > 段階の既定、ただし絶対上限で頭打ち） */
export function resolveDailyLimit(state) {
  const s = normalizeRolloutState(state);
  const byStage = STAGE_DEFAULT_DAILY[s.stage] ?? 0;
  const n = s.dailyLimit === null ? byStage : s.dailyLimit;
  return Math.max(0, Math.min(n, HARD_DAILY_MAX));
}

/**
 * **今回いくつ進めてよいか**を決める。
 *
 * ⚠️ 進めない理由は必ず 1 つ返す（「なんとなく 0 件」にしない）。
 * ⚠️ `remaining` が分からない（null）ときは**進めない**（fail closed）。
 *
 * @param {{state: object, nowMs: number, remainingCandidates: number|null,
 *          previousOutstanding: number|null, envEnabled: boolean}} input
 * @returns {{ok: boolean, allowance: number, reason: string|null, stage: string,
 *            dailyLimit: number, day: string}}
 */
export function planRolloutTick({
  state, nowMs, remainingCandidates, previousOutstanding, envEnabled,
}) {
  const s = normalizeRolloutState(state);
  const day = jstDay(nowMs);
  const dailyLimit = resolveDailyLimit(s);
  const base = { allowance: 0, stage: s.stage, dailyLimit, day };

  // ① env のマスタースイッチ。**既定 OFF**（コード側の最後の砦）
  if (envEnabled !== true) return { ...base, ok: false, reason: ROLLOUT_BLOCK.PAUSED };
  // ② 緊急停止は段階より強い
  if (s.killed === true) return { ...base, ok: false, reason: ROLLOUT_BLOCK.KILLED };
  if (s.stage === ROLLOUT_STAGE.PAUSED) return { ...base, ok: false, reason: ROLLOUT_BLOCK.PAUSED };
  if (s.stage === ROLLOUT_STAGE.COMPLETED) return { ...base, ok: false, reason: ROLLOUT_BLOCK.COMPLETED };

  // ③ 「今日動かす」の明示。`alwaysArmed` なら日付指定を省ける（継続運用）
  if (!s.alwaysArmed && s.armedFor !== day) {
    return { ...base, ok: false, reason: ROLLOUT_BLOCK.NOT_ARMED };
  }
  // ④ 同じ日に二重に走らせない（cron の重複起動・手動再実行）
  if (s.lastRunDay === day) return { ...base, ok: false, reason: ROLLOUT_BLOCK.ALREADY_RAN_TODAY };

  // ⑤ 前回ぶんの Step1 が片付くまで次を配らない（関所）
  const outstanding = num(previousOutstanding);
  if (outstanding === null) return { ...base, ok: false, reason: ROLLOUT_BLOCK.STATE_UNREADABLE };
  if (outstanding > 0) return { ...base, ok: false, reason: ROLLOUT_BLOCK.WAITING_PREVIOUS };

  // ⑥ 対象が読めない / いない
  const remaining = num(remainingCandidates);
  if (remaining === null) return { ...base, ok: false, reason: ROLLOUT_BLOCK.STATE_UNREADABLE };
  if (remaining <= 0) return { ...base, ok: false, reason: ROLLOUT_BLOCK.NO_CANDIDATES };

  if (dailyLimit <= 0) return { ...base, ok: false, reason: ROLLOUT_BLOCK.DAILY_LIMIT_REACHED };

  return { ...base, ok: true, allowance: Math.min(dailyLimit, remaining), reason: null };
}

/** 実行後の状態（**同じ日にもう一度走らせない**印を必ず付ける） */
export function applyRolloutRun({ state, nowMs, granted }) {
  const s = normalizeRolloutState(state);
  const day = jstDay(nowMs);
  const n = Math.max(0, num(granted) ?? 0);
  return {
    ...s,
    lastRunDay: day,
    lastRunCount: n,
    totalGranted: s.totalGranted + n,
    updatedAtMs: Number(nowMs) || null,
    // 日付指定で動かしている運用では、1 日 1 回で自動的に閉じる
    armedFor: s.alwaysArmed ? s.armedFor : null,
  };
}

/**
 * 次の段階の提案（**自動では上げない**。画面に出して人が決める）。
 * 「実績が良ければ上げてよい」という判断材料だけを返す。
 */
export function suggestNextStage({ state, deliveredRate, bounceRate, complaintRate }) {
  const s = normalizeRolloutState(state);
  const d = num(deliveredRate);
  const b = num(bounceRate);
  const c = num(complaintRate);
  if (d === null || b === null || c === null) {
    return { stage: s.stage, ok: false, reason: '実績を確認できないため据え置き' };
  }
  // 業界的な危険水域。ここを超えたら**下げる**
  if (b > 0.05 || c > 0.001) {
    return { stage: ROLLOUT_STAGE.PAUSED, ok: true, reason: 'バウンス/苦情が高いので停止' };
  }
  if (d < 0.9) return { stage: s.stage, ok: false, reason: '到達率が低いため据え置き' };
  const order = [ROLLOUT_STAGE.CANARY, ROLLOUT_STAGE.STEADY, ROLLOUT_STAGE.SCALE];
  const i = order.indexOf(s.stage);
  if (i === -1) return { stage: s.stage, ok: false, reason: '段階を上げられない状態' };
  if (i === order.length - 1) return { stage: s.stage, ok: false, reason: '最大段階に到達' };
  return { stage: order[i + 1], ok: true, reason: '実績が基準内のため次段階を提案' };
}

/** 残り日数の見積り（画面表示用。**約束ではない**） */
export function estimateRemainingDays({ remainingCandidates, dailyLimit }) {
  const r = num(remainingCandidates);
  const d = num(dailyLimit);
  if (r === null || d === null || d <= 0) return null;
  return Math.ceil(r / d);
}

export default planRolloutTick;
