/**
 * encoding.js — base64url / UTF-8 変換（ランタイム非依存・純粋関数）
 *
 * Buffer に依存しない。全ランタイム共通の btoa/atob + TextEncoder/TextDecoder を使う。
 * （Node 20+ / Deno / Netlify Edge すべてで globalThis に存在する）
 */

const BASE64_STD_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Uint8Array → base64url 文字列（パディングなし）。 */
export function bytesToBase64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 = btoa(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * base64url 文字列 → Uint8Array。
 * 不正な文字集合・長さは Error を投げる（呼び出し側で decode_error として捕捉）。
 */
export function base64urlToBytes(input) {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error('base64url: empty or non-string input');
  }
  // base64url 文字集合のみ許可（'.' や空白の混入を弾く）
  if (!/^[A-Za-z0-9\-_]+$/.test(input)) {
    throw new Error('base64url: invalid character');
  }
  const b64 =
    input.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (input.length % 4)) % 4);
  if (!BASE64_STD_RE.test(b64)) {
    throw new Error('base64url: invalid padding');
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** 文字列（UTF-8）→ base64url。 */
export function utf8ToBase64url(text) {
  return bytesToBase64url(new TextEncoder().encode(text));
}

/**
 * base64url → 文字列（UTF-8）。
 * 不正なら Error を投げる。
 */
export function base64urlToUtf8(input) {
  return new TextDecoder('utf-8', { fatal: true }).decode(base64urlToBytes(input));
}
