// resultsShowcasePreview.test.mjs
// トップページ上部プレビュー（当日実績カード）の回帰テスト。
//
// 守るべき確定仕様（astro-site/docs/RESULTS_SHOWCASE.md）:
//   - 単一源 buildLatestShowcase() の結果から選ぶだけで、独自集計をしない
//   - **トップでは買い目・払戻を一切出さない**（戻り値にも markup にも含めない）。
//     メインの実際の配信買い目は /results-showcase/{jra,nankan} 側だけで見せる
//   - **的中したレースだけを出す**（2026-11-25 MK 決定）。不的中のレース・分母（総レース数・
//     「全12R」）・0 件のカードを出さない（戻り値にも markup にも含めない）
//   - 的中レースは ✅ を同列で出す（メインを強調しない）
//   - JRA の複数会場開催は全会場ぶん出す（的中が無い会場は出さない）
//   - データが無い・的中 0 件のカテゴリは null（＝カードごと非表示）
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

function componentSource() {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '..', 'components', 'HomeResultsShowcasePreview.astro'), 'utf-8');
}

function componentTemplate() {
  const src = componentSource();
  return src.slice(src.indexOf('<section class="rsp"'), src.indexOf('<style>'));
}

// ─────────────────────────────────────────────────────────────
// 基本
// ─────────────────────────────────────────────────────────────

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
  const p = buildShowcasePreview(
    [makeDay({ date: '2026-08-16' }), makeDay({ date: '2026-08-10', venue: '新潟' })],
    'jra'
  );
  assert.equal(p.date, '2026-08-16');
  assert.equal(p.venueLabel, '中京');
});

test('リンク先とラベルはカテゴリ通り', () => {
  const jra = buildShowcasePreview([makeDay()], 'jra');
  assert.equal(jra.href, '/results-showcase/jra/');
  assert.equal(jra.categoryLabel, '中央競馬');
  const nankan = buildShowcasePreview([makeDay({ venue: '大井' })], 'nankan');
  assert.equal(nankan.href, '/results-showcase/nankan/');
  assert.equal(nankan.categoryLabel, '南関競馬');
});

// ─────────────────────────────────────────────────────────────
// トップでは買い目・払戻を出さない（最重要）
// ─────────────────────────────────────────────────────────────

test('戻り値に買い目・払戻を一切含めない（的中日でも）', () => {
  const p = buildShowcasePreview(
    [makeDay({ mainHit: true, mainCombination: '7-13', mainPayout: 4210 })],
    'jra'
  );
  const serialized = JSON.stringify(p);
  for (const leak of [
    'honmei',
    'partners',
    'displayArrow',
    'displayPartners',
    'payout',
    'combination',
    'bettingLines',
    'betPoints',
    'mainRace',
    '抑え',
    '4210',
    '7-13',
  ]) {
    assert.equal(serialized.includes(leak), false, `${leak} がトップ用データに漏れている`);
  }
});

test('公開キーは固定（増やすときは意図的に）', () => {
  const p = buildShowcasePreview([makeDay()], 'jra');
  assert.deepEqual(Object.keys(p).sort(), [
    'categoryLabel',
    'categoryTag',
    'category',
    'date',
    'dateLabel',
    'hitRaces',
    'href',
    'recoveryRate',
    'venueGroups',
    'venueLabel',
  ].sort());
  assert.deepEqual(Object.keys(p.venueGroups[0]).sort(), ['races', 'venue']);
});

test('コンポーネントに買い目・払戻のマークアップが無い', () => {
  const tpl = componentTemplate();
  for (const banned of [
    'rsp__bet',
    'rsp__line',
    'rsp__num',
    'rsp__arrow',
    'rsp__payout',
    'rsp__combo',
    'rsp__main',
    'honmei',
    'payout',
    'combination',
    'displayPartners',
    'betPoints',
    '配信買い目',
    '馬単',
  ]) {
    assert.equal(tpl.includes(banned), false, `トップに ${banned} が残っている`);
  }
});

test('メインレースを視覚的に強調しない（全レース同列）', () => {
  const tpl = componentTemplate();
  assert.equal(tpl.includes('is-main'), false, 'メイン強調クラスが残っている');
  assert.equal(tpl.includes('（メイン）'), false, 'メインだけ別扱いのラベルが残っている');
});

// ─────────────────────────────────────────────────────────────
// 不的中・分母を出さない（2026-11-25 MK 決定）
// ─────────────────────────────────────────────────────────────

test('コンポーネントに不的中・分母のマークアップが無い', () => {
  const tpl = componentTemplate();
  for (const banned of ['不的中', 'is-miss', '✗', 'totalRaces', '全{', '全レース', '/{c.']) {
    assert.equal(tpl.includes(banned), false, `トップに ${banned} が残っている`);
  }
});

test('戻り値は的中したレースだけ（不的中のレース・総レース数を持たない）', () => {
  const p = buildShowcasePreview([makeDay({ hitRaces: 3 })], 'jra');
  const races = p.venueGroups.flatMap((g) => g.races);
  assert.deepEqual(races.map((r) => r.raceNumber), [1, 2, 3]);
  assert.ok(races.every((r) => r.isHit === true));
  assert.equal('totalRaces' in p, false);
  assert.equal(p.venueGroups.some((g) => 'totalRaces' in g), false);
});

test('的中が無い会場は出さない', () => {
  const a = makeDay({ venue: '中京', hitRaces: 2 });
  const b = makeDay({ venue: '新潟', hitRaces: 0 });
  const merged = {
    date: '2026-08-16',
    venues: ['中京', '新潟'],
    totalRaces: 24,
    hitRaces: 2,
    races: [...a.races, ...b.races],
  };
  const p = buildShowcasePreview([merged], 'jra');
  assert.deepEqual(p.venueGroups.map((g) => g.venue), ['中京']);
});

test('的中 0 件の日はカードごと出さない（null）', () => {
  const day = makeDay({ hitRaces: 0, mainHit: false });
  assert.equal(buildShowcasePreview([day], 'jra'), null);
});

// ─────────────────────────────────────────────────────────────
// 全レース一覧
// ─────────────────────────────────────────────────────────────

test('的中レースを全会場ぶん venueGroups で返す（JRA 複数会場）', () => {
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
    assert.deepEqual(
      g.races.map((r) => r.raceNumber),
      [1, 2, 3]
    );
  }
  assert.equal(p.venueGroups.reduce((n, g) => n + g.races.length, 0), 9);
});

test('各レースは raceNumber / isHit / isMain の 3 キーのみ', () => {
  const p = buildShowcasePreview([makeDay({ mainHit: true, mainPayout: 4210 })], 'jra');
  for (const r of p.venueGroups.flatMap((g) => g.races)) {
    assert.deepEqual(Object.keys(r).sort(), ['isHit', 'isMain', 'raceNumber']);
  }
});

test('10R 開催（南関）は的中した 5 レースだけが出る', () => {
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
  assert.deepEqual(p.venueGroups[0].races.map((r) => r.raceNumber), [1, 3, 5, 7]);
  assert.equal(JSON.stringify(p).includes('7820'), false);
});

test('メイン買い目が取れない日でも的中レースは出す', () => {
  const day = makeDay();
  day.races[10] = { raceNumber: 11, venue: '中京', bettingLines: [], isHit: false };
  const p = buildShowcasePreview([day], 'jra');
  assert.notEqual(p, null);
  assert.equal(p.venueGroups[0].races.length, 3);
});

// ─────────────────────────────────────────────────────────────
// 集計・fail-safe
// ─────────────────────────────────────────────────────────────

test('集計は単一源の値をそのまま使う（一覧から数え直さない）', () => {
  const day = makeDay({ hitRaces: 4, recoveryRate: 118.2 });
  const p = buildShowcasePreview([day], 'jra');
  const view = buildLatestShowcase([day]);
  assert.equal(p.hitRaces, view.hitRaces);
  // 2026-10-06: 回収率は本線＋抑えの全組が分母（買い目行が無い日は null）。単一源の値をそのまま使うことだけを見る
  assert.equal(p.recoveryRate, view.recoveryRate == null ? null : Number(view.recoveryRate));
});

test('回収率が無い日は null（0% などを捏造しない）', () => {
  const day = makeDay();
  delete day.recoveryRate;
  day.races = day.races.map(({ bettingLines, ...r }) => r); // 点数を数える買い目行が無い日
  const p = buildShowcasePreview([day], 'nankan');
  assert.equal(p.recoveryRate, null);
});

test('データ無し・不正カテゴリ・レース 0 件は null（安全に非表示）', () => {
  assert.equal(buildShowcasePreview([], 'jra'), null);
  assert.equal(buildShowcasePreview(null, 'jra'), null);
  assert.equal(buildShowcasePreview(undefined, 'nankan'), null);
  assert.equal(buildShowcasePreview([makeDay()], 'premium-plus'), null);
  assert.equal(
    buildShowcasePreview([{ date: '2026-08-16', venues: [], totalRaces: 0, races: [] }], 'jra'),
    null
  );
});

// ─────────────────────────────────────────────────────────────
// 表示順（的中数 → 的中レース → 導線）
// ─────────────────────────────────────────────────────────────

test('的中数 → 的中レース → CTA の順で描画する', () => {
  const tpl = componentTemplate();
  const iSummary = tpl.indexOf('class="rsp__summary"');
  const iRaces = tpl.indexOf('class="rsp__races"');
  const iCta = tpl.indexOf('class="rsp__cta"');
  assert.ok(iSummary > 0, '的中数ブロックが無い');
  assert.ok(iRaces > 0, '的中レースブロックが無い');
  assert.ok(iCta > 0, 'CTA が無い');
  assert.ok(
    iSummary < iRaces && iRaces < iCta,
    `順序が崩れている: summary=${iSummary} races=${iRaces} cta=${iCta}`
  );
});

// ─────────────────────────────────────────────────────────────
// 実データ
// ─────────────────────────────────────────────────────────────

test('本物のアーカイブでも的中レースだけが出る／買い目は漏れない（両カテゴリ）', async () => {
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
    const races = p.venueGroups.flatMap((g) => g.races);
    assert.ok(races.length > 0, `${category}: 的中レースが空のカードを返した`);
    assert.ok(races.every((r) => r.isHit === true), `${category}: 不的中のレースが混ざっている`);
    assert.ok(p.hitRaces > 0);
    const serialized = JSON.stringify(p);
    for (const leak of ['payout', 'combination', 'bettingLines', '抑え', 'honmei']) {
      assert.equal(serialized.includes(leak), false, `${category}: ${leak} が漏れている`);
    }
  }
});
