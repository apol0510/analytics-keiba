/**
 * /api/upsell.json — 「この会員にどの販売導線を見せるか」を配る（SSR・read-only）
 *
 * 顧客側の表示判断を**この 1 経路に集約**する。ページごとに条件を書かない。
 *   - dashboard / premium-prediction / premium-sanrenpuku 系はこの結果に従う
 *   - 三連複の段階表示（初回閲覧からの日数・dismiss）は localStorage 由来なので
 *     **クライアントが `sanrenpukuCtaStage.js` で確定する**。ここは channel だけを決める
 *
 * 認可: ak_session（HttpOnly 署名 Cookie）。未ログインは 404（存在を漏らさない）。
 *
 * ⚠️ Premium Plus の存在秘匿を維持する。channel が plus でないときは
 *    `plus` の詳細（phase / 受付状況 / 商品ページ URL）を**一切返さない**。
 *
 * 書き込みはしない（Airtable は GET のみ・1 レコード）。
 */
export const prerender = false;

import { verifyPlanAccess, PREMIUM_PLUS_CANDIDATE_PLANS } from '../../lib/auth/index.js';
import { lookupCustomerFields } from '../../lib/premiumPlus/purchaseAnchorLookup.js';
import { resolveUpsellForCustomer, UPSELL_CHANNEL } from '../../lib/upsell/upsellTarget.js';
import { enforceSalePause } from '../../lib/premiumPlus/salePauseGuard.js';

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
    // 有料階層は一通り入口に通す。何を売るかは下の resolver が決める。
    allowedPlans: PREMIUM_PLUS_CANDIDATE_PLANS,
  });
  if (!access.ok) return notFound();

  const fields = await lookupCustomerFields({
    recordId: access.payload?.sub || null,
    env: process.env,
    now,
  });

  // 会員単位の販売 一時停止は**キャッシュを迂回して**確認する。
  // `fields` は最大 10 分キャッシュされるため、停止直後の会員がここで
  // 「販売中」の古い値のまま通ってしまう（enforceSalePause が deny-marker で塞ぐ）。
  const view = await enforceSalePause({
    view: resolveUpsellForCustomer({
      fields,
      nowMs: now,
      fallbackAnchor: process.env.PREMIUM_PLUS_FUNNEL_ANCHOR,
    }),
    fields,
    recordId: access.payload?.sub || null,
    env: process.env,
  });

  const body = {
    channel: view.channel,
    reason: view.reason,
    // 三連複は「出してよいか」だけ。段階（予告/CTA）はクライアントが決める。
    sanrenpuku: { allowed: view.sanrenpuku.allowed },
    plus: view.channel === UPSELL_CHANNEL.PLUS
      ? {
        allowed: true,
        showTeaser: view.plus.showTeaser,
        showProductPage: view.plus.showProductPage,
        showPurchaseCta: view.plus.showPurchaseCta,
        purchaseEnabled: view.plus.purchaseEnabled,
        productHref: view.plus.showProductPage ? PRODUCT_HREF : null,
      }
      // 存在秘匿: plus 以外のときは phase も受付状況も返さない
      : { allowed: false },
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  });
}
