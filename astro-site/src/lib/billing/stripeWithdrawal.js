/**
 * stripeWithdrawal.js — Stripe 月額会員の退会（即時退会・2026-10-07 MK 確定）
 *
 * ## 仕様（正本 docs/spec.md「退会（Stripe 月額）」・decisions.md 2026-10-07）
 *
 * - 退会は**即時**。確定した時点で有料権限を止める。現在の利用期限が未来でも、残り期間は使えない。
 * - 期間末解約・予約停止・次回更新から停止・解約取消は**提供しない**。再利用は新規契約。
 * - Stripe カスタマーポータルの解約機能は使わない（ポータルはカード変更・請求書・プラン変更だけ）。
 *
 * ## 単一の状態遷移（Stripe / Customers / サイト権限を食い違わせない）
 *
 *   1. 本人確認 … ak_session のレコード。メールアドレスだけでは呼べない（process-withdrawal とは別）
 *   2. 購読ごとの排他ロック（applySubscription と同じ鍵）の中で、**最新の**レコードを読み直す
 *        → 退会済みなら 409 already_withdrawn（二重クリック・二重送信は 2 回目がここで止まる）
 *   3. 本人の購読か … レコードの StripeSubscriptionId / StripeCustomerId と Stripe の購読が一致すること
 *   4. Stripe の購読を**即時解約**（日割り・返金なし・idempotency key 付き）。
 *      `cancellation_details.comment = ak_member_withdrawal` を付ける
 *   5. Customers へ退会状態（withdrawalFields: 退会フラグ + 期限を昨日へ）を書く
 *
 * 4 が失敗したら何も書かない（Stripe も Customers も契約中のまま＝食い違わない）。
 * 4 が成功して 5 が失敗したら、Stripe の終了イベント（customer.subscription.deleted）が
 * 印（4 の comment）を見て**同じ退会状態**を書く（stripeSubscriptionSync の ended 分岐）。
 *
 * ⚠️ 秘密鍵・メールアドレス・レコード内容をログに出さない。
 */

import {
  snapshotSubscription, isStripeSubscriber, withdrawalFields, MEMBER_WITHDRAWAL_COMMENT,
} from './stripeSubscriptionSync.js';
import { airtable, withSubscriptionLock } from './stripeServer.js';

/** 退会の結果（HTTP 応答へ写す）。 */
export const WITHDRAWAL_RESULT = Object.freeze({
  WITHDRAWN: 'withdrawn',                       // 200 退会した
  ALREADY_WITHDRAWN: 'already_withdrawn',       // 409 既に退会済み（二重退会）
  NOT_STRIPE_SUBSCRIBER: 'not_stripe_subscriber', // 404 Stripe の月額契約が無い
  SUBSCRIPTION_MISMATCH: 'subscription_mismatch', // 409 本人の購読と一致しない（操作しない）
  RECORD_NOT_FOUND: 'record_not_found',         // 404
  STRIPE_CANCEL_FAILED: 'stripe_cancel_failed', // 502 何も変えていない
  RECORD_WRITE_FAILED: 'record_write_failed',   // 502 Stripe は解約済み・終了イベントが退会状態へ収束させる
  BUSY: 'busy',                                 // 503 同じ購読を処理中
});

/** 解約されていない（＝退会で止める）購読の状態。Stripe 側で既に終わっていれば解約は呼ばない */
const CANCELLABLE = new Set(['active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused']);

const isTruthy = (v) => v === true || v === 1 || /^(true|1|yes)$/i.test(String(v ?? '').trim());

/**
 * 退会してよいか（純粋）。
 * @param {{ fields: object, sub: object|null }} input  sub は snapshotSubscription の戻り値
 * @returns {{ ok: boolean, reason: string, cancelStripe?: boolean }}
 */
export function decideWithdrawal({ fields = {}, sub = null } = {}) {
  const f = fields || {};
  if (isTruthy(f.WithdrawalRequested)) return { ok: false, reason: WITHDRAWAL_RESULT.ALREADY_WITHDRAWN };
  if (!isStripeSubscriber(f)) return { ok: false, reason: WITHDRAWAL_RESULT.NOT_STRIPE_SUBSCRIBER };
  if (!sub || !sub.id || sub.id !== String(f.StripeSubscriptionId)) {
    return { ok: false, reason: WITHDRAWAL_RESULT.SUBSCRIPTION_MISMATCH };
  }
  const recordCustomer = String(f.StripeCustomerId || '');
  if (recordCustomer && sub.customerId !== recordCustomer) {
    return { ok: false, reason: WITHDRAWAL_RESULT.SUBSCRIPTION_MISMATCH };
  }
  // Stripe 側で既に終わっている（管理者の解約・再試行切れ）なら、Customers だけ退会状態にする
  return { ok: true, reason: 'withdraw', cancelStripe: CANCELLABLE.has(sub.status) };
}

/**
 * 退会を実行する（I/O）。
 *
 * @param {{
 *   stripe: object, env: object, recordId: string, reason?: string|null,
 *   now?: Date, fetchImpl?: Function, redis?: Function|null,
 * }} input
 * @returns {Promise<{ ok: boolean, result: string, fields?: object, email?: string, cancelled?: boolean }>}
 */
export async function withdrawStripeSubscriber({ stripe, env, recordId, reason = null, now = new Date(), fetchImpl, redis = null }) {
  if (!recordId) return { ok: false, result: WITHDRAWAL_RESULT.RECORD_NOT_FOUND };
  const at = airtable(env, fetchImpl);

  const first = await getRecord(at, recordId);
  if (!first) return { ok: false, result: WITHDRAWAL_RESULT.RECORD_NOT_FOUND };
  // ロックの前に弾けるものは弾く（ロック鍵＝購読 ID が要るため）
  const pre = decideWithdrawal({ fields: first.fields, sub: { id: String(first.fields?.StripeSubscriptionId || ''), customerId: String(first.fields?.StripeCustomerId || '') } });
  if (!pre.ok && pre.reason !== WITHDRAWAL_RESULT.SUBSCRIPTION_MISMATCH) return { ok: false, result: pre.reason };
  const subId = String(first.fields.StripeSubscriptionId);

  const locked = await withSubscriptionLock(redis, subId, async () => {
    // ロックの中で読み直す（二重クリックの 2 本目はここで退会済みを見る）
    const record = await getRecord(at, recordId);
    if (!record) return { ok: false, result: WITHDRAWAL_RESULT.RECORD_NOT_FOUND };
    const fields = record.fields || {};

    let sub = null;
    try {
      sub = snapshotSubscription(await stripe.subscriptions.retrieve(subId));
    } catch {
      return { ok: false, result: WITHDRAWAL_RESULT.SUBSCRIPTION_MISMATCH };
    }
    const decision = decideWithdrawal({ fields, sub });
    if (!decision.ok) return { ok: false, result: decision.reason };

    if (decision.cancelStripe) {
      try {
        await stripe.subscriptions.cancel(
          subId,
          { prorate: false, invoice_now: false, cancellation_details: { comment: MEMBER_WITHDRAWAL_COMMENT } },
          { idempotencyKey: `ak-withdraw-${subId}` },
        );
      } catch {
        // 既に終わっていれば続行、そうでなければ何も書かずに失敗を返す
        let again = null;
        try { again = snapshotSubscription(await stripe.subscriptions.retrieve(subId)); } catch { again = null; }
        if (!again || CANCELLABLE.has(again.status)) return { ok: false, result: WITHDRAWAL_RESULT.STRIPE_CANCEL_FAILED };
      }
    }

    const out = withdrawalFields({ fields, now, reason });
    try {
      await at.patch(recordId, out);
    } catch {
      return { ok: false, result: WITHDRAWAL_RESULT.RECORD_WRITE_FAILED, cancelled: decision.cancelStripe };
    }
    return {
      ok: true,
      result: WITHDRAWAL_RESULT.WITHDRAWN,
      fields: out,
      email: String(fields.Email || ''),
      cancelled: decision.cancelStripe,
    };
  });
  if (locked && locked.action === 'busy') return { ok: false, result: WITHDRAWAL_RESULT.BUSY };
  return locked;
}

async function getRecord(at, recordId) {
  try {
    return await at.get(recordId);
  } catch (e) {
    if (/airtable_404/.test(String(e?.message || ''))) return null;
    throw e;
  }
}
