/**
 * sendgridAutomationPlan.js — 通し番号別の **list / Automation 移行計画**（純粋・I/O なし）
 *
 * ## なぜ「通し番号ごとに Automation を分ける」のか
 *
 * SendGrid の Automation は **入った contact を 1 通目から順に**送る。
 * 「4 通目から始める」という入り方は無い。したがって
 *
 *   > **4 通目から始めたい人は「4 通目始まりの Automation」へ入れる**
 *
 * 以外に**再送を避ける方法が無い**。よって入口を 10 本に分ける（1 始まり〜10 始まり）。
 * 対象が 0 人の入口は**作らない**（空の Automation を並べても事故の元）。
 *
 * ## 1 日 1 通
 *
 * 各 Automation の n 番目のメールは **entry から (n-1) 日後**。
 * ⚠️ AK 側の `delayDays`（2〜6 日）とは**別物**。SendGrid 側の間隔が正本になる
 *    （AK は送らないので `MIN_STEP_DELAY_DAYS` は効かない）。この違いは
 *    docs に明記し、**AK の step 定義を書き換えて合わせない**（書き換えると
 *    `contentHash` が変わり `DeliveryKey` が変わる＝再送の入口になる）。
 *
 * ## 退出（exit）
 *
 * | 退出の理由 | 誰が検知するか | SendGrid をどう抜けるか |
 * |---|---|---|
 * | open / click | SendGrid → Event Webhook → AK（`ENGAGED`）| AK が **list から contact を外す** |
 * | 購入・ログイン等 | AK（既存の反応判定）| 同上 |
 * | bounce / 苦情 / 配信停止 | SendGrid（suppression）| SendGrid 側で自動停止 ＋ AK が `SUPPRESSED` |
 * | delivered 10 通・無反応 | AK（`applyDelivered` の打ち切り）| 10 通目で Automation は終端。AK が `EXHAUSTED` |
 *
 * ⚠️ **反応の定義を SendGrid 側で作り直さない。** 既存 AK の定義（open / click /
 *    購入 / ログイン）が単一源で、SendGrid で直接取れない反応は
 *    **AK が list から外すこと**で退出させる。
 */

import { TOTAL_MESSAGES } from './sendgridMessagePlan.js';

/** list / Automation の名前（**推測で作らない**ための単一源） */
export const LIST_NAME_PREFIX = 'ak-prospect-select-start-';
export const AUTOMATION_NAME_PREFIX = 'AK Prospect Selection start ';
/** 配信停止グループ（Marketing Campaigns の unsubscribe group） */
export const UNSUBSCRIBE_GROUP_NAME = 'AK Marketing';

/** メール間隔（日）。**1 日 1 通**（2026-09-18 MK 確定） */
export const INTERVAL_DAYS = 1;

export const listNameFor = (startMessage) => `${LIST_NAME_PREFIX}${startMessage}`;
export const automationNameFor = (startMessage) => `${AUTOMATION_NAME_PREFIX}${startMessage}`;

const intOr = (v, dflt) => (Number.isInteger(Number(v)) ? Number(v) : dflt);

/**
 * 通し番号別の件数 → 移行計画。
 *
 * @param {{
 *   countsByNextMessage: Record<number, number>,  // `summarizeNextMessages` の `次に送る番号別`
 *   plan: Array<{messageNumber: number, campaignId: string, stepNumber: number, subject: string}>,
 *   totalMessages?: number,
 * }} input
 * @returns {{ok: boolean, reason?: string, automations: object[], totals: object, warnings: string[]}}
 */
export function buildAutomationPlan({ countsByNextMessage, plan, totalMessages } = {}) {
  const total = intOr(totalMessages, TOTAL_MESSAGES);
  const steps = Array.isArray(plan) ? plan : [];
  if (steps.length !== total) {
    return {
      ok: false, reason: 'plan_incomplete', automations: [], totals: {}, warnings: [],
    };
  }
  const byNumber = new Map(steps.map((s) => [s.messageNumber, s]));
  const counts = countsByNextMessage && typeof countsByNextMessage === 'object'
    ? countsByNextMessage : {};

  const automations = [];
  const warnings = [];
  let contacts = 0;
  let remainingSends = 0;

  for (let start = 1; start <= total; start += 1) {
    const count = intOr(counts[start] ?? counts[String(start)], 0);
    const messages = [];
    for (let n = start; n <= total; n += 1) {
      const s = byNumber.get(n);
      if (!s) {
        return {
          ok: false, reason: 'plan_gap', automations: [], totals: {}, warnings: [],
        };
      }
      messages.push({
        messageNumber: n,
        /** entry からの経過日数（**1 日 1 通**） */
        dayOffset: (n - start) * INTERVAL_DAYS,
        campaignId: s.campaignId,
        stepNumber: s.stepNumber,
        subject: s.subject,
      });
    }
    contacts += count;
    remainingSends += count * messages.length;
    automations.push({
      startMessage: start,
      listName: listNameFor(start),
      automationName: automationNameFor(start),
      contactCount: count,
      /** 0 人の入口は**作らない**（空の Automation を並べない） */
      needed: count > 0,
      messageCount: messages.length,
      messages,
    });
  }

  const unknown = Object.keys(counts)
    .map((k) => intOr(k, 0))
    .filter((n) => n < 1 || n > total);
  if (unknown.length > 0) warnings.push(`未知の通し番号が含まれています: ${unknown.join(',')}`);

  return {
    ok: true,
    automations,
    totals: {
      対象contact数: contacts,
      作るAutomation数: automations.filter((a) => a.needed).length,
      残送信総数: remainingSends,
      /** 全員が最後まで進んだ場合に要する日数（1 日 1 通なので最長は 10 通ぶん） */
      最長日数: total - 1,
      unsubscribeGroup: UNSUBSCRIBE_GROUP_NAME,
      intervalDays: INTERVAL_DAYS,
    },
    warnings,
  };
}

/**
 * 反応 / 抑止で **SendGrid から退出させる**ための指示（純粋）。
 *
 * AK が検知した状態変化を「どの list から外すか」に変える。**外すだけ**で、
 * SendGrid の suppression（bounce / unsubscribe）はここでは触らない。
 *
 * @param {{
 *   changes: Array<{hash?: string, email: string, state: string}>,
 *   listIdByMessage: Map<number,string>|object,
 * }} input
 * @returns {{removals: Array<{email: string, listIds: string[], state: string}>, counts: object}}
 */
export function buildExitPlan({ changes, listIdByMessage } = {}) {
  const ids = [];
  if (listIdByMessage instanceof Map) ids.push(...listIdByMessage.values());
  else if (listIdByMessage && typeof listIdByMessage === 'object') {
    ids.push(...Object.values(listIdByMessage));
  }
  const listIds = [...new Set(ids.map(String).filter(Boolean))];

  const removals = [];
  const counts = {};
  for (const c of Array.isArray(changes) ? changes : []) {
    const email = String((c && c.email) || '').trim().toLowerCase();
    if (!email) continue;
    const state = String((c && c.state) || '');
    counts[state] = (counts[state] || 0) + 1;
    // ⚠️ **どの list に居るか分からなくても全 list から外す**（残ると次の 1 通が出る）
    removals.push({ email, listIds, state });
  }
  return { removals, counts: { 退出: removals.length, 状態別: counts } };
}

export default buildAutomationPlan;
