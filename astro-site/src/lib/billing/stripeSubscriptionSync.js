/**
 * stripeSubscriptionSync.js — Stripe の購読状態 → Customers に書くフィールド（純粋・I/O なし）
 *
 * Webhook（stripe-webhook.js）と決済完了画面（stripe-checkout-complete.js）は
 * **同じこの判定**を通す。どちらが先に来ても、何回来ても同じ結果になる（絶対値で書く）。
 *
 * ## 権限の持ち方（既存の判定をそのまま使う）
 *
 * AK の閲覧権は `プラン` + `有効期限` で決まる（resolveEntitlements）。Stripe 会員も同じ形で書く:
 *
 *   プラン=Premium / PlanType=Monthly / Status=active / PaymentMethod=Stripe
 *   有効期限 = 今の請求期間の終わり（JST 暦日）+ 猶予 2 日
 *   VenueAccess = '' （両会場）| 'jra' | 'nankan'
 *
 * 毎月の請求が成功すると期間が延び、`有効期限` も延びる。
 * 請求が止まれば（解約・カード失敗）**何も書かなくても**期限で自然に閲覧できなくなる（fail closed）。
 *
 * ## 期限の根拠は「支払い済みの請求書」だけ
 *
 * - 期限は購読の `current_period_end` ではなく、**支払い済み請求書の期間の終わり（paidThrough）**から作る。
 *   `current_period_end` は更新日に**支払い前から**次の期間へ進むので、それで延ばすと
 *   カード決済が失敗しても 1 か月見られてしまう（実装初版の誤り）。
 * - 会員の退会以外の終了（決済失敗の再試行切れ・管理者が Stripe 画面で解約）は、期限を paidThrough の終わりまで残す。
 *
 * ## 退会（2026-10-07 MK 確定・期間末解約は廃止）
 *
 * - 会員の退会は**即時**。退会確定の時点で有料権限を止め、残り期間は使えない。予約停止・解約取消は無い。
 * - 退会は `stripeWithdrawal.js` が「購読の即時解約 → 退会フラグ + 期限を過去へ」を 1 回で行う。
 *   購読には `cancellation_details.comment = ak_member_withdrawal` を付けるので、Customers への書込みが
 *   失敗しても、後から届く終了イベント（ここ）が**同じ退会状態**へ収束させる（withdrawalFields）。
 * - 再利用は新規契約。新しい購読の反映（!owned）が退会フラグを戻す。
 *
 * ## 書かない（conflict）ケース — 二重課金・権利の縮小を起こさない
 *
 * | reason | 状況 | 理由 |
 * |---|---|---|
 * | `duplicate_subscription` | 別の Stripe 購読が生きている | 2 本目で 1 本目の ID を上書きすると 1 本目が課金され続け、追跡できなくなる |
 * | `existing_lifetime` | Premium 買い切り会員 | 書くと買い切りが月額（期限あり）に化ける |
 * | `existing_longer_contract` | 銀行振込の Premium が今回の期限より長く残っている | 書くと残り期間を失う／会場限定に縮む |
 *
 * conflict は管理者へ通知して手で返金・解約する（自動返金はしない）。
 */

import { planFromPriceId, venueAccessValue } from './stripePlans.js';
import { jstDateString } from '../payments/bankPaymentFlow.js';
import { normalizePlan } from '../auth/planNormalization.js';

/** 請求期間の終わりから閲覧を続ける猶予（カード再試行・Webhook 遅延の吸収） */
export const STRIPE_GRACE_MS = 2 * 24 * 60 * 60 * 1000;

/** 会員の退会で解約した購読の印（`cancellation_details.comment`）。stripeWithdrawal.js が付ける */
export const MEMBER_WITHDRAWAL_COMMENT = 'ak_member_withdrawal';

/** 権限を付ける状態 */
const LIVE_STATUSES = new Set(['active', 'trialing']);
/** 終わった状態（閲覧を止める） */
const ENDED_STATUSES = new Set(['canceled', 'unpaid', 'incomplete_expired']);

/**
 * Stripe の月額で契約している会員か（退会はマイページの「退会する」＝stripe-withdraw で購読ごと止める対象）。
 * メールアドレスだけで呼べる process-withdrawal からは、購読を操作しない。
 */
export function isStripeSubscriber(fields) {
  const f = fields || {};
  return String(f.PaymentMethod || '').trim().toLowerCase() === 'stripe'
    && /^sub_/.test(String(f.StripeSubscriptionId || ''));
}

/** Stripe の Subscription オブジェクトを、判定に要る値だけへ正規化する */
export function snapshotSubscription(sub) {
  const s = sub || {};
  const item = s.items?.data?.[0] || {};
  const customer = typeof s.customer === 'string' ? s.customer : (s.customer?.id || '');
  // API 2025-03 以降は請求期間が item 側にある。旧形も読む。
  const periodEnd = Number(item.current_period_end ?? s.current_period_end) || null;
  return {
    id: String(s.id || ''),
    status: String(s.status || ''),
    customerId: String(customer || ''),
    priceId: String(item.price?.id || item.plan?.id || ''),
    currentPeriodEnd: periodEnd,
    endedAt: Number(s.ended_at) || null,
    cancelAtPeriodEnd: s.cancel_at_period_end === true,
    // 会員の退会で解約した購読か（Customers への書込みが失敗しても終了イベントで退会状態へ収束させる）
    memberWithdrawal: String(s.cancellation_details?.comment || '') === MEMBER_WITHDRAWAL_COMMENT,
    metadata: s.metadata || {},
  };
}

const isTruthy = (v) => v === true || v === 1 || /^(true|1|yes)$/i.test(String(v ?? '').trim());

/**
 * 退会の状態（即時に有料権限を止める）。退会 API と終了イベントの**単一源**。
 *
 * - `WithdrawalRequested=true` … resolveMembership / resolveEntitlements がその場で無料扱いにする
 * - `有効期限` … **昨日（JST）へ縮める**（延ばさない）。'YYYY-MM-DD' は当日 00:00 UTC（09:00 JST）に切れるため、
 *   今日の日付ではその朝 9 時まで見られてしまう。残り期間は使えない（2026-10-07 MK 確定）
 * - 既に退会済みなら理由・日付は書き換えない（二重処理でも同じ結果）
 */
export function withdrawalFields({ fields = {}, now = new Date(), reason = null } = {}) {
  const yesterday = jstDateString(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const current = String(fields['有効期限'] || '').trim();
  const out = {
    '有効期限': current && current < yesterday ? current : yesterday,
    CancelledAt: now.toISOString(),
  };
  if (!isTruthy(fields.WithdrawalRequested)) {
    out.WithdrawalRequested = true;
    out.WithdrawalDate = jstDateString(now);
    out.WithdrawalReason = reason ? String(reason).slice(0, 500) : '理由未記入';
  }
  return out;
}

/** 支払い済み期間の終わり（unix 秒）→ 有効中の `有効期限`（JST 暦日 + 猶予 2 日。更新時の決済待ちを吸収）*/
export function expirationFromPeriodEnd(periodEndSec) {
  if (!Number.isFinite(periodEndSec) || periodEndSec <= 0) return null;
  return jstDateString(new Date(periodEndSec * 1000 + STRIPE_GRACE_MS));
}

/**
 * 終了後の `有効期限`: 支払い済み期間の終わりまで見られる最小の暦日。
 * `有効期限` 'YYYY-MM-DD' は resolveEntitlements で「その日の 00:00 UTC（= 09:00 JST）」に切れるので、
 * 支払い済みの終わりより前に切れないよう **翌暦日**にする（短く切るより 1 日未満長い方を選ぶ）。
 */
export function expirationAfterEnd(paidThroughSec) {
  if (!Number.isFinite(paidThroughSec) || paidThroughSec <= 0) return null;
  return jstDateString(new Date(paidThroughSec * 1000 + 24 * 60 * 60 * 1000));
}

/**
 * 支払い済みの請求書 → 支払い済み期間の終わり（unix 秒）。無ければ null（＝まだ 1 円も払われていない）。
 * 請求書の明細ごとの期間（period.end）の最大値。日割りの差額請求書も同じ期間末を持つ。
 */
export function paidThroughFromInvoices(invoices) {
  let max = null;
  for (const inv of invoices || []) {
    if (!inv || inv.status !== 'paid') continue;
    for (const line of inv.lines?.data || []) {
      const end = Number(line?.period?.end);
      if (Number.isFinite(end) && (max === null || end > max)) max = end;
    }
  }
  return max;
}

const blank = (v) => v === undefined || v === null || String(v).trim() === '';

/** 'YYYY-MM-DD' を JST のその日の終わりとして比べる（premiumConversion と同じ解釈） */
function endOfJstDayMs(ymd) {
  if (blank(ymd)) return null;
  const s = String(ymd).trim();
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T23:59:59+09:00`) : Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * @param {{
 *   fields: object,                 Customers の現在の fields（無ければ {}＝新規作成）
 *   sub: object,                    snapshotSubscription の戻り値
 *   env: object,                    Price ID の対応表（STRIPE_PRICE_*）
 *   now: Date,
 *   otherSubscriptionLive?: boolean 記録済みの別購読がまだ生きているか（呼び出し側が Stripe で確認）
 *   paidThrough?: number|null       支払い済み期間の終わり（unix 秒・paidThroughFromInvoices）
 * }} input
 * @returns {{ action: 'write'|'skip'|'conflict', reason: string, fields?: object, plan?: object, newlyAttached?: boolean, expiration?: string }}
 */
export function decideSubscriptionSync({ fields = {}, sub, env = {}, now = new Date(), otherSubscriptionLive = false, paidThrough = null }) {
  if (!sub || !sub.id) return { action: 'skip', reason: 'no_subscription' };
  const f = fields || {};
  const owned = String(f.StripeSubscriptionId || '') === sub.id;

  // ── 終了 ────────────────────────────────────────────────
  if (ENDED_STATUSES.has(sub.status)) {
    if (!owned) return { action: 'skip', reason: 'ended_not_owned' };
    // 会員の退会（退会 API が付けた印・または退会フラグ済み）→ 即時失効の退会状態（withdrawalFields）
    if (sub.memberWithdrawal === true || isTruthy(f.WithdrawalRequested)) {
      const w = withdrawalFields({ fields: f, now });
      return { action: 'write', reason: 'withdrawn', expiration: w['有効期限'], fields: w };
    }
    // 退会以外の終了（決済失敗・管理者の解約）: 支払い済み期間の終わりまでは見られる。1 円も払われていなければ今日で終わり。
    const endYmd = expirationAfterEnd(paidThrough) || jstDateString(now);
    const current = String(f['有効期限'] || '').trim();
    // 期限は**縮めるだけ**（延ばさない）。猶予 2 日の分だけ縮み、支払い済みの分は残る。
    const expiration = current && current < endYmd ? current : endYmd;
    return {
      action: 'write',
      reason: 'ended',
      expiration,
      fields: { '有効期限': expiration, CancelledAt: now.toISOString() },
    };
  }

  if (!LIVE_STATUSES.has(sub.status)) return { action: 'skip', reason: `status_${sub.status || 'unknown'}` };

  // ── 有効 ────────────────────────────────────────────────
  const plan = planFromPriceId(sub.priceId, env);
  if (!plan) return { action: 'conflict', reason: 'unknown_price' };
  // 期限は**支払い済み**の期間から。未払い（初回決済の処理中など）は書かない（払われてから反映）。
  if (!Number.isFinite(paidThrough)) return { action: 'skip', reason: 'awaiting_payment' };
  const expiration = expirationFromPeriodEnd(paidThrough);
  if (!expiration) return { action: 'conflict', reason: 'no_period_end' };

  if (!owned) {
    if (!blank(f.StripeSubscriptionId) && otherSubscriptionLive) {
      return { action: 'conflict', reason: 'duplicate_subscription', plan };
    }
    const tier = normalizePlan(String(f['プラン'] || '')) || 'free';
    const isPremiumTier = tier === 'premium' || tier === 'premium-predictions'
      || tier === 'premium-sanrenpuku' || tier === 'premium-combo';
    const planType = String(f.PlanType || '').trim().toLowerCase();
    const status = String(f.Status || '').trim().toLowerCase();
    if (isPremiumTier && planType === 'lifetime' && status === 'active') {
      return { action: 'conflict', reason: 'existing_lifetime', plan };
    }
    const currentEnd = endOfJstDayMs(f['有効期限']);
    const newEnd = endOfJstDayMs(expiration);
    const existingFullVenue = blank(f.VenueAccess);
    if (isPremiumTier && status === 'active' && existingFullVenue
      && currentEnd !== null && newEnd !== null && currentEnd > newEnd) {
      return { action: 'conflict', reason: 'existing_longer_contract', plan };
    }
  }

  const out = {
    'プラン': 'Premium',
    PlanType: 'Monthly',
    Status: 'active',
    '有効期限': expiration,
    VenueAccess: venueAccessValue(plan),
    PaymentMethod: 'Stripe',
    StripeCustomerId: sub.customerId,
    StripeSubscriptionId: sub.id,
  };
  if (!owned) {
    // 新しく契約した時点 = 有料化の確定時刻（銀行振込の PaidAt と同じ意味）
    out.PaidAt = now.toISOString();
    out.CancelledAt = null;
    // 新規購入で退会フラグを戻す（銀行振込の入金確認と同じ扱い）
    out.WithdrawalRequested = false;
    out.WithdrawalDate = null;
    out.WithdrawalReason = null;
  }
  return { action: 'write', reason: owned ? 'renewed' : 'attached', fields: out, plan, newlyAttached: !owned, expiration };
}
