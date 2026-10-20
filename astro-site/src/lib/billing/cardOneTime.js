/**
 * cardOneTime.js — カード決済（決済会社共通）の「一回払い」商品と、会員への反映の**単一源**（純粋・I/O なし）
 *
 * 2026-10-11 MK 確定: 代替決済は Paddle（第一）・PayPal（予備）。（fincode は 2026-10-15 MK 決定で不使用・削除）
 * 売るのは銀行振込と同じ商品（Premium 年払い・買い切り）だけ。**新規の月払いは扱わない**（MONTHLY_SALES_OPEN）。
 * 金額・商品権利・販売条件は銀行振込と同じ（年払い ¥49,800／Light 会員 ¥44,820・買い切り ¥78,000）。
 *
 * ## 守ること
 * - 金額はサーバーのこの表だけが決める（クライアントの言い値を使わない）。
 * - 会員限定価格（Light 会員 ¥44,820）は申込前にサーバーで資格を判定する（checkMemberOnlyPricing と同じ根拠）。
 * - **二重課金を作らない**: 買い切り会員・生きている Stripe 月額の会員には申込させない（409 相当）。
 * - **二重昇格・期限誤更新を作らない**:
 *     - 反映は決済 ID ごとに 1 回（呼び出し側が冪等キーを持つ）。ここは同じ入力に同じ出力を返す。
 *     - 有効期限は**延ばすだけ**。Premium の残りがある人の年払いは、残りの期限の翌日から 1 年（残り日数を失わせない）。
 *     - 買い切り会員への反映は書かない（conflict・管理者へ返金判断を通知）。
 * - 決済会社に送る商品名は paymentDisplayNames の禁止語ルールを通る名前だけ。
 */

import { assertPaymentDisplayName } from './paymentDisplayNames.js';
import { MONTHLY_SALES_OPEN } from './stripePlans.js';
import { addOneYearJst, jstDateString, LIFETIME_EXPIRATION } from '../payments/bankPaymentFlow.js';
import { normalizePlan } from '../auth/planNormalization.js';
import { checkMemberOnlyPricing } from '../pricing/pricingEligibility.js';

export const CARD_PRODUCTS = Object.freeze([
  Object.freeze({
    id: 'premium-annual',
    planName: 'Premium',
    planType: 'Annual',
    amountYen: 49800,
    displayName: 'Analytics Premium 年払い',
    // 会員限定価格の判定に使う申込名（銀行振込と同じ語彙）
    bankProductName: 'Premium Annual',
  }),
  Object.freeze({
    id: 'premium-annual-light',
    planName: 'Premium',
    planType: 'Annual',
    amountYen: 44820,
    displayName: 'Analytics Premium 年払い（Light会員特典）',
    bankProductName: 'Premium Annual - Campaign',
    memberOnly: true,
  }),
  Object.freeze({
    id: 'premium-lifetime',
    planName: 'Premium',
    planType: 'Lifetime',
    amountYen: 78000,
    displayName: 'Analytics Premium 買い切り',
    bankProductName: 'Premium Lifetime',
  }),
]);

// 決済会社へ出す名前は禁止語ルールを必ず通す（読み込み時に検査＝混入したら起動しない）
for (const p of CARD_PRODUCTS) assertPaymentDisplayName(p.displayName, `card product ${p.id}`);

export function cardProductById(id) {
  return CARD_PRODUCTS.find((p) => p.id === String(id || '')) || null;
}

/** 金額から商品を引く（Webhook の金額照合用。同額の商品は無い前提をテストで固定） */
export function cardProductByAmount(amountYen) {
  return CARD_PRODUCTS.find((p) => p.amountYen === Number(amountYen)) || null;
}

const isLifetimePremium = (f = {}) => normalizePlan(f['プラン']) === 'premium'
  && String(f.PlanType || '').trim().toLowerCase() === 'lifetime';

const isPremium = (f = {}) => normalizePlan(f['プラン']) === 'premium';

/** 有効期限（YYYY-MM-DD）が JST の今日以降か */
function expiryOnOrAfterToday(expiry, now) {
  const e = String(expiry || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(e) && e >= jstDateString(now);
}

/** 生きている Stripe 月額があるか（申込で二重課金になる） */
function hasLiveStripeMonthly(f = {}, now) {
  return Boolean(String(f.StripeSubscriptionId || '').trim())
    && String(f.PaymentMethod || '').trim().toLowerCase() === 'stripe'
    && String(f.Status || '').trim().toLowerCase() === 'active'
    && expiryOnOrAfterToday(f['有効期限'], now);
}

/**
 * 申込（決済の作成）前の判定。ここで止めれば決済会社に何も作らない。
 * @returns {{ ok: true, product } | { ok: false, code: string }}
 */
export function decideCardPurchase({ productId, fields = null, now = new Date() } = {}) {
  const product = cardProductById(productId);
  if (!product) return { ok: false, code: 'invalid_product' };
  // 2026-10-20 MK 決定: 買い切りは銀行振込だけ。カード（Paddle・PayPal）では申込を作らない（fail closed）
  if (product.planType === 'Lifetime') return { ok: false, code: 'lifetime_bank_transfer_only' };
  if (product.planType === 'Monthly' && !MONTHLY_SALES_OPEN) return { ok: false, code: 'monthly_sales_ended' };
  if (fields && isLifetimePremium(fields)) return { ok: false, code: 'already_lifetime' };
  if (fields && hasLiveStripeMonthly(fields, now)) return { ok: false, code: 'stripe_subscription_active' };
  if (product.memberOnly) {
    const c = checkMemberOnlyPricing({ productName: product.bankProductName, fields, nowMs: now.getTime() });
    if (!c.eligible) return { ok: false, code: 'not_eligible' };
  }
  return { ok: true, product };
}

/**
 * 決済成功（決済会社のサーバー通知・照会で確認済み）→ Customers に書く値。
 * 呼び出し側の前提: 決済 ID ごとの冪等（同じ決済で 2 回呼ばない）・会員単位の排他・金額と商品の照合済み。
 *
 * @param {{ productId: string, fields: object, paidAt: Date, provider: string }} input
 * @returns {{ action: 'grant', fields: object, expiration: string }
 *          | { action: 'conflict', reason: string }
 *          | { action: 'invalid', reason: string }}
 */
export function decideCardGrant({ productId, fields = {}, paidAt, provider } = {}) {
  const product = cardProductById(productId);
  if (!product) return { action: 'invalid', reason: 'invalid_product' };
  if (!(paidAt instanceof Date) || Number.isNaN(paidAt.getTime())) return { action: 'invalid', reason: 'invalid_paid_at' };
  if (!/^[a-z]+$/.test(String(provider || ''))) return { action: 'invalid', reason: 'invalid_provider' };
  // 買い切りは銀行振込だけ（2026-10-20 MK 決定）。カードで成立してしまっても権限は書かず管理者へ（返金判断）
  if (product.planType === 'Lifetime') return { action: 'conflict', reason: 'lifetime_bank_transfer_only' };
  // 買い切り会員は既に最上位。権限は変えず、返金判断を管理者へ（二重課金の後始末）
  if (isLifetimePremium(fields)) return { action: 'conflict', reason: 'existing_lifetime' };

  let expiration;
  if (product.planType === 'Lifetime') {
    expiration = LIFETIME_EXPIRATION;
  } else {
    // Premium の残りがあるなら、その翌日から 1 年（残り日数を失わせない・縮めない）
    const cur = String(fields['有効期限'] || '').slice(0, 10);
    const base = isPremium(fields) && expiryOnOrAfterToday(cur, paidAt)
      ? new Date(`${cur}T12:00:00+09:00`)
      : paidAt;
    expiration = addOneYearJst(base);
  }

  return {
    action: 'grant',
    expiration,
    fields: {
      'プラン': product.planName,
      'PlanType': product.planType,
      'Status': 'active',
      '有効期限': expiration,
      'PaidAt': paidAt.toISOString(),
      'PaymentMethod': provider,
      // 銀行振込と同じく Premium は両会場（Stripe 会場版からの移行で会場限定を残さない）
      'VenueAccess': '',
      // 新規購入で退会フラグを戻す（銀行振込の承認時と同じ）
      'WithdrawalRequested': false,
      'WithdrawalDate': null,
      'WithdrawalReason': null,
    },
  };
}
