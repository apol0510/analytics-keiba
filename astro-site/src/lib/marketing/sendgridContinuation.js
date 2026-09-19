/**
 * sendgridContinuation.js — **反応した人を次の導線へ渡す**（判定だけ / I/O なし）
 *
 * ## なぜ要るか
 *
 * 選別は「反応したら以後の選別メールを止める」までしかやらない。
 * 止めただけでは**反応した人が宙に浮く**。反応した人こそ次の訴求を受け取る相手なので、
 * 選別 list から外すのと**同じ webhook の中で**、継続配信の list へ移す。
 *
 * ## 守ること
 *
 * - 移すのは **反応した人だけ**（ENGAGED / PROMOTED）。
 *   配信停止・bounce・苦情（SUPPRESSED）と打ち切り（EXHAUSTED）は**移さない**
 * - 継続 list が無ければ**何もしない**（webhook が list を勝手に作らない）
 * - **新しい配送基盤を作らない。** 継続配信も SendGrid が送る
 * - アドレスは呼び出し内で閉じ、要約には件数だけ出す
 */

import { PROSPECT_STATE } from './prospectPolicy.js';

/** 反応した人を集める list（選別 3 本とは別。週 2 回の一斉配信の宛先になる） */
export const CONTINUATION_LIST_NAME = 'ak-drm-engaged';

/** 継続導線へ渡す状態（**反応した人だけ**） */
export const CONTINUATION_STATES = Object.freeze([
  PROSPECT_STATE.ENGAGED,
  PROSPECT_STATE.PROMOTED,
]);

/** 渡してはいけない状態（止めた人・配り終えた人） */
export const CONTINUATION_EXCLUDED_STATES = Object.freeze([
  PROSPECT_STATE.SUPPRESSED,
  PROSPECT_STATE.EXHAUSTED,
]);

/** 1 回の webhook で継続 list へ入れる上限 */
export const MAX_CONTINUATION_PER_CALL = 100;

const norm = (v) => String(v || '').trim().toLowerCase();

/**
 * webhook が拾った状態変化から、継続 list へ入れる人を選ぶ。
 *
 * @param {{changes: Array<{email:string, state:string}>}} input
 * @returns {{emails: string[], counts: object, refused: object}}
 */
export function planContinuation({ changes } = {}) {
  const allow = new Set(CONTINUATION_STATES);
  const emails = [];
  const seen = new Set();
  const counts = { 対象: 0, 対象外: 0, 重複: 0, 上限超過: 0 };
  const refused = {};
  for (const c of Array.isArray(changes) ? changes : []) {
    const email = norm(c && c.email);
    const state = String((c && c.state) || '');
    if (!email) { counts.対象外 += 1; refused.no_email = (refused.no_email || 0) + 1; continue; }
    if (!allow.has(state)) {
      counts.対象外 += 1;
      refused[state || 'unknown'] = (refused[state || 'unknown'] || 0) + 1;
      continue;
    }
    if (seen.has(email)) { counts.重複 += 1; continue; }
    if (emails.length >= MAX_CONTINUATION_PER_CALL) { counts.上限超過 += 1; continue; }
    seen.add(email);
    emails.push(email);
    counts.対象 += 1;
  }
  return { emails, counts, refused };
}

/** 応答・ログ用（**アドレスを出さない**） */
export function summarizeContinuation(plan, applied = {}) {
  return {
    list: CONTINUATION_LIST_NAME,
    対象: (plan && plan.counts && plan.counts.対象) || 0,
    対象外: (plan && plan.counts && plan.counts.対象外) || 0,
    入れた件数: Number(applied.added) || 0,
    理由別: (plan && plan.refused) || {},
    skipped: applied.skipped || null,
  };
}

export default planContinuation;
