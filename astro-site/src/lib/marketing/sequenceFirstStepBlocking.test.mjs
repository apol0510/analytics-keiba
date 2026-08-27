/**
 * sequenceFirstStepBlocking.test.mjs — **step1 待ちが step2 以降を止めないこと**
 *   node --test src/lib/marketing/sequenceFirstStepBlocking.test.mjs
 *
 * ## 直した不具合（2026-08-27・本番実測で発見）
 *
 * `selectNextDueStep` は **いちばん小さい due ステップ**を返す。
 * 初回接触（step1）は自動で撃たない決まりなので、以前の `planSequenceTick` は
 * 「いちばん小さい due が 1 なら中止」としていた。
 *
 * その結果、**step1 未送信の人が 1 人でも対象に居ると、その campaign の配信が丸ごと止まる**。
 * prospect プールを対象に含めた結果、配信台帳に行が無い人（＝step1 待ち）が 328 名
 * 対象へ入り、**8/31 の 2 通目 5,535 名が 1 通も出ない**状態になっていた。
 *
 * 守りたいのは「初回接触を自動で撃たない」ことだけなので、
 * **step1 を飛ばして次に小さい due ステップを選ぶ**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectNextDueStep, SEQ_STATUS } from './sequenceProgress.js';
import {
  planSequenceTick, readSequenceGates, summarizeSequenceTick, TICK_ABORT,
} from './sequenceAutomation.js';

const OPEN_GATES = readSequenceGates({
  MARKETING_SEQUENCE_SCHEDULER_ENABLED: 'true',
  MARKETING_CAMPAIGN_ENABLED: 'true',
  MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true',
}, Date.UTC(2026, 7, 31));

const rows = (spec) => {
  const out = [];
  for (const [step, n] of Object.entries(spec)) {
    for (let i = 0; i < n; i += 1) {
      out.push({ status: SEQ_STATUS.DUE, nextStep: Number(step), recordId: `s${step}-${i}`, email: `s${step}-${i}@x` });
    }
  }
  return out;
};
const progressOf = (spec) => ({ ok: true, rows: rows(spec), summary: { dueByStep: spec } });

test('【本番の再現】step1 待ち 328 名が居ても step2 の 5,535 名を送る', () => {
  const progress = progressOf({ 1: 328, 2: 5535, 3: 0 });
  // 素の選択は step1（＝以前はここで中止していた）
  assert.equal(selectNextDueStep(progress).step, 1);

  const plan = planSequenceTick({ progress, gates: OPEN_GATES, maxRecipients: 10000 });
  assert.equal(plan.ok, true, '⚠️ step1 待ちのせいで 2 通目が丸ごと止まっている');
  assert.equal(plan.step, 2);
  assert.equal(plan.recipients, 5535);
  assert.equal(plan.firstStepPending, 328, '手動待ちの人数を黙って捨てない');
  // step1 の人は 1 人も混ざらない
  assert.equal(plan.recordIds.some((id) => id.startsWith('s1-')), false);
});

test('⚠️ step1 は自動では絶対に送らない', () => {
  const plan = planSequenceTick({ progress: progressOf({ 1: 100 }), gates: OPEN_GATES });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, TICK_ABORT.FIRST_STEP_MANUAL);
  assert.equal(plan.step, 1);
  assert.equal(plan.firstStepPending, 100);
});

test('明示的に許可したときだけ step1 を送る（既存の運用）', () => {
  const plan = planSequenceTick({ progress: progressOf({ 1: 100 }), gates: OPEN_GATES, allowFirstStep: true });
  assert.equal(plan.ok, true);
  assert.equal(plan.step, 1);
  assert.equal(plan.recipients, 100);
});

test('step1 待ちが居なければ従来どおり（回帰なし）', () => {
  const plan = planSequenceTick({ progress: progressOf({ 2: 40 }), gates: OPEN_GATES });
  assert.equal(plan.ok, true);
  assert.equal(plan.step, 2);
  assert.equal(plan.firstStepPending, 0);
});

test('step1 を飛ばしても「1 回の実行で 1 ステップだけ」は守る', () => {
  const plan = planSequenceTick({ progress: progressOf({ 1: 5, 2: 10, 3: 7 }), gates: OPEN_GATES });
  assert.equal(plan.step, 2, 'step2 と step3 を混ぜている（1 人に 2 通届きうる）');
  assert.equal(plan.recipients, 10);
  assert.equal(plan.recordIds.every((id) => id.startsWith('s2-')), true);
});

test('step1 を飛ばした先が step3 しか無ければ step3 を送る', () => {
  const plan = planSequenceTick({ progress: progressOf({ 1: 5, 3: 9 }), gates: OPEN_GATES });
  assert.equal(plan.ok, true);
  assert.equal(plan.step, 3);
  assert.equal(plan.recipients, 9);
});

test('minStep: それ未満のステップは候補から外す', () => {
  const progress = progressOf({ 1: 3, 2: 4 });
  assert.equal(selectNextDueStep(progress).step, 1);
  assert.equal(selectNextDueStep(progress, { minStep: 2 }).step, 2);
  assert.equal(selectNextDueStep(progress, { minStep: 9 }).step, null);
});

test('持ち越しの上限は飛ばしたあとの step に対して効く', () => {
  const plan = planSequenceTick({ progress: progressOf({ 1: 5, 2: 100 }), gates: OPEN_GATES, maxRecipients: 30 });
  assert.equal(plan.step, 2);
  assert.equal(plan.recipients, 30);
  assert.equal(plan.carriedOver, 70);
  assert.equal(plan.dueTotal, 100);
});

test('ログに「初回接触待ち」が出る（黙って飛ばさない）', () => {
  const plan = planSequenceTick({ progress: progressOf({ 1: 328, 2: 10 }), gates: OPEN_GATES });
  const s = summarizeSequenceTick({ campaignId: 'c', plan, enqueued: 10, failed: 0 });
  assert.equal(s['初回接触待ち'], 328);
  assert.equal(s['ステップ'], 2);
});

test('ゲートが閉じていれば何も選ばない（既存の優先順位）', () => {
  const closed = readSequenceGates({}, Date.UTC(2026, 7, 31));
  const plan = planSequenceTick({ progress: progressOf({ 1: 5, 2: 10 }), gates: closed });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, TICK_ABORT.GATES_CLOSED);
});
