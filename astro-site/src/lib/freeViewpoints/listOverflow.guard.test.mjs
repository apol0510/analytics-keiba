/**
 * listOverflow.guard.test.mjs — 長いレース名でも `/free/` がスマホ幅を超えない（2026-09-27 不具合修正）。
 *
 * 事象: .rvb-list（grid）の子が既定の min-width:auto のまま、折り返さないレース名の最小内容幅が
 *       列幅になり、/free/nankan/ が 390px 画面で 437px（詳細を開くと 451px）まで広がった
 *       （2026-09-28 船橋 3R「船橋デビュー馬未勝利選抜馬」など）。
 * 修正: 列の最小幅を 0 に（minmax(0, 1fr)）し、行の grid／flex の子に min-width:0。
 *       レース名は 1 行のまま「…」で省略する。
 *
 * レイアウトの実測（390 / 360 / 320px・全レースを開閉）は PR で実施。ここでは再発の原因になる
 * 指定が消えていないことを固定する（後勝ちの規則を見る）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const board = readFileSync(join(ROOT, 'src/components/RaceViewpointsBoard.astro'), 'utf-8');
// CSS コメントはセレクタの一部として読まないよう除く
const style = board.slice(board.indexOf('<style'), board.lastIndexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// セレクタを含む規則（カンマ区切りの一部でも可）の宣言をすべて集める
const decls = (sel) => [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((m) => m[1].split(',').map((x) => x.trim()).includes(sel))
  .map((m) => m[2]);
const lastValue = (sel, prop) => {
  const vals = decls(sel).map((d) => (d.match(new RegExp(`(?:^|;)\\s*${esc(prop)}\\s*:\\s*([^;]+)`)) || [])[1]).filter(Boolean);
  return vals.length ? vals[vals.length - 1].trim() : null;
};

test('一覧（grid）の列は最小幅 0 まで縮められる', () => {
  assert.equal(lastValue('.rvb-list', 'display'), 'grid', '.rvb-list が grid でない（前提が変わった）');
  assert.match(lastValue('.rvb-list', 'grid-template-columns') || '', /minmax\(\s*0\s*,\s*1fr\s*\)/,
    '列の最小幅が 0 でない（長いレース名で列が広がる）');
});

test('行の grid／flex の子に min-width:0 がある', () => {
  for (const sel of ['.rvb-row', '.rvb-row > .rvb-detail', '.rvb-row > .rvb-detail > .rvb-detail-sum', '.rvb-sum-line', '.rvb-marks']) {
    assert.equal(lastValue(sel, 'min-width'), '0', `${sel} に min-width:0 が無い`);
  }
});

test('レース名は 1 行のまま「…」で省略する', () => {
  const sel = '.rvb-sum-line .rvb-name';
  assert.equal(lastValue(sel, 'min-width'), '0');
  assert.equal(lastValue(sel, 'overflow'), 'hidden');
  assert.equal(lastValue(sel, 'text-overflow'), 'ellipsis');
  assert.equal(lastValue(sel, 'white-space'), 'nowrap');
});

test('印のチップも行幅を超えない', () => {
  assert.equal(lastValue('.rvb-marks .rm', 'max-width'), '100%');
  assert.equal(lastValue('.rvb-marks .rm-rest', 'max-width'), '100%');
});
