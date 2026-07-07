/**
 * sessionCrypto.js — HMAC-SHA256 署名 / 検証（Web Crypto、ランタイム非依存）
 *
 * - node:crypto を import しない。globalThis.crypto.subtle（または引数注入 subtle）を使う。
 * - 検証は timing-safe な subtle.verify を使う。**単純な文字列比較はしない**。
 * - 秘密鍵は引数で受け取る。デフォルト鍵・環境変数参照は一切持たない。
 */

import { MIN_SECRET_LENGTH } from './constants.js';
import { bytesToBase64url, base64urlToBytes } from './encoding.js';

/** 鍵材料に関する失敗（メッセージに鍵の中身は含めない）。 */
export class SecretError extends Error {
  constructor(code) {
    super(`session secret rejected: ${code}`);
    this.name = 'SecretError';
    this.code = code;
  }
}

/**
 * 秘密鍵の形式検証。空 / 短すぎ / 非文字列は失敗（fail closed）。
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkSecret(secret) {
  if (typeof secret !== 'string') return { ok: false, reason: 'not_a_string' };
  if (secret.length === 0) return { ok: false, reason: 'empty' };
  if (secret.length < MIN_SECRET_LENGTH) return { ok: false, reason: 'too_short' };
  return { ok: true };
}

/** checkSecret に失敗したら SecretError を投げる。 */
export function assertSecret(secret) {
  const res = checkSecret(secret);
  if (!res.ok) throw new SecretError(res.reason);
}

/** globalThis から subtle を解決（未提供なら Error）。 */
function resolveSubtle(subtle) {
  const s = subtle ?? globalThis.crypto?.subtle;
  if (!s || typeof s.sign !== 'function' || typeof s.verify !== 'function') {
    throw new Error('WebCrypto subtle is unavailable in this runtime');
  }
  return s;
}

async function importHmacKey(subtle, secret, usages) {
  const keyData = new TextEncoder().encode(secret);
  return subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

/**
 * signingInput（文字列）を HMAC-SHA256 で署名し、base64url を返す。
 * @param {{ secret: string, signingInput: string, subtle?: SubtleCrypto }} opts
 * @returns {Promise<string>} base64url 署名
 */
export async function signHmac({ secret, signingInput, subtle }) {
  assertSecret(secret);
  const s = resolveSubtle(subtle);
  const key = await importHmacKey(s, secret, ['sign']);
  const sig = await s.sign('HMAC', key, new TextEncoder().encode(signingInput));
  return bytesToBase64url(new Uint8Array(sig));
}

/**
 * 署名（base64url）を timing-safe に検証する。
 * base64url 破損は例外を投げず false を返す。
 * @param {{ secret: string, signingInput: string, signatureB64url: string, subtle?: SubtleCrypto }} opts
 * @returns {Promise<boolean>}
 */
export async function verifyHmac({ secret, signingInput, signatureB64url, subtle }) {
  assertSecret(secret);
  const s = resolveSubtle(subtle);
  let signatureBytes;
  try {
    signatureBytes = base64urlToBytes(signatureB64url);
  } catch {
    return false;
  }
  const key = await importHmacKey(s, secret, ['verify']);
  // subtle.verify は内部で定数時間比較する（自前の === 比較はしない）
  return s.verify('HMAC', key, signatureBytes, new TextEncoder().encode(signingInput));
}
