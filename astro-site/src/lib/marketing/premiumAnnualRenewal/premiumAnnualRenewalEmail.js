/**
 * premiumAnnualRenewalEmail.js — 銀行振込の Premium 年払い 期限前リマインドの本文（純粋）
 *
 * 書くのは /pricing/ にある事実だけ:
 *   - 「Premium 年払い」¥49,800/年・中央＋南関の全レースを 1 年間・銀行振込・1 年ごとのお支払い
 *   - FAQ「銀行振込の年払いは、有効期限が近づきましたらメールでお知らせいたします。継続をご希望の場合は、再度お振込みいただくことで延長できます」
 *   - 銀行振込の流れ「①お振込み → ②振込完了後、報告フォームをご送信 → ③入金確認後、ご利用開始」
 * 割引・特典・カード（PayPal）の年額は書かない（年額のカード申込は表示条件付きのため・案内は銀行振込の更新だけ）。
 * ボタンは `/login/?next=/pricing/`（ログイン後に料金ページ）。配信停止リンクは共通シェルのフッター。
 */
import { renderMarketingHtml, renderMarketingText } from '../marketingEmailShell.js';
import { STAGE, PREMIUM_ANNUAL_YEN } from './premiumAnnualRenewalPolicy.js';
import { jpDate } from '../lightRenewal/lightRenewalEmail.js';

export const PREMIUM_ANNUAL_RENEWAL_CTA_URL = 'https://analytics.keiba.link/login/?next=/pricing/';

const yen = (n) => `¥${Number(n).toLocaleString('ja-JP')}`;
const md = (ymd) => { const [, m, d] = String(ymd).split('-').map(Number); return `${m}月${d}日`; };

export function subjectFor({ cycle }) {
  return `Premium 年払いの有効期限が近づいています（${md(cycle)}まで）`;
}

export function contentFor({ stage, cycle, name }) {
  if (stage !== STAGE.PRE) throw new Error(`premium_annual_renewal:unknown_stage:${stage}`);
  const salutation = name ? `${String(name).trim()} 様` : 'Premium プランをご利用のお客様へ';
  const body = [
    'いつも KEIBA Analytics の Premium プランをご利用いただき、ありがとうございます。',
    `ご利用中の Premium プラン（年払い・銀行振込）の有効期限は ${jpDate(cycle)} です。期限を過ぎると、全レースの買い目など Premium の内容をご覧いただけなくなります。`,
    `継続をご希望の場合は、料金ページの「Premium 年払い」（${yen(PREMIUM_ANNUAL_YEN)}／年・中央＋南関）の「銀行振込で申し込む」から、再度お振込みいただくことで延長できます。`,
    'お手続きの流れ: ①お振込み → ②振込完了後、報告フォームをご送信 → ③入金確認後、ご利用開始です。フォームはお振込みが済んでからご送信ください。',
  ].join('\n');
  return {
    salutation,
    headline: 'Premium 年払いの有効期限のお知らせ',
    preheader: `有効期限は ${jpDate(cycle)} です。料金ページから銀行振込で更新のお手続きができます。`,
    body,
    cta: { label: '年払いを続ける手続きへ', url: PREMIUM_ANNUAL_RENEWAL_CTA_URL },
    ctaNote: 'ボタンを押すとログイン画面が開きます。ログイン後に料金ページが表示されます。',
    footerNote: 'このメールは Premium プラン（年払い・銀行振込）をご契約いただいた方へお送りしています。',
  };
}

export function renderPremiumAnnualRenewalEmail({ stage, cycle, name }) {
  const c = contentFor({ stage, cycle, name });
  const html = renderMarketingHtml({
    salutation: c.salutation, headline: c.headline, preheader: c.preheader, body: c.body,
    cta: c.cta, ctaNote: c.ctaNote, footerNote: c.footerNote,
  });
  const text = renderMarketingText({
    salutation: c.salutation, headline: c.headline,
    body: [c.body, '', `${c.cta.label}:`, c.cta.url].join('\n'),
    ctaNote: c.ctaNote, footerNote: c.footerNote,
  });
  return { subject: subjectFor({ cycle }), html, text };
}
