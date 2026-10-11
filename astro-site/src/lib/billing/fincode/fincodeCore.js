/**
 * fincodeCore.js — fincode byGMO 連携の判定（純粋・I/O なし）
 *
 * 2026-10-11 MK 確定: 代替決済の優先候補。Sandbox（テスト環境）E2E を先に完成させる。
 * 販売開始（本番キー・本番サイトでの受付）は MK の明示決定まで行わない（CARD_SALES_OPEN）。
 *
 * ## 守ること
 * - **本番サイトでテストキーを使わない**（テストカードで本物の Premium が付与される事故を防ぐ）。
 *   **本番キーは CARD_SALES_OPEN が true のときだけ・本番サイトだけ**。それ以外は何もしない（fail closed）。
 * - 金額・商品はサーバー（cardOneTime.js）が決める。決済の成功は**通知を信じず API で照会**して確かめる。
 * - Webhook の Fincode-Signature は登録した固定文字列（HMAC ではない）→ 定数時間比較のうえ、必ず API 照会。
 * - 決済会社へ送る名前は paymentDisplayNames の禁止語ルールを通す（cardOneTime の displayName）。
 * - 秘密鍵・カード情報・メールアドレスをログ・metadata に出さない（client_field には recordId と商品 ID だけ）。
 */

import { timingSafeEqual } from 'node:crypto';
import { cardProductById } from '../cardOneTime.js';
import { CARD_SALES_OPEN as SALES, PRODUCTION_ORIGIN, resolveCardMode } from '../cardSales.js';

export const PROVIDER = 'fincode';
/**
 * fincode の**本番受付**を開くか。単一源は cardSales.js の CARD_SALES_OPEN.fincode（MK の明示決定で変える PR だけ）。
 */
export const CARD_SALES_OPEN = SALES[PROVIDER];
export { PRODUCTION_ORIGIN };

export const FINCODE_API = Object.freeze({ test: 'https://api.test.fincode.jp', live: 'https://api.fincode.jp' });

/** 受け付けるイベント（決済の確定・取消） */
export const GRANT_EVENTS = Object.freeze(['payments.card.exec', 'payments.card.capture', 'payments.card.secure']);
export const REFUND_EVENTS = Object.freeze(['payments.card.cancel']);

export function keyMode(key) {
  const k = String(key || '').trim();
  if (/^m_test_/.test(k)) return 'test';
  if (/^m_prod_/.test(k)) return 'live';
  return null;
}

/**
 * このサイト（オリジン）で fincode を使ってよいか。
 * - 本番サイト: 本番キー かつ CARD_SALES_OPEN のときだけ
 * - Deploy Preview / ローカル: テストキーのときだけ
 * @returns {{ ok: true, mode: 'test'|'live', apiBase: string } | { ok: false, reason: string }}
 */
export function resolveFincodeMode({ key, origin, salesOpen = CARD_SALES_OPEN } = {}) {
  const r = resolveCardMode({ provider: PROVIDER, keyMode: keyMode(key), origin, salesOpen });
  return r.ok ? { ...r, apiBase: FINCODE_API[r.mode] } : r;
}

/** 注文 ID（fincode の order_id）。決済は削除できないので毎回新しく作る（推測されにくい乱数） */
export function newOrderId(productId, rand) {
  const p = String(productId || '').replace(/[^a-z-]/g, '').slice(0, 20);
  return `ak-${p}-${String(rand || '').replace(/[^a-z0-9]/gi, '').slice(0, 24)}`;
}

/**
 * 決済画面（リダイレクト型 POST /v1/sessions）の本文。
 * - job_code=CAPTURE（既定の AUTH のままだと 25 日で自動取消）
 * - 3D セキュア 2.0 必須（tds_type=2, tds2_type=2: 非対応カードはエラー）
 * - client_field_1 = Customers の recordId、client_field_2 = 商品 ID（メールは載せない）
 */
export function buildSessionBody({ productId, orderId, recordId, origin, expireAt }) {
  const product = cardProductById(productId);
  if (!product) throw Object.assign(new Error('invalid_product'), { code: 'invalid_product' });
  return {
    success_url: `${origin}/checkout/card-complete/?order=${encodeURIComponent(orderId)}`,
    cancel_url: `${origin}/pricing/?checkout=cancelled`,
    expire: expireAt,
    shop_service_name: product.displayName,
    transaction: {
      pay_type: ['Card'],
      amount: String(product.amountYen),
      order_id: orderId,
      client_field_1: String(recordId),
      client_field_2: product.id,
    },
    card: { job_code: 'CAPTURE', tds_type: '2', tds2_type: '2', td_tenant_name: 'Analytics Premium' },
  };
}

/** Webhook の Fincode-Signature（登録した固定文字列）を定数時間で比べる */
export function verifyWebhookSignature(received, expected) {
  const a = Buffer.from(String(received || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (!b.length || a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Webhook 本文から必要なものだけ取り出す（受け取った値は照会の手がかりにだけ使う） */
export function parseWebhook(body) {
  let j = body;
  if (typeof body === 'string') {
    try { j = JSON.parse(body); } catch { return null; }
  }
  if (!j || typeof j !== 'object') return null;
  const event = String(j.event || '');
  const orderId = String(j.order_id || '');
  if (!event || !/^ak-[a-z-]+-[a-z0-9]+$/i.test(orderId)) return null;
  return { event, orderId };
}

/**
 * API で照会した決済（GET /v1/payments/{order_id}）と、申込時の予約を突き合わせる。
 * 予約: { recordId, productId, amountYen, mode }（申込時にサーバーが Redis へ置いたもの）
 * @returns {{ ok: true, kind: 'paid'|'canceled', recordId, productId, paidAt: Date }
 *          | { ok: false, reason: string }}
 */
export function matchPayment({ payment, reservation }) {
  if (!payment || typeof payment !== 'object') return { ok: false, reason: 'payment_not_found' };
  if (!reservation) return { ok: false, reason: 'no_reservation' };
  const product = cardProductById(reservation.productId);
  if (!product) return { ok: false, reason: 'invalid_product' };
  if (String(payment.order_id || payment.id || '') !== String(reservation.orderId)) return { ok: false, reason: 'order_mismatch' };
  if (Number(payment.amount) !== product.amountYen || Number(reservation.amountYen) !== product.amountYen) {
    return { ok: false, reason: 'amount_mismatch' };
  }
  if (!/^rec[A-Za-z0-9]{14}$/.test(String(reservation.recordId || ''))) return { ok: false, reason: 'invalid_record' };
  if (String(payment.client_field_1 || '') !== String(reservation.recordId)) return { ok: false, reason: 'record_mismatch' };
  if (String(payment.client_field_2 || '') !== product.id) return { ok: false, reason: 'product_mismatch' };
  const status = String(payment.status || '').toUpperCase();
  const at = new Date(payment.process_date || payment.updated || payment.created || Date.now());
  const paidAt = Number.isNaN(at.getTime()) ? new Date() : at;
  if (status === 'CAPTURED') return { ok: true, kind: 'paid', recordId: reservation.recordId, productId: product.id, paidAt };
  if (status === 'CANCELED') return { ok: true, kind: 'canceled', recordId: reservation.recordId, productId: product.id, paidAt };
  return { ok: false, reason: `status_${status.toLowerCase() || 'unknown'}` };
}

// 返金の戻しは決済会社共通の単一源（cardRefund.js）。互換のため再エクスポート
export { SNAPSHOT_FIELDS, snapshotFields, decideRefundRevert } from '../cardRefund.js';
