/**
 * prospectPhase2Steps.js — prospect 向け**第 2 期 7 通**の文面（純粋・I/O なし）
 *
 * ## なぜ要るか（2026-09-15 確定）
 *
 * 最上位任務は「**delivered 累計 10 通まで無反応だった prospect を EXHAUSTED にし、
 * 以後の通常マーケティングから自動で除外する**」こと。打ち切りの分母は
 * `prospectEngagement.resolveProspectCutoff()` の **delivered 10 通**（正本は
 * `engagementPolicy.js`）で、**キャンペーン単位ではなく「その人」に積む**。
 *
 * ところが有効な campaign の step 数を実測すると
 *
 *   `campaign-discount-free` … 3 通（prospect が受け取れるのはこれだけ）
 *   `campaign-discount-light` / `-premium` … Customers 由来の audience
 *
 * で、**prospect は 3 通までしか届かず 10 に到達しない**。
 * 正本 `ENGAGEMENT_SUPPRESSION.md` も
 * 「1 本 3 通のキャンペーンでは 10 通に届かないので、**複数キャンペーンを通じて**
 * 初めて打ち切りが起きる（これが意図どおり）」と書いている。
 *
 * そこで **第 1 期 3 通の後段**として、prospect 専用の第 2 期 7 通を置く。
 * 3 + 7 = **10** で、無反応なら 10 通目の delivered で打ち切りに達する。
 *
 * ## 書き方の決まり（既存の正本に従う）
 *
 * ⚠️ **金額・割引・商品条件をここで新しく決めない。** 価格を書き写すとサイトとズレる
 *    （2026-08-25 の申込モーダル事故）。金額に触れる回は
 *    `campaignDiscountSteps.js` の導出（`discountItems` / `DISCOUNT_DEADLINE`）を使う。
 * ⚠️ **実績数値を手書きしない**（`HARDCODED_STAT` が落とす）。実データのページへ誘導する。
 * ⚠️ 的中・利益の保証、煽りは書かない（`FORBIDDEN_PHRASES`）。
 * ⚠️ 配信停止リンクは書かない（送信基盤が自動で付ける）。
 * ⚠️ **件名・本文は 1 通たりとも重複させない**（`validateSequence` が同一を落とす）。
 *
 * ## 7 通の役割（重複させない）
 *
 * | step | 役割 |
 * |---|---|
 * | 4 | 無料で見られるもの（まず使ってもらう）|
 * | 5 | 予想の読み方（指数・印の意味）|
 * | 6 | 実績の見かた（アーカイブで確かめてもらう）|
 * | 7 | 使い方（会場・レースの選び方）|
 * | 8 | 有料で増えるもの（無料との違い）|
 * | 9 | 続けて見る価値（再訪の理由）|
 * | 10 | 最後のご案内（有料導線・割引は導出値）|
 *
 * ⚠️ step 番号は**第 1 期の続き**ではなく、この campaign の中で 1〜7。
 *    「累計 10 通目」は prospect レコードの `delivered` が数える（step 番号ではない）。
 */

import { discountItems, DISCOUNT_DEADLINE, DISCOUNT_CTA } from './campaignDiscountSteps.js';

const SITE = 'https://analytics.keiba.link';

const FOOTER = 'このメールは、KEIBA Analytics にご登録いただいている方へお送りしています。';

/** 無料で見られるページ（推測で URL を作らない・実在する入口だけ） */
export const PHASE2_LINKS = Object.freeze({
  freeJra: `${SITE}/free-prediction/jra/`,
  freeNankan: `${SITE}/free-prediction/nankan/`,
  showcaseJra: `${SITE}/results-showcase/jra/`,
  showcaseNankan: `${SITE}/results-showcase/nankan/`,
  dashboard: `${SITE}/dashboard/`,
});

/** 1 ステップぶんの共通形（`campaignDiscountSteps.js` の `step` と同じ形） */
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
  footerNote: FOOTER,
});

/** 無料ページを見に行く CTA（大半の回はここ。売り込みを毎回しない） */
const LOOK_CTA = Object.freeze({
  label: '今日の無料予想を見る',
  url: PHASE2_LINKS.freeJra,
  note: 'ご登録は不要です。そのままご覧いただけます。',
});

export const PROSPECT_PHASE2_STEPS = Object.freeze([
  step({
    n: 1, delayDays: 0, angle: '無料で見られるもの',
    name: '無料で見られるもの',
    subject: '【KEIBA Analytics】無料でご覧いただける予想のご案内',
    preheader: '中央・南関の予想を、ご登録なしでご覧いただけます。',
    badge: '無料',
    headline: '無料でご覧いただける予想',
    body: [
      'KEIBA Analytics です。',
      '',
      '当サイトでは、中央競馬（JRA）と南関競馬の予想を無料で公開しています。',
      'お申し込みやご登録をしなくても、そのままご覧いただけます。',
      '',
      '本命・対抗・単穴といった印と、AI が算出した指数を一覧でご確認いただけます。',
      'まずは今日のレースをご覧ください。',
    ],
    benefitTitle: '無料でご覧いただけるもの',
    benefitItems: [
      '中央競馬（JRA）の予想',
      '南関競馬（大井・船橋・浦和・川崎）の予想',
      '各馬の印と AI 指数',
    ],
    ctaLabel: LOOK_CTA.label, ctaUrl: LOOK_CTA.url, ctaNote: LOOK_CTA.note,
  }),
  step({
    n: 2, delayDays: 3, angle: '予想の読み方',
    name: '予想の読み方',
    subject: '【KEIBA Analytics】印と指数の見かたについて',
    preheader: '本命・対抗・単穴と AI 指数が、それぞれ何を表しているかのご説明です。',
    badge: '読みかた',
    headline: '印と指数は何を表しているか',
    body: [
      '予想ページに並んでいる印と数字について、簡単にご説明します。',
      '',
      '印（本命・対抗・単穴・連下）は、その馬の役割を表しています。',
      '横に出ている AI 指数は、複数の要素をまとめて数値にしたものです。',
      '',
      '指数が高いほど上位に評価している、という見かたで問題ありません。',
      '印と指数が食い違っているレースは、荒れる可能性を示していることがあります。',
      '',
      '実際の画面で見ていただくのが分かりやすいので、今日のレースでお試しください。',
    ],
    benefitTitle: 'ご確認いただけること',
    benefitItems: ['印の意味', 'AI 指数の見かた', '印と指数が食い違うレース'],
    ctaLabel: LOOK_CTA.label, ctaUrl: LOOK_CTA.url, ctaNote: LOOK_CTA.note,
  }),
  step({
    n: 3, delayDays: 4, angle: '実績の見かた',
    name: '実績の見かた',
    subject: '【KEIBA Analytics】前日の買い目と結果を公開しています',
    preheader: '有料版で配信したメインレースの買い目と、その結果をご覧いただけます。',
    badge: '実績',
    headline: '前日の買い目と結果',
    body: [
      '「当たっているのか」は、実際の記録でご確認いただくのが確実です。',
      '',
      '前日に有料版で配信したメインレースの買い目と、その結果を公開しています。',
      '当たった日も、外れた日も、そのまま掲載しています。',
      '',
      'メインレース以外についても、的中したかどうかを全レース分ご覧いただけます。',
      '数字はすべて実際の結果から集計したもので、こちらで書き換えてはいません。',
    ],
    benefitTitle: 'ご覧いただけるもの',
    benefitItems: [
      '前日のメインレースの買い目',
      'その買い目の結果',
      'メイン以外の全レースの的中・不的中',
    ],
    ctaLabel: '前日の買い目と結果を見る',
    ctaUrl: PHASE2_LINKS.showcaseJra,
    ctaNote: '南関競馬の結果も同じページからご覧いただけます。',
  }),
  step({
    n: 4, delayDays: 4, angle: '使い方',
    name: '使い方',
    subject: '【KEIBA Analytics】どのレースから見るとよいか',
    preheader: '開催が重なる日に、どこから見ると分かりやすいかのご案内です。',
    badge: '使いかた',
    headline: 'どのレースから見るとよいか',
    body: [
      '開催が重なる日は、レース数が多くて迷われるかと思います。',
      '',
      'まずはメインレースをご覧いただくのが分かりやすいです。',
      '出走頭数が揃い、印と指数の差がはっきり出やすいレースです。',
      '',
      '南関競馬は平日にも開催があり、中央競馬は土日が中心です。',
      'お時間の取れる日に合わせて、どちらかをご覧いただければと思います。',
      '',
      '会場の切り替えは、予想ページの上部から行えます。',
    ],
    benefitTitle: '見る順番の目安',
    benefitItems: ['まずメインレース', '平日は南関競馬', '土日は中央競馬'],
    ctaLabel: '南関競馬の予想を見る',
    ctaUrl: PHASE2_LINKS.freeNankan,
    ctaNote: '中央競馬の予想も同じメニューからご覧いただけます。',
  }),
  step({
    n: 5, delayDays: 5, angle: '有料で増えるもの',
    name: '有料で増えるもの',
    subject: '【KEIBA Analytics】無料版と有料版の違いについて',
    preheader: '有料版でご覧いただけるようになる範囲のご説明です。',
    badge: 'ご説明',
    headline: '無料版と有料版の違い',
    body: [
      'ご質問をいただくことが多いので、無料版と有料版の違いをご説明します。',
      '',
      '無料版でも、印と指数はそのままご覧いただけます。',
      '有料版で変わるのは、主に**見られるレースの数**です。',
      '',
      '有料版では、無料版で伏せている買い目と、対象レースの詳細をご覧いただけます。',
      '買い目の点数を増やすのではなく、ご覧いただけるレースが増える形です。',
      '',
      'まずは無料版でお試しいただき、必要だと感じられた場合にご検討ください。',
    ],
    benefitTitle: '有料版で増えるもの',
    benefitItems: ['ご覧いただけるレース数', '買い目の詳細', '対象レースの分析'],
    ctaLabel: LOOK_CTA.label, ctaUrl: LOOK_CTA.url, ctaNote: LOOK_CTA.note,
  }),
  step({
    n: 6, delayDays: 5, angle: '続けて見る価値',
    name: '続けて見る価値',
    subject: '【KEIBA Analytics】毎日更新しています',
    preheader: '開催日ごとに予想と結果を更新しています。',
    badge: '更新',
    headline: '開催日ごとに更新しています',
    body: [
      '予想は開催日ごとに更新しており、前日の結果もあわせて反映しています。',
      '',
      '一度だけご覧いただくよりも、何日か続けてご覧いただくと',
      '指数の出かたや、印の傾向が掴みやすくなります。',
      '',
      '当たった日だけでなく、外れた日も記録として残しています。',
      'どの程度の精度なのかは、続けてご覧いただくのが一番分かりやすいかと思います。',
      '',
      'ブックマークしていただくと、開催日にすぐご確認いただけます。',
    ],
    benefitTitle: '更新しているもの',
    benefitItems: ['開催日ごとの予想', '前日の結果', '月別のアーカイブ'],
    ctaLabel: '南関競馬の結果を見る',
    ctaUrl: PHASE2_LINKS.showcaseNankan,
    ctaNote: '中央競馬の結果も同じページからご覧いただけます。',
  }),
  step({
    n: 7, delayDays: 6, angle: '最後のご案内',
    name: '最後のご案内',
    subject: '【KEIBA Analytics】有料プランのご案内（最後のご連絡）',
    preheader: '有料プランをご検討いただける場合のご案内です。',
    badge: 'ご案内',
    headline: '有料プランのご案内',
    body: [
      'ここまでご案内をお送りしてまいりました。',
      '本メールが、このご案内の最後になります。',
      '',
      '無料版は今後もそのままご覧いただけます。お手続きは必要ありません。',
      '',
      'もし有料版をご検討いただける場合は、下記の価格でご案内しております。',
      'ご登録のメールアドレスでログインしていただくと、マイページに表示されます。',
      '',
      'ご不要の場合は、このままご放念ください。',
    ],
    benefitTitle: `ご案内している価格（${DISCOUNT_DEADLINE}）`,
    benefitItems: discountItems('free'),
    ctaLabel: DISCOUNT_CTA.label,
    ctaUrl: DISCOUNT_CTA.url,
    ctaNote: DISCOUNT_CTA.note,
  }),
]);

export default PROSPECT_PHASE2_STEPS;
