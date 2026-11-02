/**
 * paddle-subscription-cancel（独立サイト版 / checkout.tirol.link 上の modern Netlify function・2026-11-02）
 *
 * マイページの即時退会で、本番サイト（PADDLE_API_KEY を持たない・4KB）から署名付き intent を受けて Paddle の購読を即時解約する。
 *  - intent は CARD_GRANT_INTERNAL_SECRET（ts:rawBody・tolerance 120s）で検証。origin は本番だけ。
 *  - 購読を照会し、custom_data の会員 ID が intent の会員と一致するときだけ解約（別の会員の購読は止めない）。
 *  - 返金はしない（Paddle の cancel は返金を作らない）。解約できたかは照会し直して canceled を確かめる。
 *  - 会員の状態（Airtable）は本番が書く。ここは解約と、その結果の写しを返すだけ。
 *
 * 必要 env（このサイト）: PADDLE_API_KEY / CARD_GRANT_INTERNAL_SECRET
 * 応答: 200 { ok: true, cancelled, sub } / 200 { ok: false, code }（subscription_mismatch / cancel_failed / lookup_failed）
 *       401 invalid_signature / 400 不正 intent / 503 設定不足
 */
import { verifyPaddleSignature, keyMode, PADDLE_API } from '../../../../astro-site/src/lib/billing/paddle/paddleCore.js';
import { paddleApi } from '../../../../astro-site/src/lib/billing/paddle/paddleApi.js';
import { cancelPaddleSubscriptionForMember } from '../../../../astro-site/src/lib/billing/paddle/paddleSubscriptionServer.js';
import { PRODUCTION_ORIGIN, resolveCardMode } from '../../../../astro-site/src/lib/billing/cardSales.js';

const H = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const resp = (status, obj) => new Response(JSON.stringify(obj), { status, headers: H });
const INTENT_TTL_SEC = 120;

export async function handleCancel({ request, env, fetchImpl }) {
  if (request.method !== 'POST') return resp(405, { error: 'method_not_allowed' });
  const raw = await request.text();
  if (!env.CARD_GRANT_INTERNAL_SECRET) return resp(503, { error: 'internal_secret_missing' });
  const sig = request.headers.get('x-internal-signature') || '';
  if (!verifyPaddleSignature({ header: sig, rawBody: raw, secret: env.CARD_GRANT_INTERNAL_SECRET, toleranceSec: INTENT_TTL_SEC })) {
    return resp(401, { error: 'invalid_signature' });
  }
  let intent = null;
  try { intent = JSON.parse(raw); } catch { return resp(400, { error: 'invalid_json' }); }
  if (!intent || intent.kind !== 'cancel' || String(intent.origin || '') !== PRODUCTION_ORIGIN) return resp(400, { error: 'invalid_intent' });
  // 既存契約の解約は販売を閉じた後も行う（salesOpen: true）。鍵は本番の鍵だけ
  const mode = resolveCardMode({ provider: 'paddle', keyMode: keyMode(env.PADDLE_API_KEY), origin: PRODUCTION_ORIGIN, salesOpen: true });
  if (!mode.ok) return resp(503, { error: mode.reason });
  const api = paddleApi({ apiBase: PADDLE_API[mode.mode], key: env.PADDLE_API_KEY, fetchImpl });
  const r = await cancelPaddleSubscriptionForMember({ api, subscriptionId: String(intent.subscriptionId || ''), recordId: String(intent.recordId || '') });
  console.log(JSON.stringify({ event: 'paddle_subscription_cancel_sep', ok: r.ok, ...(r.ok ? { cancelled: r.cancelled } : { code: r.code }) }));
  return resp(200, r.ok ? { ok: true, cancelled: r.cancelled, sub: r.sub } : { ok: false, code: r.code });
}

export default async (request) => handleCancel({ request, env: process.env });
