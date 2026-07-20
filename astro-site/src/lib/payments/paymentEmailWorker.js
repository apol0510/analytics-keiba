/**
 * paymentEmailWorker.js — 入金確認メール送信 worker のコア（依存注入）。
 *
 * 実 IO（Airtable / SendGrid / Redis）は deps 経由で注入する。ユニットテストは
 * fake を渡すため実接続しない。Netlify Function（netlify/functions/payment-email-worker.js）は
 * 実クライアントを配線する薄いラッパー。
 *
 * 送信手順（docs/PAYMENT_EMAIL_V2.md）:
 *   Redis ロック取得(SET NX + fencing token)
 *   → attempting_pre_send を書く（lease / token / attempt+1）
 *   → **POST 直前に unknown_after_attempt を write-ahead し、read-back で token 一致を確認**
 *   → SendGrid POST（custom_args: record_id, idempotency_key）
 *   → 2xx=accepted / 429・5xx=failed_retryable / 4xx=failed_terminal を書く
 *   → ロック解放
 *
 * exactly-once は保証しない。ロック + fencing token は二重送信確率を下げるだけ。
 */

import {
  decideLeaseAcquire, buildWriteAheadFields, evaluateMailOutcome, decideAfterProvider,
} from './paymentEmailState.js';

/**
 * @param {object} p
 * @param {string} p.recordId
 * @param {number} p.now ms epoch
 * @param {object} p.deps 注入する依存
 *   - getRecord(recordId) -> {id, fields} | null
 *   - patchRecord(recordId, fields) -> any
 *   - acquireLock(key) -> {ok: boolean, token: string|number}
 *   - releaseLock(key, token) -> any
 *   - sendMail({to, recordId, idempotencyKey}) -> {status?: number, messageId?: string, threw?: boolean, error?: string}
 *   - hasApiKey?: boolean（省略時 true）
 *   - log?(obj)
 * @returns {Promise<{ok: boolean, stage?: string, reason?: string, status?: string, providerAccepted?: boolean}>}
 */
export async function runWorkerOnce({ recordId, now, deps }) {
  const rec = await deps.getRecord(recordId);
  if (!rec) return { ok: false, stage: 'get', reason: 'record_not_found' };
  const f = rec.fields || rec;

  const status = f.PaymentEmailStatus;
  const idempotencyKey = f.PaymentEmailIdempotencyKey || '';
  const email = f.Email || '';
  const attemptCount = Number(f.PaymentEmailAttemptCount) || 0;
  const leaseUntilMs = f.PaymentEmailLeaseUntil ? Date.parse(f.PaymentEmailLeaseUntil) : null;

  const lockKey = `payemail:${recordId}`;
  const lock = await deps.acquireLock(lockKey);
  if (!lock || !lock.ok) return { ok: false, stage: 'lock', reason: 'lock_held' };
  const token = String(lock.token);

  try {
    // 1. lease 取得可否（fencing token を Airtable に載せる）
    const lease = decideLeaseAcquire({ status, attemptCount, leaseUntilMs, now, token });
    if (!lease.granted) return { ok: false, stage: 'lease', reason: lease.reason };
    await deps.patchRecord(recordId, lease.fields);

    // 2. write-ahead（POST 前に unknown_after_attempt）→ read-back で fencing 確認
    await deps.patchRecord(recordId, buildWriteAheadFields());
    const after = await deps.getRecord(recordId);
    const aff = (after && (after.fields || after)) || {};
    if (String(aff.PaymentEmailAttemptToken) !== token) {
      // 他者が奪った可能性 → 送らない（二重送信を避ける・fail closed）
      return { ok: false, stage: 'fencing', reason: 'token_superseded' };
    }

    // 3. 送信（api key / email 欠如 / 送信元不一致は試行せず terminal）
    //    送信元は AK 正式値（support@keiba.link）のときだけ許可する。カナリアも通常 worker も
    //    同じ契約（senderIdentity.js）を deps 経由で受け取る。noreply への fallback は無い。
    const hasApiKey = deps.hasApiKey !== false;
    const hasEmail = !!email;
    const senderVerified = deps.hasVerifiedSender !== false;
    let mail = {};
    if (hasApiKey && hasEmail && senderVerified) {
      mail = await deps.sendMail({ to: email, recordId, idempotencyKey });
    }
    const outcome = evaluateMailOutcome({
      hasApiKey, hasEmail, hasVerifiedSender: senderVerified,
      providerStatus: mail && mail.status, threw: !!(mail && mail.threw),
    });
    const decision = decideAfterProvider({
      outcome, now,
      providerMessageId: (mail && mail.messageId) || null,
      lastError: (mail && mail.error) || null,
    });
    await deps.patchRecord(recordId, decision.fields);

    if (deps.log) deps.log({ at: 'worker', recordId, status: decision.status, providerAccepted: outcome.providerAccepted, failureStage: outcome.failureStage });
    return { ok: true, status: decision.status, providerAccepted: outcome.providerAccepted };
  } finally {
    await deps.releaseLock(lockKey, token);
  }
}
