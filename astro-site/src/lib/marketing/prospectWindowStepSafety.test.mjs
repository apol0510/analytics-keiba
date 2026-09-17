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
 *
 * ## このファイルの位置づけ（重要）
 *
 * ここにあるのは**純粋関数の検証**と、配線が外れていないかを見る**ソース文字列の確認**。
 * 文字列が一致しても「実行されている」ことの証明にはならないので、
 * **最重要仕様は挙動テスト `prospectWindowFallback.behavior.test.mjs` が固定する**
 * （`runSequenceTick` を偽の Redis / Airtable / SendGrid で実際に動かし、
 * 送信 0・印だけ保存・次 tick は全件・失敗時 fail closed を結果で確かめる）。
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

test('【最重要】証明できないときは、そのtickで 1 件も積まずに終わる', () => {
  assert.match(CRON, /if \(!verdict\.safe\)/, '危ないときの分岐が無い');
  const i = CRON.indexOf('if (!verdict.safe)');
  const body = CRON.slice(i, i + 1200);
  assert.match(body, /abort: 'window_needs_full_reload'/, '中止していない');
  /**
   * ⚠️ 送信・queue・予約・Airtable 変更は **0** だが、**印（走査カーソル）は書いている**。
   *    `'none'` と言い切るのは事実と違うので、書けたときだけ `cursor_state_only`。
   *    **実際にその値が出ること**は挙動テスト（`prospectWindowFallback.behavior.test.mjs`）が確かめる。
   */
  assert.match(body, /sideEffects: marked\.ok === true \? 'cursor_state_only' : 'none'/,
    '印を書いたのに副作用ゼロと言っている（または書けたかを区別していない）');
  assert.match(body, /setFullRequired\(/, '次の tick を全件で始める印を残していない');
});

test('【最重要】全件の周回では窓を掛けない（印が立っている tick は窓を読まない）', () => {
  assert.match(CRON, /\} : \(prospectFullRequired \? \{/, '印が立っていても窓を掛けている');
  assert.match(CRON, /if \(!win && !prospectFullRequired\) prospectWindowed = true;/,
    '印が立っている tick でも窓扱いのままになっている');
});

test('【最重要】カーソルを進めるのは窓を使ったときだけ', () => {
  assert.match(CRON, /prospectInputs && prospectWindowed && prospectScanStore\.usable/,
    '全件を読んだ tick でも窓のカーソルを進めている');
});

test('【重要】性能のために順序を変えない、と明記されている', () => {
  assert.match(CRON, /性能のために step 順序を変えない/, '意図の記述が消えている');
});

// ══════════════════════════════════════════════════════════════════
//  ⑤ 後段フィルタで 0 人になっても、窓の中だけで次 step へ進まない
// ══════════════════════════════════════════════════════════════════

/**
 * ## 2 つ目の穴（2026-09-17 のレビュー指摘）
 *
 * 事前の窓判定は「窓に最小 step の **due** が居るか」しか見ない。
 * ところが実送信の手前で、既に `queued` / `sent`・出所フィルタ・許可リストによって
 * **その step の送れる人が 0 人**になることがある。
 *
 *   窓 A: step2 due 5 人（**全員 `queued` で送れない**）／ step3 は送れる
 *   窓 B: **送れる step2** が残っている
 *
 * カーソルが窓 A のとき、既存の `emptySteps` による選び直しが働くと
 * **step3 を先行させてしまう**（全体には送れる step2 が残っているのに）。
 *
 * → **窓のときは次 step へ進まず、全件で読み直してやり直す。**
 */
test('【最重要】窓で最小 step が後段条件 0 人になったら、そのtickは 0 件で終わる', () => {
  const i = CRON.indexOf('targets.length === 0 && mayAdvanceStep && prospectWindowed');
  assert.ok(i > 0, '窓のときに次 step へ進めない分岐が無い');
  const body = CRON.slice(i, i + 1200);
  assert.match(body, /abort: 'window_needs_full_reload'/, '中止していない');
  assert.match(body, /reason: 'zero_sendable_in_window'/, '理由を残していない');
  /**
   * ⚠️ 送信・queue・予約・Airtable 変更は **0** だが、**印（走査カーソル）は書いている**。
   *    `'none'` と言い切るのは事実と違うので、書けたときだけ `cursor_state_only`。
   *    **実際にその値が出ること**は挙動テスト（`prospectWindowFallback.behavior.test.mjs`）が確かめる。
   */
  assert.match(body, /sideEffects: marked\.ok === true \? 'cursor_state_only' : 'none'/,
    '印を書いたのに副作用ゼロと言っている（または書けたかを区別していない）');
  assert.match(body, /setFullRequired\(/, '次の tick を全件で始める印を残していない');
});

/**
 * ⚠️ **同じ tick で「窓 → 全件」と 2 度走査してはいけない。**
 *    窓で時間を使ったあとに全件を読むと、`claimDelivered`（予約）のあと
 *    queue / upsert の途中で締切に達し、**予約だけ残って二度と送られない**。
 */
test('【最重要】同一 tick 内で window+full を二重走査しない（再入しない）', () => {
  assert.equal(/return runSequenceTick\(/.test(CRON), false,
    '同じ tick の中で自分を呼び直している（窓+全件の二重走査）');
  assert.equal(/forceFullProspect/.test(CRON), false, '同一 tick 再入のフラグが残っている');
});

test('【最重要】印を書けなくても後段 step へ進まない（fail closed）', () => {
  const i = CRON.indexOf("reason: 'zero_sendable_in_window'");
  const body = CRON.slice(Math.max(0, i - 900), i + 600);
  // 書けたかどうかに関わらず return している（分岐で送信側へ戻らない）
  assert.match(body, /markedForFullReload: marked\.ok === true/, '書けたかを記録していない');
  assert.equal(/if \(marked\.ok\)/.test(body), false, '印が書けたときだけ止める形になっている');
});

test('【最重要】全件を正常に読めたら印を外す', () => {
  assert.match(CRON, /clearFullRequired\(/, '印を外していない');
  const i = CRON.indexOf('clearFullRequired(');
  const body = CRON.slice(Math.max(0, i - 400), i + 200);
  assert.match(body, /prospectFullRequired && prospectInputs/, '全件を読めたときだけ外す形になっていない');
});

test('【最重要】全件の tick ではカーソルを進めない', () => {
  // カーソル前進は prospectWindowed のときだけ（印が立った tick は windowed=false）
  assert.match(CRON, /prospectInputs && prospectWindowed && prospectScanStore\.usable/,
    '全件の tick でもカーソルを進めている');
});

test('【最重要】次 step の選び直し（emptySteps）は全件を読んだときだけ許す', () => {
  const advance = CRON.indexOf('emptySteps.push(plan.step);');
  const guard = CRON.indexOf('targets.length === 0 && mayAdvanceStep && prospectWindowed');
  assert.ok(guard > 0 && guard < advance,
    '窓のガードより先に emptySteps へ進んでいる（step が飛ぶ）');
});

test('【最重要】印が立った tick は窓を読まず、全件だけを 1 回実行する', () => {
  assert.match(CRON, /prospectFullRequired = prospectCursor\.fullRequired === true/,
    '印を読んでいない');
  assert.match(CRON, /if \(!win && !prospectFullRequired\) prospectWindowed = true;/,
    '印が立った tick でも窓扱いになっている');
});

test('【最重要】全件の読み込みに失敗したら 1 件も送らない（fail closed）', () => {
  assert.match(CRON, /abort: 'prospect_full_reload_failed'/, '読み込み失敗の fail closed が無い');
  const i = CRON.indexOf("abort: 'prospect_full_reload_failed'");
  const body = CRON.slice(Math.max(0, i - 500), i + 200);
  assert.match(body, /if \(prospectFullRequired\)/, '全件の tick でだけ止める形になっていない');
});

test('【最重要】窓の事前判定も同じ「印を残して 0 件で終わる」経路（1 本）', () => {
  const i = CRON.indexOf('if (!verdict.safe) {');
  const body = CRON.slice(i, i + 1200);
  assert.match(body, /setFullRequired\(/, '事前判定が別経路になっている');
  assert.match(body, /abort: 'window_needs_full_reload'/, '事前判定が中止していない');
  /**
   * ⚠️ 送信・queue・予約・Airtable 変更は **0** だが、**印（走査カーソル）は書いている**。
   *    `'none'` と言い切るのは事実と違うので、書けたときだけ `cursor_state_only`。
   *    **実際にその値が出ること**は挙動テスト（`prospectWindowFallback.behavior.test.mjs`）が確かめる。
   */
  assert.match(body, /sideEffects: marked\.ok === true \? 'cursor_state_only' : 'none'/,
    '印を書いたのに副作用ゼロと言っている（または書けたかを区別していない）');
});

/**
 * ⚠️ 出所フィルタ・suppression で 0 人になった場合も同じ扱い。
 *    理由を問わず「窓で 0 人 → 次 step」を禁じているので、経路は 1 本で足りる。
 */
test('【最重要】0 人の理由（既queued / 出所 / 許可リスト）で分岐しない', () => {
  const guard = CRON.indexOf('targets.length === 0 && mayAdvanceStep && prospectWindowed');
  const body = CRON.slice(guard, guard + 1200);
  // 条件は targets.length === 0 だけ。理由ごとの分岐（if）を作らない
  assert.equal(/if \(droppedByFilter|if \(droppedByAllowlist|if \(alreadyQueued/.test(body), false,
    '0 人の理由ごとに扱いを変えている（漏れる理由が出る）');
  assert.match(body, /targets\.length === 0/, '0 人という一点で判定していない');
});

test('【最重要】第 2 期の step2〜7 でも、窓の中だけで後段 step へ進まない', () => {
  // ガードは step 番号に依存しない（どの step でも窓なら全件へ落ちる）
  const guard = CRON.indexOf('targets.length === 0 && mayAdvanceStep && prospectWindowed');
  const body = CRON.slice(guard, guard + 700);
  assert.equal(/plan\.step === 2|plan\.step < |plan\.step > /.test(body), false,
    'step 番号で条件を分けている（特定 step だけ守られる）');
});
