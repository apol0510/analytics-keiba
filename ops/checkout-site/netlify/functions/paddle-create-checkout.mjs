/**
 * paddle-create-checkout（独立サイト版 / checkout.tirol.link 上の modern Netlify function）
 *
 * 分離案 B（2026-10-24 MK 確定）の「取引の作成」側:
 *  - このサイトは PADDLE_API_KEY を持ち、Paddle API で取引を作る（本番サイトは 4KB で鍵を置けない）。
 *  - 会員資格（ログイン・既存契約・買い切り・会員限定価格）は**本番サイトが Airtable で確認済み**。
 *    本番サイトは確認後に、短寿命・署名付き intent（CARD_GRANT_INTERNAL_SECRET・ts:rawBody）をここへ渡す。
 *  - ここでは intent の署名を短い tolerance で検証し、商品カタログ（金額・通貨）をサーバー側で再構成して取引を作る。
 *    金額・通貨・商品名はクライアント由来を一切使わない（buildTransactionBody がカタログから組む）。
 *  - CARD_SALES_OPEN.paddle=false の間は、鍵が本番でも resolvePaddleMode が 503 card_sales_not_open で止める（fail closed）。
 *  - 取引作成は冪等化する（checkoutIdempotency）。同一 intent の再送・リプレイ、二重クリックでは新しい取引を作らず
 *    既存の取引を返す。ストアは Netlify Blobs（env 追加なし）。ストア障害時は fail-open（作成は通す）。
 *
 * 必要 env（このサイト）: PADDLE_API_KEY / CARD_GRANT_INTERNAL_SECRET
 * 応答: 200 { url, transactionId } / 401 invalid_signature / 400 不正 intent / 409 gate / 503 受付前・設定不足 / 502 作成失敗
 */
import { createPaddleTransaction } from '../../../../astro-site/src/lib/billing/paddle/paddleServer.js';
import { verifyPaddleSignature } from '../../../../astro-site/src/lib/billing/paddle/paddleCore.js';
import { PRODUCTION_ORIGIN } from '../../../../astro-site/src/lib/billing/cardSales.js';
import { makeBlobStore, idempotentCreateCheckout } from './lib/checkoutIdempotency.mjs';

const H = { 'content-type': 'application/json', 'cache-control': 'no-store' };
const resp = (status, obj) => new Response(JSON.stringify(obj), { status, headers: H });
// intent は server-to-server の短寿命トークン。短い窓だけ有効にしてリプレイ面を最小化する。
const INTENT_TTL_SEC = 120;

/**
 * テスト可能な本体。store を注入できる（本番は Netlify Blobs、テストは偽ストア）。
 */
export async function handleCreateCheckout({ request, env, store, now = new Date(), createTransaction = createPaddleTransaction }) {
  if (request.method !== 'POST') return resp(405, { error: 'method_not_allowed' });
  const raw = await request.text();
  if (!env.CARD_GRANT_INTERNAL_SECRET) return resp(503, { error: 'internal_secret_missing' });
  const sig = request.headers.get('x-internal-signature') || '';
  if (!verifyPaddleSignature({ header: sig, rawBody: raw, secret: env.CARD_GRANT_INTERNAL_SECRET, toleranceSec: INTENT_TTL_SEC })) {
    return resp(401, { error: 'invalid_signature' });
  }
  let intent = null;
  try { intent = JSON.parse(raw); } catch { return resp(400, { error: 'invalid_json' }); }
  const origin = PRODUCTION_ORIGIN; // 本番専用サイト。intent の origin は本番だけ受ける
  if (!intent || String(intent.origin || '') !== origin) return resp(400, { error: 'origin_mismatch' });

  const recordId = String(intent.recordId || '');
  const productId = String(intent.productId || '');
  const entry = intent.entry === 'card' ? 'card' : 'direct';
  let r;
  try {
    r = await idempotentCreateCheckout({
      store,
      nonce: String(intent.nonce || ''),
      recordId,
      productId,
      now,
      create: () => createTransaction({ env, origin, recordId, productId, entry, now }),
    });
  } catch (e) {
    console.error(JSON.stringify({ event: 'paddle_create_checkout_sep_error', message: String(e?.message || e).slice(0, 120) }));
    return resp(502, { error: 'checkout_failed' });
  }
  if (!r.ok) {
    console.error(JSON.stringify({ event: 'paddle_create_checkout_sep_fail', code: r.code }));
    return resp(r.status || 502, { error: r.code || 'checkout_failed' });
  }
  // degraded: ストア不達で原子的予約を取れず fail-open で作成した稀路。無言にせず記録する。
  console.log(JSON.stringify({ event: 'paddle_create_checkout_sep', product: productId, ...(r.reused ? { reused: r.reused } : {}), ...(r.degraded ? { degraded: true } : {}) }));
  return resp(200, { url: r.url, transactionId: r.transactionId });
}

// Netlify Blobs は実行時に Netlify が提供する。ローカル（テスト/esbuild）で解決できない場所に置くため遅延 import。
// 解決できなければ fail-open（null ストア＝dedup を諦めて作成は通す）。
async function defaultStore() {
  try {
    const { getStore } = await import('@netlify/blobs');
    return makeBlobStore(getStore, 'paddle-checkout');
  } catch {
    return makeBlobStore(() => { throw new Error('blobs_unavailable'); });
  }
}

export default async (request) => handleCreateCheckout({
  request,
  env: process.env,
  store: await defaultStore(),
});
