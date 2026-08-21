/**
 * /api/premium-plus-order.json — 申込画面が使う「本人の利用可能クーポン」と価格（SSR・read-only）
 *
 * ## 本人 1 件だけ
 *
 * 会員は **`ak_session` から解決した recordId** で決まる。query も body も読まない
 * （他会員のクーポンは構造的に出ない）。未所持なら `coupons: []` を返し、
 * 申込画面は選択欄ごと出さない。
 *
 * ## 価格はサーバーが決める
 *
 * `?couponId=` は**選択の意思表示**として受け取るだけで、価格は
 * `premiumPlusCouponApply.js` が Airtable の実データから再計算する。
 * クライアントから割引額・最終価格を受け取る口は無い。
 *
 * ## 書き込みゼロ
 *
 * Airtable は GET のみ。クーポンの使用済み化もここでは**しない**
 * （「使用済みにするタイミング」は MK 未決定。docs/progress.md 2-B）。
 *
 * ## 存在秘匿
 *
 * Premium Plus を売らない相手にはこの API の存在も知らせない（404）。
 */
export const prerender = false;

import { verifyPlanAccess, PREMIUM_PLUS_CANDIDATE_PLANS } from '../../lib/auth/index.js';
import { lookupCustomerFields } from '../../lib/premiumPlus/purchaseAnchorLookup.js';
import { resolveUpsellForCustomer } from '../../lib/upsell/upsellTarget.js';
import {
  listApplicableCoupons, resolveOrderPricing, describeOrderBreakdown,
} from '../../lib/premiumPlus/premiumPlusCouponApply.js';
// 有効期限は「再募集の開始日時 + 14 日」。開始状態は 1 か所からしか読まない
import { loadReopenStart } from '../../lib/premiumPlus/premiumPlusReopenStartStore.js';
import { withReopenStart } from '../../lib/premiumPlus/premiumPlusReopenStart.js';

function notFound() {
  return new Response('Not Found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' },
  });
}

export async function GET({ request, url }) {
  const now = Date.now();
  const access = await verifyPlanAccess({
    cookieHeader: request.headers.get('cookie') || '',
    secret: process.env.SESSION_SIGNING_SECRET,
    now,
    allowedPlans: PREMIUM_PLUS_CANDIDATE_PLANS,
  });
  if (!access.ok) return notFound();

  const recordId = access.payload?.sub || '';
  if (!recordId) return notFound();

  const fields = await lookupCustomerFields({ recordId, env: process.env, now });
  const view = resolveUpsellForCustomer({
    fields, nowMs: now, fallbackAnchor: process.env.PREMIUM_PLUS_FUNNEL_ANCHOR,
  });
  // 商品ページを見られない相手（＝ Plus 対象でも休止案内対象でもない）には存在を知らせない
  const plusVisible = view.plusRelease?.showProductPage === true
    || view.pauseNotice?.showPauseNotice === true;
  if (!plusVisible) return notFound();

  // 再募集の開始状態（＝有効期限の確定に使う）。client からは受け取らない
  const reopen = await loadReopenStart({ env: process.env });
  const couponDef = withReopenStart(reopen.startsAtIso);

  // 選択は受け取るが、価格はサーバーが Airtable の実データから決める
  const pricing = resolveOrderPricing({
    fields, couponId: url.searchParams.get('couponId'), nowMs: now, def: couponDef,
  });

  return new Response(JSON.stringify({
    coupons: listApplicableCoupons({ fields, nowMs: now, def: couponDef }),
    pricing: {
      regularPrice: pricing.regularPrice,
      discount: pricing.discount,
      finalPrice: pricing.finalPrice,
      couponApplied: pricing.couponApplied,
      reason: pricing.reason,
    },
    breakdown: describeOrderBreakdown(pricing),
    /** いま購入できるか（クーポンとは別の軸。停止中は false のまま）*/
    purchaseEnabled: view.plusRelease?.purchaseEnabled === true,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  });
}

/** 価格の決定は GET の再計算だけ。POST でクーポンを「確定」させる口は作らない */
export function POST() {
  return notFound();
}
