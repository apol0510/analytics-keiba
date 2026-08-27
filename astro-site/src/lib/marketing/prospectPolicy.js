/**
 * prospectPolicy.js — 見込み客（prospect）の**判定の単一源**（純粋・I/O なし）
 *
 * ── なぜ prospect を Customers と分けるか ──────────────────────
 * 外部 CSV の 1 万数千件を**そのまま Airtable Customers へ入れない**。
 * 反応が無いアドレスまで顧客台帳に混ぜると、
 *   - 顧客数・セグメント・集計がすべて薄まる
 *   - 配信停止やバウンスの管理対象が無駄に膨らむ
 *   - 「顧客」と「まだ顧客でない人」の区別が消える
 * ため。**1 回でも反応した人だけ**を Customers へ昇格させ、
 * 数回送って無反応なら**登録せずに以後の配信対象から外す**。
 *
 * ── 状態機械 ──────────────────────────────────────────────────
 *   NEW ──送信──▶ SENDING ──反応──▶ ENGAGED ──登録──▶ PROMOTED
 *                   │
 *                   ├─ **delivered が閾値以上で開封 0** ────────▶ EXHAUSTED（登録しない）
 *                   └─ bounce / 苦情 / 配信停止 ────────────────▶ SUPPRESSED（即時）
 *
 * ⚠️ **打ち切りは「送信回数」ではなく「配信成功（delivered）」で数える**
 *    （2026-08-27 MK 確定）。判定は `prospectEngagement.js` が単一源で、
 *    数字の正本は `engagementPolicy.js`（delivered 10 / 20）。
 *    旧仕様の `MAX_SENDS_WITHOUT_ENGAGEMENT = 3`（送信回数）は**削除した**。
 *
 * **SUPPRESSED と EXHAUSTED からは戻らない。** PROMOTED になったら
 * 以後の判断は Airtable Customers 側（既存 `resolveCustomerMarketing`）へ移る。
 *
 * ⚠️ この関数群は**アドレスを受け取るが保存しない**。保存の是非は
 *    `prospectStore.js` の責務（そちらに名前空間と PII の扱いを書いてある）。
 */

import { isProspectCutOff, PROSPECT_CUTOFF_REASON } from './prospectEngagement.js';

/**
 * 同じ相手へ続けて送らない最小間隔（JST 暦日）。
 *
 * ⚠️ これは**ペース配分**であって打ち切りではない。打ち切り（もう送らない）の判定は
 *    `prospectEngagement.js` の delivered 基準だけが決める。
 */
export const MIN_DAYS_BETWEEN_SENDS = 3;

export const PROSPECT_STATE = Object.freeze({
  NEW: 'NEW',
  SENDING: 'SENDING',
  ENGAGED: 'ENGAGED',
  PROMOTED: 'PROMOTED',
  EXHAUSTED: 'EXHAUSTED',
  SUPPRESSED: 'SUPPRESSED',
});

/** 反応とみなすもの。**開封とクリックだけ**（配信成功は反応ではない） */
export const ENGAGEMENT_KIND = Object.freeze({ OPEN: 'open', CLICK: 'click' });

/** 即時除外の理由 */
export const SUPPRESS_REASON = Object.freeze({
  BOUNCE: 'bounce',
  COMPLAINT: 'complaint',
  UNSUBSCRIBE: 'unsubscribe',
  DROPPED: 'dropped',
  INVALID: 'invalid_address',
  ALREADY_CUSTOMER: 'already_customer',
  MANUAL: 'manual',
});

/** 送らない理由（配信対象から外れた理由） */
export const SKIP_REASON = Object.freeze({
  SUPPRESSED: 'suppressed',
  EXHAUSTED: 'exhausted',
  PROMOTED: 'promoted',
  ALREADY_CUSTOMER: 'already_customer',
  TOO_SOON: 'too_soon',
  ALREADY_SENT_THIS_RUN: 'already_sent_this_run',
  NOT_ELIGIBLE: 'not_eligible',
});

const str = (v) => String(v ?? '').trim();
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

/** JST の暦日（`toISOString()` の UTC 基準は使わない） */
export function jstDate(ms) {
  const d = new Date(Number(ms) + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

/** JST 暦日の差 */
export function jstDayDiff(aMs, bMs) {
  const a = Date.parse(`${jstDate(aMs)}T00:00:00Z`);
  const b = Date.parse(`${jstDate(bMs)}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

export const normalizeEmail = (raw) => str(raw).toLowerCase();

/**
 * SendGrid のイベント種別を prospect の扱いへ翻訳する。
 * **知らない種別は「何もしない」**（勝手に除外も反応扱いもしない）。
 */
export function classifyEvent(eventType) {
  const t = str(eventType).toLowerCase();
  if (t === 'open') return { kind: 'engagement', engagement: ENGAGEMENT_KIND.OPEN };
  if (t === 'click') return { kind: 'engagement', engagement: ENGAGEMENT_KIND.CLICK };
  if (t === 'bounce' || t === 'blocked') return { kind: 'suppress', reason: SUPPRESS_REASON.BOUNCE };
  if (t === 'dropped') return { kind: 'suppress', reason: SUPPRESS_REASON.DROPPED };
  if (t === 'spamreport') return { kind: 'suppress', reason: SUPPRESS_REASON.COMPLAINT };
  if (t === 'unsubscribe' || t === 'group_unsubscribe') return { kind: 'suppress', reason: SUPPRESS_REASON.UNSUBSCRIBE };
  return { kind: 'ignore', reason: null };
}

/** prospect レコードの初期値 */
export function buildProspect({ email, nowMs, batchId, source }) {
  const e = normalizeEmail(email);
  return {
    email: e,
    state: PROSPECT_STATE.NEW,
    /** 送信「試行」回数。**打ち切りには使わない**（届いた保証が無い） */
    sends: 0,
    /** 配信成功の累計。**打ち切りはこの値だけで決める** */
    delivered: 0,
    /** 開封・クリックの累計（0 のままなら無反応） */
    opens: 0,
    clicks: 0,
    lastSentAt: null,
    lastDeliveredAt: null,
    lastRunId: null,
    engagedAt: null,
    engagedKind: null,
    promotedAt: null,
    suppressedAt: null,
    suppressedReason: null,
    addedAt: new Date(Number(nowMs) || 0).toISOString(),
    batchId: str(batchId) || null,
    source: str(source) || 'csv',
  };
}

/**
 * いま送ってよい相手か。**送らない理由は必ず 1 つ返す**（黙って落とさない）。
 *
 * @param {{prospect, nowMs, isCustomer, sentKeysThisRun, deliveryKey,
 *          maxSends, minDaysBetweenSends}} args
 */
export function evaluateProspectForSend({
  prospect, nowMs, isCustomer, sentKeysThisRun, deliveryKey,
  minDaysBetweenSends, env = process.env,
} = {}) {
  const p = prospect || {};
  const gap = Number.isFinite(Number(minDaysBetweenSends))
    ? int(minDaysBetweenSends) : MIN_DAYS_BETWEEN_SENDS;

  // ⚠️ 既存顧客は prospect として送らない（Customers 側の判定に一本化する）
  if (isCustomer === true) return { send: false, reason: SKIP_REASON.ALREADY_CUSTOMER };
  if (p.state === PROSPECT_STATE.SUPPRESSED) return { send: false, reason: SKIP_REASON.SUPPRESSED };
  if (p.state === PROSPECT_STATE.EXHAUSTED) return { send: false, reason: SKIP_REASON.EXHAUSTED };
  if (p.state === PROSPECT_STATE.PROMOTED) return { send: false, reason: SKIP_REASON.PROMOTED };

  // 反応済みだがまだ昇格していない相手も、prospect としては送らない
  // （昇格して Customers 側の配信に乗せる。二重送信を作らない）
  if (p.state === PROSPECT_STATE.ENGAGED) return { send: false, reason: SKIP_REASON.PROMOTED };

  // ⚠️ **打ち切りは delivered だけで判定する**（`prospectEngagement.js` が単一源）。
  //    `sends`（試行）が何回あっても、届いていなければ打ち切らない。
  if (isProspectCutOff(p, { env })) return { send: false, reason: SKIP_REASON.EXHAUSTED };

  if (p.lastSentAt && gap > 0) {
    const last = Date.parse(p.lastSentAt);
    if (Number.isFinite(last) && jstDayDiff(last, Number(nowMs)) < gap) {
      return { send: false, reason: SKIP_REASON.TOO_SOON };
    }
  }
  // 同一 run 内の二重送信を防ぐ
  if (sentKeysThisRun instanceof Set && deliveryKey && sentKeysThisRun.has(deliveryKey)) {
    return { send: false, reason: SKIP_REASON.ALREADY_SENT_THIS_RUN };
  }
  return { send: true, reason: null };
}

/**
 * 送信を「試みた」ことを記録する。
 *
 * ⚠️ **ここで打ち切らない。** 試行はまだ届いた証拠ではないので、
 *    何回積んでも EXHAUSTED にはしない（旧仕様はここで 3 回打ち切っていた）。
 *    打ち切りが起きるのは `applyDelivered()`（配信成功の記録）だけ。
 */
export function applySend({ prospect, nowMs, runId }) {
  const p = { ...(prospect || {}) };
  p.sends = int(p.sends) + 1;
  p.lastSentAt = new Date(Number(nowMs) || 0).toISOString();
  p.lastRunId = str(runId) || null;
  if (p.state === PROSPECT_STATE.NEW) p.state = PROSPECT_STATE.SENDING;
  return p;
}

/**
 * **配信成功（delivered）**を記録する。打ち切りが起きるのはここだけ。
 *
 * `delivered` が閾値に達し、開封もクリックも 0 なら **その場で EXHAUSTED**
 * （次回の判定を待たない）。反応済み（ENGAGED）・除外済み（SUPPRESSED）・
 * 昇格済み（PROMOTED）は**触らない**（状態を巻き戻さない）。
 */
export function applyDelivered({ prospect, nowMs, env = process.env }) {
  const p = { ...(prospect || {}) };
  if (p.state === PROSPECT_STATE.SUPPRESSED
    || p.state === PROSPECT_STATE.PROMOTED
    || p.state === PROSPECT_STATE.ENGAGED) {
    return { changed: false, prospect: p };
  }
  p.delivered = int(p.delivered) + 1;
  p.lastDeliveredAt = new Date(Number(nowMs) || 0).toISOString();
  if (isProspectCutOff(p, { env })) {
    p.state = PROSPECT_STATE.EXHAUSTED;
    p.suppressedReason = PROSPECT_CUTOFF_REASON;
  } else if (p.state === PROSPECT_STATE.NEW) {
    p.state = PROSPECT_STATE.SENDING;
  }
  return { changed: true, prospect: p };
}

/**
 * 反応を記録する。**SUPPRESSED からは戻さない**（苦情の後に開封しても復活させない）。
 */
export function applyEngagement({ prospect, nowMs, kind }) {
  const p = { ...(prospect || {}) };
  if (p.state === PROSPECT_STATE.SUPPRESSED) return { changed: false, prospect: p };
  if (p.state === PROSPECT_STATE.PROMOTED) return { changed: false, prospect: p };
  if (p.state === PROSPECT_STATE.ENGAGED) return { changed: false, prospect: p };
  p.state = PROSPECT_STATE.ENGAGED;
  p.engagedAt = new Date(Number(nowMs) || 0).toISOString();
  const k = str(kind) || ENGAGEMENT_KIND.OPEN;
  p.engagedKind = k;
  // 反応の回数も残す（打ち切り判定が「開封 0」を見るため）
  if (k === ENGAGEMENT_KIND.CLICK) p.clicks = int(p.clicks) + 1;
  else p.opens = int(p.opens) + 1;
  return { changed: true, prospect: p };
}

/** 除外を記録する。**どの状態からでも即時**に入る（最優先） */
export function applySuppression({ prospect, nowMs, reason }) {
  const p = { ...(prospect || {}) };
  if (p.state === PROSPECT_STATE.SUPPRESSED) return { changed: false, prospect: p };
  p.state = PROSPECT_STATE.SUPPRESSED;
  p.suppressedAt = new Date(Number(nowMs) || 0).toISOString();
  p.suppressedReason = str(reason) || SUPPRESS_REASON.MANUAL;
  return { changed: true, prospect: p };
}

/** Airtable へ登録した後の状態 */
export function applyPromotion({ prospect, nowMs }) {
  const p = { ...(prospect || {}) };
  p.state = PROSPECT_STATE.PROMOTED;
  p.promotedAt = new Date(Number(nowMs) || 0).toISOString();
  return p;
}

/**
 * 昇格してよいか。**反応済みだけ**。既存顧客なら昇格しない（重複登録の防止）。
 */
export function evaluateForPromotion({ prospect, isCustomer }) {
  const p = prospect || {};
  if (isCustomer === true) return { promote: false, reason: SKIP_REASON.ALREADY_CUSTOMER };
  if (p.state === PROSPECT_STATE.PROMOTED) return { promote: false, reason: SKIP_REASON.PROMOTED };
  if (p.state === PROSPECT_STATE.SUPPRESSED) return { promote: false, reason: SKIP_REASON.SUPPRESSED };
  if (p.state !== PROSPECT_STATE.ENGAGED) return { promote: false, reason: SKIP_REASON.NOT_ELIGIBLE };
  return { promote: true, reason: null };
}

/**
 * 取り込み時の仕分け。**Customers に居るアドレスは prospect にしない**。
 *
 * @param {{rows: {email:string}[], customerEmails:Set<string>,
 *          existingEmails:Set<string>, blacklistEmails:Set<string>, nowMs, batchId}} args
 */
export function planProspectIntake({
  rows, customerEmails, existingEmails, blacklistEmails, blockedHashes, hashFn, nowMs, batchId,
} = {}) {
  const customers = customerEmails instanceof Set ? customerEmails : new Set();
  const existing = existingEmails instanceof Set ? existingEmails : new Set();
  const blacklist = blacklistEmails instanceof Set ? blacklistEmails : new Set();
  // ⚠️ 永続抑止台帳（hash の集合）。**再取り込みで復活させない**
  const blocked = blockedHashes instanceof Set ? blockedHashes : new Set();
  const hash = typeof hashFn === 'function' ? hashFn : null;

  const add = []; const skipped = {}; const seen = new Set();
  const bump = (r) => { skipped[r] = (skipped[r] || 0) + 1; };

  for (const row of (rows || [])) {
    const email = normalizeEmail(row && row.email);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { bump('invalid_address'); continue; }
    if (seen.has(email)) { bump('duplicate_in_input'); continue; }
    seen.add(email);
    // ⚠️ 既存顧客は入れない（Customers が正本）
    if (customers.has(email)) { bump(SKIP_REASON.ALREADY_CUSTOMER); continue; }
    if (existing.has(email)) { bump('already_prospect'); continue; }
    // ⚠️ 台帳照合は**アドレスではなく hash**で行う（台帳は hash しか持たない）
    if (hash && blocked.has(hash(email))) { bump('permanently_blocked'); continue; }
    if (blacklist.has(email)) { bump(SUPPRESS_REASON.UNSUBSCRIBE); continue; }
    add.push(buildProspect({ email, nowMs, batchId, source: 'csv' }));
  }
  return { add, skipped, 入力: (rows || []).length, 追加: add.length };
}

/** 一覧表示用の要約（**アドレスを含めない**） */
export function summarizeProspects(list) {
  const byState = {};
  let engaged = 0; let promoted = 0;
  for (const p of (list || [])) {
    const s = str(p && p.state) || PROSPECT_STATE.NEW;
    byState[s] = (byState[s] || 0) + 1;
    if (s === PROSPECT_STATE.ENGAGED) engaged += 1;
    if (s === PROSPECT_STATE.PROMOTED) promoted += 1;
  }
  return { 合計: (list || []).length, 状態別: byState, 反応済み: engaged, 登録済み: promoted };
}

export default evaluateProspectForSend;
