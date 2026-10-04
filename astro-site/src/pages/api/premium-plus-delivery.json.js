/**
 * /api/premium-plus-delivery.json — 購入者マイページの Premium Plus 提供レース（SSR・GET）
 *
 * - 対象は **`ak_session` の recordId だけ**（query / body の id は読まない）。
 * - 見せるのは「入金確認済み・対象日が今日以降」の注文と、有効な枠確保の提供日だけ。無ければ 404。
 * - **公開時刻（発走予定の10分前）より前の買い目は返さない**（判定は `buildMemberView`）。
 *   キャッシュさせない（公開前の応答が公開後に再利用されないように）。
 */
export const prerender = false;

import { verifySession } from '../../lib/auth/index.js';
import { readSessionCookie } from '../../lib/auth/sessionCookie.js';
import { makeRedisCmd } from '../../lib/premiumPlus/premiumPlusFunnelServer.js';
import { createOrderStore } from '../../lib/premiumPlus/premiumPlusOrderService.js';
import { createDeliveryStore } from '../../lib/premiumPlus/premiumPlusDeliveryStore.js';
import { buildMemberView, jstDate } from '../../lib/premiumPlus/premiumPlusDelivery.js';
import { createPassStore } from '../../lib/premiumPlus/premiumPlusPassStore.js';
import { memberDeliveryDates } from '../../lib/premiumPlus/premiumPlusPass.js';

const NO_STORE = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store, max-age=0' };
const notFound = () => new Response(JSON.stringify({ error: 'not_found' }), { status: 404, headers: NO_STORE });

export async function GET({ request }) {
  const nowMs = Date.now();
  const secret = process.env.SESSION_SIGNING_SECRET;
  const token = readSessionCookie(request.headers.get('cookie') || '');
  if (!secret || !token) return notFound();
  const verified = await verifySession({ token, secret, now: nowMs });
  if (!verified.ok) return notFound();
  const recordId = String(verified.payload?.sub || '');
  if (!recordId) return notFound();

  const cmd = makeRedisCmd(process.env);
  if (!cmd) return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: NO_STORE });
  try {
    // 単発注文（入金確認済み）と枠確保（予約日・年間の配信曜日）を合わせた本人の提供日
    const today = jstDate(nowMs);
    const dates = memberDeliveryDates({
      orders: await createOrderStore({ redisCmd: cmd }).list(),
      passes: await createPassStore({ redisCmd: cmd }).list(),
      recordId,
    }).filter((d) => d >= today).slice(0, 3);
    if (dates.length === 0) return notFound();
    const orders = dates.map((saleDate) => ({ saleDate }));
    const deliveries = await createDeliveryStore({ redisCmd: cmd }).getMany(dates);
    return new Response(JSON.stringify(buildMemberView({ orders, deliveries, nowMs })), { status: 200, headers: NO_STORE });
  } catch {
    return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: NO_STORE });
  }
}
