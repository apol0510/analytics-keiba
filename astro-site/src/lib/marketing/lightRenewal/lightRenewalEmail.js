/**
 * lightRenewalEmail.js — Light 月払い 期限前・失効後リマインドの本文（純粋）
 *
 * 2026-10-02 MK 確定（Light 新規募集停止・Stripe 月額への再編）:
 *   - **主な案内は「Light と同じ ¥4,980/月で、中央＋南関の全レースが見られる Premium への変更」**（ボタンはこれだけ）
 *   - 年払い（Light 会員の乗り換え特典 ¥44,820・期限あり）は補助の案内
 *   - Light の更新・再開は**権利として残すが勧めない**（本文に 1 行だけ・ボタンは付けない）
 * ボタンは `/login/?next=/pricing/`（ログイン後に会員向け表示の料金ページへ）。
 * ⚠️ Stripe live 決済が無効な間は送らない（cron が `stripeSalesGate` で dry-run に落とす）。
 *
 * 本文に書くのは spec にある事実だけ（価格・期限・手続き方法）。煽らない。
 * 配信停止リンクは本文に書かない（共通シェルのフッターが付ける）。
 */
import { renderMarketingHtml, renderMarketingText, renderCta, escapeHtml } from '../marketingEmailShell.js';
import {
  STAGE, SWITCH_PRICE_YEN, REGULAR_PREMIUM_ANNUAL_YEN, LIGHT_MONTHLY_YEN, switchDeadlineFor, addDays,
} from './lightRenewalPolicy.js';
import { planById } from '../../billing/stripePlans.js';

/** Premium 月額（Stripe）。金額の正本は stripePlans.js */
const PREMIUM_MONTHLY_YEN = planById('premium').amountYen;

export const LIGHT_RENEWAL_CTA_URL = 'https://analytics.keiba.link/login/?next=/pricing/';

const yen = (n) => `¥${Number(n).toLocaleString('ja-JP')}`;
export function jpDate(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  return `${y}年${m}月${d}日`;
}
const md = (ymd) => { const [, m, d] = String(ymd).split('-').map(Number); return `${m}月${d}日`; };

/** 件名 */
export function subjectFor({ stage, cycle }) {
  if (stage === STAGE.PRE) return `Light プランの有効期限が近づいています（${md(cycle)}まで）— 同じ ${yen(PREMIUM_MONTHLY_YEN)}/月で Premium に変更できます`;
  return `Light プランの有効期限が終了しました — 同じ ${yen(PREMIUM_MONTHLY_YEN)}/月で Premium をご利用いただけます`;
}

/** 本文の材料（HTML / text で共通）*/
export function contentFor({ stage, cycle, name }) {
  const deadline = switchDeadlineFor(cycle);
  const salutation = name ? `${String(name).trim()} 様` : 'Light プランをご利用のお客様へ';
  const premium = {
    title: `Premium へ変更する（${yen(PREMIUM_MONTHLY_YEN)}／月・中央＋南関の全レース）`,
    cta: 'Premium へ変更する手続きへ',
    detail: `Light と同じ ${yen(PREMIUM_MONTHLY_YEN)} で、メインレースだけでなく中央・南関の全レース（1R〜12R）の買い目をご覧いただけます。お支払いはクレジットカード（毎月自動更新）で、決済後すぐにご利用いただけます。`,
  };
  const annual = stage === STAGE.PRE
    ? `年払いをご希望の場合は、Light 会員の乗り換え特典として Premium 年額を ${yen(SWITCH_PRICE_YEN)}（通常 ${yen(REGULAR_PREMIUM_ANNUAL_YEN)}・銀行振込）でお申し込みいただけます。`
    : `年払いをご希望の場合は、${jpDate(deadline)} まで Light 会員の乗り換え特典として Premium 年額を ${yen(SWITCH_PRICE_YEN)}（通常 ${yen(REGULAR_PREMIUM_ANNUAL_YEN)}・銀行振込）でお申し込みいただけます。${jpDate(addDays(deadline, 1))} 以降は通常の価格になります。`;
  const lightLine = stage === STAGE.PRE
    ? `Light（${yen(LIGHT_MONTHLY_YEN)}／30日・メインレースのみ）の更新も、料金ページ下部の「銀行振込」からお手続きいただけます。`
    : `Light（${yen(LIGHT_MONTHLY_YEN)}／30日・メインレースのみ）の再開も、料金ページ下部の「銀行振込」からお手続きいただけます。`;
  const body = stage === STAGE.PRE
    ? [
      'いつも KEIBA Analytics の Light プランをご利用いただき、ありがとうございます。',
      `ご利用中の Light プラン（月払い）の有効期限は ${jpDate(cycle)} です。期限を過ぎると、メインレースの馬単買い目など Light 向けの内容をご覧いただけなくなります。`,
      `Light と同じ ${yen(PREMIUM_MONTHLY_YEN)}/月で、中央＋南関の全レースの買い目が見られる Premium へ変更できます。`,
    ].join('\n')
    : [
      'KEIBA Analytics の Light プランをご利用いただき、ありがとうございました。',
      `Light プラン（月払い）の有効期限は ${jpDate(cycle)} で終了しました。`,
      `Light と同じ ${yen(PREMIUM_MONTHLY_YEN)}/月で、中央＋南関の全レースの買い目が見られる Premium をご利用いただけます。`,
    ].join('\n');
  return {
    salutation,
    headline: stage === STAGE.PRE ? 'Light プランの有効期限のお知らせ' : 'Light プランの有効期限終了のお知らせ',
    preheader: stage === STAGE.PRE
      ? `有効期限は ${jpDate(cycle)} です。同じ ${yen(PREMIUM_MONTHLY_YEN)}/月で中央＋南関の全レースが見られる Premium へ変更できます。`
      : `同じ ${yen(PREMIUM_MONTHLY_YEN)}/月で中央＋南関の全レースが見られる Premium をご利用いただけます。`,
    body,
    premium,
    annual,
    lightLine,
    ctaNote: 'ボタンを押すとログイン画面が開きます。ログイン後に料金ページが表示され、会員向けの表示でお申し込みいただけます。',
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
  const premiumCta = { label: c.premium.cta, url: LIGHT_RENEWAL_CTA_URL };

  // 共通シェルの CTA は 1 つ。ボタンは「Premium へ変更」だけ（Light 更新・年払いは本文の補足）
  const baseHtml = renderMarketingHtml({
    salutation: c.salutation, headline: c.headline, preheader: c.preheader, body: c.body,
    cta: premiumCta, ctaNote: c.ctaNote, footerNote: c.footerNote,
  });
  const button = renderCta(premiumCta);
  const block = [
    optionHeading(c.premium.title), optionDetail(c.premium.detail), button,
    optionDetail(c.annual), optionDetail(c.lightLine),
  ].join('\n');
  const html = baseHtml.replace(button, block);

  const text = renderMarketingText({
    salutation: c.salutation, headline: c.headline,
    body: [
      c.body, '',
      c.premium.title, c.premium.detail, `${c.premium.cta}:`, LIGHT_RENEWAL_CTA_URL, '',
      c.annual, c.lightLine,
    ].join('\n'),
    ctaNote: c.ctaNote, footerNote: c.footerNote,
  });
  return { subject: subjectFor({ stage, cycle }), html, text };
}
