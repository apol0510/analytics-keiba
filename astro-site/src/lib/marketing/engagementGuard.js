/**
 * engagementGuard.js — 「反応が無い相手を除外してよいか」を決める（純粋・I/O なし）
 *
 * ── これが答える問い ────────────────────────────────────────
 *   1. いま **除外を適用してよい状態か**（材料が揃っているか）
 *   2. 揃っているなら **どの期間の配信を数えるか**
 *   3. その結果 **誰が INACTIVE / HARD_INACTIVE なのか**
 *
 * 閾値（5 / 10 / 20）と状態の定義は `engagementPolicy.js` が単一源。
 * ここでは**複製しない**（複製すると片方だけ直って判定がズレる）。
 *
 * ── fail closed（1 つでも欠けたら誰も止めない）──────────────────
 * 「反応が無い」と「反応を観測できていない」を取り違えると、開封している人を
 * 切ってしまう。次のどれか 1 つでも欠ければ **guard は 1 人も除外しない**:
 *
 *   a. `MARKETING_ENGAGEMENT_GUARD=off`（緊急停止）
 *   b. 反応の集計（Redis）を読めない
 *   c. 配信基盤の **open 計測が有効でない**（無効・不明どちらも不可）
 *   d. 集計に open が **1 件も無い**（open が本当に届いている証拠が無い）
 *   e. 最後にイベントを受けてから時間が経ちすぎ（Webhook 停止の疑い）
 *
 * ── 数える期間 ──────────────────────────────────────────────
 * 集計が記録を始めた時刻（`started_at`）より前の配信は数えない。
 * `MARKETING_ENGAGEMENT_COVERAGE_SINCE` で**後ろへずらす**ことだけできる
 * （前へは戻せない。記録していない期間を「無反応」と見なさないため）。
 */

import {
  classifyEngagement, isBlockedByEngagement, resolveThresholds, summarizeEngagement, ENGAGEMENT,
} from './engagementPolicy.js';
import { buildEngagementStats } from './engagementStats.js';
import { hashEmailForSignal } from './engagementSignalStore.js';

/** 除外を適用しない理由（コード）。画面・ログはこの文字列を使う */
export const GUARD_SKIP = Object.freeze({
  OFF: 'guard_off',
  STORE_UNAVAILABLE: 'signal_store_unavailable',
  OPEN_NOT_MEASURED: 'open_not_measured',
  NO_OPEN_RECORDED: 'no_open_recorded',
  SIGNAL_STALE: 'signal_stale',
  NO_COVERAGE_START: 'no_coverage_start',
});

export const GUARD_SKIP_LABEL = Object.freeze({
  guard_off: '緊急停止中（MARKETING_ENGAGEMENT_GUARD=off）',
  signal_store_unavailable: '反応の集計を読み取れません（確認できないので誰も除外しません）',
  open_not_measured: '開封を計測していません（開封 0 が事実か確認できません）',
  no_open_recorded: '開封の記録がまだ 1 件もありません（記録が届いている証拠が無いため除外しません）',
  signal_stale: '反応の受信が長く途絶えています（Webhook 停止の疑いがあるため除外しません）',
  no_coverage_start: '集計の開始時刻が分かりません（どの期間を数えてよいか確定できません）',
});

/** 適用中であることを表す理由コード（画面で分岐せずに済むよう同じ形で返す） */
export const GUARD_ACTIVE = 'active';

/** これ以上イベントが途絶えたら「観測できていない」とみなす（既定 7 日） */
export const DEFAULT_MAX_SIGNAL_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const posMs = (v) => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};

/** `off` だけが停止。未設定・未知の値は既定（適用可の判定へ進む）へ倒す */
export function resolveGuardMode(env = process.env) {
  const raw = String((env && env.MARKETING_ENGAGEMENT_GUARD) || '').trim().toLowerCase();
  return raw === 'off' ? 'off' : 'auto';
}

/** イベント途絶とみなすまでの時間（env で伸縮可・壊れた値は既定） */
export function resolveMaxSignalAgeMs(env = process.env) {
  const n = num(env && env.MARKETING_ENGAGEMENT_MAX_SIGNAL_AGE_MS);
  return n !== null && n > 0 ? n : DEFAULT_MAX_SIGNAL_AGE_MS;
}

/**
 * 数え始める時刻。**記録開始より前へは戻せない**（記録の無い期間を無反応にしない）。
 * env は ISO 文字列でも epoch ms でも受ける。
 */
export function resolveCoverageSince({ meta, env = process.env } = {}) {
  const startedAtMs = posMs(meta && meta.startedAtMs);
  if (startedAtMs === null) return null;
  const raw = String((env && env.MARKETING_ENGAGEMENT_COVERAGE_SINCE) || '').trim();
  if (!raw) return startedAtMs;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return startedAtMs; // 壊れた値は無視（緩めない）
  return Math.max(startedAtMs, parsed);
}

/**
 * 除外を適用してよいか。
 *
 * @param {{ mode?: string, signals: object, measurement: object|null,
 *           nowMs: number, env?: object }} input
 * @returns {{usable: boolean, sinceMs: number|null, reason: string, label: string|null,
 *            openRecorded: number, lastEventAtMs: number|null, startedAtMs: number|null}}
 */
export function resolveEngagementCoverage({ mode, signals, measurement, nowMs, env = process.env } = {}) {
  const s = signals || {};
  const meta = s.meta || {};
  const openRecorded = s.openByHash instanceof Map ? s.openByHash.size : 0;
  const startedAtMs = posMs(meta.startedAtMs);
  const lastEventAtMs = posMs(meta.lastEventAtMs);
  const now = num(nowMs) ?? 0;

  const deny = (reason) => ({
    usable: false, sinceMs: null, reason, label: GUARD_SKIP_LABEL[reason] || reason,
    openRecorded, lastEventAtMs, startedAtMs,
  });

  const m = mode || resolveGuardMode(env);
  if (m === 'off') return deny(GUARD_SKIP.OFF);
  if (s.available !== true) return deny(GUARD_SKIP.STORE_UNAVAILABLE);
  // 「計測していない」と「計測状態が不明」はどちらも不可（推測しない）
  if (!measurement || measurement.open !== 'enabled') return deny(GUARD_SKIP.OPEN_NOT_MEASURED);
  if (openRecorded <= 0) return deny(GUARD_SKIP.NO_OPEN_RECORDED);

  const sinceMs = resolveCoverageSince({ meta, env });
  if (sinceMs === null) return deny(GUARD_SKIP.NO_COVERAGE_START);

  const maxAge = resolveMaxSignalAgeMs(env);
  if (lastEventAtMs === null || now - lastEventAtMs > maxAge) return deny(GUARD_SKIP.SIGNAL_STALE);

  return {
    usable: true, sinceMs, reason: GUARD_ACTIVE, label: null,
    openRecorded, lastEventAtMs, startedAtMs,
  };
}

/**
 * `EmailHash` 単位の集計を**アドレス単位**へ引き直す。
 * 値は「回数」ではなく有無で足りるため 1 を入れる（回数は保存していない）。
 */
export function mapSignalsToEmails({ emails, signals } = {}) {
  const openByEmail = new Map();
  const clickByEmail = new Map();
  const openedAtMs = new Map();
  const openByHash = signals && signals.openByHash instanceof Map ? signals.openByHash : new Map();
  const clickByHash = signals && signals.clickByHash instanceof Map ? signals.clickByHash : new Map();
  if (openByHash.size === 0 && clickByHash.size === 0) return { openByEmail, clickByEmail, openedAtMs };

  for (const raw of Array.isArray(emails) ? emails : []) {
    const email = String(raw || '').trim().toLowerCase();
    if (!email || openByEmail.has(email) || clickByEmail.has(email)) continue;
    const hash = hashEmailForSignal(email);
    if (!hash) continue;
    const at = openByHash.get(hash);
    if (at) { openByEmail.set(email, 1); openedAtMs.set(email, at); }
    if (clickByHash.get(hash)) clickByEmail.set(email, 1);
  }
  return { openByEmail, clickByEmail, openedAtMs };
}

/** 顧客一覧からアドレスを取り出す（重複はそのまま。呼び出し側で一意化しない） */
function emailsOf(list) {
  const out = [];
  for (const c of Array.isArray(list) ? list : []) {
    const e = String((c && c.fields && c.fields.Email) || '').trim().toLowerCase();
    if (e) out.push(e);
  }
  return out;
}

/**
 * 送信前に出す 1 セット（**下見と実送信で同じものを使う**）。
 *
 * `engagementByEmail` は **適用できるときだけ Map**。適用できないときは `null` を返し、
 * 呼び出し側（`buildCampaignPlan`）は Map でない値を素通りさせるので誰も除外されない。
 *
 * @param {{ list: object[], deliveries: object[], signals: object,
 *           measurement: object|null, nowMs: number, env?: object }} input
 */
export function buildEngagementView({
  list, deliveries, signals, measurement, nowMs, env = process.env,
} = {}) {
  const thresholds = resolveThresholds(env);
  const coverage = resolveEngagementCoverage({ signals, measurement, nowMs, env });
  const emails = emailsOf(list);
  const { openByEmail, clickByEmail, openedAtMs } = mapSignalsToEmails({ emails, signals });

  // 適用できないときも**参考値としての内訳**は出す（ただし期間を絞らない素の数字）。
  // 画面はこの数字を「いま除外される人数」と混同しないよう `applied` を必ず併記する。
  const statsByEmail = buildEngagementStats({
    list, deliveries, openByEmail, clickByEmail,
    sinceMs: coverage.usable ? coverage.sinceMs : null,
  });

  const counts = summarizeEngagement([...statsByEmail.values()], { thresholds });
  const blockedEmails = new Set();
  if (coverage.usable) {
    for (const [email, stats] of statsByEmail) {
      const { state } = classifyEngagement(stats, { thresholds });
      if (isBlockedByEngagement(state)) blockedEmails.add(email);
    }
  }

  return {
    applied: coverage.usable,
    reason: coverage.reason,
    reasonLabel: coverage.label,
    thresholds,
    coverage: {
      sinceMs: coverage.sinceMs,
      since: coverage.sinceMs ? new Date(coverage.sinceMs).toISOString() : null,
      startedAt: coverage.startedAtMs ? new Date(coverage.startedAtMs).toISOString() : null,
      lastEventAt: coverage.lastEventAtMs ? new Date(coverage.lastEventAtMs).toISOString() : null,
      openRecorded: coverage.openRecorded,
    },
    counts,
    blockedEmails,
    /** そのまま `buildCampaignPlan` へ渡す（適用不可なら null＝素通り） */
    engagementByEmail: coverage.usable ? statsByEmail : null,
    statsByEmail,
    openedAtMs,
  };
}

/** 画面向けの内訳（キーを固定して 0 も必ず出す） */
export function engagementCountsView(counts = {}) {
  return {
    active: counts[ENGAGEMENT.ACTIVE] || 0,
    lowEngagement: counts[ENGAGEMENT.LOW_ENGAGEMENT] || 0,
    inactive: counts[ENGAGEMENT.INACTIVE] || 0,
    hardInactive: counts[ENGAGEMENT.HARD_INACTIVE] || 0,
    unknown: counts[ENGAGEMENT.UNKNOWN] || 0,
  };
}
