/**
 * lightTrialSteps.js — Light 無料体験**期間中**の Step5〜6（文面の単一源）
 *
 * ── なぜ 6 通で終わるのか ────────────────────────────────────
 * 目的は「無反応の相手にも接点を作って反応を見る」ことで、**累計 24 接点**を用意する。
 * ただし無料体験は 30 日で終わる。最短 3 日間隔 + 無反応での間隔延長では、
 * **体験中に入るのは 6 通前後**（統合テストで実測）。
 * 7 通目以降を体験中フェーズに置くと、期限切れの相手へ
 * 「無料期間中です」と書いたメールを送ることになり**事実と食い違う**。
 *
 * そこで 7 通目以降は別キャンペーン（`postExpirySteps.js` /
 * `light-trial-post-expiry-sequence`）が担当する。
 * 通し番号（1〜24）は `journeyModel.js` が持つ。
 *
 * ── 書くときの禁止事項（`FORBIDDEN_PHRASES` と同じ方針）───────────
 * - 的中・利益の**保証**、「必ず」「絶対」「確実に」
 * - **架空の実績・数値**（実績はページへ誘導し、メールに書き写さない）
 * - 「今だけ」「残りわずか」の煽り
 * - 価格の直書き（`/pricing/` が正本）
 *
 * ── 間隔 ────────────────────────────────────────────────────
 * `delayDays` は**前の通からの日数**。無料期間 30 日の間は詰めすぎず、
 * 期間後は間隔を広げる。実際の送信間隔は `sequencePolicy` の
 * 最小間隔・頻度上限（7 日で 2 通）が上限として効く。
 *
 * ⚠️ **本番送信はしない。** 管理画面の `action=preview` で 1 通ずつ確認できる。
 */

const SITE = 'https://analytics.keiba.link';

/** 無料期間の終了日を差し込む印（`marketingEmailShell.js` が解決する） */
const EXPIRY = '{{grantExpiry}}';

/**
 * 訴求角度。**同じ角度を連続で置かない**（`sequencePolicy.pickAngle` と対応）。
 * 画面にも出すので、日本語の短い語にする。
 */
export const LIGHT_TRIAL_ANGLES = Object.freeze([
  '体験の開始', '使い方', '活用例', '中央競馬', '南関競馬', '習慣化',
  '買い目の使い方', '成績の確認', 'Premium との差', '期間の確認',
  '不安の解消', '料金の考え方', '継続の提案', '期限前', '期限後', 'comeback',
]);

/** 1 ステップぶんの共通形（`campaignCatalog` の step と同じ形） */
const step = ({
  n, delayDays, angle, name, subject, preheader, badge, headline,
  body, benefitTitle, benefitItems, ctaLabel, ctaUrl, ctaNote, footerNote,
}) => ({
  stepNumber: n,
  delayDays,
  /** 訴求角度（連投を避けるための札） */
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
  ...(footerNote ? { footerNote } : {}),
  benefitType: 'free_access',
  benefitDescription: 'Lightプランの無料期間中にご覧いただける内容のご案内です',
});

/**
 * Step5〜6。**Step1〜4（`campaignCatalog.js`）の続き**で、体験中フェーズの最後まで。
 *
 * ⚠️ ここへ 7 通目以降を足さない。**無料期間中に届かない**（30 日に収まらない）。
 *    足したい場合は `postExpirySteps.js` 側へ置く。
 */
export const LIGHT_TRIAL_EXTRA_STEPS = Object.freeze([
  step({
    n: 5, delayDays: 4, angle: '活用例',
    name: '当日の見方（レース前）',
    subject: '【KEIBA Analytics】レース前に見ておくと分かりやすい順番',
    preheader: '出走前に、本命・相手・不要馬の並びをどう読むかをご案内します。',
    badge: '見方',
    headline: 'レース前に見る順番',
    body: [
      'メインレースのページは、上から順に見ていただくと読みやすくなっています。',
      '',
      '1. 本命と対抗（軸にする馬）',
      '2. 相手（買い目に入る馬）',
      '3. 抑え・不要馬（外す理由が書いてある馬）',
      '',
      'AI総合指数は馬ごとの評価値です。数字そのものより、',
      '同じレース内での並び方を見ていただくと差が分かりやすくなります。',
    ],
    benefitTitle: 'レース前の 3 分',
    benefitItems: ['本命と対抗を確認する', '相手 5 頭を確認する', '外している馬の理由を見る'],
    ctaLabel: '今日のメインレースを見る',
    ctaUrl: `${SITE}/dashboard/`,
    ctaNote: `無料期間中はお手続きなくご覧いただけます。${EXPIRY}`,
  }),
  step({
    n: 6, delayDays: 4, angle: '中央競馬',
    name: '中央（JRA）の予想',
    subject: '【KEIBA Analytics】中央競馬（JRA）の予想について',
    preheader: '土日の中央競馬もご覧いただけます。開催が複数場のときの見方もご案内します。',
    badge: '中央競馬',
    headline: '土日は中央競馬（JRA）もご覧いただけます',
    body: [
      '当サイトは南関競馬と中央競馬（JRA）の両方を扱っています。',
      '',
      '中央は土日開催で、複数の会場が同時に行われます。',
      '会場ごとにメインレースが決まるので、見たい会場を選んでご覧ください。',
      '',
      '平日は南関競馬、土日は中央競馬という形でお使いいただけます。',
    ],
    benefitTitle: '中央競馬のページ',
    benefitItems: ['会場ごとのメインレース', 'AI総合指数と役割', '前日の買い目と結果'],
    ctaLabel: '中央競馬の予想を見る',
    ctaUrl: `${SITE}/dashboard/`,
    ctaNote: `無料期間中はお手続きなくご覧いただけます。${EXPIRY}`,
  }),
]);

export default LIGHT_TRIAL_EXTRA_STEPS;
