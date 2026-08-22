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
// 販売停止中に「押したその場で」出す文言とクーポン（**文言は必ずサーバーから配る**）
import { PAUSE_NOTICE_COPY, COUPON_PAGE_PATH } from '../../lib/premiumPlus/premiumPlusPauseNoticePage.js';
import { resolveCouponAccess } from '../../lib/premiumPlus/premiumPlusCouponAccess.js';
import { loadReopenStart } from '../../lib/premiumPlus/premiumPlusReopenStartStore.js';
import {
  isReopenCouponEnabled, describeCouponDiscount, describeCouponPrice,
} from '../../lib/premiumPlus/premiumPlusReopenCoupon.js';

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
  // 販売の一時停止（PremiumPlusSalePaused）は member → release の単一源が読む。
  const upsell = resolveUpsellForCustomer({
    fields,
    nowMs: now,
    fallbackAnchor: process.env.PREMIUM_PLUS_FUNNEL_ANCHOR,
  });
  const release = upsell.plusRelease;
  const paused = release.salePaused === true;

  // ── 販売停止中も枠を消さない（2026-08-22）────────────────────────
  // ⚠️ 停止すると channel が none になり、この枠ごと消えていた。
  //    その結果「買おうとする入口」が無くなり、
  //    「お申し込みが殺到しております → 代わりにクーポン」へ**到達できなかった**。
  //    停止中は **通常と同じ見た目**（停止を外したときの文言）で枠を出し、
  //    押した先で殺到のご案内とクーポンを出す（遷移はさせない）。
  if (!paused && upsell.channel !== UPSELL_CHANNEL.PLUS) return notFound();
  if (paused && upsell.plusAudience?.isPlusAudience !== true) return notFound();

  // 停止中は「停止していなければ出ていたはずの表示」を使う（見た目を変えない）
  const shown = paused ? (upsell.plusAudience.resumed || release) : release;

  // PHASE 1 / 販売資格なし / route 対象外 は「まだ何も知らせない」＝存在秘匿を維持する。
  if (!shown.showTeaser) return notFound();

  // 文言は route + phase で決まる。PHASE 2/3（待機中）は「準備しています」、
  // PHASE 4（開通済み）は用意済みであることを静かに伝える文言＋導線ラベルを返す。
  const teaser = teaserCopyForRoute(shown.route, shown.phase);
  if (!teaser) return notFound();

  // 停止中に「押したその場で」出す内容。**文言はここで作ってクライアントへ渡す**
  // （teaser の script は is:inline で未ログイン者の HTML にも載るため、
  //  クライアント側に Premium Plus の文言を 1 文字も書かない）。
  let pausedNotice = null;
  if (paused) {
    const reopen = await loadReopenStart({ recordId: access.payload?.sub || null, env: process.env });
    const couponAccess = resolveCouponAccess({
      audience: true,
      salePaused: true,
      reopen,
      fields,
      nowMs: now,
      storageReady: isReopenCouponEnabled(process.env),
    });
    pausedNotice = {
      title: PAUSE_NOTICE_COPY.title,
      body: PAUSE_NOTICE_COPY.body,
      couponLead: PAUSE_NOTICE_COPY.couponLead,
      couponAsk: PAUSE_NOTICE_COPY.couponAsk,
      discountText: describeCouponDiscount(),
      priceText: describeCouponPrice(),
      /** いま受け取れるか（判定は単一源。停止中の未取得なら true）*/
      canClaim: couponAccess.canClaim === true,
      claimed: couponAccess.claimed === true,
      claimLabel: 'クーポンを受け取る',
      claimedLabel: 'クーポンは受け取り済みです',
      claimedHref: COUPON_PAGE_PATH,
      claimedHrefLabel: 'クーポンを確認する',
      thanksLabel: 'クーポンを受け取りました',
      errorLabel: '受け取れませんでした。時間をおいてもう一度お試しください。',
    };
  }

  return new Response(JSON.stringify({
    phase: shown.phase,
    route: shown.route,
    teaser,
    productHref: shown.phase >= PP_PHASE.PREVIEW ? PRODUCT_HREF : null,
    /** 販売停止中か。true なら**リンクを押しても遷移させず**、下の案内をその場で出す */
    paused,
    pausedNotice,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  });
}
