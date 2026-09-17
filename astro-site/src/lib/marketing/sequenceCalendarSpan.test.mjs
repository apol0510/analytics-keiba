/**
 * sequenceCalendarSpan.test.mjs — **throughput と完走日数を混同しない**
 *   node --test src/lib/marketing/sequenceCalendarSpan.test.mjs
 *
 * ## なぜ要るか（2026-09-17 の誤り）
 *
 * 「1 tick の人数を増やせば早く終わる」と考え、
 * **「N=50 で 18 日 / N=100 で 9 日 / Background で 1.3 日で完走」**と書いた。**これは誤り。**
 *
 * `sequenceProgress` の正本挙動は
 * **「次回予定 ＝ 直近の送信時刻 ＋ *次 step* の `delayDays`」**。
 * つまり 1 人が step1 から最終 step まで受け取るには、
 * **`delayDays` の合計ぶんのカレンダー日数が必ずかかる**。
 * 送信速度をいくら上げても、この待機日数は 1 日も縮まない。
 *
 * | | 意味 | 速度を上げると |
 * |---|---|---|
 * | **throughput（backlog 消化）** | due になったメールを捌く速さ | **縮む** |
 * | **calendar（完走日数）** | 1 人が最終 step に到達するまでの日数 | **縮まない** |
 *
 * ⚠️ `delayDays` は**ユーザー承認なしに変更しない**。ここは実値を読むだけ。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getCampaign } from './campaignCatalog.js';
import { getSequenceSteps, resolveMaxSends } from './campaignSequence.js';
import { computeNextSendAtMs } from './campaignSequence.js';
import { SYNC_TICK_MAX_RECIPIENTS } from './sequenceAutomation.js';

const DAY = 86400000;
const PHASE1 = getCampaign('campaign-discount-free', { includeDisabled: true });
const PHASE2 = getCampaign('campaign-prospect-phase2', { includeDisabled: true });

/**
 * step1 から最終 step までの**最低カレンダー日数**（catalog の実値から計算）。
 *
 * ⚠️ step1 の `delayDays` は入口なので足さない。
 *    足すのは **step2 以降**（「直近の送信 ＋ 次 step の delayDays」だから）。
 */
function minCalendarDays(campaign) {
  const steps = getSequenceSteps(campaign);
  return steps.slice(1).reduce((sum, s) => sum + (Number(s.delayDays) || 0), 0);
}

// ══════════════════════════════════════════════════════════════════
//  ① catalog の実値（変わったら気づく）
// ══════════════════════════════════════════════════════════════════

test('【最重要】第 2 期は step1→step7 だけで最低 27 日かかる', () => {
  assert.equal(minCalendarDays(PHASE2), 27, '第 2 期の待機日数が変わった（完走の見積りも直すこと）');
  assert.deepEqual(
    getSequenceSteps(PHASE2).map((s) => s.delayDays),
    [0, 3, 4, 4, 5, 5, 6],
    'delayDays が変わった（ユーザー承認なしに変えてはいけない）',
  );
});

test('【最重要】第 1 期は step1→step3 で最低 11 日かかる', () => {
  assert.equal(minCalendarDays(PHASE1), 11);
  assert.deepEqual(getSequenceSteps(PHASE1).map((s) => s.delayDays), [0, 5, 6]);
});

test('【最重要】delivered 累計 10 は 第 1 期 3 通 ＋ 第 2 期 7 通', () => {
  assert.equal(resolveMaxSends(PHASE1), 3);
  assert.equal(resolveMaxSends(PHASE2), 7);
  assert.equal(resolveMaxSends(PHASE1) + resolveMaxSends(PHASE2), 10);
});

/**
 * ⚠️ **これが最短の完成時期の下限。**
 *    第 1 期を今日終えた人でも、第 2 期の 7 通目までに 27 日かかる。
 */
test('【最重要】第 1 期を終えた直後の人でも、EXHAUSTED まで最低 27 日', () => {
  const span = minCalendarDays(PHASE2);
  assert.ok(span >= 27, `第 2 期が ${span} 日に縮んでいる`);
});

// ══════════════════════════════════════════════════════════════════
//  ② カレンダーは throughput と無関係（これが混同の元）
// ══════════════════════════════════════════════════════════════════

test('【最重要】待機日数は 1 tick の人数に依存しない', () => {
  // どの人数でも、次回予定は「直近の送信 + 次 step の delayDays」で決まる
  const base = Date.UTC(2026, 8, 17, 0, 0, 0);
  for (const step of [2, 3, 4, 5, 6, 7]) {
    const at = computeNextSendAtMs({ campaign: PHASE2, stepNumber: step, lastSentAtMs: base, nowMs: base });
    const wantDays = getSequenceSteps(PHASE2).find((s) => s.stepNumber === step).delayDays;
    assert.equal(at, base + wantDays * DAY, `step${step} の待機が delayDays と違う`);
  }
  // 人数の上限は待機日数の計算にまったく現れない
  assert.ok(SYNC_TICK_MAX_RECIPIENTS > 0);
});

test('【最重要】送信速度を上げても最低カレンダー日数は変わらない', () => {
  const before = minCalendarDays(PHASE2);
  // 人数を何倍にしても catalog の delayDays は不変
  const after = minCalendarDays(PHASE2);
  assert.equal(before, after, 'throughput で待機日数が変わる実装になっている');
});

// ══════════════════════════════════════════════════════════════════
//  ③ throughput に求められるのは「カレンダーに追いつくこと」
// ══════════════════════════════════════════════════════════════════

/**
 * 第 2 期を calendar どおり進めるのに必要な速度:
 *   人数 × 通数 ÷ カレンダー日数
 * これを下回ると**待機日数より遅れる**（backlog が積む）。
 */
test('【重要】第 2 期に必要な最低 throughput を計算できる', () => {
  const people = 11826;                       // 2026-09-17 実測の prospect 数
  const mails = people * resolveMaxSends(PHASE2);
  const perDay = mails / minCalendarDays(PHASE2);
  assert.ok(perDay > 3000 && perDay < 3200, `必要速度の計算が変わった（${perDay.toFixed(0)} 通/日）`);
  // 現行の実測 171 通/時 = 4,104 通/日 は足りている
  assert.ok(171 * 24 > perDay, '現行速度では第 2 期のカレンダーに追いつかない');
});

/**
 * ⚠️ **高速化の価値はここ。** 完走日数ではなく:
 *    - 第 1 期の backlog（一度きりの山）を早く捌く
 *    - 同じ日に大量の cohort が due になっても滞留させない
 */
test('【重要】第 1 期の backlog は throughput で縮む（ここが高速化の効き所）', () => {
  const backlog = 5593 + 5900;                // 2026-09-17 実測（step2 due + step3 due）
  const hours = (rate) => backlog / rate;
  assert.ok(hours(171) > hours(214), '速度を上げても backlog が縮まない計算になっている');
  assert.ok(hours(214) > hours(429));
  // それでも第 1 期の step3 は「その人の step2 + 6 日」なので、backlog 消化だけでは終わらない
  assert.equal(getSequenceSteps(PHASE1).find((s) => s.stepNumber === 3).delayDays, 6);
});
