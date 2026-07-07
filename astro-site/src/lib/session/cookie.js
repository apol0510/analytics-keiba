/**
 * session/cookie.js — Set-Cookie 文字列生成（PR-A）
 *
 * 属性は固定/安全既定: HttpOnly; Secure; SameSite=Lax; Path=/; cookie 名 ak_session。
 * ランタイム非依存（文字列組み立てのみ）。env / fs は参照しない。
 */

import { COOKIE_NAME } from './constants.js';

const BASE_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Lax';

/**
 * セッション Cookie の Set-Cookie 値を生成。
 * @param {string} token 署名済みトークン
 * @param {{ maxAgeSeconds:number }} opts
 * @returns {string}
 */
export function serializeSessionCookie(token, opts) {
  if (typeof token !== 'string' || token === '') {
    throw new Error('COOKIE_EMPTY_TOKEN');
  }
  const maxAge = opts && opts.maxAgeSeconds;
  if (!Number.isInteger(maxAge) || maxAge <= 0) {
    throw new Error('COOKIE_BAD_MAXAGE');
  }
  return `${COOKIE_NAME}=${token}; Max-Age=${maxAge}; ${BASE_ATTRS}`;
}

/**
 * 削除用 Cookie の Set-Cookie 値（Max-Age=0・同一属性）。
 * @returns {string}
 */
export function serializeLogoutCookie() {
  return `${COOKIE_NAME}=; Max-Age=0; ${BASE_ATTRS}`;
}
