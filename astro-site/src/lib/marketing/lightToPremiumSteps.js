/**
 * lightToPremiumSteps.js — **Light ご利用中 → Premium** の育成 4 通（文面の単一源）
 *
 * ── 文面はどこから来たか（新しい営業訴求を作っていない）──────────────
 * 訴求の骨組みは承認済みの `postExpirySteps.js`（無料体験 終了後フェーズ 18 通）から
 * **前提に依存しない回だけ**を選んで流用した:
 *
 *   Step1 ← 終了後 Step9  「見られる範囲の違い」
 *   Step2 ← 終了後 Step10 「料金の考え方」
 *   Step3 ← 終了後 Step13 「直近の買い目と結果」
 *   Step4 ← 終了後 Step17 「続けてご覧になる場合」
 *
 * ── 2026-09-15 コピー基準の適用（`docs/EMAIL_COPY_STANDARD.md`）──────────
 * 4 通とも**未送信**（`LOCKED.delivered: []`）なので、ルール (C) に触れずに改稿できる。
 *
 * | 直した点 | 理由 |
 * |---|---|
 * | 冒頭に「Light をご利用中の方へ」の文脈を置いた | なぜこの案内が届いたのかが読めなかった（基準 1）|
 * | 「Light はそのままご利用いただけます」を明示 | 乗り換えを迫られていると読まれないようにした（基準 3）|
 * | CTA を「Premium で見られる範囲を確認する」等へ | 「プランの内容を確認する」が 4 通中 2 回重複していた（基準 5・6）|
 * | preheader を本文の複製から変更 | 受信箱の一覧で開く理由が増えていなかった（基準 6）|
 * | **Step4「内容と料金はプランのページが正本です。メールには書いていません。」を削除** | 顧客向けの文面に内部運用の語を出さない（基準 7 / `docs/spec.md`）|
 *
 * ⚠️ **配信対象・順序・間隔（`delayDays`）・`campaignId`・`version` は 1 つも変えていない。**
 *
 * ⚠️ **価格を書かない**（`/pricing/` に最新が出る）。**実績数値を書かない**（ページへ誘導する）。
 * ⚠️ 「Light から Premium へ変えると残期間がどうなるか」は**書かない**。
 *    その扱いは既存の仕様に無く、書くと新しい営業事実を作ることになる。
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
  // ── 最初の接点（最重要）────────────────────────────────────
  step({
    n: 1, delayDays: 0, angle: 'Premium との差',
    name: '見られる範囲の違い',
    subject: '【KEIBA Analytics】Light と Premium で見られる範囲の違い',
    preheader: '違うのはレース数と情報の範囲だけで、買い目の作り方は同じです。',
    badge: 'プラン',
    headline: 'プランによる違いはレース数と範囲です',
    body: [
      'いつも Light プランをご利用いただきありがとうございます。',
      '',
      'Light では、各開催のメインレース買い目をご覧いただいています。',
      'Premium との違いをお伝えしておきます。',
      '',
      '違うのは、ご覧いただけるレース数と情報の範囲です。',
      '買い目の作り方や指数の出し方はどのプランでも同じで、',
      '上位プランだから点数が増える、という作りにはしていません。',
      '',
      'Premium では、中央（JRA）・南関の有料予想を全会場ご覧いただけます。',
      '',
      'Light プランはそのままご利用いただけます。',
      'レース数を増やしたくなったときの選択肢として、お読みいただければ十分です。',
    ],
    benefitTitle: 'プランごとの違い',
    benefitItems: [
      '見られるレース数',
      '見られる情報の範囲',
      '対象の開催（中央 / 南関）',
    ],
    ctaLabel: 'Premium で見られる範囲を確認する',
    ctaUrl: `${SITE}/pricing/`,
    ctaNote: 'プランごとにご覧いただける範囲と料金が並べて出ています。',
  }),
  step({
    n: 2, delayDays: 7, angle: '料金の考え方',
    name: '料金の考え方',
    subject: '【KEIBA Analytics】料金は「見る量」で選んでください',
    preheader: '当たれば元が取れる、という書き方はしません。判断の材料をご案内します。',
    badge: '料金',
    headline: '料金は「見る量」で選んでください',
    body: [
      'Light プランをご利用中の方へ、料金の考え方をお伝えします。',
      '',
      '「当たれば元が取れる」という書き方はしません。結果は保証できないためです。',
      '',
      'ご判断いただく材料は 2 つあると考えています。',
      'ひとつは、ご覧になりたいレース数。もうひとつは、これまでの結果です。',
      '',
      '結果は当たった日も外した日も残していますので、',
      'ご自身で確かめてからお決めください。',
      '',
      'いま増やす必要が無ければ、Light のままご利用いただいて構いません。',
    ],
    benefitTitle: '決める前に見るもの',
    benefitItems: [
      'ご覧になりたいレース数',
      '過去の買い目と結果',
      'プランごとの範囲',
    ],
    ctaLabel: 'プランごとの料金を確認する',
    ctaUrl: `${SITE}/pricing/`,
    ctaNote: '過去の買い目と結果は無料のページでも確かめられます。',
  }),
  step({
    n: 3, delayDays: 7, angle: '成績の確認',
    name: '直近の買い目と結果',
    subject: '【KEIBA Analytics】前日の買い目と結果を毎日公開しています',
    preheader: '的中した日も外した日も、そのまま並べて残しています。',
    badge: '記録',
    headline: '直近の記録をご確認いただけます',
    body: [
      'Light プランをご利用中の方へ、記録の見方をご案内します。',
      '',
      '前日にお届けしたメインレースの買い目と結果を、毎日更新しています。',
      '的中した日だけを選んで出すことはしていません。',
      '',
      'Premium をご検討いただく場合も、まずはこの記録をご覧いただくのが確実です。',
      '',
      '中央（JRA）は土日、南関は平日にも開催があるため、',
      '最新日がそれぞれ違う日付になることがあります。',
    ],
    benefitTitle: '確認できること',
    benefitItems: [
      '前日の買い目',
      '的中・不的中',
      '払戻（的中時）',
    ],
    ctaLabel: '南関の前日の買い目と結果を見る',
    ctaUrl: `${SITE}/results-showcase/nankan/`,
    ctaNote: '中央（JRA）のページも同じ作りでご覧いただけます。',
  }),
  step({
    n: 4, delayDays: 7, angle: '継続の提案',
    name: 'レース数を増やしたい場合',
    subject: '【KEIBA Analytics】見るレース数を増やしたい場合のご案内',
    preheader: '増やす必要が無ければ、このままお読み飛ばしいただいて構いません。',
    badge: 'ご検討',
    headline: 'レース数を増やしたい場合',
    body: [
      'Light プランをご利用中の方から、',
      'もっと多くのレースを見たい、という声をいただくことがあります。',
      '',
      'ご覧いただけるレース数を増やす場合は、Premium をご検討ください。',
      '買い目の作り方は変わりません。増えるのは対象のレース数と情報の範囲です。',
      '',
      'いまのままで足りている場合は、お手続きは何も必要ありません。',
      'Light プランはそのままご利用いただけます。',
      '',
      'ご覧いただける範囲と料金は、プランのページでご確認いただけます。',
    ],
    benefitTitle: 'ご検討の材料',
    benefitItems: [
      'ご覧になりたいレース数',
      'これまでの買い目と結果',
      'プランごとの範囲',
    ],
    ctaLabel: 'Premium の範囲と料金を確認する',
    ctaUrl: `${SITE}/pricing/`,
    ctaNote: 'ご不明な点はこのメールへの返信でお問い合わせいただけます。',
  }),
]);

export default LIGHT_TO_PREMIUM_STEPS;
