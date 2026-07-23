/**
 * sessionIssuance.js — 会員判定結果から ak_session Cookie を発行するオーケストレータ
 *
 * PR-B スコープ: verify-magic-link / logout Function が使う薄い純粋層。
 *   - 秘密鍵は呼び出し側が env から読んで渡す。ここでは env を読まない・fallback 鍵を持たない。
 *   - free / denied では発行しない（paid のみ）。
 *   - 失敗は例外を投げず構造化結果で返す（fail closed）。
 */

import { checkSecret } from './sessionCrypto.js';
import { createSessionV2 } from './session.js';
import { serializeSessionCookie, serializeLogoutCookie } from './sessionCookie.js';
import { MEMBER_TYPE } from './memberResolution.js';

/**
 * 有料セッションの通常 idle TTL（Cookie 寿命）。
 * 2026-07-24: 会員の再ログイン負担軽減のため 20分 → 30日へ。この期間アクセスが無ければ
 * Cookie が失効し再ログインが必要。アクセスがあれば refresh-session が Airtable を再照会
 * のうえ延長する（絶対上限 90日）。ライブラリ絶対上限 MAX_SESSION_TTL_MS(31日) の範囲内。
 */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const ISSUE_REJECT = Object.freeze({
  NOT_PAID: 'not_paid',
  SECRET_INVALID: 'secret_invalid',
  BUILD_FAILED: 'build_failed',
});

/**
 * env から読んだ秘密鍵の妥当性を判定する（値そのものは返さない・ログしない）。
 * @param {unknown} rawSecret
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkSigningSecret(rawSecret) {
  return checkSecret(rawSecret);
}

/**
 * paid 会員に対して ak_session Cookie を発行する。
 * paid 以外・鍵不正・payload 構築失敗はいずれも { ok:false } を返す（Cookie を作らない）。
 *
 * v2 セッション（sessionStart 付き）を発行する。
 *   - 初回ログイン: sessionStart 省略 → now（= issuedAt）が起点になる
 *   - refresh:      呼び出し側が既存 payload の sessionStart を渡し、初回ログイン時刻を保持する
 *
 * @param {{
 *   membership: { memberType: string, normalizedPlan: string|null, venueAccess: string[], sessionVersion: number, recordId: string|null },
 *   secret: string,
 *   now: number,
 *   ttlMs?: number,
 *   sessionStart?: number,
 *   subtle?: SubtleCrypto,
 * }} input
 * @returns {Promise<{ ok: true, cookie: string, token: string, payload: object }
 *   | { ok: false, reason: string }>}
 */
export async function issuePaidSessionCookie(input) {
  const { membership, secret, now, subtle } = input;
  const ttlMs = input.ttlMs ?? DEFAULT_SESSION_TTL_MS;

  if (!membership || membership.memberType !== MEMBER_TYPE.PAID) {
    return { ok: false, reason: ISSUE_REJECT.NOT_PAID };
  }
  if (!checkSecret(secret).ok) {
    return { ok: false, reason: ISSUE_REJECT.SECRET_INVALID };
  }

  let created;
  try {
    created = await createSessionV2({
      secret,
      sub: membership.recordId,
      plan: membership.normalizedPlan,
      venueAccess: membership.venueAccess,
      sessionVersion: membership.sessionVersion ?? 0,
      now,
      ttlMs,
      sessionStart: input.sessionStart, // 省略時は createSessionV2 が now を採用
      subtle,
    });
  } catch {
    // SecretError / payload 拒否（free plan・venue 不明・TTL 超過 等）。
    // メッセージは外に出さず理由コードのみ。
    return { ok: false, reason: ISSUE_REJECT.BUILD_FAILED };
  }

  const cookie = serializeSessionCookie(created.token, {
    maxAgeSeconds: Math.floor(ttlMs / 1000),
  });
  return { ok: true, cookie, token: created.token, payload: created.payload };
}

/**
 * ログアウト用（削除）Cookie を返す。PR-A の serializer をそのまま使う。
 * @returns {string} Set-Cookie 値（ak_session=; Max-Age=0; 同一属性）
 */
export function buildLogoutCookie() {
  return serializeLogoutCookie();
}
