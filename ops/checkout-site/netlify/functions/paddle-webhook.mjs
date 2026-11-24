/**
 * paddle-webhook（独立サイト版 / checkout.tirol.link 上の modern Netlify function）
 *
 * 分離案 B（2026-10-24 MK 確定）:
 *  - このサイトは PADDLE_API_KEY を持ち、署名検証＋取引照会＋照合までを行う（4KB 制約なし）。
 *  - 会員付与（Airtable/Redis）は本番の internal-paddle-grant へ委譲する（課金系 creds は本番のみ）。
 *  - CARD_GRANT_INTERNAL_SECRET による HMAC（ts:rawBody）で本番へ内部認証。
 *  - 冪等性・二重付与防止は本番 entitlementLedger がそのまま担保（同一 Redis キー）。
 *
 * 定期課金（2026-11-02）: 取引・購読を照会し、購読の写し（apply.kind='subscription'）を同じ経路で本番へ渡す。
 *
 * KL・HIBI（2026-11-24・lib/servicePaddle.mjs）: 署名検証のあと、AK の処理より前に custom_data.svc（無ければ購読・取引を照会）を読み、
 * svc が kl / hibi の event は本文を変えずにそのサービスの grantUrl へ、そのサービスの secret で署名して転送する
 * （サービスの 2xx・4xx → 200・5xx / 到達不能 / secret なし → 500 で Paddle に再送させる）。知らない svc は 200 で無視。
 * AK の event（ak_* の印・印なし）はここから下の従来の処理のまま。
 *
 * 必要 env（このサイト）: PADDLE_WEBHOOK_SECRET / PADDLE_API_KEY / CARD_GRANT_INTERNAL_SECRET（＋ KL_GRANT_INTERNAL_SECRET / HIBI_GRANT_INTERNAL_SECRET）
 * 応答: 200=処理済/無視/照合違い、500=再送希望（照会失敗・本番付与が再送可）。
 */
import { decidePaddleGrant } from '../../../../astro-site/src/lib/billing/paddle/paddleServer.js';
import { verifyPaddleSignature, parsePaddleWebhook, resolvePaddleMode, signTsBody } from '../../../../astro-site/src/lib/billing/paddle/paddleCore.js';
import { PRODUCTION_ORIGIN } from '../../../../astro-site/src/lib/billing/cardSales.js';
import { routeServiceEvent } from './lib/servicePaddle.mjs';

const H = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const resp = (status, obj) => new Response(JSON.stringify(obj), { status, headers: H });
const GRANT_URL = `${PRODUCTION_ORIGIN}/.netlify/functions/internal-paddle-grant`;

/** テスト可能な本体（fetchImpl を注入できる。本番は global fetch） */
export async function handlePaddleWebhook({ request, env, fetchImpl }) {
  if (request.method !== 'POST') return resp(405, { error: 'method_not_allowed' });
  const raw = await request.text();
  const header = request.headers.get('paddle-signature') || '';
  if (!verifyPaddleSignature({ header, rawBody: raw, secret: env.PADDLE_WEBHOOK_SECRET })) {
    return resp(401, { error: 'invalid_signature' });
  }
  // KL・HIBI の event はここで転送して終わる（AK の event は null が返り、従来の処理へ）
  const routed = await routeServiceEvent({ raw, env, fetchImpl });
  if (routed) return routed;
  const parsed = parsePaddleWebhook(raw);
  if (!parsed || parsed.ignored) return resp(200, { received: true });

  const origin = PRODUCTION_ORIGIN; // 本番専用サイト
  // 鍵の種類（live/test）だけを見る（一回払いの販売停止中でも、定期課金の反映指示の種類は正しく伝える）
  const mode = resolvePaddleMode({ key: env.PADDLE_API_KEY, origin, salesOpen: true });
  const dec = await decidePaddleGrant({ env, origin, parsed, fetchImpl });

  // 付与も照合アラートも無い＝無視 or 再送希望（照会失敗）。本番へは呼ばない。
  if (!dec.apply && !dec.alert) return dec.retry ? resp(500, { error: dec.result }) : resp(200, { received: true });

  if (!env.CARD_GRANT_INTERNAL_SECRET) return resp(500, { error: 'internal_secret_missing' }); // 付与待ち＝再送させる
  const forward = JSON.stringify({ apply: dec.apply || null, alert: dec.alert || null, mode: mode.ok ? mode.mode : 'test', paymentId: parsed.transactionId });
  const sig = signTsBody({ rawBody: forward, secret: env.CARD_GRANT_INTERNAL_SECRET });
  let res;
  try {
    res = await (fetchImpl || fetch)(GRANT_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-signature': sig }, body: forward });
  } catch (e) {
    console.error(JSON.stringify({ event: 'paddle_webhook_sep_grant_unreachable', message: String(e?.message || e).slice(0, 120) }));
    return resp(500, { error: 'grant_unreachable' }); // 再送させる
  }
  // 本番が 5xx（再送希望）なら Paddle に再送させる。4xx は再送しても直らないので 200 で止める（ログだけ）。
  if (res.status >= 500) return resp(500, { error: 'grant_retry' });
  if (!res.ok) {
    console.error(JSON.stringify({ event: 'paddle_webhook_sep_grant_4xx', status: res.status, type: parsed.eventType }));
    return resp(200, { received: true, grant_status: res.status });
  }
  console.log(JSON.stringify({ event: 'paddle_webhook_sep', type: parsed.eventType, result: dec.result }));
  return resp(200, { received: true });
}

export default async (request) => handlePaddleWebhook({ request, env: process.env });
