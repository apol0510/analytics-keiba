/**
 * getDisplayRecentRacesForNankan.test.js (analytics-keiba)
 *
 * 南関 過去走 表示用配列の解決 helper のテスト（Node標準 assert）。
 * 優先順位（表示の正本）:
 *   1. recentRacesFromEntriesNankan（呼び出し側インライン・最優先）
 *   2. recentRacesFromHistoriesNankan（resolver ① 注入正規化）
 *   3. horseStatsNankan.recentRacesDetailed（resolver ② uma_info 正本・最大5走）
 *   4. recentRaces（legacy・racebook 由来・素通し）
 *
 * entries 判定は free/light/premium 各カードのインライン（RaceHorseSection.astro:77-79 /
 * HorseMainCard.astro:56-58 / free-prediction/nankan.astro:235 等）で行うため、
 * テストでも同じ選択ラッパ displaySelect() を通して全経路を再現する。
 *
 * 2026-06-24 URA 3R 5番 ダイメイバタフライ回帰: entries/histories 欠落日に horseStats(5走) が
 * racebook の不完全な4走へ落ちず、1/9(5走目)・5/28 raceName=３歳(六)・passingOrder=4-3-4-5 を保つ。
 *
 * 実行: node src/lib/getDisplayRecentRacesForNankan.test.js （astro-site 直下から）
 */
import assert from 'assert';
import { getDisplayRecentRacesForNankan } from './getDisplayRecentRacesForNankan.js';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.error(`  ❌ ${name}\n     ${e.message}`); } };

// free/light/premium 各カードの選択（entries優先 → resolver）を再現するラッパ。
function displaySelect(horse) {
  return (Array.isArray(horse?.recentRacesFromEntriesNankan) && horse.recentRacesFromEntriesNankan.length > 0)
    ? horse.recentRacesFromEntriesNankan
    : getDisplayRecentRacesForNankan(horse);
}

// ダイメイバタフライ相当の horseStatsNankan.recentRacesDetailed（新→古・order 1=前走）
const DAIMEI_DETAILED = [
  { order: 1, finish: 5, venue: '浦和', date: '2026-05-28', distance: 1400, raceName: '３歳(六)', headCount: 9, horseNumberInRace: 3, passingOrder: '4-3-4-5', last3f: '39.6', carriedWeight: '54.0' },
  { order: 2, finish: 3, venue: '浦和', date: '2026-04-22', distance: 1400, raceName: '３歳(五)', headCount: 11, horseNumberInRace: 9, passingOrder: '9-9-6-5', last3f: '39.5', carriedWeight: '54.0' },
  { order: 3, finish: 3, venue: '浦和', date: '2026-03-20', distance: 1400, raceName: '３歳(八)', headCount: 11, horseNumberInRace: 9, passingOrder: '11-10-4-3', last3f: '38.9' },
  { order: 4, finish: 3, venue: '浦和', date: '2026-02-28', distance: 1400, raceName: '３歳(七)', headCount: 9, horseNumberInRace: 9, passingOrder: '5-6-6-4', last3f: '40.4' },
  { order: 5, finish: 6, venue: '浦和', date: '2026-01-09', distance: 1300, raceName: '３歳(六)', headCount: 10, horseNumberInRace: 7, passingOrder: '8-10-7-7', last3f: '39.2', carriedWeight: '54.0' },
];
const mkRacebook = (n) => ({ date: `2026-0${n}-01`, venue: '浦和', rank: n, raceName: `${n}組`, passingOrder: '3-4-5' });

// ケース1: entries あり（horseStats/racebook もあり）→ entries 採用
t('ケース1: entries優先（horseStats/racebookより前）', () => {
  const ent = [{ date: '2026-06-20', venue: '浦和', rank: 1 }];
  const out = displaySelect({
    recentRacesFromEntriesNankan: ent,
    horseStatsNankan: { recentRacesDetailed: DAIMEI_DETAILED },
    recentRaces: [mkRacebook(2)],
  });
  assert.strictEqual(out, ent);
});

// ケース2: entries なし・histories あり（horseStats/racebookもあり）→ histories 採用
t('ケース2: histories優先（horseStats/racebookより前）', () => {
  const inj = [{ date: '2026-05-10', venue: '大井', finish: 2, distance: 1400 }];
  const out = displaySelect({
    recentRacesFromHistoriesNankan: inj,
    horseStatsNankan: { recentRacesDetailed: DAIMEI_DETAILED },
    recentRaces: [mkRacebook(2)],
  });
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].rank, 2); // finish→rank（histories 由来）
});

// ケース3: entries/histories なし・horseStats 5走・racebook 4走 → horseStats 採用（5走・値正）
t('ケース3: horseStats fallback（5走・1/9・raceName/passingOrder 正）', () => {
  const out = displaySelect({
    horseStatsNankan: { recentRacesDetailed: DAIMEI_DETAILED },
    recentRaces: [mkRacebook(2), mkRacebook(3), mkRacebook(4), mkRacebook(5)], // racebook 4走
  });
  assert.strictEqual(out.length, 5, '5走になっていない');
  // AK 契約は 古→新。最新(前走)=末尾、5走目(最古)=先頭。
  const newest = out[out.length - 1];
  assert.strictEqual(newest.date, '2026-05-28');
  assert.strictEqual(newest.raceName, '３歳(六)');
  assert.strictEqual(newest.passingOrder, '4-3-4-5');
  assert.strictEqual(newest.rank, 5);            // finish→rank
  assert.strictEqual(newest.horseNumber, 3);     // horseNumberInRace→horseNumber
  // 5走目（2026-01-09）が存在
  const jan9 = out.find((r) => r.date === '2026-01-09');
  assert.ok(jan9, '2026-01-09 が5走目に存在しない');
  assert.strictEqual(out[0].date, '2026-01-09'); // 古→新の先頭=最古
  assert.strictEqual(jan9.raceName, '３歳(六)');
  assert.strictEqual(jan9.passingOrder, '8-10-7-7');
  // racebook の不完全値（六組/3-4-5）に汚染されていない
  assert.ok(!out.some((r) => r.passingOrder === '3-4-5'), 'racebook の passingOrder が混入');
});

// ケース4: entries/histories/horseStats なし・racebook あり → racebook 採用（素通し）
t('ケース4: legacy fallback（racebook 素通し）', () => {
  const legacy = [mkRacebook(2), mkRacebook(3)];
  const out = displaySelect({ recentRaces: legacy });
  assert.strictEqual(out, legacy); // 同一参照（素通し）
});

// ケース5: horseStats 不完全（空/不正）→ 例外にせず racebook へ fallback
t('ケース5: horseStats 不完全 → racebook へ fallback', () => {
  const legacy = [mkRacebook(2)];
  assert.strictEqual(displaySelect({ horseStatsNankan: { recentRacesDetailed: [] }, recentRaces: legacy }), legacy);
  assert.strictEqual(displaySelect({ horseStatsNankan: { recentRacesDetailed: null }, recentRaces: legacy }), legacy);
  assert.strictEqual(displaySelect({ horseStatsNankan: {}, recentRaces: legacy }), legacy);
  assert.strictEqual(displaySelect({ horseStatsNankan: null, recentRaces: legacy }), legacy);
  // recentRacesDetailed が非object要素のみ → mapped 0件 → racebook
  assert.strictEqual(displaySelect({ horseStatsNankan: { recentRacesDetailed: [null, 1, 'x'] }, recentRaces: legacy }), legacy);
});

// 入力不変: horse / horseStatsNankan / recentRacesDetailed を破壊しない
t('入力(horse/horseStats/recentRacesDetailed)を破壊しない', () => {
  const detailed = JSON.parse(JSON.stringify(DAIMEI_DETAILED));
  const copy = JSON.parse(JSON.stringify(DAIMEI_DETAILED));
  getDisplayRecentRacesForNankan({ horseStatsNankan: { recentRacesDetailed: detailed } });
  assert.deepStrictEqual(detailed, copy);
});

// passingOrder が配列でも安全に文字列化（推測補完しない）
t('passingOrder 配列 → "4-3-4-5" 文字列化', () => {
  const out = getDisplayRecentRacesForNankan({
    horseStatsNankan: { recentRacesDetailed: [{ order: 1, finish: 5, date: '2026-05-28', passingOrder: [4, 3, 4, 5], raceName: '３歳(六)' }] },
  });
  assert.strictEqual(out[0].passingOrder, '4-3-4-5');
});

// order は順序であり着順ではない: rank=finish のみ・order は出力に残さない
t('order を着順(rank)に使わない・order を出力に残さない', () => {
  const out = getDisplayRecentRacesForNankan({
    horseStatsNankan: { recentRacesDetailed: [{ order: 1, finish: 7, date: '2026-05-28', raceName: '３歳(六)' }] },
  });
  assert.strictEqual(out[0].rank, 7, 'rank は finish(=7) であるべき（order=1 を使っていない）');
  assert.ok(!('order' in out[0]), 'order が出力に混入している');
});

// 非完走 finish=null の実在パターン（2026-06-18 KAW R01 アビエーション 2026-05-29 走）。
// finish=null の走が脱落して5走→4走に減る／rank=null や order由来の rank が生成される／
// null参照で例外になる、という将来の mapper 退行を防ぐ。
const ABIATION_DETAILED = [
  { order: 1, date: '2026-05-29', venue: '川崎', raceName: '３歳(八)', finish: null, finishStatus: null, passingOrder: '6-6-10' },
  { order: 2, date: '2026-05-12', venue: '川崎', raceName: '３歳(七)', finish: 9, passingOrder: '12-11-8-8' },
  { order: 3, date: '2026-04-22', venue: '川崎', raceName: '３歳(五)', finish: 8, passingOrder: '8-8-8-8' },
  { order: 4, date: '2026-03-20', venue: '川崎', raceName: '３歳(七)', finish: 7, passingOrder: '6-8-8-7' },
  { order: 5, date: '2026-02-28', venue: '川崎', raceName: '３歳(四)', finish: 3, passingOrder: '5-5-5-4' },
];
t('非完走 finish=null の走を5走内に保持・rank非生成・例外なし（古→新）', () => {
  let out;
  assert.doesNotThrow(() => { out = getDisplayRecentRacesForNankan({ horseStatsNankan: { recentRacesDetailed: ABIATION_DETAILED } }); }, '例外を出した');
  assert.strictEqual(out.length, 5, 'finish=null の走が脱落して5走を割っている');
  // AK 契約 古→新: order1(最新/非完走)=末尾, order5(最古)=先頭
  const nonFinisher = out[out.length - 1];
  assert.strictEqual(nonFinisher.date, '2026-05-29', '非完走走(2026-05-29)が末尾に存在しない');
  assert.ok(out.some((r) => r.date === '2026-05-29'), '非完走走が戻り値から脱落');
  assert.ok(!('rank' in nonFinisher), 'finish=null なのに rank キーが生成された');
  assert.ok(!('order' in nonFinisher), 'order が出力に混入（rank転用の温床）');
  assert.strictEqual(nonFinisher.raceName, '３歳(八)', 'raceName が保持されていない');
  assert.strictEqual(nonFinisher.passingOrder, '6-6-10', 'passingOrder が保持されていない');
  // 完走走は従来どおり rank=finish
  const finisher = out.find((r) => r.date === '2026-05-12');
  assert.strictEqual(finisher.rank, 9, '完走走の rank=finish が壊れている');
});

console.log(`\ngetDisplayRecentRacesForNankan (AK): ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
