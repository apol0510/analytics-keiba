/**
 * sessionPayload.js — セッション payload の生成 / 検証（ランタイム非依存・純粋関数）
 *
 * payload には最小限の情報だけを入れる。氏名 / points / 支払情報 / 内部メモ /
 * Airtable レコード全体は **入れない**（ALLOWED_PAYLOAD_KEYS で強制）。
 *
 * @typedef {Object} SessionPayload
 * @property {number}   v             スキーマバージョン（整数, == SESSION_SCHEMA_VERSION）
 * @property {string}   sub           顧客の不透明 ID（Airtable recordId 等。email ではない）
 * @property {string}   plan          正規プラン（有料のみ。free は不可）
 * @property {string[]} venueAccess   正規 venue 配列（例: ['jra'] / ['jra','nankan']）
 * @property {number}   sessionVersion 失効管理用の整数（>= 0）
 * @property {number}   issuedAt      発行時刻（ms epoch）
 * @property {number}   expiresAt     失効時刻（ms epoch, > issuedAt）
 */

import {
  SESSION_SCHEMA_VERSION,
  SESSION_SCHEMA_VERSION_V2,
  SUPPORTED_SCHEMA_VERSIONS,
  ALLOWED_PAYLOAD_KEYS,
  ALLOWED_PAYLOAD_KEYS_V2,
  MAX_SESSION_TTL_MS,
  CLOCK_SKEW_MS,
  ABSOLUTE_SESSION_TTL_MS,
} from './constants.js';
import {
  normalizePlan,
  isPaidPlan,
  isValidVenueAccessArray,
  normalizeVenueAccess,
} from './planNormalization.js';

const ALLOWED_KEY_SET_V1 = new Set(ALLOWED_PAYLOAD_KEYS);
const ALLOWED_KEY_SET_V2 = new Set(ALLOWED_PAYLOAD_KEYS_V2);
const SUPPORTED_VERSION_SET = new Set(SUPPORTED_SCHEMA_VERSIONS);

/** 検証失敗理由コード（構造化。人間可読メッセージは付けない）。 */
export const PAYLOAD_REJECT = Object.freeze({
  NOT_OBJECT: 'payload_not_object',
  IS_ARRAY: 'payload_is_array',
  UNEXPECTED_FIELD: 'unexpected_field',
  UNKNOWN_VERSION: 'unknown_version',
  MISSING_SUB: 'missing_sub',
  INVALID_SUB: 'invalid_sub',
  UNKNOWN_PLAN: 'unknown_plan',
  FREE_PLAN: 'free_plan_not_allowed',
  UNKNOWN_VENUE: 'unknown_venue',
  MISSING_SESSION_VERSION: 'missing_session_version',
  INVALID_SESSION_VERSION: 'invalid_session_version',
  INVALID_TIME: 'invalid_time',
  EXPIRES_NOT_AFTER_ISSUED: 'expires_not_after_issued',
  TTL_EXCEEDED: 'ttl_exceeded',
  ISSUED_IN_FUTURE: 'issued_in_future',
  EXPIRED: 'expired',
  NOT_YET_VALID: 'not_yet_valid',
  // v2 専用（sessionStart / 絶対 TTL）
  MISSING_SESSION_START: 'missing_session_start',
  INVALID_SESSION_START: 'invalid_session_start',
  SESSION_START_AFTER_ISSUED: 'session_start_after_issued',
  SESSION_START_IN_FUTURE: 'session_start_in_future',
  ABSOLUTE_EXPIRED: 'absolute_expired',
});

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * payload の構造・型・意味を検証する。
 * 時刻依存（期限切れ / 未来発行）チェックは now を渡したときのみ行う。
 *
 * @param {unknown} payload
 * @param {{ now?: number, maxTtlMs?: number, clockSkewMs?: number, absoluteTtlMs?: number }} [opts]
 * @returns {{ ok: true, payload: SessionPayload } | { ok: false, reason: string }}
 */
export function validatePayload(payload, opts = {}) {
  const maxTtlMs = opts.maxTtlMs ?? MAX_SESSION_TTL_MS;
  const clockSkewMs = opts.clockSkewMs ?? CLOCK_SKEW_MS;
  const absoluteTtlMs = opts.absoluteTtlMs ?? ABSOLUTE_SESSION_TTL_MS;

  if (Array.isArray(payload)) return { ok: false, reason: PAYLOAD_REJECT.IS_ARRAY };
  if (!isPlainObject(payload)) return { ok: false, reason: PAYLOAD_REJECT.NOT_OBJECT };

  // v（先に版を確定してから、版ごとの allow-list を選ぶ）
  if (!SUPPORTED_VERSION_SET.has(payload.v)) return { ok: false, reason: PAYLOAD_REJECT.UNKNOWN_VERSION };
  const isV2 = payload.v === SESSION_SCHEMA_VERSION_V2;
  const allowSet = isV2 ? ALLOWED_KEY_SET_V2 : ALLOWED_KEY_SET_V1;

  // allow-list 外のキー（機密情報など）を含む payload は拒否。
  // v1 に sessionStart が来た場合も v1 allow-list 外なのでここで弾かれる（版を跨いだ混入を防ぐ）。
  for (const key of Object.keys(payload)) {
    if (!allowSet.has(key)) return { ok: false, reason: PAYLOAD_REJECT.UNEXPECTED_FIELD };
  }

  // sub
  if (!('sub' in payload) || payload.sub === undefined || payload.sub === null) {
    return { ok: false, reason: PAYLOAD_REJECT.MISSING_SUB };
  }
  if (typeof payload.sub !== 'string' || payload.sub.trim().length === 0) {
    return { ok: false, reason: PAYLOAD_REJECT.INVALID_SUB };
  }

  // plan
  const plan = normalizePlan(payload.plan);
  if (plan === null) return { ok: false, reason: PAYLOAD_REJECT.UNKNOWN_PLAN };
  if (!isPaidPlan(plan)) return { ok: false, reason: PAYLOAD_REJECT.FREE_PLAN };
  // payload には正規値が入っている前提。生値のブレは拒否（発行側で正規化しておくこと）
  if (payload.plan !== plan) return { ok: false, reason: PAYLOAD_REJECT.UNKNOWN_PLAN };

  // venueAccess
  if (!isValidVenueAccessArray(payload.venueAccess)) {
    return { ok: false, reason: PAYLOAD_REJECT.UNKNOWN_VENUE };
  }

  // sessionVersion
  if (!('sessionVersion' in payload) || payload.sessionVersion === undefined || payload.sessionVersion === null) {
    return { ok: false, reason: PAYLOAD_REJECT.MISSING_SESSION_VERSION };
  }
  if (!Number.isInteger(payload.sessionVersion) || payload.sessionVersion < 0) {
    return { ok: false, reason: PAYLOAD_REJECT.INVALID_SESSION_VERSION };
  }

  // issuedAt / expiresAt
  if (!isFiniteNumber(payload.issuedAt) || !isFiniteNumber(payload.expiresAt)) {
    return { ok: false, reason: PAYLOAD_REJECT.INVALID_TIME };
  }
  if (payload.expiresAt <= payload.issuedAt) {
    return { ok: false, reason: PAYLOAD_REJECT.EXPIRES_NOT_AFTER_ISSUED };
  }
  if (payload.expiresAt - payload.issuedAt > maxTtlMs) {
    return { ok: false, reason: PAYLOAD_REJECT.TTL_EXCEEDED };
  }

  // sessionStart（v2 必須。v1 は持たない）
  if (isV2) {
    if (!('sessionStart' in payload) || payload.sessionStart === undefined || payload.sessionStart === null) {
      return { ok: false, reason: PAYLOAD_REJECT.MISSING_SESSION_START };
    }
    if (!isFiniteNumber(payload.sessionStart)) {
      return { ok: false, reason: PAYLOAD_REJECT.INVALID_SESSION_START };
    }
    // sessionStart は必ず発行時刻以前（refresh でも初回ログイン時刻を保持する）
    if (payload.sessionStart > payload.issuedAt) {
      return { ok: false, reason: PAYLOAD_REJECT.SESSION_START_AFTER_ISSUED };
    }
  }

  // 時刻依存チェック（now が与えられたときのみ）
  if (opts.now !== undefined) {
    const now = opts.now;
    if (payload.issuedAt > now + clockSkewMs) {
      return { ok: false, reason: PAYLOAD_REJECT.ISSUED_IN_FUTURE };
    }
    // 期限切れ判定に clock skew の猶予は足さない（skew で有効期限を延長しない）
    if (now > payload.expiresAt) {
      return { ok: false, reason: PAYLOAD_REJECT.EXPIRED };
    }
    if (isV2) {
      // 未来すぎる sessionStart は不正（skew 分だけ許容）
      if (payload.sessionStart > now + clockSkewMs) {
        return { ok: false, reason: PAYLOAD_REJECT.SESSION_START_IN_FUTURE };
      }
      // 絶対 TTL 超過（初回ログインから 12 時間）。refresh を跨いでも sessionStart は不変なので
      // ここで確実に打ち切られる。skew の猶予は足さない（延命に使わない）。
      if (now - payload.sessionStart >= absoluteTtlMs) {
        return { ok: false, reason: PAYLOAD_REJECT.ABSOLUTE_EXPIRED };
      }
    }
  }

  return { ok: true, payload: /** @type {SessionPayload} */ (payload) };
}

/**
 * 発行用 payload を組み立てる（正規化込み）。検証に通る payload だけを返す。
 * ここでは署名しない（sessionCrypto の責務）。
 *
 * @param {{
 *   sub: string,
 *   plan: unknown,
 *   venueAccess: unknown,
 *   sessionVersion?: number,
 *   issuedAt: number,
 *   ttlMs: number,
 *   maxTtlMs?: number,
 * }} input
 * @returns {{ ok: true, payload: SessionPayload } | { ok: false, reason: string }}
 */
export function buildPayload(input) {
  const maxTtlMs = input.maxTtlMs ?? MAX_SESSION_TTL_MS;

  if (typeof input.sub !== 'string' || input.sub.trim().length === 0) {
    return { ok: false, reason: PAYLOAD_REJECT.INVALID_SUB };
  }
  const plan = normalizePlan(input.plan);
  if (plan === null) return { ok: false, reason: PAYLOAD_REJECT.UNKNOWN_PLAN };
  if (!isPaidPlan(plan)) return { ok: false, reason: PAYLOAD_REJECT.FREE_PLAN };

  const venueAccess = normalizeVenueAccess(input.venueAccess);
  if (venueAccess === null) return { ok: false, reason: PAYLOAD_REJECT.UNKNOWN_VENUE };

  const sessionVersion = input.sessionVersion ?? 0;
  if (!Number.isInteger(sessionVersion) || sessionVersion < 0) {
    return { ok: false, reason: PAYLOAD_REJECT.INVALID_SESSION_VERSION };
  }

  if (!isFiniteNumber(input.issuedAt)) return { ok: false, reason: PAYLOAD_REJECT.INVALID_TIME };
  if (!isFiniteNumber(input.ttlMs) || input.ttlMs <= 0) {
    return { ok: false, reason: PAYLOAD_REJECT.EXPIRES_NOT_AFTER_ISSUED };
  }
  if (input.ttlMs > maxTtlMs) return { ok: false, reason: PAYLOAD_REJECT.TTL_EXCEEDED };

  const payload = {
    v: SESSION_SCHEMA_VERSION,
    sub: input.sub,
    plan,
    venueAccess,
    sessionVersion,
    issuedAt: input.issuedAt,
    expiresAt: input.issuedAt + input.ttlMs,
  };

  // 生成物を自己検証（allow-list・順序含め確実に妥当なものだけ返す）
  const check = validatePayload(payload, { maxTtlMs });
  if (!check.ok) return check;
  return { ok: true, payload };
}

/**
 * v2 発行用 payload を組み立てる（sessionStart 必須）。
 * - 初回ログイン: sessionStart 省略 → issuedAt を採用（sessionStart === issuedAt）
 * - refresh:      呼び出し側が既存 payload の sessionStart をそのまま渡す（初回ログイン時刻を保持）
 * sessionStart は現在時刻へ更新しないこと（絶対 TTL の起点であり、延命防止の要）。
 *
 * @param {{
 *   sub: string,
 *   plan: unknown,
 *   venueAccess: unknown,
 *   sessionVersion?: number,
 *   issuedAt: number,
 *   ttlMs: number,
 *   sessionStart?: number,
 *   maxTtlMs?: number,
 * }} input
 * @returns {{ ok: true, payload: SessionPayload } | { ok: false, reason: string }}
 */
export function buildPayloadV2(input) {
  const maxTtlMs = input.maxTtlMs ?? MAX_SESSION_TTL_MS;

  if (typeof input.sub !== 'string' || input.sub.trim().length === 0) {
    return { ok: false, reason: PAYLOAD_REJECT.INVALID_SUB };
  }
  const plan = normalizePlan(input.plan);
  if (plan === null) return { ok: false, reason: PAYLOAD_REJECT.UNKNOWN_PLAN };
  if (!isPaidPlan(plan)) return { ok: false, reason: PAYLOAD_REJECT.FREE_PLAN };

  const venueAccess = normalizeVenueAccess(input.venueAccess);
  if (venueAccess === null) return { ok: false, reason: PAYLOAD_REJECT.UNKNOWN_VENUE };

  const sessionVersion = input.sessionVersion ?? 0;
  if (!Number.isInteger(sessionVersion) || sessionVersion < 0) {
    return { ok: false, reason: PAYLOAD_REJECT.INVALID_SESSION_VERSION };
  }

  if (!isFiniteNumber(input.issuedAt)) return { ok: false, reason: PAYLOAD_REJECT.INVALID_TIME };
  if (!isFiniteNumber(input.ttlMs) || input.ttlMs <= 0) {
    return { ok: false, reason: PAYLOAD_REJECT.EXPIRES_NOT_AFTER_ISSUED };
  }
  if (input.ttlMs > maxTtlMs) return { ok: false, reason: PAYLOAD_REJECT.TTL_EXCEEDED };

  // sessionStart: 省略時は初回ログインとみなし issuedAt を採用
  const sessionStart = input.sessionStart ?? input.issuedAt;
  if (!isFiniteNumber(sessionStart)) return { ok: false, reason: PAYLOAD_REJECT.INVALID_SESSION_START };
  if (sessionStart > input.issuedAt) return { ok: false, reason: PAYLOAD_REJECT.SESSION_START_AFTER_ISSUED };

  const payload = {
    v: SESSION_SCHEMA_VERSION_V2,
    sub: input.sub,
    plan,
    venueAccess,
    sessionVersion,
    issuedAt: input.issuedAt,
    expiresAt: input.issuedAt + input.ttlMs,
    sessionStart,
  };

  const check = validatePayload(payload, { maxTtlMs });
  if (!check.ok) return check;
  return { ok: true, payload };
}
