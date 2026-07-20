/**
 * paymentEmailReconciler.js — Activity reconciler のコア（依存注入・dry-run 対応）。
 *
 * unknown_after_attempt（POST 済みかもしれない）のレコードについて、SendGrid Activity API を
 * idempotency_key で照合し、受理事実を確定させる／安全に再送へ戻す／人手へ上げる。
 *
 * **dryRun=true では書き込みを一切行わず、決定内容だけを返す**（S3 で dry-run 稼働）。
 * 実 IO は deps 経由。ユニットテストは fake を注入し実接続しない。
 */

import { classifyActivityResult, decideReconcile, EMAIL_STATUS } from './paymentEmailState.js';

function pickMessageId(messages) {
  const m = Array.isArray(messages) && messages.length === 1 ? messages[0] : null;
  return m ? (m.msg_id || m.msgId || null) : null;
}

/**
 * unknown_after_attempt 1 件を照合する。
 * @param {object} p
 * @param {{id: string, fields: object}} p.record
 * @param {number} p.now
 * @param {boolean} p.dryRun
 * @param {object} p.deps
 *   - searchActivity(idempotencyKey) -> {httpStatus: number, messages: any[]}
 *   - patchRecord(recordId, fields) -> any
 *   - log?(obj)
 * @returns {Promise<{action: string, reason: string, wouldWrite?: object|null, wrote?: object, dryRun?: boolean, skipped?: boolean}>}
 */
export async function reconcileOne({ record, now, dryRun = false, deps }) {
  const f = record.fields || record;
  if (f.PaymentEmailStatus !== EMAIL_STATUS.UNKNOWN_AFTER_ATTEMPT) {
    return { action: 'skip', reason: 'not_unknown', skipped: true };
  }

  const idempotencyKey = f.PaymentEmailIdempotencyKey || '';
  const attemptedAtMs = f.PaymentEmailAttemptedAt ? Date.parse(f.PaymentEmailAttemptedAt) : NaN;
  const attemptCount = Number(f.PaymentEmailAttemptCount) || 0;

  const res = await deps.searchActivity(idempotencyKey);
  const activity = classifyActivityResult({ httpStatus: res && res.httpStatus, messages: res && res.messages });
  const providerMessageId = activity === 'hit_one' ? pickMessageId(res.messages) : null;

  const decision = decideReconcile({ activity, attemptedAtMs, attemptCount, now, providerMessageId });

  // ログに recordId / Email / provider 応答本文を出さない（非機密の集計値のみ）。
  if (deps.log) deps.log({ at: 'reconcile', activity, action: decision.action, reason: decision.reason, dryRun });

  if (dryRun || !decision.fields) {
    return { action: decision.action, reason: decision.reason, wouldWrite: decision.fields || null, dryRun: !!dryRun };
  }
  await deps.patchRecord(record.id, decision.fields);
  return { action: decision.action, reason: decision.reason, wrote: decision.fields };
}

/**
 * unknown_after_attempt を一括照合する。
 * @param {object} p
 * @param {number} p.now
 * @param {boolean} p.dryRun
 * @param {object} p.deps  上記 + listUnknownAfterAttempt() -> [{id, fields}]
 * @returns {Promise<{count: number, byAction: Record<string, number>, results: any[]}>}
 */
export async function reconcileUnknownBatch({ now, dryRun = false, maxRecords = 0, deadlineAt = null, clock = Date.now, deps }) {
  const all = (await deps.listUnknownAfterAttempt()) || [];
  // 30 秒上限に安全に収めるため、1 実行の処理件数を制限する（0 以下なら従来どおり全件）。
  const records = Number.isInteger(maxRecords) && maxRecords > 0 ? all.slice(0, maxRecords) : all;
  const results = [];
  const byAction = {};
  const pastDeadline = () => Number.isFinite(deadlineAt) && clock() >= deadlineAt;
  let deadlineStopped = false;
  for (const record of records) {
    // deadline guard: 時間切れ前に新規レコードの照合を開始しない（残りは次回へ）。
    if (pastDeadline()) { deadlineStopped = true; byAction.deadline_skipped = (byAction.deadline_skipped || 0) + 1; continue; }
    const r = await reconcileOne({ record, now, dryRun, deps });
    results.push({ id: record.id, ...r });
    byAction[r.action] = (byAction[r.action] || 0) + 1;
  }
  return { count: records.length, listed: all.length, deadlineStopped, byAction, results };
}
