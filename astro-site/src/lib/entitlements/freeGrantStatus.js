/**
 * freeGrantStatus.js — 無料付与の「いまの状態」と「これまでの記録」（純粋・I/O なし）
 *
 * ── なぜ分けるか ────────────────────────────────────────────────
 * これまで管理画面には「現在の特典」という 1 つの曖昧な絞り込みしか無く、
 *   ・いま無料で見られるのか
 *   ・過去に無料付与したことがあるのか
 * が同じ欄に混ざっていた。運用では「**いまは付与なしだが、過去に配った人**」を
 * 探したい場面が多く、この 2 つを混ぜると対象が作れない。
 *
 *   A. 現在の無料付与（`resolveCurrentFreeGrant`）… **いま**閲覧できるか
 *   B. 無料付与履歴（`resolveFreeGrantHistory`）  … **記録として残っているか**
 *
 * 判定の材料は `promotionalGrants.js` が解いた値だけ。ここで Airtable の
 * フィールドを直接読み直さない（判定が二重化して食い違うため）。
 *
 * ── 「履歴」で証明できること・できないこと ─────────────────────────
 * Customers は **ティアごとに最新の 1 回分**しか持たない
 * （`*GrantedAt` / `*GrantOp` / `*GrantedBy` / `*GrantUntil` / `*GrantRevokedAt`）。
 * したがって:
 *   ✅ 証明できる … 付与された事実 / 最後の付与日時 / 期間が終わったか / 取り消したか
 *   ❌ 証明できない … 付与回数、2 回目以前の内容、フィールド運用開始前の付与
 *
 * よって**証跡が 1 つも無い状態を「付与したことがない」と断定しない**。
 * `NO_RECORD`（付与の記録なし）という言い方に留める。
 */

import {
  PROMO_TIER, PROMO_TIER_LABEL, resolvePromotionalGrants, fmtDay,
} from './promotionalGrants.js';

/** 現在の無料付与（同じ項目内は OR で選ぶ） */
export const FREE_GRANT_NOW = Object.freeze({
  NONE: 'none',
  LIGHT_PERIOD: 'light_period',
  LIGHT_LIFETIME: 'light_lifetime',
  PREMIUM_PERIOD: 'premium_period',
  PREMIUM_LIFETIME: 'premium_lifetime',
  BOTH: 'both',
  INCONSISTENT: 'inconsistent',
});

export const FREE_GRANT_NOW_LABEL = Object.freeze({
  [FREE_GRANT_NOW.NONE]: '現在は無料付与なし',
  [FREE_GRANT_NOW.LIGHT_PERIOD]: 'Light 無料期間中',
  [FREE_GRANT_NOW.LIGHT_LIFETIME]: 'Light 永久無料',
  [FREE_GRANT_NOW.PREMIUM_PERIOD]: 'Premium 無料期間中',
  [FREE_GRANT_NOW.PREMIUM_LIFETIME]: 'Premium 永久無料',
  [FREE_GRANT_NOW.BOTH]: 'Light・Premium 両方が有効',
  [FREE_GRANT_NOW.INCONSISTENT]: '要確認（データ不整合）',
});

/** 無料付与履歴（記録から証明できる範囲だけ） */
export const FREE_GRANT_HISTORY = Object.freeze({
  NO_RECORD: 'no_record',
  LIGHT: 'light',
  PREMIUM: 'premium',
  BOTH: 'both',
  ENDED: 'ended',
  REVOKED: 'revoked',
  INCONSISTENT: 'inconsistent',
  UNKNOWN: 'unknown',
});

export const FREE_GRANT_HISTORY_LABEL = Object.freeze({
  [FREE_GRANT_HISTORY.NO_RECORD]: '付与の記録なし',
  [FREE_GRANT_HISTORY.LIGHT]: 'Light の付与歴あり',
  [FREE_GRANT_HISTORY.PREMIUM]: 'Premium の付与歴あり',
  [FREE_GRANT_HISTORY.BOTH]: 'Light・Premium 両方の付与歴あり',
  [FREE_GRANT_HISTORY.ENDED]: '無料期間が終了済み',
  [FREE_GRANT_HISTORY.REVOKED]: '取消・失効の記録あり',
  [FREE_GRANT_HISTORY.INCONSISTENT]: '要確認（記録が矛盾）',
  [FREE_GRANT_HISTORY.UNKNOWN]: '履歴不明（記録が不完全）',
});

/** 不整合の理由コード → 画面にそのまま出す文言 */
export const GRANT_CONFLICT = Object.freeze({
  REVOKED_BUT_VALUED: '取消の記録より後に有効な値が無い（取消後に値が残っている）',
  LIFETIME_WITH_UNTIL: '永久無料と期限が同時に設定されている',
  UNTIL_UNREADABLE: '期限の日時を読み取れない',
  ORPHAN_TRACE: '付与の痕跡はあるが、種類も期間も確定できない',
});

const DAY_MS = 24 * 60 * 60 * 1000;
const str = (v) => String(v ?? '').trim();

/** 選択（文字列でも配列でも受ける）を配列へ。空 / 'all' は「条件なし」 */
function selection(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value])
    .map((x) => str(x))
    .filter((x) => x && x !== 'all');
}

/**
 * 生フィールドで「永久無料と期限が同時に立っている」等の矛盾を見る。
 * `resolvePromotionalGrants` は fail closed で解決してしまうため、
 * **元の値**を見ないと「なぜ要確認なのか」を説明できない。
 */
export function validateFreeGrantConsistency(fields, nowMs = Date.now()) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const grants = resolvePromotionalGrants(f, nowMs);
  const reasons = [];
  for (const tier of [PROMO_TIER.LIGHT, PROMO_TIER.PREMIUM]) {
    const g = grants[tier];
    const label = PROMO_TIER_LABEL[tier];
    if (g.inconsistent) reasons.push(`${label}: ${GRANT_CONFLICT.REVOKED_BUT_VALUED}`);
    // 生値で「無期限 + 期限」の同時設定を見る（解決後は untilMs が落ちる）
    const rawLifetime = f[`${label === 'Light' ? 'Light' : 'Premium'}GrantLifetime`];
    const rawUntil = f[`${label === 'Light' ? 'Light' : 'Premium'}GrantUntil`];
    const lifetimeOn = rawLifetime === true || rawLifetime === 1 || str(rawLifetime).toLowerCase() === 'true';
    if (lifetimeOn && str(rawUntil) !== '') reasons.push(`${label}: ${GRANT_CONFLICT.LIFETIME_WITH_UNTIL}`);
    if (!lifetimeOn && str(rawUntil) !== '' && g.untilMs === null && g.revokedAtMs === null) {
      reasons.push(`${label}: ${GRANT_CONFLICT.UNTIL_UNREADABLE}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/** 1 ティア分の「いま」を短い文で表す（一覧の 1 行に収まる長さ） */
export function formatTierNow(g) {
  if (!g) return '';
  const label = PROMO_TIER_LABEL[g.tier];
  if (g.active && g.lifetime) return `${label} 永久無料`;
  if (g.active) {
    const days = Number.isFinite(g.daysRemaining) ? `残り ${g.daysRemaining} 日` : '';
    return `${label} 無料：${fmtDay(g.untilMs)} まで${days ? `（${days}）` : ''}`;
  }
  if (g.inconsistent) return `${label} 無料：要確認`;
  if (g.revokedAtMs !== null) return `${label} 無料：取消済み ${fmtDay(g.revokedAtMs)}`;
  if (g.expired) return `${label} 無料：${fmtDay(g.untilMs)} 終了`;
  if (g.grantedAtMs !== null) return `${label} 無料：過去に付与あり`;
  return '';
}

/**
 * 現在の無料付与を 1 つの区分へ落とす（絞り込み用）。
 * 併せて、画面にそのまま出せる説明と、両ティアの内訳を返す。
 *
 * @param {object|null} fields Customers の fields
 * @param {number} [nowMs]
 */
export function resolveCurrentFreeGrant(fields, nowMs = Date.now()) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const grants = resolvePromotionalGrants(fields, now);
  const consistency = validateFreeGrantConsistency(fields, now);
  const light = grants.light;
  const premium = grants.premium;

  /** 絞り込みで当たるコード（**複数当たりうる**。OR で選ぶため配列で持つ） */
  const codes = [];
  if (!consistency.ok) codes.push(FREE_GRANT_NOW.INCONSISTENT);
  if (light.active) codes.push(light.lifetime ? FREE_GRANT_NOW.LIGHT_LIFETIME : FREE_GRANT_NOW.LIGHT_PERIOD);
  if (premium.active) codes.push(premium.lifetime ? FREE_GRANT_NOW.PREMIUM_LIFETIME : FREE_GRANT_NOW.PREMIUM_PERIOD);
  if (light.active && premium.active) codes.push(FREE_GRANT_NOW.BOTH);
  if (!light.active && !premium.active) codes.push(FREE_GRANT_NOW.NONE);

  const parts = [formatTierNow(premium), formatTierNow(light)].filter(Boolean);
  const summary = parts.length ? parts.join(' / ') : '現在は無料付与なし';

  return {
    codes,
    /** 代表区分（一覧のバッジ 1 つ分） */
    primary: codes.includes(FREE_GRANT_NOW.INCONSISTENT) ? FREE_GRANT_NOW.INCONSISTENT : codes[0],
    summary,
    hasAny: light.active || premium.active,
    light: {
      active: light.active, lifetime: light.lifetime, untilMs: light.untilMs,
      daysRemaining: light.daysRemaining, text: formatTierNow(light),
    },
    premium: {
      active: premium.active, lifetime: premium.lifetime, untilMs: premium.untilMs,
      daysRemaining: premium.daysRemaining, text: formatTierNow(premium),
    },
    source: grants.source,
    consistent: consistency.ok,
    conflicts: consistency.reasons,
  };
}

/** 1 ティア分の履歴の証跡（何をもって「あった」と言えるか） */
function tierEvidence(g) {
  const granted = g.grantedAtMs !== null;
  const opOrBy = str(g.operationId) !== '' || str(g.grantedBy) !== '';
  const revoked = g.revokedAtMs !== null;
  const hadPeriod = g.untilMs !== null || g.expired;
  return {
    tier: g.tier,
    /** 付与が起きたと言い切れるか */
    granted: granted || hadPeriod || g.lifetime || g.active,
    /** 証跡はあるが、種類・時期を確定できない（op や by だけ残っている等） */
    traceOnly: !granted && !hadPeriod && !g.lifetime && !g.active && (opOrBy || revoked),
    revoked,
    ended: g.expired,
    grantedAtMs: g.grantedAtMs,
    revokedAtMs: g.revokedAtMs,
    operationId: g.operationId,
    grantedBy: g.grantedBy,
  };
}

/**
 * 無料付与の履歴を、記録から**証明できる範囲**で分類する。
 *
 * ⚠️ `NO_RECORD` は「一度も付与していない」ではなく「**この台帳に記録が無い**」。
 *    フィールド運用開始前の付与・別経路の無料開放は証明できない。
 */
export function resolveFreeGrantHistory(fields, nowMs = Date.now()) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const grants = resolvePromotionalGrants(fields, now);
  const consistency = validateFreeGrantConsistency(fields, now);
  const light = tierEvidence(grants.light);
  const premium = tierEvidence(grants.premium);

  const codes = [];
  if (light.granted) codes.push(FREE_GRANT_HISTORY.LIGHT);
  if (premium.granted) codes.push(FREE_GRANT_HISTORY.PREMIUM);
  if (light.granted && premium.granted) codes.push(FREE_GRANT_HISTORY.BOTH);
  if (light.ended || premium.ended) codes.push(FREE_GRANT_HISTORY.ENDED);
  if (light.revoked || premium.revoked) codes.push(FREE_GRANT_HISTORY.REVOKED);
  if (!consistency.ok) codes.push(FREE_GRANT_HISTORY.INCONSISTENT);
  if (light.traceOnly || premium.traceOnly) codes.push(FREE_GRANT_HISTORY.UNKNOWN);
  if (codes.length === 0) codes.push(FREE_GRANT_HISTORY.NO_RECORD);

  const parts = [];
  for (const e of [premium, light]) {
    const label = PROMO_TIER_LABEL[e.tier];
    if (e.granted) {
      const when = e.grantedAtMs !== null ? `${fmtDay(e.grantedAtMs)} 付与` : '付与日不明';
      const end = e.revoked ? `／${fmtDay(e.revokedAtMs)} 取消` : (e.ended ? '／期間終了' : '');
      parts.push(`${label}: ${when}${end}`);
    } else if (e.traceOnly) {
      parts.push(`${label}: 操作の痕跡のみ（内容不明）`);
    }
  }

  return {
    codes,
    summary: parts.length ? parts.join(' / ') : '付与の記録なし',
    /** 「記録が無い」＝「付与していない」ではないことを画面へ明示するための注記 */
    note: parts.length ? '' : 'この台帳に記録が無いだけで、過去の付与が無いことの証明ではありません。',
    light,
    premium,
    source: grants.source,
  };
}

/** 一覧 1 行に出す要約（現在 → 履歴の順。**色に頼らず文言で分かる**ようにする） */
export function formatFreeGrantSummary(fields, nowMs = Date.now()) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const cur = resolveCurrentFreeGrant(fields, now);
  const hist = resolveFreeGrantHistory(fields, now);
  const badges = [];
  if (!cur.consistent) badges.push({ tone: 'warn', icon: '⚠️', text: '要確認' });
  if (cur.light.active) badges.push({ tone: 'ok', icon: '🎁', text: cur.light.text });
  if (cur.premium.active) badges.push({ tone: 'ok', icon: '🎁', text: cur.premium.text });
  if (!cur.hasAny) {
    badges.push({
      tone: 'muted', icon: '—',
      text: hist.codes.includes(FREE_GRANT_HISTORY.NO_RECORD) ? '現在は無料付与なし' : '現在は無料付与なし（過去に付与記録あり）',
    });
  }
  return {
    current: cur.summary,
    history: hist.summary,
    historyNote: hist.note,
    conflicts: cur.conflicts,
    source: cur.source,
    badges,
    currentCodes: cur.codes,
    historyCodes: hist.codes,
  };
}

/** 選んだ区分のいずれかに当たるか（未選択なら絞らない） */
export function matchesFreeGrantNow(codes, sel) {
  const want = selection(sel);
  if (want.length === 0) return true;
  const has = new Set(codes || []);
  return want.some((w) => has.has(w));
}

/** 履歴の選択に当たるか（未選択なら絞らない） */
export function matchesFreeGrantHistory(codes, sel) {
  const want = selection(sel);
  if (want.length === 0) return true;
  const has = new Set(codes || []);
  return want.some((w) => has.has(w));
}

/** 条件要約（画面にそのまま出す。「特典」という語を使わない） */
export function describeFreeGrantFilters({ now, history } = {}) {
  const n = selection(now).map((c) => FREE_GRANT_NOW_LABEL[c] || c);
  const h = selection(history).map((c) => FREE_GRANT_HISTORY_LABEL[c] || c);
  if (n.length === 0 && h.length === 0) return '無料付与では絞り込んでいません。';
  const parts = [];
  if (n.length) parts.push(n.join('または'));
  if (h.length) parts.push(h.join('または'));
  return `${parts.join('で、')}の顧客を検索します。`;
}

/** 一覧全体の件数集計（PII なし） */
export function summarizeFreeGrants(rows = []) {
  const now = { total: 0 };
  const hist = {};
  for (const c of Object.values(FREE_GRANT_NOW)) now[c] = 0;
  for (const c of Object.values(FREE_GRANT_HISTORY)) hist[c] = 0;
  for (const r of rows) {
    now.total += 1;
    for (const c of r.currentCodes || []) if (c in now) now[c] += 1;
    for (const c of r.historyCodes || []) if (c in hist) hist[c] += 1;
  }
  return { now, history: hist };
}

export const FREE_GRANT_NOW_VALUES = Object.freeze(Object.values(FREE_GRANT_NOW));
export const FREE_GRANT_HISTORY_VALUES = Object.freeze(Object.values(FREE_GRANT_HISTORY));
export const DAY_MS_EXPORT = DAY_MS;
