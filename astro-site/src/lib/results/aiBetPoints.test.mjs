// aiBetPoints.test.mjs — 実績の購入点数は AI レース別算定（MK 確定仕様 2026-10-06・本番反映は Preview 目視後）
// 正本 docs/BET_POINT_LOGIC.md「MK確定仕様: 実績の購入点数は AI レース別算定」
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  expandUmatanLine, extraCount, aiPointBasis, buildAiBet, raceAiResult, summarizeAiDay, summarizeAiDays,
  EXTRA_MIN, EXTRA_MAX, AI_POINTS_NOTE, AI_BET_VERSION,
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

test('通常レース: 購入点数 = 少ない買い目（6 組）＋通常買い目を参照した 2〜6 組', () => {
  const basis = aiPointBasis(field, normalLines, { cat: 'nankan' });
  const nar = expandUmatanLine(narrowUmatan(field, normalLines).line);
  const normal = normalLines.flatMap(expandUmatanLine);
  assert.equal(nar.length, 6);
  for (const c of nar) assert.ok(basis.includes(c), '少ない買い目は必ず含む');
  for (const c of basis) assert.ok(normal.includes(c), '通常買い目に無い組を作らない（第 3 の買い目を作らない）');
  const extra = basis.length - 6;
  assert.ok(extra >= EXTRA_MIN && extra <= EXTRA_MAX, `追加 ${extra} 組`);
});

test('AI が算定・保存するのは購入点数だけ（組の一覧を保存しない）', () => {
  const ai = buildAiBet(field, normalLines, { cat: 'nankan' });
  assert.deepEqual(Object.keys(ai).sort(), ['points', 'v']);
  assert.equal(ai.v, AI_BET_VERSION);
  assert.equal(ai.points, aiPointBasis(field, normalLines, { cat: 'nankan' }).length);
});

test('メインレース: 通常買い目（5 点）を超えない', () => {
  const ai = buildAiBet(field, mainLines, { cat: 'nankan' });
  assert.ok(ai.points <= 5 && ai.points >= 3);
  for (const c of aiPointBasis(field, mainLines, { cat: 'nankan' })) assert.ok(expandUmatanLine(mainLines[0]).includes(c));
});

test('追加組数はレース前のデータで変わる（毎レース同じ点数に固定しない）', () => {
  const strong = [H(1, '本命', 200, 92), H(2, '対抗', 150), ...field.slice(2)];
  const tight = [H(1, '本命', 152, 70), H(2, '対抗', 150), ...field.slice(2)];
  const a = extraCount(strong, { cat: 'nankan', horseCount: 10 });
  const b = extraCount(tight, { cat: 'nankan', horseCount: 16 });
  assert.ok(a < b, `堅い ${a} < 混戦 ${b}`);
  assert.ok(a >= EXTRA_MIN && b <= EXTRA_MAX);
});

test('通常買い目で的中なら実績も的中・払戻は通常買い目で記録された払戻をそのまま使う', () => {
  // 勝ち組がどの組でも（少ない買い目の外でも）、通常買い目で的中していれば払戻を 0 にしない
  const race = { isHit: true, umatan: { combination: '6-2', payout: 3000 }, aiBet: { v: 2, points: 8 } };
  const r = raceAiResult(race);
  assert.equal(r.hit, true, '通常買い目で的中していれば的中');
  assert.equal(r.payout, 3000, '記録された払戻をそのまま使う');
  assert.equal(r.points, 8);
  assert.equal('covered' in r, false, 'AI 内部の組に当たりが含まれるかを判定しない');
  // 旧 v1（組の一覧つき）のデータでも、組の一覧で払戻を絞らない
  const legacy = raceAiResult({ ...race, aiBet: { v: 1, points: 8, combos: ['1-2', '2-1'] } });
  assert.equal(legacy.payout, 3000);
  // 不的中は払戻 0
  assert.equal(raceAiResult({ ...race, isHit: false }).payout, 0);
});

test('回収率 = 通常買い目で記録された払戻 ÷（AI 算定購入点数 × 100 円）', () => {
  const day = { races: [
    { isHit: true, umatan: { combination: '6-2', payout: 3000 }, aiBet: { v: 2, points: 10 } },
    { isHit: false, umatan: { combination: '1-2', payout: 900 }, aiBet: { v: 2, points: 12 } },
    { isHit: true, umatan: { combination: '1-3', payout: 450 }, aiBet: { v: 2, points: 5 } },
  ] };
  const d = summarizeAiDay(day);
  assert.equal(d.points, 27);
  assert.equal(d.investment, 2700);
  assert.equal(d.payout, 3450);
  assert.equal(d.recoveryRate, Math.round((3450 / 2700) * 1000) / 10);
  const s = summarizeAiDays([day, day]);
  assert.equal(s.points, 54);
  assert.equal(s.payout, 6900);
  assert.equal(s.recoveryRate, d.recoveryRate);
});

test('算定の無いレースがある日は購入点数・回収率を出さない（推測で埋めない）', () => {
  const d = summarizeAiDay({ races: [{ isHit: true, umatan: { combination: '1-2', payout: 500 }, aiBet: { v: 2, points: 8 } }, { isHit: false }] });
  assert.equal(d.complete, false);
  assert.equal(d.points, null);
  assert.equal(d.recoveryRate, null);
  assert.equal(d.hitRaces, 1);
});

test('実データ: 全レース 5 点固定にならず、点数はレースごとに変わり、保存は点数だけ', () => {
  for (const f of ['src/data/archiveResults.json', 'src/data/archiveResultsJra.json']) {
    const arr = JSON.parse(read(f));
    const races = arr.flatMap((e) => e.races || []).filter((r) => r.aiBet);
    assert.ok(races.length > 500, `${f}: aiBet ${races.length}`);
    const pts = new Set(races.map((r) => r.aiBet.points));
    assert.ok(pts.size >= 4, `${f}: 点数の種類 ${[...pts]}`);
    assert.ok(races.filter((r) => r.aiBet.points === 5).length < races.length * 0.2, `${f}: 5 点に偏っている`);
    for (const r of races) {
      assert.deepEqual(Object.keys(r.aiBet).sort(), ['points', 'v'], `${f}: aiBet は点数だけ`);
      const normal = new Set((r.bettingLines || []).flatMap(expandUmatanLine));
      assert.ok(r.aiBet.points >= 1 && r.aiBet.points <= normal.size, `${f}: 点数が通常買い目の点数を超える`);
    }
    const s = summarizeAiDays(arr);
    assert.ok(s.points > 0 && s.recoveryRate != null);
    // 払戻は通常買い目で記録された払戻（算定のそろった日の的中レースの umatan.payout の合計）と一致する
    const full = arr.filter((e) => summarizeAiDay(e).complete);
    const recorded = full.flatMap((e) => e.races).reduce((t, r) => t + ((r.isHit ?? r.hit) ? Number(r.umatan?.payout ?? r.payout) || 0 : 0), 0);
    assert.equal(s.payout, recorded, `${f}: 払戻が通常買い目の記録と一致しない`);
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
/** 実績ページ以外で同じ実績値（昨日の回収率等）を出す箇所。予想本文（Light の既存買い目表示）は対象外 */
const SAME_VALUE_PAGES = [
  'src/lib/archive-utils.js',
  'src/pages/light-predictions.astro',
  'src/pages/light-predictions-jra.astro',
];

test('実績ページは単一源を使い、独自の回収率計算を持たない', () => {
  for (const p of RESULT_PAGES) {
    const s = read(p);
    assert.doesNotMatch(s, /totalPayout\s*\/\s*\(?\s*total(BetAmount|Investment)/, `${p}: 独自の回収率計算`);
    assert.doesNotMatch(s, /returnRate\s*\?\?\s*[a-zA-Z.]*recoveryRate|\.returnRate\s*\?\?/, `${p}: 旧 5 点固定の returnRate を読んでいる`);
  }
  for (const p of ['src/lib/resultsShowcase.js', 'src/pages/archive/jra/index.astro', 'src/pages/archive/jra/[year]/index.astro',
    'src/pages/archive/jra/[year]/[month]/index.astro', 'src/pages/archive/nankan/[year]/index.astro',
    'src/pages/archive/nankan/[year]/[month]/index.astro', 'src/pages/index.astro', ...SAME_VALUE_PAGES]) {
    assert.match(read(p), /results\/aiBetPoints\.js/, `${p}: 単一源を import していない`);
  }
});

test('第 3 の買い目に見せない: 算定した組を画面に出さず、「厳選」「AI選定買い目」等を使わない', () => {
  for (const p of RESULT_PAGES) {
    const s = read(p);
    assert.doesNotMatch(s, /aiBet\??\.combos/, `${p}: 算定した組を表示している`);
    assert.doesNotMatch(s, /厳選|AI選定|AI推奨|AI買い目/, `${p}: 第 3 の買い目に見える語`);
  }
  assert.doesNotMatch(AI_POINTS_NOTE, /厳選|買い目/);
  assert.equal(AI_POINTS_NOTE, '購入点数はAIによるレース別算定');
});

test('回収率 100% 未満を赤字で警告しない（他の実績値と同じ扱い）', () => {
  for (const p of [...RESULT_PAGES, ...SAME_VALUE_PAGES]) {
    assert.doesNotMatch(read(p), /(returnRate|recoveryRate|ReturnRate)[^\n]*'loss'/, `${p}: 100% 未満を loss（赤）にしている`);
  }
});

test('同じ日・同じデータなら、どの実績画面の算定も単一源と一致する', async () => {
  const { buildShowcaseDay } = await import('../resultsShowcase.js');
  for (const f of ['src/data/archiveResults.json', 'src/data/archiveResultsJra.json']) {
    for (const day of JSON.parse(read(f)).slice(0, 10)) {
      const sd = buildShowcaseDay(day);
      if (!sd) continue;
      const ai = summarizeAiDay(day);
      assert.equal(sd.recoveryRate, ai.recoveryRate, `${f} ${day.date}: ショーケースの回収率`);
      assert.equal(sd.totalBetPoints, ai.points, `${f} ${day.date}: ショーケースの購入点数`);
    }
  }
  // 「昨日の結果」（Light ページ等）も単一源から取る（JSON の旧 5 点固定 returnRate を読まない）
  const utils = read('src/lib/archive-utils.js');
  const yesterday = utils.slice(utils.indexOf('export function convertToYesterdayResults('), utils.indexOf('export function getLatestSanrenpukuDayData('));
  assert.equal((yesterday.match(/summarizeAiDay\(latestData\)/g) || []).length, 2, '南関・中央の両方で単一源を使う');
  assert.doesNotMatch(yesterday, /returnRate|bettingPoints|betPoints/, '旧方式の点数・回収率を読まない');
});

test('ショーケースのメインレースに「馬単 N点」を出さない（全レース 5 点の誤解を防ぐ）', () => {
  for (const p of ['src/pages/results-showcase/jra.astro', 'src/pages/results-showcase/nankan.astro']) {
    assert.doesNotMatch(read(p), /馬単 \{g\.mainRace\.betPoints\}点/);
  }
});

test('Premium の少ない買い目・通常買い目は実績算定に引きずられない・第 3 の買い目を足さない', () => {
  // 予想表示側は aiBetPoints を参照しない（実績専用）
  for (const p of ['src/lib/acquisition/predictionContent.js', 'src/utils/mainRaceBetting.js',
    'src/components/acquisition/AcquiredPredictionBody.astro']) {
    assert.doesNotMatch(read(p), /aiBetPoints|aiBet\b/, `${p}: Premium 側が実績算定を参照している`);
  }
  // 絞った買い目の仕様（本命軸×上位 3 頭・通常 ↔ = 6 点 / メイン → = 3 点）は不変
  assert.equal(narrowUmatan(field, normalLines).points, 6);
  assert.equal(narrowUmatan(field, mainLines).points, 3);
});
