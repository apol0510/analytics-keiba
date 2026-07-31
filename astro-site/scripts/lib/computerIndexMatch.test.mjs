/**
 * computerIndexMatch.test.mjs — race-scoped 馬番主キー突合の単体テスト。
 * 実行: node scripts/lib/computerIndexMatch.test.mjs
 * AK のテスト規約（node + assert、CI は check:safety 集約）に従う。
 */
import assert from 'node:assert';
import { buildRaceScopedComputerMap, injectSourceComputerIndexRaceScoped, normalizeHorseName, parseRaceNumber, toHorseNumber, assertInjectionSafe, classifyInjectionProblems } from './computerIndexMatch.mjs';
import { isHorseNameBroken } from '../../src/utils/normalizePrediction.js';
import { isIneligibleHorse } from '../../src/utils/osaeClassification.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}

// racebook 本体（注入先）を組み立てるヘルパ
function rbVenue(venue, races) {
  return { venue, races: races.map(r => ({ raceInfo: { raceNumber: `${r.rn}R` }, horses: r.horses })) };
}
function inject(computerVenues, sharedJSON) {
  const map = buildRaceScopedComputerMap(computerVenues);
  const stats = injectSourceComputerIndexRaceScoped(sharedJSON, map, { isNameBroken: isHorseNameBroken });
  return stats;
}
const PUA = '';

console.log('━━━ computerIndexMatch 単体テスト ━━━');

// 1. (外) 接頭辞差
t('1. (外)接頭辞差: 馬番一致で sci=60 注入 / 不要馬にならない', () => {
  const computer = [{ venue: '阪神', races: [{ raceNumber: 11, horses: [{ number: 8, name: '(外)ポールセン', computerIndex: 60 }] }] }];
  const shared = { venues: [rbVenue('阪神', [{ rn: 11, horses: [{ number: 8, name: 'ポールセン', role: '補欠' }] }])] };
  const stats = inject(computer, shared);
  const h = shared.venues[0].races[0].horses[0];
  assert.strictEqual(h.sourceComputerIndex, 60);
  assert.strictEqual(stats.injected, 1);
  assert.strictEqual(isIneligibleHorse(h), false, 'sci=60 の補欠は不要馬であってはならない');
});

// 2. (地) 接頭辞差
t('2. (地)接頭辞差: 馬番一致で sci 注入', () => {
  const computer = [{ venue: '東京', races: [{ raceNumber: 5, horses: [{ number: 3, name: '(地)ニシノアイオーン', computerIndex: 50 }] }] }];
  const shared = { venues: [rbVenue('東京', [{ rn: 5, horses: [{ number: 3, name: 'ニシノアイオーン', role: '補欠' }] }])] };
  inject(computer, shared);
  assert.strictEqual(shared.venues[0].races[0].horses[0].sourceComputerIndex, 50);
});

// 3. PUA/空名: 馬番一致で sci 注入 + 名前復元
t('3. PUA/空名: sci 注入 + computer 名で復元', () => {
  const computer = [{ venue: '阪神', races: [{ raceNumber: 11, horses: [{ number: 11, name: '(外)ノーブルロジャー', computerIndex: 57 }] }] }];
  const shared = { venues: [rbVenue('阪神', [{ rn: 11, horses: [{ number: 11, name: PUA, role: '連下最上位' }] }])] };
  const stats = inject(computer, shared);
  const h = shared.venues[0].races[0].horses[0];
  assert.strictEqual(h.sourceComputerIndex, 57);
  assert.strictEqual(h.name, '(外)ノーブルロジャー', '破損名は computer 名で復元される');
  assert.strictEqual(stats.nameRecovered, 1);
  assert.strictEqual(isHorseNameBroken(h.name), false);
});

// 4. 同名別レース: 混線しない（race-scoped）
t('4. 同名別レース: R1#3 と R2#3 が混線しない', () => {
  const computer = [{ venue: '函館', races: [
    { raceNumber: 1, horses: [{ number: 3, name: 'カブト', computerIndex: 70 }] },
    { raceNumber: 2, horses: [{ number: 3, name: 'カブト', computerIndex: 40 }] },
  ] }];
  const shared = { venues: [rbVenue('函館', [
    { rn: 1, horses: [{ number: 3, name: 'カブト', role: '補欠' }] },
    { rn: 2, horses: [{ number: 3, name: 'カブト', role: '補欠' }] },
  ])] };
  inject(computer, shared);
  assert.strictEqual(shared.venues[0].races[0].horses[0].sourceComputerIndex, 70);
  assert.strictEqual(shared.venues[0].races[1].horses[0].sourceComputerIndex, 40);
});

// 5. 馬番重複: ambiguous として注入しない
t('5. computer 同一レース馬番重複: ambiguous で注入スキップ', () => {
  const computer = [{ venue: '東京', races: [{ raceNumber: 9, horses: [
    { number: 4, name: 'A', computerIndex: 60 },
    { number: 4, name: 'B', computerIndex: 50 },
  ] }] }];
  const shared = { venues: [rbVenue('東京', [{ rn: 9, horses: [{ number: 4, name: 'A', role: '補欠' }] }])] };
  const stats = inject(computer, shared);
  assert.strictEqual(shared.venues[0].races[0].horses[0].sourceComputerIndex, undefined);
  assert.ok(stats.ambiguous >= 1);
});

// 6. 馬番一致・名前乖離: 注入しつつ nameMismatch を記録（誤注入でなく馬番が正本）
t('6. 馬番一致・名前乖離: 注入 + nameMismatch 記録', () => {
  const computer = [{ venue: '阪神', races: [{ raceNumber: 1, horses: [
    { number: 8, name: 'アルファ', computerIndex: 60 },
    { number: 9, name: 'ベータ', computerIndex: 50 },
  ] }] }];
  // racebook #8 の名前が computer #8 と乖離（誤って #9 の名前）。馬番主キーなので #8(60) を採用。
  const shared = { venues: [rbVenue('阪神', [{ rn: 1, horses: [{ number: 8, name: 'ベータ', role: '補欠' }] }])] };
  const stats = inject(computer, shared);
  assert.strictEqual(shared.venues[0].races[0].horses[0].sourceComputerIndex, 60, '馬番が正本（名前で #9 に誤注入しない）');
  assert.strictEqual(stats.nameMismatch, 1);
});

// 7. index 異常: null/NaN/0-9 は真指数として注入しない
t('7. index異常: null/NaN/0-9 を sci に注入しない', () => {
  const computer = [{ venue: '函館', races: [{ raceNumber: 3, horses: [
    { number: 1, name: 'ヌル', computerIndex: null },
    { number: 2, name: 'ナン', computerIndex: 'x' },
    { number: 3, name: 'ジャンク', computerIndex: 5 },
    { number: 4, name: 'セイ', computerIndex: 48 },
  ] }] }];
  const shared = { venues: [rbVenue('函館', [{ rn: 3, horses: [
    { number: 1, name: 'ヌル', role: '補欠' }, { number: 2, name: 'ナン', role: '補欠' },
    { number: 3, name: 'ジャンク', role: '補欠' }, { number: 4, name: 'セイ', role: '補欠' },
  ] }])] };
  inject(computer, shared);
  const hs = shared.venues[0].races[0].horses;
  assert.strictEqual(hs[0].sourceComputerIndex, undefined);
  assert.strictEqual(hs[1].sourceComputerIndex, undefined);
  assert.strictEqual(hs[2].sourceComputerIndex, undefined, '0-9 は真指数扱いしない');
  assert.strictEqual(hs[3].sourceComputerIndex, 48);
});

// 8. 不変条件: 真コンピ指数>=45 → 不要馬にならない（補欠でも sci で救済）
t('8. 不変条件: 真ci>=45 の補欠は不要馬でない / 真ci<=44 は不要馬', () => {
  const computer = [{ venue: '阪神', races: [{ raceNumber: 7, horses: [
    { number: 10, name: '(地)ヤマカツレオン', computerIndex: 46 },
    { number: 5, name: 'ロースコア', computerIndex: 30 },
  ] }] }];
  const shared = { venues: [rbVenue('阪神', [{ rn: 7, horses: [
    { number: 10, name: 'ヤマカツレオン', role: '補欠' },
    { number: 5, name: 'ロースコア', role: '補欠' },
  ] }])] };
  inject(computer, shared);
  const [h10, h5] = shared.venues[0].races[0].horses;
  assert.strictEqual(h10.sourceComputerIndex, 46);
  assert.strictEqual(isIneligibleHorse(h10), false, '真ci46 の補欠は不要馬でない');
  // h5: sci=30 注入されるが <45 → 補欠かつ getOsaeCi<45 → 不要馬（仕様通り）
  assert.strictEqual(isIneligibleHorse(h5), true, '真ci30(<=44) の補欠は不要馬');
});

// 補助: normalizeHorseName / parseRaceNumber
t('9. normalizeHorseName / parseRaceNumber', () => {
  assert.strictEqual(normalizeHorseName('(外)ポールセン'), 'ポールセン');
  assert.strictEqual(normalizeHorseName('（地）馬名'), '馬名');
  assert.strictEqual(normalizeHorseName('普通'), '普通');
  assert.strictEqual(parseRaceNumber('11R'), 11);
  assert.strictEqual(parseRaceNumber(11), 11);
  assert.strictEqual(parseRaceNumber('x'), null);
});

// 10. 馬番厳格化: 0/負数/小数/NaN/文字混じり を馬番として受理しない
t('10. toHorseNumber: 正の整数のみ受理', () => {
  assert.strictEqual(toHorseNumber(8), 8);
  assert.strictEqual(toHorseNumber('8'), 8);
  assert.strictEqual(toHorseNumber(0), null);
  assert.strictEqual(toHorseNumber(-3), null);
  assert.strictEqual(toHorseNumber(2.5), null);
  assert.strictEqual(toHorseNumber(NaN), null);
  assert.strictEqual(toHorseNumber('8a'), null);
  assert.strictEqual(toHorseNumber(null), null);
});

// 11. 不正馬番は突合に使わない（0/小数の馬は byNumber に入らない→名前fallbackも無ければ unmatched）
t('11. 不正馬番(0)は byNumber キーにならず誤注入しない', () => {
  const computer = [{ venue: '阪神', races: [{ raceNumber: 1, horses: [{ number: 0, name: 'ゼロ', computerIndex: 60 }] }] }];
  const map = buildRaceScopedComputerMap(computer);
  assert.strictEqual(map.get('阪神').get(1).byNumber.size, 0, '馬番0は byNumber に登録されない');
});

// 12. assertInjectionSafe: uncoveredHighCi があれば throw
t('12. assertInjectionSafe: 真ci>=45 未対応で throw', () => {
  const computer = [{ venue: '東京', races: [{ raceNumber: 9, horses: [{ number: 4, name: 'ハイ', computerIndex: 60 }] }] }];
  const map = buildRaceScopedComputerMap(computer);
  const shared = { venues: [rbVenue('東京', [{ rn: 9, horses: [{ number: 7, name: '別馬', role: '補欠' }] }])] }; // #4 が racebook に無い
  const stats = injectSourceComputerIndexRaceScoped(shared, map, { isNameBroken: isHorseNameBroken });
  assert.strictEqual(stats.uncoveredHighCi.length, 1);
  assert.throws(() => assertInjectionSafe(stats), /未対応/);
});

// 13. assertInjectionSafe: ambiguous(馬番重複) で throw
t('13. assertInjectionSafe: computer 馬番重複で throw', () => {
  const computer = [{ venue: '函館', races: [{ raceNumber: 2, horses: [
    { number: 3, name: 'A', computerIndex: 60 }, { number: 3, name: 'B', computerIndex: 55 },
  ] }] }];
  const map = buildRaceScopedComputerMap(computer);
  const shared = { venues: [rbVenue('函館', [{ rn: 2, horses: [{ number: 3, name: 'A', role: '補欠' }] }])] };
  const stats = injectSourceComputerIndexRaceScoped(shared, map, { isNameBroken: isHorseNameBroken });
  assert.ok(stats.ambiguous >= 1);
  assert.throws(() => assertInjectionSafe(stats), /馬番重複/);
});

// 14. assertInjectionSafe: 健全な stats では throw しない
t('14. assertInjectionSafe: 健全なら通過', () => {
  const computer = [{ venue: '阪神', races: [{ raceNumber: 11, horses: [{ number: 8, name: '(外)ポールセン', computerIndex: 60 }] }] }];
  const map = buildRaceScopedComputerMap(computer);
  const shared = { venues: [rbVenue('阪神', [{ rn: 11, horses: [{ number: 8, name: 'ポールセン', role: '補欠' }] }])] };
  const stats = injectSourceComputerIndexRaceScoped(shared, map, { isNameBroken: isHorseNameBroken });
  assert.doesNotThrow(() => assertInjectionSafe(stats));
});

// 15. classifyInjectionProblems: 健全 / stale 疑い / 実欠陥 の 3 分類
t('15. classifyInjectionProblems: 健全は ok・retry 対象外', () => {
  const v = classifyInjectionProblems({ ambiguous: 0, uncoveredHighCi: [] });
  assert.deepStrictEqual(v, { ok: true, staleSuspect: false, uncovered: 0, ambiguous: 0 });
});

t('16. classifyInjectionProblems: uncoveredHighCi のみは staleSuspect', () => {
  const v = classifyInjectionProblems({ ambiguous: 0, uncoveredHighCi: [{ ci: 60 }, { ci: 50 }] });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.staleSuspect, true, 'racebook 側の可視性遅れは再取得で解消しうる');
  assert.strictEqual(v.uncovered, 2);
});

t('17. classifyInjectionProblems: ambiguous を含むと staleSuspect にしない（即FAIL対象）', () => {
  const onlyDup = classifyInjectionProblems({ ambiguous: 1, uncoveredHighCi: [] });
  assert.strictEqual(onlyDup.ok, false);
  assert.strictEqual(onlyDup.staleSuspect, false);
  const both = classifyInjectionProblems({ ambiguous: 1, uncoveredHighCi: [{ ci: 60 }] });
  assert.strictEqual(both.staleSuspect, false, '馬番重複を伴う場合は再取得で救済しない');
});

console.log(`\n結果: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
