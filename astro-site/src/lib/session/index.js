/**
 * session/index.js — 有料セッション共通ライブラリ 公開 API（PR-A）
 *
 * createSession / verifySession（HMAC-SHA256 署名 Cookie トークン）と Cookie 生成を提供。
 * 秘密鍵は必ず引数注入（デフォルト秘密鍵は持たない）。鍵欠落・不正は fail closed。
 * free plan では発行不可。ランタイム非依存（Web Crypto を globalThis/引数から使用）。
 *
 * トークン形式: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payloadB64))
 */

import { MAX_TTL_SECONDS, MIN_SECRET_LENGTH, SESSION_SCHEMA_VERSION } from './constants.js';
import { normalizePlan, isPaidPlan, normalizeVenue } from './normalize.js';
import { validatePayload } from './payload.js';
import { hmacSign, hmacVerify } from './crypto.js';
import { jsonToBase64url, base64urlToJson, bytesToBase64url, base64urlToBytes } from './base64url.js';

export { serializeSessionCookie, serializeLogoutCookie } from './cookie.js';
export { normalizePlan, normalizeVenue, isPaidPlan } from './normalize.js';
export { validatePayload } from './payload.js';
export * from './constants.js';

function isValidSecret(secret) {
  return typeof secret === 'string' && secret.length >= MIN_SECRET_LENGTH;
}

function nowSeconds(optNow) {
  if (typeof optNow === 'number' && Number.isInteger(optNow)) return optNow;
  // ランタイムの現在時刻（テストは now を注入するため到達しない）
  return Math.floor(Date.now() / 1000);
}

/**
 * 有料セッショントークンを生成する。
 * 失敗時は機密を含まない code 付き Error を throw（secret/payload は message に出さない）。
 *
 * @param {{ sub:string, plan:unknown, venueAccess?:unknown, sessionVersion:number }} input
 * @param {string} secret HMAC 署名鍵（32 文字以上）。デフォルト無し。
 * @param {{ ttlSeconds:number, now?:number, crypto?:object }} opts
 * @returns {Promise<string>} 署名済みトークン
 */
export async function createSession(input, secret, opts) {
  if (!isValidSecret(secret)) throw new Error('SESSION_CREATE_BAD_SECRET');
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('SESSION_CREATE_BAD_INPUT');
  }

  const plan = normalizePlan(input.plan);
  if (plan === null) throw new Error('SESSION_CREATE_UNKNOWN_PLAN');
  if (!isPaidPlan(plan)) throw new Error('SESSION_CREATE_FREE_PLAN');

  const venueAccess = normalizeVenue(input.venueAccess);
  if (venueAccess === null) throw new Error('SESSION_CREATE_UNKNOWN_VENUE');

  if (typeof input.sub !== 'string' || input.sub.trim() === '') {
    throw new Error('SESSION_CREATE_BAD_SUB');
  }
  if (!Number.isInteger(input.sessionVersion) || input.sessionVersion < 0) {
    throw new Error('SESSION_CREATE_BAD_SESSION_VERSION');
  }

  const ttl = opts && opts.ttlSeconds;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_TTL_SECONDS) {
    throw new Error('SESSION_CREATE_BAD_TTL');
  }

  const issuedAt = nowSeconds(opts && opts.now);
  const expiresAt = issuedAt + ttl;

  const payload = {
    v: SESSION_SCHEMA_VERSION,
    sub: input.sub,
    plan,
    venueAccess,
    sessionVersion: input.sessionVersion,
    issuedAt,
    expiresAt,
  };

  const payloadB64 = jsonToBase64url(payload);
  const sigBytes = await hmacSign(secret, payloadB64, opts && opts.crypto);
  const sigB64 = bytesToBase64url(sigBytes);
  return `${payloadB64}.${sigB64}`;
}

/**
 * トークンを検証する。例外を外へ漏らさず構造化した結果を返す。
 * 検証失敗の reason は機密（secret / payload 内容 / email 相当）を含まない短い列挙値。
 *
 * @param {unknown} token Cookie 値
 * @param {string} secret HMAC 署名鍵
 * @param {{ now?:number, crypto?:object, maxTtlSeconds?:number, clockSkewSeconds?:number }} [opts]
 * @returns {Promise<{ valid:true, payload:object } | { valid:false, reason:string }>}
 */
export async function verifySession(token, secret, opts) {
  try {
    // 鍵欠落/不正 → fail closed（有料アクセスを与えない）
    if (!isValidSecret(secret)) return { valid: false, reason: 'NO_SECRET' };

    if (typeof token !== 'string' || token === '') return { valid: false, reason: 'MISSING' };

    const parts = token.split('.');
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
      return { valid: false, reason: 'MALFORMED' };
    }
    const [payloadB64, sigB64] = parts;

    // 署名バイト復号（破損は BAD_BASE64）
    let sigBytes;
    try {
      sigBytes = base64urlToBytes(sigB64);
    } catch (_e) {
      return { valid: false, reason: 'BAD_BASE64' };
    }

    // 先に署名検証（timing-safe）。未認証データを解釈する前に弾く。
    const authentic = await hmacVerify(secret, payloadB64, sigBytes, opts && opts.crypto);
    if (!authentic) return { valid: false, reason: 'TAMPERED' };

    // payload 復号（署名済みなので通常成功するが防御的に catch）
    let payload;
    try {
      payload = base64urlToJson(payloadB64);
    } catch (_e) {
      return { valid: false, reason: 'BAD_JSON' };
    }

    const now = nowSeconds(opts && opts.now);
    const res = validatePayload(payload, {
      now,
      maxTtlSeconds: opts && opts.maxTtlSeconds,
      clockSkewSeconds: opts && opts.clockSkewSeconds,
    });
    if (!res.ok) return { valid: false, reason: res.reason };

    return { valid: true, payload: res.payload };
  } catch (_e) {
    // 例外・秘密鍵・payload をメッセージへ出さない
    return { valid: false, reason: 'ERROR' };
  }
}
