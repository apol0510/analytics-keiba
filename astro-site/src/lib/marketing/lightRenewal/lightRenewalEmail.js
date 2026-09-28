/**
 * lightRenewalEmail.js — Light 月払い 期限前・失効後リマインドの本文（純粋）
 *
 * どちらの通も **2 つの導線を分けて**載せる（MK 決定 2026-09-29）:
 *   ① Light をそのまま続ける（期限前）／ Light を再開する（失効後）
 *   ② Premium 年額 ¥44,820 へ乗り換える（Light 会員の乗り換え特典・通常 ¥49,800）
 * どちらのボタンも `/login/?next=/pricing/`（ログイン後に会員向け価格の料金ページへ着地させる）。
 *
 * 本文に書くのは spec にある事実だけ（価格・期限・手続き方法）。煽らない。
 * 配信停止リンクは本文に書かない（共通シェルのフッターが付ける）。
 */
import { renderMarketingHtml, renderMarketingText, renderCta, escapeHtml } from '../marketingEmailShell.js';
import {
  STAGE, SWITCH_PRICE_YEN, REGULAR_PREMIUM_ANNUAL_YEN, LIGHT_MONTHLY_YEN, switchDeadlineFor, addDays,
} from './lightRenewalPolicy.js';

export const LIGHT_RENEWAL_CTA_URL = 'https://analytics.keiba.link/login/?next=/pricing/';

const yen = (n) => `¥${Number(n).toLocaleString('ja-JP')}`;
export function jpDate(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return `${y}年${m}月${d}日`;
}
const md = (ymd) => { const [, m, d] = String(ymd).split('-').map(Number); return `${m}月${d}日`; };

/** 件名 */
export function subjectFor({ stage, cycle }) {
  if (stage === STAGE.PRE) return `Light プランの有効期限が近づいています（${md(cycle)}まで）`;
  return `Light プランの有効期限が終了しました — ${md(switchDeadlineFor(cycle))}まで Premium 年額 ${yen(SWITCH_PRICE_YEN)} でご案内できます`;
}

/** 本文の材料（HTML / text で共通）*/
export function contentFor({ stage, cycle, name }) {
  const deadline = switchDeadlineFor(cycle);
  const salutation = name ? `${String(name).trim()} 様` : 'Light プランをご利用のお客様へ';
  const light = stage === STAGE.PRE
    ? { title: `① Light をそのまま続ける（${yen(LIGHT_MONTHLY_YEN)}／30日）`, cta: 'Light を続ける手続きへ' }
    : { title: `① Light を再開する（${yen(LIGHT_MONTHLY_YEN)}／30日）`, cta: 'Light を再開する手続きへ' };
  const premium = {
    title: `② Premium 年額へ乗り換える（Light 会員の乗り換え特典 ${yen(SWITCH_PRICE_YEN)}／年・通常 ${yen(REGULAR_PREMIUM_ANNUAL_YEN)}）`,
    cta: `Premium 年額 ${yen(SWITCH_PRICE_YEN)} で申し込む`,
  };
  const body = stage === STAGE.PRE
    ? [
      'いつも KEIBA Analytics の Light プランをご利用いただき、ありがとうございます。',
      `ご利用中の Light プラン（月払い）の有効期限は ${jpDate(cycle)} です。期限を過ぎると、メインレースの馬単買い目など Light 向けの内容をご覧いただけなくなります。`,
      '引き続きご利用いただく場合は、次の 2 つからお選びください。お手続きは料金ページから、これまでと同じ銀行振込でお申し込みいただけます。',
    ].join('\n')
    : [
      'KEIBA Analytics の Light プランをご利用いただき、ありがとうございました。',
      `Light プラン（月払い）の有効期限は ${jpDate(cycle)} で終了しました。再開をご希望の場合は、次の 2 つからお選びいただけます。お手続きは料金ページから銀行振込でお申し込みいただけます。`,
      `${jpDate(deadline)} までは、Light 会員の乗り換え特典として Premium 年額を ${yen(SWITCH_PRICE_YEN)}（通常 ${yen(REGULAR_PREMIUM_ANNUAL_YEN)}）でお申し込みいただけます。${jpDate(addDays(deadline, 1))} 以降は通常の価格になります。`,
    ].join('\n');
  return {
    salutation,
    headline: stage === STAGE.PRE ? 'Light プランの有効期限のお知らせ' : 'Light プランの有効期限終了のお知らせ',
    preheader: stage === STAGE.PRE
      ? `有効期限は ${jpDate(cycle)} です。Light を続けるか、Premium 年額 ${yen(SWITCH_PRICE_YEN)} へ乗り換えるかをお選びいただけます。`
      : `${jpDate(deadline)} まで Premium 年額 ${yen(SWITCH_PRICE_YEN)} でお申し込みいただけます。`,
    body,
    light,
    premium: {
      ...premium,
      detail: 'Premium では全レース（1R〜12R）の買い目をご覧いただけます。中央・南関の両方が対象です。',
    },
    lightDetail: 'メインレースの馬単買い目（最大 5 点）と、全レースの予想（買い目なし）をご覧いただけます。',
    ctaNote: 'どちらのボタンもログイン画面が開きます。ログイン後に料金ページが表示され、会員向けの価格でお申し込みいただけます。',
    footerNote: 'このメールは Light プラン（月払い）をご契約いただいた方へお送りしています。',
    deadline,
  };
}

const optionHeading = (text) => `<p style="margin:18px 0 6px;font-size:15px;line-height:1.7;font-weight:bold;color:#1f2937;">${escapeHtml(text)}</p>`;
const optionDetail = (text) => `<p style="margin:0 0 6px;font-size:14px;line-height:1.8;color:#4b5563;">${escapeHtml(text)}</p>`;

/**
 * HTML と text を同時に作る。配信停止 URL は共通シェルの印（`{{unsubscribeUrl}}`）のまま返す。
 * @returns {{subject: string, html: string, text: string}}
 */
export function renderLightRenewalEmail({ stage, cycle, name }) {
  const c = contentFor({ stage, cycle, name });
  const lightCta = { label: c.light.cta, url: LIGHT_RENEWAL_CTA_URL };
  const premiumCta = { label: c.premium.cta, url: LIGHT_RENEWAL_CTA_URL };

  // 共通シェルは CTA を 1 つしか持たないので、① のボタンの直前・直後に選択肢を差し込む
  const baseHtml = renderMarketingHtml({
    salutation: c.salutation, headline: c.headline, preheader: c.preheader, body: c.body,
    cta: lightCta, ctaNote: c.ctaNote, footerNote: c.footerNote,
  });
  const lightButton = renderCta(lightCta);
  const block = [
    optionHeading(c.light.title), optionDetail(c.lightDetail), lightButton,
    optionHeading(c.premium.title), optionDetail(c.premium.detail), renderCta(premiumCta),
  ].join('\n');
  const html = baseHtml.replace(lightButton, block);

  const text = renderMarketingText({
    salutation: c.salutation, headline: c.headline,
    body: [
      c.body, '',
      c.light.title, c.lightDetail, `${c.light.cta}:`, LIGHT_RENEWAL_CTA_URL, '',
      c.premium.title, c.premium.detail, `${c.premium.cta}:`, LIGHT_RENEWAL_CTA_URL,
    ].join('\n'),
    ctaNote: c.ctaNote, footerNote: c.footerNote,
  });
  return { subject: subjectFor({ stage, cycle }), html, text };
}
