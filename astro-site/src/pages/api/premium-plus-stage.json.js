/**
 * /api/premium-plus-stage.json — 段階公開ステージの配信（SSR・存在秘匿）
 *
 * 三連複会員ページ（premium-sanrenpuku*.astro は prerender=true の静的 HTML）へ
 * PHASE 2 の予告を出すための唯一の経路。予告文言を静的 HTML に置くと、非会員が
 * ソースを見るだけで Premium Plus の存在を知れてしまうため、**文言はここから配る**。
 *
 * 認可: ak_session（HttpOnly 署名 Cookie）のみ。verifyPlanAccess が NG なら 404
 * （401/403 は存在を漏らすので使わない）。PHASE 1 でも 404（まだ何も知らせない）。
 *
 * 返すもの（PHASE で最小限に絞る）:
 *   PHASE 2: 予告文言のみ（金額なし・購入ボタンなし・商品ページ URL なし）
 *   PHASE 3+: 予告文言 + 商品ページ URL（購入 CTA は商品ページ側で phase 判定）
 *   価格・口座情報はどの phase でも返さない。
 */
export const prerender = false;

import { verifyPlanAccess } from '../../lib/auth/index.js';
import {
  PP_PHASE,
  PP_RELEASE_COPY,
  resolvePremiumPlusRelease,
} from '../../lib/premiumPlus/premiumPlusRelease.js';
import { lookupSanrenpukuPaidAt } from '../../lib/premiumPlus/purchaseAnchorLookup.js';

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
  });
  if (!access.ok) return notFound();

  const { paidAtMs } = await lookupSanrenpukuPaidAt({
    recordId: access.payload?.sub || null,
    env: process.env,
    now,
  });

  const release = resolvePremiumPlusRelease({ hasSanrenpuku: true, paidAtMs, nowMs: now });

  // PHASE 1 は「まだ何も知らせない」＝存在秘匿を維持する。
  if (!release.showTeaser) return notFound();

  return new Response(JSON.stringify({
    phase: release.phase,
    teaser: PP_RELEASE_COPY.teaser,
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
