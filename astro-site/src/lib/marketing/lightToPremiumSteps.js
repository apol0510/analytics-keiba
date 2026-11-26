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
 * ── 2026-11-25 MK 決定（共通 A-2）で 4 通を書き直した ─────────────────
 * 的中・好走を主役にする。「当たれば元が取れる、という書き方はしません」
 * 「外した日もそのまま」「選んで出すことはしていません」のような、魅力を打ち消す書き方をやめた。
 * 全件の結果と算定ルールは実績ページ（/results-showcase/・/archive/）に置く。
 * ⚠️ version は 1 のまま（ルール (D)・`campaignCatalog.js`）。DeliveryKey は本文を含まないので、
 *    既に受け取った人へは再送されず、新しい受信者とまだ届いていない step にだけ新しい文面が届く。
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
    subject: '【KEIBA Analytics】Premium なら、的中を狙えるレースが全会場に広がります',
    preheader: 'メインレースと同じ作り方の買い目を、中央・南関の全会場で。',
    badge: 'プラン',
    headline: 'Premium は、的中を狙えるレースが増えるプランです',
    body: [
      'いつも Light プランをご利用いただきありがとうございます。',
      '',
      'Light では、各開催のメインレース買い目をご覧いただいています。',
      'Premium では、同じ作り方の買い目を、中央（JRA）・南関の全会場でご覧いただけます。',
      '',
      '買い目の作り方や指数の出し方は、どのプランでも同じです。',
      'Premium で増えるのは、的中を狙えるレースの数と、ご覧いただける情報の範囲です。',
      '',
      'メインレース以外にも、好配当のチャンスは毎日あります。',
      '「このレースも見ておけばよかった」を減らしたい方に、Premium をおすすめします。',
    ],
    benefitTitle: 'Premium で広がること',
    benefitItems: [
      '中央（JRA）・南関の全会場の買い目',
      'メインレース以外の的中チャンス',
      'レースごとの詳しい予想情報',
    ],
    ctaLabel: 'Premium で見られる範囲を確認する',
    ctaUrl: `${SITE}/pricing/`,
    ctaNote: 'プランごとにご覧いただける範囲と料金が並んでいます。',
  }),
  step({
    n: 2, delayDays: 7, angle: '料金の考え方',
    name: '料金の考え方',
    subject: '【KEIBA Analytics】プランは「狙いたいレースの数」で選べます',
    preheader: '有料版の的中レースは、払戻とあわせて毎日公開しています。',
    badge: '料金',
    headline: 'プランは「狙いたいレースの数」で選べます',
    body: [
      'Light プランをご利用中の方へ、プランの選び方をお伝えします。',
      '',
      '選ぶ基準はシンプルで、狙いたいレースの数です。',
      'メインレースに絞って楽しむなら Light、全会場のレースで的中を狙うなら Premium です。',
      '',
      '有料版でお届けした買い目が的中したレースは、払戻とあわせて毎日公開しています。',
      'どのレースで、どれだけの払戻になったのか。実際の的中をご覧いただくと、',
      'Premium で増えるレースの価値がつかみやすくなります。',
    ],
    benefitTitle: '選ぶときの目安',
    benefitItems: [
      '狙いたいレースの数',
      '有料版の的中と払戻',
      'プランごとの範囲',
    ],
    ctaLabel: 'プランごとの料金を確認する',
    ctaUrl: `${SITE}/pricing/`,
    ctaNote: '有料版の的中と払戻は、無料のページでもご覧いただけます。',
  }),
  step({
    n: 3, delayDays: 7, angle: '成績の確認',
    name: '直近の的中',
    subject: '【KEIBA Analytics】昨日の有料版、どのレースで的中したかご覧ください',
    preheader: '有料会員へお届けしたメインレースの買い目と払戻を公開しています。',
    badge: '的中',
    headline: '有料版の的中を、毎日公開しています',
    body: [
      'Light プランをご利用中の方へ、直近の的中のご案内です。',
      '',
      '前日に有料会員へお届けしたメインレースの買い目を、払戻とあわせて毎日更新しています。',
      '「この買い目を買っていたら、いくらになったか」がひと目で分かるページです。',
      '',
      'Premium なら、この買い目と同じ作り方の予想を全会場でご覧いただけます。',
      '',
      '中央（JRA）は土日、南関は平日にも開催があるため、',
      '最新日がそれぞれ違う日付になることがあります。',
    ],
    benefitTitle: '確認できること',
    benefitItems: [
      '前日のメインレース買い目',
      '的中したレースと払戻',
      '中央・南関それぞれの最新日',
    ],
    ctaLabel: '南関の前日の的中と買い目を見る',
    ctaUrl: `${SITE}/results-showcase/nankan/`,
    ctaNote: '中央（JRA）のページも同じ作りでご覧いただけます。',
  }),
  step({
    n: 4, delayDays: 7, angle: '継続の提案',
    name: 'レース数を増やしたい場合',
    subject: '【KEIBA Analytics】的中を狙えるレースを、全会場に広げませんか',
    preheader: 'Premium なら、中央・南関の全会場の買い目をご覧いただけます。',
    badge: 'ご案内',
    headline: '的中を狙えるレースを増やしたい方へ',
    body: [
      'Light プランをご利用中の方から、',
      'もっと多くのレースで的中を狙いたい、という声をいただいています。',
      '',
      'Premium では、メインレースと同じ作り方の買い目を、',
      '中央（JRA）・南関の全会場でご覧いただけます。',
      '見られるレースが増えるほど、好配当に出会えるチャンスも増えます。',
      '',
      '前日の的中と払戻は、実績のページで毎日更新しています。',
      'ご覧いただける範囲と料金は、プランのページでご確認いただけます。',
    ],
    benefitTitle: 'Premium で広がること',
    benefitItems: [
      '中央・南関の全会場の買い目',
      'メインレース以外の的中チャンス',
      'プランごとの範囲と料金',
    ],
    ctaLabel: 'Premium の範囲と料金を確認する',
    ctaUrl: `${SITE}/pricing/`,
    ctaNote: 'ご不明な点はこのメールへの返信でお問い合わせいただけます。',
  }),
]);

export default LIGHT_TO_PREMIUM_STEPS;
