/**
 * promotionalOffer.js — その顧客専用の「購入条件」（割引 offer）の単一源（純粋・I/O なし）
 *
 * ── offer は権利ではない ──────────────────────────────────────────
 * offer を発行しても閲覧権は 1 ミリも増えない。`プラン` / `有効期限` /
 * `PaymentConfirmed` / `PaidAt` / `PaymentEmailSent` は**絶対に書かない**。
 * 支払い完了 → 既存の入金確認フロー（confirm-bank-payment）が昇格させる、が唯一の経路。
 *
 * ── 保存先は専用テーブル（Customers のカラムにしない）─────────────────
 * grant（無料権利）は runtime のログイン経路が毎回読むので Customers のカラムに置く。
 * offer は**購入時にしか読まない**うえ、同じ顧客へ時期違いで複数発行しうるので
 * `PromotionalOffers` テーブルへ 1 行ずつ積む。runtime の権限判定は offer を読まない。
 *
 * ── URL を知っている第三者が使えないようにする ─────────────────────
 * offer トークンは `HMAC-SHA256(secret, offerKey + ':' + email)` を含む。
 *   - 保存するのは**ハッシュだけ**（生トークンは案内メール / URL の中にしか存在しない）
 *   - 検証時は「トークンから復元した offerKey で行を引く」→「その行の email で HMAC を再計算」
 *     → 一致・Status=issued・期限内 のときだけ有効
 *   - 別人がトークンを拾っても、申込フォームの email が offer の email と一致しなければ失敗する
 *
 * ── 二重課金・二重昇格の防止 ────────────────────────────────────
 *   - `OfferKey` は (operationId, offerId, version, customerRecordId) から決まる。
 *     同じ操作を再実行しても upsert で 1 行のまま（発行の冪等性）
 *   - 利用は `Status: issued → redeemed` の一方向遷移でしか進まない。
 *     redeemed / expired / revoked の offer は再利用できない
 *   - 昇格そのものは既存フローが `RequestedPlan` を承認時にクリアする冪等性で守られている
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { OFFER_KIND } from './promotionOfferCatalog.js';

/** offer 台帳テーブル（AK 専用。KMA のテーブルとは無関係） */
export const OFFERS_TABLE = 'PromotionalOffers';

/** offer の状態（一方向にしか進まない） */
export const OFFER_STATUS = Object.freeze({
  ISSUED: 'issued',
  REDEEMED: 'redeemed',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
});

/** このモジュールが PromotionalOffers へ書いてよいフィールド */
export const OFFER_WRITABLE_FIELDS = Object.freeze([
  'OfferKey', 'CustomerRecordId', 'Email', 'OfferId', 'OfferVersion',
  'TargetTier', 'BillingTerm', 'PlanName', 'PlanType',
  'RegularPrice', 'OfferPrice', 'DiscountType', 'DiscountValue',
  'StartsAt', 'ExpiresAt', 'Status', 'OperationId', 'Source', 'TokenHash',
  'RedeemedAt', 'Notes',
]);

/**
 * offer 台帳に**絶対に現れてはいけない**名前（Customers 側の課金・権限フィールド）。
 * このモジュールは Customers を 1 バイトも書かないが、将来の改変を検知するため固定する。
 */
export const OFFER_FORBIDDEN_FIELDS = Object.freeze([
  'プラン', 'Plan', 'PlanTypeCurrent', '有効期限', 'ValidUntil',
  'PaidAt', 'PaymentConfirmed', 'PaymentEmailSent', 'PaymentEmailStatus',
  'LifetimeSanrenpuku', '三連複Lifetime', 'PremiumPlusEligibility',
  'WithdrawalRequested', 'RequestedPlan', 'RequestedPlanType', 'RequestedAmount',
  'SessionVersion',
]);

/** offer の既定有効日数（案内メールから申し込むまでの猶予） */
export const DEFAULT_OFFER_TTL_DAYS = 14;
export const MAX_OFFER_TTL_DAYS = 90;

const ALLOW = new Set(OFFER_WRITABLE_FIELDS);
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * offer 台帳への書き込みが有効か（本番 Airtable に `PromotionalOffers` を作るまで false）。
 * 特典フィールドの gate（COMEBACK_GRANT_FIELDS_READY）とは**別**に持つ。
 * 片方だけ用意した状態で PATCH すると 404/422 になり、同じ操作の他の書き込みまで巻き添えになる。
 */
export function isOfferTableEnabled(env) {
  return !!env && env.COMEBACK_OFFER_TABLE_READY === '1';
}

/** offer トークンの署名鍵が使えるか（無ければ URL 無しの offer になる） */
export function getOfferSecret(env) {
  const s = env && typeof env.PROMO_OFFER_SECRET === 'string' ? env.PROMO_OFFER_SECRET.trim() : '';
  return s.length >= 16 ? s : null;
}

/** fields が offer 台帳の許可フィールドだけか（書き込み直前の最終防衛） */
export function assertOnlyOfferFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false;
  const keys = Object.keys(fields);
  if (keys.length === 0) return false;
  return keys.every((k) => ALLOW.has(k));
}

function sha256(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function normalizeEmail(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

/**
 * offer の一意キー（冪等性の鍵）。
 * 同じ operationId・同じ offer・同じ顧客なら常に同じ値になり、upsert で 1 行のまま。
 */
export function computeOfferKey({ operationId, offerId, version, customerRecordId }) {
  const op = String(operationId || '').trim();
  const oid = String(offerId || '').trim();
  const rec = String(customerRecordId || '').trim();
  if (!op || !oid || !rec) return null;
  return sha256(`ak-offer|${op}|${oid}|v${version ?? ''}|${rec}`).slice(0, 32);
}

/**
 * offer トークン（顧客だけが使える purchase URL のパラメータ）。
 * 形式: `<offerKey>.<hmac(32hex)>`
 */
export function signOfferToken({ offerKey, email, secret }) {
  const key = String(offerKey || '').trim();
  const mail = normalizeEmail(email);
  const sec = String(secret || '');
  if (!key || !mail || sec.length < 16) return null; // 鍵が弱い / 情報不足なら発行しない
  const mac = createHmac('sha256', sec).update(`${key}:${mail}`, 'utf8').digest('hex').slice(0, 32);
  return `${key}.${mac}`;
}

/** token → offerKey（形式が不正なら null）。DB を引く前の軽い分解。 */
export function parseOfferToken(token) {
  const t = String(token || '').trim();
  const m = /^([0-9a-f]{32})\.([0-9a-f]{32})$/.exec(t);
  return m ? { offerKey: m[1], mac: m[2] } : null;
}

/** 保存用のトークンハッシュ（生トークンは保存しない） */
export function hashOfferToken(token) {
  const t = String(token || '').trim();
  return t ? sha256(t) : null;
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/**
 * offer トークンを検証する（純粋）。Airtable から引いた 1 行を渡す。
 *
 * 落ちる条件（すべて fail closed・理由は呼び出し側で握りつぶさず返す）:
 *   - トークン形式が不正 / 署名不一致（＝ URL を拾った第三者）
 *   - 申込フォームの email が offer の email と違う
 *   - Status が issued 以外（redeemed / revoked / expired）
 *   - 有効期限切れ
 *
 * @param {{ token: string, record: object|null, secret: string, nowMs: number, claimedEmail?: string }} input
 * @returns {{ ok: true, offer: object }|{ ok: false, reason: string }}
 */
export function verifyOfferToken({ token, record, secret, nowMs, claimedEmail }) {
  const parsed = parseOfferToken(token);
  if (!parsed) return { ok: false, reason: 'malformed_token' };
  const f = (record && record.fields) || null;
  if (!f) return { ok: false, reason: 'offer_not_found' };
  if (String(f.OfferKey || '') !== parsed.offerKey) return { ok: false, reason: 'offer_not_found' };

  const email = normalizeEmail(f.Email);
  const expected = signOfferToken({ offerKey: parsed.offerKey, email, secret });
  if (!expected) return { ok: false, reason: 'secret_unavailable' };
  if (!safeEqualHex(expected, String(token).trim())) return { ok: false, reason: 'bad_signature' };

  // 申込フォームの email と一致するか（トークンを転送されても他人は使えない）
  if (claimedEmail !== undefined && normalizeEmail(claimedEmail) !== email) {
    return { ok: false, reason: 'email_mismatch' };
  }

  const status = String(f.Status || '').trim().toLowerCase();
  if (status !== OFFER_STATUS.ISSUED) return { ok: false, reason: `not_issued:${status || 'unknown'}` };

  const expiresMs = Date.parse(String(f.ExpiresAt || ''));
  if (!Number.isFinite(expiresMs)) return { ok: false, reason: 'no_expiry' };
  if (expiresMs <= nowMs) return { ok: false, reason: 'expired' };

  const offerPrice = Number(f.OfferPrice);
  if (!Number.isInteger(offerPrice) || offerPrice <= 0) return { ok: false, reason: 'invalid_price' };

  return {
    ok: true,
    offer: {
      offerKey: parsed.offerKey,
      email,
      offerId: String(f.OfferId || ''),
      version: Number(f.OfferVersion) || 0,
      planName: String(f.PlanName || ''),
      planType: String(f.PlanType || ''),
      regularPrice: Number(f.RegularPrice) || 0,
      offerPrice,
      term: String(f.BillingTerm || ''),
      startsMs: Number.isFinite(Date.parse(String(f.StartsAt || ''))) ? Date.parse(String(f.StartsAt)) : null,
      expiresMs,
      customerRecordId: String(f.CustomerRecordId || ''),
    },
  };
}

/**
 * offer 台帳へ書く 1 行を組み立てる。
 *
 * @param {{
 *   offer: object,            resolveOffer() の戻り値 .offer
 *   customer: { recordId: string, email: string },
 *   nowMs: number, operationId: string, source?: string,
 *   ttlDays?: number, secret?: string,
 * }} input
 * @returns {{ fields: object, token: string|null, offerKey: string }|{ error: string }}
 */
export function buildOfferRecord({ offer, customer, nowMs, operationId, source, ttlDays, secret }) {
  if (!offer || offer.kind !== OFFER_KIND.PURCHASE) return { error: 'not_a_purchase_offer' };
  if (!Number.isFinite(nowMs)) return { error: 'invalid_now' };
  const recordId = String(customer?.recordId || '').trim();
  const email = normalizeEmail(customer?.email);
  if (!recordId || !email) return { error: 'invalid_customer' };

  const offerKey = computeOfferKey({
    operationId, offerId: offer.offerId, version: offer.version, customerRecordId: recordId,
  });
  if (!offerKey) return { error: 'invalid_operation' };

  const days = Number.isInteger(ttlDays) && ttlDays > 0 && ttlDays <= MAX_OFFER_TTL_DAYS
    ? ttlDays : DEFAULT_OFFER_TTL_DAYS;
  const expiresMs = nowMs + days * DAY_MS;

  // 鍵が無ければトークンを作らない（URL 無しの offer として台帳には残す＝手動案内は可能）
  const token = secret ? signOfferToken({ offerKey, email, secret }) : null;

  const fields = {
    OfferKey: offerKey,
    CustomerRecordId: recordId,
    Email: email,
    OfferId: offer.offerId,
    OfferVersion: offer.version,
    TargetTier: offer.targetTier,
    BillingTerm: offer.term,
    PlanName: offer.planName || '',
    PlanType: offer.planType || '',
    RegularPrice: offer.regularPrice,
    OfferPrice: offer.offerPrice,
    DiscountType: offer.discountType,
    DiscountValue: offer.discountValue === null || offer.discountValue === undefined
      ? '' : String(offer.discountValue),
    StartsAt: new Date(nowMs).toISOString(),
    ExpiresAt: new Date(expiresMs).toISOString(),
    Status: OFFER_STATUS.ISSUED,
    OperationId: String(operationId),
    Source: String(source || '').slice(0, 200),
  };
  const hash = hashOfferToken(token);
  if (hash) fields.TokenHash = hash;

  if (!assertOnlyOfferFields(fields)) return { error: 'field_allow_list_violation' };
  return { fields, token, offerKey, expiresMs };
}

/**
 * 利用済みにする更新（Status: issued → redeemed）。
 * 既に issued でなければ書かない（二重利用の防止は状態遷移で行う）。
 */
export function buildRedeemFields({ record, nowMs }) {
  const f = (record && record.fields) || {};
  if (String(f.Status || '').trim().toLowerCase() !== OFFER_STATUS.ISSUED) {
    return { skipped: 'not_issued' };
  }
  const fields = {
    Status: OFFER_STATUS.REDEEMED,
    RedeemedAt: new Date(nowMs).toISOString(),
  };
  return assertOnlyOfferFields(fields) ? { fields } : { skipped: 'field_allow_list_violation' };
}

/** 取り消し（発行済み offer を無効化する。権利には触れない） */
export function buildOfferRevokeFields({ record, nowMs, reason }) {
  const f = (record && record.fields) || {};
  const status = String(f.Status || '').trim().toLowerCase();
  if (status === OFFER_STATUS.REDEEMED) return { skipped: 'already_redeemed' };
  if (status === OFFER_STATUS.REVOKED) return { skipped: 'already_revoked' };
  const fields = {
    Status: OFFER_STATUS.REVOKED,
    Notes: `revoked ${new Date(nowMs).toISOString()}${reason ? ` / ${String(reason).slice(0, 150)}` : ''}`,
  };
  return assertOnlyOfferFields(fields) ? { fields } : { skipped: 'field_allow_list_violation' };
}

/** 既に有効な同一 offer を持っているか（重複発行の抑止） */
export function hasActiveOffer({ records, offerId, customerRecordId, nowMs }) {
  for (const rec of records || []) {
    const f = (rec && rec.fields) || {};
    if (String(f.CustomerRecordId || '') !== String(customerRecordId)) continue;
    if (String(f.OfferId || '') !== String(offerId)) continue;
    if (String(f.Status || '').trim().toLowerCase() !== OFFER_STATUS.ISSUED) continue;
    const exp = Date.parse(String(f.ExpiresAt || ''));
    if (Number.isFinite(exp) && exp > nowMs) return true;
  }
  return false;
}

/** この operationId で既に発行済みか（再実行時のスキップ） */
export function findOfferByKey({ records, offerKey }) {
  for (const rec of records || []) {
    if (String(rec?.fields?.OfferKey || '') === String(offerKey)) return rec;
  }
  return null;
}
