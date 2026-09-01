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
  assert.ok(long.longLayoff, '2ヶ月以上は休養明け');
  assert.ok(long.label.startsWith('休養明け'));
});

test('2 つのチップは同じ基準を使う（休養明けラベルと休み明けチップが食い違わない）', () => {
  // ティントレットの前走間隔 70 日は、両方とも「長い休み」側で一致していること。
  const iv = calcInterval('2026-09-02', '2026-06-24');
  assert.equal(iv.days, 70);
  assert.equal(iv.label, '休養明け（中9週）');
  assert.ok(iv.longLayoff);
  assert.equal(calcLayoffRun('2026-09-02', TINTORETTO).kind, 'layoff');
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

// ─── 休み明け / 叩き◯戦目 ────────────────────────────────────

import { calcLayoffRun, LAYOFF_DAYS, CAMPAIGN_MAX_GAP_DAYS } from './memberExtras.js';

const at = (...ds) => ds.map((d) => ({ date: d }));

test('長い休みの直後は 休み明け', () => {
  const r = calcLayoffRun('2026-08-20', at('2026-04-01', '2026-03-01'));
  assert.equal(r.kind, 'layoff');
  assert.equal(r.nth, 1);
  assert.ok(r.gapDays >= LAYOFF_DAYS);
});

test('休み明けの次走は 叩き2戦目、その次は 叩き3戦目', () => {
  assert.equal(calcLayoffRun('2026-08-20', at('2026-08-01', '2026-04-01')).nth, 2);
  assert.equal(calcLayoffRun('2026-08-20', at('2026-08-01', '2026-07-01', '2026-03-01')).nth, 3);
  assert.equal(calcLayoffRun('2026-08-20', at('2026-08-01', '2026-07-01', '2026-03-01')).kind, 'run-after-layoff');
});

test('しきい値の境界（60 日 = 2ヶ月）で切り替わる', () => {
  assert.equal(LAYOFF_DAYS, 60, '休み明けの基準は 2ヶ月＝60 日');
  // 2026-06-22 = 59 日前（休みではない） / 2026-06-21 = 60 日前（休み）
  assert.equal(calcLayoffRun('2026-08-20', at('2026-06-22')), null, '59 日は休みではない');
  assert.equal(calcLayoffRun('2026-08-20', at('2026-06-21')).kind, 'layoff', '60 日は休み');
  assert.equal(calcLayoffRun('2026-08-20', at('2026-06-21')).gapDays, LAYOFF_DAYS);
});

// ─── 叩き◯戦目は「詰めて使った」ときだけ ───────────────────────

test('休み明け以降の間隔が 1 本でも空いていたら 叩き◯戦目 を出さない', () => {
  assert.equal(CAMPAIGN_MAX_GAP_DAYS, 42, '「続けて使った」と言える上限は中6週＝42 日');
  // 長い休み(90日) → 43 日空けて 1 走 → 今日。43 > 42 なので「叩き」ではない。
  assert.equal(calcLayoffRun('2026-08-20', at('2026-07-08', '2026-04-09')), null);
  // 42 日ちょうどなら叩き2戦目（境界は含む）
  const tight = calcLayoffRun('2026-08-20', at('2026-07-09', '2026-04-10'));
  assert.equal(tight.kind, 'run-after-layoff');
  assert.equal(tight.nth, 2);
});

test('休み明け直後（今日 ← 前走が長い）は間隔条件の対象外でそのまま出す', () => {
  // 前走までが 120 日空き。過去の間隔がどうであれ「休み明け」は出す。
  const r = calcLayoffRun('2026-08-20', at('2026-04-22', '2025-12-01'));
  assert.equal(r.kind, 'layoff');
  assert.equal(r.nth, 1);
});

// ─── 回帰: 2026-09-02 大井 11R ③ティントレット（実データ）─────────
//
// nankan/horseStats/2026/09/2026-09-02-OOI-R11.json の実日付。
// 旧実装（LAYOFF_DAYS=84・間隔を見ない）では「叩き3戦目」と表示されていた:
//   今日←前走 70日 / 前走←2走前 70日 / 2走前←3走前 91日 ← ここで成立して nth=3
// 前走から 70 日（中9週）空いており、正しくは「休み明け（復帰初戦）」。
const TINTORETTO = at(
  '2026-06-24', // 浦和 さきたま杯(JpnI) 4着   ← 今日から 70 日前
  '2026-04-15', // 大井 東京スプリント(JpnIII) 2着
  '2026-01-14', // 大井 ウインタースプリント 1着
  '2025-12-23', // 浦和 ゴールドカップ(SI) 12着
  '2025-09-23', // 浦和 オーバルスプリント(JpnIII) 5着
);

test('ティントレット（2026-09-02 大井11R③）は 休み明け であって 叩き3戦目 ではない', () => {
  const r = calcLayoffRun('2026-09-02', TINTORETTO);
  assert.equal(r.kind, 'layoff', '前走から 70 日＝2ヶ月以上なので休み明け');
  assert.equal(r.nth, 1, '復帰初戦＝叩き1戦目にあたる');
  assert.equal(r.gapDays, 70);
  assert.notEqual(r.kind, 'run-after-layoff', '「叩き◯戦目」を出してはいけない');
});

test('ティントレットは前走(6/24)の時点でも休み明けだった＝70日間隔のローテ馬', () => {
  // この馬を「叩き◯戦目」と呼べる局面がそもそも無いことを固定する。
  const r = calcLayoffRun('2026-06-24', at('2026-04-15', '2026-01-14', '2025-12-23', '2025-09-23'));
  assert.equal(r.kind, 'layoff');
  assert.equal(r.gapDays, 70);
});

test('休み明け以降に 43〜59 日の空きがあれば 叩き◯戦目 を出さない', () => {
  // 90日の休み → 50日空けて1走 → その20日後が今日。
  // 50 日は「休み」(60日)には届かないが「詰めて使った」(42日)とも言えない帯。
  // ここを塞がないと、閾値を下げるだけでは同型の誤表示が残る。
  assert.equal(calcLayoffRun('2026-08-20', at('2026-07-31', '2026-06-11', '2026-03-13')), null);
});

test('休み明け以降がすべて 42 日以内なら 叩き3戦目 を出す（正常系）', () => {
  // 90日の休み → 40日 → 20日 → 今日
  const r = calcLayoffRun('2026-08-20', at('2026-07-31', '2026-06-21', '2026-03-23'));
  assert.equal(r.kind, 'run-after-layoff');
  assert.equal(r.nth, 3);
  assert.equal(r.gapDays, 90);
});

test('持っている範囲に長い休みが無ければ null（休みではないと断定しない）', () => {
  assert.equal(calcLayoffRun('2026-08-20', at('2026-08-01', '2026-07-01', '2026-06-01')), null);
});

test('日付が欠けたらそこで打ち切って null（推測しない）', () => {
  assert.equal(calcLayoffRun('2026-08-20', at(null)), null);
  assert.equal(calcLayoffRun('2026-08-20', at('2026-08-01', null, '2026-01-01')), null);
  assert.equal(calcLayoffRun('2026-08-20', []), null);
  assert.equal(calcLayoffRun(null, at('2026-04-01')), null);
});

test('並びが壊れている（未来日）ときは判定しない', () => {
  assert.equal(calcLayoffRun('2026-08-20', at('2026-09-01')), null);
});

test('buildHorseExtras に layoffRun が含まれ、有料項目は混ざらない', () => {
  const e = buildHorseExtras({ past: at('2026-04-01', '2026-03-01') }, today);
  assert.ok(e.layoffRun, 'layoffRun が無い');
  assert.equal(e.layoffRun.kind, 'layoff');
  const json = JSON.stringify(e);
  for (const banned of ['pt', 'computerIndex', 'role', 'featureScores', 'bettingLines']) {
    assert.equal(json.includes(banned), false, `${banned} を出してはいけない`);
  }
});
