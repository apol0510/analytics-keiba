/**
 * beginnerHelp.guard.test.mjs
 *
 * 2026-08-20 確定: 対象は**競馬を始めたばかりの人**。
 * 「初コース」「乗り替わり」「中◯週」も知らない前提で読めるようにする。
 *
 * 守ること:
 *   - 用語には**やさしい言い換え**が付いている
 *   - 言い換えは**事実の説明**に留める（予想の評価を書かない）
 *   - 説明は**既定で出る**（JS が動かない環境でも読める）
 *   - 割合は「何のうち何か」が分かる形にする
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TERM_HELP, CHIP_HELP, HOW_TO_USE, HELP_TOGGLE,
  TAG_LABEL, HORSE_CHANGE_CHIP, BANNED_JUDGEMENT_WORDS,
} from './copy.js';
import { TAG } from './raceViewpoints.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const board = readFileSync(join(ROOT, 'src/components/RaceViewpointsBoard.astro'), 'utf-8');

const allHelpText = () => [
  ...Object.values(TERM_HELP), ...Object.values(CHIP_HELP),
  HOW_TO_USE.lead, ...HOW_TO_USE.steps.flatMap((s) => [s.title, s.body]),
];

// ─── 用語の言い換え ───────────────────────────────────────────

test('すべてのタグにやさしい言い換えがある', () => {
  for (const t of Object.values(TAG)) {
    assert.ok(TERM_HELP[t], `${TAG_LABEL[t] || t} に説明が無い`);
    assert.ok(TERM_HELP[t].length >= 10, `${t} の説明が短すぎる`);
  }
});

test('馬ごとのチップすべてに説明がある', () => {
  for (const k of Object.keys(HORSE_CHANGE_CHIP)) {
    assert.ok(CHIP_HELP[k], `${k} に説明が無い`);
  }
  for (const k of ['interval', 'bodyWeight']) {
    assert.ok(CHIP_HELP[k], `${k} に説明が無い`);
  }
});

test('説明は事実の言い換えに留める（予想の評価を書かない）', () => {
  for (const text of allHelpText()) {
    for (const w of BANNED_JUDGEMENT_WORDS) {
      assert.equal(text.includes(w), false, `「${w}」は評価語。説明に入れない: ${text}`);
    }
  }
});

test('初めての人が読めない言い方をそのまま残さない', () => {
  // 「初コース」「乗り替わり」は言い換えの中で説明されていること
  assert.ok(TERM_HELP[TAG.FIRST_COURSE].includes('初めて'), '初コースを言い換えていない');
  assert.ok(TERM_HELP[TAG.JOCKEY_CHANGE].includes('騎手'), '乗り替わりを言い換えていない');
  assert.ok(CHIP_HELP.interval.includes('間が空いた') || CHIP_HELP.interval.includes('空き'),
    '出走間隔（中◯週）を言い換えていない');
});

// ─── 表示のしかた ─────────────────────────────────────────────

test('説明は既定で表示される（JS が動かなくても読める）', () => {
  const m = board.match(/\.rvb-help\s*\{([^}]*)\}/);
  assert.ok(m, '.rvb-help のスタイルが無い');
  assert.equal(/display:\s*none/.test(m[1]), false,
    '既定で隠すと JS が動かない環境で説明が読めない');
  assert.ok(/\[data-rvb-help="off"\][\s\S]{0,80}display:\s*none/.test(board),
    'オフにしたときだけ隠す指定が無い');
});

test('割合は「何頭中何頭」で出す（3/12 のような書き方にしない）', () => {
  assert.ok(board.includes('頭中'), '「◯頭中◯頭」の表記になっていない');
  assert.equal(/\{ev\.n\}\/\{ev\.of\}/.test(board), false, '分数表記が残っている');
});

test('出走間隔は日数を先に出す（中◯週だけにしない）', () => {
  assert.ok(board.includes('前走から') && board.includes('日ぶり'),
    '「前走から◯日ぶり」の形になっていない');
});

// ─── 使い方ブロック ───────────────────────────────────────────

test('使い方は 3 ステップで、買い目の扱いにも触れる', () => {
  assert.equal(HOW_TO_USE.steps.length, 3);
  for (const s of HOW_TO_USE.steps) {
    assert.ok(s.title && s.body, 'ステップに見出しか本文が無い');
  }
  assert.ok(HOW_TO_USE.note.includes('買い目'), '買い目がここに無いことを伝えていない');
  assert.ok(HOW_TO_USE.note.includes('有料版'), '買い目の在りかを伝えていない');
});

test('使い方ブロックとかんたん表示トグルが実装されている', () => {
  assert.ok(board.includes('rvb-howto'), '使い方ブロックが無い');
  assert.ok(board.includes('rvb-help-toggle'), 'かんたん表示トグルが無い');
  assert.ok(board.includes('aria-pressed'), 'トグルの状態が支援技術へ伝わらない');
  assert.ok(HELP_TOGGLE.on && HELP_TOGGLE.off, 'トグルの文言が無い');
});

test('凡例の記号に説明が付いている（記号だけにしない）', () => {
  const legend = board.slice(board.indexOf('rvb-legend'), board.indexOf('</ul>', board.indexOf('rvb-legend')));
  const titled = (legend.match(/title="/g) || []).length;
  assert.ok(titled >= 5, `凡例の説明が足りない（${titled} 件）`);
});
