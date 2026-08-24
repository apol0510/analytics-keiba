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
import { lookupCustomerFields, FRESH_LOOKUP_MAX_AGE_MS } from '../../lib/premiumPlus/purchaseAnchorLookup.js';
import { resolveUpsellForCustomer, UPSELL_CHANNEL } from '../../lib/upsell/upsellTarget.js';
// 取得済みクーポンの保有状態（マイページのカード用）。判定・文言は単一源に任せる
import {
  readReopenCoupon, describeCouponForMember, describeCouponUsageForMember,
} from '../../lib/premiumPlus/premiumPlusReopenCoupon.js';
import { formatClaimedAtJst, COUPON_PAGE_PATH } from '../../lib/premiumPlus/premiumPlusPauseNoticePage.js';
// 再募集の開始日時の単一源（開始済みなら有効期限が確定した定義になる）
// 「使ったか」は保有（Customers 3 列）ではなく**予約台帳**にしかない
import { listReservationsFor } from '../../lib/premiumPlus/premiumPlusCouponReservationStore.js';
import { describeCouponLifecycle } from '../../lib/premiumPlus/premiumPlusCouponReservation.js';
// 全会員向けキャンペーン割引（Light / Premium / 三連複）。Premium Plus とは別物。
import { describeCampaignForMember } from '../../lib/promotions/campaignOffers.js';
import { fromAirtableFields, resolveEntitlements } from '../../lib/entitlements/resolveEntitlements.js';
import { loadReopenStart } from '../../lib/premiumPlus/premiumPlusReopenStartStore.js';
import { withReopenStart } from '../../lib/premiumPlus/premiumPlusReopenStart.js';
// 「取得できるか」の単一源（**販売停止フラグでは決めない**）
import { resolveCouponAccess } from '../../lib/premiumPlus/premiumPlusCouponAccess.js';
import { isReopenCouponEnabled } from '../../lib/premiumPlus/premiumPlusReopenCoupon.js';

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
  // ⚠️ マイページのお知らせ・クーポン表示は**管理画面の操作ですぐ変わる**。古い値を使うと
  //    「渡したのに画面が変わらない」になる（2026-08-23 の報告）。
  maxAgeMs: FRESH_LOOKUP_MAX_AGE_MS,
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
  // ⚠️ 会員ごとの開始日時。**本人（セッション由来）の recordId だけ**を渡す。
  //    未取得の人にも読む: 「取得できる状態か」を判定するため（停止フラグでは決めない）。
  const reopen = await loadReopenStart({
    recordId: access.payload?.sub || null, env: process.env,
  });
  const couponAccess = resolveCouponAccess({
    audience: view.plusAudience?.isPlusAudience === true,
    // ⚠️ 配る相手は「**いま買えない人**」。買える人には出さない
    salePaused: view.plusRelease?.salePaused === true,
    reopen,
    fields,
    nowMs: now,
    storageReady: isReopenCouponEnabled(process.env),
  });
  // ── クーポンを「使ったか」──────────────────────────────────
  // ⚠️ 保有（Customers の 3 列）は**使い終わっても消えない**（渡した事実だから）。
  //    使用済みかどうかは予約台帳にしかない。ここを読まないと、マイページは
  //    使用済みのクーポンを「ご利用いただけます」と出し続ける（2026-08-23 の報告）。
  //    取得していない人では読みに行かない（無関係な会員に失敗要因を足さない）。
  const usageLedger = held.claimed === true
    ? await listReservationsFor({ env: process.env, customerRecordId: access.payload?.sub || null })
    : { available: true, records: [] };
  const usage = describeCouponUsageForMember({
    lifecycle: describeCouponLifecycle({
      fields,
      offerRows: usageLedger.available ? usageLedger.records : null,
      ledgerAvailable: usageLedger.available,
      customerRecordId: access.payload?.sub || '',
    }).state,
    ledgerAvailable: usageLedger.available,
    claimed: held.claimed === true,
  });

  // 取得済み、または**いま取得できる**ならマイページにカードを出す。
  // ⚠️ 旧実装は「取得済みのときだけ」で、取得導線を知らないと辿り着けなかった。
  const couponBody = couponAccess.visible
    ? (() => {
      const v = describeCouponForMember({
        coupon: held,
        paused: view.plusRelease?.salePaused === true,
        // マイページからも取得できる（判定は単一源。停止中かどうかでは決めない）
        claimable: couponAccess.canClaim,
        // いま購入できるか。**停止中は false** で、押せる CTA を出さない
        purchasable: view.plusRelease?.purchaseEnabled === true,
        ctaSource: 'dashboard',
        def: withReopenStart(reopen.startsAtIso),
      });
      return {
        claimed: held.claimed === true,
        /** まだ取得していないが、いま取得できる（マイページに取得 CTA を出す） */
        canClaim: couponAccess.canClaim === true,
        /** 取得ページ（実際の取得はここで行う） */
        claimHref: COUPON_PAGE_PATH,
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
        /** いまどうなっているか（未使用 / 申込に適用済み / ご利用済み / 確認できない）*/
        usage,
        // 申込導線（主 CTA）。停止中は href が null の非購入表示になる。
        // ⚠️ **使用済み・申込に適用済みなら申込導線を出さない**（二重に申し込ませない）
        cta: usage.blocksOrder ? { show: false, purchasable: false, label: '', href: null } : v.orderCta,
      };
    })()
    : { claimed: false, canClaim: false };

  // ── 全会員向けキャンペーン割引 ────────────────────────────────
  // ⚠️ 出し分けは単一源（`campaignOffers.js`）。**持っている商品は勧めない**。
  //    Premium Plus と違い存在秘匿は不要（通常商品なので商品名も金額も出す）。
  const campaign = describeCampaignForMember({
    entitlements: resolveEntitlements(fromAirtableFields(fields || {}), now),
    nowMs: now,
  });

  const body = {
    channel: view.channel,
    reason: view.reason,
    coupon: couponBody,
    campaign,
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
