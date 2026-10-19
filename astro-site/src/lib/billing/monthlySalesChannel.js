/**
 * monthlySalesChannel.js — 「いま新規の月額を受け付けている決済経路があるか」の単一源（更新リマインドのゲート用）
 *
 * 更新リマインド（Light / Premium 月払い）の本文は /pricing/ の月額（Premium ¥4,980・中央版／南関版 ¥2,980・
 * クレジットカードで毎月自動更新）を案内する。案内先で申し込めないときは送らない（2026-10-02 MK 確定の考え方）。
 *
 * 2026-10-11 以降は Stripe の新規月払い（MONTHLY_SALES_OPEN）が閉じていたため、旧ゲートは Stripe だけを見て
 * 常に dry-run に落としていた。2026-10-15 MK 決定で月額は PayPal の定期課金（SUBSCRIPTION_SALES_OPEN.paypal）で
 * 受け付けているため、**実際に開いている月額の経路**で判定する。
 *
 * 判定（fail closed＝開いていないとみなす側）:
 *   1. SUBSCRIPTION_SALES_OPEN[ACTIVE_SUBSCRIPTION_PROVIDER] が true で、その決済会社の本番鍵が Function の env にある
 *      （本番サイトとして live と判定できる＝monthly-create-checkout と同じ判定）→ 開いている
 *   2. そうでなく MONTHLY_SALES_OPEN（Stripe）が true → Stripe の live 決済が有効か（checkStripeLiveSales）
 *   3. どちらでもない → 開いていない（monthly_sales_ended）
 */
import { SUBSCRIPTION_SALES_OPEN, ACTIVE_SUBSCRIPTION_PROVIDER, PRODUCTION_ORIGIN, resolveCardMode } from './cardSales.js';
import { MONTHLY_SALES_OPEN } from './stripePlans.js';
import { checkStripeLiveSales } from './stripeSalesGate.js';
import { keyMode } from './paypal/paypalCore.js';

/** 月額の案内文に書く決済代行の表示名（/pricing/ の注記「決済代行：PayPal」と同じ） */
export const MONTHLY_PROVIDER_LABEL = Object.freeze({ paypal: 'PayPal', stripe: 'Stripe' });

/** 決済会社ごとの本番鍵の判定（値は読まない・形だけ） */
const KEY_MODE = {
  paypal: (env) => keyMode({ clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET, env: env.PAYPAL_ENV }),
};

/**
 * @param {object} env Function の process.env
 * @param {{ fetchImpl?: Function, subscriptionOpen?: object, activeProvider?: string, stripeMonthlyOpen?: boolean }} [opts] テスト用の差し替え
 * @returns {Promise<{ open: boolean, provider: string|null, reason: string }>}
 */
export async function resolveMonthlySalesChannel(env = {}, {
  fetchImpl,
  subscriptionOpen = SUBSCRIPTION_SALES_OPEN,
  activeProvider = ACTIVE_SUBSCRIPTION_PROVIDER,
  stripeMonthlyOpen = MONTHLY_SALES_OPEN,
} = {}) {
  if (subscriptionOpen[activeProvider] === true) {
    const km = KEY_MODE[activeProvider] ? KEY_MODE[activeProvider](env || {}) : null;
    const r = resolveCardMode({ provider: activeProvider, keyMode: km, origin: PRODUCTION_ORIGIN, salesOpen: true });
    if (r.ok && r.mode === 'live') return { open: true, provider: activeProvider, reason: 'ok' };
    return { open: false, provider: activeProvider, reason: r.ok ? 'not_live' : r.reason };
  }
  if (stripeMonthlyOpen === true) {
    const s = await checkStripeLiveSales(env, { fetchImpl });
    return { open: s.open === true, provider: 'stripe', reason: s.reason };
  }
  return { open: false, provider: null, reason: 'monthly_sales_ended' };
}
