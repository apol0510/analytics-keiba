// resultsShowcasePreview.test.mjs
// トップページ上部プレビュー（有料実績ショーケースの誘導カード）の回帰テスト。
//
// 守るべき確定仕様（astro-site/docs/RESULTS_SHOWCASE.md）:
//   - 単一源 buildLatestShowcase() の結果から選ぶだけで、独自集計をしない
//   - 買い目はメインレースのみ・抑えは非公開
//   - 旧 ↔ archive の裏目的中は buildMainRace の畳み込み（⇄ + 勝った1組）に従う
//   - データが無い / 代表メインが無いカテゴリは null（＝カードごと非表示）
//   - 全レース一覧は ✅/✗ のみ（非メインの買い目・払戻を持たせない）
//   - 全体実績 → 全レース一覧 → メイン買い目詳細 の順で描画する（メイン不的中の日に
//     全体実績まで悪く見えないようにするための構成。マークアップ順を guard で固定）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import {
  buildShowcasePreview,
  formatShowcaseDate,
  SHOWCASE_CATEGORIES,
} from './resultsShowcasePreview.js';
import { buildLatestShowcase } from './resultsShowcase.js';

/** 12R 開催（メイン = 11R）の1日分アーカイブを作る */
function makeDay({
  date = '2026-08-16',
  venue = '中京',
  mainLine = '7→2.4.11.13.15(抑え5.9)',
  mainHit = false,
  mainCombination = '5-15',
  mainPayout = 57520,
  hitRaces = 3,
  recoveryRate = 256.1,
} = {}) {
  const races = Array.from({ length: 12 }, (_, i) => ({
    raceNumber: i + 1,
    venue,
    isHit: i < hitRaces,
    bettingLines: ['1↔2.3.4.5.6'],
    betPoints: 5,
  }));
  races[10] = {
    raceNumber: 11,
    venue,
    raceName: '3歳以上1勝クラス',
    bettingLines: [mainLine],
    isHit: mainHit,
    umatan: { combination: mainCombination, payout: mainPayout },
    betPoints: 5,
  };
  return {
    date,
    venues: [venue],
    totalRaces: 12,
    hitRaces: races.filter((r) => r.isHit).length,
    recoveryRate,
    races,
  };
}

test('カテゴリ定数は jra / nankan の2つ', () => {
  assert.deepEqual(SHOWCASE_CATEGORIES, ['jra', 'nankan']);
});

test('formatShowcaseDate は M月D日（不正値はそのまま）', () => {
  assert.equal(formatShowcaseDate('2026-08-16'), '8月16日');
  assert.equal(formatShowcaseDate('2026-12-01'), '12月1日');
  assert.equal(formatShowcaseDate(''), '');
  assert.equal(formatShowcaseDate('bogus'), 'bogus');
});

test('最新日（index 0）だけを読む', () => {
  const latest = makeDay({ date: '2026-08-16' });
  const older = makeDay({ date: '2026-08-10', venue: '新潟' });
  const p = buildShowcasePreview([latest, older], 'jra');
  assert.equal(p.date, '2026-08-16');
  assert.equal(p.venueLabel, '中京');
});

test('代表メインの買い目は抑えを伏せた本命→相手5頭', () => {
  const p = buildShowcasePreview([makeDay()], 'jra');
  assert.equal(p.mainRace.raceNumber, 11);
  assert.equal(p.mainRace.honmei, '7');
  assert.deepEqual(p.mainRace.displayPartners, ['2', '4', '11', '13', '15']);
  assert.equal(p.mainRace.displayArrow, '→');
  // 抑え（5.9）はどこにも出さない
  assert.equal(JSON.stringify(p.mainRace).includes('抑え'), false);
  assert.equal(p.mainRace.displayPartners.includes('5'), false);
  assert.equal(p.mainRace.displayPartners.includes('9'), false);
});

test('的中時は組み合わせと払戻を持つ', () => {
  const p = buildShowcasePreview(
    [makeDay({ mainHit: true, mainCombination: '7-13', mainPayout: 4210 })],
    'jra'
  );
  assert.equal(p.mainRace.isHit, true);
  assert.equal(p.mainRace.combination, '7-13');
  assert.equal(p.mainRace.payout, 4210);
});

test('旧 ↔ archive の裏目的中は単一源の畳み込み（⇄ + 勝った1組）に従う', () => {
  const p = buildShowcasePreview(
    [
      makeDay({
        mainLine: '1↔2.3.6.8.9(抑え4.5)',
        mainHit: true,
        mainCombination: '2-1',
        mainPayout: 3300,
      }),
    ],
    'jra'
  );
  assert.equal(p.mainRace.displayArrow, '⇄');
  assert.deepEqual(p.mainRace.displayPartners, ['2']);
});

test('集計は単一源の値をそのまま使う（独自計算しない）', () => {
  const day = makeDay({ hitRaces: 4, recoveryRate: 118.2 });
  const p = buildShowcasePreview([day], 'jra');
  const view = buildLatestShowcase([day]);
  assert.equal(p.hitRaces, view.hitRaces);
  assert.equal(p.totalRaces, view.totalRaces);
  assert.equal(p.recoveryRate, Number(view.recoveryRate));
});

test('回収率が無い日は null（0% などを捏造しない）', () => {
  const day = makeDay();
  delete day.recoveryRate;
  const p = buildShowcasePreview([day], 'nankan');
  assert.equal(p.recoveryRate, null);
});

test('複数会場開催では最初の会場を代表にし、残り会場数を返す', () => {
  const a = makeDay({ venue: '中京' });
  const b = makeDay({ venue: '新潟', mainLine: '1→2.3.4.5.6' });
  const c = makeDay({ venue: '札幌', mainLine: '3→1.2.4.5.6' });
  const merged = {
    date: '2026-08-16',
    venues: ['中京', '新潟', '札幌'],
    totalRaces: 36,
    hitRaces: 15,
    recoveryRate: 256.1,
    races: [...a.races, ...b.races, ...c.races],
  };
  const p = buildShowcasePreview([merged], 'jra');
  assert.equal(p.mainVenue, '中京');
  assert.equal(p.otherVenueCount, 2);
  assert.equal(p.venueLabel, '中京・新潟・札幌');
});

test('代表メインの選択は的中で並べ替えない（誇張しない）', () => {
  const miss = makeDay({ venue: '中京', mainHit: false });
  const hit = makeDay({
    venue: '新潟',
    mainLine: '1→2.3.4.5.6',
    mainHit: true,
    mainCombination: '1-2',
    mainPayout: 99999,
  });
  const merged = {
    date: '2026-08-16',
    venues: ['中京', '新潟'],
    totalRaces: 24,
    hitRaces: 6,
    recoveryRate: 100,
    races: [...miss.races, ...hit.races],
  };
  const p = buildShowcasePreview([merged], 'jra');
  assert.equal(p.mainVenue, '中京');
  assert.equal(p.mainRace.isHit, false);
});

test('リンク先とラベルはカテゴリ通り', () => {
  const jra = buildShowcasePreview([makeDay()], 'jra');
  assert.equal(jra.href, '/results-showcase/jra/');
  assert.equal(jra.categoryLabel, '中央競馬');
  const nankan = buildShowcasePreview([makeDay({ venue: '大井' })], 'nankan');
  assert.equal(nankan.href, '/results-showcase/nankan/');
  assert.equal(nankan.categoryLabel, '南関競馬');
});

test('データ無し・不正カテゴリ・メイン買い目無しは null（安全に非表示）', () => {
  assert.equal(buildShowcasePreview([], 'jra'), null);
  assert.equal(buildShowcasePreview(null, 'jra'), null);
  assert.equal(buildShowcasePreview(undefined, 'nankan'), null);
  assert.equal(buildShowcasePreview([makeDay()], 'premium-plus'), null);

  // メインレース（11R）の買い目が空 → 代表メインが作れない
  const noMain = makeDay();
  noMain.races[10] = { raceNumber: 11, venue: '中京', bettingLines: [], isHit: false };
  assert.equal(buildShowcasePreview([noMain], 'jra'), null);
});

test('本物のアーカイブでも壊れない（両カテゴリ）', async () => {
  const [{ default: nankan }, { default: jra }] = await Promise.all([
    import('../data/archiveResults.json', { with: { type: 'json' } }),
    import('../data/archiveResultsJra.json', { with: { type: 'json' } }),
  ]);
  for (const [arr, category] of [
    [nankan, 'nankan'],
    [jra, 'jra'],
  ]) {
    const p = buildShowcasePreview(arr, category);
    if (p === null) continue; // データ端境期は非表示が正しい挙動
    assert.ok(p.mainRace.honmei);
    assert.ok(p.mainRace.displayPartners.length > 0);
    assert.ok(p.totalRaces > 0);
    assert.ok(p.hitRaces <= p.totalRaces);
    assert.equal(JSON.stringify(p).includes('抑え'), false);
  }
});

// ─────────────────────────────────────────────────────────────
// 全レース一覧（2026-08-18 追加）
// ─────────────────────────────────────────────────────────────

test('全会場・全レースを venueGroups で返す（JRA 複数会場も全会場ぶん）', () => {
  const a = makeDay({ venue: '中京' });
  const b = makeDay({ venue: '新潟', mainLine: '1→2.3.4.5.6' });
  const c = makeDay({ venue: '札幌', mainLine: '3→1.2.4.5.6' });
  const merged = {
    date: '2026-08-16',
    venues: ['中京', '新潟', '札幌'],
    totalRaces: 36,
    hitRaces: 15,
    recoveryRate: 256.1,
    races: [...a.races, ...b.races, ...c.races],
  };
  const p = buildShowcasePreview([merged], 'jra');
  assert.deepEqual(
    p.venueGroups.map((g) => g.venue),
    ['中京', '新潟', '札幌']
  );
  for (const g of p.venueGroups) {
    assert.equal(g.totalRaces, 12);
    assert.equal(g.races.length, 12);
    assert.deepEqual(
      g.races.map((r) => r.raceNumber),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
    );
    assert.equal(g.hasMain, true);
    assert.equal(g.mainRaceNumber, 11);
  }
  // 全 36 レースが漏れなく出る
  assert.equal(p.venueGroups.reduce((n, g) => n + g.races.length, 0), 36);
});

test('全レース一覧は的中の有無のみ（非メインの買い目・払戻を持たない）', () => {
  const p = buildShowcasePreview([makeDay({ mainHit: true, mainPayout: 4210 })], 'jra');
  const races = p.venueGroups.flatMap((g) => g.races);
  assert.ok(races.length > 0);
  for (const r of races) {
    assert.deepEqual(Object.keys(r).sort(), ['isHit', 'isMain', 'raceNumber']);
  }
  // 一覧側に払戻・組み合わせ・買い目が一切載っていない
  const serialized = JSON.stringify(p.venueGroups);
  for (const leak of ['payout', 'combination', 'bettingLines', '抑え', '4210']) {
    assert.equal(serialized.includes(leak), false, `${leak} が一覧に漏れている`);
  }
});

test('メインレースだけ isMain=true（1 会場につき 1 レース）', () => {
  const p = buildShowcasePreview([makeDay()], 'jra');
  for (const g of p.venueGroups) {
    const mains = g.races.filter((r) => r.isMain);
    assert.equal(mains.length, 1);
    assert.equal(mains[0].raceNumber, g.mainRaceNumber);
  }
});

test('10R 開催（南関）は 9R がメイン・全 10 レースが出る', () => {
  const races = Array.from({ length: 10 }, (_, i) => ({
    raceNumber: i + 1,
    venue: '大井',
    isHit: i % 2 === 0,
    bettingLines: ['1↔2.3.4.5.6'],
    betPoints: 5,
  }));
  races[8] = {
    raceNumber: 9,
    venue: '大井',
    raceName: 'サードニックス賞',
    bettingLines: ['5→1.2.6.8.9(抑え3.7)'],
    isHit: false,
    umatan: { combination: '9-1', payout: 7820 },
    betPoints: 5,
  };
  const p = buildShowcasePreview(
    [{ date: '2026-08-17', venues: ['大井'], totalRaces: 10, hitRaces: 7, recoveryRate: 135.4, races }],
    'nankan'
  );
  assert.equal(p.venueGroups.length, 1);
  assert.equal(p.venueGroups[0].races.length, 10);
  assert.equal(p.venueGroups[0].mainRaceNumber, 9);
  assert.equal(p.mainRace.raceNumber, 9);
});

test('的中数は単一源の値のまま（一覧から数え直さない）', () => {
  const day = makeDay({ hitRaces: 4 });
  const p = buildShowcasePreview([day], 'jra');
  const view = buildLatestShowcase([day]);
  assert.equal(p.hitRaces, view.hitRaces);
  assert.equal(p.totalRaces, view.totalRaces);
});

test('本物のアーカイブでも全レースが出る（両カテゴリ）', async () => {
  const [{ default: nankan }, { default: jra }] = await Promise.all([
    import('../data/archiveResults.json', { with: { type: 'json' } }),
    import('../data/archiveResultsJra.json', { with: { type: 'json' } }),
  ]);
  for (const [arr, category] of [
    [nankan, 'nankan'],
    [jra, 'jra'],
  ]) {
    const p = buildShowcasePreview(arr, category);
    if (p === null) continue;
    const total = p.venueGroups.reduce((n, g) => n + g.races.length, 0);
    assert.equal(total, p.totalRaces, `${category}: 一覧の件数が totalRaces と一致しない`);
    for (const r of p.venueGroups.flatMap((g) => g.races)) {
      assert.deepEqual(Object.keys(r).sort(), ['isHit', 'isMain', 'raceNumber']);
    }
  }
});

// ─────────────────────────────────────────────────────────────
// 表示順の guard（全体実績 → 全レース一覧 → メイン買い目詳細）
// ─────────────────────────────────────────────────────────────

test('コンポーネントは全体実績 → 全レース一覧 → メイン買い目 の順で描画する', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const astro = readFileSync(
    join(here, '..', 'components', 'HomeResultsShowcasePreview.astro'),
    'utf-8'
  );
  const body = astro.slice(astro.indexOf('<section class="rsp"'), astro.indexOf('<style>'));
  const iSummary = body.indexOf('class="rsp__summary"');
  const iRaces = body.indexOf('class="rsp__races"');
  const iMain = body.indexOf('class="rsp__main"');
  assert.ok(iSummary > 0, '全体実績ブロックが無い');
  assert.ok(iRaces > 0, '全レース一覧ブロックが無い');
  assert.ok(iMain > 0, 'メイン買い目ブロックが無い');
  assert.ok(
    iSummary < iRaces && iRaces < iMain,
    `順序が崩れている: summary=${iSummary} races=${iRaces} main=${iMain}`
  );
});

test('全レース一覧のマークアップに払戻・買い目を出していない', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const astro = readFileSync(
    join(here, '..', 'components', 'HomeResultsShowcasePreview.astro'),
    'utf-8'
  );
  const body = astro.slice(astro.indexOf('<section class="rsp"'), astro.indexOf('<style>'));
  const strip = body.slice(body.indexOf('class="rsp__races"'), body.indexOf('class="rsp__main"'));
  for (const banned of ['payout', 'combination', 'displayPartners', 'honmei', 'betPoints']) {
    assert.equal(strip.includes(banned), false, `一覧に ${banned} を出している`);
  }
});
