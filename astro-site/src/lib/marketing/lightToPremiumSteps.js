/**
 * lightToPremiumSteps.js — **Light ご利用中 → Premium** の育成 4 通（文面の単一源）
 *
 * ── 文面はどこから来たか（新しい営業訴求を作っていない）──────────────
 * 既に承認済みの `postExpirySteps.js`（無料体験 終了後フェーズ 18 通）から
 * **前提に依存しない回だけ**を選んで流用した:
 *
 *   Step1 ← 終了後 Step9  「見られる範囲の違い」
 *   Step2 ← 終了後 Step10 「料金の考え方」      （**無編集**）
 *   Step3 ← 終了後 Step13 「直近の買い目と結果」（**無編集**）
 *   Step4 ← 終了後 Step17 「続けてご覧になる場合」
 *
 * ── 編集したのは前提の 1 行だけ（各 2 箇所）──────────────────────
 * 元は「無料会員（体験が終わった人）」向けなので、そのままでは Light
 * ご利用中の方に**事実と食い違う**。次の 2 行だけを差し替えた:
 *
 * | 元 | 直した | 理由 |
 * |---|---|---|
 * | Step1 末尾「無料会員のままでも、無料予想と前日の結果はご覧いただけます。」| 「Light では、各開催のメインレース買い目をご覧いただけます。」| 受信者は無料会員ではない。Light の範囲は `light-trial-to-premium-sequence` Step1 の承認済み記述に合わせた |
 * | Step4 冒頭「無料予想だけでは物足りない、という声をいただくことがあります。」| 「もっと多くのレースをご覧になりたい、という声をいただくことがあります。」| 同上（前提を中立にしただけで、訴求は変えていない）|
 *
 * ⚠️ **価格を書かない**（`/pricing/` が正本）。**実績数値を書かない**（ページへ誘導する）。
 * ⚠️ 「Light から Premium へ変えると残期間がどうなるか」は**書かない**。
 *    その扱いは既存の正本に無く、書くと新しい営業事実を作ることになる。
 * ⚠️ 本文に配信停止リンクを書かない（送信基盤が全通に自動付与する）。
 */

const SITE = 'https://analytics.keiba.link';

/** 訴求角度（連投を避けるための札。終了後フェーズと同じ語彙） */
export const LIGHT_TO_PREMIUM_ANGLES = Object.freeze([
  'Premium との差', '料金の考え方', '成績の確認', '継続の提案',
]);

const step = ({
  n, delayDays, angle, name, subject, preheader, badge, headline,
  body, benefitTitle, benefitItems, ctaLabel, ctaUrl, ctaNote,
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
  ctaLabel,
  ctaUrl,
  ctaNote,
  /** 新しい権利は付かない。**通常は有料の範囲の案内** */
  benefitType: 'content_unlock',
  benefitDescription: 'Premium では中央（JRA）・南関の有料予想を全会場ご覧いただけます',
});

export const LIGHT_TO_PREMIUM_STEPS = Object.freeze([
  step({
    n: 1, delayDays: 0, angle: 'Premium との差',
    name: '見られる範囲の違い',
    subject: '【KEIBA Analytics】プランごとにご覧いただける範囲',
    preheader: '違いは「レース数」と「情報の範囲」です。買い目の作り方は同じです。',
    badge: 'プラン',
    headline: 'プランによる違いはレース数と範囲です',
    body: [
      'プランによる違いは、ご覧いただけるレース数と情報の範囲です。',
      '',
      '買い目の作り方や指数の出し方はどのプランでも同じで、',
      '上位プランだから点数が増える、という作りにはしていません。',
      '',
      // ⚠️ 元は「無料会員のままでも…」。受信者は Light ご利用中なので事実に合わせた
      'Light では、各開催のメインレース買い目をご覧いただけます。',
    ],
    benefitTitle: 'プランごとの違い',
    benefitItems: ['見られるレース数', '見られる情報の範囲', '対象の開催（中央 / 南関）'],
    ctaLabel: 'プランの内容を確認する',
    ctaUrl: `${SITE}/pricing/`,
    ctaNote: '内容と料金はこちらのページが最新です。',
  }),
  // ── 以下 2 通は前提に依存しないため **1 文字も変えていない** ──────────
  step({
    n: 2, delayDays: 7, angle: '料金の考え方',
    name: '料金の考え方',
    subject: '【KEIBA Analytics】料金についての考え方',
    preheader: '当たれば元が取れる、という書き方はしません。判断の材料をご案内します。',
    badge: '料金',
    headline: '料金は「見る量」で選んでください',
    body: [
      '「当たれば元が取れる」という書き方はしません。結果は保証できないためです。',
      '',
      'ご判断いただく材料は 2 つあると考えています。',
      'ひとつは、ご覧になりたいレース数。もうひとつは、これまでの結果です。',
      '',
      '結果は当たった日も外した日も残していますので、',
      'ご自身で確かめてからお決めください。',
    ],
    benefitTitle: '決める前に見るもの',
    benefitItems: ['ご覧になりたいレース数', '過去の買い目と結果', 'プランごとの範囲'],
    ctaLabel: '料金を確認する',
    ctaUrl: `${SITE}/pricing/`,
    ctaNote: '過去の買い目と結果は無料のページで確かめられます。',
  }),
  step({
    n: 3, delayDays: 7, angle: '成績の確認',
    name: '直近の買い目と結果',
    subject: '【KEIBA Analytics】直近の買い目と結果',
    preheader: '毎日更新しています。的中も不的中もそのまま出しています。',
    badge: '記録',
    headline: '直近の記録をご確認いただけます',
    body: [
      '前日にお届けしたメインレースの買い目と結果を、毎日更新しています。',
      '',
      '数字はページのものが最新です。メールには書き写していません。',
      '',
      '中央（JRA）は土日、南関は平日にも開催があるため、',
      '最新日がそれぞれ違う日付になることがあります。',
    ],
    benefitTitle: '確認できること',
    benefitItems: ['前日の買い目', '的中・不的中', '払戻（的中時）'],
    ctaLabel: '南関の結果を見る',
    ctaUrl: `${SITE}/results-showcase/nankan/`,
    ctaNote: '中央のページも同じ作りです。',
  }),
  step({
    n: 4, delayDays: 7, angle: '継続の提案',
    name: 'レース数を増やしたい場合',
    subject: '【KEIBA Analytics】ご覧になるレース数を増やす場合のご案内',
    preheader: 'レース数を増やしたい場合のプランをご案内します。',
    badge: 'ご検討',
    headline: 'レース数を増やしたい場合',
    body: [
      // ⚠️ 元は「無料予想だけでは物足りない…」。前提を中立にしただけ
      'もっと多くのレースをご覧になりたい、という声をいただくことがあります。',
      '',
      'ご覧いただけるレース数を増やす場合は、有料プランをご検討ください。',
      '買い目の作り方は変わりません。増えるのは対象のレース数と情報の範囲です。',
      '',
      '内容と料金はプランのページが正本です。メールには書いていません。',
    ],
    benefitTitle: 'ご検討の材料',
    benefitItems: ['ご覧になりたいレース数', 'これまでの買い目と結果', 'プランごとの範囲'],
    ctaLabel: 'プランの内容を確認する',
    ctaUrl: `${SITE}/pricing/`,
    ctaNote: 'ご不明な点はこのメールへの返信でお問い合わせいただけます。',
  }),
]);

export default LIGHT_TO_PREMIUM_STEPS;
