/**
 * subscriptionCampaign.js — Premium 新規カード契約の「特別価格」（純粋・I/O なし・単一源）
 *
 * 2026-11-11 MK 指示（decisions「Premium 新規カード契約の特別価格」）:
 *   | プラン | 通常 | 特別価格（最初の決済 1 回だけ）|
 *   |---|---:|---:|
 *   | Premium 中央＋南関（月額）| ¥4,980 | ¥3,980（1,000円OFF）|
 *   | Premium 中央版（月額）| ¥2,980 | ¥2,480（500円OFF）|
 *   | Premium 南関版（月額）| ¥2,980 | ¥2,480（500円OFF）|
 *   | Premium 年額 | ¥49,800 | ¥44,800（5,000円OFF）|
 *   月額は翌月から、年額は翌年から通常料金で自動更新。既存契約の料金は変えない。
 *
 * ## 仕組み（金額の正本を 1 つに保つ）
 *   - 商品の価格（`SUBSCRIPTION_PLANS.amountYen`）は**変えない**。購読の単価は通常料金のまま作り、
 *     割引は Paddle の取引に付ける**一回限りの値引き**（`discount`・`recur: false`）で表す。
 *     → 反映時の価格検査（amount_mismatch）はそのまま効き、更新は自動で通常料金になる。
 *   - 対象かどうかは本番サイトが会員の記録で決め、中立サイトへは**キャンペーン ID だけ**を渡す（金額は渡さない）。
 *     中立サイトはこの表から値引き額を引き直す（改ざんされた intent で任意の値引きを作れない）。
 *   - 受付はカード（Paddle）の新規定期課金だけ。PayPal は新規受付を閉じているので対象外。
 *     銀行振込（年払い・買い切り）は従来の価格のまま（この特別価格を出さない）。
 *   - Light 会員の乗り換え特典（Premium 年額 ¥44,820・毎年同額）とは**重ねない**（この表に載せない）。
 *
 * ## 対象（新規の定義・2026-11-11）
 *   その会員がこれまでカードの定期課金（Paddle / PayPal / Stripe）を一度も持っていないこと。
 *   一度契約すると Redis の購読の対応（`ak:paddle:sub:member:*` 等）が残るので、2 回目は自動で通常価格になる。
 *   有料会員が二重に契約できないことは既存の判定（409）が担う。
 */

/** 受付中のキャンペーン（閉じるときは open:false にする PR だけ。env では開閉しない）*/
export const SUBSCRIPTION_CAMPAIGN = Object.freeze({
  id: 'special-2026-11',
  open: true,
  /** プラン ID → 値引き額（円）。ここに無いプラン（Light 乗り換え特典など）は対象外 */
  discountYen: Object.freeze({
    premium: 1000,
    'premium-jra': 500,
    'premium-nankan': 500,
    'premium-annual': 5000,
  }),
});

const CAMPAIGN_ID_RE = /^[a-z0-9-]{1,40}$/;

/** キャンペーン ID が「いま受付中のもの」か（中立サイトが intent を受けるときにも使う）*/
export function isActiveCampaignId(id, campaign = SUBSCRIPTION_CAMPAIGN) {
  return campaign.open === true && CAMPAIGN_ID_RE.test(String(id || '')) && id === campaign.id;
}

/** このプランは特別価格の対象か（会員を問わない・表示用）*/
export function campaignDiscountYen(planId, campaign = SUBSCRIPTION_CAMPAIGN) {
  if (campaign.open !== true) return 0;
  const d = campaign.discountYen[String(planId || '')];
  return Number.isInteger(d) && d > 0 ? d : 0;
}

/**
 * 表示用の価格（通常・特別・値引き）。対象外のプランは special=null。
 * 画面はこの戻り値だけを使い、自分で引き算しない（CLAUDE.md「金額は見せた額 = 請求する額」）。
 */
export function campaignPriceFor(plan, campaign = SUBSCRIPTION_CAMPAIGN) {
  if (!plan || !Number.isInteger(plan.amountYen)) return null;
  const off = campaignDiscountYen(plan.id, campaign);
  return {
    planId: plan.id,
    regularYen: plan.amountYen,
    specialYen: off > 0 ? plan.amountYen - off : null,
    discountYen: off,
    interval: plan.interval === 'YEAR' ? 'year' : 'month',
  };
}

/**
 * これまでにカードの定期課金を持ったことがあるか（Airtable の値だけで分かる分）。
 * Stripe の購読 ID は退会後も残る。PaymentMethod はカード決済（Paddle / PayPal / Stripe）で付けた値が残る。
 */
export function hadCardSubscriptionInFields(fields = {}) {
  if (/^sub_/.test(String(fields?.StripeSubscriptionId || '').trim())) return true;
  return /^(paddle|paypal|stripe)$/i.test(String(fields?.PaymentMethod || '').trim());
}

/**
 * この申込に特別価格を付けるか（本番サイトが決める・純粋）。
 * @param {{ planId: string, fields?: object, hadCardSubscription: boolean|null }} p
 *   hadCardSubscription: Redis で過去の Paddle / PayPal 購読の対応が見つかったか。読めなかったら null（→ 付けない）
 * @returns {{ applied: true, campaignId, discountYen, firstYen, regularYen } | { applied: false, reason, regularYen? }}
 */
export function decideCampaignForCheckout({ planId, plan, fields = {}, hadCardSubscription, campaign = SUBSCRIPTION_CAMPAIGN }) {
  const regularYen = plan?.amountYen;
  if (campaign.open !== true) return { applied: false, reason: 'closed', regularYen };
  const off = campaignDiscountYen(planId, campaign);
  if (!plan || off <= 0) return { applied: false, reason: 'plan_not_covered', regularYen };
  // 読めない（null / undefined）は「新規と確かめられない」→ 付けない（安全側。画面は通常価格を案内する）
  if (hadCardSubscription !== false) return { applied: false, reason: hadCardSubscription ? 'previous_subscription' : 'history_unknown', regularYen };
  if (hadCardSubscriptionInFields(fields)) return { applied: false, reason: 'previous_subscription', regularYen };
  return { applied: true, campaignId: campaign.id, discountYen: off, firstYen: regularYen - off, regularYen };
}

/**
 * Paddle の取引に付ける一回限りの値引き（非カタログ・`recur: false`）。中立サイトが intent の campaignId から作る。
 * 金額は intent からは受け取らず、この表から引き直す。対象外なら null。
 */
export function paddleCampaignDiscount({ planId, campaignId, campaign = SUBSCRIPTION_CAMPAIGN }) {
  if (!isActiveCampaignId(campaignId, campaign)) return null;
  const off = campaignDiscountYen(planId, campaign);
  if (off <= 0) return null;
  return {
    description: `特別価格 ${off.toLocaleString('ja-JP')}円OFF`,
    type: 'flat',
    amount: String(off),
    recur: false,
  };
}
