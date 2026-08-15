/**
 * rolloutControl.js — 展開状態を**書き換えてよい形へ落とす**（純粋・I/O なし）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 展開状態（Redis）は「いま何人まで配ってよいか」「止まっているか」を決める。
 * ここを自由に書けると、**運用ミスがそのまま本番の配信量になる**。
 * 2026-08-15 の activation で、そもそも状態を書く経路が無く開始できなかったため、
 * 管理 API へ書き込み口を足す。**その代わり、受け付ける値をここで絞る。**
 *
 * ── 受け付ける操作は 4 つだけ ──────────────────────────────────
 *   start   … 段階・1 日上限・武装を設定して開始する（CAS 必須）
 *   kill    … 緊急停止（**次の tick から自動処理を全部止める**）
 *   pause   … 新規付与だけ止める（積み残しの queue / 送信は進む）
 *   resume  … 停止を解除する（**段階は上げない**）
 *
 * ── ここで弾くもの（fail closed）────────────────────────────────
 * - 知らない `stage`（実装が持つ 5 値以外）
 * - `dailyLimit` が整数でない / 負 / 上限超え
 * - `armedFor` が過去の日付（**武装したつもりで動かない**状態を作らない）
 * - `armedFor` が遠すぎる未来（置きっぱなしの誤爆を防ぐ）
 * - `expectedVersion` の指定漏れ（**CAS 無しでは書かせない**）
 *
 * ⚠️ ここは値を作るだけで、Redis へは書かない（呼び出し側が `rolloutStore` を使う）。
 * ⚠️ Customers・配信台帳・送信には**一切触れない**。
 */

import { ROLLOUT_STAGE, HARD_DAILY_MAX, jstDay, normalizeRolloutState } from './rolloutPlan.js';

/** 受け付ける操作 */
export const ROLLOUT_OP = Object.freeze({
  START: 'start',
  KILL: 'kill',
  PAUSE: 'pause',
  RESUME: 'resume',
});

/** 断る理由（固定コード。値そのものは返さない） */
export const CONTROL_REJECT = Object.freeze({
  UNKNOWN_OP: 'unknown_op',
  BAD_STAGE: 'bad_stage',
  BAD_DAILY_LIMIT: 'bad_daily_limit',
  BAD_ALWAYS_ARMED: 'bad_always_armed',
  BAD_ARMED_FOR: 'bad_armed_for',
  ARMED_FOR_PAST: 'armed_for_past',
  ARMED_FOR_TOO_FAR: 'armed_for_too_far',
  ARMED_FOR_REQUIRED: 'armed_for_required',
  EXPECTED_VERSION_REQUIRED: 'expected_version_required',
  BAD_NOTE: 'bad_note',
});

export const CONTROL_REJECT_LABEL = Object.freeze({
  unknown_op: '知らない操作です',
  bad_stage: '段階の値が不正です（paused / canary / steady / scale / completed のみ）',
  bad_daily_limit: `1 日あたりの上限が不正です（0〜${HARD_DAILY_MAX} の整数）`,
  bad_always_armed: 'alwaysArmed は true / false のみです',
  bad_armed_for: '武装日は YYYY-MM-DD（JST）で指定してください',
  armed_for_past: '武装日が過去です（その日は来ないので何も起きません）',
  armed_for_too_far: '武装日が先すぎます（置きっぱなしの誤爆を防ぐため 7 日以内）',
  armed_for_required: '継続運用でないときは武装日（armedFor）が必要です',
  expected_version_required: '競合検知のため expectedVersion が必要です（null は新規作成）',
  bad_note: 'メモが長すぎます（200 文字まで）',
});

/** 武装日として許す最大の先付け（日数） */
export const MAX_ARMED_AHEAD_DAYS = 7;

const DAY_MS = 86400_000;
const isDateString = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? ''));

const reject = (reason) => ({ ok: false, reason, label: CONTROL_REJECT_LABEL[reason] || reason });

/**
 * `start` の入力を検証して、**保存してよい状態**を作る。
 *
 * @param {object} input
 * @param {object} input.current            いまの状態（`store.load()` の `state`）
 * @param {boolean} input.exists            キーが既にあるか
 * @param {object} input.req                管理画面からの指定
 * @param {number} input.nowMs
 * @returns {{ok: true, state: object, expectedVersion: number|null} | {ok: false, reason: string}}
 */
export function planRolloutStart({ current, exists, req, nowMs }) {
  const r = req && typeof req === 'object' ? req : {};

  // ── 段階 ──────────────────────────────────────────────────
  const stage = String(r.stage ?? '');
  if (!Object.values(ROLLOUT_STAGE).includes(stage)) return reject(CONTROL_REJECT.BAD_STAGE);

  // ── 1 日あたりの上限 ────────────────────────────────────────
  //    ⚠️ 未指定を「段階の既定でよい」と解釈しない。**必ず明示させる**
  //       （100 名のつもりが canary 既定の 10 名だった、を防ぐ）
  const dailyLimit = r.dailyLimit;
  if (!Number.isInteger(dailyLimit) || dailyLimit < 0 || dailyLimit > HARD_DAILY_MAX) {
    return reject(CONTROL_REJECT.BAD_DAILY_LIMIT);
  }

  // ── 武装（1 回だけ / 継続）──────────────────────────────────
  if (typeof r.alwaysArmed !== 'boolean') return reject(CONTROL_REJECT.BAD_ALWAYS_ARMED);
  let armedFor = null;
  if (r.alwaysArmed === false) {
    // one-shot は**必ず日付を伴う**（無いと永久に動かない状態になる）
    if (r.armedFor === undefined || r.armedFor === null) return reject(CONTROL_REJECT.ARMED_FOR_REQUIRED);
    if (!isDateString(r.armedFor)) return reject(CONTROL_REJECT.BAD_ARMED_FOR);
    const today = jstDay(nowMs);
    if (String(r.armedFor) < today) return reject(CONTROL_REJECT.ARMED_FOR_PAST);
    const limit = jstDay(Number(nowMs) + MAX_ARMED_AHEAD_DAYS * DAY_MS);
    if (String(r.armedFor) > limit) return reject(CONTROL_REJECT.ARMED_FOR_TOO_FAR);
    armedFor = String(r.armedFor);
  } else if (r.armedFor !== undefined && r.armedFor !== null && !isDateString(r.armedFor)) {
    return reject(CONTROL_REJECT.BAD_ARMED_FOR);
  }

  // ── CAS の前提値（**指定漏れは断る**）──────────────────────────
  const hasExpected = Object.prototype.hasOwnProperty.call(r, 'expectedVersion');
  if (!hasExpected) return reject(CONTROL_REJECT.EXPECTED_VERSION_REQUIRED);
  const expectedVersion = r.expectedVersion === null ? null : Number(r.expectedVersion);
  if (expectedVersion !== null && !Number.isInteger(expectedVersion)) {
    return reject(CONTROL_REJECT.EXPECTED_VERSION_REQUIRED);
  }
  // 新規作成のつもりで既存を上書きしない / その逆もしない
  if (exists === true && expectedVersion === null) return reject(CONTROL_REJECT.EXPECTED_VERSION_REQUIRED);
  if (exists === false && expectedVersion !== null) return reject(CONTROL_REJECT.EXPECTED_VERSION_REQUIRED);

  const note = String(r.note ?? '');
  if (note.length > 200) return reject(CONTROL_REJECT.BAD_NOTE);

  const base = normalizeRolloutState(current);
  return {
    ok: true,
    expectedVersion,
    state: {
      ...base,
      stage,
      dailyLimit,
      alwaysArmed: r.alwaysArmed === true,
      armedFor,
      // ⚠️ 開始操作で緊急停止を解除しない（止めた事実を勝手に消さない）
      killed: base.killed === true,
      note,
      updatedAtMs: Number(nowMs) || null,
    },
  };
}

/**
 * `pause` … 新規付与だけ止める。**積み残しの queue / 送信は進む**。
 * 緊急停止（killed）とは別物なので、ここでは `killed` を触らない。
 */
export function planRolloutPause({ current, nowMs }) {
  const base = normalizeRolloutState(current);
  return {
    ok: true,
    state: {
      ...base,
      stage: ROLLOUT_STAGE.PAUSED,
      // 武装も外す（再開時に改めて日付を入れさせる）
      armedFor: null,
      alwaysArmed: false,
      updatedAtMs: Number(nowMs) || null,
    },
  };
}

/**
 * `resume` … 停止の解除。**段階は上げない**（上げるのは `start`）。
 * 緊急停止も解除するが、**武装は戻さない**（再開＝すぐ配り出す、にしない）。
 */
export function planRolloutResume({ current, nowMs }) {
  const base = normalizeRolloutState(current);
  return {
    ok: true,
    state: {
      ...base,
      killed: false,
      armedFor: null,
      alwaysArmed: false,
      updatedAtMs: Number(nowMs) || null,
    },
  };
}

/** 画面・ログに出す形（**件数と状態だけ**。PII も secret も入れない） */
export function describeControlResult({ op, state }) {
  const s = normalizeRolloutState(state);
  return {
    op,
    stage: s.stage,
    dailyLimit: s.dailyLimit,
    alwaysArmed: s.alwaysArmed,
    armedFor: s.armedFor,
    killed: s.killed,
    version: s.version,
    updatedAt: s.updatedAtMs ? new Date(s.updatedAtMs).toISOString() : null,
  };
}

export default planRolloutStart;
