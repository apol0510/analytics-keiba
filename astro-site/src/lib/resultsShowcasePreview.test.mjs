// resultsShowcasePreview.test.mjs
// トップページ上部プレビュー（有料実績ショーケースの誘導カード）の回帰テスト。
//
// 守るべき確定仕様（astro-site/docs/RESULTS_SHOWCASE.md）:
//   - 単一源 buildLatestShowcase() の結果から選ぶだけで、独自集計をしない
//   - 買い目はメインレースのみ・抑えは非公開
//   - 旧 ↔ archive の裏目的中は buildMainRace の畳み込み（⇄ + 勝った1組）に従う
//   - データが無い / 代表メインが無いカテゴリは null（＝カードごと非表示）
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
