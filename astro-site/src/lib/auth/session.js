/**
 * session.js — 有料セッションの発行 / 検証オーケストレータ（ランタイム非依存）
 *
 * トークン形式:  <base64url(payload JSON, UTF-8)>.<base64url(HMAC-SHA256)>
 *   - 署名対象（signingInput）は 1 つ目の base64url payload 文字列そのもの。
 *   - payload と署名は '.' で分離する。
 *
 * 設計原則:
 *   - 秘密鍵は必ず引数注入。デフォルト鍵・環境変数参照なし。
 *   - free plan では発行不可。
 *   - 検証は fail closed。例外を外へ漏らさず、構造化された理由を返す。
 *   - ログに payload / email 相当 / secret を出さない（この層は console を使わない）。
 */

import { MAX_SESSION_TTL_MS, CLOCK_SKEW_MS } from './constants.js';
import { checkSecret, signHmac, verifyHmac, SecretError } from './sessionCrypto.js';
import { utf8ToBase64url, base64urlToUtf8 } from './encoding.js';
import { buildPayload, validatePayload } from './sessionPayload.js';

/** verifySession が返す失敗理由（構造化）。 */
export const VERIFY_REJECT = Object.freeze({
  MISSING_COOKIE: 'missing_cookie',
  MALFORMED_TOKEN: 'malformed_token',
  DECODE_ERROR: 'base64url_decode_error',
  JSON_ERROR: 'json_parse_error',
  SIGNATURE_INVALID: 'signature_invalid',
  KEY_MISSING: 'key_missing',
  INTERNAL_ERROR: 'internal_error',
});

/**
 * セッショントークンを発行する。
 *
 * @param {{
 *   secret: string,
 *   sub: string,
 *   plan: unknown,
 *   venueAccess: unknown,
 *   sessionVersion?: number,
 *   now: number,
 *   ttlMs: number,
 *   maxTtlMs?: number,
 *   subtle?: SubtleCrypto,
 * }} input
 * @returns {Promise<{ token: string, payload: import('./sessionPayload.js').SessionPayload }>}
 * @throws {SecretError} 鍵が空 / 短すぎ / 非文字列
 * @throws {Error}       payload 構築に失敗（free plan / venue 不明 / TTL 超過 など、code 付き）
 */
export async function createSession(input) {
  const maxTtlMs = input.maxTtlMs ?? MAX_SESSION_TTL_MS;

  // 鍵検証を先に（fail closed）
  const secretCheck = checkSecret(input.secret);
  if (!secretCheck.ok) throw new SecretError(secretCheck.reason);

  const built = buildPayload({
    sub: input.sub,
    plan: input.plan,
    venueAccess: input.venueAccess,
    sessionVersion: input.sessionVersion,
    issuedAt: input.now,
    ttlMs: input.ttlMs,
    maxTtlMs,
  });
  if (!built.ok) {
    const err = new Error('createSession: payload rejected');
    err.code = built.reason;
    throw err;
  }

  const payloadPart = utf8ToBase64url(JSON.stringify(built.payload));
  const signature = await signHmac({
    secret: input.secret,
    signingInput: payloadPart,
    subtle: input.subtle,
  });
  return { token: `${payloadPart}.${signature}`, payload: built.payload };
}

/**
 * セッショントークンを検証する。例外は投げず、必ず構造化結果を返す。
 *
 * token か cookieValue のどちらかを渡す（両方省略は missing_cookie）。
 *
 * @param {{
 *   token?: string|null,
 *   cookieValue?: string|null,
 *   secret: string,
 *   now: number,
 *   maxTtlMs?: number,
 *   clockSkewMs?: number,
 *   subtle?: SubtleCrypto,
 * }} input
 * @returns {Promise<{ ok: true, payload: import('./sessionPayload.js').SessionPayload } | { ok: false, reason: string }>}
 */
export async function verifySession(input) {
  try {
    const maxTtlMs = input.maxTtlMs ?? MAX_SESSION_TTL_MS;
    const clockSkewMs = input.clockSkewMs ?? CLOCK_SKEW_MS;

    // 鍵欠落 → fail closed
    if (!checkSecret(input.secret).ok) {
      return { ok: false, reason: VERIFY_REJECT.KEY_MISSING };
    }

    const token = input.token ?? input.cookieValue;
    if (typeof token !== 'string' || token.length === 0) {
      return { ok: false, reason: VERIFY_REJECT.MISSING_COOKIE };
    }

    // 区切りは厳密に 1 個（parts.length === 2）
    const parts = token.split('.');
    if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
      return { ok: false, reason: VERIFY_REJECT.MALFORMED_TOKEN };
    }
    const [payloadPart, signaturePart] = parts;

    // 署名検証（timing-safe / base64url 破損なら false）
    const sigOk = await verifyHmac({
      secret: input.secret,
      signingInput: payloadPart,
      signatureB64url: signaturePart,
      subtle: input.subtle,
    });
    if (!sigOk) return { ok: false, reason: VERIFY_REJECT.SIGNATURE_INVALID };

    // payload デコード
    let json;
    try {
      json = base64urlToUtf8(payloadPart);
    } catch {
      return { ok: false, reason: VERIFY_REJECT.DECODE_ERROR };
    }
    let payload;
    try {
      payload = JSON.parse(json);
    } catch {
      return { ok: false, reason: VERIFY_REJECT.JSON_ERROR };
    }

    // 構造・意味・時刻検証
    const validated = validatePayload(payload, { now: input.now, maxTtlMs, clockSkewMs });
    if (!validated.ok) return { ok: false, reason: validated.reason };

    return { ok: true, payload: validated.payload };
  } catch {
    // 予期しない例外は理由だけ返す（メッセージ・payload・secret は漏らさない）
    return { ok: false, reason: VERIFY_REJECT.INTERNAL_ERROR };
  }
}
