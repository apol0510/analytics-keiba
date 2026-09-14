// ステップメール シーケンス定義（コード定数・純粋データ・副作用ゼロ）
//
// 設計: NEWSLETTER_AUTOMATION_AIRTABLE_DESIGN.md「★採用方針確定（2026-05-22）」確定.1。
//   - StepEmailSequences / StepEmailSteps は当面 Airtable テーブル化せず、本ファイルの
//     コード定数で管理する（admin UI 化が必要になったらテーブル移行）。
//   - 本ファイルは render も送信も Airtable アクセスもしない。定義データと純粋 getter のみ。
//
// enroll-from-now 方針（確定.5）: signup-onboarding は新規 free 登録時に enroll。
//   既存 free 会員へのバックフィルはしない（別途 reengage campaign）。
//
// delayDays は EnrolledAt からの経過日（カレンダー日）。SendAt = EnrolledAt + delayDays。
// stepNumber は StepEnrollments.CurrentStepNumber と対応（1 始まり・連番）。

/** signup-onboarding 各ステップの本文（プレースホルダは {{firstName}} 等の単純置換を想定） */
const FREE_ONBOARDING_STEPS = [
  {
    stepNumber: 1,
    delayDays: 0,
    campaignType: 'step-signup-d0',
    subjectTemplate: '【KEIBA Analytics】ご登録ありがとうございます（まずはここから）',
    bodyTemplate:
      '<p>{{firstName}} 様</p>' +
      '<p>KEIBA Analytics へのご登録ありがとうございます。AIが南関競馬・中央競馬のメインレースを分析し、本命・買い目を無料で公開しています。</p>' +
      '<p>まずは本日の無料予想をご覧ください。</p>' +
      '<p><a href="https://analytics.keiba.link/free-prediction/nankan">▶ 無料予想を見る</a></p>',
  },
  {
    stepNumber: 2,
    delayDays: 1,
    campaignType: 'step-signup-d1',
    subjectTemplate: '【KEIBA Analytics】予想ページの見方（3分でわかる使い方）',
    bodyTemplate:
      '<p>{{firstName}} 様</p>' +
      '<p>予想ページの見方を簡単にご案内します。本命◎・対抗○・単穴▲・連下・抑え・不要馬まで、全頭をAI指数で分類しています。</p>' +
      '<p><a href="https://analytics.keiba.link/free-prediction/nankan">▶ 今日の予想で使い方を確認する</a></p>',
  },
  {
    stepNumber: 3,
    delayDays: 3,
    campaignType: 'step-signup-d3',
    subjectTemplate: '【KEIBA Analytics】直近の的中実績をまとめました',
    bodyTemplate:
      '<p>{{firstName}} 様</p>' +
      '<p>AI予想の直近の的中実績・回収率をアーカイブで公開しています。データで予想の精度をご確認ください。</p>' +
      '<p><a href="https://analytics.keiba.link/archive/nankan/">▶ 的中実績アーカイブを見る</a></p>',
  },
  {
    stepNumber: 4,
    delayDays: 7,
    campaignType: 'step-signup-d7',
    subjectTemplate: '【KEIBA Analytics】買い目の見方とメインレース10点の考え方',
    bodyTemplate:
      '<p>{{firstName}} 様</p>' +
      '<p>メインレースの買い目は全プラン共通で最大10点に絞っています。本命を軸にした双方向馬単の考え方をご紹介します。</p>' +
      '<p><a href="https://analytics.keiba.link/free-prediction/nankan">▶ 今日の買い目を見る</a></p>',
  },
  {
    stepNumber: 5,
    delayDays: 14,
    campaignType: 'step-signup-d14',
    subjectTemplate: '【KEIBA Analytics】プラン比較（無料／ライト／プレミアム）',
    bodyTemplate:
      '<p>{{firstName}} 様</p>' +
      '<p>より多くのレースの買い目をご覧になりたい方へ、プランの違いをまとめました。閲覧できるレース数で選べます。</p>' +
      '<p><a href="https://analytics.keiba.link/premium-prediction/nankan">▶ プランを比較する</a></p>',
  },
  {
    stepNumber: 6,
    delayDays: 21,
    campaignType: 'step-signup-d21',
    subjectTemplate: '【KEIBA Analytics】三連複絞り込み・個別配信などの上位機能',
    bodyTemplate:
      '<p>{{firstName}} 様</p>' +
      '<p>プレミアム三連複の絞り込み機能や、三連単の個別配信など上位プランの機能をご紹介します。</p>' +
      '<p><a href="https://analytics.keiba.link/premium-prediction/nankan">▶ 上位プランの機能を見る</a></p>',
  },
];

/** シーケンス定義テーブル（StepSequenceId をキーにした純粋データ） */
export const STEP_SEQUENCES = Object.freeze({
  'analytics-keiba:signup-onboarding': Object.freeze({
    stepSequenceId: 'analytics-keiba:signup-onboarding',
    brand: 'analytics-keiba',
    serviceType: 'analytics-keiba',
    sequenceName: '無料登録オンボーディング',
    triggerType: 'signup', // 新規 free 登録で enroll
    audienceType: 'free', // 送信時に free 以外なら停止（converted）
    isActive: true,
    /**
     * ⛔ **後継へ移行済み（2026-09-14）。live 送信してはいけない。**
     *
     * この 6 通は `marketing/freeSignupOnboardingSteps.js` へ移送され、
     * campaign `free-signup-onboarding` として **DRM の入口**になった。
     * 移送先は `DeliveryKey`（campaign × version × step × 受信者）で冪等なのに対し、
     * こちらの鍵は `extraKey='step:{seqId}:{stepNumber}'` で**別物**。
     * 両方を live にすると **同じ人へ同じ 6 通が二度届く**（鍵が違うので互いに検知できない）。
     *
     * さらにこちらの本文は**古い**（「メインレース10点 / 双方向馬単」= 2026-07-09 に
     * 5 点・一方向へ変更済み）。送ると事実と違う案内になる。
     *
     * ⚠️ `enqueue-step-emails` の live パスは `supersededBy` があるレコードを**拒否**する。
     *    復活させたい場合は、先に campaign 側を止めること（**両方を live にしない**）。
     */
    supersededBy: 'campaign:free-signup-onboarding',
    supersededAt: '2026-09-14',
    steps: FREE_ONBOARDING_STEPS,
  }),
});

/**
 * そのシーケンスは**後継へ移行済み**か（live 送信を止めるため）。
 * ⚠️ dryRun（計画の確認）は止めない。止めるのは**書き込み・送信の経路だけ**。
 */
export function isSequenceSuperseded(stepSequenceId) {
  const seq = getSequence(stepSequenceId);
  return Boolean(seq && seq.supersededBy);
}

/** 後継の識別子（無ければ null） */
export function supersededBy(stepSequenceId) {
  const seq = getSequence(stepSequenceId);
  return (seq && seq.supersededBy) || null;
}

/** 全シーケンスID一覧 */
export function getAllSequenceIds() {
  return Object.keys(STEP_SEQUENCES);
}

/** シーケンス定義を取得（無ければ null） */
export function getSequence(stepSequenceId) {
  return STEP_SEQUENCES[stepSequenceId] || null;
}

/** シーケンスのステップ配列を取得（stepNumber 昇順、無ければ []） */
export function listSteps(stepSequenceId) {
  const seq = getSequence(stepSequenceId);
  if (!seq) return [];
  return [...seq.steps].sort((a, b) => a.stepNumber - b.stepNumber);
}

/** 指定 stepNumber のステップ定義を取得（無ければ null） */
export function getStep(stepSequenceId, stepNumber) {
  const seq = getSequence(stepSequenceId);
  if (!seq) return null;
  return seq.steps.find((s) => s.stepNumber === Number(stepNumber)) || null;
}

/** 最終ステップ番号（全消化判定用）。シーケンスが無ければ 0 */
export function getMaxStepNumber(stepSequenceId) {
  const steps = listSteps(stepSequenceId);
  return steps.length ? steps[steps.length - 1].stepNumber : 0;
}
