/**
 * sendgridMessagePlan.js — prospect 選別 10 通の**通し番号**の単一源（純粋・I/O なし）
 *
 * ## なぜ要るか（2026-09-18 MK 確定）
 *
 * prospect の選別配信（約 15,000 件 → 1 日 1 通 → 最大 10 通 → 反応者は退出 →
 * delivered 10 通・無反応で除外）の**実行**を、AK 自作の cron / queue から
 * **SendGrid Marketing Campaigns の Automation** へ移す。
 *
 * 移す先で最初に要るのは「**この人は次に何通目を受け取るのか**」だけで、
 * それには AK 側の 2 つの campaign を**1 本の通し番号**として見る必要がある。
 *
 * | 通し番号 | campaignId | step |
 * |---|---|---|
 * | 1〜3 | `campaign-discount-free`（第 1 期）| 1〜3 |
 * | 4〜10 | `campaign-prospect-phase2`（第 2 期）| 1〜7 |
 *
 * ## ここで決めること・決めないこと
 *
 * - **決める**: 通し番号 ↔ (campaignId, step) の対応と、その健全性（3 + 7 = 10）
 * - **決めない**: 誰が何通目まで受け取ったか（`sendgridNextMessage.js`）、
 *   送信そのもの、文面（既存 catalog が単一源）
 *
 * ⚠️ **文面・`version`・step 定義を 1 バイトも変えない。** 通し番号は
 *    既存定義の**読み方**であって、新しい配信定義ではない。変えると `DeliveryKey`
 *    が変わり、**既に受け取った人へもう一度届く**。
 * ⚠️ **campaign が期間外でも対応表は変わってはいけない。** 第 1 期は
 *    `get enabled() { return isCampaignActive(); }` で期間が切れると無効になるが、
 *    「何通目まで送ったか」の対応表が期間で変わると、移行の途中で番号がずれる。
 *    よって解決は必ず `includeDisabled: true` で行う。
 * ⚠️ **fail closed**: 対応表を作れない（campaign が無い / step 数が合わない）なら
 *    `ok:false` を返す。0 件や既定値へ倒さない（倒すと全員 1 通目から送り直しになる）。
 */

import { getCampaign as catalogGetCampaign } from './campaignCatalog.js';
import { getSequenceSteps, resolveSequenceStep } from './campaignSequence.js';
import { computeCampaignDeliveryKey } from './campaignSend.js';

/** 第 1 期（3 通）。**既存の割引メール**。文面も version も触らない */
export const PHASE1_CAMPAIGN_ID = 'campaign-discount-free';
/** 第 2 期（7 通）。prospect 専用の後段 */
export const PHASE2_CAMPAIGN_ID = 'campaign-prospect-phase2';

/** 選別に使う通し番号の総数。**打ち切りの分母（delivered 10）と同じ数**にそろえる */
export const TOTAL_MESSAGES = 10;

/** 期ごとの期待 step 数（ここが崩れたら移行を始めてはいけない） */
export const PHASE_STEP_COUNTS = Object.freeze({ [PHASE1_CAMPAIGN_ID]: 3, [PHASE2_CAMPAIGN_ID]: 7 });

/** 並び順（**この順にしか通し番号を振らない**） */
export const PHASE_ORDER = Object.freeze([PHASE1_CAMPAIGN_ID, PHASE2_CAMPAIGN_ID]);

/** 対応表を作れない理由（**0 件と区別する**） */
export const PLAN_FAIL = Object.freeze({
  CAMPAIGN_MISSING: 'campaign_missing',
  NOT_A_SEQUENCE: 'not_a_sequence',
  STEP_COUNT_MISMATCH: 'step_count_mismatch',
  TOTAL_MISMATCH: 'total_mismatch',
  VERSION_MISSING: 'version_missing',
});

/**
 * 通し番号 → (campaignId, version, step) の対応表。
 *
 * @param {{lookup?: (id: string) => object|null}} [deps]
 *   `lookup` はテスト用の差し替え口。既定は catalog（`includeDisabled: true`）。
 * @returns {{ok: boolean, reason?: string, detail?: string, plan: Array<{
 *   messageNumber: number, phase: number, campaignId: string,
 *   version: number, stepNumber: number, subject: string, delayDays: number
 * }>}}
 */
export function buildMessagePlan({ lookup } = {}) {
  const get = typeof lookup === 'function'
    ? lookup
    : (id) => catalogGetCampaign(id, { includeDisabled: true });

  const plan = [];
  let messageNumber = 0;
  for (let i = 0; i < PHASE_ORDER.length; i += 1) {
    const campaignId = PHASE_ORDER[i];
    const campaign = get(campaignId);
    if (!campaign) {
      return { ok: false, reason: PLAN_FAIL.CAMPAIGN_MISSING, detail: campaignId, plan: [] };
    }
    const version = Number(campaign.version);
    if (!Number.isFinite(version)) {
      return { ok: false, reason: PLAN_FAIL.VERSION_MISSING, detail: campaignId, plan: [] };
    }
    const steps = getSequenceSteps(campaign);
    if (steps.length === 0) {
      return { ok: false, reason: PLAN_FAIL.NOT_A_SEQUENCE, detail: campaignId, plan: [] };
    }
    // ⚠️ step 数が期待と違うなら**移行を始めない**。番号がずれると再送になる
    if (steps.length !== PHASE_STEP_COUNTS[campaignId]) {
      return { ok: false, reason: PLAN_FAIL.STEP_COUNT_MISMATCH, detail: campaignId, plan: [] };
    }
    for (const step of steps) {
      messageNumber += 1;
      plan.push({
        messageNumber,
        phase: i + 1,
        campaignId,
        version,
        stepNumber: step.stepNumber,
        subject: String(step.subject || ''),
        /** AK 側の間隔（日）。**SendGrid の 1 日間隔とは別物**（記録として残す） */
        delayDays: Number.isFinite(Number(step.delayDays)) ? Number(step.delayDays) : 0,
      });
    }
  }
  if (plan.length !== TOTAL_MESSAGES) {
    return { ok: false, reason: PLAN_FAIL.TOTAL_MISMATCH, detail: String(plan.length), plan: [] };
  }
  return { ok: true, plan };
}

/**
 * 1 人ぶんの「通し番号 → `DeliveryKey`」。
 *
 * ⚠️ **鍵の作り方は変えない**（`computeCampaignDeliveryKey` が唯一の生成元）。
 *    ここがズレると既送信を見落として**再送**する。
 * ⚠️ 1 つでも鍵を作れなければ `null` を返す（**部分的な対応表を使わせない**）。
 *
 * @returns {Map<number, string>|null} messageNumber → DeliveryKey
 */
export function buildMessageKeys({ plan, email, brand, fromEmail, lookup } = {}) {
  const get = typeof lookup === 'function'
    ? lookup
    : (id) => catalogGetCampaign(id, { includeDisabled: true });
  const address = String(email || '').trim().toLowerCase();
  if (!address || !Array.isArray(plan) || plan.length === 0) return null;

  const out = new Map();
  for (const entry of plan) {
    const campaign = get(entry.campaignId);
    if (!campaign) return null;
    const effective = resolveSequenceStep(campaign, entry.stepNumber);
    if (!effective) return null;
    const key = computeCampaignDeliveryKey({
      campaign: effective, recipientEmail: address, brand, fromEmail,
    });
    if (!key) return null;
    out.set(entry.messageNumber, key);
  }
  return out;
}

/**
 * campaign ごとに「その campaign に属する通し番号と step」をまとめる。
 * 台帳（`DeliveryKey` 集合）は campaign 単位で引くので、その単位に合わせるため。
 *
 * @returns {Array<{campaignId: string, version: number,
 *   entries: Array<{messageNumber: number, stepNumber: number}>}>}
 */
export function groupPlanByCampaign(plan) {
  const byId = new Map();
  for (const entry of Array.isArray(plan) ? plan : []) {
    if (!byId.has(entry.campaignId)) {
      byId.set(entry.campaignId, { campaignId: entry.campaignId, version: entry.version, entries: [] });
    }
    byId.get(entry.campaignId).entries.push({
      messageNumber: entry.messageNumber, stepNumber: entry.stepNumber,
    });
  }
  return [...byId.values()];
}

export default buildMessagePlan;
