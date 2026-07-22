/**
 * paymentEmailWebhook.js — S9 本体。SendGrid Event Webhook の配信結果を
 * Payment Email v2 の状態（`PaymentEmailStatus`）へ反映するコア（依存注入・IO は deps 経由）。
 *
 * 設計の全体像は `astro-site/docs/PAYMENT_EMAIL_V2.md` / `SENDGRID_WEBHOOK.md`。
 *
 * ## 前提
 * - 呼び出し元（`netlify/functions/sendgrid-webhook.js`）で**署名検証済み**のイベントだけを渡す。
 *   ここでは署名を再検証しない（検証の単一源は `src/lib/webhooks/sendgridSignature.js`）。
 * - worker は送信時に `custom_args: { record_id, idempotency_key, purpose: 'payment_confirmation_v2' }`
 *   を載せている。SendGrid はこれを各イベントの**トップレベル項目**として返す。
 *
 * ## 安全側の約束（fail closed）
 * 1. `purpose` が一致しないイベントは**対象外**（メルマガ等の bounce は従来どおり suppression 側だけが扱う）。
 * 2. `record_id` / `idempotency_key` が欠けていたら**何もしない**。
 * 3. レコードの `PaymentEmailIdempotencyKey` と**完全一致**しなければ**書かない**
 *    （再送で採番し直された後に古いイベントが届いても、過去の送信結果で上書きしない）。
 * 4. 状態遷移の可否は `decideWebhookTransition`（純粋関数）だけが決める。ここに判定を再実装しない。
 * 5. **PII / 識別子をログへ出さない**（recordId・メールアドレス・キーを出さない。件数と reason のみ）。
 */

import { decideWebhookTransition } from './paymentEmailState.js';

/** worker が custom_args に載せる目的識別子（送信側と同一文字列であること）。 */
export const PAYMENT_EMAIL_PURPOSE = 'payment_confirmation_v2';

/**
 * このイベントが Payment Email v2 の配信結果か。
 * @param {Record<string, unknown>} event
 */
export function isPaymentEmailEvent(event) {
  if (!event || typeof event !== 'object') return false;
  return event.purpose === PAYMENT_EMAIL_PURPOSE;
}

/**
 * 1 イベントを反映する。
 *
 * @param {object} p
 * @param {Record<string, any>} p.event 署名検証済みのイベント
 * @param {number} p.now ms epoch
 * @param {object} p.deps `getRecord(recordId)` / `patchRecord(recordId, fields)`（本番 Customers）
 * @returns {Promise<{applied: boolean, reason: string, status?: string}>}
 */
export async function applyPaymentEmailEvent({ event, now, deps }) {
  if (!isPaymentEmailEvent(event)) return { applied: false, reason: 'not_payment_email' };

  const recordId = typeof event.record_id === 'string' ? event.record_id.trim() : '';
  const idempotencyKey = typeof event.idempotency_key === 'string' ? event.idempotency_key.trim() : '';
  if (!recordId || !idempotencyKey) return { applied: false, reason: 'missing_identifiers' };

  const rec = await deps.getRecord(recordId);
  if (!rec) return { applied: false, reason: 'record_not_found' };
  const fields = rec.fields || rec;

  // 冪等キー不一致は「別の送信試行の結果」なので触らない（fail closed）。
  const recordKey = typeof fields.PaymentEmailIdempotencyKey === 'string'
    ? fields.PaymentEmailIdempotencyKey.trim()
    : '';
  if (!recordKey || recordKey !== idempotencyKey) {
    return { applied: false, reason: 'idempotency_key_mismatch' };
  }

  const decision = decideWebhookTransition({
    currentStatus: fields.PaymentEmailStatus,
    event: event.event,
    now,
  });
  if (!decision.apply) return { applied: false, reason: decision.reason };

  await deps.patchRecord(recordId, decision.fields);
  return { applied: true, reason: decision.reason, status: decision.status };
}

/**
 * イベント配列をまとめて反映する。**1 件の失敗で残件を止めない。**
 * 戻り値は件数と reason の集計のみ（識別子を含めない）。
 *
 * @returns {Promise<{targeted: number, applied: number, skipped: number, errors: number, byReason: Record<string, number>}>}
 */
export async function applyPaymentEmailEvents({ events, now, deps }) {
  const summary = { targeted: 0, applied: 0, skipped: 0, errors: 0, byReason: {} };
  if (!Array.isArray(events)) return summary;

  for (const event of events) {
    if (!isPaymentEmailEvent(event)) continue;
    summary.targeted += 1;
    try {
      const r = await applyPaymentEmailEvent({ event, now, deps });
      summary.byReason[r.reason] = (summary.byReason[r.reason] || 0) + 1;
      if (r.applied) summary.applied += 1;
      else summary.skipped += 1;
    } catch {
      // 例外本文は握りつぶす（Airtable 応答本文・レコード値をログへ出さない）
      summary.errors += 1;
      summary.byReason.error = (summary.byReason.error || 0) + 1;
    }
  }
  return summary;
}
