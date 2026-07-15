/**
 * mediaAuth.js — 管理系 POST の認可（会員認可とは別系統の管理者認可・fail closed）
 *
 * 条件（すべて満たすときのみ ALLOW。1 つでも欠ければ書き込みに到達しない）:
 *   - method === 'POST'
 *   - PREMIUM_PLUS_ADMIN_SECRET が設定済み（未設定/短すぎ → 503 fail closed）
 *   - x-admin-secret が timing-safe 比較で一致
 *   - context === 'production'（未設定/preview/branch/dev/localhost からの本番書き込みは拒否）
 *   - Origin が本番オリジンと完全一致（欠落/不一致/複数/不正形式は拒否）
 *
 * 管理者 secret は URL/body/query に入れない前提。ここではヘッダのみを見る。
 */

import { decideRefreshOrigin, ORIGIN_DECISION } from '../auth/originPolicy.js';

export const MIN_ADMIN_SECRET_LENGTH = 16;

export const ADMIN_WRITE = Object.freeze({ ALLOW: 'allow', REJECT: 'reject' });

export const ADMIN_REJECT = Object.freeze({
  METHOD: 'method_not_allowed', // 405
  SECRET_UNAVAILABLE: 'secret_unavailable', // 503（env 未設定）
  FORBIDDEN: 'forbidden', // 403（secret 不一致）
  NON_PRODUCTION: 'non_production', // 403（本番以外からの書き込み）
  ORIGIN: 'origin', // 403（Origin 欠落/不一致）
});

const REJECT_STATUS = {
  [ADMIN_REJECT.METHOD]: 405,
  [ADMIN_REJECT.SECRET_UNAVAILABLE]: 503,
  [ADMIN_REJECT.FORBIDDEN]: 403,
  [ADMIN_REJECT.NON_PRODUCTION]: 403,
  [ADMIN_REJECT.ORIGIN]: 403,
};

/**
 * 2 つの文字列を timing-safe に比較する（WebCrypto HMAC + subtle.verify）。
 * 単純な === 比較はしない。長さの差は HMAC が吸収する。
 */
export async function timingSafeEqualString(a, b, subtle = globalThis.crypto?.subtle) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!subtle || !globalThis.crypto?.getRandomValues) return false; // fail closed
  const enc = new TextEncoder();
  const keyBytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const mac = await subtle.sign('HMAC', key, enc.encode(a));
  return subtle.verify('HMAC', key, mac, enc.encode(b));
}

function reject(reason) {
  return { decision: ADMIN_WRITE.REJECT, reason, status: REJECT_STATUS[reason] || 403 };
}

/**
 * @param {object} input
 * @param {string} input.method            HTTP method
 * @param {unknown} input.adminSecret       process.env.PREMIUM_PLUS_ADMIN_SECRET
 * @param {unknown} input.providedSecret    x-admin-secret ヘッダ
 * @param {unknown} input.origin            Origin ヘッダ
 * @param {unknown} input.context           process.env.CONTEXT
 * @param {{subtle?:SubtleCrypto}} [deps]
 * @returns {Promise<{decision:'allow'}|{decision:'reject', reason:string, status:number}>}
 */
export async function decideAdminWrite(input, deps = {}) {
  const { method, adminSecret, providedSecret, origin, context } = input || {};

  if (method !== 'POST') return reject(ADMIN_REJECT.METHOD);

  // 認証: env 由来 secret は前後の空白/改行を正規化してから評価する。
  // 環境変数ストアや設定経路（CLI/ダッシュボード/コピペ）で値の末尾に改行(\n / \r\n)や
  // 空白が混入すると、送出ヘッダが同一文字列でも byte 完全一致比較で不一致となり 403 に
  // なる（env secret の定番 footgun）。前後のみ trim し、秘密内部の空白は保持する。
  // trim 後に空/短すぎ → fail closed（503）。
  const normAdminSecret = typeof adminSecret === 'string' ? adminSecret.trim() : '';
  if (normAdminSecret.length < MIN_ADMIN_SECRET_LENGTH) {
    return reject(ADMIN_REJECT.SECRET_UNAVAILABLE);
  }
  // 送出 secret も前後空白を正規化（HTTP ヘッダの OWS 相当）。比較は timing-safe。
  const normProvidedSecret = String(providedSecret ?? '').trim();
  const matched = await timingSafeEqualString(normProvidedSecret, normAdminSecret, deps.subtle);
  if (!matched) return reject(ADMIN_REJECT.FORBIDDEN);

  // 本番 context のみ書き込み可（strictly 'production'）
  if (context !== 'production') return reject(ADMIN_REJECT.NON_PRODUCTION);

  // Origin 完全一致（本番オリジン。欠落/不一致/複数は拒否）
  if (decideRefreshOrigin({ origin, context: 'production' }) !== ORIGIN_DECISION.ALLOW) {
    return reject(ADMIN_REJECT.ORIGIN);
  }

  return { decision: ADMIN_WRITE.ALLOW };
}
