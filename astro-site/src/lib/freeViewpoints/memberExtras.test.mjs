import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDate, calcInterval, calcBodyWeight, buildConditionHistory,
  buildSameConditionTable, buildHorseExtras,
} from './memberExtras.js';

const today = { date: '2026-08-20', venue: '川崎', distanceMeters: 1600 };

// ─── 出走間隔 ─────────────────────────────────────────────────

test('前走からの日数で 連闘 / 中◯週 / 休養明け を出し分ける', () => {
  assert.equal(calcInterval('2026-08-20', '2026-08-14').label, '連闘');      // 6日
  assert.equal(calcInterval('2026-08-20', '2026-08-13').label, '連闘');      // 7日
  assert.equal(calcInterval('2026-08-20', '2026-08-12').label, '中1週');     // 8日
  assert.equal(calcInterval('2026-08-20', '2026-08-06').label, '中1週');     // 14日
  assert.equal(calcInterval('2026-08-20', '2026-07-30').label, '中2週');     // 21日
  const long = calcInterval('2026-08-20', '2026-05-01');                     // 111日
  assert.ok(long.longLayoff, '12週以上は休養明け');
  assert.ok(long.label.startsWith('休養明け'));
});

test('日付が取れないときは null（連闘と決めつけない）', () => {
  assert.equal(calcInterval('2026-08-20', null), null);
  assert.equal(calcInterval('2026-08-20', ''), null);
  assert.equal(calcInterval(null, '2026-08-01'), null);
  assert.equal(calcInterval('2026-08-20', 'ごみ'), null);
  assert.equal(parseDate('2026/08/20'), null, 'スラッシュ区切りは受け付けない');
});

test('前走が未来日なら null（データ不整合を表示しない）', () => {
  assert.equal(calcInterval('2026-08-20', '2026-08-21'), null);
});

// ─── 馬体重 ───────────────────────────────────────────────────

test('前走時点の馬体重と、その前走比の増減を返す', () => {
  const r = calcBodyWeight([{ bodyWeight: 470 }, { bodyWeight: 462 }]);
  assert.deepEqual(r, { latest: 470, diff: 8 });
  const minus = calcBodyWeight([{ bodyWeight: 458 }, { bodyWeight: 470 }]);
  assert.equal(minus.diff, -12);
});

test('2 走ぶん揃わなければ増減は null（0 と誤らせない）', () => {
  assert.deepEqual(calcBodyWeight([{ bodyWeight: 470 }]), { latest: 470, diff: null });
  assert.deepEqual(calcBodyWeight([{ bodyWeight: 470 }, {}]), { latest: 470, diff: null });
  assert.equal(calcBodyWeight([{}, { bodyWeight: 470 }]), null, '最新走の体重が無ければ出さない');
  assert.equal(calcBodyWeight([]), null);
});

// ─── 条件変化の履歴 ───────────────────────────────────────────

test('過去5走までを新しい順に、1 走ごとの会場・距離の変化つきで返す', () => {
  const past = [
    { venue: '大井', distance: 1400, finish: 3 },
    { venue: '川崎', distance: 1600, finish: 1 },
    { venue: '川崎', distance: 1500, finish: 5 },
  ];
  const h = buildConditionHistory(past, today);
  assert.equal(h.length, 3);
  assert.equal(h[0].venueChanged, true, '大井 ← 川崎 で会場が替わっている');
  assert.equal(h[0].distanceChanged, true, '1400 ← 1600 は 200m 以上');
  assert.equal(h[1].venueChanged, false);
  assert.equal(h[1].distanceChanged, false, '1600 ← 1500 は 200m 未満');
  assert.equal(h[2].venueChanged, null, '最も古い走は比較対象が無い');
});

test('最新走だけ今日の条件との比較を持つ', () => {
  const h = buildConditionHistory([{ venue: '大井', distance: 1400 }], today);
  assert.equal(h[0].vsToday.sameVenue, false);
  assert.equal(h[0].vsToday.distanceDiff, -200);
  const same = buildConditionHistory([{ venue: '川崎', distance: 1600 }], today);
  assert.equal(same[0].vsToday.sameVenue, true);
  assert.equal(same[0].vsToday.distanceDiff, 0);
});

test('6 走以上あっても 5 走までに制限する', () => {
  const past = Array.from({ length: 8 }, () => ({ venue: '川崎', distance: 1600 }));
  assert.equal(buildConditionHistory(past, today).length, 5);
});

// ─── 同条件馬の横比較 ─────────────────────────────────────────

const horse = (number, name, prev) => ({ number, name, prev });

test('前走が同会場・近い距離の馬だけを、前走着順順に並べる', () => {
  const rows = buildSameConditionTable([
    horse(1, 'アルファ', { venue: '川崎', distance: 1600, finish: 5, bodyWeight: 470 }),
    horse(2, 'ブラボー', { venue: '大井', distance: 1600, finish: 1 }),        // 別会場
    horse(3, 'チャーリー', { venue: '川崎', distance: 1200, finish: 1 }),      // 距離が離れている
    horse(4, 'デルタ', { venue: '川崎', distance: 1500, finish: 2 }),          // 100m差 → 対象
    horse(5, 'エコー', null),                                                  // 前走なし
  ], today);
  assert.deepEqual(rows.map((r) => r.number), [4, 1], '対象は 4番・1番のみ、着順順');
  assert.equal(rows[0].bodyWeight, null);
  assert.equal(rows[1].bodyWeight, 470);
});

test('着順が数値でない馬は後ろに回す（除外はしない）', () => {
  const rows = buildSameConditionTable([
    horse(1, 'アルファ', { venue: '川崎', distance: 1600, finish: '中止' }),
    horse(2, 'ブラボー', { venue: '川崎', distance: 1600, finish: 3 }),
  ], today);
  assert.deepEqual(rows.map((r) => r.number), [2, 1]);
});

test('今日の距離が取れなければ横比較を作らない（誤った同条件判定をしない）', () => {
  const rows = buildSameConditionTable(
    [horse(1, 'アルファ', { venue: '川崎', distance: 1600, finish: 1 })],
    { venue: '川崎', distanceMeters: null },
  );
  assert.deepEqual(rows, []);
});

// ─── まとめ ───────────────────────────────────────────────────

test('過去走が無い馬は null（空オブジェクトを返さない）', () => {
  assert.equal(buildHorseExtras({ past: [] }, today), null);
  assert.equal(buildHorseExtras({}, today), null);
  assert.equal(buildHorseExtras(null, today), null);
});

test('項目ごとにデータの有無を保つ（無い項目は null）', () => {
  const e = buildHorseExtras({ past: [{ venue: '川崎', distance: 1600 }] }, today);
  assert.equal(e.interval, null, '日付が無いので間隔は出さない');
  assert.equal(e.bodyWeight, null, '体重が無いので出さない');
  assert.equal(e.history.length, 1, '履歴は作れる');
});

// ─── 有料情報を扱わない ───────────────────────────────────────

test('有料項目を入力に取らず、出力にも含めない', () => {
  const withPaid = {
    past: [{ venue: '川崎', distance: 1600, date: '2026-08-06', bodyWeight: 470, pt: 999, role: '本命' }],
    pt: 999, computerIndex: 88, role: '本命', featureScores: { speedIndex: 90 },
  };
  const e = buildHorseExtras(withPaid, today);
  const json = JSON.stringify(e);
  for (const banned of ['pt', 'computerIndex', 'role', 'featureScores', '本命', 'bettingLines']) {
    assert.equal(json.includes(banned), false, `${banned} を出してはいけない`);
  }
  // 有料項目があってもなくても結果が同じ
  const plain = buildHorseExtras({ past: [{ venue: '川崎', distance: 1600, date: '2026-08-06', bodyWeight: 470 }] }, today);
  assert.deepEqual(e, plain);
});
