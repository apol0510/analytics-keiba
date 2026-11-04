import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFreeLiveBoard, dayPrefix, headline, hitMapFor, jstToIso, nextRace, nextRacesByCat, raceProgress, raceStatus, ringModel } from './freeLiveBoard.js';
import { buildNextRaceFeed } from './nextRaceFeed.js';

const model = {
  date: '2026-11-03',
  venues: [
    { venueName: '船橋', races: [
      { listing: { raceNumber: 1, startTime: '12:10', isMainRace: false } },
      { listing: { raceNumber: 2, startTime: '12:45', isMainRace: false } },
      { listing: { raceNumber: 11, startTime: '20:15', isMainRace: true } },
      { listing: { raceNumber: 12, startTime: '', isMainRace: false } },
    ] },
  ],
};
const archive = [
  { date: '2026-11-03', venue: '船橋', races: [
    { venue: '船橋', raceNumber: 1, isHit: true, bettingLines: ['1↔2.3'], umatan: { combination: '1-2', payout: 1200 } },
    { venue: '船橋', raceNumber: 2, isHit: false, bettingLines: ['4↔5.6'] },
    { venue: '船橋', raceNumber: 11, isHit: true, bettingLines: ['3→5.7.8.10.12(抑え9)'], umatan: { combination: '3-5', payout: 5000 } },
  ] },
  { date: '2026-11-02', venue: '船橋', races: [{ venue: '船橋', raceNumber: 1, isHit: false }] },
];
const at = (hm) => Date.parse(`2026-11-03T${hm}:00+09:00`);

test('jstToIso: JST 時刻を ISO に・読めなければ null', () => {
  assert.equal(jstToIso('2026-11-03', '12:10'), '2026-11-03T03:10:00.000Z');
  assert.equal(jstToIso('2026-11-03', ''), null);
  assert.equal(jstToIso('2026-11-03', '25:00'), null);
  assert.equal(jstToIso('bad', '12:10'), null);
});

test('🛑 買い目・払戻・メイン判定をブラウザ向けモデルへ写さない', () => {
  const b = buildFreeLiveBoard({ cat: 'nankan', model, archiveArray: archive });
  const json = JSON.stringify(b);
  for (const banned of ['bettingLines', 'umatan', 'payout', 'combination', 'isMainRace', '↔', '→', '抑え', '1200', '5000']) {
    assert.ok(!json.includes(banned), `leaked: ${banned}`);
  }
  for (const r of b.races) assert.deepEqual(Object.keys(r).sort(), ['hit', 'raceNumber', 'startAt', 'venueName']);
});

test('結果が入った日は ✅/✗ を全部出し、累計は正直に数える', () => {
  const b = buildFreeLiveBoard({ cat: 'nankan', model, archiveArray: archive });
  assert.deepEqual(b.races.map((r) => r.hit), [true, false, true, null]);
  assert.deepEqual(b.tally, { hit: 2, total: 3 });
  assert.equal(raceStatus(b.races[0], at('21:30'), true).text, '的中');
  assert.equal(raceStatus(b.races[1], at('21:30'), true).text, '不的中');
});

test('結果が無い日は ✅/✗ を付けない（推測しない）', () => {
  const b = buildFreeLiveBoard({ cat: 'nankan', model, archiveArray: archive.slice(1) });
  assert.equal(b.resultsIn, false);
  assert.equal(b.tally, null);
  const past = raceStatus(b.races[0], at('13:00'), false);
  assert.equal(past.state, 'past');
  assert.match(past.text, /^\d{2}:\d{2}$/, '発走済みは時刻だけ（「結果待ち」を並べない）');
  assert.equal(raceStatus(b.races[2], at('13:00'), false, b.races[2]).text, '次 20:15');
  assert.equal(raceStatus(b.races[2], at('13:00'), false).text, '20:15 発走');
  assert.equal(raceStatus(b.races[3], at('13:00'), false).text, '発走時刻未定');
  assert.equal(hitMapFor(archive, '2026-11-04'), null);
});

test('カウントダウンは全レース共通（メインを優先しない）・時刻未定は飛ばす', () => {
  const b = buildFreeLiveBoard({ cat: 'nankan', model, archiveArray: [] });
  assert.equal(nextRace(b.races, at('12:00')).raceNumber, 1);
  assert.equal(nextRace(b.races, at('12:20')).raceNumber, 2);
  assert.equal(nextRace(b.races, at('13:00')).raceNumber, 11);
  assert.equal(nextRace(b.races, at('20:20')), null);
  const h = headline(b, at('12:44'));
  assert.equal(h.state, 'countdown');
  assert.equal(h.label, '船橋 2R');
  assert.equal(h.at, '12:45');
});

test('全レース発走後: 結果前は反映予定、結果後は終了', () => {
  const pending = buildFreeLiveBoard({ cat: 'nankan', model, archiveArray: [] });
  assert.match(headline(pending, at('20:30')).text, /本日の発走はすべて終了.*21 時台/);
  const done = buildFreeLiveBoard({ cat: 'nankan', model, archiveArray: archive });
  assert.equal(headline(done, at('21:30')).text, '本日のレースはすべて終了しました');
  // 過去日を表示しているときは「本日」と書かない
  assert.equal(headline(done, Date.parse('2026-11-05T10:00:00+09:00')).text, '11/3のレースはすべて終了しました');
});

test('レースが無ければ何も出さない', () => {
  const b = buildFreeLiveBoard({ cat: 'jra', model: { date: null, venues: [] }, archiveArray: archive });
  assert.equal(b.races.length, 0);
  assert.equal(headline(b, at('12:00')).state, 'none');
});

test('guard: 部品は単一源だけを使い、買い目系フィールドを参照しない', () => {
  const src = readFileSync(new URL('../components/FreeLiveRaceBoard.astro', import.meta.url), 'utf-8');
  assert.match(src, /from '\.\.\/lib\/freeLiveBoard\.js'/);
  for (const banned of ['bettingLines', 'umatan', 'payout', 'isMainRace', 'mainRace']) assert.ok(!src.includes(banned), banned);
  for (const page of ['jra', 'nankan']) {
    const p = readFileSync(new URL(`../pages/free-prediction/${page}.astro`, import.meta.url), 'utf-8');
    assert.match(p, new RegExp(`<FreeLiveRaceBoard cat="${page}" model=\\{model\\} />`));
  }
});

test('ringModel: 1 周 60 分・60 分以上は満タン・発走後と時刻不明は null', () => {
  const start = '2026-11-03T08:15:00.000Z'; // 17:15 JST
  const ms = (m, s = 0) => Date.parse(start) - (m * 60 + s) * 1000;
  assert.deepEqual(ringModel(start, ms(19, 47)), { fraction: 1187 / 3600, second: 47, soon: false, main: '19分', sub: '47秒' });
  assert.equal(ringModel(start, ms(30)).fraction, 0.5);
  assert.equal(ringModel(start, ms(60)).fraction, 1);
  const far = ringModel(start, ms(125));
  assert.deepEqual([far.fraction, far.main, far.sub], [1, '2時間', '05分']);
  assert.equal(ringModel(start, ms(5, 1)).soon, false);
  assert.equal(ringModel(start, ms(5)).soon, true, '残り 5 分から金色');
  assert.equal(ringModel(start, Date.parse(start)), null);
  assert.equal(ringModel(null, ms(5)), null);
});

test('dayPrefix: 今日は空・翌日は明日・それ以外は M/D（JST の日付で判定）', () => {
  const race = '2026-11-07T01:10:00.000Z'; // 11/7 10:10 JST
  assert.equal(dayPrefix(race, Date.parse('2026-11-07T08:00:00+09:00')), '');
  assert.equal(dayPrefix(race, Date.parse('2026-11-06T23:30:00+09:00')), '明日 ');
  assert.equal(dayPrefix(race, Date.parse('2026-11-05T23:30:00+09:00')), '11/7 ');
});

test('headline: 翌日ぶんは時刻に日付が付く', () => {
  const b = buildFreeLiveBoard({ cat: 'nankan', model, archiveArray: [] });
  assert.equal(headline(b, at('12:00')).at, '12:10');
  assert.equal(headline(b, Date.parse('2026-11-02T22:00:00+09:00')).at, '明日 12:10');
});

test('nextRacesByCat: 区分ごとに次の 1 件・翌日ぶんは当日ぶんと混ぜない・無ければ空', () => {
  const r = (cat, venueName, raceNumber, jst) => ({ cat, venueName, raceNumber, startAt: new Date(Date.parse(`${jst}:00+09:00`)).toISOString() });
  const feed = [
    r('jra', '東京', 11, '2026-11-07T15:40'), r('jra', '東京', 1, '2026-11-07T10:10'),
    r('nankan', '大井', 1, '2026-11-07T14:50'), r('nankan', '大井', 2, '2026-11-08T14:50'),
  ];
  const t = (jst) => Date.parse(`${jst}:00+09:00`);
  const brief = (l) => l.map((x) => `${x.venueName}${x.raceNumber}`);
  assert.deepEqual(brief(nextRacesByCat(feed, t('2026-11-07T09:00'))), ['東京1', '大井1'], '土日は 2 区分が並ぶ');
  assert.deepEqual(brief(nextRacesByCat(feed, t('2026-11-07T15:00'))), ['東京11'], '翌日の南関は当日の中央と並べない');
  assert.deepEqual(brief(nextRacesByCat(feed, t('2026-11-07T20:00'))), ['大井2'], '当日が終われば翌日へ');
  assert.deepEqual(nextRacesByCat(feed, t('2026-11-09T09:00')), []);
  assert.deepEqual(nextRacesByCat(null, t('2026-11-09T09:00')), []);
});

test('buildNextRaceFeed: 今日以降だけ・許可したキーだけ・時刻未定は除く・片方が無くても出す', () => {
  const root = mkdtempSync(join(tmpdir(), 'nrf-'));
  try {
    const dir = join(root, 'src', 'data', 'predictions');
    mkdirSync(dir, { recursive: true });
    const horses = [{ horseNumber: 1, horseName: '秘密の馬', role: '本命', pt: 99 }];
    const day = (date, races) => JSON.stringify({ eventInfo: { date, totalRaces: races.length }, predictions: races });
    writeFileSync(join(dir, '2026-11-03-funabashi.json'), day('2026-11-03', [{ raceInfo: { raceNumber: 1, startTime: '12:10' }, horses }]));
    writeFileSync(join(dir, '2026-11-04-funabashi.json'), day('2026-11-04', [
      { raceInfo: { raceNumber: 6, startTime: '17:15' }, horses },
      { raceInfo: { raceNumber: 7, startTime: '' }, horses },
    ]));
    const feed = buildNextRaceFeed({ root, now: Date.parse('2026-11-04T09:00:00+09:00') });
    assert.deepEqual(feed, [{ cat: 'nankan', venueName: '船橋', raceNumber: 6, startAt: '2026-11-04T08:15:00.000Z' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('guard: 次のレース部品は買い目系を参照せず、対象ページすべてに置かれている', () => {
  for (const f of ['../components/NextRaceStrip.astro', '../components/CountdownRing.astro', './nextRaceFeed.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const banned of ['bettingLines', 'umatan', 'payout', 'isMainRace', 'mainRace', 'gtag']) assert.ok(!src.includes(banned), `${f}: ${banned}`);
  }
  for (const page of ['index', 'free/index', 'free/jra', 'free/nankan', 'free-prediction/index']) {
    assert.match(readFileSync(new URL(`../pages/${page}.astro`, import.meta.url), 'utf-8'), /<NextRaceStrip /, page);
  }
});

test('raceProgress: 結果の案内は 1 回だけ・結果が入ったら消える', () => {
  const start = (h) => `2026-11-04T${h}:00+09:00`;
  const board = { date: '2026-11-04', resultsIn: false, resultEta: '21 時台', races: [{ startAt: start('14:40') }, { startAt: start('15:10') }, { startAt: start('15:40') }, { startAt: null }] };
  const t = (h) => Date.parse(start(h));
  assert.equal(raceProgress(board, t('14:00')), null, '発走前は出さない');
  const p = raceProgress(board, t('15:20'));
  assert.equal(p.text, '発走済み 2 / 3 レース');
  assert.equal(p.eta, '有料版の的中は21 時台にまとめて表示');
  assert.equal(raceProgress(board, t('16:00')), null, '全レース発走後は見出しが案内する');
  assert.equal(raceProgress({ ...board, resultsIn: true }, t('15:20')), null);
  const yesterday = { ...board, date: '2026-11-03' };
  assert.match(raceProgress(yesterday, t('15:20')).eta, /確定後に/);
});
