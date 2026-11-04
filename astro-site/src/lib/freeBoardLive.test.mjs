/** freeBoardLive.test.mjs — レース単位の結果と発走時刻の変更。ページは合成（実データを repo に入れない） */
import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceState, judgeHit, loadLive, parseRaceListTimes, parseResultTop2, publicView } from './freeBoardLive.js';

const result = (rows, n = 10) => `<title>レース成績表</title><a href="x?k_raceNo=${n}">r</a><section class="gradeTable"><table><tr><th class="a">着順</th></tr>${
  rows.map(([rank, num]) => `<tr><td class="a">${rank}</td><td class="b">1</td><td class="c">${num}</td></tr>`).join('')}</table></section>`;
const list = (rows) => `2026年11月4日<table>${rows.map(([n, t, c]) => `<tr class="data"><td>${n}R</td><td>${t}</td><td><span class="timechange">${c || ''}</span></td></tr>`).join('')}</table>`;
const date = '2026-11-04';
const race = (n, hm, lines = ['3↔5.7']) => ({ venueName: '船橋', raceNumber: n, startAt: `${date}T${hm}:00+09:00`, lines });
const at = (hm) => Date.parse(`${date}T${hm}:00+09:00`);
const res = (status, body = '') => ({ status, ok: status === 200, text: async () => body });

test('parseResultTop2: 1・2 着の馬番。同着・発表前・別レースは null', () => {
  assert.deepEqual(parseResultTop2(result([[1, 7], [2, 3], [3, 9]]), 10), { first: 7, second: 3 });
  assert.equal(parseResultTop2(result([[1, 7], [1, 3], [3, 9]]), 10), null, '1 着同着');
  assert.equal(parseResultTop2(result([[1, 7], [2, 3], [2, 9]]), 10), null, '2 着同着');
  assert.equal(parseResultTop2('<title>エラー</title>', 10), null);
  assert.equal(parseResultTop2(result([[1, 7], [2, 3]], 9), 10), null);
});

test('parseRaceListTimes: 変更欄を優先・日付違いは null', () => {
  const t = parseRaceListTimes(list([[1, '14:40'], [2, '15:10', '15:13']]), date);
  assert.deepEqual([t.get(1), t.get(2)], ['14:40', '15:13']);
  assert.equal(parseRaceListTimes(list([[1, '14:40']]), '2026-11-05'), null);
});

test('judgeHit: importResults と同じ判定・買い目が無ければ判定しない', () => {
  assert.equal(judgeHit(['3↔5.7'], { first: 7, second: 3 }), true);
  assert.equal(judgeHit(['3→5.7'], { first: 7, second: 3 }), false, '一方向の裏目は外れ');
  assert.equal(judgeHit(['3↔5(抑え7)'], { first: 3, second: 7 }), false, '抑えは対象外');
  assert.equal(judgeHit([], { first: 7, second: 3 }), null);
  assert.equal(judgeHit(['3↔5'], null), null);
});

test('advanceState: 発走直後は読まず、読めたレースから順に確定する', async () => {
  const urls = [];
  const fetchImpl = async (u) => { urls.push(u); return u.includes('RaceList') ? res(200, list([[1, '14:40'], [2, '15:10']])) : res(200, result([[1, 7], [2, 3]], Number(/k_raceNo=(\d+)/.exec(u)[1]))); };
  const races = [race(1, '14:40'), race(2, '15:10')];
  const s1 = await advanceState({ state: {}, races, date, nowMs: at('14:45'), fetchImpl, wait: async () => {} });
  assert.deepEqual(s1.hits, {});
  assert.ok(urls.every((u) => u.includes('RaceList')), '8 分経つまで成績は見ない');
  const s2 = await advanceState({ state: s1, races, date, nowMs: at('14:50'), fetchImpl, wait: async () => {} });
  assert.deepEqual(s2.hits, { '船橋|1': true });
  urls.length = 0;
  const s3 = await advanceState({ state: s2, races, date, nowMs: at('14:51'), fetchImpl, wait: async () => {} });
  assert.ok(!urls.some((u) => u.includes('k_raceNo=1&')), '確定済みは読み直さない');
  assert.deepEqual(s3.hits, s2.hits);
});

test('advanceState: 変更後の時刻を記録し、成績を見に行く時刻も後ろへずらす', async () => {
  const urls = [];
  const fetchImpl = async (u) => { urls.push(u); return res(200, list([[1, '14:40', '14:55']])); };
  const s = await advanceState({ state: {}, races: [race(1, '14:40')], date, nowMs: at('14:50'), fetchImpl, wait: async () => {} });
  assert.equal(s.times['船橋|1'], new Date(at('14:55')).toISOString());
  assert.ok(!urls.some((u) => u.includes('RaceMarkTable')));
});

test('🛑 アクセス拒否は 1 時間読まない・通信失敗は何も書かない', async () => {
  let n = 0;
  const s = await advanceState({ state: {}, races: [race(1, '14:40')], date, nowMs: at('15:00'), fetchImpl: async () => { n += 1; return res(403); }, wait: async () => {} });
  assert.equal(n, 1);
  assert.ok(s.blockedUntil > at('15:30'));
  await advanceState({ state: s, races: [race(1, '14:40')], date, nowMs: at('15:30'), fetchImpl: async () => { n += 1; return res(200); } });
  assert.equal(n, 1);
  const e = await advanceState({ state: {}, races: [race(1, '14:40')], date, nowMs: at('15:00'), fetchImpl: async () => { throw new Error('x'); }, wait: async () => {} });
  assert.deepEqual(e.hits, {});
});

test('🛑 公開は ✅/✗ と時刻だけ・ロックが無ければ公式を読まない', async () => {
  assert.deepEqual(Object.keys(publicView({ hits: { a: true }, times: {}, tries: { a: 1 }, listAt: 1, blockedUntil: 2 })).sort(), ['hits', 'times']);
  let fetched = 0;
  const store = new Map([['ak:freeboard:v1:nankan:2026-11-04', JSON.stringify({ hits: { '船橋|1': false } })]]);
  const redis = async ([cmd, key]) => (cmd === 'GET' ? store.get(key) ?? null : null);
  const v = await loadLive({ redis, races: [race(1, '14:40')], date, nowMs: at('16:00'), fetchImpl: async () => { fetched += 1; return res(200); } });
  assert.deepEqual(v, { hits: { '船橋|1': false }, times: {} });
  assert.equal(fetched, 0);
  assert.deepEqual(await loadLive({ redis: null, races: [race(1, '14:40')], date, nowMs: 0 }), { hits: {}, times: {} });
});
