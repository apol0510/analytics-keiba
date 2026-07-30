/**
 * comebackGrantPlan.js — カムバック特典の付与計画（純粋・I/O なし）
 *
 * 管理画面の「確認 → dry-run → 付与」で使う**対象確定ロジックの単一源**。
 * Function 側はこの結果をそのまま使い、独自に対象を足したり引いたりしてはいけない。
 *
 * ── メール送信とは完全に別 ────────────────────────────────────────
 * このモジュールも Function も**メールを送らない**。特典付与とメール送信を 1 操作に
 * 結合しない（付与成功を根拠に、あとから管理者がキャンペーンを選んで送る）。
 *
 * ── 原子性（Airtable にトランザクションが無い制約）───────────────────
 * 複合オファー（Premium 30日無料 ＋ Light 永久無料）は **2 つの独立 grant** だが、
 * どちらも **同じ Customers レコードの別フィールド**に書く。したがって
 * **1 顧客あたり 1 回の PATCH** で両方が同時に確定する ―― 顧客単位では原子的で、
 * 「片方だけ付いた」状態は構造上起きない。
 *
 * 原子性が保証できないのは **顧客をまたぐ範囲**（10 件ずつの PATCH のうち後半が
 * 落ちる等）。ここは次の 3 点で安全にする:
 *   1. すべての書き込みが同じ operationId を持つ
 *   2. 同じ operationId の再実行は各フィールドで `already_applied` として無視される
 *      → **何度でも安全に再実行できる**（冪等）
 *   3. 失敗時は「適用済み / 未適用」を件数で返し、同じ operationId で dry-run し直せば
 *      残りだけが対象になる（reconcile）
 *
 * ── 減らさない ────────────────────────────────────────────────
 * 計画は権利を**増やす**書き込みしか作らない。有効期限の短縮・プラン変更・
 * 課金フィールドの更新は allowlist（promotionalGrants.js）で構造的に不可能。
 */

import { createHash } from 'node:crypto';
import {
  PROMO_GRANT,
  PROMO_GRANT_LABEL,
  PROMO_WRITABLE_FIELDS,
  PREMIUM_TRIAL_DAYS,
  buildGrantFields,
  buildRevokeFields,
  resolvePromotionalGrants,
  computeTrialUntilMs,
  describeGrantState,
  assertOnlyGrantFields,
  fmtDay,
} from '../entitlements/promotionalGrants.js';
import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import { normalizePlan } from '../auth/planNormalization.js';

/**
 * 管理画面で選べるオファー。**3 つだけ**。
 * 内部では `grants` の独立した grant として扱う（複合オファー専用の状態を作らない）。
 */
export const COMEBACK_OFFERS = Object.freeze([
  {
    offerId: 'light_lifetime',
    name: 'Light 永久無料',
    description: 'Light プランを期限なしで無料開放する。課金は発生せず、有料 Premium とは別枠。',
    grants: [PROMO_GRANT.LIGHT_LIFETIME],
  },
  {
    offerId: 'premium_trial_30d',
    name: `Premium ${PREMIUM_TRIAL_DAYS}日無料`,
    description: `付与時点から ${PREMIUM_TRIAL_DAYS} 日間、Premium を無料開放する。終了後は元の状態へ戻る。`,
    grants: [PROMO_GRANT.PREMIUM_TRIAL_30D],
  },
  {
    offerId: 'comeback_full',
    name: `Premium ${PREMIUM_TRIAL_DAYS}日無料 ＋ Light 永久無料`,
    description: `${PREMIUM_TRIAL_DAYS} 日間 Premium を無料開放し、終了後は Light 永久無料が残る。今回の主要カムバック施策。`,
    grants: [PROMO_GRANT.PREMIUM_TRIAL_30D, PROMO_GRANT.LIGHT_LIFETIME],
  },
]);

export function getOffer(offerId) {
  const id = String(offerId ?? '').trim();
  return COMEBACK_OFFERS.find((o) => o.offerId === id) || null;
}

/** 1 回の操作で扱える最大件数（暴走防止。超えたら計画自体を作らない） */
export const MAX_GRANT_RECORDS = 200;

/** Airtable の 1 リクエストあたりレコード数（batch PATCH の上限） */
export const RECORDS_PER_BATCH = 10;

/** 対象外の理由（すべて dry-run で件数表示する。黙って落とさない） */
export const CB_SKIP = Object.freeze({
  UNKNOWN_CUSTOMER: 'unknown_customer',
  DATA_INCOMPLETE: 'data_incomplete',
  ACCOUNT_SUSPENDED: 'account_suspended',
  WITHDRAWAL_BLOCKED: 'withdrawal_blocked',
  ALREADY_GRANTED: 'already_granted',
  ALREADY_APPLIED: 'already_applied',
  PAID_STRONGER: 'paid_stronger',
  GRANT_INCONSISTENT: 'grant_inconsistent',
  NOT_GRANTED: 'not_granted',
});

export const CB_SKIP_LABEL = Object.freeze({
  unknown_customer: '顧客レコード不明',
  data_incomplete: 'データ不備（メールアドレス未登録/不正）',
  account_suspended: 'アカウント停止・テストアカウント',
  withdrawal_blocked: '退会・強制ログアウトでログイン不可',
  already_granted: '既に付与済み',
  already_applied: 'この操作で適用済み（再実行）',
  paid_stronger: '有料 Premium が優先で変更不要',
  grant_inconsistent: '特典データ不整合（要確認）',
  not_granted: '対象の特典を持っていない',
});

const SUSPENDED_STATUS = new Set(['suspended', 'inactive', 'banned', 'disabled', '停止', '無効']);
const WITHDRAWN_STATUS = new Set(['withdrawn', 'cancelled', 'canceled', 'closed', '退会', '解約']);

function statusOf(fields) {
  const f = fields || {};
  const raw = f.AccountStatus ?? f.Status ?? '';
  return String(raw).trim().toLowerCase();
}

function isTruthyFlag(v) {
  return v === true || v === 1 || (typeof v === 'string' && ['true', '1', 'yes', 'checked', 'on'].includes(v.trim().toLowerCase()));
}

/** 特典を付けても使えない相手か（fail closed）。付けてから気づくのではなく、事前に落とす。 */
export function checkGrantable(fields) {
  const f = fields || {};
  const email = String(f.Email ?? '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, reason: CB_SKIP.DATA_INCOMPLETE };
  }
  const status = statusOf(f);
  const planRaw = String(f['プラン'] ?? f.Plan ?? '').trim().toLowerCase();
  if (SUSPENDED_STATUS.has(status) || status === 'test' || planRaw === 'test') {
    return { ok: false, reason: CB_SKIP.ACCOUNT_SUSPENDED };
  }
  // 退会 / 強制ログアウトはログイン自体が拒否される（memberResolution の拒否ゲート）。
  // 特典を書いても使えないので、**付与せず理由を出す**。退会フラグの解除は課金契約の
  // 判断であり、この機能では**絶対に触らない**（PROMO_FORBIDDEN_FIELDS）。
  if (isTruthyFlag(f.WithdrawalRequested) || isTruthyFlag(f.ForceLogout) || WITHDRAWN_STATUS.has(status)) {
    return { ok: false, reason: CB_SKIP.WITHDRAWAL_BLOCKED };
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
 * 現在の状態を 1 行で説明する（管理画面の「現在」欄）。
 * 判定は既存の正本（resolveEntitlements / resolvePromotionalGrants）だけを使う。
 */
export function describeCustomerState(fields, nowMs) {
  const f = fields || {};
  const ent = resolveEntitlements(fromAirtableFields(f), nowMs);
  const grants = resolvePromotionalGrants(f, nowMs);
  const tier = normalizePlan(String(f['プラン'] ?? f.Plan ?? '').trim()) ?? 'free';
  const expiry = paidExpiryMs(f);

  const paid = [];
  if (ent.paidPremiumActive) paid.push(`有効 Premium${expiry ? `（〜${fmtDay(expiry)}）` : ''}`);
  else if (ent.paidLightActive) paid.push(`有効 Light${expiry ? `（〜${fmtDay(expiry)}）` : ''}`);
  else if (tier !== 'free' && expiry !== null) paid.push(`期限切れ ${tier === 'light' ? 'Light' : 'Premium'}${`（${fmtDay(expiry)}）`}`);
  else if (tier !== 'free') paid.push(`${tier === 'light' ? 'Light' : 'Premium'}（期限不明）`);
  else paid.push('無料会員');

  const promo = describeGrantState(grants);
  return {
    text: promo === '特典なし' ? paid[0] : `${paid[0]} ＋ ${promo}`,
    paid: paid[0],
    promo,
    canViewPremium: ent.canViewPremium,
    canViewLight: ent.canViewLight,
    canViewSanrenpuku: ent.canViewSanrenpuku,
    lifetimeSanrenpuku: ent.lifetimeSanrenpuku,
    paidPremiumActive: ent.paidPremiumActive,
    paidExpiryMs: expiry,
  };
}

/**
 * 1 顧客に対して、オファーのうち実際に書き込む grant を決める。
 *
 * @returns {{
 *   recordId: string, email: string,
 *   applied: Array<{ grantType: string, untilMs: number|null }>,
 *   skippedParts: Array<{ grantType: string, reason: string }>,
 *   fields: object,          このレコードへ PATCH する特典フィールド（1 回で全部）
 *   before: object, after: object,
 *   skipped: string|null,    全パートが対象外ならその理由
 * }}
 */
export function planCustomerGrant({ offer, recordId, fields, nowMs, operationId, actor, source }) {
  const f = fields || {};
  const before = describeCustomerState(f, nowMs);
  const applied = [];
  const skippedParts = [];
  let merged = {};

  const grants = resolvePromotionalGrants(f, nowMs);
  const trialEndMs = computeTrialUntilMs(nowMs);

  for (const grantType of offer.grants) {
    // 有料 Premium が trial 終了日より後まで有効なら、無料期間を足しても意味が無い（no-op）
    if (grantType === PROMO_GRANT.PREMIUM_TRIAL_30D
      && before.paidPremiumActive
      && before.paidExpiryMs !== null
      && before.paidExpiryMs >= trialEndMs) {
      skippedParts.push({ grantType, reason: CB_SKIP.PAID_STRONGER });
      continue;
    }
    // 有効期限が読めない有効 Premium も、短縮しないため触らない（fail closed）
    if (grantType === PROMO_GRANT.PREMIUM_TRIAL_30D
      && before.paidPremiumActive && before.paidExpiryMs === null) {
      skippedParts.push({ grantType, reason: CB_SKIP.PAID_STRONGER });
      continue;
    }

    const built = buildGrantFields({ grantType, fields: f, now: nowMs, operationId, actor, source });
    if (!built) {
      skippedParts.push({ grantType, reason: CB_SKIP.DATA_INCOMPLETE });
      continue;
    }
    if (built.skipped) {
      skippedParts.push({ grantType, reason: built.skipped });
      continue;
    }
    merged = { ...merged, ...built.fields };
    applied.push({ grantType, untilMs: built.effect.untilMs });
  }

  // 特典データが壊れている（値は残っているのに取り消し済み）レコードは自動修復しない
  const inconsistent = grants.lightLifetime.inconsistent || grants.premiumTrial.inconsistent;

  const hasWrite = Object.keys(merged).length > 0;
  const after = hasWrite ? describeCustomerState({ ...f, ...merged }, nowMs) : before;

  let skipped = null;
  if (!hasWrite) {
    // すべてのパートが落ちた理由のうち、最初のものを代表にする
    skipped = skippedParts.length ? skippedParts[0].reason : CB_SKIP.ALREADY_GRANTED;
  }

  return {
    recordId,
    email: String(f.Email ?? '').trim().toLowerCase(),
    applied,
    skippedParts,
    fields: merged,
    before,
    after,
    skipped,
    inconsistent,
  };
}

/**
 * 付与計画を確定する（純粋）。
 *
 * @param {{
 *   offer: object,
 *   selected: Array<{ recordId: string, fields: object|null }>,
 *   nowMs: number, operationId: string, actor?: string, source?: string,
 * }} input
 * @returns {{ ok: boolean, error?: string, targets: object[], skipped: object[],
 *   counts: object, planFingerprint: string }}
 */
export function buildGrantPlan({ offer, selected, nowMs, operationId, actor, source }) {
  const empty = (error) => ({
    ok: false, error, targets: [], skipped: [],
    counts: { selected: 0, willGrant: 0, skipped: 0, byReason: {} },
    planFingerprint: '',
  });
  if (!offer || !Array.isArray(offer.grants) || offer.grants.length === 0) return empty('unknown_offer');
  if (!Array.isArray(selected)) return empty('invalid_selection');
  if (!Number.isFinite(nowMs)) return empty('invalid_now');
  if (!String(operationId || '').trim()) return empty('missing_operation_id');
  if (selected.length === 0) return empty('empty_selection');
  if (selected.length > MAX_GRANT_RECORDS) {
    return empty(`too_many_records:${selected.length}>${MAX_GRANT_RECORDS}`);
  }

  const targets = [];
  const skipped = [];
  const byReason = {};
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

    const grantable = checkGrantable(fields);
    if (!grantable.ok) {
      note(recordId, grantable.reason, { before: describeCustomerState(fields, nowMs) });
      continue;
    }

    const planned = planCustomerGrant({ offer, recordId, fields, nowMs, operationId, actor, source });
    if (planned.inconsistent) {
      // 不整合レコードは自動で上書きしない（管理者が個別に確認する）
      note(recordId, CB_SKIP.GRANT_INCONSISTENT, { before: planned.before });
      continue;
    }
    if (planned.skipped) {
      note(recordId, planned.skipped, { before: planned.before });
      continue;
    }
    if (!assertOnlyGrantFields(planned.fields)) {
      note(recordId, CB_SKIP.DATA_INCOMPLETE);
      continue;
    }
    targets.push(planned);
  }

  return {
    ok: true,
    targets,
    skipped,
    counts: {
      selected: selected.length,
      willGrant: targets.length,
      skipped: skipped.length,
      byReason,
    },
    planFingerprint: computeGrantPlanFingerprint({ offer, operationId, targets }),
  };
}

/**
 * 取り消し計画（promotional grant だけ）。
 * paid entitlement / LifetimeSanrenpuku は allowlist により構造的に触れない。
 */
export function buildRevokePlan({ grantTypes, selected, nowMs, actor, reason }) {
  const empty = (error) => ({
    ok: false, error, targets: [], skipped: [],
    counts: { selected: 0, willRevoke: 0, skipped: 0, byReason: {} },
    planFingerprint: '',
  });
  const types = (Array.isArray(grantTypes) ? grantTypes : []).filter(
    (t) => t === PROMO_GRANT.LIGHT_LIFETIME || t === PROMO_GRANT.PREMIUM_TRIAL_30D,
  );
  if (types.length === 0) return empty('unknown_grant_type');
  if (!Array.isArray(selected) || selected.length === 0) return empty('empty_selection');
  if (!Number.isFinite(nowMs)) return empty('invalid_now');
  if (selected.length > MAX_GRANT_RECORDS) return empty(`too_many_records:${selected.length}>${MAX_GRANT_RECORDS}`);

  const targets = [];
  const skipped = [];
  const byReason = {};
  const seen = new Set();

  for (const item of selected) {
    const recordId = item && item.recordId ? String(item.recordId) : '';
    const fields = item && item.fields;
    if (!recordId || !fields) {
      skipped.push({ recordId, reason: CB_SKIP.UNKNOWN_CUSTOMER });
      byReason[CB_SKIP.UNKNOWN_CUSTOMER] = (byReason[CB_SKIP.UNKNOWN_CUSTOMER] || 0) + 1;
      continue;
    }
    if (seen.has(recordId)) continue;
    seen.add(recordId);

    const before = describeCustomerState(fields, nowMs);
    let merged = {};
    const revoked = [];
    for (const grantType of types) {
      const built = buildRevokeFields({ grantType, fields, now: nowMs, actor, reason });
      if (!built || built.skipped) continue;
      merged = { ...merged, ...built.fields };
      revoked.push(grantType);
    }
    if (Object.keys(merged).length === 0 || !assertOnlyGrantFields(merged)) {
      skipped.push({ recordId, reason: CB_SKIP.NOT_GRANTED, before });
      byReason[CB_SKIP.NOT_GRANTED] = (byReason[CB_SKIP.NOT_GRANTED] || 0) + 1;
      continue;
    }
    targets.push({
      recordId,
      email: String(fields.Email ?? '').trim().toLowerCase(),
      revoked,
      fields: merged,
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
    planFingerprint: computeGrantPlanFingerprint({
      offer: { offerId: `revoke:${types.join('+')}`, grants: types },
      operationId: 'revoke',
      targets,
    }),
  };
}

/**
 * dry-run → 実行の受け渡しトークン。
 * 対象集合・オファー・**書き込む内容そのもの**が 1 つでも変われば値が変わる。
 * 実行はこのトークンが再計算値と一致しないと走らない（TOCTOU 防止）。
 *
 * ⚠️ 一部だけ適用されて失敗した場合、再 dry-run すると適用済みが `already_applied` で
 *    落ちるためトークンは当然変わる。**同じ operationId で dry-run し直して残りを実行する**
 *    のが正しい再開手順（冪等なので二重付与にならない）。
 */
export function computeGrantPlanFingerprint({ offer, operationId, targets }) {
  const rows = (targets || [])
    .map((t) => `${t.recordId}:${(t.applied || t.revoked || []).map((a) => a.grantType || a).sort().join('+')}`)
    .sort();
  const seed = [
    String(offer?.offerId || ''),
    String(operationId || ''),
    String(rows.length),
    ...rows,
  ].join('|');
  return createHash('sha256').update(seed, 'utf8').digest('hex');
}

/** Airtable batch PATCH 用にレコードを分割する */
export function chunkTargets(targets, size = RECORDS_PER_BATCH) {
  const out = [];
  const list = targets || [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * 実行後の突合（reconcile）。Airtable から読み直した fields を渡し、
 * この operationId の書き込みが実際に入っているかを数える。
 *
 * @returns {{ applied: string[], missing: string[], counts: object }}
 */
export function reconcileOperation({ operationId, records, nowMs }) {
  const op = String(operationId || '').trim();
  const applied = [];
  const missing = [];
  for (const rec of records || []) {
    const f = (rec && rec.fields) || {};
    const g = resolvePromotionalGrants(f, nowMs);
    const hit = (op && g.lightLifetime.operationId === op) || (op && g.premiumTrial.operationId === op);
    (hit ? applied : missing).push(rec.recordId || rec.id || '');
  }
  return {
    applied,
    missing,
    counts: { total: applied.length + missing.length, applied: applied.length, missing: missing.length },
  };
}

/** 管理画面の「付与後」表示に使う短い説明（顧客向け文面ではない） */
export function describeOfferEffect(offer, nowMs) {
  if (!offer) return '';
  const until = fmtDay(computeTrialUntilMs(nowMs));
  const parts = offer.grants.map((g) => (
    g === PROMO_GRANT.PREMIUM_TRIAL_30D
      ? `Premium 無料 ${PREMIUM_TRIAL_DAYS} 日（〜${until}）`
      : PROMO_GRANT_LABEL[g]
  ));
  return parts.join(' → その後 ');
}

/** Function 側が PATCH 直前に使う最終チェック（許可フィールド以外を 1 つでも含めば false） */
export function assertPlanWritesOnlyGrantFields(targets) {
  const allow = new Set(PROMO_WRITABLE_FIELDS);
  for (const t of targets || []) {
    const keys = Object.keys(t.fields || {});
    if (keys.length === 0) return false;
    if (!keys.every((k) => allow.has(k))) return false;
  }
  return true;
}
