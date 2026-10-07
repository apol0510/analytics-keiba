/**
 * GET /api/ailab/view/?market=jra|nankan[&date=YYYY-MM-DD] — AI ラボの自動更新用（30 秒ごと）。正本 docs/AI_LAB.md
 * 本人確認は ak_session の署名だけ（Airtable を呼ばない：自動更新で月間上限を超えないため）。
 * ページ本体（/ai-lab/）は gatePaidPage で権利を確かめてから描画する。
 */
export const prerender = false;
import { verifyPlanAccess } from '../../../lib/auth/pageAccess.js';
import { loadMarketView, AILAB_POLL_PLANS } from '../../../lib/ailab/aiLabServer.js';
import { MARKETS } from '../../../lib/ailab/aiLab.js';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } });

export async function GET({ request, url }) {
  const access = await verifyPlanAccess({
    cookieHeader: request.headers.get('cookie') || '', secret: process.env.SESSION_SIGNING_SECRET,
    now: Date.now(), allowedPlans: AILAB_POLL_PLANS,
  });
  if (!access.ok) return json(401, { ok: false, error: 'unauthorized' });
  const market = url.searchParams.get('market') || 'jra';
  if (!MARKETS.includes(market)) return json(400, { ok: false, error: 'market' });
  const view = await loadMarketView({ env: process.env, market, date: url.searchParams.get('date') });
  if (!view) return json(503, { ok: false, error: 'unavailable' });
  return json(200, { ok: true, ...view });
}
