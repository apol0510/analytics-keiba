/**
 * session/payload.js — セッション payload の構造・時刻・権限の検証（PR-A）
 *
 * 純粋関数。ランタイム非依存。個人情報（氏名/points/支払/内部メモ/レコード全体）は
 * payload に含めない設計。ここでは「復号済み payload オブジェクト」を検証する。
 *
 * 検証失敗は例外にせず { ok:false, reason } を返す（reason は機密を含まない短い列挙値）。
 */

import {
  SESSION_SCHEMA_VERSION,
  MAX_TTL_SECONDS,
  CLOCK_SKEW_SECONDS,
  REQUIRED_PAYLOAD_KEYS,
  CANONICAL_PLANS,
  CANONICAL_VENUES,
  PLAN_FREE,
} from './constants.js';
import { isPaidPlan } from './normalize.js';

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInteger(v) {
  return typeof v === 'number' && Number.isInteger(v);
}

/**
 * 復号済み payload を検証する。
 * @param {unknown} payload
 * @param {{ now:number, maxTtlSeconds?:number, clockSkewSeconds?:number }} opts
 *   now = 現在時刻（epoch 秒）
 * @returns {{ ok:true, payload:object } | { ok:false, reason:string }}
 */
export function validatePayload(payload, opts) {
  const now = opts && typeof opts.now === 'number' ? opts.now : null;
  if (now === null) return { ok: false, reason: 'NO_NOW' };
  const maxTtl = (opts && opts.maxTtlSeconds) || MAX_TTL_SECONDS;
  const skew = (opts && typeof opts.clockSkewSeconds === 'number') ? opts.clockSkewSeconds : CLOCK_SKEW_SECONDS;

  // 型: オブジェクトのみ（配列/null/プリミティブ拒否）
  if (Array.isArray(payload)) return { ok: false, reason: 'PAYLOAD_ARRAY' };
  if (!isPlainObject(payload)) return { ok: false, reason: 'PAYLOAD_NOT_OBJECT' };

  // 必須キー欠落拒否
  for (const key of REQUIRED_PAYLOAD_KEYS) {
    if (!(key in payload)) return { ok: false, reason: 'MISSING_KEY' };
  }

  // version
  if (payload.v !== SESSION_SCHEMA_VERSION) return { ok: false, reason: 'UNKNOWN_VERSION' };

  // sub（会員識別子）: 非空文字列
  if (typeof payload.sub !== 'string' || payload.sub.trim() === '') {
    return { ok: false, reason: 'BAD_SUB' };
  }

  // plan: canonical かつ有料（free は拒否）
  if (typeof payload.plan !== 'string' || !CANONICAL_PLANS.includes(payload.plan)) {
    return { ok: false, reason: 'UNKNOWN_PLAN' };
  }
  if (payload.plan === PLAN_FREE || !isPaidPlan(payload.plan)) {
    return { ok: false, reason: 'FREE_PLAN' };
  }

  // venueAccess: canonical
  if (typeof payload.venueAccess !== 'string' || !CANONICAL_VENUES.includes(payload.venueAccess)) {
    return { ok: false, reason: 'UNKNOWN_VENUE' };
  }

  // sessionVersion: 0 以上の整数
  if (!isInteger(payload.sessionVersion) || payload.sessionVersion < 0) {
    return { ok: false, reason: 'BAD_SESSION_VERSION' };
  }

  // issuedAt / expiresAt: 整数（epoch 秒）
  if (!isInteger(payload.issuedAt) || !isInteger(payload.expiresAt)) {
    return { ok: false, reason: 'BAD_TIMES' };
  }
  // expiresAt <= issuedAt 拒否
  if (payload.expiresAt <= payload.issuedAt) {
    return { ok: false, reason: 'EXPIRES_BEFORE_ISSUED' };
  }
  // TTL 上限超過拒否
  if (payload.expiresAt - payload.issuedAt > maxTtl) {
    return { ok: false, reason: 'TTL_EXCEEDED' };
  }
  // issuedAt が未来すぎる（クロックスキュー超過）拒否
  if (payload.issuedAt > now + skew) {
    return { ok: false, reason: 'ISSUED_IN_FUTURE' };
  }
  // 期限切れ拒否
  if (now >= payload.expiresAt) {
    return { ok: false, reason: 'EXPIRED' };
  }

  return { ok: true, payload };
}
