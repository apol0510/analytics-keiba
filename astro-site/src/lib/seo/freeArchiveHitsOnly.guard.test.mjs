/**
 * 無料予想の日付一覧・日付ページは的中が主役（MK 2026-11-25・共通 A-2）。
 * 分母（例「14/24R」）・✗・不的中・0 件の表記を出さない。全件と算定ルールは /archive/・/results-showcase/ にだけ置く。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hitCountLabel } from '../dayResultsView.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const stripComments = (s) => s.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('hitCountLabel は的中数だけ・0 件は null', () => {
  assert.equal(hitCountLabel(3), '的中 3R');
  assert.equal(hitCountLabel(0), null);
  assert.equal(hitCountLabel(null), null);
  assert.equal(hitCountLabel(undefined), null);
});

const FILES = [
  'src/pages/free-prediction/jra/archive.astro',
  'src/pages/free-prediction/nankan/archive.astro',
  'src/pages/free-prediction/jra/[date].astro',
  'src/pages/free-prediction/nankan/[date].astro',
  'src/components/DayResultsSummary.astro',
];

test('無料予想の一覧・日付ページに分母・✗・不的中を出さない', () => {
  for (const f of FILES) {
    const src = stripComments(read(f));
    assert.ok(!src.includes('不的中'), `${f}: 不的中`);
    assert.ok(!src.includes('✗'), `${f}: ✗`);
    assert.ok(!/hitRaces\}\s*\/\s*\$?\{/.test(src), `${f}: 的中の分母`);
    assert.ok(!/\.length\}\s*\/\s*\$\{/.test(src), `${f}: 的中の分母`);
    assert.ok(!/resultRaces/.test(src), `${f}: resultRaces（分母）`);
  }
});

test('一覧の的中表記は hitCountLabel（0 件は「的中 0」を出さない）', () => {
  for (const f of FILES.slice(0, 2)) assert.match(read(f), /hitCountLabel\(/, f);
});

test('的中数の行に全レース数を並べない（「全24レース ／ 14レース的中」も分母）', () => {
  for (const f of FILES) {
    for (const line of stripComments(read(f)).split('\n')) {
      if (line.includes('レース的中')) assert.ok(!/totalRaces/.test(line), `${f}: ${line.trim()}`);
    }
  }
});

test('一覧は的中数を出す日にレース数（races）を並べない', () => {
  assert.match(read(FILES[0]), /races: item\.hitCount > 0 \? undefined :/);
  assert.match(read(FILES[1]), /races: p\.summary\.hasResults && p\.summary\.hitRaces > 0 \? undefined :/);
});
