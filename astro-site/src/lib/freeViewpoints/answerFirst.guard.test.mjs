/**
 * answerFirst.guard.test.mjs — `/free/` は「答えが先」（2026-09-27 MK 確定 / docs/decisions.md）。
 *
 *   ヘッダー → 今日の無料予想（印）→ 読み方（折りたたみ）→ 全レース一覧（行に印）→ 実績・登録案内
 *
 * 既存の分析情報は削除せず、位置と開閉だけ変えたことを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANSWER, BANNED_JUDGEMENT_WORDS, BANNED_PAID_TERMS } from './copy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf-8');
const board = read('src/components/RaceViewpointsBoard.astro');
const markup = board.slice(board.indexOf('<section class="rvb">'), board.indexOf('<script is:inline>'));
const answerLib = read('src/lib/freeViewpoints/answerView.js');
const at = (needle) => {
  const i = markup.indexOf(needle);
  assert.ok(i > -1, `${needle} が無い`);
  return i;
};

test('並びは「ヘッダー → 今日の無料予想 → 読み方 → 全レース一覧 → 実績・登録案内」', () => {
  const order = [
    '</header>', 'class="rvb-answer"', 'class="rvb-guide"', 'id="rvb-races"',
    '<ol class="rvb-list"', 'class="rvb-more"', 'class="rvb-foot"',
  ].map(at);
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] < order[i], `並びが崩れている（${i}）`);
});

test('無料登録・有料の実績バナーは答えより後ろ（主役にしない）', () => {
  const list = at('<ol class="rvb-list"');
  for (const cta of ['class="rvb-topgate"', 'class="rvb-topmember"', '<slot name="results"', 'href="/free-signup/"']) {
    assert.ok(markup.indexOf(cta) > list, `${cta} が一覧より前にある`);
  }
  const header = markup.slice(0, at('</header>'));
  assert.equal(/free-signup|\/pricing\//.test(header), false, 'ヘッダーに CTA がある');
});

test('既存の分析情報を削除していない（読み方は折りたたみの中に残す）', () => {
  const guide = markup.slice(at('class="rvb-guide"'), at('id="rvb-races"'));
  for (const cls of ['rvb-lead', 'rvb-howto', 'rvb-help-toggle', 'rvb-legend']) {
    assert.ok(guide.includes(cls), `読み方に ${cls} が無い`);
  }
  assert.equal(/<details class="rvb-guide"[^>]*\bopen\b/.test(markup), false, '読み方が既定で開いている');
  for (const cls of ['rvb-row-tags', 'rvb-tag-help', 'rvb-detail', 'rvb-horses', 'rvb-highlight', 'rvb-signup-cta']) {
    assert.ok(markup.includes(cls), `${cls} が消えている`);
  }
});

test('全レース一覧の各行に、開かなくても印が見える', () => {
  const row = markup.slice(at('<li class={`rvb-row'), at('<details class="rvb-detail"'));
  assert.ok(row.includes('rvb-row-marks'), '行に印が無い');
  assert.ok(row.includes('headlineMarksOf(race.horseRows)'), '行の印が公開 DTO 由来でない');
});

test('今日の無料予想は公開 DTO の印だけから作る（有料モジュールを読まない）', () => {
  assert.ok(board.includes('buildAnswerPicks(view)'));
  for (const bad of ['shared-prediction-logic', 'loadFeatureScores', 'mainRaceBetting', 'osaeClassification', 'resultsShowcase']) {
    assert.equal(answerLib.includes(bad), false, `answerView.js が ${bad} を読んでいる`);
  }
  for (const bad of ['computerIndex', 'bettingLines', '.pt', 'role', 'importance']) {
    assert.equal(answerLib.includes(bad), false, `answerView.js に ${bad} がある`);
  }
});

test('答えの文言に役割名・評価語を書かない', () => {
  const words = Object.values(ANSWER).filter((v) => v !== ANSWER.markline).join(' ');
  for (const w of [...BANNED_PAID_TERMS, ...BANNED_JUDGEMENT_WORDS]) {
    assert.equal(words.includes(w), false, `文言に「${w}」がある`);
  }
  // markline は「買い目は有料版」の案内だけを許す（無料予想の語と一緒に出す約束）
  assert.ok(ANSWER.markline.includes('買い目は有料版'));
  for (const w of ['本命', '対抗', '単穴', '連下', ...BANNED_JUDGEMENT_WORDS]) {
    assert.equal(ANSWER.markline.includes(w), false, `markline に「${w}」がある`);
  }
});

test('スマホで読める大きさ（新しい部分は 0.85rem 以上）', () => {
  const css = board.slice(board.indexOf('2026-09-27 MK: 答えを先に見せる'));
  const sizes = [...css.matchAll(/font-size:\s*([0-9.]+)rem/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length > 0);
  assert.ok(Math.min(...sizes) >= 0.85, `小さすぎる文字: ${Math.min(...sizes)}rem`);
});

test('/free-prediction/ は今回変更しない（PR #597 の注目馬ブロックを持ち込まない）', () => {
  for (const c of ['jra', 'nankan']) {
    const src = read(`src/pages/free-prediction/${c}.astro`);
    assert.equal(src.includes('FreePreviewFirstView'), false);
    assert.equal(src.includes('rvb-answer'), false);
  }
});
