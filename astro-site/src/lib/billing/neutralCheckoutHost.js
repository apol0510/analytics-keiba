/**
 * neutralCheckoutHost.js — 決済会社へ渡す URL を中立ホスト checkout.tirol.link に寄せる単一源（純粋）
 *
 * 2026-10-15 MK 確定: 決済会社（PayPal・Paddle 等）へ渡す戻り先 URL・キャンセル URL・Webhook URL に競馬関連語を入れない。
 * 会員サイトのドメイン（analytics.keiba.link）は変えないので、本番では中立ホストを経由させる:
 *   - 戻り先・キャンセル: checkout.tirol.link の `_redirects` が会員サイトへ **302**（ブラウザが移るだけ。
 *     ログインの Cookie は会員サイトのものがそのまま使える。PayPal が付ける ?token= 等のクエリは Netlify がそのまま渡す）
 *   - Webhook: checkout.tirol.link が会員サイトの Function へ **200 プロキシ**（本文・署名ヘッダはそのまま。
 *     Netlify のプロキシは元の Host を付けたまま届けるので、Function は Host=checkout.tirol.link を本番として扱う）
 * ルートの正本はこの表。checkout.tirol.link の `_redirects`（ops/checkout-site/site.mjs）はここから作る。
 * Sandbox（sandbox.checkout.tirol.link・Deploy Preview）は従来どおり受けたオリジンへ戻す（既に中立ホスト）。
 */
import { PRODUCTION_ORIGIN } from './cardSales.js';

export const NEUTRAL_CHECKOUT_HOST = 'checkout.tirol.link';
export const NEUTRAL_CHECKOUT_ORIGIN = `https://${NEUTRAL_CHECKOUT_HOST}`;

export const NEUTRAL_PATHS = Object.freeze({
  paypalOrderReturn: '/r/paypal/order-return',
  paypalSubscriptionReturn: '/r/paypal/subscription-return',
  paypalCancel: '/r/paypal/cancel',
  paypalWebhook: '/hooks/paypal',
});

/** checkout.tirol.link の `_redirects` に書く行（from → 会員サイトの実 URL） */
export const NEUTRAL_ROUTES = Object.freeze([
  Object.freeze({ from: NEUTRAL_PATHS.paypalOrderReturn, to: `${PRODUCTION_ORIGIN}/checkout/paypal-return/`, status: '302!' }),
  Object.freeze({ from: NEUTRAL_PATHS.paypalSubscriptionReturn, to: `${PRODUCTION_ORIGIN}/checkout/paypal-subscription-return/`, status: '302!' }),
  Object.freeze({ from: NEUTRAL_PATHS.paypalCancel, to: `${PRODUCTION_ORIGIN}/pricing/?checkout=cancelled`, status: '302!' }),
  Object.freeze({ from: NEUTRAL_PATHS.paypalWebhook, to: `${PRODUCTION_ORIGIN}/.netlify/functions/paypal-order-webhook`, status: '200!' }),
]);

/** PayPal Live の Webhook に登録する URL */
export const PAYPAL_LIVE_WEBHOOK_URL = `${NEUTRAL_CHECKOUT_ORIGIN}${NEUTRAL_PATHS.paypalWebhook}`;

/**
 * PayPal へ渡す戻り先・キャンセル URL。本番サイトのときだけ中立ホストを通す。
 * @param {string} origin 申込を受けたサイトのオリジン（resolveSiteOrigin の結果）
 * @param {'order'|'subscription'} kind
 */
export function paypalReturnUrls(origin, kind) {
  const o = String(origin || '');
  if (o === PRODUCTION_ORIGIN) {
    return {
      return_url: `${NEUTRAL_CHECKOUT_ORIGIN}${kind === 'order' ? NEUTRAL_PATHS.paypalOrderReturn : NEUTRAL_PATHS.paypalSubscriptionReturn}`,
      cancel_url: `${NEUTRAL_CHECKOUT_ORIGIN}${NEUTRAL_PATHS.paypalCancel}`,
    };
  }
  return {
    return_url: `${o}${kind === 'order' ? '/checkout/paypal-return/' : '/checkout/paypal-subscription-return/'}`,
    cancel_url: `${o}/pricing/?checkout=cancelled`,
  };
}

/**
 * Webhook を受けた Function が「どのサイトとして」判定するか。中立ホスト経由（Host=checkout.tirol.link）は本番。
 * Netlify は Host で配信先サイトを決めるため、会員サイトの Function にこの Host が届くのは中立ホストのプロキシ経由だけ。
 */
export function webhookSiteOrigin(host) {
  const h = String(host || '').trim().toLowerCase();
  if (h === NEUTRAL_CHECKOUT_HOST) return PRODUCTION_ORIGIN;
  return `https://${h}`;
}
