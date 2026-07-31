/**
 * offerRevokePlan — 発行済み割引オファーを 1 件だけ取り消すための判定（純粋・Airtable 非依存）
 *
 * 「誤って発行したオファーを管理画面から安全に無効化する」ための唯一の判定源。
 * revoke のフィールド生成は **`buildOfferRevokeFields()` に完全委譲**する
 * （このモジュールは Status / Notes を自前で組み立てない。二重実装を作らない）。
 *
 * ── revoke は「権利の変更」ではない ─────────────────────────────
 * 割引オファーは **購入条件**であって閲覧権ではない（`COMEBACK_GRANTS.md` §1 の D）。
 * したがって取り消しても顧客の閲覧権・課金契約は 1 ミリも動かない。
 * このモジュールは Customers のフィールド名を 1 つも知らないし、返り値にも含めない。
 *
 * ── 無料特典（grant）の取り消しとは別物 ──────────────────────────
 * grant revoke（`buildRevokePlan` / `handleRevoke`）は Customers の特典カラムを消す。
 * offer revoke は `PromotionalOffers` の 1 行だけを触る。**経路を混ぜない**。
 */

import { createHash } from 'node:crypto';
import {
  OFFER_STATUS,
  buildOfferRevokeFields,
  assertOnlyOfferFields,
} from './promotionalOffer.js';

/** 取り消せない理由（すべて fail closed。黙って成功にしない） */
export const OFFER_REVOKE_SKIP = Object.freeze({
  NOT_FOUND: 'offer_not_found',
  ALREADY_REDEEMED: 'already_redeemed',
  ALREADY_REVOKED: 'already_revoked',
  EXPIRED: 'expired',
  OPERATION_MISMATCH: 'operation_mismatch',
  CUSTOMER_MISMATCH: 'customer_mismatch',
  OFFER_KEY_MISMATCH: 'offer_key_mismatch',
  NO_EXPIRY: 'no_expiry',
  FIELD_ALLOW_LIST_VIOLATION: 'field_allow_list_violation',
});

export const OFFER_REVOKE_SKIP_LABEL = Object.freeze({
  offer_not_found: 'オファーが見つからない',
  already_redeemed: '既に申込済み（redeemed）のため取り消せない',
  already_revoked: '既に取り消し済み',
  expired: '有効期限切れ（expired）のため取り消せない',
  operation_mismatch: '操作 ID が一致しない',
  customer_mismatch: '対象顧客が一致しない',
  offer_key_mismatch: 'OfferKey が一致しない',
  no_expiry: '有効期限が読めない（データ不整合）',
  field_allow_list_violation: '書き込みフィールドが許可リスト外',
});

const str = (v) => String(v ?? '').trim();

/**
 * 台帳の Status と有効期限から**実効状態**を出す。
 *
 * `expired` は Status 列に書かれるとは限らない（発行時は issued のまま時間が過ぎる）。
 * 期限切れは `verifyOfferToken` が実行時に弾いており、台帳を書き換える処理は無い。
 * したがって取り消し可否も **時刻で判定**する。
 */
export function resolveOfferStatus({ record, nowMs }) {
  const f = (record && record.fields) || null;
  if (!f) return OFFER_STATUS.EXPIRED;
  const status = str(f.Status).toLowerCase();
  if (status === OFFER_STATUS.REDEEMED) return OFFER_STATUS.REDEEMED;
  if (status === OFFER_STATUS.REVOKED) return OFFER_STATUS.REVOKED;
  const exp = Date.parse(str(f.ExpiresAt));
  if (Number.isFinite(exp) && exp <= nowMs) return OFFER_STATUS.EXPIRED;
  return status === OFFER_STATUS.ISSUED ? OFFER_STATUS.ISSUED : OFFER_STATUS.EXPIRED;
}

/**
 * 管理画面に出してよい情報だけを取り出す。
 *
 * **含めないもの（意図的）**: `Email` / `TokenHash` / 生トークン / 氏名。
 * 誤発行の取り消しに顧客の PII は要らない。対象の一意特定は
 * `offerRecordId` / `OfferKey` / `CustomerRecordId` で足りる。
 */
export function describeOfferForRevoke({ record, nowMs }) {
  const f = (record && record.fields) || {};
  const regular = Number(f.RegularPrice) || 0;
  const price = Number(f.OfferPrice) || 0;
  return {
    offerRecordId: str(record && record.id),
    offerKey: str(f.OfferKey),
    offerId: str(f.OfferId),
    offerVersion: Number(f.OfferVersion) || 0,
    targetTier: str(f.TargetTier),
    billingTerm: str(f.BillingTerm),
    planName: str(f.PlanName),
    planType: str(f.PlanType),
    regularPrice: regular,
    offerPrice: price,
    discountPercent: regular > 0 && price > 0 ? Math.round((1 - price / regular) * 100) : 0,
    status: resolveOfferStatus({ record, nowMs }),
    rawStatus: str(f.Status).toLowerCase(),
    startsAt: str(f.StartsAt),
    expiresAt: str(f.ExpiresAt),
    operationId: str(f.OperationId),
    customerRecordId: str(f.CustomerRecordId),
    source: str(f.Source),
  };
}

/**
 * dry-run → 実行の受け渡しトークン。
 *
 * **状態が 1 つでも動いたら値が変わる**ように、可変な列（Status / RedeemedAt / Notes）と
 * 同一性の列（recordId / OfferKey / OperationId / CustomerRecordId / ExpiresAt）を混ぜる。
 * これにより「dry-run 後に顧客が申し込んだ（redeemed）」を実行直前に検知して 409 で止められる。
 */
export function computeOfferRevokeFingerprint({ record }) {
  const f = (record && record.fields) || {};
  const seed = [
    str(record && record.id),
    str(f.OfferKey),
    str(f.OperationId),
    str(f.CustomerRecordId),
    str(f.OfferId),
    str(f.Status).toLowerCase(),
    str(f.ExpiresAt),
    str(f.RedeemedAt),
    str(f.Notes),
  ].join('|');
  return createHash('sha256').update(seed, 'utf8').digest('hex');
}

/**
 * 1 件の offer について「取り消せるか」と「書き込む内容」を確定する。
 *
 * @param {{
 *   record: object|null,                 Airtable の 1 レコード（fields 付き）
 *   nowMs: number,
 *   expect?: { operationId?: string, customerRecordId?: string, offerKey?: string },
 *   reason?: string,
 * }} input
 * @returns {{ ok: true, offer: object, fields: object, fingerprint: string }
 *          |{ ok: false, reason: string, offer: object|null, fingerprint: string|null }}
 */
export function planOfferRevoke({ record, nowMs, expect, reason }) {
  const f = (record && record.fields) || null;
  if (!f) return { ok: false, reason: OFFER_REVOKE_SKIP.NOT_FOUND, offer: null, fingerprint: null };

  const offer = describeOfferForRevoke({ record, nowMs });
  const fingerprint = computeOfferRevokeFingerprint({ record });
  const no = (r) => ({ ok: false, reason: r, offer, fingerprint });

  // ── 対象の一意特定（取り違えを構造的に防ぐ）──
  const e = expect || {};
  if (e.operationId !== undefined && str(e.operationId) !== offer.operationId) {
    return no(OFFER_REVOKE_SKIP.OPERATION_MISMATCH);
  }
  if (e.customerRecordId !== undefined && str(e.customerRecordId) !== offer.customerRecordId) {
    return no(OFFER_REVOKE_SKIP.CUSTOMER_MISMATCH);
  }
  if (e.offerKey !== undefined && str(e.offerKey) !== offer.offerKey) {
    return no(OFFER_REVOKE_SKIP.OFFER_KEY_MISMATCH);
  }

  // ── 状態（issued 以外はすべて不可。二重 revoke もここで止まる）──
  if (!str(f.ExpiresAt) || !Number.isFinite(Date.parse(str(f.ExpiresAt)))) {
    return no(OFFER_REVOKE_SKIP.NO_EXPIRY);
  }
  const status = offer.status;
  if (status === OFFER_STATUS.REDEEMED) return no(OFFER_REVOKE_SKIP.ALREADY_REDEEMED);
  if (status === OFFER_STATUS.REVOKED) return no(OFFER_REVOKE_SKIP.ALREADY_REVOKED);
  if (status === OFFER_STATUS.EXPIRED) return no(OFFER_REVOKE_SKIP.EXPIRED);

  // ── 書き込む内容は既存の単一源に委譲する（ここで組み立てない）──
  const built = buildOfferRevokeFields({ record, nowMs, reason });
  if (built.skipped) return no(built.skipped);
  if (!assertOnlyOfferFields(built.fields)) {
    return no(OFFER_REVOKE_SKIP.FIELD_ALLOW_LIST_VIOLATION);
  }

  return { ok: true, offer, fields: built.fields, fingerprint };
}

/** 一覧表示用（read-only）。取り消しボタンを出してよいのは `canRevoke` が true の行だけ。 */
export function listOffersForRevoke({ records, nowMs, customerRecordId }) {
  const out = [];
  for (const rec of records || []) {
    const offer = describeOfferForRevoke({ record: rec, nowMs });
    if (customerRecordId && offer.customerRecordId !== str(customerRecordId)) continue;
    out.push({ ...offer, canRevoke: offer.status === OFFER_STATUS.ISSUED });
  }
  // 新しい発行から順に（StartsAt 降順 → 同時刻は recordId で安定化）
  out.sort((a, b) => (Date.parse(b.startsAt) || 0) - (Date.parse(a.startsAt) || 0)
    || a.offerRecordId.localeCompare(b.offerRecordId));
  return out;
}
