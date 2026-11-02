/**
 * subscriptionProviderCopy.js — 料金ページの「カード（定期課金）」の説明のうち、決済会社によって変わる部分の単一源（純粋）
 *
 * 2026-11-02 MK 確定「新規の月額・年額は Paddle へ一本化」: 受付先は cardSales.ACTIVE_SUBSCRIPTION_PROVIDER の 1 社。
 * 料金ページはこの表の ACTIVE の行だけを出す（切替 PR で ACTIVE を変えると文言も一緒に変わる＝決済会社と案内がずれない）。
 * paypal の行は 2026-10-15〜11-02 の掲載文と同一（切替前の表示を 1 文字も変えない）。
 * paddle の行は実際の挙動どおり: Paddle の決済画面でカード入力（PayPal のアカウント不要）／Paddle から届くメールのリンクで解約すると
 * 支払い済み期間の終わりまで利用可・マイページの退会は即時（CARD_PAYMENT_PROVIDERS.md §3.8）。
 */
import { ACTIVE_SUBSCRIPTION_PROVIDER } from './cardSales.js';

export const SUBSCRIPTION_PROVIDER_COPY = Object.freeze({
  paypal: Object.freeze({
    label: 'PayPal',
    annualTitle: 'カード（PayPal）の年払いは自動更新です。',
    annualStop: '更新を止めるには、PayPal のアカウントで自動支払いを停止してください。次回から請求されず、支払い済みの 12 か月が終わるまでご利用いただけます。',
    flowStep2: '決済画面（PayPal）でお支払いを承認',
  }),
  paddle: Object.freeze({
    label: 'Paddle',
    annualTitle: 'カードの年払いは自動更新です。',
    annualStop: '更新を止めるには、Paddle から届くお支払いの確認メールにあるリンクから解約してください。次回から請求されず、支払い済みの 12 か月が終わるまでご利用いただけます。',
    flowStep2: '決済画面（Paddle）でカード情報を入力してお支払い',
  }),
});

export function subscriptionProviderCopy(provider = ACTIVE_SUBSCRIPTION_PROVIDER) {
  return SUBSCRIPTION_PROVIDER_COPY[provider] || SUBSCRIPTION_PROVIDER_COPY.paypal;
}
