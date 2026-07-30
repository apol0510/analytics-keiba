/**
 * comebackEmailTemplate.js — カムバック案内メールの本文を **offer の内容から生成**する（純粋）
 *
 * 文面を手書きしない。管理者が選んだ特典（Light の無料権利 / Premium の無料 or 割引）を
 * そのまま文章にする。金額・期間を書き間違える余地を無くすため。
 *
 * ── 表現のルール（守ること）──────────────────────────────────────
 *   ✅ 「その後も継続的に改善を重ね、現在の KEIBA Analytics を改めてお試しいただきたい」
 *   ❌ 「以前は未完成でした」「以前のサービスは物足りないものでした」等の**自社否定**
 *   ❌ 的中率・回収率の数値（根拠のない数値は書かない）
 *   ❌ 煽り・カウントダウン・「今だけ」の繰り返し
 *   ❌ 配信停止リンク（送信基盤が全通に自動付与する。二重に出さない）
 *
 * ── メールは grant / offer の作成とは別操作 ─────────────────────────
 * このモジュールは**文面を作るだけ**で、送信も付与もしない。
 * 付与・発行が完了した顧客にだけ、管理者がマーケティングタブから送る。
 */

import { OFFER_KIND, BILLING_TERM } from './promotionOfferCatalog.js';
import { PROMO_TIER } from '../entitlements/promotionalGrants.js';

const SITE = 'https://analytics.keiba.link';

/** 金額表記（¥49,800） */
export function yen(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `¥${Math.round(v).toLocaleString('en-US')}` : '';
}

function termLabel(term) {
  if (term === BILLING_TERM.LIFETIME) return '買い切り（永久アクセス）';
  if (term === BILLING_TERM.ANNUAL) return '年額';
  if (term === BILLING_TERM.MONTHLY) return '30日';
  return '';
}

/** 無料権利 1 件の説明行 */
function grantLine(offer) {
  const tier = offer.targetTier === PROMO_TIER.LIGHT ? 'Light プラン' : 'Premium プラン';
  if (offer.isLifetime) return `・${tier}を **無期限で無料** でご利用いただけます`;
  return `・${tier}を **${offer.duration}日間 無料** でご利用いただけます`;
}

/** 割引 1 件の説明行 */
function purchaseLine(offer) {
  const t = termLabel(offer.term);
  return `・Premium プラン（${t}）を 通常 ${yen(offer.regularPrice)} のところ `
    + `**${yen(offer.offerPrice)}** でご利用いただけます`;
}

/**
 * 案内メールの件名・本文を作る。
 *
 * @param {{
 *   grantOffers?: object[],     無料付与した offer（resolveOffer の .offer）
 *   purchaseOffer?: object|null 発行した割引 offer
 *   offerUrl?: string,          割引 offer の申込 URL（トークン付き。無ければ /pricing/ を案内しない）
 *   offerExpiresText?: string,  割引 offer の有効期限（'2026-08-13' 等）
 * }} input
 * @returns {{ subject: string, body: string }|null}
 */
export function buildComebackEmailContent({ grantOffers, purchaseOffer, offerUrl, offerExpiresText } = {}) {
  const grants = (grantOffers || []).filter((o) => o && o.kind === OFFER_KIND.GRANT);
  const purchase = purchaseOffer && purchaseOffer.kind === OFFER_KIND.PURCHASE ? purchaseOffer : null;
  if (grants.length === 0 && !purchase) return null;

  // 件名は「何がもらえるか」を 1 つだけ言う（複数並べると読みにくい）
  const lead = grants.find((o) => o.targetTier === PROMO_TIER.LIGHT) || grants[0];
  const subject = lead
    ? (lead.isLifetime
      ? `【KEIBA Analytics】${lead.targetTier === PROMO_TIER.LIGHT ? 'Light' : 'Premium'}プランを無料でご利用いただけます`
      : `【KEIBA Analytics】${lead.targetTier === PROMO_TIER.LIGHT ? 'Light' : 'Premium'}プランを${lead.duration}日間 無料でご利用いただけます`)
    : '【KEIBA Analytics】Premium プランの特別価格のご案内';

  const lines = [
    '{{salutation}}',
    '',
    'KEIBA Analytics をご利用いただきありがとうございました。',
    '',
    'ご利用いただいていた頃から、その後も継続的に改善を重ねてまいりました。',
    '本命・対抗・単穴の選定ロジックと買い目の組み方を見直し、',
    '前日の有料メインレース買い目と結果は、当たった日も外した日も毎日公開しています。',
    '',
    '現在の KEIBA Analytics を改めてお試しいただきたく、',
    'お客様にはこちらをご用意しました。',
    '',
  ];

  for (const g of grants) lines.push(grantLine(g));
  if (purchase) lines.push(purchaseLine(purchase));
  lines.push('');

  if (grants.length > 0) {
    lines.push('無料でご利用いただける分は、お手続きもお支払いも必要ありません。');
    lines.push('いつものメールアドレスでログインするだけでご覧いただけます。');
  }
  if (purchase) {
    lines.push('');
    lines.push('特別価格でのお申し込みは、お客様専用のご案内ページからお進みください。');
    if (offerExpiresText) lines.push(`（${offerExpiresText} までにお手続きください）`);
  }

  // Light を無料開放したときは、Light が何を見られるプランかを明示する（期待値のズレ防止）
  if (grants.some((o) => o.targetTier === PROMO_TIER.LIGHT)) {
    lines.push('');
    lines.push('※ Light プランでは各開催のメインレース買い目をご覧いただけます。');
  }
  if (grants.some((o) => o.targetTier === PROMO_TIER.PREMIUM && !o.isLifetime)) {
    const p = grants.find((o) => o.targetTier === PROMO_TIER.PREMIUM && !o.isLifetime);
    lines.push('');
    lines.push(`※ Premium プランの無料期間は ${p.duration} 日間です。`);
    if (grants.some((o) => o.targetTier === PROMO_TIER.LIGHT && o.isLifetime)) {
      lines.push('　 期間終了後も Light プランは無料のままご利用いただけます。');
    }
  }

  return {
    subject,
    body: lines.join('\n'),
    ctaLabel: purchase && offerUrl ? '特別価格の詳細を見る' : 'ログインして予想を見る',
    ctaUrl: purchase && offerUrl ? offerUrl : `${SITE}/login/`,
  };
}

/**
 * campaignCatalog の下書き（`comeback-offer`）が使う既定の組み合わせ。
 * **Light 永久無料をベースに、Premium 30日無料を上乗せ**した今回の主要施策。
 * 本文をここから生成するので、カタログ側に文面を二重に持たない。
 */
export const DEFAULT_COMEBACK_COMBO = Object.freeze({
  grantOffers: [
    Object.freeze({
      kind: OFFER_KIND.GRANT, targetTier: PROMO_TIER.LIGHT,
      isLifetime: true, duration: null,
    }),
    Object.freeze({
      kind: OFFER_KIND.GRANT, targetTier: PROMO_TIER.PREMIUM,
      isLifetime: false, duration: 30,
    }),
  ],
  purchaseOffer: null,
});
