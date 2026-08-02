/**
 * comebackAudience.js — カムバック特典の**対象区分**（純粋・I/O なし）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 「カムバック」は**戻ってきてほしい人**への施策で、いま払って使っている会員に配るものではない。
 * ところが管理画面は契約状態を横断して選べるため、**現有効会員を選んだまま特典を配れて**しまう。
 * 一度配った権利は取り消すと不信を招くので、**既定で除外**し、混ざっていたら実行を止める。
 *
 * ── 区分 ────────────────────────────────────────────────
 *   expired        期限切れ（元有料）
 *   withdrawn      退会申請・退会済み
 *   dormant        休眠（契約なし / 無料のまま長期未ログイン）
 *   active_member  **現在有効な会員**（既定の対象外）
 *   unknown        判定できない（既定の対象外）
 *
 * ── 既定の除外 ────────────────────────────────────────────
 * active_member / unknown に加え、配信停止・blacklist・重複 Email・
 * 既に同じ特典を持っている人は対象にしない（**弱い付与で権利を縮めない**）。
 */

/** 対象区分 */
export const SEGMENT = Object.freeze({
  EXPIRED: 'expired',
  WITHDRAWN: 'withdrawn',
  DORMANT: 'dormant',
  ACTIVE_MEMBER: 'active_member',
  UNKNOWN: 'unknown',
});

/** 画面に出す区分名 */
export const SEGMENT_LABEL = Object.freeze({
  [SEGMENT.EXPIRED]: '期限切れ',
  [SEGMENT.WITHDRAWN]: '退会',
  [SEGMENT.DORMANT]: '休眠',
  [SEGMENT.ACTIVE_MEMBER]: '現有効会員',
  [SEGMENT.UNKNOWN]: '状態不明',
});

/** 既定で対象にする区分（カムバックの本来の宛先） */
export const DEFAULT_TARGET_SEGMENTS = Object.freeze([SEGMENT.EXPIRED, SEGMENT.WITHDRAWN, SEGMENT.DORMANT]);

/** 対象外の理由（固定コード） */
export const EXCLUDE = Object.freeze({
  ACTIVE_MEMBER: 'active_member',
  UNKNOWN_STATE: 'unknown_state',
  ALREADY_GRANTED: 'already_granted',
  ALREADY_OFFERED: 'already_offered',
  UNSUBSCRIBED: 'unsubscribed',
  BLACKLISTED: 'blacklisted',
  DUPLICATE_EMAIL: 'duplicate_email',
});

export const EXCLUDE_LABEL = Object.freeze({
  [EXCLUDE.ACTIVE_MEMBER]: '現在有効な会員（カムバック対象外）',
  [EXCLUDE.UNKNOWN_STATE]: '状態を判定できない',
  [EXCLUDE.ALREADY_GRANTED]: '同じ特典を既に保有',
  [EXCLUDE.ALREADY_OFFERED]: '有効な割引オファーを既に保有',
  [EXCLUDE.UNSUBSCRIBED]: '配信停止',
  [EXCLUDE.BLACKLISTED]: '配信不可（blacklist）',
  [EXCLUDE.DUPLICATE_EMAIL]: '同一アドレスの重複レコード',
});

const str = (v) => String(v ?? '').trim();
const lower = (v) => str(v).toLowerCase();
const PAID_PLANS = new Set(['light', 'premium', 'premium sanrenpuku', 'premium combo', 'premium plus']);

/** 有効期限（`有効期限` / `ExpirationDate`）を ms で返す。読めなければ null */
export function resolveExpiryMs(fields = {}) {
  const raw = str(fields['有効期限']) || str(fields.ExpirationDate);
  if (!raw) return null;
  const t = Date.parse(raw.length <= 10 ? `${raw}T23:59:59+09:00` : raw);
  return Number.isFinite(t) ? t : null;
}

/**
 * 1 顧客の区分を決める。**推測しない**（判定できなければ unknown）。
 *
 * @param {{fields: object, nowMs: number, dormantDays?: number}} input
 */
export function classifyComebackSegment({ fields, nowMs, dormantDays = 180 } = {}) {
  const f = fields && typeof fields === 'object' ? fields : null;
  if (!f) return SEGMENT.UNKNOWN;

  // 退会は契約状態より優先（本人の意思表示）
  if (f.WithdrawalRequested === true || lower(f.Status) === 'withdrawn') return SEGMENT.WITHDRAWN;

  const status = lower(f.Status);
  const plan = lower(f['プラン'] || f.Plan);
  const expiry = resolveExpiryMs(f);
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();

  // 有効な有料会員（= 現有効会員）。ここが既定の除外対象
  if (status === 'active' && PAID_PLANS.has(plan)) {
    if (lower(f.PlanType) === 'lifetime') return SEGMENT.ACTIVE_MEMBER;
    if (expiry !== null && expiry >= now) return SEGMENT.ACTIVE_MEMBER;
    if (expiry === null) return SEGMENT.UNKNOWN;  // active なのに期限が読めない＝判定不能
    return SEGMENT.EXPIRED;                        // active のまま期限切れ
  }

  // 元有料で期限が過ぎている
  if (PAID_PLANS.has(plan) && expiry !== null && expiry < now) return SEGMENT.EXPIRED;
  if (status === 'expired') return SEGMENT.EXPIRED;

  // 無料・契約なしは休眠かどうかで見る
  const isFree = plan === 'free' || plan === '' || status === 'none' || status === '';
  if (isFree) {
    const last = Date.parse(str(f['最終ログイン']) || str(f.LastLoginAt) || '');
    if (!Number.isFinite(last)) return SEGMENT.DORMANT;             // ログイン記録が無い＝休眠扱い
    return (now - last) >= dormantDays * 86400000 ? SEGMENT.DORMANT : SEGMENT.UNKNOWN;
  }
  return SEGMENT.UNKNOWN;
}

/**
 * 対象にできるか。**現有効会員は明示許可がない限り対象外**。
 *
 * @param {{fields, nowMs, includeActiveMembers?, alreadyGranted?, alreadyOffered?,
 *          unsubscribed?, blacklisted?, duplicateEmail?}} input
 */
export function evaluateComebackTarget(input = {}) {
  const segment = classifyComebackSegment(input);
  const out = (eligible, reason) => ({ segment, eligible, reason: reason || null });

  if (input.duplicateEmail === true) return out(false, EXCLUDE.DUPLICATE_EMAIL);
  if (input.blacklisted === true) return out(false, EXCLUDE.BLACKLISTED);
  if (input.unsubscribed === true) return out(false, EXCLUDE.UNSUBSCRIBED);
  if (input.alreadyGranted === true) return out(false, EXCLUDE.ALREADY_GRANTED);
  if (input.alreadyOffered === true) return out(false, EXCLUDE.ALREADY_OFFERED);
  if (segment === SEGMENT.UNKNOWN) return out(false, EXCLUDE.UNKNOWN_STATE);
  if (segment === SEGMENT.ACTIVE_MEMBER) {
    // 明示的に許可されたときだけ対象にできる（既定は不可）
    return input.includeActiveMembers === true ? out(true, null) : out(false, EXCLUDE.ACTIVE_MEMBER);
  }
  return out(true, null);
}

/** 対象一覧の要約（区分別・除外理由別・現有効会員の混入数） */
export function summarizeComebackAudience(evaluations = []) {
  const bySegment = {};
  const byReason = {};
  let eligible = 0;
  let activeMembers = 0;
  for (const e of evaluations || []) {
    if (!e) continue;
    bySegment[e.segment] = (bySegment[e.segment] || 0) + 1;
    if (e.segment === SEGMENT.ACTIVE_MEMBER) activeMembers += 1;
    if (e.eligible) eligible += 1;
    else if (e.reason) byReason[e.reason] = (byReason[e.reason] || 0) + 1;
  }
  return {
    total: (evaluations || []).length,
    eligible,
    excluded: (evaluations || []).length - eligible,
    activeMembers,
    bySegment,
    byReason,
  };
}

/**
 * 実行してよいか。**現有効会員が 1 名でも混ざっていれば既定で不可**。
 * 明示許可 + 人数の入力一致があるときだけ通す。
 */
export function canApplyComebackGrant({ summary, includeActiveMembers = false, typedActiveCount = null } = {}) {
  const s = summary || { eligible: 0, activeMembers: 0 };
  if ((Number(s.eligible) || 0) === 0) return { allowed: false, reason: 'no_eligible_targets' };
  const active = Number(s.activeMembers) || 0;
  if (active === 0) return { allowed: true, reason: null };
  if (includeActiveMembers !== true) return { allowed: false, reason: EXCLUDE.ACTIVE_MEMBER };
  if (str(typedActiveCount) !== String(active)) return { allowed: false, reason: 'active_count_mismatch' };
  return { allowed: true, reason: null };
}

/** 「現有効会員を含める」を ON にするときの警告文（画面はこの文言を出す） */
export const INCLUDE_ACTIVE_WARNING =
  '現在有効な会員も対象になります。通常のカムバック施策では使用しません。';
