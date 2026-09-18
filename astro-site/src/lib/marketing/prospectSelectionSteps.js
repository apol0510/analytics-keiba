/**
 * prospectSelectionSteps.js — prospect 選別配信で **01 / 02 / 03 / 10 に差し替える文面**
 * （純粋・I/O なし）
 *
 * ## なぜ差し替えるのか（2026-09-18 MK 確定 / 案 B）
 *
 * 通し番号 **01・02・03・10** は割引キャンペーンの文面で、
 * 「2026年9月23日まで」という**固定の期限**を含んでいた。選別配信は任意の日に始めるので、
 * 期限つきの文面では「期限を過ぎてから届く」＝**案内は届くのに 1 円も割り引かれない**状態になる
 * （判定は `sendgridSingleSendPlan.checkDeadlineFeasibility()`）。
 *
 * **割引期間（`CAMPAIGN_WINDOW`）はメール都合で延ばさない**（MK 確定）。
 * **10 通で選別する設計も変えない**。よって**選別用に期限の無い文面へ差し替える**。
 *
 * ## 差し替えの範囲（ここが肝）
 *
 * - 差し替えるのは **SendGrid へ渡す本文だけ**
 * - **通し番号 ↔ (campaignId, step) の対応と `DeliveryKey` は 1 バイトも変えない**
 *   → 「誰が何通目まで受け取ったか」の判定は従来どおりで、**next_message は動かない**
 * - **既送信の号は送らない**（list の割り当てが `next_message` なので、
 *   start-N の人は N 通目以降しか受け取らない）
 * - **04〜09 は変更しない**（日付を含まないので、そのまま成立する）
 *
 * ## 書かないもの
 *
 * - 固定の期限・日付（「◯月◯日まで」）
 * - 期限切れの割引を前提にした CTA
 * - 価格の数字（**メールへ金額を書き写さない**。料金は `/pricing/` が正本）
 * - 的中・利益の保証、実績数値の手書き（カタログ検証が落とす）
 *
 * ## 行き先（すべて本番で 200 を確認済み / 2026-09-18）
 *
 * `/free-prediction/jra/` `/free-prediction/nankan/` `/results-showcase/jra/` `/pricing/`
 */

const SITE = 'https://analytics.keiba.link';

/** 差し替え文面の行き先（**推測で URL を作らない**） */
export const SELECTION_LINKS = Object.freeze({
  freeJra: `${SITE}/free-prediction/jra/`,
  freeNankan: `${SITE}/free-prediction/nankan/`,
  showcaseJra: `${SITE}/results-showcase/jra/`,
  pricing: `${SITE}/pricing/`,
});

const FOOTER = 'このメールは、KEIBA Analytics にご登録いただいている方へお送りしています。';

/** `campaignCatalog` の step と同じ形（`renderCampaign` がそのまま描画できる） */
const step = ({
  n, angle, name, subject, preheader, badge, headline,
  body, benefitTitle, benefitItems, ctaLabel, ctaUrl, ctaNote,
}) => Object.freeze({
  messageNumber: n,
  stepNumber: n,
  delayDays: 0,
  angle,
  name,
  subject,
  preheader,
  badge,
  headline,
  body: body.join('\n'),
  benefitTitle,
  benefitItems: Object.freeze(benefitItems),
  ctaLabel,
  ctaUrl,
  ctaNote,
  footerNote: FOOTER,
  /** 権利を渡さない案内（無料で見られる範囲の紹介）*/
  benefitType: 'free_content',
  benefitDescription: '無料でご覧いただける予想ページをご案内します',
});

/**
 * 差し替える通し番号 → 文面。
 *
 * ⚠️ **04〜09 はここに入れない**（変更しないため）。
 * ⚠️ 01〜03 は「この配信は何か」→「中央の予想」→「南関の予想」と役割を分け、
 *    04 以降（無料で見られるもの / 読み方 / 実績 / 使い方 / 有料との違い / 更新）と重ならないようにする。
 */
export const PROSPECT_SELECTION_OVERRIDES = Object.freeze({
  1: step({
    n: 1,
    angle: 'ご挨拶と配信内容',
    name: 'ご挨拶（この配信は何か）',
    subject: '【KEIBA Analytics】無料予想のご案内をお送りします',
    preheader: '中央・南関の無料予想を、数回に分けてご案内します。配信停止はいつでも可能です。',
    badge: 'ごあいさつ',
    headline: '無料予想のご案内をお送りします',
    body: [
      'KEIBA Analytics です。いつもご覧いただきありがとうございます。',
      '',
      'これから数回に分けて、当サイトで無料でご覧いただける予想と、その読み方をご案内します。',
      '中央競馬（JRA）と南関競馬（大井・船橋・浦和・川崎）の両方を毎日公開しており、',
      'お申し込みやご登録をしなくても、そのままご覧いただけます。',
      '',
      'まずは本日のレースをご覧ください。印と指数が一覧で並んでいます。',
      'ご不要の場合は、メール末尾の配信停止からいつでもお手続きいただけます。',
    ],
    /**
     * ⚠️ **着地先で見られるものだけを書く。** 無料予想ページでは買い目を伏せているので、
     *    ここで「買い目」を約束しない（`emailCopyStandard` の
     *    `promise_not_on_landing_page` が落とす）。
     */
    benefitTitle: 'このご案内でお伝えすること',
    benefitItems: [
      '無料でご覧いただける予想の範囲',
      '印と AI 指数の読み方',
      '中央競馬と南関競馬の開催日',
    ],
    ctaLabel: '本日の無料予想を見る',
    ctaUrl: SELECTION_LINKS.freeJra,
    ctaNote: 'ご登録は不要です。そのままご覧いただけます。',
  }),
  2: step({
    n: 2,
    angle: '中央競馬の無料予想',
    name: '中央競馬（JRA）の無料予想',
    subject: '【KEIBA Analytics】中央競馬（JRA）の予想ページのご案内',
    preheader: '開催日の全レースについて、印と AI 指数を無料で公開しています。',
    badge: '中央競馬',
    headline: '中央競馬（JRA）の予想ページ',
    body: [
      'KEIBA Analytics です。いつもご利用ありがとうございます。',
      '',
      '中央競馬（JRA）の予想ページでは、開催日の全レースを一覧でご確認いただけます。',
      '各レースに本命・対抗・単穴・連下といった印が付き、あわせて AI が算出した指数が並びます。',
      '',
      '指数は出走馬ごとの評価を数値にしたもので、印と見比べると各馬の位置づけが分かります。',
      'どの馬が中心に推されているのかを、短時間で確認していただけます。',
      '',
      '本日の開催があるかどうかもページ上でご確認いただけます。',
    ],
    benefitTitle: '無料でご覧いただけるもの',
    /** ⚠️ 着地先（`/free-prediction/`）で伏せているもの（買い目 / AI 総合指数 / 評価ポイント / 全頭の役割）は書かない */
    benefitItems: [
      '開催日の全レースの印',
      '出走馬ごとの AI 指数',
      '開催している会場の一覧',
    ],
    ctaLabel: '中央競馬の無料予想を見る',
    ctaUrl: SELECTION_LINKS.freeJra,
    ctaNote: 'ご登録は不要です。そのままご覧いただけます。',
  }),
  3: step({
    n: 3,
    angle: '南関競馬の無料予想',
    name: '南関競馬の無料予想',
    subject: '【KEIBA Analytics】南関競馬（大井・船橋・浦和・川崎）の予想ページ',
    preheader: '平日の開催もあります。中央がお休みの日もご覧いただけます。',
    badge: '南関競馬',
    headline: '南関競馬の予想ページ',
    body: [
      'KEIBA Analytics です。いつもご利用ありがとうございます。',
      '',
      '当サイトでは南関競馬（大井・船橋・浦和・川崎）の予想も毎開催日に公開しています。',
      '南関競馬は平日の開催があるため、中央競馬がお休みの日もご覧いただけます。',
      '',
      '中央競馬と同じように、各レースの印と AI 指数を一覧でご確認いただけます。',
      '会場ごとにページが分かれており、その日に開催している会場が選べます。',
      '',
      'ナイター開催の日は、仕事終わりの時間帯からでも間に合います。',
    ],
    benefitTitle: '南関競馬のページでご覧いただけるもの',
    benefitItems: [
      '大井・船橋・浦和・川崎の予想',
      '会場ごとの全レース一覧',
      '中央競馬と同じ印と AI 指数',
    ],
    ctaLabel: '南関競馬の無料予想を見る',
    ctaUrl: SELECTION_LINKS.freeNankan,
    ctaNote: 'ご登録は不要です。そのままご覧いただけます。',
  }),
  10: step({
    n: 10,
    angle: '有料プランのご案内',
    name: '有料プランのご案内（最終回）',
    subject: '【KEIBA Analytics】有料プランでご覧いただける内容について',
    preheader: '無料版との違いと、料金ページのご案内です。今回でこのご案内は最後になります。',
    badge: 'ご案内',
    headline: '有料プランでご覧いただける内容',
    body: [
      'KEIBA Analytics です。いつもご利用ありがとうございます。',
      'ここまで数回にわたってご案内をお送りしてまいりました。',
      '',
      '無料版では、印と一部の情報を公開しています。',
      '有料プランでは、これに加えて買い目と各馬の役割をすべてご覧いただけます。',
      '対象も中央競馬と南関競馬の両方に広がります。',
      '',
      'プランごとの内容と料金は、料金ページに最新の情報を掲載しています。',
      '無料のままご利用いただいても構いません。今後も無料予想は毎日公開します。',
      '',
      'このご案内は今回で最後です。引き続きのご利用をお待ちしております。',
    ],
    benefitTitle: '有料プランで増えるもの',
    /** ⚠️ 着地先（`/pricing/`）で伏せているもの（AI 総合指数 / 過去走 / 不要馬）は書かない */
    benefitItems: [
      'レースごとの買い目',
      '出走馬すべての役割',
      '中央競馬と南関競馬の両方',
    ],
    ctaLabel: 'プランの内容と料金を見る',
    ctaUrl: SELECTION_LINKS.pricing,
    ctaNote: '最新の料金は料金ページでご確認いただけます。',
  }),
});

/** 差し替える通し番号（**04〜09 は含まない**） */
export const OVERRIDDEN_MESSAGE_NUMBERS = Object.freeze(
  Object.keys(PROSPECT_SELECTION_OVERRIDES).map(Number).sort((a, b) => a - b),
);

/** 固定の日付・期限が含まれていないか（**差し替えの目的そのもの**） */
export const DATE_PATTERN = /\d{1,4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}/;

export function hasFixedDate(stepLike) {
  const s = stepLike || {};
  const text = [s.subject, s.preheader, s.headline, s.body, s.ctaLabel, s.ctaNote, s.footerNote]
    .concat(Array.isArray(s.benefitItems) ? s.benefitItems : [])
    .map((v) => String(v || '')).join('\n');
  return DATE_PATTERN.test(text);
}

export default PROSPECT_SELECTION_OVERRIDES;
