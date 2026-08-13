/**
 * /api/pp-funnel.json — Premium Plus の**実閲覧**を記録する（SSR・書き込みは Redis だけ）
 *
 * ## 何のため
 *
 * 管理画面の「実表示 Plus CTA」は判定結果であって閲覧記録ではない。
 * 「見えているはず」と「実際に見た」を区別するため、ここで実測を取る。
 *
 * ## 個人情報を増やさない
 *
 * 記録するのは **`ak_session` から解決した recordId** だけ。
 * **クライアントが送った id は一切使わない**（なりすまし・他人の計測汚染を防ぐ）。
 * アドレスも氏名も Redis に入れない。
 *
 * ## 数えないもの（正本は `premiumPlusFunnelStore.shouldRecordFunnelEvent`）
 *
 * 未認証 / 管理者プレビュー / bot / 短時間の再描画。
 *
 * ## 存在秘匿
 *
 * Premium Plus を売らない相手には**この API の存在も知らせない**（404）。
 * `/api/upsell.json` と同じ扱い。
 *
 * ## Airtable は触らない
 *
 * 顧客レコードへは 1 バイトも書かない（計測は Redis のみ）。
 */
export const prerender = false;

import { verifyPlanAccess, PREMIUM_PLUS_CANDIDATE_PLANS } from '../../lib/auth/index.js';
import { lookupCustomerFields } from '../../lib/premiumPlus/purchaseAnchorLookup.js';
import { resolveUpsellForCustomer, UPSELL_CHANNEL } from '../../lib/upsell/upsellTarget.js';
import { createFunnelStore, FUNNEL_EVENT } from '../../lib/premiumPlus/premiumPlusFunnelStore.js';

function notFound() {
  return new Response('Not Found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' },
  });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

/** Upstash REST。未設定なら null（計測しないだけで画面は壊さない） */
export function makeRedisCmd(env) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return null;
  return async (args) => {
    const res = await fetch(env.UPSTASH_REDIS_REST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`redis_${res.status}`);
    const data = await res.json();
    return data && Object.prototype.hasOwnProperty.call(data, 'result') ? data.result : null;
  };
}

const ALLOWED_EVENTS = new Set([FUNNEL_EVENT.CTA_VIEW, FUNNEL_EVENT.CTA_CLICK, FUNNEL_EVENT.PAGE_VIEW]);

export async function POST({ request }) {
  const now = Date.now();

  const access = await verifyPlanAccess({
    cookieHeader: request.headers.get('cookie') || '',
    secret: process.env.SESSION_SIGNING_SECRET,
    now,
    allowedPlans: PREMIUM_PLUS_CANDIDATE_PLANS,
  });
  if (!access.ok) return notFound();

  // **recordId はセッションから取る**。body の id は読まない
  const recordId = access.payload?.sub || '';

  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const event = String(body.event || '');
  if (!ALLOWED_EVENTS.has(event)) return json(400, { ok: false, error: 'unknown_event' });

  // Premium Plus を売らない相手には存在を知らせない（判定は既存の単一源）
  const fields = await lookupCustomerFields({ recordId, env: process.env, now });
  const view = resolveUpsellForCustomer({ fields, nowMs: now });
  if (view.channel !== UPSELL_CHANNEL.PLUS) return notFound();

  const redisCmd = makeRedisCmd(process.env);
  if (!redisCmd) {
    // 計測できないことを隠さない（呼び出し側は「未確認」のまま）
    return json(200, { ok: true, counted: false, reason: 'measurement_unavailable' });
  }

  const store = createFunnelStore({ redisCmd });
  const out = await store.record({
    recordId,
    event,
    nowMs: now,
    userAgent: request.headers.get('user-agent') || '',
    authenticated: true,
    // 管理者プレビューは顧客の行動ではないので数えない
    adminPreview: String(body.preview || '') === '1'
      || (request.headers.get('x-admin-preview') || '') === '1',
  });

  return json(200, { ok: out.ok, counted: out.counted, reason: out.reason || null });
}

/** GET は使わせない（誤ってプリフェッチで数えないため） */
export function GET() {
  return notFound();
}
