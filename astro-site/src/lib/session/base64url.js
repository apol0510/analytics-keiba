/**
 * session/base64url.js — ランタイム非依存の base64url encode/decode（PR-A）
 *
 * Buffer に依存しない。globalThis の TextEncoder/TextDecoder と btoa/atob を使う
 * （Node 20+ / Deno / ブラウザいずれもグローバルに存在）。fs / env は参照しない。
 */

function requireGlobals() {
  const g = globalThis;
  if (typeof g.btoa !== 'function' || typeof g.atob !== 'function') {
    throw new Error('BASE64_UNSUPPORTED_RUNTIME');
  }
  if (typeof g.TextEncoder !== 'function' || typeof g.TextDecoder !== 'function') {
    throw new Error('TEXTCODER_UNSUPPORTED_RUNTIME');
  }
  return g;
}

/** Uint8Array -> base64url 文字列（パディング無し） */
export function bytesToBase64url(bytes) {
  requireGlobals();
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return globalThis
    .btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** base64url 文字列 -> Uint8Array（不正文字・破損は例外） */
export function base64urlToBytes(str) {
  requireGlobals();
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) {
    throw new Error('BAD_BASE64URL_CHARSET');
  }
  const padLen = (4 - (str.length % 4)) % 4;
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padLen);
  // atob は不正入力で例外を投げる → 呼び出し側で BAD_BASE64 として扱う
  const binary = globalThis.atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** 文字列（ASCII/UTF-8）-> Uint8Array */
export function stringToBytes(str) {
  requireGlobals();
  return new globalThis.TextEncoder().encode(str);
}

/** Uint8Array -> 文字列（UTF-8） */
export function bytesToString(bytes) {
  requireGlobals();
  return new globalThis.TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** オブジェクト -> base64url(JSON) */
export function jsonToBase64url(obj) {
  return bytesToBase64url(stringToBytes(JSON.stringify(obj)));
}

/** base64url(JSON) -> オブジェクト（破損は例外） */
export function base64urlToJson(str) {
  const bytes = base64urlToBytes(str);
  const json = bytesToString(bytes);
  return JSON.parse(json);
}
