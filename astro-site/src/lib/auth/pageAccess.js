/**
 * pageAccess.js — SSR ページのサーバー側プラン認可（存在秘匿・fail closed）
 *
 * `/premium-plus/` のような「特定プラン会員にのみ存在を知らせる」ページで使う。
 * HttpOnly 署名 Cookie（ak_session）だけを認可の根拠にする純粋関数。
 * localStorage / クライアント AccessControl / リクエスト body は一切信用しない。
 *
 * 判定は verifyPlanAccess に集約する:
 *   - 秘密鍵未設定 / Cookie 無し / 署名・期限・スキーマ NG / プラン非該当
 *     → すべて { ok:false }（呼び出し側は理由に関わらず 404 を返し存在を秘匿する）
 *   - 署名済み Cookie の plan が allowedPlans に含まれるときのみ { ok:true }
 *
 * plan は発行時に Airtable から確定した値を署名して埋め込んでいる（クライアント改変不可）。
 * 鮮度は「会員ページのクライアント keep-alive が表示のたびに refresh-session を叩き、
 * Airtable を再照会して延長/失効させる」ことで担保する（2026-07-24: idle TTL は 30 日へ）。
 * そのため SSR ゲート自身はページ表示ごとの Airtable 再照会は行わない（I/O ゼロ・高速）。
 */

import { checkSecret } from './sessionCrypto.js';
import { readSessionCookie } from './sessionCookie.js';
import { verifySession } from './session.js';
import { normalizePlan } from './planNormalization.js';

// Premium Plus を閲覧できるプラン（三連複会員＝三連複単体 + コンボ）。
// lifetimeSanrenpuku 会員も発行時 plan は 'premium-sanrenpuku' に正規化されるためここに含まれる。
export const PREMIUM_PLUS_ALLOWED_PLANS = Object.freeze(['premium-sanrenpuku', 'premium-combo']);

/**
 * Premium Plus の**販売候補**になりうるプラン（ROUTE A + ROUTE B）。
 *
 * - ROUTE A: 三連複会員（premium-sanrenpuku / premium-combo）
 * - ROUTE B: 通常 Premium 会員（premium / premium-predictions）で、加入から一定期間
 *            三連複未購入の会員
 *
 * ⚠️ これは「Premium Plus を見せてよい」ことを意味しない。**入口の粗いふるい**であり、
 *    実際の可否は Premium Plus 販売資格（PremiumPlusEligibility）と段階公開 phase が
 *    決める（src/lib/premiumPlus/premiumPlusRelease.js）。ここを広げても、
 *    eligibility が eligible でなければページは 404 のままになる（fail closed）。
 */
export const PREMIUM_PLUS_CANDIDATE_PLANS = Object.freeze([
  'premium-sanrenpuku',
  'premium-combo',
  'premium',
  'premium-predictions',
]);

export const PAGE_ACCESS_REJECT = Object.freeze({
  KEY_MISSING: 'key_missing',
  NO_COOKIE: 'no_cookie',
  VERIFY_FAILED: 'verify_failed',
  PLAN_NOT_ALLOWED: 'plan_not_allowed',
});

/**
 * @param {object} input
 * @param {string} input.cookieHeader   Cookie ヘッダ文字列（Astro.request.headers.get('cookie')）
 * @param {string} input.secret         SESSION_SIGNING_SECRET
 * @param {number} input.now            Date.now()
 * @param {string[]} [input.allowedPlans] 許可プラン（正規化済み canonical）。既定 = Premium Plus 用
 * @param {SubtleCrypto} [input.subtle] テスト用。既定はグローバル crypto.subtle
 * @returns {Promise<{ok:true, payload:object, plan:string}|{ok:false, reason:string, verifyReason?:string}>}
 */
export async function verifyPlanAccess(input) {
  const { cookieHeader, secret, now, allowedPlans, subtle } = input || {};

  // 鍵未設定 → fail closed（存在秘匿）
  if (!checkSecret(secret).ok) {
    return { ok: false, reason: PAGE_ACCESS_REJECT.KEY_MISSING };
  }

  const token = readSessionCookie(cookieHeader || '');
  if (!token) {
    return { ok: false, reason: PAGE_ACCESS_REJECT.NO_COOKIE };
  }

  const verified = await verifySession({ token, secret, now, subtle });
  if (!verified.ok) {
    return { ok: false, reason: PAGE_ACCESS_REJECT.VERIFY_FAILED, verifyReason: verified.reason };
  }

  const plan = normalizePlan(verified.payload.plan);
  const allowList = Array.isArray(allowedPlans) && allowedPlans.length > 0
    ? allowedPlans
    : PREMIUM_PLUS_ALLOWED_PLANS;
  if (!plan || !allowList.includes(plan)) {
    return { ok: false, reason: PAGE_ACCESS_REJECT.PLAN_NOT_ALLOWED };
  }

  return { ok: true, payload: verified.payload, plan };
}
