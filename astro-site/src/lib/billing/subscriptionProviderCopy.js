/**
 * subscriptionProviderCopy.js — 料金ページの「カード（定期課金）」の説明のうち、決済会社によって変わる部分の単一源（純粋）
 *
 * 2026-11-02 MK 確定「新規の月額・年額は Paddle へ一本化」: 受付先は cardSales.ACTIVE_SUBSCRIPTION_PROVIDER の 1 社。
 * 料金ページはこの表の ACTIVE の行だけを出す（切替 PR で ACTIVE を変えると文言も一緒に変わる＝決済会社と案内がずれない）。
 * paypal の行は 2026-10-15〜11-02 の掲載文と同一（切替前の表示を 1 文字も変えない）。
 * paddle の行は実際の挙動どおり: Paddle の決済画面でカード入力（PayPal のアカウント不要）。
 * 2026-11-02 MK 確定: 料金ページでは退会・解約の方法（決済会社のメール・アカウントでの解約、支払い済み期間までの利用）を販売の訴求として出さない。
 * 解約・退会の条件は料金ページの FAQ（マイページ「登録変更」→「退会する」・確定した時点で即時終了・残り期間の返金なし）と規約で説明する。
 */
import { ACTIVE_SUBSCRIPTION_PROVIDER } from './cardSales.js';

export const SUBSCRIPTION_PROVIDER_COPY = Object.freeze({
  paypal: Object.freeze({
    label: 'PayPal',
    annualTitle: 'カード（PayPal）の年払いは自動更新です。',
    flowStep2: '決済画面（PayPal）でお支払いを承認',
  }),
  paddle: Object.freeze({
    label: 'Paddle',
    annualTitle: 'カードの年払いは自動更新です。',
    flowStep2: '決済画面（Paddle）でカード情報を入力してお支払い',
  }),
});

export function subscriptionProviderCopy(provider = ACTIVE_SUBSCRIPTION_PROVIDER) {
  return SUBSCRIPTION_PROVIDER_COPY[provider] || SUBSCRIPTION_PROVIDER_COPY.paypal;
}
