/**
 * automationScheduler.js — 実行判断・配信直前の再判定・突合（純粋・I/O なし）
 *
 * ── scheduler の責務 ──────────────────────────────────────────
 *   1. ACTIVE な Definition を取る
 *   2. JST と quiet hours で due か判定する
 *   3. due なものだけ claim する（`SET NX EX` は store 側）
 *   4. dry-run 時の snapshot と**現在の対象を再評価**する
 *   5. snapshot 増加 / campaignVersion 変更 / contentHash 変更を検知する
 *   6. 安全条件を満たすときだけ enqueue 候補を作る
 *   7. 1 回の実行で扱う automation 数と件数に上限を置く
 *
 * ── 配信直前の再判定（enqueue 時点だけでは足りない）─────────────
 * enqueue から dispatcher までの間に、相手が有料化・退会・配信停止・バウンス
 * することがある。**送る直前にもう一度**既存 AK ルールで判定し、
 * 外れていたら送らずに理由を残す。
 */

import { isQuietHours, jstDateString, buildAutomationRunId, RUN_REJECT } from './automationModel.js';
import { evaluateRecipient, AUTO_SKIP } from './automationEligibility.js';

/** 1 回の scheduler 実行で扱う automation 数の上限 */
export const MAX_AUTOMATIONS_PER_TICK = 3;
/** 1 回の scheduler 実行で作る enqueue 候補の総上限 */
export const MAX_RECIPIENTS_PER_TICK = 500;

/** 実行を見送る理由 */
export const SKIP_TICK = Object.freeze({
  NOT_ACTIVE: 'not_active',
  QUIET_HOURS: 'quiet_hours',
  NOT_DUE: 'not_due',
  ALREADY_RAN_TODAY: 'already_ran_today',
  LOCKED: 'locked',
  TICK_LIMIT: 'tick_limit',
});

/** 実行前に検知する「変わってしまったもの」 */
export const DRIFT = Object.freeze({
  SNAPSHOT_GREW: 'snapshot_grew',
  CAMPAIGN_VERSION_CHANGED: 'campaign_version_changed',
  CONTENT_HASH_CHANGED: 'content_hash_changed',
});

const str = (v) => String(v ?? '').trim();
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

/**
 * この Definition は今 due か。**Redis / Airtable へ触る前**に判定する。
 */
export function isDue({ definition, nowMs }) {
  if (!definition) return { due: false, reason: SKIP_TICK.NOT_ACTIVE };
  if (definition.status !== 'ACTIVE' || definition.enabled !== true) {
    return { due: false, reason: SKIP_TICK.NOT_ACTIVE };
  }
  if (isQuietHours({ nowMs, quietHours: definition.quietHours })) {
    return { due: false, reason: SKIP_TICK.QUIET_HOURS };
  }
  // 同じ JST 暦日に既に実行していれば見送る（配信回は 1 日 1 つ）
  const today = jstDateString(nowMs);
  if (str(definition.lastRunAt) && jstDateString(Date.parse(definition.lastRunAt)) === today) {
    return { due: false, reason: SKIP_TICK.ALREADY_RAN_TODAY };
  }
  return { due: true, reason: null, occurrenceDate: today };
}

/**
 * この tick で扱う Definition を選ぶ。**無制限に run を開始しない**。
 */
export function selectDueAutomations({ definitions, nowMs, maxAutomations }) {
  const limit = int(maxAutomations) || MAX_AUTOMATIONS_PER_TICK;
  const due = []; const skipped = {};
  for (const d of (definitions || [])) {
    const v = isDue({ definition: d, nowMs });
    if (!v.due) { skipped[v.reason] = (skipped[v.reason] || 0) + 1; continue; }
    if (due.length >= limit) { skipped[SKIP_TICK.TICK_LIMIT] = (skipped[SKIP_TICK.TICK_LIMIT] || 0) + 1; continue; }
    due.push({
      automationId: d.automationId,
      occurrenceDate: v.occurrenceDate,
      runId: buildAutomationRunId({ automationId: d.automationId, occurrenceDate: v.occurrenceDate }),
    });
  }
  return { due, skipped };
}

/**
 * dry-run 時から**変わってしまったもの**を検知する。
 * 1 つでもあれば enqueue しない（再承認が要る）。
 */
export function detectDrift({ dryRun, current }) {
  const d = dryRun || {}; const c = current || {};
  const drifts = [];
  if (int(c.snapshotCount) > int(d.snapshotCount)) drifts.push(DRIFT.SNAPSHOT_GREW);
  if (str(d.campaignVersion) && str(d.campaignVersion) !== str(c.campaignVersion)) {
    drifts.push(DRIFT.CAMPAIGN_VERSION_CHANGED);
  }
  if (str(d.contentHash) && str(d.contentHash) !== str(c.contentHash)) {
    drifts.push(DRIFT.CONTENT_HASH_CHANGED);
  }
  return { ok: drifts.length === 0, drifts };
}

/**
 * enqueue 候補を作る。**上限を超えたら切らずに止める**（部分送信の曖昧さを作らない）。
 */
export function buildEnqueuePlan({ recipients, maxRecipients, tickBudget }) {
  const list = Array.isArray(recipients) ? recipients : [];
  const cap = int(maxRecipients);
  const budget = int(tickBudget) || MAX_RECIPIENTS_PER_TICK;
  if (cap > 0 && list.length > cap) {
    return { ok: false, reason: RUN_REJECT.MAX_SENDS_EXCEEDED, plan: [], count: list.length, cap };
  }
  if (list.length > budget) {
    return { ok: false, reason: SKIP_TICK.TICK_LIMIT, plan: [], count: list.length, cap: budget };
  }
  return { ok: true, reason: null, plan: list, count: list.length };
}

/**
 * **配信直前の再判定**。既存 AK ルールでもう一度見て、外れていたら送らない。
 *
 * @returns {{ send: object[], drop: object[], reasons: object }}
 */
export function recheckBeforeDispatch({
  candidates, recordsByEmail, definition, nowMs, blacklistEmails, sentDeliveryKeys,
}) {
  const send = []; const drop = [];
  const reasons = {};
  const bump = (r) => { reasons[r] = (reasons[r] || 0) + 1; };

  for (const c of (candidates || [])) {
    const email = str(c.email).toLowerCase();
    // 既に送った deliveryKey は二度と送らない（Airtable が正本）
    if (sentDeliveryKeys instanceof Set && c.deliveryKey && sentDeliveryKeys.has(c.deliveryKey)) {
      bump(AUTO_SKIP.ALREADY_QUEUED); drop.push({ ...c, reason: AUTO_SKIP.ALREADY_QUEUED }); continue;
    }
    const rec = recordsByEmail ? recordsByEmail[email] : null;
    if (!rec) { bump('record_missing'); drop.push({ ...c, reason: 'record_missing' }); continue; }

    // ⚠️ 既存 AK ルールで**もう一度**判定する（有料化・退会・配信停止・バウンス）
    const v = evaluateRecipient({
      fields: rec.fields || rec, definition, nowMs, blacklistEmails,
    });
    if (!v.eligible) { bump(v.reason || 'unknown'); drop.push({ ...c, reason: v.reason }); continue; }
    send.push(c);
  }
  return { send, drop, reasons };
}

/**
 * 突合。**Redis / ScheduledEmails / CampaignDeliveries / EmailEvents** を突き合わせる。
 * 不一致なら自動続行しない。
 */
export const RECONCILE = Object.freeze({ OK: 'OK', PARTIAL: 'PARTIAL', BLOCKED: 'BLOCKED' });

export function reconcileRun({
  run, recipientClaims, scheduledRecipientCount, deliveryQueued, deliverySent, emailEventsAccepted,
}) {
  const queued = int(run?.queued);
  const excluded = int(run?.excluded);
  const failed = int(run?.failed);
  const snapshot = int(run?.snapshotCount);

  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail: detail ?? null });

  add('run_counts_balanced', queued + excluded + failed === snapshot,
    `${queued}+${excluded}+${failed} vs ${snapshot}`);
  add('claims_match_queued', int(recipientClaims) === queued, `${recipientClaims} vs ${queued}`);
  add('scheduled_matches_queued',
    scheduledRecipientCount === null || scheduledRecipientCount === undefined ? true : int(scheduledRecipientCount) === queued,
    `${scheduledRecipientCount} vs ${queued}`);
  add('deliveries_match_queued',
    deliveryQueued === null || deliveryQueued === undefined ? true : int(deliveryQueued) + int(deliverySent) === queued,
    `${deliveryQueued}+${deliverySent} vs ${queued}`);
  // provider 受理は実配信ではない。**受理数が queued を超えない**ことだけ見る
  add('events_within_queued',
    emailEventsAccepted === null || emailEventsAccepted === undefined ? true : int(emailEventsAccepted) <= queued,
    `${emailEventsAccepted} <= ${queued}`);

  const failedChecks = checks.filter((c) => !c.ok).map((c) => c.name);
  let verdict = RECONCILE.OK;
  if (failedChecks.length > 0) verdict = RECONCILE.BLOCKED;
  else if (failed > 0) verdict = RECONCILE.PARTIAL;

  return {
    verdict,
    /** 自動で次へ進んでよいか。**OK 以外は進めない** */
    canContinue: verdict === RECONCILE.OK,
    checks, failedChecks,
    counts: { snapshot, queued, excluded, failed, recipientClaims: int(recipientClaims) },
    note: verdict === RECONCILE.OK ? '突合は一致しています。'
      : (verdict === RECONCILE.PARTIAL ? '失敗が残っています。再送はせず内容を確認してください。'
        : '説明できない不一致があります。**人が確認するまで進めないでください。** 送信済みは再送しません。'),
  };
}

export default selectDueAutomations;
