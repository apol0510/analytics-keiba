/**
 * paddleCore.js — Paddle Billing 連携の判定（純粋・I/O なし）
 *
 * 2026-10-11 MK 確定: 代替決済の第一優先。TIROL DATA LABO 名義の**新規アカウント**だけを使う（旧 Paddle アカウントは使わない）。
 * Sandbox E2E を先に完成させる。本番受付は Paddle が AK の取扱商品を承認したあと、MK の明示決定で
 * cardSales.CARD_SALES_OPEN.paddle を変える PR だけで開く（env では開かない）。
 *
 * ## 守ること
 * - 金額・商品はサーバー（cardOneTime.js）が決める。非カタログ価格（API 鍵でしか作れない）で取引を作り、
 *   tax_mode=internal（税込 ¥49,800 のまま。Paddle が販売者として税を内側で扱う）。
 * - 支払いの成否は**通知を信じず API で照会**（GET /transactions/{id}）。origin=api・JPY・総額・custom_data を照合。
 * - Webhook の Paddle-Signature は HMAC-SHA256（`ts:rawBody`）。定数時間で比べ、時刻のずれも見る。
 * - 決済会社へ送る名前は paymentDisplayNames の禁止語ルールを通った名前だけ（cardOneTime の displayName）。
 * - custom_data には recordId と商品 ID だけ（メールアドレスを載せない）。
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { cardProductById } from '../cardOneTime.js';
import { CARD_SALES_OPEN as SALES, resolveCardMode } from '../cardSales.js';
import { paddleCheckoutPage } from '../neutralCheckoutHost.js';

export const PROVIDER = 'paddle';
export const CARD_SALES_OPEN = SALES[PROVIDER];
export const PADDLE_API = Object.freeze({ test: 'https://sandbox-api.paddle.com', live: 'https://api.paddle.com' });
export const SIGNATURE_TOLERANCE_SEC = 300;

/** 付与: 支払い完了（completed）。paid は「支払い済み・社内処理前」なので照会で paid/completed とも受ける */
export const GRANT_EVENTS = Object.freeze(['transaction.completed', 'transaction.paid']);
/** 返金・チャージバック: adjustment の作成・更新（承認済みだけ戻す） */
export const ADJUSTMENT_EVENTS = Object.freeze(['adjustment.created', 'adjustment.updated']);

const TXN_RE = /^txn_[a-z0-9]{10,40}$/;
const ADJ_RE = /^adj_[a-z0-9]{10,40}$/;
const RECORD_RE = /^rec[A-Za-z0-9]{14}$/;

export const isTransactionId = (id) => TXN_RE.test(String(id || ''));

/** API 鍵の種類（2025-05 以降の形式。接頭辞で Sandbox と本番を見分ける） */
export function keyMode(key) {
  const k = String(key || '').trim();
  if (/^pdl_sdbx_apikey_/.test(k)) return 'test';
  if (/^pdl_live_apikey_/.test(k)) return 'live';
  return null;
}

/** Paddle.js 用のクライアントトークン（公開してよい値）の種類 */
export function clientTokenMode(token) {
  const t = String(token || '').trim();
  if (/^test_[A-Za-z0-9]+$/.test(t)) return 'test';
  if (/^live_[A-Za-z0-9]+$/.test(t)) return 'live';
  return null;
}

/** このサイトで Paddle を使ってよいか（本番サイト=本番鍵かつ販売開始済み／それ以外=Sandbox 鍵だけ） */
export function resolvePaddleMode({ key, origin, salesOpen = CARD_SALES_OPEN } = {}) {
  const r = resolveCardMode({ provider: PROVIDER, keyMode: keyMode(key), origin, salesOpen });
  return r.ok ? { ...r, apiBase: PADDLE_API[r.mode] } : r;
}

/**
 * 取引（POST /transactions）の本文。一回払い・非カタログ価格・税込。
 * checkout.url は送らない（2026-10-12）。決済画面を開くページは Paddle アカウントの Default payment link
 * （承認済みドメイン）に任せる。明示した checkout.url はドメイン承認が無いと 400
 * transaction_checkout_url_domain_is_not_approved になるため。返ってきた URL が自サイトかは
 * checkoutUrlMatchesOrigin で確かめ、違えば使わない（fail closed）。
 */
export function buildTransactionBody({ productId, recordId, origin }) {
  const product = cardProductById(productId);
  if (!product) throw Object.assign(new Error('invalid_product'), { code: 'invalid_product' });
  if (!RECORD_RE.test(String(recordId || ''))) throw Object.assign(new Error('invalid_record'), { code: 'invalid_record' });
  return {
    items: [{
      quantity: 1,
      price: {
        description: product.displayName,
        name: product.displayName,
        unit_price: { amount: String(product.amountYen), currency_code: 'JPY' },
        tax_mode: 'internal',
        product: { name: product.displayName, tax_category: 'standard' },
      },
    }],
    currency_code: 'JPY',
    collection_mode: 'automatic',
    custom_data: { ak_record: String(recordId), ak_product: product.id },
  };
}

/** Paddle が返した決済画面 URL が、このサイトの決済ページ（paddleCheckoutPage）か（別ドメインへ顧客を送らない） */
export function checkoutUrlMatchesOrigin(url, origin) {
  try {
    const u = new URL(String(url || ''));
    // 本番サイトは中立ホストの決済ページ（Paddle の承認ドメイン）・それ以外は自サイトの /checkout/paddle/
    return `${u.origin}${u.pathname}` === paddleCheckoutPage(origin) && /^txn_[a-z0-9]+$/.test(u.searchParams.get('_ptxn') || '');
  } catch { return false; }
}

/**
 * Paddle-Signature: "ts=<unix>;h1=<hex>[;h1=<hex>]"（鍵の切替中は h1 が複数）
 * 署名対象は `${ts}:${rawBody}`（受け取った本文そのまま）
 */
export function verifyPaddleSignature({ header, rawBody, secret, nowSec = Math.floor(Date.now() / 1000), toleranceSec = SIGNATURE_TOLERANCE_SEC }) {
  if (!secret || !header || typeof rawBody !== 'string') return false;
  let ts = null;
  const sigs = [];
  for (const part of String(header).split(';')) {
    const [k, v] = part.split('=');
    if (k === 'ts') ts = v;
    if (k === 'h1' && /^[0-9a-f]{64}$/.test(v || '')) sigs.push(v);
  }
  if (!/^\d{9,11}$/.test(String(ts || '')) || !sigs.length) return false;
  if (Math.abs(nowSec - Number(ts)) > toleranceSec) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex'), 'utf8');
  return sigs.some((s) => {
    const got = Buffer.from(s, 'utf8');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

/** Webhook 本文から必要なものだけ（値は照会の手がかりにだけ使う） */
export function parsePaddleWebhook(body) {
  let j = body;
  if (typeof body === 'string') {
    try { j = JSON.parse(body); } catch { return null; }
  }
  if (!j || typeof j !== 'object') return null;
  const eventType = String(j.event_type || '');
  const d = j.data || {};
  if (GRANT_EVENTS.includes(eventType) && isTransactionId(d.id)) return { eventType, transactionId: d.id };
  if (ADJUSTMENT_EVENTS.includes(eventType) && ADJ_RE.test(String(d.id || '')) && isTransactionId(d.transaction_id)) {
    return { eventType, adjustmentId: d.id, transactionId: d.transaction_id };
  }
  return { eventType, ignored: true };
}

/**
 * API で照会した取引（GET /transactions/{id}）を確かめる。
 * @returns {{ ok: true, kind: 'paid', recordId, productId, paidAt } | { ok: false, reason }}
 */
export function matchTransaction(txn) {
  if (!txn || typeof txn !== 'object') return { ok: false, reason: 'transaction_not_found' };
  if (String(txn.origin || '') !== 'api') return { ok: false, reason: 'origin_not_api' };
  const cd = txn.custom_data || {};
  const product = cardProductById(cd.ak_product);
  if (!product) return { ok: false, reason: 'invalid_product' };
  if (!RECORD_RE.test(String(cd.ak_record || ''))) return { ok: false, reason: 'invalid_record' };
  if (String(txn.currency_code || '') !== 'JPY') return { ok: false, reason: 'currency_mismatch' };
  if (Number(txn.details?.totals?.grand_total) !== product.amountYen) return { ok: false, reason: 'amount_mismatch' };
  const status = String(txn.status || '');
  if (status !== 'paid' && status !== 'completed') return { ok: false, reason: `status_${status || 'unknown'}` };
  const at = new Date(txn.billed_at || txn.updated_at || txn.created_at || Date.now());
  return { ok: true, kind: 'paid', recordId: cd.ak_record, productId: product.id, paidAt: Number.isNaN(at.getTime()) ? new Date() : at };
}

/**
 * 照会した adjustment（返金・チャージバック）から、権限を戻すか決める。
 * 戻すのは承認済み（approved）の refund / chargeback だけ。全額（type=full）なら戻す、一部なら管理者へ。
 * @returns {{ action: 'revert', full: boolean } | { action: 'ignore', reason }}
 */
export function decideAdjustment(adj, transactionId) {
  if (!adj || typeof adj !== 'object') return { action: 'ignore', reason: 'adjustment_not_found' };
  if (String(adj.transaction_id || '') !== String(transactionId)) return { action: 'ignore', reason: 'transaction_mismatch' };
  const action = String(adj.action || '');
  if (action !== 'refund' && action !== 'chargeback') return { action: 'ignore', reason: `action_${action || 'unknown'}` };
  if (String(adj.status || '') !== 'approved') return { action: 'ignore', reason: `status_${adj.status || 'unknown'}` };
  // chargeback は常に全額扱い（権限を戻す）。refund は type=full だけ全額
  return { action: 'revert', full: action === 'chargeback' || String(adj.type || '') === 'full' };
}
