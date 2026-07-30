/**
 * comebackGrantPlan.js — カムバック施策の実行計画（純粋・I/O なし）
 *
 * 管理画面の「顧客選択 → Light 特典 → Premium 特典 → 価格/期間 → preview → dry-run → 確定」
 * の**対象確定ロジックの単一源**。Function 側はこの結果をそのまま使い、独自に対象を
 * 足したり引いたりしてはいけない。
 *
 * ── 1 回の操作で 2 種類の結果が出る ──────────────────────────────
 *   grant（無料）… Customers の特典フィールドへ書く＝**その場で閲覧権が増える**
 *   offer（割引）… PromotionalOffers へ 1 行積む＝**権利は増えない**。購入条件だけ
 *
 * Light と Premium は独立に選べる。組み合わせ例:
 *   Light 永久無料のみ / Light 永久無料 + Premium 30日無料 /
 *   Light 永久無料 + Premium 年額50%OFF / Premium 買い切り50%OFF のみ …
 *
 * ── 原子性（Airtable にトランザクションが無い制約）───────────────────
 * Light grant と Premium grant は **同じ Customers レコードの別フィールド**なので
 * **1 顧客あたり 1 PATCH** で同時に確定する（顧客単位では原子的）。
 * 割引 offer は別テーブルなので、grant と offer の間は原子的にならない。
 * そこで **grant → offer の順**で実行し、どちらも同じ operationId を持たせる。
 *   - grant だけ入って offer が落ちた → 同じ operationId で再実行すれば offer だけ発行される
 *   - offer は OfferKey で upsert なので重複行にならない
 * つまり「途中で落ちても、同じ operationId でやり直せば必ず収束する」。
 */

import { createHash } from 'node:crypto';
import {
  PROMO_TIER,
  PROMO_TIER_LABEL,
  PROMO_WRITABLE_FIELDS,
  buildGrantFields,
  buildRevokeFields,
  resolvePromotionalGrants,
  describeGrantState,
  assertOnlyGrantFields,
  fmtDay,
} from '../entitlements/promotionalGrants.js';
import {
  OFFER_KIND,
  resolveOffer,
  describeOffer,
} from '../promotions/promotionOfferCatalog.js';
import {
  buildOfferRecord,
  hasActiveOffer,
  findOfferByKey,
  computeOfferKey,
} from '../promotions/promotionalOffer.js';
import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import { normalizePlan } from '../auth/planNormalization.js';

/** 1 回の操作で扱える最大件数（暴走防止。超えたら計画自体を作らない） */
export const MAX_GRANT_RECORDS = 200;

/** Airtable の 1 リクエストあたりレコード数（batch upsert / PATCH の上限） */
export const RECORDS_PER_BATCH = 10;

/** 対象外の理由（すべて dry-run で件数表示する。黙って落とさない） */
export const CB_SKIP = Object.freeze({
  UNKNOWN_CUSTOMER: 'unknown_customer',
  DATA_INCOMPLETE: 'data_incomplete',
  ACCOUNT_SUSPENDED: 'account_suspended',
  /** 退会・強制ログアウト → ログインできないので**無料付与**はしない（割引 offer は可） */
  WITHDRAWAL_BLOCKED: 'withdrawal_blocked',
  ALREADY_GRANTED: 'already_granted',
  ALREADY_APPLIED: 'already_applied',
  PAID_STRONGER: 'paid_stronger',
  ALREADY_OFFERED: 'already_offered',
  GRANT_INCONSISTENT: 'grant_inconsistent',
  NOT_GRANTED: 'not_granted',
  NOTHING_SELECTED: 'nothing_selected',
});

export const CB_SKIP_LABEL = Object.freeze({
  unknown_customer: '顧客レコード不明',
  data_incomplete: 'データ不備（メールアドレス未登録/不正）',
  account_suspended: 'アカウント停止・テストアカウント',
  withdrawal_blocked: '退会・強制ログアウトのため無料付与は不可',
  already_granted: '既に同等以上の特典を保有',
  already_applied: 'この操作で適用済み（再実行）',
  paid_stronger: '有料契約が優先で変更不要',
  already_offered: '有効な割引オファーを発行済み',
  grant_inconsistent: '特典データ不整合（要確認）',
  not_granted: '対象の特典を持っていない',
  nothing_selected: '適用できる内容がない',
});

const SUSPENDED_STATUS = new Set(['suspended', 'inactive', 'banned', 'disabled', '停止', '無効']);
const WITHDRAWN_STATUS = new Set(['withdrawn', 'cancelled', 'canceled', 'closed', '退会', '解約']);

function statusOf(fields) {
  const f = fields || {};
  return String(f.AccountStatus ?? f.Status ?? '').trim().toLowerCase();
}

function isTruthyFlag(v) {
  return v === true || v === 1
    || (typeof v === 'string' && ['true', '1', 'yes', 'checked', 'on'].includes(v.trim().toLowerCase()));
}

function emailOf(fields) {
  return String((fields || {}).Email ?? '').trim().toLowerCase();
}

function hasValidEmail(fields) {
  const e = emailOf(fields);
  return !!e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/**
 * **無料付与**の可否。付けても使えない相手を事前に落とす（fail closed）。
 * 退会・強制ログアウトはログイン自体が拒否されるため付与しない
 * （退会フラグの解除は課金契約側の判断であり、特典付与の副作用にしない）。
 */
export function checkGrantable(fields) {
  const f = fields || {};
  if (!hasValidEmail(f)) return { ok: false, reason: CB_SKIP.DATA_INCOMPLETE };
  const status = statusOf(f);
  const planRaw = String(f['プラン'] ?? f.Plan ?? '').trim().toLowerCase();
  if (SUSPENDED_STATUS.has(status) || status === 'test' || planRaw === 'test') {
    return { ok: false, reason: CB_SKIP.ACCOUNT_SUSPENDED };
  }
  if (isTruthyFlag(f.WithdrawalRequested) || isTruthyFlag(f.ForceLogout) || WITHDRAWN_STATUS.has(status)) {
    return { ok: false, reason: CB_SKIP.WITHDRAWAL_BLOCKED };
  }
  return { ok: true, reason: null };
}

/**
 * **割引オファー**の可否。無料付与より条件がゆるい。
 *
 * 退会者にも発行してよい: 割引 offer は「購入条件」であり、支払い完了時に既存の
 * 入金確認フロー（confirm-bank-payment）が退会フラグをリセットして昇格させる。
 * つまり退会者が戻ってくる正規の導線として成立する。
 * 停止・banned・テストアカウントは AK 側が意図的に止めた相手なので除外を維持する。
 */
export function checkOfferable(fields) {
  const f = fields || {};
  if (!hasValidEmail(f)) return { ok: false, reason: CB_SKIP.DATA_INCOMPLETE };
  const status = statusOf(f);
  const planRaw = String(f['プラン'] ?? f.Plan ?? '').trim().toLowerCase();
  if (SUSPENDED_STATUS.has(status) || status === 'test' || planRaw === 'test') {
    return { ok: false, reason: CB_SKIP.ACCOUNT_SUSPENDED };
  }
  return { ok: true, reason: null };
}

/** 有料契約の有効期限（ms）。読めなければ null。 */
function paidExpiryMs(fields) {
  const f = fields || {};
  const raw = f['有効期限'] ?? f.ValidUntil ?? f.ExpiryDate ?? f.ExpirationDate ?? '';
  if (!raw) return null;
  const t = Date.parse(String(raw));
  return Number.isNaN(t) ? null : t;
}

/**
 * 現在の状態を説明する（管理画面の「現在」欄）。
 * 判定は既存の正本（resolveEntitlements / resolvePromotionalGrants）だけを使う。
 */
export function describeCustomerState(fields, nowMs) {
  const f = fields || {};
  const ent = resolveEntitlements(fromAirtableFields(f), nowMs);
  const grants = resolvePromotionalGrants(f, nowMs);
  const tier = normalizePlan(String(f['プラン'] ?? f.Plan ?? '').trim()) ?? 'free';
  const expiry = paidExpiryMs(f);
  const planType = String(f.PlanType ?? '').trim().toLowerCase();

  let paid;
  if (ent.paidPremiumActive) {
    paid = planType === 'lifetime'
      ? '有効 Premium（買い切り）'
      : `有効 Premium${expiry ? `（〜${fmtDay(expiry)}）` : ''}`;
  } else if (ent.paidLightActive) {
    paid = `有効 Light${expiry ? `（〜${fmtDay(expiry)}）` : ''}`;
  } else if (tier !== 'free' && expiry !== null) {
    paid = `期限切れ ${tier === 'light' ? 'Light' : 'Premium'}（${fmtDay(expiry)}）`;
  } else if (tier !== 'free') {
    paid = `${tier === 'light' ? 'Light' : 'Premium'}（期限不明）`;
  } else {
    paid = '無料会員';
  }

  const promo = describeGrantState(grants);
  return {
    text: promo === '特典なし' ? paid : `${paid} ＋ ${promo}`,
    paid,
    promo,
    effectiveTier: ent.effectiveTier,
    canViewPremium: ent.canViewPremium,
    canViewLight: ent.canViewLight,
    canViewSanrenpuku: ent.canViewSanrenpuku,
    lifetimeSanrenpuku: ent.lifetimeSanrenpuku,
    paidPremiumActive: ent.paidPremiumActive,
    paidExpiryMs: expiry,
    paidLifetime: planType === 'lifetime',
  };
}

/**
 * 1 顧客に対して、選んだ Light / Premium 特典から実際に書く内容を決める。
 *
 * @returns {{
 *   recordId, email,
 *   grantFields: object,            Customers へ 1 回で PATCH する特典フィールド
 *   grantParts: Array<{tier, lifetime, untilMs, upgrade}>,
 *   offer: object|null,             発行する割引 offer（resolveOffer の .offer）
 *   partSkips: Array<{part, reason}>,
 *   before, after, skipped: string|null,
 * }}
 */
export function planCustomer({ recordId, fields, grantOffers, purchaseOffer, nowMs, operationId, actor, source, existingOffers }) {
  const f = fields || {};
  const before = describeCustomerState(f, nowMs);
  const grantParts = [];
  const partSkips = [];
  let grantFields = {};

  const grantable = checkGrantable(f);
  const offerable = checkOfferable(f);

  // ── 無料付与（Light / Premium それぞれ独立に判定）──
  for (const offer of grantOffers || []) {
    if (!grantable.ok) { partSkips.push({ part: offer.targetTier, reason: grantable.reason }); continue; }

    // 有料契約の方が強いなら書かない（権利を縮めない・意味の無い付与をしない）
    if (offer.targetTier === PROMO_TIER.PREMIUM && before.paidPremiumActive) {
      const grantEndMs = offer.isLifetime ? Infinity : nowMs + offer.duration * 86400000;
      const paidEndMs = before.paidLifetime ? Infinity : (before.paidExpiryMs ?? Infinity);
      if (paidEndMs >= grantEndMs) {
        partSkips.push({ part: offer.targetTier, reason: CB_SKIP.PAID_STRONGER });
        continue;
      }
    }

    const built = buildGrantFields({
      tier: offer.targetTier,
      lifetime: offer.isLifetime,
      durationDays: offer.duration,
      fields: f, now: nowMs, operationId, actor, source,
    });
    if (!built) { partSkips.push({ part: offer.targetTier, reason: CB_SKIP.DATA_INCOMPLETE }); continue; }
    if (built.skipped) { partSkips.push({ part: offer.targetTier, reason: built.skipped }); continue; }
    grantFields = { ...grantFields, ...built.fields };
    grantParts.push({ ...built.effect, offerId: offer.offerId, label: describeOffer(offer) });
  }

  // ── 割引オファー（権利は増えない）──
  let offerToIssue = null;
  if (purchaseOffer) {
    if (!offerable.ok) {
      partSkips.push({ part: 'offer', reason: offerable.reason });
    } else {
      const offerKey = computeOfferKey({
        operationId, offerId: purchaseOffer.offerId, version: purchaseOffer.version, customerRecordId: recordId,
      });
      if (findOfferByKey({ records: existingOffers, offerKey })) {
        partSkips.push({ part: 'offer', reason: CB_SKIP.ALREADY_APPLIED });
      } else if (hasActiveOffer({
        records: existingOffers, offerId: purchaseOffer.offerId, customerRecordId: recordId, nowMs,
      })) {
        partSkips.push({ part: 'offer', reason: CB_SKIP.ALREADY_OFFERED });
      } else {
        offerToIssue = purchaseOffer;
      }
    }
  }

  const grants = resolvePromotionalGrants(f, nowMs);
  const hasGrantWrite = Object.keys(grantFields).length > 0;
  const after = hasGrantWrite ? describeCustomerState({ ...f, ...grantFields }, nowMs) : before;

  let skipped = null;
  if (!hasGrantWrite && !offerToIssue) {
    skipped = partSkips.length ? partSkips[0].reason : CB_SKIP.NOTHING_SELECTED;
  }

  return {
    recordId,
    email: emailOf(f),
    grantFields,
    grantParts,
    offer: offerToIssue,
    partSkips,
    before,
    after,
    skipped,
    inconsistent: grants.inconsistent,
  };
}

/**
 * 実行計画を確定する（純粋）。
 *
 * @param {{
 *   grantOffers: object[],      無料付与する offer（resolveOffer の .offer。0〜2 件）
 *   purchaseOffer: object|null, 発行する割引 offer（0〜1 件）
 *   selected: Array<{ recordId: string, fields: object|null }>,
 *   existingOffers?: object[],  PromotionalOffers の既存行（重複発行の抑止）
 *   nowMs: number, operationId: string, actor?: string, source?: string,
 * }} input
 */
export function buildComebackPlan({
  grantOffers, purchaseOffer, selected, existingOffers, nowMs, operationId, actor, source,
}) {
  const empty = (error) => ({
    ok: false, error, targets: [], skipped: [],
    counts: { selected: 0, willGrant: 0, willOffer: 0, skipped: 0, byReason: {}, parts: {} },
    planFingerprint: '',
  });

  const grants = (grantOffers || []).filter((o) => o && o.kind === OFFER_KIND.GRANT);
  const purchase = purchaseOffer && purchaseOffer.kind === OFFER_KIND.PURCHASE ? purchaseOffer : null;
  if (grants.length === 0 && !purchase) return empty('nothing_selected');
  // 同じティアの無料付与を 2 つ選べない（どちらが勝つか曖昧になる）
  if (grants.length === 2 && grants[0].targetTier === grants[1].targetTier) return empty('duplicate_tier');
  if (!Array.isArray(selected)) return empty('invalid_selection');
  if (!Number.isFinite(nowMs)) return empty('invalid_now');
  if (!String(operationId || '').trim()) return empty('missing_operation_id');
  if (selected.length === 0) return empty('empty_selection');
  if (selected.length > MAX_GRANT_RECORDS) return empty(`too_many_records:${selected.length}>${MAX_GRANT_RECORDS}`);

  const targets = [];
  const skipped = [];
  const byReason = {};
  const parts = {
    lightGrant: 0, premiumGrant: 0, purchaseOffer: 0,
    partSkips: {},
  };
  const seen = new Set();
  const note = (recordId, reason, detail) => {
    skipped.push({ recordId, reason, ...(detail || {}) });
    byReason[reason] = (byReason[reason] || 0) + 1;
  };

  for (const item of selected) {
    const recordId = item && item.recordId ? String(item.recordId) : '';
    const fields = item && item.fields;
    if (!recordId || !fields) { note(recordId, CB_SKIP.UNKNOWN_CUSTOMER); continue; }
    if (seen.has(recordId)) continue; // 同一レコードの重複選択は 1 回にまとめる
    seen.add(recordId);

    const planned = planCustomer({
      recordId, fields, grantOffers: grants, purchaseOffer: purchase,
      nowMs, operationId, actor, source, existingOffers,
    });

    // 特典データが壊れているレコードは自動で上書きしない（管理者が個別に確認する）
    if (planned.inconsistent) { note(recordId, CB_SKIP.GRANT_INCONSISTENT, { before: planned.before }); continue; }
    if (planned.skipped) { note(recordId, planned.skipped, { before: planned.before }); continue; }
    if (Object.keys(planned.grantFields).length > 0 && !assertOnlyGrantFields(planned.grantFields)) {
      note(recordId, CB_SKIP.DATA_INCOMPLETE);
      continue;
    }

    for (const p of planned.grantParts) {
      if (p.tier === PROMO_TIER.LIGHT) parts.lightGrant += 1;
      if (p.tier === PROMO_TIER.PREMIUM) parts.premiumGrant += 1;
    }
    if (planned.offer) parts.purchaseOffer += 1;
    for (const s of planned.partSkips) {
      const key = `${s.part}:${s.reason}`;
      parts.partSkips[key] = (parts.partSkips[key] || 0) + 1;
    }
    targets.push(planned);
  }

  const willGrant = targets.filter((t) => Object.keys(t.grantFields).length > 0).length;
  const willOffer = targets.filter((t) => t.offer).length;

  return {
    ok: true,
    targets,
    skipped,
    counts: {
      selected: selected.length,
      willGrant,
      willOffer,
      skipped: skipped.length,
      byReason,
      parts,
    },
    planFingerprint: computePlanFingerprint({ grantOffers: grants, purchaseOffer: purchase, operationId, targets }),
  };
}

/**
 * 取り消し計画（promotional grant だけ）。
 * paid contract / LifetimeSanrenpuku は allowlist により構造的に触れない。
 */
export function buildRevokePlan({ tiers, selected, nowMs, actor, reason }) {
  const empty = (error) => ({
    ok: false, error, targets: [], skipped: [],
    counts: { selected: 0, willRevoke: 0, skipped: 0, byReason: {} },
    planFingerprint: '',
  });
  const list = (Array.isArray(tiers) ? tiers : []).filter(
    (t) => t === PROMO_TIER.LIGHT || t === PROMO_TIER.PREMIUM,
  );
  if (list.length === 0) return empty('unknown_tier');
  if (!Array.isArray(selected) || selected.length === 0) return empty('empty_selection');
  if (!Number.isFinite(nowMs)) return empty('invalid_now');
  if (selected.length > MAX_GRANT_RECORDS) return empty(`too_many_records:${selected.length}>${MAX_GRANT_RECORDS}`);

  const targets = [];
  const skipped = [];
  const byReason = {};
  const seen = new Set();
  const note = (recordId, r, detail) => {
    skipped.push({ recordId, reason: r, ...(detail || {}) });
    byReason[r] = (byReason[r] || 0) + 1;
  };

  for (const item of selected) {
    const recordId = item && item.recordId ? String(item.recordId) : '';
    const fields = item && item.fields;
    if (!recordId || !fields) { note(recordId, CB_SKIP.UNKNOWN_CUSTOMER); continue; }
    if (seen.has(recordId)) continue;
    seen.add(recordId);

    const before = describeCustomerState(fields, nowMs);
    let merged = {};
    const revoked = [];
    for (const tier of list) {
      const built = buildRevokeFields({ tier, fields, now: nowMs, actor, reason });
      if (!built || built.skipped) continue;
      merged = { ...merged, ...built.fields };
      revoked.push(tier);
    }
    if (Object.keys(merged).length === 0 || !assertOnlyGrantFields(merged)) {
      note(recordId, CB_SKIP.NOT_GRANTED, { before });
      continue;
    }
    targets.push({
      recordId,
      email: emailOf(fields),
      revoked,
      grantFields: merged,
      before,
      after: describeCustomerState({ ...fields, ...merged }, nowMs),
    });
  }

  return {
    ok: true,
    targets,
    skipped,
    counts: {
      selected: selected.length,
      willRevoke: targets.length,
      skipped: skipped.length,
      byReason,
    },
    planFingerprint: computePlanFingerprint({
      grantOffers: list.map((t) => ({ offerId: `revoke-${t}`, targetTier: t })),
      purchaseOffer: null, operationId: 'revoke', targets,
    }),
  };
}

/**
 * dry-run → 実行の受け渡しトークン。
 * 対象集合・選んだ特典・**書き込む内容そのもの**が 1 つでも変われば値が変わる。
 * 実行はこのトークンが再計算値と一致しないと走らない（TOCTOU 防止）。
 *
 * ⚠️ 一部だけ適用されて失敗した場合、再 dry-run するとトークンは当然変わる。
 *    **同じ operationId で dry-run し直して残りを実行する**のが正しい再開手順
 *    （冪等なので二重付与・二重発行にならない）。
 */
export function computePlanFingerprint({ grantOffers, purchaseOffer, operationId, targets }) {
  const rows = (targets || []).map((t) => {
    const g = (t.grantParts || t.revoked || []).map((x) => x.tier || x).sort().join('+');
    return `${t.recordId}:${g}:${t.offer ? t.offer.offerId : '-'}`;
  }).sort();
  const seed = [
    (grantOffers || []).map((o) => `${o.offerId}@${o.duration ?? (o.isLifetime ? 'inf' : '')}`).sort().join(','),
    purchaseOffer ? `${purchaseOffer.offerId}@${purchaseOffer.offerPrice}` : '-',
    String(operationId || ''),
    String(rows.length),
    ...rows,
  ].join('|');
  return createHash('sha256').update(seed, 'utf8').digest('hex');
}

/** Airtable batch 用にレコードを分割する */
export function chunkTargets(targets, size = RECORDS_PER_BATCH) {
  const out = [];
  const list = targets || [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * 実行後の突合（reconcile）。Airtable から読み直した fields / offer 行を渡し、
 * この operationId の書き込みが実際に入っているかを数える。
 */
export function reconcileOperation({ operationId, records, offerRecords, nowMs }) {
  const op = String(operationId || '').trim();
  const applied = [];
  const missing = [];
  for (const rec of records || []) {
    const f = (rec && rec.fields) || {};
    const g = resolvePromotionalGrants(f, nowMs);
    const hit = !!op && (g.light.operationId === op || g.premium.operationId === op);
    (hit ? applied : missing).push(rec.recordId || rec.id || '');
  }
  const offersIssued = (offerRecords || []).filter(
    (r) => String(r?.fields?.OperationId || '') === op,
  ).length;
  return {
    applied,
    missing,
    counts: {
      total: applied.length + missing.length,
      applied: applied.length,
      missing: missing.length,
      offersIssued,
    },
  };
}

/** PATCH 直前の最終チェック（特典フィールド以外を 1 つでも含めば false） */
export function assertPlanWritesOnlyGrantFields(targets) {
  const allow = new Set(PROMO_WRITABLE_FIELDS);
  for (const t of targets || []) {
    const keys = Object.keys(t.grantFields || {});
    if (keys.length === 0) continue; // offer だけの対象は grant を書かない
    if (!keys.every((k) => allow.has(k))) return false;
  }
  return true;
}

/** offer 行を組み立てる（Function から呼ぶ薄いラッパー） */
export function buildOfferRecordsForPlan({ targets, nowMs, operationId, source, ttlDays, secret }) {
  const out = [];
  for (const t of targets || []) {
    if (!t.offer) continue;
    const built = buildOfferRecord({
      offer: t.offer,
      customer: { recordId: t.recordId, email: t.email },
      nowMs, operationId, source, ttlDays, secret,
    });
    if (built.error) continue; // 組み立てられないものは発行しない（fail closed）
    out.push({ recordId: t.recordId, ...built });
  }
  return out;
}

/** 選択内容の要約（管理画面の見出し用） */
export function describeSelection({ grantOffers, purchaseOffer }) {
  const parts = (grantOffers || []).map((o) => describeOffer(o));
  if (purchaseOffer) parts.push(describeOffer(purchaseOffer));
  return parts.join(' ＋ ') || '（未選択）';
}

export { PROMO_TIER, PROMO_TIER_LABEL, resolveOffer, describeOffer };
