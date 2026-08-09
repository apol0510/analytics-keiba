/**
 * paidPageGate.js — 有料ページのサーバー側認可（既存の単一源へ委譲する薄い層）
 *
 * ── 何のためにあるか ────────────────────────────────────────────
 * 有料ページの多くは `prerender = true` の静的 HTML で、認可はクライアントの
 * `AccessControl`（localStorage の `user-plan`）に依存している。その構造では
 * **localStorage を書き換えるだけで有料本文を読める**
 * （2026-08-08 の監査で確認。`setTestAuth` 除去後も `user-plan` 直接注入は有効）。
 *
 * 本モジュールはページを SSR 化したうえで、**HTML を組み立てる前に**
 * サーバー側で認可を確定させる入口。認可できなければ有料本文を一切返さない。
 *
 * ── 第二の認証方式を作らない ────────────────────────────────────
 * 判定は既存の 2 つの単一源へ**そのまま委譲**する。
 *
 *   1. 本人特定 … `verifyPlanAccess`（ak_session / HttpOnly 署名 Cookie）
 *   2. 権利判定 … `resolveEntitlements`（Airtable の契約・買い切り・無料特典の正本）
 *
 * 新しいトークン・Cookie・localStorage 鍵は一切導入しない。
 *
 * ── なぜ 2 段なのか（session の plan だけでは足りない）────────────
 * session payload が持つのは `plan` 1 つだけで、**`LifetimeSanrenpuku`（三連複の
 * 買い切り永久権）やカムバック無料特典を表現できない**。
 * 実際、`プラン=Premium` + `LifetimeSanrenpuku=true` の会員が本番に存在する。
 * session の plan だけで三連複ページを判定すると、この会員を締め出してしまう。
 *
 * そこで `premium-plus.astro` と同じ形にする:
 *   入口は広め（有料プランなら通す）→ **権利は Airtable を引いて正本で判定**。
 */

import { verifyPlanAccess } from './pageAccess.js';
import { lookupCustomerFieldsResult } from '../premiumPlus/purchaseAnchorLookup.js';
import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
// ⚠️ このファイルは標準出力への書き出しを持たない（staticGuards が禁止。payload/secret 漏洩防止）。
//    出力してよい形は observability 側が単独で決める。
import { logPaidGateDeny } from '../observability/paidGateLog.js';

/**
 * 入口（door）で通す canonical plan。**ここで権利を判定しない。**
 * 有料契約のいずれかであれば通し、実際の可否は下の entitlement で決める。
 */
export const PAID_DOOR_PLANS = Object.freeze([
  'premium-sanrenpuku',
  'premium-combo',
  'premium',
  'premium-predictions',
  'light',
]);

/**
 * `<AccessControl requiredPlan>` の語 → `resolveEntitlements` のどのフラグを見るか。
 * **表記は既存ページに合わせる**（`standard` は Light プランを指す既存語）。
 */
export const REQUIRED_PLAN_ENTITLEMENT = Object.freeze({
  'Premium Sanrenpuku': 'canViewSanrenpuku',
  premium: 'canViewPremium',
  standard: 'canViewLight',
});

/** 表記ゆれを吸収して entitlement フラグ名を返す。未知は null（fail closed）。 */
export function resolveEntitlementFlag(requiredPlan) {
  const key = String(requiredPlan ?? '').trim();
  if (Object.prototype.hasOwnProperty.call(REQUIRED_PLAN_ENTITLEMENT, key)) {
    return REQUIRED_PLAN_ENTITLEMENT[key];
  }
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(REQUIRED_PLAN_ENTITLEMENT)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

/** 有料本文を CDN / 共有キャッシュへ載せない（別人へ配られるのを防ぐ）。 */
export const PAID_PAGE_HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store',
  Vary: 'Cookie',
});

function denyResponse(notFound) {
  return notFound
    ? new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...PAID_PAGE_HEADERS },
    })
    : new Response(null, { status: 302, headers: { Location: '/login/', ...PAID_PAGE_HEADERS } });
}

/**
 * ページ frontmatter から呼ぶ。認可できなければ `response` に Response が入るので、
 * 呼び出し側は `if (gate.response) return gate.response;` と書くだけでよい。
 *
 * @param {{
 *   request: Request,
 *   requiredPlan: string,
 *   env: object,                 **必須**。この層は process.env を直接参照しない
 *                                （ランタイム非依存にするため。呼び出し側が注入する）
 *   now?: number,
 *   notFound?: boolean,          未認可を 404 にする（既定は /login へ 302）
 *   lookup?: Function,           テスト用の差し替え（既定 lookupCustomerFields）
 * }} input
 * @returns {Promise<{ ok: boolean, response: Response|null, reason: string, entitlements: object|null }>}
 */
/**
 * lookup の戻り値を正規化する。
 *
 * 新契約: `{ ok:true, fields }` / `{ ok:false, reason:'not_found'|'unavailable' }`
 * 旧契約: `fields | null`（差し替えテストや既存呼び出しの互換）
 *
 * ⚠️ 旧契約の `null` は**区別できない**ので `not_found` として扱う。
 *    認可経路は必ず新契約（`lookupCustomerFieldsResult`）を使うこと。
 */
export function normalizeLookupResult(v) {
  if (!v) return { ok: false, reason: 'not_found' };
  if (v.ok === true && v.fields && typeof v.fields === 'object') return { ok: true, fields: v.fields };
  if (v.ok === false && typeof v.reason === 'string') return { ok: false, reason: v.reason };
  if (typeof v === 'object') return { ok: true, fields: v };   // 旧契約
  return { ok: false, reason: 'not_found' };
}

export async function gatePaidPage({
  request,
  requiredPlan,
  env,
  now = Date.now(),
  notFound = false,
  lookup = lookupCustomerFieldsResult,
} = {}) {
  const flag = resolveEntitlementFlag(requiredPlan);
  const deny = (reason) => {
    logPaidGateDeny(reason, requiredPlan);
    return { ok: false, reason, response: denyResponse(notFound), entitlements: null };
  };

  // 設定ミスで全開にしない
  if (!flag) return deny('unknown_required_plan');
  // env 未注入は fail closed（既定値で process.env を掴まない）
  if (!env || typeof env !== 'object') return deny('env_missing');

  // ── 1. 本人特定（session。plan は入口の判定にだけ使う）──
  const access = await verifyPlanAccess({
    cookieHeader: request?.headers?.get?.('cookie') || '',
    secret: env.SESSION_SIGNING_SECRET,
    now,
    allowedPlans: PAID_DOOR_PLANS,
  });
  if (!access.ok) return deny(access.reason || 'no_session');

  const sub = access.payload?.sub || null;
  if (!sub) return deny('no_subject');

  // ── 2. 権利判定（Airtable の正本。買い切り・無料特典もここで効く）──
  // ⚠️ **一時障害と「会員が存在しない」を区別する。**
  //    どちらも通さない（fail closed）が、理由コードを分けないと障害が観測できない。
  //    2026-08-08 の障害では、Airtable の一時障害が customer_not_found に潰れており、
  //    さらに失敗が 10 分キャッシュされて有効会員が締め出されていた。
  let looked = null;
  try {
    looked = await lookup({ recordId: sub, env, now });
  } catch {
    return deny('lookup_failed');
  }
  const r = normalizeLookupResult(looked);
  if (!r.ok) return deny(r.reason === 'not_found' ? 'customer_not_found' : 'lookup_unavailable');
  const fields = r.fields;

  const ent = resolveEntitlements(fromAirtableFields(fields), now);
  if (ent[flag] !== true) return deny('entitlement_denied');

  return { ok: true, response: null, reason: 'ok', entitlements: ent };
}
