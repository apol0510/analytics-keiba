/**
 * sendgridNextMessage.js — 受信者ごとの「**次に送るべき通し番号**」の単一源（純粋・I/O なし）
 *
 * ## 何のために要るか（2026-09-18 MK 確定の移行）
 *
 * 選別配信の実行を SendGrid Marketing Campaigns へ移すとき、**最大の事故は再送**。
 * 11,000 件超を「全員 1 通目から」で Automation に入れると、既に 2〜3 通受け取った人へ
 * 同じ文面がもう一度届く。よって移行の入口は
 *
 *   > **その人が次に受け取るべき通し番号（1〜10）を確定すること**
 *
 * であり、それ以外（文面・間隔・送信）は SendGrid 側の仕事になる。
 *
 * ## 判定の原則（**この 3 つは緩めない**）
 *
 * 1. **`highestSent + 1`**。受け取った**通数**ではなく**最大の通し番号**で決める。
 *    穴（例: 1 と 3 だけ届いている）があっても**埋めない**。埋めると 2 通目が再送になる。
 * 2. **読めなければ `unresolved`**。台帳を引けなかったときに「未送信」と見なすと
 *    全員へ再送する。0 件（本当に 1 通も送っていない）と**必ず区別する**。
 * 3. **送ってよい状態の人だけ**。ENGAGED / PROMOTED / EXHAUSTED / SUPPRESSED は
 *    移行対象から外す（AK 側の除外理由をそのまま持ち込む）。
 *
 * ⚠️ 反応の定義・打ち切りの閾値は**ここでは決めない**。既存の
 *    `prospectPolicy.js` / `prospectEngagement.js` / `engagementPolicy.js` が単一源。
 * ⚠️ この結果に**アドレスを含めない集計**（`summarizeNextMessages`）を必ず用意する。
 *    件数だけを docs / ログ / 管理画面へ出す（PII を出さない）。
 */

import { PROSPECT_STATE, normalizeEmail } from './prospectPolicy.js';
import { TOTAL_MESSAGES } from './sendgridMessagePlan.js';

export const MIGRATION_STATUS = Object.freeze({
  /** SendGrid の Automation へ入れてよい（次の 1 通がある） */
  READY: 'ready',
  /** 10 通を配り終えている（もう送る通が無い）*/
  COMPLETED: 'completed',
  /** 送ってはいけない（反応済み・昇格済み・打ち切り・抑止）*/
  EXCLUDED: 'excluded',
  /** 判定できない（**送らない**。0 件と混同しない）*/
  UNRESOLVED: 'unresolved',
});

/** 除外・判定不能の理由（黙って 0 件にしない） */
export const NEXT_MESSAGE_REASON = Object.freeze({
  ENGAGED: 'engaged',
  PROMOTED: 'promoted',
  EXHAUSTED: 'exhausted',
  SUPPRESSED: 'suppressed',
  UNKNOWN_STATE: 'unknown_state',
  NO_EMAIL: 'no_email',
  LEDGER_UNAVAILABLE: 'ledger_unavailable',
  PLAN_UNAVAILABLE: 'plan_unavailable',
});

/** 送信を続けてよい状態（`prospectStore.isSendableState` と同じ集合） */
const SENDABLE = new Set([PROSPECT_STATE.NEW, PROSPECT_STATE.SENDING]);

/** 状態 → 除外理由（未知の状態は `unknown_state` で**除外側**へ倒す） */
const EXCLUDE_BY_STATE = Object.freeze({
  [PROSPECT_STATE.ENGAGED]: NEXT_MESSAGE_REASON.ENGAGED,
  [PROSPECT_STATE.PROMOTED]: NEXT_MESSAGE_REASON.PROMOTED,
  [PROSPECT_STATE.EXHAUSTED]: NEXT_MESSAGE_REASON.EXHAUSTED,
  [PROSPECT_STATE.SUPPRESSED]: NEXT_MESSAGE_REASON.SUPPRESSED,
});

const intOr = (v, dflt) => (Number.isInteger(Number(v)) ? Number(v) : dflt);

/**
 * 1 人ぶんの判定。
 *
 * @param {{
 *   prospect: {email?: string, state?: string, delivered?: number, opens?: number, clicks?: number},
 *   deliveredMessageNumbers: Set<number>|null,  // 台帳で確認できた通し番号。**null = 引けなかった**
 *   totalMessages?: number,
 * }} input
 * @returns {{status: string, reason: string|null, nextMessageNumber: number|null,
 *            highestSent: number, sentCount: number, gaps: number[]}}
 */
export function resolveNextMessage({ prospect, deliveredMessageNumbers, totalMessages } = {}) {
  const total = intOr(totalMessages, TOTAL_MESSAGES);
  const base = {
    status: MIGRATION_STATUS.UNRESOLVED, reason: null,
    nextMessageNumber: null, highestSent: 0, sentCount: 0, gaps: [],
  };

  const email = normalizeEmail(prospect && prospect.email);
  if (!email) return { ...base, reason: NEXT_MESSAGE_REASON.NO_EMAIL };

  // ⚠️ **引けなかった**を「まだ送っていない」と読まない（読むと全員へ再送）
  if (!(deliveredMessageNumbers instanceof Set)) {
    return { ...base, reason: NEXT_MESSAGE_REASON.LEDGER_UNAVAILABLE };
  }

  // 送ってよい状態か（反応済み・昇格済み・打ち切り・抑止は移行対象にしない）
  const state = String((prospect && prospect.state) || '');
  if (!SENDABLE.has(state)) {
    return {
      ...base,
      status: MIGRATION_STATUS.EXCLUDED,
      reason: EXCLUDE_BY_STATE[state] || NEXT_MESSAGE_REASON.UNKNOWN_STATE,
    };
  }

  let highestSent = 0;
  let sentCount = 0;
  const gaps = [];
  for (let n = 1; n <= total; n += 1) {
    if (deliveredMessageNumbers.has(n)) {
      sentCount += 1;
      highestSent = n;
    }
  }
  // 穴は**記録するだけ**。埋めない（埋めると再送になる）
  for (let n = 1; n < highestSent; n += 1) {
    if (!deliveredMessageNumbers.has(n)) gaps.push(n);
  }

  if (highestSent >= total) {
    return {
      ...base, status: MIGRATION_STATUS.COMPLETED, highestSent, sentCount, gaps,
    };
  }
  return {
    status: MIGRATION_STATUS.READY,
    reason: null,
    nextMessageNumber: highestSent + 1,
    highestSent,
    sentCount,
    gaps,
  };
}

/**
 * 「送った番号より小さい番号を送ろうとしていないか」の最終確認。
 *
 * ⚠️ 変換層・Automation 計画・import 直前の**どこからでも**呼べる形にしておく。
 *    再送は取り返しがつかないので、判定を 1 か所に閉じ込めず**何度でも確かめる**。
 */
export function assertNoResend({ highestSent, nextMessageNumber } = {}) {
  const sent = intOr(highestSent, 0);
  const next = intOr(nextMessageNumber, 0);
  if (next <= 0) return { ok: false, reason: 'next_message_missing' };
  if (next <= sent) return { ok: false, reason: 'resend_detected' };
  if (next > sent + 1) return { ok: false, reason: 'gap_skipped' };
  return { ok: true, reason: null };
}

/**
 * 集計（**アドレスを 1 つも含めない**）。docs / 応答 / ログへ出すのはこの形だけ。
 *
 * @param {Array<{status: string, reason: string|null, nextMessageNumber: number|null,
 *                gaps?: number[]}>} results
 */
export function summarizeNextMessages(results, { totalMessages } = {}) {
  const total = intOr(totalMessages, TOTAL_MESSAGES);
  const byNextMessage = {};
  for (let n = 1; n <= total; n += 1) byNextMessage[n] = 0;
  const excluded = {};
  const unresolved = {};
  let ready = 0; let completed = 0; let withGaps = 0;

  for (const r of Array.isArray(results) ? results : []) {
    if (!r) continue;
    if (Array.isArray(r.gaps) && r.gaps.length > 0) withGaps += 1;
    if (r.status === MIGRATION_STATUS.READY) {
      ready += 1;
      const n = intOr(r.nextMessageNumber, 0);
      if (n >= 1 && n <= total) byNextMessage[n] += 1;
      continue;
    }
    if (r.status === MIGRATION_STATUS.COMPLETED) { completed += 1; continue; }
    if (r.status === MIGRATION_STATUS.EXCLUDED) {
      const k = r.reason || NEXT_MESSAGE_REASON.UNKNOWN_STATE;
      excluded[k] = (excluded[k] || 0) + 1;
      continue;
    }
    const k = r.reason || 'unknown';
    unresolved[k] = (unresolved[k] || 0) + 1;
  }

  const excludedTotal = Object.values(excluded).reduce((a, b) => a + b, 0);
  const unresolvedTotal = Object.values(unresolved).reduce((a, b) => a + b, 0);
  return {
    総数: ready + completed + excludedTotal + unresolvedTotal,
    移行対象: ready,
    配り終えた: completed,
    除外: excludedTotal,
    判定不能: unresolvedTotal,
    次に送る番号別: byNextMessage,
    除外の内訳: excluded,
    判定不能の内訳: unresolved,
    /** 穴あき（低い番号が抜けている）。**埋めない**が、件数は把握する */
    穴あき: withGaps,
  };
}

/**
 * 集計にアドレスが混ざっていないことを構造的に確かめる（guard テストから使う）。
 * 値に `@` を含む文字列があれば**アドレスが漏れている**と見なす。
 */
export function containsEmailLike(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return /@/.test(value);
  if (Array.isArray(value)) return value.some(containsEmailLike);
  if (typeof value === 'object') {
    return Object.entries(value).some(([k, v]) => containsEmailLike(k) || containsEmailLike(v));
  }
  return false;
}

export default resolveNextMessage;
