/**
 * sendgridSingleSendPlan.js — 選別配信を **Single Sends 27 通**で組む（純粋・I/O なし）
 *
 * ## なぜ Automation をやめたのか（2026-09-18 MK 確定）
 *
 * Automation は **公開 API に作成・更新の経路が無く**、画面で 1 通ずつ組むしかない。
 * さらに API で作った Design（`editor: 'code'`）は **Automation の「Your Email Designs」に出ない**
 * ことを実画面で確認した（原因の切り分けは `SENDGRID_MC_MIGRATION.md` §11-d）。
 *
 * **目的は「SendGrid 上で自動配信すること」であって、Automation 機能を使うことではない。**
 * Single Sends は**作成・内容設定・宛先・配信停止グループ・予約まで全部 API で完結**するので、
 * UI 手作業ゼロで同じ配信（1 日 1 通・最大 10 通・list 別の開始位置）を実現できる。
 *
 * ## 27 通の構成（list は既存 3 本をそのまま使う / segment は使わない）
 *
 * | 宛先 list | 送る通し番号 | 通数 |
 * |---|---|---:|
 * | `ak-prospect-select-start-1` | 01 → 10 | **10** |
 * | `ak-prospect-select-start-2` | 02 → 10 | **9** |
 * | `ak-prospect-select-start-3` | 03 → 10 | **8** |
 *
 * **同じ暦日に同じ通し番号が出る**ように並べる（day 0 は 01 / 02 / 03、day 1 は 02 / 03 / 04 …）。
 * ⚠️ 3 本の list は**互いに素**（1 人はどれか 1 本にしか居ない）なので、
 *    1 人が 1 日に受け取るのは **1 通だけ**。
 *
 * ## 守ること
 *
 * - 文面（subject / html / plain）は**既存の書き出しを無加工**で使う
 * - **同じ名前の Single Send を二度作らない**（名前が識別子）
 * - list / sender / unsubscribe group の id が 1 つでも解決できなければ**何も作らない**
 * - **予約（send_at）はこの計画に含めない**。予約は別の承認で、`buildSchedule()` が日付を与える
 */

import { TOTAL_MESSAGES } from './sendgridMessagePlan.js';
import { listNameFor, INTERVAL_DAYS, UNSUBSCRIBE_GROUP_NAME } from './sendgridAutomationPlan.js';

/** 開始番号（＝ list）。**実測で人が居る 3 つだけ** */
export const SINGLE_SEND_STARTS = Object.freeze([1, 2, 3]);

/** Single Send の名前（**これが二重作成を防ぐ識別子**） */
export const singleSendName = (start, messageNumber) => `AK Prospect Selection s${start} m${String(messageNumber).padStart(2, '0')}`;

export const PLAN_FAIL = Object.freeze({
  MESSAGES_INCOMPLETE: 'messages_incomplete',
  LIST_ID_MISSING: 'list_id_missing',
  SENDER_MISSING: 'sender_id_missing',
  GROUP_MISSING: 'suppression_group_missing',
  DUPLICATE_NAME: 'duplicate_name',
});

const intOr = (v, d) => (Number.isInteger(Number(v)) ? Number(v) : d);

/**
 * 27 通の計画を作る（純粋）。
 *
 * @param {{
 *   messages: Array<{messageNumber:number, campaignId:string, stepNumber:number, subject:string}>,
 *   listIdByStart: Record<number,string>|Map<number,string>,
 *   senderId: number, suppressionGroupId: number,
 *   starts?: number[], totalMessages?: number,
 * }} input
 * @returns {{ok:boolean, reason?:string, detail?:string, sends:Array, totals:object}}
 */
export function buildSingleSendPlan({
  messages, listIdByStart, senderId, suppressionGroupId, starts, totalMessages,
} = {}) {
  const total = intOr(totalMessages, TOTAL_MESSAGES);
  const list = Array.isArray(messages) ? messages : [];
  if (list.length !== total) {
    return {
      ok: false, reason: PLAN_FAIL.MESSAGES_INCOMPLETE, detail: String(list.length), sends: [], totals: {},
    };
  }
  const byNumber = new Map(list.map((m) => [m.messageNumber, m]));
  for (let n = 1; n <= total; n += 1) {
    if (!byNumber.has(n)) {
      return {
        ok: false, reason: PLAN_FAIL.MESSAGES_INCOMPLETE, detail: `missing:${n}`, sends: [], totals: {},
      };
    }
  }

  const sender = intOr(senderId, 0);
  if (sender <= 0) return { ok: false, reason: PLAN_FAIL.SENDER_MISSING, sends: [], totals: {} };
  const group = intOr(suppressionGroupId, 0);
  if (group <= 0) return { ok: false, reason: PLAN_FAIL.GROUP_MISSING, sends: [], totals: {} };

  const listOf = (n) => {
    if (listIdByStart instanceof Map) return listIdByStart.get(n) || null;
    const v = listIdByStart && typeof listIdByStart === 'object' ? listIdByStart[n] : null;
    return v ? String(v) : null;
  };

  const use = (Array.isArray(starts) && starts.length > 0 ? starts : SINGLE_SEND_STARTS)
    .map((n) => intOr(n, 0)).filter((n) => n >= 1 && n <= total);

  const sends = [];
  const seen = new Set();
  for (const start of use) {
    const listId = listOf(start);
    if (!listId) {
      return {
        ok: false, reason: PLAN_FAIL.LIST_ID_MISSING, detail: listNameFor(start), sends: [], totals: {},
      };
    }
    for (let n = start; n <= total; n += 1) {
      const m = byNumber.get(n);
      const name = singleSendName(start, n);
      if (seen.has(name)) {
        return { ok: false, reason: PLAN_FAIL.DUPLICATE_NAME, detail: name, sends: [], totals: {} };
      }
      seen.add(name);
      sends.push({
        name,
        startMessage: start,
        messageNumber: n,
        campaignId: m.campaignId,
        stepNumber: m.stepNumber,
        subject: m.subject,
        /** 同じ暦日に同じ通し番号が出るよう、**開始番号からの経過日数**で並べる */
        dayOffset: (n - start) * INTERVAL_DAYS,
        listId,
        listName: listNameFor(start),
        senderId: sender,
        suppressionGroupId: group,
      });
    }
  }

  const byStart = {};
  for (const s of sends) byStart[s.startMessage] = (byStart[s.startMessage] || 0) + 1;
  return {
    ok: true,
    sends,
    totals: {
      SingleSend数: sends.length,
      開始番号別: byStart,
      間隔日数: INTERVAL_DAYS,
      最長日数: Math.max(...sends.map((s) => s.dayOffset), 0),
      unsubscribeGroup: UNSUBSCRIBE_GROUP_NAME,
      segment: 'なし（list だけを宛先にする）',
    },
  };
}

/**
 * 予約時刻（**別の承認で使う**。計画そのものには持たせない）。
 *
 * @param {{sends: Array, baseDateIso: string, hourUtc?: number}} input
 * @returns {{ok: boolean, reason?: string, schedule: Array<{name: string, send_at: string}>}}
 */
export function buildSchedule({ sends, baseDateIso, hourUtc } = {}) {
  const base = Date.parse(String(baseDateIso || ''));
  if (!Number.isFinite(base)) return { ok: false, reason: 'bad_base_date', schedule: [] };
  const hour = intOr(hourUtc, null);
  const day = 24 * 60 * 60 * 1000;
  const schedule = (Array.isArray(sends) ? sends : []).map((s) => {
    const at = new Date(base + s.dayOffset * day);
    if (hour !== null) at.setUTCHours(hour, 0, 0, 0);
    return { name: s.name, send_at: at.toISOString() };
  });
  return { ok: true, schedule };
}

/**
 * 1 人あたり何通届くか（**list の人数から総送信数を出す**）。
 * `countsByNextMessage` は `summarizeNextMessages` の「次に送る番号別」。
 */
export function estimateSendVolume({ countsByNextMessage, starts, totalMessages } = {}) {
  const total = intOr(totalMessages, TOTAL_MESSAGES);
  const counts = countsByNextMessage && typeof countsByNextMessage === 'object' ? countsByNextMessage : {};
  const use = Array.isArray(starts) && starts.length > 0 ? starts : SINGLE_SEND_STARTS;
  const perStart = {};
  let emails = 0; let contacts = 0;
  for (const start of use) {
    const c = intOr(counts[start] ?? counts[String(start)], 0);
    const messages = total - start + 1;
    perStart[start] = { contacts: c, messagesEach: messages, emails: c * messages };
    contacts += c;
    emails += c * messages;
  }
  return { contacts, emails, perStart };
}

export default buildSingleSendPlan;
