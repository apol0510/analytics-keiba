/**
 * automationTickPlan.js — 毎日の配信 1 回ぶんの**計画**（純粋・I/O なし）
 *
 * scheduler の tick が「誰に何を送るか」を決めるところ。**ここでは何も書かない**。
 * Redis も Airtable も触らず、**呼び出し側がゲートの内側で実行する計画**を返す。
 *
 * ── 組み立ての順序（安全側から）────────────────────────────────
 *   1. 承認済み snapshot と現在の対象を突き合わせる（違えば**何もしない**）
 *   2. Customers 由来と prospect 由来を 1 つにまとめ、**重複を落とす**
 *   3. 上限を超えたら**切り捨てず中止**（部分送信の曖昧さを作らない）
 *   4. 既存 enqueue 契約が要求する形にする（ScheduledEmails の PENDING 行）
 *
 * ⚠️ prospect の送信回数は **enqueue が成功してから**記録する。
 *    先に数えると、失敗した回まで「送った」ことになって早く諦めてしまう。
 */

import { verifySnapshotBeforeDispatch } from './automationScheduler.js';
import { mergeAudiences } from './prospectPipeline.js';
import { validateAutomationContext, buildJobId } from './marketingEnqueueContract.js';

const str = (v) => String(v ?? '').trim();
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

export const TICK_ABORT = Object.freeze({
  SNAPSHOT_DRIFT: 'snapshot_drift',
  NO_RECIPIENTS: 'no_recipients',
  OVER_MAX: 'over_max_recipients',
  INVALID_CONTEXT: 'invalid_automation_context',
});

/**
 * @param {{definition, occurrenceDate, runId, currentFingerprint, currentCount,
 *          customerRecipients, prospectRecipients, maxRecipients, tickBudget}} args
 * @returns {{ok, abort?, plan?}}
 */
export function planTickDelivery({
  definition, occurrenceDate, runId,
  currentFingerprint, currentCount,
  customerRecipients, prospectRecipients,
  maxRecipients, tickBudget, nowMs, scheduledAt, evaluatedAt,
} = {}) {
  const d = definition || {};

  // 1) 承認した対象と同じか（違えば送らない）
  const verified = verifySnapshotBeforeDispatch({
    definition: d,
    currentFingerprint, currentCount,
    currentCampaignVersion: d.campaignVersion,
    currentContentHash: d.contentHash,
    occurrenceDate,
  });
  if (!verified.ok) {
    return { ok: false, abort: TICK_ABORT.SNAPSHOT_DRIFT, drifts: verified.drifts };
  }

  // 2) 重複を落として 1 本にする
  const merged = mergeAudiences({ customerRecipients, prospectRecipients });
  if (merged.recipients.length === 0) {
    return { ok: false, abort: TICK_ABORT.NO_RECIPIENTS, counts: merged.counts };
  }

  // 3) 上限は切り捨てず中止
  const cap = int(maxRecipients);
  const budget = int(tickBudget);
  if (cap > 0 && merged.recipients.length > cap) {
    return { ok: false, abort: TICK_ABORT.OVER_MAX, 件数: merged.recipients.length, 上限: cap };
  }
  if (budget > 0 && merged.recipients.length > budget) {
    return { ok: false, abort: TICK_ABORT.OVER_MAX, 件数: merged.recipients.length, 上限: budget };
  }

  // 4) enqueue 契約が要求する文脈が揃っているか
  const ctx = {
    automationId: d.automationId,
    automationRunId: str(runId),
    operationId: `${str(runId)}#001`,
    // 受信者ごとに変わる値は enqueue 直前に差し替える。ここでは**揃っていること**だけ見る
    recipientKey: `${str(runId)}:batch`,
    campaignId: d.campaignId,
    campaignVersion: d.campaignVersion,
    shellVersion: d.shellVersion,
    contentHash: d.contentHash,
    scheduledAt: str(scheduledAt) || new Date(Number(nowMs) || 0).toISOString(),
    eligibilityEvaluatedAt: str(evaluatedAt) || new Date(Number(nowMs) || 0).toISOString(),
    snapshotFingerprint: verified.snapshotFingerprint,
    occurrenceDate,
  };
  const v = validateAutomationContext(ctx);
  if (v && v.ok === false) {
    return { ok: false, abort: TICK_ABORT.INVALID_CONTEXT, missing: v.missing || null };
  }

  return {
    ok: true,
    plan: {
      context: ctx,
      jobId: buildJobId({
        campaignId: d.campaignId, version: d.campaignVersion,
        fingerprint: verified.snapshotFingerprint, index: 0, automationRunId: str(runId),
      }),
      recipients: merged.recipients,
      // ⚠️ enqueue が成功した後にだけ送信回数を記録する相手
      prospectEmailsToRecord: merged.recipients
        .filter((r) => r['出所'] === 'prospect').map((r) => r.email),
      counts: merged.counts,
      dropped: merged.dropped,
    },
  };
}

/** 実行結果の要約（**アドレスを含めない**） */
export function summarizeTick({ plan, enqueued, failed }) {
  return {
    対象: plan ? plan.counts : null,
    重複除外: plan ? plan.dropped : null,
    enqueued: int(enqueued),
    failed: int(failed),
    prospect送信記録: plan ? plan.prospectEmailsToRecord.length : 0,
  };
}

export default planTickDelivery;
