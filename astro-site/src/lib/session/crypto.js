/**
 * session/crypto.js — HMAC-SHA256 署名/検証（Web Crypto）（PR-A）
 *
 * Node Functions / Astro middleware / Netlify Edge の 3 ランタイムで共有できるよう、
 * Web Crypto の SubtleCrypto を引数 or globalThis.crypto から取得する。
 * node:crypto / Deno 固有 API は import しない。検証は crypto.subtle.verify（timing-safe）。
 */

import { stringToBytes } from './base64url.js';

/**
 * SubtleCrypto を取得（引数優先、無ければ globalThis.crypto.subtle）。
 * 取得不能なら例外。
 */
export function resolveSubtle(cryptoLike) {
  const c = cryptoLike || (typeof globalThis !== 'undefined' ? globalThis.crypto : undefined);
  if (!c || !c.subtle || typeof c.subtle.importKey !== 'function') {
    throw new Error('WEBCRYPTO_UNAVAILABLE');
  }
  return c.subtle;
}

async function importHmacKey(subtle, secret, usages) {
  const keyBytes = stringToBytes(secret);
  return subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

/**
 * data 文字列に対する HMAC-SHA256 署名（Uint8Array を返す）。
 */
export async function hmacSign(secret, data, cryptoLike) {
  const subtle = resolveSubtle(cryptoLike);
  const key = await importHmacKey(subtle, secret, ['sign']);
  const sig = await subtle.sign('HMAC', key, stringToBytes(data));
  return new Uint8Array(sig);
}

/**
 * data 文字列に対する署名を timing-safe に検証（crypto.subtle.verify）。
 * 文字列比較は使わない。
 * @returns {Promise<boolean>}
 */
export async function hmacVerify(secret, data, signatureBytes, cryptoLike) {
  const subtle = resolveSubtle(cryptoLike);
  const key = await importHmacKey(subtle, secret, ['verify']);
  return subtle.verify('HMAC', key, signatureBytes, stringToBytes(data));
}
