/**
 * prospectWindowStepSafety.test.mjs — **窓で step 順序を壊さない**
 *   node --test src/lib/marketing/prospectWindowStepSafety.test.mjs
 *
 * ## これが事故そのもの（2026-09-17 のレビュー指摘）
 *
 * `selectNextDueStep` は「**全体で**いちばん小さい due step」を選ぶ。
 * prospect の読み込みを窓で切ると progress は**窓の中だけ**から作られるので:
 *
 * | | step2 due | step3 due |
 * |---|---|---|
 * | 窓 A | **0** | あり |
 * | 窓 B | あり | — |
 *
 * カーソルが窓 A を指す tick で「窓の中の最小」が step3 になり、
 * **全体にはまだ step2 待ちが残っているのに step3 を先に送ってしまう**。
 *
 * ⚠️ **性能改善のために step 順序を変えてはいけない。**
 *    証明できないときは全件へ落とす（fail closed）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  isWindowStepDecisionSafe, minSelectableDueStep, lowestSelectableStep,
  LOWEST_SELECTABLE_STEP_DEFAULT,
} from './prospectWindowStepSafety.js';

const CRON = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/cron-campaign-sequence.js', import.meta.url)),
  'utf8',
);

// ══════════════════════════════════════════════════════════════════
//  ① 指摘そのもの — 窓 A（step3 だけ）で step3 を送らない
// ══════════════════════════════════════════════════════════════════

test('【最重要】窓に step3 due しか無いとき、窓の判断を採用しない（step3 を先行させない）', () => {
  // 窓 A: step2 due 0 / step3 due あり
  const v = isWindowStepDecisionSafe({ dueByStep: { 2: 0, 3: 1947 } });
  assert.equal(v.safe, false, '窓 A の判断を採用して step3 を送ってしまう');
  assert.equal(v.reason, 'lower_step_may_exist_outside_window');
  assert.equal(v.windowMinStep, 3);
});

test('【最重要】窓に step2 due が 1 人でもあれば窓の判断でよい（それが全体の最小）', () => {
  // 窓 B 相当。step2 は「選べる最小」なので、これより小さい due は全体に存在し得ない
  const v = isWindowStepDecisionSafe({ dueByStep: { 2: 5, 3: 1947 } });
  assert.equal(v.safe, true);
  assert.equal(v.reason, 'window_min_is_lowest_possible');
  assert.equal(v.windowMinStep, 2);
});

test('【最重要】全体の step2 due が 0 になって初めて step3 が許される', () => {
  // 窓の中に step2 が無い → 窓では判断できない（全件を読み直して初めて step3 を選べる）
  assert.equal(isWindowStepDecisionSafe({ dueByStep: { 3: 10 } }).safe, false);
  // 全件を読んだ（＝窓ではない）なら step3 でよい
  assert.equal(isWindowStepDecisionSafe({ dueByStep: { 3: 10 }, windowed: false }).safe, true);
});

test('【最重要】窓に due が 1 人も居なくても「送る相手なし」と結論しない', () => {
  const v = isWindowStepDecisionSafe({ dueByStep: {} });
  assert.equal(v.safe, false, '窓が空なだけで全体を空と決めつけている');
  assert.equal(v.reason, 'window_has_no_due');
});

// ══════════════════════════════════════════════════════════════════
//  ② phase2 の複数 step へ一般化（後段が先行しない）
// ══════════════════════════════════════════════════════════════════

test('【最重要】第 2 期の 7 step でも、後段 step が先行しない', () => {
  // 窓に step4..7 しか無い → どれも採用しない（step2/3 が窓の外に居るかもしれない）
  for (const min of [3, 4, 5, 6, 7]) {
    const dueByStep = { [min]: 100 };
    const v = isWindowStepDecisionSafe({ dueByStep });
    assert.equal(v.safe, false, `窓の最小が step${min} なのに採用している`);
  }
  // step2 が居るときだけ採用してよい
  assert.equal(isWindowStepDecisionSafe({ dueByStep: { 2: 1, 7: 100 } }).safe, true);
});

test('【最重要】入口が開いている campaign では step1 が最小（それでも順序は守る）', () => {
  assert.equal(lowestSelectableStep({ allowFirstStep: true }), 1);
  assert.equal(lowestSelectableStep({ allowFirstStep: false }), LOWEST_SELECTABLE_STEP_DEFAULT);
  // 入口が開いているとき、窓の最小が step2 なら step1 が窓の外に居るかもしれない
  const v = isWindowStepDecisionSafe({ dueByStep: { 2: 10 }, allowFirstStep: true });
  assert.equal(v.safe, false, 'step1 が窓の外に居る可能性を無視している');
  // step1 が窓にあれば最小なので採用してよい
  assert.equal(isWindowStepDecisionSafe({ dueByStep: { 1: 3 }, allowFirstStep: true }).safe, true);
});

// ══════════════════════════════════════════════════════════════════
//  ③ 数え方（0 件を due と数えない）
// ══════════════════════════════════════════════════════════════════

test('【重要】件数 0 の step は due と数えない', () => {
  assert.equal(minSelectableDueStep({ dueByStep: { 2: 0, 3: 5 } }), 3);
  assert.equal(minSelectableDueStep({ dueByStep: { 2: 0, 3: 0 } }), null);
});

test('【重要】選べない step（step1 が除外のとき）は無視する', () => {
  // step1 に due が居ても、選べないので最小は 2
  assert.equal(minSelectableDueStep({ dueByStep: { 1: 328, 2: 5 } }), 2);
  assert.equal(minSelectableDueStep({ dueByStep: { 1: 328 } }), null);
});

test('【重要】壊れた値は数えない', () => {
  assert.equal(minSelectableDueStep({ dueByStep: { x: 5, 3: 'abc', 4: 2 } }), 4);
  assert.equal(minSelectableDueStep({}), null);
  assert.equal(minSelectableDueStep({ dueByStep: null }), null);
});

// ══════════════════════════════════════════════════════════════════
//  ④ 実経路の配線（窓を使ったときだけ確かめ、危なければ全件へ落ちる）
// ══════════════════════════════════════════════════════════════════

test('【最重要】cron は窓を使ったとき必ず安全性を確かめる', () => {
  assert.match(CRON, /isWindowStepDecisionSafe\(\{/, '安全性の判定を呼んでいない');
  assert.match(CRON, /prospectWindowed/, '窓を使ったかどうかを持っていない');
});

test('【最重要】証明できないときは全件で読み直す（fail closed）', () => {
  assert.match(CRON, /if \(!verdict\.safe\)/, '危ないときの分岐が無い');
  // 全件読み直し = maxRecipients / offset を渡さない呼び出し
  const i = CRON.indexOf('if (!verdict.safe)');
  const body = CRON.slice(i, i + 1400);
  assert.match(body, /loadProspectSequenceInputs\(\{/, '全件で読み直していない');
  assert.equal(/maxRecipients: prospectWindowSize/.test(body), false, '読み直しでも窓を掛けている');
  assert.match(body, /prospectWindowed = false/, '読み直した後も窓扱いのままになっている');
});

test('【最重要】読み直しに失敗したら窓のまま進めない（順序を壊さない）', () => {
  const i = CRON.indexOf('if (!verdict.safe)');
  const body = CRON.slice(i, i + 1400);
  assert.match(body, /prospectInputs = null/, '読み直し失敗でも窓のまま送ろうとしている');
});

test('【最重要】カーソルを進めるのは窓を使ったときだけ', () => {
  assert.match(CRON, /prospectInputs && prospectWindowed && prospectScanStore\.usable/,
    '全件を読んだ tick でも窓のカーソルを進めている');
});

test('【重要】性能のために順序を変えない、と明記されている', () => {
  assert.match(CRON, /性能のために step 順序を変えない/, '意図の記述が消えている');
});
