/**
 * rolloutTarget.js — Light 無料体験 展開の**完成条件（正本・機械可読）**
 *
 * ── なぜコードに置くか ────────────────────────────────────────
 * この契約は文章だけだと**縮む**。実際に 2026-08-17、カナリアで 500 名を配った日の
 * 実績が「500 名/日の仕様」と読み替えられ、15,000 名を 30 日かけて配る話になりかけた。
 * 数値を**コードの定数**にして、テスト（`rolloutTargetContract.test.mjs`）が
 * ドキュメントの記述と突き合わせる。**片方だけ書き換えると CI が落ちる。**
 *
 * ⚠️ この値を小さくする変更は「仕様変更」であり、
 *    docs（`docs/spec.md` / `docs/decisions.md` / `astro-site/docs/MARKETING_ROLLOUT.md`）と
 *    同時に直さない限り通らない。**運用の一時的な絞り込みは state 側で行う**
 *    （`rolloutStart` に小さい `dailyLimit` を渡す＝カナリア。目標そのものは変えない）。
 */

/**
 * **正常時の目標**。約 15,000 名の取り込みコホートを**同じ日に**配り切る。
 *
 * - `dailyLimit` … 1 日に配れる合計人数（回数ではない）
 * - `batchSize`  … 論理バッチ 1 本の人数。この単位で
 *                  付与 → Step1 queue → 送信 → 関所確認 を回す
 * - `grantOperationMax` … 付与 1 回の上限（`MAX_GRANT_RECORDS` / `HARD_MAX_BATCH_SIZE` の小さい方）。
 *                  500 名の論理バッチは **200 + 200 + 100** の 3 回に分かれる
 * - `ticksPerBatch` … 論理バッチ 1 本に要する tick（付与 3 回 × 3 tick）
 * - `cronMinutes` … cron の間隔。30 バッチ × 5 tick × 2 分 ≈ 5 時間
 */
export const ROLLOUT_TARGET = Object.freeze({
  /** 対象コホート（取り込み分。厳密な数ではなく規模の目安） */
  cohortApprox: 15_000,
  dailyLimit: 15_000,
  batchSize: 500,
  grantOperationMax: 200,
  /**
   * 500 = 200 + 200 + 100。ただし **1 回ごとに queue → 送信 → 関所確認**を挟む
   * （付与側の関所が「前回ぶんの Step1 が送り終わるまで付与しない」ため）。
   */
  grantSplit: Object.freeze([200, 200, 100]),
  /** 付与 1 回あたりの tick 数（付与 1 + queue 1 + 送信起動 1） */
  ticksPerGrant: 3,
  /** 論理バッチ 500 名ぶん（3 回 × 3 tick） */
  ticksPerBatch: 9,
  cronMinutes: 2,
  /** 正常時は**同日に**配り切る（翌日以降へ持ち越すのは異常や絞り込みのとき） */
  sameDay: true,
});

/** 目標どおりの日数（バッチ数と所要時間の目安。**画面と報告で同じ数を使う**） */
export function describeTargetPlan(target = ROLLOUT_TARGET) {
  const t = target || ROLLOUT_TARGET;
  const batches = Math.ceil(t.cohortApprox / t.batchSize);
  const ticks = batches * t.ticksPerBatch;
  return {
    batches,
    ticks,
    minutes: ticks * t.cronMinutes,
    hours: Math.round((ticks * t.cronMinutes) / 6) / 10,
    grantsPerBatch: t.grantSplit.length,
  };
}

/**
 * いまの展開状態が**目標どおりか**を返す（画面・報告用）。
 *
 * ⚠️ 目標より小さいこと自体は異常ではない（カナリアや段階運用）。
 *    ただし「小さいまま気づかず放置」を防ぐため、**画面に必ず出す**。
 *
 * @returns {{onTarget: boolean, dailyLimit: number|null, batchSize: number|null,
 *            target: object, gaps: string[]}}
 */
export function describeTargetGap(state, target = ROLLOUT_TARGET) {
  const t = target || ROLLOUT_TARGET;
  const s = state && typeof state === 'object' ? state : {};
  const daily = Number.isFinite(Number(s.dailyLimit)) ? Number(s.dailyLimit) : null;
  const batch = Number.isFinite(Number(s.batchSize)) ? Number(s.batchSize) : null;
  const gaps = [];
  if (daily === null || daily < t.dailyLimit) gaps.push('daily_limit_below_target');
  if (batch === null || batch < t.batchSize) gaps.push('batch_size_below_target');
  return {
    onTarget: gaps.length === 0,
    dailyLimit: daily,
    batchSize: batch,
    target: { dailyLimit: t.dailyLimit, batchSize: t.batchSize, cohortApprox: t.cohortApprox },
    gaps,
  };
}

export default ROLLOUT_TARGET;
