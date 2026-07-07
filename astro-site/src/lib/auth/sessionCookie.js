/**
 * sessionCookie.js — Set-Cookie 文字列生成（ランタイム非依存・純粋関数）
 *
 * 属性は固定または安全な既定値にする:
 *   HttpOnly / Secure / SameSite=Lax / Path=/ / Max-Age / 名前 ak_session
 * 削除用 Cookie（Max-Age=0）も同じ属性で生成できる。
 */

import { SESSION_COOKIE_NAME } from './constants.js';

const DEFAULT_PATH = '/';
const DEFAULT_SAMESITE = 'Lax';

/**
 * Cookie 属性を組み立てる（HttpOnly / Secure は常に固定）。
 * @param {number} maxAgeSeconds
 * @param {{ path?: string, sameSite?: string }} [opts]
 * @returns {string} "ak_session=<value>; ..."
 */
function serialize(name, value, maxAgeSeconds, opts = {}) {
  const path = opts.path ?? DEFAULT_PATH;
  const sameSite = opts.sameSite ?? DEFAULT_SAMESITE;
  const attrs = [
    `${name}=${value}`,
    `Max-Age=${maxAgeSeconds}`,
    `Path=${path}`,
    `SameSite=${sameSite}`,
    'HttpOnly',
    'Secure',
  ];
  return attrs.join('; ');
}

/**
 * セッション Cookie（Set-Cookie 値）を生成する。
 * @param {string} token 署名済みセッショントークン
 * @param {{ maxAgeSeconds: number, path?: string, sameSite?: string }} opts
 * @returns {string}
 */
export function serializeSessionCookie(token, opts) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('serializeSessionCookie: token must be a non-empty string');
  }
  const maxAgeSeconds = opts?.maxAgeSeconds;
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new Error('serializeSessionCookie: maxAgeSeconds must be a positive integer');
  }
  return serialize(SESSION_COOKIE_NAME, token, maxAgeSeconds, opts);
}

/**
 * ログアウト（削除）用 Cookie を生成する。
 * Max-Age=0・値空・同一 Path/SameSite・Secure/HttpOnly。
 * @param {{ path?: string, sameSite?: string }} [opts]
 * @returns {string}
 */
export function serializeLogoutCookie(opts = {}) {
  return serialize(SESSION_COOKIE_NAME, '', 0, opts);
}

/**
 * Cookie ヘッダ文字列から ak_session の値を取り出す（Edge/Function 共通ヘルパ）。
 * 見つからなければ null。復号・検証はしない（呼び出し側で verifySession する）。
 * @param {string|null|undefined} cookieHeader
 * @returns {string|null}
 */
export function readSessionCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === SESSION_COOKIE_NAME) {
      const val = part.slice(idx + 1).trim();
      return val.length > 0 ? val : null;
    }
  }
  return null;
}
