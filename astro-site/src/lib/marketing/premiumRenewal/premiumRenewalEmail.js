/**
 * premiumRenewalEmail.js — Premium 月払い 期限前・失効後リマインドの本文（純粋）
 *
 * 書くのは /pricing/ にある事実だけ（Premium 月額 ¥4,980・クレジットカードの自動更新 / 2026-10-02〜）。割引・特典は書かない。
 * 対象は銀行振込で月払いを契約していた会員（Stripe 会員は自動更新なので対象外・premiumRenewalPolicy）。
 * ボタンは `/login/?next=/pricing/`（ログイン後に料金ページ）。配信停止リンクは共通シェルのフッター。
 */
import { renderMarketingHtml, renderMarketingText } from '../marketingEmailShell.js';
import { STAGE, PREMIUM_MONTHLY_YEN } from './premiumRenewalPolicy.js';
import { jpDate } from '../lightRenewal/lightRenewalEmail.js';

export const PREMIUM_RENEWAL_CTA_URL = 'https://analytics.keiba.link/login/?next=/pricing/';

const yen = (n) => `¥${Number(n).toLocaleString('ja-JP')}`;
const md = (ymd) => { const [, m, d] = String(ymd).split('-').map(Number); return `${m}月${d}日`; };

export function subjectFor({ stage, cycle }) {
  if (stage === STAGE.PRE) return `Premium プランの有効期限が近づいています（${md(cycle)}まで）`;
  return 'Premium プランの有効期限が終了しました — 再開のご案内';
}

export function contentFor({ stage, cycle, name }) {
  const salutation = name ? `${String(name).trim()} 様` : 'Premium プランをご利用のお客様へ';
  const body = stage === STAGE.PRE
    ? [
      'いつも KEIBA Analytics の Premium プランをご利用いただき、ありがとうございます。',
      `ご利用中の Premium プラン（月払い）の有効期限は ${jpDate(cycle)} です。期限を過ぎると、全レースの買い目など Premium の内容をご覧いただけなくなります。`,
      `引き続きご利用いただく場合は、料金ページから Premium 月額プラン（${yen(PREMIUM_MONTHLY_YEN)}／月・クレジットカードで毎月自動更新）をお申し込みください。年払いなど他のプランも料金ページでお選びいただけます。`,
    ].join('\n')
    : [
      'KEIBA Analytics の Premium プランをご利用いただき、ありがとうございました。',
      `Premium プラン（月払い）の有効期限は ${jpDate(cycle)} で終了しました。`,
      `再開をご希望の場合は、料金ページから Premium 月額プラン（${yen(PREMIUM_MONTHLY_YEN)}／月・クレジットカードで毎月自動更新）をお申し込みいただけます。年払いなど他のプランも料金ページでお選びいただけます。`,
    ].join('\n');
  return {
    salutation,
    headline: stage === STAGE.PRE ? 'Premium プランの有効期限のお知らせ' : 'Premium プランの有効期限終了のお知らせ',
    preheader: stage === STAGE.PRE
      ? `有効期限は ${jpDate(cycle)} です。料金ページから更新のお手続きができます。`
      : '料金ページから Premium を再開していただけます。',
    body,
    cta: { label: stage === STAGE.PRE ? 'Premium を続ける手続きへ' : 'Premium を再開する手続きへ', url: PREMIUM_RENEWAL_CTA_URL },
    ctaNote: 'ボタンを押すとログイン画面が開きます。ログイン後に料金ページが表示されます。',
    footerNote: 'このメールは Premium プラン（月払い）をご契約いただいた方へお送りしています。',
  };
}

export function renderPremiumRenewalEmail({ stage, cycle, name }) {
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
  return { subject: subjectFor({ stage, cycle }), html, text };
}
