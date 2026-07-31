/**
 * /api/premium-plus-stage.json — 段階公開ステージの配信（SSR・存在秘匿）
 *
 * 会員ページ（premium-sanrenpuku*.astro は prerender=true の静的 HTML）へ PHASE 2 の予告を
 * 出すための唯一の経路。予告文言を静的 HTML に置くと、非会員がソースを見るだけで
 * Premium Plus の存在を知れてしまうため、**文言はここから配る**。
 *
 * 認可: ak_session（HttpOnly 署名 Cookie）のみ。verifyPlanAccess が NG なら 404
 * （401/403 は存在を漏らすので使わない）。PHASE 1 でも 404（まだ何も知らせない）。
 *
 * 販売対象の判定は premiumPlusRelease.js（純粋）に集約:
 *   ROUTE A = Premium Sanrenpuku 購入者 / ROUTE B = 通常 Premium 会員（加入 30 日以上・三連複未購入）
 *   どちらも PremiumPlusEligibility が eligible のときだけ先へ進む（fail closed）。
 *
 * 返すもの（PHASE で最小限に絞る）:
 *   PHASE 2: 予告文言のみ（金額なし・購入ボタンなし・商品ページ URL なし）
 *   PHASE 3+: 予告文言 + 商品ページ URL
 *   価格・口座情報・内部メモ（Reason）はどの phase でも返さない。
 */
export const prerender = false;

import { verifyPlanAccess, PREMIUM_PLUS_CANDIDATE_PLANS } from '../../lib/auth/index.js';
import { PP_PHASE, teaserCopyForRoute } from '../../lib/premiumPlus/premiumPlusRelease.js';
import { lookupCustomerFields } from '../../lib/premiumPlus/purchaseAnchorLookup.js';
import { resolveUpsellForCustomer, UPSELL_CHANNEL } from '../../lib/upsell/upsellTarget.js';

const PRODUCT_HREF = '/premium-plus-v2/';

function notFound() {
  return new Response('Not Found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' },
  });
}

export async function GET({ request }) {
  const now = Date.now();
  const access = await verifyPlanAccess({
    cookieHeader: request.headers.get('cookie') || '',
    secret: process.env.SESSION_SIGNING_SECRET,
    now,
    // ROUTE B（通常 Premium 会員）も入口に通す。可否は下の販売資格 + phase が決める。
    allowedPlans: PREMIUM_PLUS_CANDIDATE_PLANS,
  });
  if (!access.ok) return notFound();

  const fields = await lookupCustomerFields({
    recordId: access.payload?.sub || null,
    env: process.env,
    now,
  });
  // 販売導線の選択（UpsellTarget）。**この会員に Plus を見せてよいか**をここで決める。
  // sanrenpuku / none 指定の会員には Plus の予告も商品ページも出さない（2 商品を並べない）。
  // 判定は単一源 upsellTarget.js。ページ側に条件を散らさない。
  const upsell = resolveUpsellForCustomer({
    fields,
    nowMs: now,
    fallbackAnchor: process.env.PREMIUM_PLUS_FUNNEL_ANCHOR,
  });
  if (upsell.channel !== UPSELL_CHANNEL.PLUS) return notFound();

  const release = upsell.plusRelease;

  // PHASE 1 / 販売資格なし / route 対象外 は「まだ何も知らせない」＝存在秘匿を維持する。
  if (!release.showTeaser) return notFound();

  const teaser = teaserCopyForRoute(release.route);
  if (!teaser) return notFound();

  return new Response(JSON.stringify({
    phase: release.phase,
    route: release.route,
    teaser,
    productHref: release.phase >= PP_PHASE.PREVIEW ? PRODUCT_HREF : null,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  });
}
