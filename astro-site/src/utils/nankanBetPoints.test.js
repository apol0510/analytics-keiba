/**
 * nankanBetPoints.test.js (analytics-keiba)
 *
 * 案1「ユニーク実購入買い目数」算出関数の単体・回帰テスト（Node標準 assert）。
 * 実行: node src/utils/nankanBetPoints.test.js （astro-site 直下から）
 *
 * 馬単の CANONICAL 期待値は AK / KI 両 repo のテストで**同一値**を用いる（parity 保証）。
 */
import assert from 'assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseUmatanLine,
  countUmatanUniquePoints,
  normalizeTriple,
  countSanrenpukuUniquePoints,
  parseSanrenpukuLine,
  countSanrenpukuUniqueFromStrings,
  BetPointsParseError,
} from './nankanBetPoints.js';
import { buildRaceSanrenpuku } from './sanrenpukuBetting.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.error(`  ❌ ${name}\n     ${e && e.message}`); } };

// ── 馬単 CANONICAL（AK/KI 共通の parity 期待値）─────────────────
// 各要素: { lines, expected }
const UMATAN_CANONICAL = [
  { name: '軸↔相手3頭 → 6組', lines: ['3↔5.7.8'], expected: 6 },
  { name: 'ダッシュ区切りも同結果（separator不変/parity）', lines: ['3-5.7.8'], expected: 6 },
  { name: '抑えを相手に含める', lines: ['3↔5.7(抑え9)'], expected: 6 },
  { name: '本命↔対抗の重複を軸間dedup', lines: ['3↔5.7', '5↔3.7'], expected: 6 },
  { name: '同一行の重複をdedup', lines: ['3↔5.7', '3↔5.7'], expected: 4 },
  { name: '空配列は0点', lines: [], expected: 0 },
];

t('馬単 CANONICAL 期待値一致（parity 基準）', () => {
  for (const c of UMATAN_CANONICAL) {
    assert.strictEqual(countUmatanUniquePoints(c.lines), c.expected, `${c.name}: ${JSON.stringify(c.lines)}`);
  }
});

t('parseUmatanLine: 軸除外・本線+抑え結合・dedup', () => {
  const { axis, partners } = parseUmatanLine('3↔5.7.3(抑え9.5)'); // 3=軸(除外), 5重複, 9抑え
  assert.strictEqual(axis, 3);
  assert.deepStrictEqual([...partners].sort((a, b) => a - b), [5, 7, 9]);
});

t('抑え・補欠が組数に反映される（含める前後で差）', () => {
  const withOsae = countUmatanUniquePoints(['3↔5.7(抑え9.11)']);
  const without = countUmatanUniquePoints(['3↔5.7']);
  assert.strictEqual(without, 4);
  assert.strictEqual(withOsae, 8); // 相手 5,7,9,11 × 双方向
});

t('払戻額を入力に取らない（関数arityは1・払戻非依存）', () => {
  assert.strictEqual(countUmatanUniquePoints.length, 1);
  const lines = ['3↔5.7.8(抑え9)'];
  // 「異なる払戻の日」でも同一 lines なら同一点数（payout は一切参照しない）
  const a = countUmatanUniquePoints(lines);
  const b = countUmatanUniquePoints(lines);
  assert.strictEqual(a, b);
  assert.strictEqual(a, 8);
});

t('malformed 馬単行は BetPointsParseError を throw（黙って推測しない）', () => {
  assert.throws(() => countUmatanUniquePoints(['abc']), BetPointsParseError);
  assert.throws(() => countUmatanUniquePoints(['3']), BetPointsParseError);       // 区切りなし
  assert.throws(() => countUmatanUniquePoints(['3↔5.x']), BetPointsParseError);   // 相手が数値でない
  assert.throws(() => countUmatanUniquePoints('3↔5'), BetPointsParseError);       // 配列でない
});

// ── 三連複（AK 専用）─────────────────────────────────────────
t('normalizeTriple: 馬番順序違いを同一組として正規化', () => {
  assert.strictEqual(normalizeTriple([3, 1, 2]), '1-2-3');
  assert.strictEqual(normalizeTriple([2, 3, 1]), '1-2-3');
  assert.strictEqual(normalizeTriple([10, 2, 7]), '2-7-10');
});

t('normalizeTriple: 不正入力は throw', () => {
  assert.throws(() => normalizeTriple([1, 1, 2]), BetPointsParseError);   // 重複頭
  assert.throws(() => normalizeTriple([1, 2]), BetPointsParseError);      // 3頭でない
  assert.throws(() => normalizeTriple([1, 2, 0]), BetPointsParseError);   // 0/不正番号
});

t('countSanrenpukuUniquePoints: 軸間重複と順序違いを dedup', () => {
  const n = countSanrenpukuUniquePoints([
    [[1, 2, 3], [1, 2, 4]], // 本命軸
    [[3, 2, 1]],            // 対抗軸（=1-2-3, 順序違いの重複）
  ]);
  assert.strictEqual(n, 2); // {1-2-3, 1-2-4}
});

t('parseSanrenpukuLine: 表示文字列 → triple 復元', () => {
  const triples = parseSanrenpukuLine('1 - 2.3 - 2.3.4');
  const keys = triples.map(normalizeTriple).sort();
  assert.deepStrictEqual(keys, ['1-2-3', '1-2-4', '1-3-4']);
});

t('countSanrenpukuUniqueFromStrings: 本命軸+対抗軸を dedup', () => {
  const n = countSanrenpukuUniqueFromStrings(['1 - 2.3 - 2.3.4', '2 - 1.3 - 1.3.4']);
  assert.strictEqual(n, 4); // {1-2-3,1-2-4,1-3-4,2-3-4}
  // 空文字/null は無視
  assert.strictEqual(countSanrenpukuUniqueFromStrings(['1 - 2.3 - 2.3.4', null, '']), 3);
});

t('malformed 三連複行は throw', () => {
  assert.throws(() => parseSanrenpukuLine('1 - 2.3'), BetPointsParseError);      // 3ブロックでない
  assert.throws(() => parseSanrenpukuLine('x - 2.3 - 2.3.4'), BetPointsParseError); // 軸不正
});

// ── 実データ fixture 回帰（tracked prediction を使用）──────────
const readPred = (slug) => JSON.parse(readFileSync(join(process.cwd(), 'src/data/predictions', `${slug}.json`), 'utf-8'));
const umatanDayTotal = (j) => (j.predictions || j.races).reduce((s, r) => s + countUmatanUniquePoints(r.bettingLines?.umatan || []), 0);

t('fixture 2026-06-30 OOI: 馬単日計ユニーク=330 / R1=30', () => {
  const j = readPred('2026-06-30-ooi');
  assert.strictEqual(umatanDayTotal(j), 330);
  assert.strictEqual(countUmatanUniquePoints((j.predictions || j.races)[0].bettingLines.umatan), 30);
});

t('fixture 2026-06-26 URA: 馬単日計ユニーク=320 / R1=30', () => {
  const j = readPred('2026-06-26-urawa');
  assert.strictEqual(umatanDayTotal(j), 320);
  assert.strictEqual(countUmatanUniquePoints((j.predictions || j.races)[0].bettingLines.umatan), 30);
});

t('fixture 三連複 2026-06-30 OOI R1: 両軸 dedup ユニーク=29', () => {
  const j = readPred('2026-06-30-ooi');
  const r1 = (j.predictions || j.races)[0];
  const b = buildRaceSanrenpuku(r1.horses);
  const n = countSanrenpukuUniquePoints([b.normalHonmeiAxis?.lines || [], b.normalTaikouAxis?.lines || []]);
  assert.strictEqual(n, 29);
});

console.log(`\nnankanBetPoints.test.js: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
