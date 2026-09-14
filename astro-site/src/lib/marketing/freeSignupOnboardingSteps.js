/**
 * freeSignupOnboardingSteps.js — **メルマガ無料登録者**の育成 6 通（文面の単一源）
 *
 * ── 文面はどこから来たか（新しく書いていない）────────────────────
 * 本文・件名・リンクは `src/lib/newsletter/step-sequences.js` の
 * `analytics-keiba:signup-onboarding`（無料登録時に enroll される既存のステップメール）
 * から**そのまま**移した。営業訴求・価格・特典を新しく作っていない。
 *
 * ── なぜ移したか ──────────────────────────────────────────────
 * 元のステップメールは **配信系統が別**（`StepEnrollments` + `cron-email-scheduler`）で、
 *   - **送信が未実装**（`step-enroll.js` の注記どおり「実際に送るのは将来の Phase 3」）
 *   - `DeliveryKey` が無い＝**二重送信を構造的に防げない**
 *   - 購入停止・配信停止・反応別 routing を**持たない**
 * だった。DRM の入口を**既存の配信経路 1 本**（`CampaignDeliveries` / 既存 dispatcher）へ
 * 載せるため、campaign として定義し直した。**新しい配信基盤は作っていない。**
 *
 * ── 移す際に直した 2 点（どちらも既存仕様への整合。新規の訴求ではない）──────
 * 1. **Step2 の間隔 1 日 → 2 日**。`campaignSequence.MIN_STEP_DELAY_DAYS = 2` に反するため
 *    （このリポジトリの既存ルール）。**まだ 1 通も送っていない**ので影響は無い。
 * 2. **Step4 の「メインレース10点 / 双方向馬単」→「最大5点 / 一方向の馬単」**。
 *    2026-07-09 に確定した現行仕様（`CLAUDE.md`「メインレース5点ロジック」）と
 *    食い違っており、そのまま送ると**事実と違う案内**になるため。
 *
 * ⚠️ 本文に配信停止リンクを書かない（送信基盤が全通に自動付与する）。
 * ⚠️ 実績の数値を手書きしない（実データのページへ誘導する）。
 * ⚠️ preheader は**その step の本文にある一文をそのまま**使う（新しい売り文句を作らない）。
 */

const SITE = 'https://analytics.keiba.link';

/** 訴求角度（連投を避けるための札） */
export const FREE_SIGNUP_ANGLES = Object.freeze([
  'はじめに', '使い方', '成績の確認', '買い目の使い方', 'プランの違い', '上位プラン',
]);

const step = ({
  n, delayDays, angle, name, subject, preheader, headline, body,
  ctaLabel, ctaUrl,
}) => ({
  stepNumber: n,
  delayDays,
  angle,
  name,
  subject,
  preheader,
  headline,
  body: body.join('\n'),
  ctaLabel,
  ctaUrl,
  benefitType: 'free_content',
  benefitDescription: '無料のままご覧いただける予想・買い目・結果のご案内です',
});

export const FREE_SIGNUP_ONBOARDING_STEPS = Object.freeze([
  step({
    n: 1, delayDays: 0, angle: 'はじめに',
    name: 'ご登録のお礼と入口',
    subject: '【KEIBA Analytics】ご登録ありがとうございます（まずはここから）',
    preheader: 'まずは本日の無料予想をご覧ください。',
    headline: 'ご登録ありがとうございます',
    body: [
      'KEIBA Analytics へのご登録ありがとうございます。',
      'AIが南関競馬・中央競馬のメインレースを分析し、本命・買い目を無料で公開しています。',
      '',
      'まずは本日の無料予想をご覧ください。',
    ],
    ctaLabel: '無料予想を見る',
    ctaUrl: `${SITE}/free-prediction/nankan/`,
  }),
  // ⚠️ 元のステップメールは delayDays: 1。MIN_STEP_DELAY_DAYS = 2 に合わせて 2 にした
  step({
    n: 2, delayDays: 2, angle: '使い方',
    name: '予想ページの見方',
    subject: '【KEIBA Analytics】予想ページの見方（3分でわかる使い方）',
    preheader: '本命◎・対抗○・単穴▲・連下・抑え・不要馬まで、全頭をAI指数で分類しています。',
    headline: '予想ページの見方',
    body: [
      '予想ページの見方を簡単にご案内します。',
      '本命◎・対抗○・単穴▲・連下・抑え・不要馬まで、全頭をAI指数で分類しています。',
    ],
    ctaLabel: '今日の予想で使い方を確認する',
    ctaUrl: `${SITE}/free-prediction/nankan/`,
  }),
  step({
    n: 3, delayDays: 3, angle: '成績の確認',
    name: '直近の実績',
    subject: '【KEIBA Analytics】直近の的中実績をまとめました',
    preheader: 'データで予想の精度をご確認ください。',
    headline: '直近の実績はページで公開しています',
    body: [
      'AI予想の直近の的中実績・回収率をアーカイブで公開しています。',
      'データで予想の精度をご確認ください。',
    ],
    ctaLabel: '的中実績アーカイブを見る',
    ctaUrl: `${SITE}/archive/nankan/`,
  }),
  // ⚠️ 元のステップメールは「最大10点 / 双方向馬単」。現行仕様（2026-07-09 確定）に合わせた
  step({
    n: 4, delayDays: 7, angle: '買い目の使い方',
    name: '買い目の考え方',
    subject: '【KEIBA Analytics】買い目の見方とメインレース5点の考え方',
    preheader: 'メインレースの買い目は全プラン共通で最大5点に絞っています。',
    headline: 'メインレースの買い目の考え方',
    body: [
      'メインレースの買い目は全プラン共通で最大5点に絞っています。',
      '本命を軸にした一方向の馬単（本命→相手5頭）の考え方をご紹介します。',
    ],
    ctaLabel: '今日の買い目を見る',
    ctaUrl: `${SITE}/free-prediction/nankan/`,
  }),
  step({
    n: 5, delayDays: 14, angle: 'プランの違い',
    name: 'プラン比較',
    subject: '【KEIBA Analytics】プラン比較（無料／ライト／プレミアム）',
    preheader: '閲覧できるレース数で選べます。',
    headline: 'プランの違い',
    body: [
      'より多くのレースの買い目をご覧になりたい方へ、プランの違いをまとめました。',
      '閲覧できるレース数で選べます。',
    ],
    ctaLabel: 'プランを比較する',
    ctaUrl: `${SITE}/premium-prediction/nankan/`,
  }),
  step({
    n: 6, delayDays: 21, angle: '上位プラン',
    name: '上位プランの機能',
    subject: '【KEIBA Analytics】三連複絞り込み・個別配信などの上位機能',
    preheader: 'プレミアム三連複の絞り込み機能や、三連単の個別配信など上位プランの機能をご紹介します。',
    headline: '上位プランの機能',
    body: [
      'プレミアム三連複の絞り込み機能や、三連単の個別配信など上位プランの機能をご紹介します。',
    ],
    ctaLabel: '上位プランの機能を見る',
    ctaUrl: `${SITE}/premium-prediction/nankan/`,
  }),
]);

export default FREE_SIGNUP_ONBOARDING_STEPS;
