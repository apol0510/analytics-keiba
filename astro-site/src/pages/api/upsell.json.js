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
 * ## 取得済みクーポン（マイページのカード）
 *
 * `coupon` は **ak_session から解決した本人 1 件**の保有状態だけを返す。
 * クライアントは recordId も email も指定できない（他会員のクーポンは構造的に出ない）。
 * **未取得のときは `{ claimed: false }` だけ**を返し、名称も条件も返さない
 * （マイページはカードごと出さない）。
 *
 * 書き込みはしない（Airtable は GET のみ・1 レコード）。
 */
export const prerender = false;

import { verifyPlanAccess, PREMIUM_PLUS_CANDIDATE_PLANS } from '../../lib/auth/index.js';
import { lookupCustomerFields } from '../../lib/premiumPlus/purchaseAnchorLookup.js';
import { resolveUpsellForCustomer, UPSELL_CHANNEL } from '../../lib/upsell/upsellTarget.js';
// 取得済みクーポンの保有状態（マイページのカード用）。判定・文言は単一源に任せる
import {
  readReopenCoupon, describeCouponForMember,
} from '../../lib/premiumPlus/premiumPlusReopenCoupon.js';
import { formatClaimedAtJst, COUPON_PAGE_PATH } from '../../lib/premiumPlus/premiumPlusPauseNoticePage.js';
// 再募集の開始日時の単一源（開始済みなら有効期限が確定した定義になる）
import { loadReopenStart } from '../../lib/premiumPlus/premiumPlusReopenStartStore.js';
import { withReopenStart } from '../../lib/premiumPlus/premiumPlusReopenStart.js';

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

  // 販売の一時停止（PremiumPlusSalePaused）は member → release の単一源が読む。
  // ここで個別に判定しない。
  const view = resolveUpsellForCustomer({
    fields,
    nowMs: now,
    fallbackAnchor: process.env.PREMIUM_PLUS_FUNNEL_ANCHOR,
  });

  // 本人のクーポン保有状態。文言・条件は単一源（describeCouponForMember）に作らせる。
  // ⚠️ ここで条件文や価格を組み立てないこと。条件が確定したら単一源だけが変わる。
  const held = readReopenCoupon(fields);
  // 取得済みの人にだけ期限を出す。読めなければ従来どおり「未確定」表示のまま（fail closed）。
  // ⚠️ 会員ごとの開始日時。**本人（セッション由来）の recordId だけ**を渡す
  const reopen = held.claimed
    ? await loadReopenStart({ recordId: access.payload?.sub || null, env: process.env })
    : { startsAtIso: null };
  const couponBody = held.claimed
    ? (() => {
      const v = describeCouponForMember({
        coupon: held,
        paused: view.plusRelease?.salePaused === true,
        // マイページから新規取得はさせない（取得はクーポンページ / 受付休止ページ）
        claimable: false,
        // いま購入できるか。**停止中・再募集前は false** で、押せる CTA を出さない
        purchasable: view.plusRelease?.purchaseEnabled === true,
        ctaSource: 'dashboard',
        def: withReopenStart(reopen.startsAtIso),
      });
      return {
        claimed: true,
        name: v.name,
        claimedAt: held.claimedAtIso,
        claimedAtText: formatClaimedAtJst(held.claimedAtIso),
        usableNote: v.usableNote,
        // 割引条件はすべて単一源が組み立てた文字列。API 側で数値を作らない
        termsText: v.termsText,
        discountText: v.discountText,
        priceText: v.priceText,
        expiryText: v.expiryText,
        expiryDetermined: v.expiryDetermined,
        termsDetermined: v.termsDetermined,
        detailHref: COUPON_PAGE_PATH,
        // 申込導線（主 CTA）。停止中は href が null の非購入表示になる
        cta: v.orderCta,
      };
    })()
    : { claimed: false };

  const body = {
    channel: view.channel,
    reason: view.reason,
    coupon: couponBody,
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
