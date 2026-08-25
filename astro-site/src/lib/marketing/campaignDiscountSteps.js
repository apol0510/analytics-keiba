/**
 * campaignDiscountSteps.js — 全会員向けキャンペーン割引の**メール文面**（純粋・I/O なし）
 *
 * サイト側（マイページのお知らせ / 申込モーダル）で動いているキャンペーン割引を、
 * **メールでもご案内する**ための文面の単一源。`campaignCatalog.js` から読み込む。
 *
 * ── 金額と期限を手で書かない（これが本モジュールの存在理由）────────────
 * 割引額・通常価格・適用後価格・期限は **`campaignOffers.js` / `promotionOfferCatalog.js`
 * から導出**する。メールに数字を書き写すと、サイトの価格を直したときに
 * **メールだけ古い金額のまま**になり「案内した額と請求額が違う」事故になる
 * （2026-08-25 に申込モーダルで実際に起きた）。
 * よって本ファイルには **¥ の数字を 1 つも書かない**（テストで固定）。
 *
 * ── 誰に何を案内するか ────────────────────────────────────────
 * 出し分けの正本は `campaignOffers.resolveCampaignOfferIdsFor(entitlements)`。
 * メールの宛先区分はその出力と **1 対 1 で対応させる**（対応がズレたら
 * 「メールで案内した割引がマイページに出ない」になる）。
 *
 *   | 宛先区分 | 権利 | 案内する割引 |
 *   |---|---|---|
 *   | `free`    | 有料の閲覧権なし（無料 / 期限切れ）| Light 月額 / Premium 年額 / Premium 買い切り |
 *   | `light`   | Light 有効 | Premium 年額 / Premium 買い切り |
 *   | `premium` | Premium 有効・三連複なし | 三連複 買い切り |
 *   | （三連複あり）| 最上位 | **メールを作らない**（売るものが無い）|
 *
 * ── 行き先は `/dashboard/` だけ ───────────────────────────────
 * ⚠️ **未ログインの方には割引価格が表示されない。** キャンペーン価格は
 *    `localStorage` の契約（= ログイン済み）を見て出しており、未ログインでは
 *    通常価格 +「無料登録で◯◯円OFF」が出る（`campaign-price.js`）。
 *    ご登録済みの方にその文言を見せないため、**入口はログインに固定**する。
 *    ログイン後は `/dashboard/` のお知らせに割引後の価格が出る。
 * ⚠️ 三連複には**公開の販売ページが無い**（`/premium-sanrenpuku/` は保有者専用で、
 *    Premium の方は 302 → `/login/?r=not_entitled`）。購入導線はマイページの
 *    「三連複を追加」モーダルだけ。**推測で URL を作らない。**
 *
 * ── 書かないこと ────────────────────────────────────────────
 * 的中・利益の保証、煽り、実績数値の手書き（`FORBIDDEN_PHRASES` /
 * `HARDCODED_STAT` がカタログ検証で落とす）、配信停止リンク（送信基盤が自動付与）。
 */

import {
  CAMPAIGN_OFFER_IDS, describeCampaignOfferLine, describeCampaignDeadline,
} from '../promotions/campaignOffers.js';
import { resolveOffer } from '../promotions/promotionOfferCatalog.js';

const SITE = 'https://analytics.keiba.link';

/** 入口は 1 つだけ（ログイン後にお知らせで割引価格が出る） */
export const DISCOUNT_CTA = Object.freeze({
  label: 'ログインして割引価格を見る',
  url: `${SITE}/dashboard/`,
  note: 'ご登録のメールアドレスでログインしていただくと、割引後の価格が表示されます。',
});

const FOOTER = 'このメールは、KEIBA Analytics にご登録いただいている方へお送りしています。';

/** 期限の表示。**画面と同じ文字列**を使う（別々に組み立てない） */
export const DISCOUNT_DEADLINE = describeCampaignDeadline();

/** offerId → 「Premium 年額 5,000円OFF（¥49,800 → ¥44,800）」の 1 行（カタログ由来） */
function line(offerId) {
  const r = resolveOffer(offerId);
  if (!r.ok) throw new Error(`campaignDiscountSteps: ${offerId} を解決できない (${r.error})`);
  return describeCampaignOfferLine(r.offer);
}

/** 宛先区分ごとに案内する割引（`resolveCampaignOfferIdsFor` と 1 対 1） */
export const DISCOUNT_SEGMENT_OFFER_IDS = Object.freeze({
  free: Object.freeze([
    CAMPAIGN_OFFER_IDS.LIGHT_MONTHLY,
    CAMPAIGN_OFFER_IDS.PREMIUM_ANNUAL,
    CAMPAIGN_OFFER_IDS.PREMIUM_LIFETIME,
  ]),
  light: Object.freeze([
    CAMPAIGN_OFFER_IDS.PREMIUM_ANNUAL,
    CAMPAIGN_OFFER_IDS.PREMIUM_LIFETIME,
  ]),
  premium: Object.freeze([CAMPAIGN_OFFER_IDS.SANRENPUKU_LIFETIME]),
});

/** 特典欄に出す割引の一覧（金額はカタログから） */
export function discountItems(segment) {
  return DISCOUNT_SEGMENT_OFFER_IDS[segment].map(line);
}

/** benefit guard 用の宣言（「何の得があるか」を具体的に書く） */
export function discountBenefitDescription(segment) {
  return `${discountItems(segment).join(' / ')} を${DISCOUNT_DEADLINE}ご案内します`;
}

/** 1 ステップぶんの共通形（`campaignCatalog` の step と同じ形） */
const step = ({
  n, delayDays, angle, name, subject, preheader, badge, headline,
  body, benefitTitle, benefitItems, ctaNote,
}) => ({
  stepNumber: n,
  delayDays,
  angle,
  name,
  subject,
  preheader,
  badge,
  headline,
  body: body.join('\n'),
  benefitTitle,
  benefitItems,
  ctaLabel: DISCOUNT_CTA.label,
  ctaUrl: DISCOUNT_CTA.url,
  ctaNote: ctaNote || DISCOUNT_CTA.note,
  footerNote: FOOTER,
});

// ── 無料 / 期限切れの方（最大の母集団）──────────────────────────────
//
// 3 通。1 通目で割引そのもの、2 通目でプランの違い（何が見られるか）、
// 3 通目で期限のご案内。**同じ文面の繰り返しは定義できない**（検証で落ちる）。
export const DISCOUNT_FREE_STEPS = Object.freeze([
  step({
    n: 1, delayDays: 0, angle: '割引のご案内',
    name: '割引のご案内',
    subject: `【KEIBA Analytics】有料プラン割引のご案内（${DISCOUNT_DEADLINE}）`,
    preheader: 'ご登録いただいている方を対象に、有料プランの割引をご案内しています。',
    badge: '期間限定',
    headline: '有料プラン割引のご案内',
    body: [
      'KEIBA Analytics です。',
      'いつもご登録いただきありがとうございます。',
      '',
      'ご登録いただいている方だけのご優待として、有料プランの割引をご用意しました。',
      'この価格は、ご登録済みの方の画面にだけ表示されます。',
      `${DISCOUNT_DEADLINE}のお申し込みが対象です。`,
      '',
      'ご登録のメールアドレスでログインしていただくと、',
      'マイページのお知らせに割引後の価格が表示され、そのままお申し込みいただけます。',
    ],
    benefitTitle: `割引価格（${DISCOUNT_DEADLINE}）`,
    benefitItems: discountItems('free'),
  }),
  step({
    n: 2, delayDays: 5, angle: 'プランの違い',
    name: 'プランの違い',
    subject: '【KEIBA Analytics】Light と Premium の違いについて',
    preheader: 'どちらを選べばよいかのご参考に、ご覧いただける範囲をまとめました。',
    badge: '',
    headline: 'ご覧いただける範囲の違い',
    body: [
      'KEIBA Analytics です。',
      '',
      '先日ご案内した割引について、どのプランを選べばよいかのご参考に、',
      'それぞれでご覧いただける範囲をお伝えします。',
      '',
      '前日のメインレース買い目とその結果は、的中・不的中を正確なデータとして',
      'そのまま無料で公開しています。実際の中身をご確認いただいたうえで',
      'ご検討いただければ幸いです。',
      '',
      `割引は${DISCOUNT_DEADLINE}のお申し込みが対象です。`,
    ],
    benefitTitle: 'ご覧いただける範囲',
    benefitItems: [
      'Light … 各開催のメインレース買い目を閲覧できます',
      'Premium … 中央（JRA）・南関の有料予想を全会場ご覧いただけます',
      'Premium 買い切り … 一度のお支払いで、継続のお手続きは不要です',
    ],
  }),
  step({
    n: 3, delayDays: 6, angle: '期限のご案内',
    name: '期限のご案内',
    subject: `【KEIBA Analytics】割引のご案内は${DISCOUNT_DEADLINE}です`,
    preheader: 'お申し込みの期限が近づいています。価格は下記のとおりです。',
    badge: '期限のご案内',
    headline: `割引のお申し込みは${DISCOUNT_DEADLINE}です`,
    body: [
      'KEIBA Analytics です。',
      '',
      `先日よりご案内している割引は、${DISCOUNT_DEADLINE}のお申し込みが対象です。`,
      '',
      'ご検討中の方は、ご登録のメールアドレスでログインしていただくと、',
      'マイページのお知らせからそのままお申し込みいただけます。',
      '',
      '期限を過ぎたあとは通常価格でのご案内となります。',
    ],
    benefitTitle: `割引価格（${DISCOUNT_DEADLINE}）`,
    benefitItems: discountItems('free'),
  }),
]);

// ── Light をご利用中の方 ──────────────────────────────────────
//
// ⚠️ Light の割引は**出さない**（すでにお持ちのものを勧めない）。
// お支払いいただいている方なので 2 通に留める。
export const DISCOUNT_LIGHT_STEPS = Object.freeze([
  step({
    n: 1, delayDays: 0, angle: '割引のご案内',
    name: '割引のご案内',
    subject: `【KEIBA Analytics】Premium の割引のご案内（${DISCOUNT_DEADLINE}）`,
    preheader: 'Light をご利用中の方へ、Premium の割引をご案内しています。',
    badge: '期間限定',
    headline: 'Premium の割引のご案内',
    body: [
      'KEIBA Analytics です。',
      'いつも Light プランをご利用いただきありがとうございます。',
      '',
      'Light をご利用いただいている方へのご優待として、Premium の割引をご用意しました。',
      '',
      'Light では各開催のメインレース買い目をご覧いただいていますが、',
      'Premium では中央（JRA）・南関の有料予想を全会場ご覧いただけます。',
      '',
      `${DISCOUNT_DEADLINE}のお申し込みが対象です。`,
    ],
    benefitTitle: `割引価格（${DISCOUNT_DEADLINE}）`,
    benefitItems: discountItems('light'),
  }),
  step({
    n: 2, delayDays: 6, angle: '期限のご案内',
    name: '期限のご案内',
    subject: `【KEIBA Analytics】Premium の割引は${DISCOUNT_DEADLINE}です`,
    preheader: 'お申し込みの期限が近づいています。価格は下記のとおりです。',
    badge: '期限のご案内',
    headline: `Premium の割引は${DISCOUNT_DEADLINE}です`,
    body: [
      'KEIBA Analytics です。',
      '',
      `先日ご案内した Premium の割引は、${DISCOUNT_DEADLINE}のお申し込みが対象です。`,
      '',
      'Light プランはそのままご利用いただけます。',
      '切り替えをご検討中の場合のみ、マイページからお手続きください。',
    ],
    benefitTitle: `割引価格（${DISCOUNT_DEADLINE}）`,
    benefitItems: discountItems('light'),
  }),
]);

// ── Premium をご利用中の方（三連複はお持ちでない）────────────────────
//
// ⚠️ 行き先はマイページのみ。三連複の購入導線は**マイページ内のモーダル**だけで、
//    公開の販売ページは存在しない。
export const DISCOUNT_PREMIUM_STEPS = Object.freeze([
  step({
    n: 1, delayDays: 0, angle: '割引のご案内',
    name: '割引のご案内',
    subject: `【KEIBA Analytics】三連複（買い切り）の割引のご案内（${DISCOUNT_DEADLINE}）`,
    preheader: 'Premium をご利用中の方へ、三連複 買い切りの割引をご案内しています。',
    badge: '期間限定',
    headline: '三連複（買い切り）の割引のご案内',
    body: [
      'KEIBA Analytics です。',
      'いつも Premium プランをご利用いただきありがとうございます。',
      '',
      'Premium をご利用いただいている方だけにご案内している、',
      '三連複予想（買い切り）のご優待です。',
      '',
      '三連複は馬単とは別軸の買い目で、点数を絞って狙う設計です。',
      '買い切りのため、追加のお支払いはありません。',
      '',
      `${DISCOUNT_DEADLINE}のお申し込みが対象です。`,
      'マイページの「三連複を追加」からお手続きいただけます。',
    ],
    benefitTitle: `割引価格（${DISCOUNT_DEADLINE}）`,
    benefitItems: discountItems('premium'),
    ctaNote: 'マイページの「三連複を追加」から、割引後の価格でお申し込みいただけます。',
  }),
  step({
    n: 2, delayDays: 6, angle: '期限のご案内',
    name: '期限のご案内',
    subject: `【KEIBA Analytics】三連複の割引は${DISCOUNT_DEADLINE}です`,
    preheader: 'お申し込みの期限が近づいています。価格は下記のとおりです。',
    badge: '期限のご案内',
    headline: `三連複の割引は${DISCOUNT_DEADLINE}です`,
    body: [
      'KEIBA Analytics です。',
      '',
      `先日ご案内した三連複（買い切り）の割引は、${DISCOUNT_DEADLINE}のお申し込みが対象です。`,
      '',
      'Premium プランはそのままご利用いただけます。',
      '追加をご検討中の場合のみ、マイページの「三連複を追加」からお手続きください。',
    ],
    benefitTitle: `割引価格（${DISCOUNT_DEADLINE}）`,
    benefitItems: discountItems('premium'),
    ctaNote: 'マイページの「三連複を追加」から、割引後の価格でお申し込みいただけます。',
  }),
]);
