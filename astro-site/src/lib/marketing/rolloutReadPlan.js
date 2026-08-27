/**
 * rolloutReadPlan.js — 1 tick で **Airtable を読んでよい範囲**の単一源（純粋・I/O なし）
 *
 * ── 何を直すか ────────────────────────────────────────────────
 * `cron-marketing-rollout` は「決める前に事実を全部数える」形だった。
 * `runRolloutTick` の冒頭で、**結論が SKIP になる tick でも**
 *   ① 付与計画（Customers 候補走査 + 関所走査 + 配信台帳の全件走査 + blacklist）
 *   ② ジョブ照会（ScheduledEmails + CampaignDeliveries）
 *   ③ 連続配信の進行読み（1 フェーズ 19〜21 秒 = 約 100 リクエスト × 最大 2）
 * を**無条件で**実行していた。2 分間隔だと 1 か月 21,600 tick なので、
 * 空振りの tick が Airtable の月間上限を単独で焼き切る（2026-08 に実際に起きた）。
 *
 * ── 方針 ──────────────────────────────────────────────────
 * **読む前に、読んでも結論が変わらないかを確かめる。**
 * 判断材料は 2 つだけで、どちらも Airtable を読まずに手に入る:
 *   - env（工程ごとのゲート … `rolloutGates.js`）
 *   - 展開状態（Redis … `rolloutPlan.js` の `normalizeRolloutState`）
 *
 * ⚠️ **ゲートを緩めない。** ここは「読まない」しか決めない。
 *    実行してよいかの判定は従来どおり `tickRollout` / 各 Function が持つ。
 * ⚠️ **読まなかった事実は `null` のまま渡す**（0 として渡さない）。
 *    `tickRollout` は数えられない事実で付与も送信もしない（fail closed）ので、
 *    読み落としが「0 件」に化けて誤送信になることはない。
 *
 * ── 段階（`tickRollout` の優先順と同じ並び）────────────────────
 *   ⓪ `planTickReads`      … env と状態だけ。ここで止まれば **Airtable 0 回**
 *   ① jobs                 … 送信待ちの数（①送信起動の判断）
 *   ② `needsGrantPlan`     … 関所・候補（②キュー登録 / ④付与の判断）
 *   ③ `needsSequenceRead`  … 期日（③ Step2〜24 の判断）※**最重量**
 */

import {
  normalizeRolloutState, dailyRoomToday, ROLLOUT_BLOCK, ROLLOUT_STAGE, jstDay,
} from './rolloutPlan.js';
import { readStageGates, ROLLOUT_STAGE_GATE } from './rolloutGates.js';

/** 1 tick で起こしうる読み取り（名前はログにそのまま出す） */
export const TICK_READ = Object.freeze({
  JOBS: 'jobs',
  GRANT_PLAN: 'grantPlan',
  SEQUENCE: 'sequence',
});

/** 読む前に終わる理由 */
export const READ_SKIP = Object.freeze({
  KILLED: ROLLOUT_BLOCK.KILLED,
  /** 付与・キュー登録・送信の**どれも**開いていない（何をしても副作用ゼロ） */
  ALL_GATES_CLOSED: 'all_gates_closed',
});

/**
 * 進行読みを据え置いてよい**最長時間**。
 *
 * `nextScheduledAt` は「これより前には誰も期日にならない」という単一源の答えなので、
 * 原理的にはそこまで読まなくてよい。それでも上限を置くのは、
 * キャンペーン定義の変更（deploy）や人の手による登録など、
 * **展開状態からは見えない変化**を取りこぼし続けないため。
 * 写し（`customerSnapshotCache`）と同じ 6 時間に揃える。
 */
export const SEQUENCE_MAX_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * **状態だけで「今日はもう配れない」と分かる**とき、付与計画を読み直す間隔。
 *
 * 止まっている・今日の枠を使い切った・武装していない・展開が終わった —— どれでも
 * `planRolloutTick` は候補を見る前に断る。それでも読む理由が 1 つだけ残る:
 * **付与したのに Step1 を積んでいない人**（`outstanding`）の救済で、
 * これは `cron-light-trial-grant`（1 日 1 回）が独立に付与したときに起こりうる。
 *
 * 1 日 1 回しか生まれない事象のために 5 分おきに全件走査を払うのは割に合わない。
 * 救済は**最大 6 時間遅れる**が、その間も送信待ち・引き継ぎがあれば
 * （＝運転手自身が付与したぶんは）状態から即座に拾える。
 */
export const GRANT_PLAN_MAX_STALE_MS = 6 * 60 * 60 * 1000;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 状態が持つ「まだ queue していない付与」の数（Airtable を読まずに分かる） */
export function countPendingHandoffs(state) {
  const s = normalizeRolloutState(state);
  return s.pendingHandoffOps.length + (s.pendingHandoffOp ? 1 : 0);
}

/**
 * ⓪ **env と状態だけ**で「この tick は Airtable を読む価値があるか」を決める。
 *
 * @returns {{skip: {reason: string}|null, reads: {jobs: boolean}, gates: object}}
 */
export function planTickReads({ state, env, nowMs }) {
  const s = normalizeRolloutState(state);
  const gates = readStageGates(env || {});

  // 緊急停止は他のすべてに優先する（`tickRollout` と同じ順序）
  if (s.killed === true) {
    return { skip: { reason: READ_SKIP.KILLED }, reads: { jobs: false }, gates };
  }

  /**
   * ⚠️ 3 工程が**全部**閉じているなら、事実を何点数えても行き先は SKIP しかない。
   *    ジョブ照会すら要らない（実績の写しは工程が開いた最初の tick が拾う）。
   */
  const anyOpen = [ROLLOUT_STAGE_GATE.GRANT, ROLLOUT_STAGE_GATE.QUEUE, ROLLOUT_STAGE_GATE.DISPATCH]
    .some((stage) => gates.stages[stage] && gates.stages[stage].effective === true);
  if (!anyOpen) {
    return { skip: { reason: READ_SKIP.ALL_GATES_CLOSED }, reads: { jobs: false }, gates };
  }

  // ここから先は「送信待ちが何件あるか」を知らないと ① の判断ができない
  return { skip: null, reads: { jobs: true }, gates };
}

/**
 * ② 付与計画（関所 + 候補 + 配信台帳）を読む必要があるか。
 *
 * `tickRollout` は
 *   ① `pendingJobs > 0`      → DISPATCH
 *   ② `pendingHandoffs > 0`  → QUEUE（**状態だけで決まる**）
 * を先に返すので、そのどちらかに当たる tick では関所も候補も**結論を変えられない**。
 */
export function needsGrantPlan({ pendingJobs, pendingHandoffs, gates, state, nowMs }) {
  const jobs = num(pendingJobs);
  // 読めていない = 判断できない。従来どおり fail closed（読まない・進めない）
  if (jobs === null) return false;
  if (jobs > 0) return false;
  if ((num(pendingHandoffs) ?? 0) > 0) return false;
  // 付与も queue も閉じているなら、関所を数えても SKIP しかない
  const open = (stage) => !!(gates && gates.stages[stage] && gates.stages[stage].effective === true);
  if (!open(ROLLOUT_STAGE_GATE.QUEUE) && !open(ROLLOUT_STAGE_GATE.GRANT)) return false;
  // 「今日はもう配れない」が状態だけで分かるなら、救済のための読みを間引く
  if (isGrantPlanDeferred({ state, nowMs })) return false;
  return true;
}

/** 運転手自身が抱えている仕事（Airtable を読まずに分かる） */
function hasNothingInFlight(state) {
  const s = normalizeRolloutState(state);
  return s.pendingJobIds.length === 0
    && Object.keys(s.dispatchWatch).length === 0
    && countPendingHandoffs(s) === 0;
}

/**
 * 付与計画の読みを間引いてよいか。
 *
 * ⚠️ 間引いてよいのは、次の**すべて**が揃うときだけ:
 *   - 状態だけで「今日はもう配れない」と言える（停止・完了・未武装・1 日上限）
 *   - 運転手が抱えている仕事が無い（送信待ち・見張り・引き継ぎがゼロ）
 *   - 前回の読みから `GRANT_PLAN_MAX_STALE_MS` 経っていない
 * どれか 1 つでも欠ければ**読む**。「配れるかもしれない」ときは必ず数える。
 */
export function isGrantPlanDeferred({ state, nowMs }) {
  if (describeCheapBlock({ state, nowMs }) === null) return false;
  if (!hasNothingInFlight(state)) return false;
  const readAt = num(normalizeRolloutState(state).grantPlanReadAtMs);
  const now = num(nowMs);
  if (readAt === null || now === null) return false;
  return now - readAt < GRANT_PLAN_MAX_STALE_MS;
}

/**
 * 進行読みを据え置いてよいか（**期日より前かつ据え置きが長すぎない**）。
 */
export function isSequenceDeferred(state, nowMs) {
  const s = normalizeRolloutState(state);
  const dueAt = num(s.nextDueAtMs);
  const readAt = num(s.sequenceReadAtMs);
  const now = num(nowMs);
  if (dueAt === null || readAt === null || now === null) return false;
  if (now >= dueAt) return false;                          // 期日が来た → 読む
  if (now - readAt >= SEQUENCE_MAX_STALE_MS) return false; // 据え置きが長すぎ → 読む
  return true;
}

/**
 * ③ 連続配信の進行（`action=sequence`）を読む必要があるか。**最重量の読み取り**。
 *
 * 要るのは 2 か所だけ:
 *   - ② の救済経路（付与の引き継ぎが無いまま queue 待ちが居る）… **据え置き不可**
 *   - ③ Step2〜24 の期日判定 … `nextScheduledAt` まで据え置いてよい
 */
export function needsSequenceRead({
  pendingJobs, pendingHandoffs, pendingQueue, gates, state, nowMs,
}) {
  const jobs = num(pendingJobs);
  if (jobs === null || jobs > 0) return false;
  if ((num(pendingHandoffs) ?? 0) > 0) return false;
  // queue が閉じていれば ②③ はどちらも `gate_closed_queue` で SKIP（読んでも変わらない）
  const queueOpen = !!(gates && gates.stages[ROLLOUT_STAGE_GATE.QUEUE]
    && gates.stages[ROLLOUT_STAGE_GATE.QUEUE].effective === true);
  if (!queueOpen) return false;

  const queued = num(pendingQueue);
  // 関所を読んでいない（= 読む必要が無かった）なら、期日も判断材料にならない
  if (queued === null) return false;
  // 救済経路は「誰を積むか」を単一源から取り直す必要があるので**必ず読む**
  if (queued > 0) return true;

  return !isSequenceDeferred(state, nowMs);
}

/**
 * 進行読みの結果から、次に読むべき時刻を決める（状態へ書く値）。
 *
 * ⚠️ **据え置いてよいのは「全フェーズを読んで、いま期日の人が 0 人」だったときだけ。**
 *    片方のフェーズを省略した読み（`phasesComplete !== true`）は
 *    「もう片方に期日があるか」を知らないので、据え置きの根拠にならない。
 */
export function resolveSequenceDefer({ due, nowMs }) {
  const now = num(nowMs);
  const read = now;
  if (!due || due.phasesComplete !== true) return { nextDueAtMs: null, sequenceReadAtMs: read };
  if ((num(due.due) ?? 0) > 0) return { nextDueAtMs: null, sequenceReadAtMs: read };
  const at = Date.parse(String(due.nextScheduledAt || ''));
  if (!Number.isFinite(at) || now === null || at <= now) {
    return { nextDueAtMs: null, sequenceReadAtMs: read };
  }
  return { nextDueAtMs: at, sequenceReadAtMs: read };
}

/**
 * 付与・キュー登録が起きたら据え置きを**必ず解く**（次の tick で読み直す）。
 *
 * Step1 を積めば、その人たちの Step2 の期日が新しく生まれる。
 * 据え置いたままだと「積んだのに次が来ない」時間が最大 6 時間伸びる。
 */
export function clearSequenceDefer(state) {
  return { ...state, nextDueAtMs: null, sequenceReadAtMs: null, grantPlanReadAtMs: null };
}

/**
 * 今日はもう配れない（1 日上限・段階・武装）ことが**状態だけ**で分かるか。
 * ログに出して運用者が「なぜ静かなのか」を読めるようにするための説明用。
 */
export function describeCheapBlock({ state, nowMs }) {
  const s = normalizeRolloutState(state);
  if (s.killed === true) return ROLLOUT_BLOCK.KILLED;
  if (s.stage === ROLLOUT_STAGE.PAUSED) return ROLLOUT_BLOCK.PAUSED;
  if (s.stage === ROLLOUT_STAGE.COMPLETED) return ROLLOUT_BLOCK.COMPLETED;
  if (!s.alwaysArmed && s.armedFor !== jstDay(nowMs)) return ROLLOUT_BLOCK.NOT_ARMED;
  if (dailyRoomToday(s, nowMs) <= 0) return ROLLOUT_BLOCK.DAILY_LIMIT_REACHED;
  return null;
}

export default planTickReads;
