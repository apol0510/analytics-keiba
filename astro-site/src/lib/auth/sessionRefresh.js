/**
 * sessionRefresh.js — ak_session の refresh 可否を判定する純粋ロジック（ランタイム非依存）
 *
 * 前提: 呼び出し側は先に verifySession() を通し、署名・スキーマ・idle 期限・（v2 なら）絶対 TTL を
 *       検証済みの payload を渡すこと。ここでは Airtable 由来の最新 membership と突き合わせ、
 *       「再発行するか / そのままか / 拒否か」だけを決める。I/O・env・秘密鍵には触れない。
 *
 * 判定の骨子:
 *   - membership が PAID でなければ拒否（退会・停止・期限切れ・降格 free 化はここで止まる）
 *   - Cookie の sessionVersion が Airtable の最新と一致しなければ拒否（遠隔失効）
 *   - sessionStart（v1 は now を採用＝この refresh 時刻を新しい起点にする）から
 *     絶対 TTL を超えていれば拒否
 *   - v1 は常に v2 へ移行（reissue）。v2 は残り idle TTL が閾値以下のときだけ reissue、
 *     それ以外は keep（再発行しない）
 *   - reissue の plan / venue / sessionVersion は **membership（最新 Airtable）** を採用し、
 *     旧 Cookie の値では上書きしない。sessionStart は引き継ぐ（延命防止）
 */

import {
  SESSION_SCHEMA_VERSION_V2,
  ABSOLUTE_SESSION_TTL_MS,
} from './constants.js';
import { MEMBER_TYPE } from './memberResolution.js';
import { DEFAULT_SESSION_TTL_MS } from './sessionIssuance.js';

/** 残り idle TTL がこの値以下になったら再発行する（それ未満の頻繁な再発行を避ける）。 */
export const REFRESH_THRESHOLD_MS = 5 * 60 * 1000; // 5分

export const REFRESH_DECISION = Object.freeze({
  REISSUE: 'reissue', // 新しい ak_session を Set-Cookie する
  KEEP: 'keep',       // 十分な残 TTL。Set-Cookie しない（204 相当）
  REJECT: 'reject',   // 更新不可。Cookie を削除して認可拒否
});

export const REFRESH_REJECT = Object.freeze({
  INVALID_INPUT: 'invalid_input',
  NOT_PAID: 'not_paid',
  SESSION_VERSION_MISMATCH: 'session_version_mismatch',
  ABSOLUTE_EXPIRED: 'absolute_expired',
});

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * refresh 後に採用する sessionStart を決める。
 *   - v2 payload: 既存 sessionStart を引き継ぐ（初回ログイン時刻を保持）
 *   - v1 payload: sessionStart が無いので、この refresh 時刻（now）を新しい起点にする（v1→v2 移行）
 * @param {object} payload verifySession を通った payload
 * @param {number} now
 * @returns {number}
 */
export function resolveCarriedSessionStart(payload, now) {
  if (
    payload &&
    payload.v === SESSION_SCHEMA_VERSION_V2 &&
    isFiniteNumber(payload.sessionStart)
  ) {
    return payload.sessionStart;
  }
  return now;
}

/**
 * refresh 判定。
 *
 * @param {{
 *   payload: object,              // verifySession を通った payload（v1 または v2）
 *   membership: object,          // resolveMembership の結果（最新 Airtable）
 *   now: number,
 *   idleTtlMs?: number,          // 既定 20分
 *   absoluteTtlMs?: number,      // 既定 12時間
 *   refreshThresholdMs?: number, // 既定 5分
 * }} input
 * @returns {
 *   { decision: 'reissue', sessionStart: number, ttlMs: number,
 *     plan: string, venueAccess: string[], sessionVersion: number, recordId: string|null }
 *   | { decision: 'keep' }
 *   | { decision: 'reject', reason: string }
 * }
 */
export function decideRefresh(input) {
  const {
    payload,
    membership,
    now,
    idleTtlMs = DEFAULT_SESSION_TTL_MS,
    absoluteTtlMs = ABSOLUTE_SESSION_TTL_MS,
    refreshThresholdMs = REFRESH_THRESHOLD_MS,
  } = input || {};

  if (!payload || typeof payload !== 'object' || !isFiniteNumber(now)) {
    return { decision: REFRESH_DECISION.REJECT, reason: REFRESH_REJECT.INVALID_INPUT };
  }

  // 退会 / 停止 / 期限切れ / free 降格 は membership 側で PAID 以外になる → 拒否
  if (!membership || membership.memberType !== MEMBER_TYPE.PAID) {
    return { decision: REFRESH_DECISION.REJECT, reason: REFRESH_REJECT.NOT_PAID };
  }

  // sessionVersion 照合（Airtable 側で +1 された＝遠隔失効なら拒否）
  const cookieSv = payload.sessionVersion;
  const memberSv = Number.isInteger(membership.sessionVersion) ? membership.sessionVersion : 0;
  if (!Number.isInteger(cookieSv) || cookieSv !== memberSv) {
    return { decision: REFRESH_DECISION.REJECT, reason: REFRESH_REJECT.SESSION_VERSION_MISMATCH };
  }

  // 絶対 TTL（初回ログイン起点。v1 は now を起点にするため必ず範囲内）
  const sessionStart = resolveCarriedSessionStart(payload, now);
  if (now - sessionStart >= absoluteTtlMs) {
    return { decision: REFRESH_DECISION.REJECT, reason: REFRESH_REJECT.ABSOLUTE_EXPIRED };
  }

  const isV2 = payload.v === SESSION_SCHEMA_VERSION_V2;
  const remainingIdle = isFiniteNumber(payload.expiresAt) ? payload.expiresAt - now : 0;

  // v2 でまだ残 TTL が十分 → 再発行しない
  if (isV2 && remainingIdle > refreshThresholdMs) {
    return { decision: REFRESH_DECISION.KEEP };
  }

  // reissue（v1 は常にここ＝v2 へ移行）。
  // expiresAt が絶対期限を越えないよう ttl を上限で丸める。
  const absoluteRemaining = sessionStart + absoluteTtlMs - now; // > 0（上で確認済み）
  const ttlMs = Math.min(idleTtlMs, absoluteRemaining);

  return {
    decision: REFRESH_DECISION.REISSUE,
    sessionStart,
    ttlMs,
    plan: membership.normalizedPlan,
    venueAccess: membership.venueAccess,
    sessionVersion: memberSv,
    recordId: membership.recordId,
  };
}
