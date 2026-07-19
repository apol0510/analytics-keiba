/**
 * verifyMagicLinkFlow.js — マジックリンク検証の純粋オーケストレータ（依存注入可能）
 *
 * Airtable / env / 時計に触れず、注入された関数だけを呼ぶ。
 * これにより「token 期限 / 使用済み / 再利用 / paid 判定 / Cookie 発行 / 更新失敗時に
 * Cookie を返さない」までを実 Airtable 無しでテストできる。
 *
 * 単回性: Cookie 準備が成功したあとに token を再読込して未使用を再確認し、
 *   使用済み更新（markUsed）が成功した場合だけ Cookie を返す。
 *   Airtable に原子的 compare-and-set が無い制約は呼び出し側が理解する前提の最小リスク設計。
 */

import { checkSigningSecret, issuePaidSessionCookie } from './sessionIssuance.js';
import { resolveMembership, MEMBER_TYPE } from './memberResolution.js';

export const VERIFY_FLOW = Object.freeze({
  SECRET_UNAVAILABLE: 'secret_unavailable', // 503
  MISSING_TOKEN: 'missing_token',           // 400
  TOKEN_NOT_FOUND: 'token_not_found',       // 404
  TOKEN_USED: 'token_used',                 // 403
  TOKEN_EXPIRED: 'token_expired',           // 403
  CUSTOMER_NOT_FOUND: 'customer_not_found', // 404
  CUSTOMER_CONFLICT: 'customer_conflict',   // 409 (重複レコード → fail closed)
  NOT_PAID: 'not_paid',                     // 403
  ISSUE_FAILED: 'issue_failed',             // 500 (secret_invalid → 503)
  CONSUME_FAILED: 'consume_failed',         // 500
  OK: 'ok',                                 // 200
});

/**
 * @param {{
 *   token: string|null|undefined,
 *   secret: string,
 *   now: number,
 *   ttlMs?: number,
 *   subtle?: SubtleCrypto,
 *   findToken: (token: string) => Promise<{ id: string, fields: { Used?: boolean, ExpiresAt?: string, Email?: string } } | null>,
 *   findCustomer: (email: string) => Promise<{ id: string, fields: Record<string, unknown> } | null>,
 *   markUsed: (tokenId: string) => Promise<void>,
 * }} deps
 * @returns {Promise<{ outcome: string, cookie?: string, membership?: object, payload?: object, reason?: string }>}
 */
export async function runVerifyMagicLink(deps) {
  const { token, secret, now, ttlMs, subtle, findToken, findCustomer, markUsed } = deps;

  // 1. 秘密鍵（fail closed。token に触れない）
  if (!checkSigningSecret(secret).ok) return { outcome: VERIFY_FLOW.SECRET_UNAVAILABLE };
  if (typeof token !== 'string' || token.length === 0) return { outcome: VERIFY_FLOW.MISSING_TOKEN };

  // 2. token 検証
  const tok = await findToken(token);
  if (!tok) return { outcome: VERIFY_FLOW.TOKEN_NOT_FOUND };
  if (tok.fields?.Used) return { outcome: VERIFY_FLOW.TOKEN_USED };
  const exp = Date.parse(tok.fields?.ExpiresAt);
  if (Number.isNaN(exp) || now > exp) return { outcome: VERIFY_FLOW.TOKEN_EXPIRED };

  // 3. Customers 再取得
  //    findCustomer の契約: null=未登録 / { conflict: true }=重複（fail closed） /
  //    { id, fields }=一意。重複時は会員判定・Cookie 発行・markUsed のいずれも行わない。
  const email = String(tok.fields?.Email || '').trim().toLowerCase();
  const customer = await findCustomer(email);
  if (!customer) return { outcome: VERIFY_FLOW.CUSTOMER_NOT_FOUND };
  if (customer.conflict === true) return { outcome: VERIFY_FLOW.CUSTOMER_CONFLICT };

  // 4. 会員再判定（クライアント plan は使わない）
  const membership = resolveMembership({ fields: customer.fields, recordId: customer.id, now });
  if (membership.memberType !== MEMBER_TYPE.PAID) {
    return { outcome: VERIFY_FLOW.NOT_PAID, reason: membership.reason };
  }

  // 5. Cookie 準備（20分）。会員判定・Cookie 準備が成功してから token を消費する。
  const issued = await issuePaidSessionCookie({ membership, secret, now, ttlMs, subtle });
  if (!issued.ok) return { outcome: VERIFY_FLOW.ISSUE_FAILED, reason: issued.reason };

  // 6. 使用済み更新の直前に再確認（並行利用の単回性を最大限守る）
  const recheck = await findToken(token);
  if (!recheck || recheck.fields?.Used) return { outcome: VERIFY_FLOW.TOKEN_USED };

  // 7. 使用済みに更新 → 成功時のみ Cookie を返す
  try {
    await markUsed(tok.id);
  } catch {
    return { outcome: VERIFY_FLOW.CONSUME_FAILED };
  }

  return {
    outcome: VERIFY_FLOW.OK,
    cookie: issued.cookie,
    membership,
    payload: issued.payload,
    email: customer.fields?.Email ?? email,
    // Airtable Customers の氏名フィールドは日本語の `氏名`（`Name` / `お名前` は存在しない）。
    // これを読み落としていたため常に空になり、dashboard の既定値 'お客様' が user-plan に残って
    // 問い合わせフォームへ自動入力されていた（2026-07-18 修正）。旧名は将来のリネーム保険として残す。
    name: customer.fields?.['氏名'] ?? customer.fields?.Name ?? customer.fields?.['お名前'] ?? '',
  };
}
