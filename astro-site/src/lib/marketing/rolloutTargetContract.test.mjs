/**
 * rolloutTargetContract.test.mjs — **完成条件を縮められない**ようにする
 *   node --test src/lib/marketing/rolloutTargetContract.test.mjs
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * 2026-08-17、カナリアで 500 名を配った日の**実績**が「500 名/日という仕様」として
 * 読み替えられ、15,000 名を 30 日かけて配る話になりかけた。
 * 文章だけの契約は縮む。ここで
 *   コードの定数（`rolloutTarget.js`）  ↔  正本ドキュメント（docs/spec.md ほか）
 * を突き合わせ、**片方だけ書き換えたら CI が落ちる**ようにする。
 *
 * ⚠️ 運用を一時的に絞るのは `rolloutStart` の引数（state）で行う。
 *    **目標そのもの（この定数）を下げる変更は仕様変更**で、docs と同時にしか通らない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROLLOUT_TARGET, describeTargetPlan, describeTargetGap } from './rolloutTarget.js';
import { GRANT_OPERATION_MAX } from '../comeback/lightTrialAutoGrant.js';
import { ABSOLUTE_MAX_PER_DAY } from './rolloutPlan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASTRO_ROOT = join(HERE, '..', '..', '..');
const REPO_ROOT = join(ASTRO_ROOT, '..');

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

/** 正本ドキュメント（**増やさない**。既存の 3 本に統合する） */
const CANON = {
  spec: join(REPO_ROOT, 'docs', 'spec.md'),
  progress: join(REPO_ROOT, 'docs', 'progress.md'),
  decisions: join(REPO_ROOT, 'docs', 'decisions.md'),
  rollout: join(ASTRO_ROOT, 'docs', 'MARKETING_ROLLOUT.md'),
};

// ── 数値そのもの ────────────────────────────────────────────────

test('【重要】完成条件の数値が縮んでいない（15,000 名 / 500 名バッチ / 同日）', () => {
  assert.equal(ROLLOUT_TARGET.cohortApprox, 15_000, '対象コホートが縮んでいる');
  assert.equal(ROLLOUT_TARGET.dailyLimit, 15_000, '1 日上限が縮んでいる（500/日 への後退）');
  assert.equal(ROLLOUT_TARGET.batchSize, 500, '論理バッチが変わっている');
  assert.equal(ROLLOUT_TARGET.sameDay, true, '同日完走の目標が外されている');
  assert.deepEqual([...ROLLOUT_TARGET.grantSplit], [200, 200, 100], '500 の分割が変わっている');
});

test('【重要】付与 1 回の上限と分割が矛盾していない', () => {
  assert.equal(ROLLOUT_TARGET.grantOperationMax, GRANT_OPERATION_MAX, '実装の上限とズレている');
  assert.ok(
    ROLLOUT_TARGET.grantSplit.every((n) => n <= GRANT_OPERATION_MAX),
    '分割が付与 1 回の上限を超えている（毎 tick 空回りする）',
  );
  assert.equal(
    ROLLOUT_TARGET.grantSplit.reduce((a, b) => a + b, 0), ROLLOUT_TARGET.batchSize,
    '分割の合計が論理バッチと合っていない',
  );
  assert.equal(ROLLOUT_TARGET.ticksPerBatch, ROLLOUT_TARGET.grantSplit.length + 2,
    '1 バッチの tick 数（付与 n + queue 1 + 送信 1）と合っていない');
});

test('【重要】1 日上限は絶対上限の範囲に収まっている', () => {
  assert.ok(ROLLOUT_TARGET.dailyLimit <= ABSOLUTE_MAX_PER_DAY,
    `目標 ${ROLLOUT_TARGET.dailyLimit} が絶対上限 ${ABSOLUTE_MAX_PER_DAY} を超えている（保存できない）`);
  assert.ok(ROLLOUT_TARGET.batchSize <= ROLLOUT_TARGET.dailyLimit);
});

test('【重要】同日に配り切れる見積もりになっている（24 時間以内）', () => {
  const plan = describeTargetPlan();
  assert.equal(plan.batches, 30, `${plan.batches} バッチ（15,000 ÷ 500 = 30 のはず）`);
  assert.equal(plan.ticks, 150);
  assert.ok(plan.hours <= 12, `${plan.hours} 時間かかる見積もり（同日完走に届かない）`);
});

// ── 正本ドキュメントとの一致（片方だけ変えられない）──────────────────

test('【重要】正本 docs に完成条件が書かれている（docs/spec.md）', () => {
  const spec = read(CANON.spec);
  assert.ok(spec, 'docs/spec.md が無い（正本の場所が変わったらこのテストも直す）');
  for (const needle of ['dailyLimit=15000', 'batchSize=500', '200 + 200 + 100']) {
    assert.ok(spec.includes(needle), `docs/spec.md に「${needle}」が無い（コードだけ変えている）`);
  }
  assert.ok(/completed/.test(spec), 'docs/spec.md に終端（completed）の記述が無い');
});

test('【重要】判断の正本（docs/decisions.md）に「500/日ではない」と残っている', () => {
  const d = read(CANON.decisions);
  assert.ok(d, 'docs/decisions.md が無い');
  assert.ok(d.includes('15,000') || d.includes('15000'), '対象規模が書かれていない');
  assert.ok(/500 名\/日|500\/日/.test(d), '「500 名/日ではない」旨の記録が無い（同じ誤読が再発する）');
});

test('【重要】任務の完了条件が PROGRESS に書かれている', () => {
  const p = read(CANON.progress);
  assert.ok(p, 'docs/progress.md が無い');
  assert.ok(p.includes('任務の完了条件'), '「任務の完了条件」の節が無い');
  // 「500 名送れた / PR ができた / deploy した」で完了にしない、が明記されていること
  assert.ok(/完了ではない|完了にしない/.test(p), '部分的な成果を完了と呼ばない旨が無い');
});

test('【重要】運用ドキュメントの数値がコードと一致している', () => {
  const r = read(CANON.rollout);
  assert.ok(r, 'astro-site/docs/MARKETING_ROLLOUT.md が無い');
  assert.ok(r.includes(`dailyLimit = ${ROLLOUT_TARGET.dailyLimit}`)
    || r.includes(`dailyLimit=${ROLLOUT_TARGET.dailyLimit}`), '1 日上限が運用 docs と食い違う');
  assert.ok(r.includes(`batchSize = ${ROLLOUT_TARGET.batchSize}`)
    || r.includes(`batchSize=${ROLLOUT_TARGET.batchSize}`), '論理バッチが運用 docs と食い違う');
});

// ── 画面へ「目標との差」を必ず出す ───────────────────────────────

test('目標より小さい設定は「差」として見える（絞ったまま忘れない）', () => {
  const canary = describeTargetGap({ dailyLimit: 500, batchSize: 500 });
  assert.equal(canary.onTarget, false);
  assert.deepEqual(canary.gaps, ['daily_limit_below_target']);
  assert.equal(canary.target.dailyLimit, ROLLOUT_TARGET.dailyLimit);

  const full = describeTargetGap({ dailyLimit: 15_000, batchSize: 500 });
  assert.equal(full.onTarget, true);
  assert.deepEqual(full.gaps, []);

  // 未設定は「目標どおり」と言わない
  assert.equal(describeTargetGap({}).onTarget, false);
});

test('画面へ出す形に PII も secret も混ぜない', () => {
  const dump = JSON.stringify(describeTargetGap({ dailyLimit: 15_000, batchSize: 500 }));
  assert.equal(/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(dump), false);
  assert.equal(/rec[A-Za-z0-9]{14}/.test(dump), false);
});

test('管理画面の応答に目標との差が載っている（実装の配線確認）', () => {
  const view = readFileSync(join(ASTRO_ROOT, 'src', 'lib', 'marketing', 'rolloutView.js'), 'utf8');
  assert.ok(view.includes('describeTargetGap'), '画面が目標との差を出していない');
});
