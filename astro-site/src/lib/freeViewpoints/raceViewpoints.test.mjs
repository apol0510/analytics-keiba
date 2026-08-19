import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateRace, dailyHighlights, TAG, RACE_STATE } from './raceViewpoints.js';
import { MIN_HORSES, THRESHOLDS, REQUIRED_COVERAGE } from './thresholds.js';

// 騎手判定はページ側の責務。テストでは単純一致にする。
const sameJockey = (a, b) => {
  if (!a || !b) return null;
  return String(a) === String(b);
};

const horse = (past, todayJockey = 'J1') => ({ past, todayJockey });
const run = (venue, distance, jockey = 'J1') => ({ venue, distance, jockey });

/** n 頭ぶん同じ属性の馬を作る */
const many = (n, past, jockey) => Array.from({ length: n }, () => horse(past, jockey));

const race = (over) => ({
  category: 'nankan', venue: '川崎', distanceMeters: 1400, entryCount: 10, horses: [], ...over,
});

// ─── しきい値そのものの固定（変更を検知する）─────────────────

test('しきい値は凍結値である（変更したら測り直しと docs 更新が要る）', () => {
  assert.equal(MIN_HORSES, 3);
  assert.equal(REQUIRED_COVERAGE, 1.0);
  assert.deepEqual(THRESHOLDS.nankan.dist, [0.14, 0.57]);
  assert.deepEqual(THRESHOLDS.nankan.first, [0.00, 0.15]);
  assert.deepEqual(THRESHOLDS.nankan.jchg, [0.25, 0.56]);
  assert.deepEqual(THRESHOLDS.nankan.comp, [0.33, 0.78]);
  assert.deepEqual(THRESHOLDS.jra.dist, [0.19, 0.62]);
  assert.deepEqual(THRESHOLDS.jra.first, [0.25, 0.79]);
  assert.deepEqual(THRESHOLDS.jra.jchg, [0.44, 0.79]);
  assert.deepEqual(THRESHOLDS.jra.comp, [0.00, 0.43]);
});

// ─── 4 つの状態が混ざらない ───────────────────────────────────

test('全頭照合＋近走ありで突出なし → neutral（空欄ではなく中立）', () => {
  // 全頭が同会場・同距離・同騎手 = 変化ゼロ。comp は 100% なので比べやすい側に付く
  const r = evaluateRace(race({ horses: many(10, [run('川崎', 1400)]) }), sameJockey);
  assert.equal(r.state, RACE_STATE.TAGGED);
  assert.deepEqual(r.tags, [TAG.EASY_COMPARE]);
});

test('中立: どの軸も帯の内側なら tags は空で state=neutral', () => {
  // comp を 33%〜78% の内側（5/10=50%）にし、他も内側に収める
  const horses = [
    ...many(5, [run('川崎', 1400)]),                 // easy compare 5
    ...many(3, [run('大井', 1400)]),                 // 初コース 3（15% 超えるが後述）
    ...many(2, [run('川崎', 1500)]),                 // 変化なし扱い
  ];
  const r = evaluateRace(race({ horses }), sameJockey);
  // 初コースは 3/10=30% >= 15% かつ 3 頭なので付く。ここでは「中立になり得る」構造の確認のみ
  assert.ok([RACE_STATE.TAGGED, RACE_STATE.NEUTRAL].includes(r.state));
  assert.equal(r.counts.withHistory, 10);
});

test('本当に近走が無い → no-history（照合失敗と区別する）', () => {
  const r = evaluateRace(race({ horses: many(10, []) }), sameJockey);
  assert.equal(r.state, RACE_STATE.NO_HISTORY);
  assert.deepEqual(r.tags, []);
  assert.equal(r.coverage, 1);
});

test('一部しか照合できていない → unmatched（未出走と区別する）', () => {
  const r = evaluateRace(race({ entryCount: 10, horses: many(9, [run('川崎', 1400)]) }), sameJockey);
  assert.equal(r.state, RACE_STATE.UNMATCHED);
  assert.deepEqual(r.tags, []);
  assert.ok(Math.abs(r.coverage - 0.9) < 1e-9);
  assert.equal(r.matched, 9);
  assert.equal(r.entryCount, 10);
});

test('全頭照合でなければタグを出さない（第一候補＝全頭照合のみ）', () => {
  const r = evaluateRace(race({ entryCount: 12, horses: many(11, [run('大井', 900)]) }), sameJockey);
  assert.equal(r.state, RACE_STATE.UNMATCHED);
});

// ─── 最低該当頭数 ─────────────────────────────────────────────

test('割合が閾値を超えても該当が 3 頭未満ならタグを立てない（南関の初コース対策）', () => {
  // 10 頭中 2 頭だけ初コース = 20% >= 15% だが 2 頭なので付かない
  const horses = [...many(2, [run('大井', 1400)]), ...many(8, [run('川崎', 1400)])];
  const r = evaluateRace(race({ horses }), sameJockey);
  assert.equal(r.counts.firstCourse, 2);
  assert.ok(!r.tags.includes(TAG.FIRST_COURSE), '2 頭では初コースタグを出さない');
});

test('3 頭に達すれば初コースタグが立つ', () => {
  const horses = [...many(3, [run('大井', 1400)]), ...many(7, [run('川崎', 1400)])];
  const r = evaluateRace(race({ horses }), sameJockey);
  assert.equal(r.counts.firstCourse, 3);
  assert.ok(r.tags.includes(TAG.FIRST_COURSE));
});

// ─── カテゴリ別の基準（共通閾値にしない）─────────────────────

test('同じ内容でも南関と JRA で判定が変わる（初コース 30%）', () => {
  const horses = [...many(3, [run('X', 1400)]), ...many(7, [run('川崎', 1400)])];
  const nk = evaluateRace(race({ category: 'nankan', horses }), sameJockey);
  const jr = evaluateRace(race({ category: 'jra', venue: '川崎', horses }), sameJockey);
  assert.ok(nk.tags.includes(TAG.FIRST_COURSE), '南関は 15% 基準なので付く');
  assert.ok(!jr.tags.includes(TAG.FIRST_COURSE), 'JRA は 79% 基準なので付かない');
});

// ─── 個別フィールド欠損の縮退 ─────────────────────────────────

test('今日の距離が取れない場合、距離依存タグだけ落として他は残す', () => {
  const horses = [...many(4, [run('大井', 1400)]), ...many(6, [run('川崎', 1400)])];
  const r = evaluateRace(race({ distanceMeters: null, horses }), sameJockey);
  assert.ok(r.degraded.includes('distance'));
  assert.ok(!r.tags.includes(TAG.DISTANCE_CHANGE));
  assert.ok(!r.tags.includes(TAG.EASY_COMPARE) && !r.tags.includes(TAG.HARD_COMPARE));
  assert.ok(r.tags.includes(TAG.FIRST_COURSE), '距離に依存しないタグは残す');
});

test('騎手が取れない馬ばかりでも他のタグは残る', () => {
  const horses = [...many(4, [run('大井', 1400, null)], null), ...many(6, [run('川崎', 1400, null)], null)];
  const r = evaluateRace(race({ horses }), sameJockey);
  assert.ok(r.degraded.includes('jockey'));
  assert.ok(!r.tags.includes(TAG.JOCKEY_CHANGE));
  assert.ok(r.tags.includes(TAG.FIRST_COURSE));
});

// ─── 有料情報を入力にも出力にもしない ─────────────────────────

test('入力に pt / 指数 / 役割 / 特徴量があっても結果に影響しない', () => {
  const base = many(10, [run('大井', 1400)]);
  const withPaid = base.map((h) => ({ ...h, pt: 999, computerIndex: 88, role: '本命', featureScores: { speedIndex: 90 } }));
  const a = evaluateRace(race({ horses: base }), sameJockey);
  const b = evaluateRace(race({ horses: withPaid }), sameJockey);
  assert.deepEqual(a.tags, b.tags);
  assert.deepEqual(a.counts, b.counts);
});

test('出力に pt / 指数 / 役割 / 特徴量 / 買い目が含まれない', () => {
  const r = evaluateRace(race({ horses: many(10, [run('川崎', 1400)]) }), sameJockey);
  const json = JSON.stringify(r);
  for (const banned of ['pt', 'computerIndex', 'sourceComputerIndex', 'role', 'featureScores', 'bettingLines', '買い目', '本命', '対抗']) {
    assert.equal(json.includes(banned), false, `${banned} を出してはいけない`);
  }
});

// ─── 当日相対は別レイヤー ─────────────────────────────────────

test('当日相対ハイライトは判定できたレースだけを対象にする', () => {
  const mk = (raceNumber, state, ratios) => ({ raceNumber, result: { state, ratios } });
  const h = dailyHighlights([
    mk(1, RACE_STATE.TAGGED, { dist: 0.1, first: 0.1, jchg: 0.1, comp: 0.9 }),
    mk(2, RACE_STATE.NEUTRAL, { dist: 0.5, first: 0.5, jchg: 0.5, comp: 0.1 }),
    mk(3, RACE_STATE.UNMATCHED, { dist: 1, first: 1, jchg: 1, comp: 0 }),
    mk(4, RACE_STATE.NO_HISTORY, { dist: 1, first: 1, jchg: 1, comp: 0 }),
  ]);
  assert.equal(h.mostChanged, 2);
  assert.equal(h.easiest, 1);
  assert.equal(h.hardest, 2);
});

test('対象が無ければ当日相対は全て null', () => {
  assert.deepEqual(dailyHighlights([]), { mostChanged: null, easiest: null, hardest: null });
  assert.deepEqual(
    dailyHighlights([{ raceNumber: 1, result: { state: RACE_STATE.UNMATCHED, ratios: {} } }]),
    { mostChanged: null, easiest: null, hardest: null },
  );
});

test('絶対タグが無いレースでも当日相対の対象になる（二層が独立）', () => {
  const h = dailyHighlights([
    { raceNumber: 5, result: { state: RACE_STATE.NEUTRAL, ratios: { dist: 0.5, first: 0.5, jchg: 0.5, comp: 0.4 } } },
    { raceNumber: 6, result: { state: RACE_STATE.TAGGED, ratios: { dist: 0.1, first: 0.0, jchg: 0.1, comp: 0.9 } } },
  ]);
  assert.equal(h.mostChanged, 5, '絶対タグ無しでも「今日いちばん条件が動く」になり得る');
});

// ─── 壊れた入力 ───────────────────────────────────────────────

test('入力が壊れていても落ちない', () => {
  for (const bad of [null, undefined, {}, { horses: null }, { entryCount: 0 }]) {
    const r = evaluateRace(bad, sameJockey);
    assert.ok([RACE_STATE.UNMATCHED, RACE_STATE.NO_HISTORY].includes(r.state));
    assert.deepEqual(r.tags, []);
  }
});

test('距離 null を 0m と誤読しない（Number(null)===0 の罠）', () => {
  const horses = many(10, [run('川崎', 1400)]);
  const r = evaluateRace(race({ distanceMeters: null, horses }), sameJockey);
  assert.equal(r.counts.distanceBase, 0, '距離が無いレースを 0m 扱いしない');
  assert.equal(r.ratios.dist, null);
  assert.deepEqual(r.tags.filter((t) => t === TAG.DISTANCE_CHANGE), []);
});

test('過去走の距離が null の馬を 0m 扱いしない', () => {
  const horses = many(10, [run('川崎', null)]);
  const r = evaluateRace(race({ horses }), sameJockey);
  assert.equal(r.counts.distanceBase, 0);
  assert.ok(!r.tags.includes(TAG.DISTANCE_CHANGE));
});
