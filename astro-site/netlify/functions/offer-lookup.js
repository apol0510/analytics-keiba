/**
 * offer-lookup — 割引オファーのトークンから「表示してよい内容だけ」を返す（read-only）
 *
 * `/offer/?t=<token>` のページが表示前に 1 回だけ呼ぶ。
 *
 * ── 返さないもの ────────────────────────────────────────────────
 *   × 完全なメールアドレス（伏せ字だけ返す。URL を拾った第三者に PII を渡さない）
 *   × TokenHash / Airtable recordId / CustomerRecordId / 顧客の契約状況
 *   × Customers の中身（この Function は Customers を**一切読まない**）
 *
 * ── 何も書かない ───────────────────────────────────────────────
 * PATCH / POST を Airtable へ投げない。redeem は申込時（offer-application）だけ。
 *
 * gate: COMEBACK_OFFER_TABLE_READY='1' と PROMO_OFFER_SECRET が無ければ 503。
 */

import {
  OFFERS_TABLE,
  verifyOfferToken,
  isOfferTableEnabled,
  getOfferSecret,
  parseOfferToken,
} from '../../src/lib/promotions/promotionalOffer.js';
import { buildOfferKeyFormula, buildOfferPresentation } from '../../src/lib/promotions/offerIntake.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
  'Cache-Control': 'private, no-store',
};

function json(statusCode, body) {
  return { statusCode, headers: CORS, body: JSON.stringify(body) };
}

/** 検証失敗の理由 → 画面に出す状態とメッセージ（理由をそのまま見せない） */
function presentFailure(reason) {
  const r = String(reason || '');
  if (r === 'expired') {
    return { state: 'expired', message: 'このご案内の有効期限が切れています。お手数ですがサポートへご連絡ください。' };
  }
  if (r.startsWith('not_issued:redeemed')) {
    return { state: 'redeemed', message: 'このご案内は既にお申し込み済みです。入金確認までお待ちください。' };
  }
  if (r.startsWith('not_issued:revoked')) {
    return { state: 'revoked', message: 'このご案内は現在ご利用いただけません。サポートへご連絡ください。' };
  }
  return { state: 'invalid', message: 'ご案内の内容を確認できませんでした。メール内のリンクをもう一度お開きください。' };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'Method Not Allowed' });

  // ── gate（未整備なら機能そのものを閉じる）──────────────────────
  if (!isOfferTableEnabled(process.env)) {
    return json(503, { ok: false, state: 'unavailable', message: '現在このご案内はご利用いただけません。' });
  }
  const secret = getOfferSecret(process.env);
  if (!secret) {
    return json(503, { ok: false, state: 'unavailable', message: '現在このご案内はご利用いただけません。' });
  }

  const KEY = process.env.AIRTABLE_API_KEY;
  const BASE = process.env.AIRTABLE_BASE_ID;
  if (!KEY || !BASE) return json(500, { ok: false, state: 'error', message: 'サーバー設定エラーです。' });

  let token = '';
  try {
    token = String((JSON.parse(event.body || '{}') || {}).token || '').trim();
  } catch {
    return json(400, { ok: false, state: 'invalid', message: 'リクエストが不正です。' });
  }

  const parsed = parseOfferToken(token);
  if (!parsed) return json(200, { ok: false, ...presentFailure('malformed_token') });

  const formula = buildOfferKeyFormula(parsed.offerKey);
  if (!formula) return json(200, { ok: false, ...presentFailure('malformed_token') });

  let record = null;
  try {
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(OFFERS_TABLE)}`);
    url.searchParams.set('filterByFormula', formula);
    url.searchParams.set('maxRecords', '1');
    const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
    if (!res.ok) throw new Error(`offers fetch failed: HTTP ${res.status}`);
    const data = await res.json();
    record = (data.records || [])[0] || null;
  } catch (e) {
    console.error('❌ [offer-lookup] Airtable 参照に失敗:', e.message);
    return json(502, { ok: false, state: 'error', message: '一時的なエラーです。時間をおいてお試しください。' });
  }

  const now = Date.now();
  const verified = verifyOfferToken({ token, record, secret, nowMs: now });
  if (!verified.ok) {
    console.warn('⚠️ [offer-lookup] 検証失敗:', verified.reason, `offerKey=${parsed.offerKey}`);
    return json(200, { ok: false, ...presentFailure(verified.reason) });
  }

  const presentation = buildOfferPresentation({ offer: verified.offer, nowMs: now });
  if (!presentation) return json(500, { ok: false, state: 'error', message: 'ご案内の内容を組み立てられませんでした。' });

  return json(200, { ok: true, state: 'valid', offer: presentation });
};
