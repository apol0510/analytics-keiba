/**
 * sequenceStepAdvance.test.mjs — **0 人だった step で tick を終わらせない**
 *   node --test src/lib/marketing/sequenceStepAdvance.test.mjs
 *
 * ## これが事故そのもの（2026-09-16 本番実測 / `campaign-discount-free`）
 *
 * `selectNextDueStep` は**いちばん小さい due step** だけを返す。その step の候補が
 * 後段の安全条件（既に `queued` / `sent`・出所フィルタ・許可リスト）で**全部落ちる**と、
 * tick は 0 人で終わり、**次の tick もまったく同じ step を選ぶ**。
 *
 * | 実測 | 値 |
 * |---|---|
 * | 選ばれる step | **2**（毎回同じ）|
 * | その tick の候補 | **0** |
 * | 既に `queued` のため除外 | **36**（`sent` にならないので永久に due のまま）|
 * | step3 の due | **5,465 名** |
 * | step3 の送信実績 | **0 通** |
 *
 * 第 1 期（3 通）が誰も完了しないので、後段接続の第 2 期は**1 行も作られなかった**
 * （`campaign-prospect-phase2` の配信台帳は 0 行）。
 * その結果 **delivered 累計 10 に永久に到達できず、EXHAUSTED も起きない**。
 *
 * ⚠️ ここで固定するのは「**0 人のときだけ**次の due step を試す」こと。
 *    安全条件・上限・並び順は 1 つも変えない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { planSequenceTick, TICK_ABORT } from './sequenceAutomation.js';

const CRON = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/cron-campaign-sequence.js', import.meta.url)),
  'utf8',
);

const OPEN_GATES = { allOpen: true, missing: [] };

/** due な行を作る（`sequenceProgress` の戻りのうち、計画が見るぶんだけ） */
const dueRow = (recordId, nextStep) => ({
  recordId, email: `${recordId}@example.invalid`, status: 'due', nextStep,
});

function progressOf(rows) {
  const dueByStep = {};
  for (const r of rows) dueByStep[r.nextStep] = (dueByStep[r.nextStep] || 0) + 1;
  return { ok: true, rows, summary: { dueByStep } };
}

// ══════════════════════════════════════════════════════════════════
//  ① 既定（skipSteps 無し）は 1 ミリも変わらない
// ══════════════════════════════════════════════════════════════════

test('【最重要】skipSteps を渡さなければ従来どおり最小 due step を選ぶ', () => {
  const progress = progressOf([dueRow('a', 2), dueRow('b', 3), dueRow('c', 3)]);
  const plan = planSequenceTick({ progress, gates: OPEN_GATES });
  assert.equal(plan.ok, true);
  assert.equal(plan.step, 2, '最小 due step が変わっている');
});

test('【最重要】step1 は今までどおり自動で撃たない（除外であって中止ではない）', () => {
  const progress = progressOf([dueRow('a', 1), dueRow('b', 2)]);
  const plan = planSequenceTick({ progress, gates: OPEN_GATES });
  assert.equal(plan.ok, true);
  assert.equal(plan.step, 2, 'step1 が混ざると step2 が止まっている');
});

test('【最重要】step1 しか居なければ従来どおり first_step_is_manual', () => {
  const progress = progressOf([dueRow('a', 1)]);
  const plan = planSequenceTick({ progress, gates: OPEN_GATES });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, TICK_ABORT.FIRST_STEP_MANUAL);
});

// ══════════════════════════════════════════════════════════════════
//  ② 0 人だった step を外すと、次の due step が選ばれる
// ══════════════════════════════════════════════════════════════════

test('【最重要】step2 が 0 人でも step3 が選ばれる（これが止まっていた）', () => {
  const progress = progressOf([dueRow('a', 2), dueRow('b', 3), dueRow('c', 3)]);
  const plan = planSequenceTick({ progress, gates: OPEN_GATES, skipSteps: [2] });
  assert.equal(plan.ok, true, 'step2 を外したら進まなくなっている');
  assert.equal(plan.step, 3);
  assert.equal(plan.recipients, 2);
});

test('【重要】外した step の人は対象に入らない（同じ step を二度試さない）', () => {
  const progress = progressOf([dueRow('a', 2), dueRow('b', 3)]);
  const plan = planSequenceTick({ progress, gates: OPEN_GATES, skipSteps: [2] });
  assert.deepEqual(plan.recordIds, ['b'], '外した step の人が混ざっている');
});

test('【重要】step1 の除外は保ったまま次の step を試す', () => {
  // step1 の人が居ても、step1 は撃たない。step2 を外したら step3 へ。
  const progress = progressOf([dueRow('a', 1), dueRow('b', 2), dueRow('c', 3)]);
  const plan = planSequenceTick({ progress, gates: OPEN_GATES, skipSteps: [2] });
  assert.equal(plan.ok, true);
  assert.equal(plan.step, 3, 'step1 へ落ちている（自動で撃ってはいけない）');
});

test('【最重要】試せる step を使い切ったら no_due_recipients（first_step_manual と言わない）', () => {
  const progress = progressOf([dueRow('a', 2), dueRow('b', 3)]);
  const plan = planSequenceTick({ progress, gates: OPEN_GATES, skipSteps: [2, 3] });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, TICK_ABORT.NO_DUE);
  assert.deepEqual(plan.skippedSteps, [2, 3]);
});

test('【重要】ゲートが閉じていれば skipSteps があっても何も選ばない', () => {
  const progress = progressOf([dueRow('a', 2), dueRow('b', 3)]);
  const plan = planSequenceTick({
    progress, gates: { allOpen: false, missing: ['X'] }, skipSteps: [2],
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, TICK_ABORT.GATES_CLOSED);
});

test('【重要】上限は skipSteps があっても変わらない', () => {
  const rows = Array.from({ length: 80 }, (_, i) => dueRow(`r${i}`, 3));
  const plan = planSequenceTick({
    progress: progressOf([dueRow('a', 2), ...rows]),
    gates: OPEN_GATES, maxRecipients: 50, skipSteps: [2],
  });
  assert.equal(plan.step, 3);
  assert.equal(plan.recipients, 50, '上限を超えて積もうとしている');
  assert.equal(plan.carriedOver, 30, '残りが次の tick へ持ち越されていない');
});

// ══════════════════════════════════════════════════════════════════
//  ③ 実経路の配線（cron 側）
// ══════════════════════════════════════════════════════════════════

test('【最重要】cron は 0 人だった step を外して選び直す', () => {
  assert.match(CRON, /skipSteps: emptySteps/, 'cron が選び直しを渡していない');
  assert.match(CRON, /emptySteps\.push\(plan\.step\)/, '0 人だった step を記録していない');
});

test('【最重要】選び直すのは 0 人のときだけ（1 人でも積めたら抜ける）', () => {
  assert.match(CRON, /targets\.length === 0 && mayAdvanceStep/, '0 人以外でも選び直している');
});

test('【最重要】許可リスト / expectedCount のときは選び直さない（約束を変えない）', () => {
  assert.match(
    CRON,
    /const mayAdvanceStep = entryAllowlist === null && !Number\.isInteger\(expectedCount\)/,
    'canary / DRM 入口の約束（この step でこの人数）が守られていない',
  );
});

test('【最重要】打ち切りがある（無限ループにならない）', () => {
  assert.match(CRON, /attempt \+ 1 < maxStepAttempts/, '打ち切り条件が無い');
  assert.match(CRON, /maxStepAttempts = mayAdvanceStep/, '試行回数の上限が無い');
});

test('【重要】安全条件は選び直しの後でも同じ順で通る', () => {
  // 既登録の除外 → 出所フィルタ → 許可リスト の順（ループの中に入っている）
  const order = [
    CRON.indexOf('fetchActiveDeliveryKeys'),
    CRON.indexOf('applyAudienceFilter({ targets: due'),
    CRON.indexOf('applyEntryAllowlist({ targets: f.kept'),
  ];
  assert.ok(order.every((i) => i > 0), '安全条件のどれかが消えている');
  assert.deepEqual([...order].sort((a, b) => a - b), order, '安全条件の順序が変わっている');
});

test('【重要】選び直しても除外数を持ち越さない（数字が二重に増えない）', () => {
  assert.match(CRON, /alreadyQueued = 0;/, '除外数を数え直していない');
});

test('【最重要】下見も同じ選び直しをする（下見と live がズレない）', () => {
  // 下見の return はループの外（選び直しが終わってから）に無いといけない
  const loopEnd = CRON.indexOf('} // ← step 選び直しループの終わり');
  const dryReturn = CRON.indexOf('if (isDry) {', loopEnd);
  assert.ok(loopEnd > 0, '選び直しループが無い');
  assert.ok(dryReturn > loopEnd, '下見がループの内側で return している（live とズレる）');
});
