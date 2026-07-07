/**
 * memberResolution.js — Airtable Customers レコードから会員権限を解決する純粋関数
 *
 * PR-B スコープ: サーバー専用の会員判定を **1 箇所に集約**する。
 *   - ランタイム非依存・依存注入可能（Airtable / env / 時計に触れない）。
 *   - 呼び出し側（Netlify Functions）が Airtable から取得した `record.fields` と
 *     `record.id`、`now`（ms epoch）を渡す。この関数は I/O を一切行わない。
 *   - クライアントから送られた plan は **使わない**（引数に取らない）。
 *
 * 判定原則（fail closed）:
 *   - 明確な Free だけ `free`
 *   - 有効な有料会員だけ `paid`
 *   - 退会申請 / 強制ログアウト / 利用停止 / 期限切れ有料 / plan 欠落 / 未知 plan /
 *     複数解釈 / SessionVersion 異常 は `denied`
 *   - 期限切れ有料会員を Free として即時ログインさせない（`denied`）
 *   - SessionVersion 欠落・空は `0`。負数 / 非整数 / 異常型は `denied`
 */

import {
  normalizePlan,
  isPaidPlan,
  normalizeVenueAccess,
  CANONICAL_VENUES,
} from './planNormalization.js';

export const MEMBER_TYPE = Object.freeze({
  FREE: 'free',
  PAID: 'paid',
  DENIED: 'denied',
});

/** 判定理由コード（構造化。人間可読メッセージ・機密は含めない）。 */
export const MEMBER_REASON = Object.freeze({
  CLEAR_FREE: 'clear_free',
  PENDING_PAYMENT_FREE: 'pending_payment_free',
  ACTIVE_PAID: 'active_paid',
  LIFETIME_SANRENPUKU: 'lifetime_sanrenpuku',
  FORCE_LOGOUT: 'force_logout',
  WITHDRAWAL_REQUESTED: 'withdrawal_requested',
  STATUS_SUSPENDED: 'status_suspended',
  INVALID_SESSION_VERSION: 'invalid_session_version',
  MISSING_PLAN: 'missing_plan',
  UNKNOWN_PLAN: 'unknown_plan',
  PLAN_CONFLICT: 'plan_conflict',
  EXPIRED: 'expired',
  UNKNOWN_VENUE: 'unknown_venue',
  INVALID_NOW: 'invalid_now',
});

// Airtable 上の停止系ステータス（大小・和英を吸収）。
const SUSPENDED_STATUS = new Set([
  'suspended', 'inactive', 'banned', 'disabled', 'cancelled', 'canceled',
  '停止', '無効', '解約', '退会',
]);
// 入金待ち（有料プラン名が入っていても有料扱いしない）。
const PENDING_STATUS = new Set(['pending', '入金待ち', '未入金']);

function readRaw(fields, names) {
  for (const n of names) {
    const v = fields[n];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

// Airtable のチェックボックス/数値フラグ（true / 1 のみ真）。
function isTruthyFlag(v) {
  return v === true || v === 1;
}

/**
 * SessionVersion を整数へ解決する。
 * 欠落・null・空文字は 0。負数 / 非整数 / 異常型は不正。
 * @returns {{ ok: true, value: number } | { ok: false }}
 */
export function resolveSessionVersion(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: 0 };
  if (typeof raw === 'number') {
    if (Number.isInteger(raw) && raw >= 0) return { ok: true, value: raw };
    return { ok: false };
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    return { ok: true, value: parseInt(raw.trim(), 10) };
  }
  return { ok: false };
}

// 期限切れ判定。パース不能な値は「期限なし」とみなす（誤って有効会員を弾かない）。
function isExpiredDate(raw, now) {
  if (raw === undefined || raw === null || raw === '') return false;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return false;
  return t < now;
}

// VenueAccess を正規配列へ。未指定は両会場（jra+nankan）。未知値は ok:false。
function resolveVenues(fields) {
  const raw = readRaw(fields, ['VenueAccess']);
  if (raw === undefined) return { ok: true, venues: [...CANONICAL_VENUES] };
  const norm = normalizeVenueAccess(raw);
  if (norm === null) return { ok: false };
  return { ok: true, venues: norm };
}

function deny(reason, recordId, sessionVersion = 0, lifetimeSanrenpuku = false) {
  return {
    memberType: MEMBER_TYPE.DENIED,
    normalizedPlan: null,
    venueAccess: [],
    sessionVersion,
    recordId: recordId ?? null,
    reason,
    lifetimeSanrenpuku,
  };
}

function freeResult(recordId, sessionVersion, reason = MEMBER_REASON.CLEAR_FREE) {
  return {
    memberType: MEMBER_TYPE.FREE,
    normalizedPlan: 'free',
    venueAccess: [],
    sessionVersion,
    recordId: recordId ?? null,
    reason,
    lifetimeSanrenpuku: false,
  };
}

function paidResult(plan, venues, recordId, sessionVersion, lifetimeSanrenpuku, reason) {
  return {
    memberType: MEMBER_TYPE.PAID,
    normalizedPlan: plan,
    venueAccess: venues,
    sessionVersion,
    recordId: recordId ?? null,
    reason,
    lifetimeSanrenpuku,
  };
}

/**
 * 会員権限を解決する。I/O なし・純粋。
 *
 * @param {{ fields?: Record<string, unknown>, recordId?: string|null, now: number }} input
 * @returns {{
 *   memberType: 'free'|'paid'|'denied',
 *   normalizedPlan: string|null,
 *   venueAccess: string[],
 *   sessionVersion: number,
 *   recordId: string|null,
 *   reason: string,
 *   lifetimeSanrenpuku: boolean,
 * }}
 */
export function resolveMembership(input = {}) {
  const { fields = {}, recordId = null, now } = input;
  if (typeof now !== 'number' || !Number.isFinite(now)) {
    return deny(MEMBER_REASON.INVALID_NOW, recordId);
  }
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    return deny(MEMBER_REASON.MISSING_PLAN, recordId);
  }

  const sv = resolveSessionVersion(readRaw(fields, ['SessionVersion']));

  // --- 拒否ゲート（lifetime よりも優先。ここを通らないと有料化しない） ---
  if (isTruthyFlag(readRaw(fields, ['ForceLogout']))) {
    return deny(MEMBER_REASON.FORCE_LOGOUT, recordId, sv.ok ? sv.value : 0);
  }
  if (isTruthyFlag(readRaw(fields, ['WithdrawalRequested']))) {
    return deny(MEMBER_REASON.WITHDRAWAL_REQUESTED, recordId, sv.ok ? sv.value : 0);
  }
  const statusRaw = readRaw(fields, ['Status']);
  const status = statusRaw == null ? '' : String(statusRaw).trim().toLowerCase();
  if (SUSPENDED_STATUS.has(status)) {
    return deny(MEMBER_REASON.STATUS_SUSPENDED, recordId, sv.ok ? sv.value : 0);
  }
  if (!sv.ok) {
    return deny(MEMBER_REASON.INVALID_SESSION_VERSION, recordId);
  }
  const sessionVersion = sv.value;

  const lifetime = isTruthyFlag(readRaw(fields, ['LifetimeSanrenpuku', '三連複Lifetime']));

  // --- plan（ティア）の解決（クライアント値は使わない） ---
  // ティアの正本は `プラン`（日本語）。`Plan`（英語）は読み取り互換の別名。
  // ※ `PlanType` は課金サイクル（Monthly/annual/lifetime）でありティアではないため
  //    ここでは **絶対に参照しない**（verify-magic-link 旧実装の混同を持ち込まない）。
  const jaRaw = fields['プラン'];
  const enRaw = fields['Plan'];
  const jaPlan = jaRaw !== undefined && jaRaw !== null && jaRaw !== '' ? normalizePlan(jaRaw) : undefined;
  const enPlan = enRaw !== undefined && enRaw !== null && enRaw !== '' ? normalizePlan(enRaw) : undefined;

  // `プラン` と `Plan` が有料/無料で食い違う → 複数解釈として拒否（fail closed）
  if (jaPlan != null && enPlan != null && isPaidPlan(jaPlan) !== isPaidPlan(enPlan)) {
    return deny(MEMBER_REASON.PLAN_CONFLICT, recordId, sessionVersion, lifetime);
  }

  // 実効プラン: `プラン` を優先し、無ければ `Plan`
  const plan = jaPlan !== undefined ? jaPlan : enPlan;

  if (plan === undefined) {
    // plan フィールド自体が無い
    if (lifetime) {
      const v = resolveVenues(fields);
      if (!v.ok) return deny(MEMBER_REASON.UNKNOWN_VENUE, recordId, sessionVersion, lifetime);
      return paidResult('premium-sanrenpuku', v.venues, recordId, sessionVersion, true, MEMBER_REASON.LIFETIME_SANRENPUKU);
    }
    return deny(MEMBER_REASON.MISSING_PLAN, recordId, sessionVersion, lifetime);
  }
  if (plan === null) {
    // 値はあるが未知
    return deny(MEMBER_REASON.UNKNOWN_PLAN, recordId, sessionVersion, lifetime);
  }

  const isPending = PENDING_STATUS.has(status);

  // 無料プラン
  if (!isPaidPlan(plan)) {
    if (lifetime) {
      const v = resolveVenues(fields);
      if (!v.ok) return deny(MEMBER_REASON.UNKNOWN_VENUE, recordId, sessionVersion, lifetime);
      return paidResult('premium-sanrenpuku', v.venues, recordId, sessionVersion, true, MEMBER_REASON.LIFETIME_SANRENPUKU);
    }
    return freeResult(recordId, sessionVersion);
  }

  // 有料プラン候補
  if (isPending) {
    // 入金待ち → 有料化しない（Free 扱い。lifetime のみ例外）
    if (lifetime) {
      const v = resolveVenues(fields);
      if (!v.ok) return deny(MEMBER_REASON.UNKNOWN_VENUE, recordId, sessionVersion, lifetime);
      return paidResult('premium-sanrenpuku', v.venues, recordId, sessionVersion, true, MEMBER_REASON.LIFETIME_SANRENPUKU);
    }
    return freeResult(recordId, sessionVersion, MEMBER_REASON.PENDING_PAYMENT_FREE);
  }

  const expiryRaw = readRaw(fields, ['有効期限', 'ValidUntil', 'ExpiryDate', 'ExpirationDate']);
  if (isExpiredDate(expiryRaw, now)) {
    // 期限切れ有料 → Free に落とさず denied（lifetime のみ sanrenpuku を維持）
    if (lifetime) {
      const v = resolveVenues(fields);
      if (!v.ok) return deny(MEMBER_REASON.UNKNOWN_VENUE, recordId, sessionVersion, lifetime);
      return paidResult('premium-sanrenpuku', v.venues, recordId, sessionVersion, true, MEMBER_REASON.LIFETIME_SANRENPUKU);
    }
    return deny(MEMBER_REASON.EXPIRED, recordId, sessionVersion, lifetime);
  }

  // 有効な有料会員
  const v = resolveVenues(fields);
  if (!v.ok) return deny(MEMBER_REASON.UNKNOWN_VENUE, recordId, sessionVersion, lifetime);
  return paidResult(plan, v.venues, recordId, sessionVersion, lifetime, MEMBER_REASON.ACTIVE_PAID);
}
