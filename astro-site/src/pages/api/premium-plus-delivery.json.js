/**
 * /api/premium-plus-delivery.json — 購入者マイページの Premium Plus 提供レース（SSR・GET）
 *
 * - 対象は **`ak_session` の recordId だけ**（query / body の id は読まない）。
 * - 見せるのは「入金確認済み・対象日が今日以降」の注文の分だけ。無ければ 404（存在も知らせない）。
 * - **公開時刻（発走予定の10分前）より前の買い目は返さない**（判定は `buildMemberView`）。
 *   キャッシュさせない（公開前の応答が公開後に再利用されないように）。
 */
export const prerender = false;

import { verifySession } from '../../lib/auth/index.js';
import { readSessionCookie } from '../../lib/auth/sessionCookie.js';
import { makeRedisCmd } from '../../lib/premiumPlus/premiumPlusFunnelServer.js';
import { createOrderStore } from '../../lib/premiumPlus/premiumPlusOrderService.js';
import { createDeliveryStore } from '../../lib/premiumPlus/premiumPlusDeliveryStore.js';
import { selectMemberOrders, buildMemberView } from '../../lib/premiumPlus/premiumPlusDelivery.js';

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
    const orders = selectMemberOrders(await createOrderStore({ redisCmd: cmd }).list(), { recordId, nowMs });
    if (orders.length === 0) return notFound();
    const deliveries = await createDeliveryStore({ redisCmd: cmd }).getMany([...new Set(orders.map((o) => o.saleDate))]);
    return new Response(JSON.stringify(buildMemberView({ orders, deliveries, nowMs })), { status: 200, headers: NO_STORE });
  } catch {
    return new Response(JSON.stringify({ error: 'unavailable' }), { status: 503, headers: NO_STORE });
  }
}
