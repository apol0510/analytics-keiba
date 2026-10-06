// aiBetPoints.test.mjs — 実績の AI レース別購入点数（MK 確認用 Preview・最終採否未定）
// 正本 docs/BET_POINT_LOGIC.md「検討中Preview仕様: AI レース別購入点数」
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expandUmatanLine, extraCount, buildAiBet, raceAiResult, summarizeAiDay, summarizeAiDays,
  EXTRA_MIN, EXTRA_MAX, AI_POINTS_NOTE,
} from './aiBetPoints.js';
import { narrowUmatan } from '../acquisition/predictionContent.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const H = (n, role, pt, ci = 80) => ({ horseNumber: n, role, pt, computerIndex: ci });
const field = [
  H(1, '本命', 180, 88), H(2, '対抗', 150), H(3, '単穴', 140), H(4, '連下最上位', 130),
  H(5, '連下', 120), H(6, '連下', 110), H(7, '補欠', 90), H(8, '無', 50), H(9, '無', 40), H(10, '無', 30),
];
const normalLines = ['1↔2.3.4.5.6', '2↔1.3.4.5.6'];
const mainLines = ['1→2.3.4.5.6(抑え7)'];

test('馬単 1 行の展開: → は一方向、↔ は双方向、抑えは含めない', () => {
  assert.deepEqual(expandUmatanLine('1→2.3(抑え7)'), ['1-2', '1-3']);
  assert.deepEqual(expandUmatanLine('1↔2.3'), ['1-2', '2-1', '1-3', '3-1']);
  assert.deepEqual(expandUmatanLine(''), []);
});

test('通常レース: 点数を絞った買い目（6 組）＋通常買い目から 2〜6 組', () => {
  const ai = buildAiBet(field, normalLines, { cat: 'nankan' });
  const nar = expandUmatanLine(narrowUmatan(field, normalLines).line);
  const normal = normalLines.flatMap(expandUmatanLine);
  assert.equal(nar.length, 6);
  for (const c of nar) assert.ok(ai.combos.includes(c), '絞った買い目は必ず含む');
  for (const c of ai.combos) assert.ok(normal.includes(c), '通常買い目に無い組を作らない（第 3 の買い目を作らない）');
  const extra = ai.points - 6;
  assert.ok(extra >= EXTRA_MIN && extra <= EXTRA_MAX, `追加 ${extra} 組`);
});

test('メインレース: 通常買い目（5 点）を超えない', () => {
  const ai = buildAiBet(field, mainLines, { cat: 'nankan' });
  assert.ok(ai.points <= 5 && ai.points >= 3);
  for (const c of ai.combos) assert.ok(expandUmatanLine(mainLines[0]).includes(c));
});

test('追加組数はレース前のデータで変わる（毎レース同じ点数に固定しない）', () => {
  const strong = [H(1, '本命', 200, 92), H(2, '対抗', 150), ...field.slice(2)];
  const tight = [H(1, '本命', 152, 70), H(2, '対抗', 150), ...field.slice(2)];
  const a = extraCount(strong, { cat: 'nankan', horseCount: 10 });
  const b = extraCount(tight, { cat: 'nankan', horseCount: 16 });
  assert.ok(a < b, `堅い ${a} < 混戦 ${b}`);
  assert.ok(a >= EXTRA_MIN && b <= EXTRA_MAX);
});

test('的中は通常買い目で判定。算定外の組で当たった払戻は回収率に数えない', () => {
  const race = { isHit: true, umatan: { combination: '6-2', payout: 3000 }, aiBet: { v: 1, points: 8, combos: ['1-2', '2-1'] } };
  const r = raceAiResult(race);
  assert.equal(r.hit, true, '通常買い目で的中していれば的中');
  assert.equal(r.covered, false);
  assert.equal(r.payout, 0);
  const r2 = raceAiResult({ ...race, umatan: { combination: '2-1', payout: 3000 } });
  assert.equal(r2.payout, 3000);
});

test('算定の無いレースがある日は購入点数・回収率を出さない（推測で埋めない）', () => {
  const d = summarizeAiDay({ races: [{ isHit: true, umatan: { combination: '1-2', payout: 500 }, aiBet: { points: 8, combos: ['1-2'] } }, { isHit: false }] });
  assert.equal(d.complete, false);
  assert.equal(d.points, null);
  assert.equal(d.recoveryRate, null);
  assert.equal(d.hitRaces, 1);
});

test('実データ: 全レース 5 点固定にならず、点数はレースごとに変わり、組は必ず通常買い目の中', () => {
  for (const f of ['src/data/archiveResults.json', 'src/data/archiveResultsJra.json']) {
    const arr = JSON.parse(read(f));
    const races = arr.flatMap((e) => e.races || []).filter((r) => r.aiBet);
    assert.ok(races.length > 500, `${f}: aiBet ${races.length}`);
    const pts = new Set(races.map((r) => r.aiBet.points));
    assert.ok(pts.size >= 4, `${f}: 点数の種類 ${[...pts]}`);
    for (const r of races) {
      const normal = new Set((r.bettingLines || []).flatMap(expandUmatanLine));
      for (const c of r.aiBet.combos) assert.ok(normal.has(c), `${f}: ${c} は通常買い目に無い`);
      assert.equal(r.aiBet.points, r.aiBet.combos.length);
    }
    const s = summarizeAiDays(arr);
    assert.ok(s.points > 0 && s.recoveryRate != null);
  }
});

const RESULT_PAGES = [
  'src/pages/results-showcase/jra.astro',
  'src/pages/results-showcase/nankan.astro',
  'src/pages/archive/jra/index.astro',
  'src/pages/archive/jra/[year]/index.astro',
  'src/pages/archive/jra/[year]/[month]/index.astro',
  'src/pages/archive/nankan/[year]/index.astro',
  'src/pages/archive/nankan/[year]/[month]/index.astro',
  'src/pages/index.astro',
  'src/components/HomeResultsShowcasePreview.astro',
  'src/components/ResultsShowcaseBanner.astro',
  'src/lib/resultsShowcase.js',
];

test('実績ページは単一源を使い、独自の回収率計算を持たない', () => {
  for (const p of RESULT_PAGES) {
    const s = read(p);
    assert.doesNotMatch(s, /totalPayout\s*\/\s*\(?\s*total(BetAmount|Investment)/, `${p}: 独自の回収率計算`);
    assert.doesNotMatch(s, /returnRate\s*\?\?\s*[a-zA-Z.]*recoveryRate|\.returnRate\s*\?\?/, `${p}: 旧 5 点固定の returnRate を読んでいる`);
  }
  for (const p of ['src/lib/resultsShowcase.js', 'src/pages/archive/jra/index.astro', 'src/pages/archive/jra/[year]/index.astro',
    'src/pages/archive/jra/[year]/[month]/index.astro', 'src/pages/archive/nankan/[year]/index.astro',
    'src/pages/archive/nankan/[year]/[month]/index.astro', 'src/pages/index.astro']) {
    assert.match(read(p), /results\/aiBetPoints\.js/, `${p}: 単一源を import していない`);
  }
});

test('第 3 の買い目に見せない: 算定した組を画面に出さず、「厳選」「AI選定買い目」等を使わない', () => {
  for (const p of RESULT_PAGES) {
    const s = read(p);
    assert.doesNotMatch(s, /aiBet\??\.combos/, `${p}: 算定した組を表示している`);
    assert.doesNotMatch(s, /厳選|AI選定|AI推奨\d*点|AI買い目/, `${p}: 第 3 の買い目に見える語`);
  }
  assert.doesNotMatch(AI_POINTS_NOTE, /厳選|買い目/);
});

test('ショーケースのメインレースに「馬単 N点」を出さない（全レース 5 点の誤解を防ぐ）', () => {
  for (const p of ['src/pages/results-showcase/jra.astro', 'src/pages/results-showcase/nankan.astro']) {
    assert.doesNotMatch(read(p), /馬単 \{g\.mainRace\.betPoints\}点/);
  }
});

test('Premium の買い目（通常・点数を絞った買い目）は実績算定に引きずられない', () => {
  // 予想表示側は aiBetPoints を参照しない（実績専用）
  for (const p of ['src/lib/acquisition/predictionContent.js', 'src/utils/mainRaceBetting.js',
    'src/components/acquisition/AcquiredPredictionBody.astro']) {
    assert.doesNotMatch(read(p), /aiBetPoints/, `${p}: Premium 側が実績算定を参照している`);
  }
  // 絞った買い目の仕様（本命軸×上位 3 頭・通常 ↔ = 6 点 / メイン → = 3 点）は不変
  assert.equal(narrowUmatan(field, normalLines).points, 6);
  assert.equal(narrowUmatan(field, mainLines).points, 3);
});
