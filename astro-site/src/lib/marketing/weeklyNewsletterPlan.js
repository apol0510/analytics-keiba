/**
 * weeklyNewsletterPlan.js — 選別後の**週 2 回の一斉配信**を組む（判定だけ / I/O なし）
 *
 * ## 立場
 *
 * 選別が終わったあと、残った見込み客へ**週 2 回**送る。
 * 送るのは SendGrid（Single Send）で、**AK 側に配送基盤は作らない**。
 * AK がやるのは「いつ・誰に・何を」を決めて **1 回 API を呼ぶ**ことだけ。
 *
 * ## 決めていること
 *
 * - 宛先は **`ak-drm-engaged` 1 本**（反応した人。webhook が自動で入れる）
 * - 曜日と時刻は**固定**（水・土 19:00 JST）。1 週間に **2 通まで**
 * - 名前は `AK Weekly YYYY-MM-DD`。**同じ名前があれば作らない**（二重予約の防止）
 * - **選別期間中は作らない**（27 通と重なると 1 日 2 通届く）
 * - 文面は**品質基準を通らなければ送らない**（`evaluateCopyStandard`）
 *
 * ⚠️ ここは判定だけ。作成・予約は呼び出し側（`cron-sendgrid-weekly`）。
 */

import { evaluateCopyStandard } from './emailCopyStandard.js';

/** 宛先 list（選別 3 本とは別） */
export const WEEKLY_LIST_NAME = 'ak-drm-engaged';

/** 送る曜日（0=日）。**水・土** */
export const WEEKLY_DAYS = Object.freeze([3, 6]);

/** 送る時刻（JST） */
export const WEEKLY_HOUR_JST = 19;

/** 1 週間に送ってよい通数 */
export const WEEKLY_MAX_PER_WEEK = 2;

/** 何日先までの枠を作るか（先を作りすぎない） */
export const WEEKLY_LOOKAHEAD_DAYS = 7;

export const WEEKLY_REFUSE = Object.freeze({
  SELECTION_RUNNING: 'selection_running',
  ALREADY_PLANNED: 'already_planned',
  NO_SLOT: 'no_slot',
  WEEK_LIMIT: 'week_limit',
  EMPTY_AUDIENCE: 'empty_audience',
  COPY_REJECTED: 'copy_rejected',
  LIST_MISSING: 'list_missing',
});

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const pad = (n) => String(n).padStart(2, '0');

/** JST の暦日（`YYYY-MM-DD`）。UTC 基準で切らない */
export function jstDateKey(ms) {
  const d = new Date(ms + JST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** その JST 暦日の 19:00 を UTC のミリ秒で返す */
export function slotMsFor(dateKey) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  if (!y || !m || !d) return null;
  return Date.UTC(y, m - 1, d, WEEKLY_HOUR_JST - 9, 0, 0, 0);
}

export const weeklyName = (dateKey) => `AK Weekly ${dateKey}`;

/**
 * 次に作る枠を決める。
 *
 * @param {{
 *   nowMs: number,
 *   selectionEndsMs: number|null,  // 27 通の最終配信時刻（これを過ぎるまで作らない）
 *   existingNames: string[],       // すでにある Single Send の名前
 *   audienceCount: number,         // 宛先 list の人数
 *   listId: string|null,
 * }} input
 */
export function planWeeklySend({
  nowMs = Date.now(), selectionEndsMs = null, existingNames = [],
  audienceCount = 0, listId = null,
} = {}) {
  if (Number.isFinite(selectionEndsMs) && nowMs <= selectionEndsMs) {
    return { ok: false, reason: WEEKLY_REFUSE.SELECTION_RUNNING, slot: null };
  }
  if (!listId) return { ok: false, reason: WEEKLY_REFUSE.LIST_MISSING, slot: null };
  if (!Number.isFinite(audienceCount) || audienceCount <= 0) {
    return { ok: false, reason: WEEKLY_REFUSE.EMPTY_AUDIENCE, slot: null };
  }

  const names = new Set(existingNames.map(String));
  const day = 24 * 60 * 60 * 1000;

  /** その週（月曜起点）に何通あるか */
  const weekKeyOf = (ms) => {
    const d = new Date(ms + JST_OFFSET_MS);
    const dow = (d.getUTCDay() + 6) % 7; // 月曜 = 0
    return jstDateKey(ms - dow * day);
  };
  const plannedByWeek = new Map();
  for (const n of names) {
    const m = /^AK Weekly (\d{4}-\d{2}-\d{2})$/.exec(n);
    if (!m) continue;
    const ms = slotMsFor(m[1]);
    if (ms === null) continue;
    const k = weekKeyOf(ms);
    plannedByWeek.set(k, (plannedByWeek.get(k) || 0) + 1);
  }

  for (let i = 0; i <= WEEKLY_LOOKAHEAD_DAYS; i += 1) {
    const ms = nowMs + i * day;
    const dateKey = jstDateKey(ms);
    const slot = slotMsFor(dateKey);
    if (slot === null || slot <= nowMs) continue;
    const dow = new Date(slot + JST_OFFSET_MS).getUTCDay();
    if (!WEEKLY_DAYS.includes(dow)) continue;
    if (names.has(weeklyName(dateKey))) continue;              // 二重予約しない
    const wk = weekKeyOf(slot);
    if ((plannedByWeek.get(wk) || 0) >= WEEKLY_MAX_PER_WEEK) continue;
    return {
      ok: true,
      reason: null,
      slot: { dateKey, name: weeklyName(dateKey), sendAt: new Date(slot).toISOString(), listId, audienceCount },
    };
  }
  const anyThisWeek = plannedByWeek.get(weekKeyOf(nowMs)) || 0;
  return {
    ok: false,
    reason: anyThisWeek >= WEEKLY_MAX_PER_WEEK ? WEEKLY_REFUSE.WEEK_LIMIT : WEEKLY_REFUSE.NO_SLOT,
    slot: null,
  };
}

/**
 * 文面を**送ってよいか**だけ判定する（内容は呼び出し側が作る）。
 * 品質基準（`emailCopyStandard`）を通らなければ **false**。
 */
export function validateWeeklyContent(step = {}) {
  const verdict = evaluateCopyStandard(step, { label: 'ak-weekly' });
  const ok = verdict && verdict.ok === true;
  return {
    ok,
    reason: ok ? null : WEEKLY_REFUSE.COPY_REJECTED,
    /** 直し方が分かるように**理由コードだけ**返す（本文は返さない） */
    issues: ((verdict && verdict.issues) || []).map((i) => i.code),
  };
}

/** 応答・ログ用（**アドレスを出さない**） */
export function summarizeWeeklyPlan(plan) {
  if (!plan) return { ok: false, 理由: 'unknown' };
  if (!plan.ok) return { ok: false, 理由: plan.reason };
  return {
    ok: true,
    名前: plan.slot.name,
    配信日時: plan.slot.sendAt,
    宛先: WEEKLY_LIST_NAME,
    宛先人数: plan.slot.audienceCount,
  };
}

export default planWeeklySend;
