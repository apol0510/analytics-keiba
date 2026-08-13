/**
 * premiumPlusSaleDate.test.mjs — 「いま何日分を売っているか」を固定する
 *   node --test src/lib/premiumPlus/premiumPlusSaleDate.test.mjs
 *
 * 16:30 を境に本日分 → 翌日分へ切り替わる。**JST の暦日**で計算し、
 * UTC 基準で日付を作らない（JST 00:00〜08:59 は UTC ではまだ前日で 1 日ずれる）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SALE_CUTOVER_MIN, SALE_TARGET,
  resolveSaleTarget, buildSaleProductName, verifySaleTarget, jstParts, formatJstDate,
} from './premiumPlusSaleDate.js';

/** JST の 'YYYY-MM-DD HH:MM' → ミリ秒 */
const jst = (s) => Date.parse(`${s.replace(' ', 'T')}:00+09:00`);

/**
 * 時刻の境界テストは「開催があるか」とは**別の軸**。
 * すべての日を開催日とみなすカレンダーを使い、時刻の切替だけを見る。
 */
/** 全日開催として判定させるための ctx（knownRaceDates を都度作る） */
const anyDay = (ms) => ({ knownRaceDates: [
  fmt(ms), fmt(ms + 86400000), fmt(ms + 2 * 86400000),
] });
const fmt = (ms) => {
  const d = new Date(ms + 9 * 3600000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
};

test('締切は既存の受付締切と同じ 16:30', () => {
  assert.equal(SALE_CUTOVER_MIN, 16 * 60 + 30);
});

// ── 境界（ご指定の時刻）────────────────────────────────────────
test('【重要】12:29 は本日分', () => {
  const r = resolveSaleTarget(jst('2026-08-13 12:29'), anyDay(jst('2026-08-13 12:29')));
  assert.equal(r.date, '2026-08-13');
  assert.equal(r.isNextDay, false);
  assert.equal(r.target, SALE_TARGET.TODAY);
});

test('【重要】12:30 も本日分（販売開始であって切替ではない）', () => {
  const r = resolveSaleTarget(jst('2026-08-13 12:30'), anyDay(jst('2026-08-13 12:30')));
  assert.equal(r.date, '2026-08-13');
  assert.equal(r.isNextDay, false);
});

test('【重要】16:29 は本日分（切替の直前）', () => {
  const r = resolveSaleTarget(jst('2026-08-13 16:29'), anyDay(jst('2026-08-13 16:29')));
  assert.equal(r.date, '2026-08-13');
  assert.equal(r.isNextDay, false);
  assert.equal(r.intakeLabel, '本日分 受付中');
});

test('【重要】16:30 ちょうどで翌日分へ切り替わる', () => {
  const r = resolveSaleTarget(jst('2026-08-13 16:30'), anyDay(jst('2026-08-13 16:30')));
  assert.equal(r.date, '2026-08-14');
  assert.equal(r.isNextDay, true);
  assert.equal(r.target, SALE_TARGET.NEXT_DAY);
  assert.equal(r.intakeLabel, '翌日分 受付中');
  assert.equal(r.label, '8月14日分');
});

test('【重要】23:59 も翌日分（同じ日付のまま）', () => {
  const r = resolveSaleTarget(jst('2026-08-13 23:59'), anyDay(jst('2026-08-13 23:59')));
  assert.equal(r.date, '2026-08-14');
  assert.equal(r.isNextDay, true);
});

test('【重要】翌日 00:00 で「本日分」に戻り、日付は同じ 8/14 のまま', () => {
  const r = resolveSaleTarget(jst('2026-08-14 00:00'), anyDay(jst('2026-08-14 00:00')));
  assert.equal(r.date, '2026-08-14', '日付が飛んでいる');
  assert.equal(r.isNextDay, false, '日付は同じなのに翌日分のままになっている');
  assert.equal(r.intakeLabel, '本日分 受付中');
});

test('【重要】23:59 → 00:00 をまたいでも対象日は連続する', () => {
  const before = resolveSaleTarget(jst('2026-08-13 23:59'), anyDay(jst('2026-08-13 23:59')));
  const after = resolveSaleTarget(jst('2026-08-14 00:00'), anyDay(jst('2026-08-14 00:00')));
  assert.equal(before.date, after.date, '日付が飛んでいる（買った日と届く日がズレる）');
});

// ── JST の暦日 ────────────────────────────────────────────────
test('【重要】JST 00:00〜08:59 で UTC 基準の 1 日ズレを起こさない', () => {
  // UTC ではまだ 8/13 の時刻
  for (const hhmm of ['00:00', '01:23', '08:59']) {
    const r = resolveSaleTarget(jst(`2026-08-14 ${hhmm}`), anyDay(jst(`2026-08-14 ${hhmm}`)));
    assert.equal(r.date, '2026-08-14', `${hhmm} で日付がずれている`);
  }
});

test('【重要】月をまたぐ切替（8/31 16:30 → 9/1 分）', () => {
  const r = resolveSaleTarget(jst('2026-08-31 16:30'), anyDay(jst('2026-08-31 16:30')));
  assert.equal(r.date, '2026-09-01');
  assert.equal(r.label, '9月1日分');
});

test('【重要】年をまたぐ切替（12/31 16:30 → 1/1 分）', () => {
  const r = resolveSaleTarget(jst('2026-12-31 16:30'), anyDay(jst('2026-12-31 16:30')));
  assert.equal(r.date, '2027-01-01');
  assert.equal(r.label, '1月1日分');
});

test('うるう日をまたぐ切替（2/28 16:30 → 2/29 分・2028 年）', () => {
  const r = resolveSaleTarget(jst('2028-02-28 16:30'), anyDay(jst('2028-02-28 16:30')));
  assert.equal(r.date, '2028-02-29');
});

test('時刻が読めなければ売らない側へ倒す', () => {
  for (const bad of [NaN, null, undefined, 'x']) {
    const r = resolveSaleTarget(bad);
    assert.equal(r.ok, false);
    assert.equal(r.date, null);
  }
});

// ── 表示 ──────────────────────────────────────────────────────
test('対象日を表示ラベルに出す', () => {
  const r = resolveSaleTarget(jst('2026-08-13 17:00'), anyDay(jst('2026-08-13 17:00')));
  assert.equal(r.label, '8月14日分');
  assert.equal(r.productLabel, '8月14日分 Premium Plus');
});

test('商品名に対象日が必ず入る（注文・メール・履歴が運ぶ）', () => {
  const r = resolveSaleTarget(jst('2026-08-13 17:00'), anyDay(jst('2026-08-13 17:00')));
  const name = buildSaleProductName(r.label, 68000);
  assert.match(name, /8月14日分/);
  assert.match(name, /¥68,000/);
  assert.match(name, /Premium Plus/);
});

test('ラベルが無くても商品名は壊れない', () => {
  assert.match(buildSaleProductName('', 68000), /Premium Plus/);
  assert.match(buildSaleProductName('', 68000), /¥68,000/);
});

// ── 注文時の検証（クライアントを信用しない）──────────────────
test('【重要】クライアントの対象日をそのまま採用しない', () => {
  const now = jst('2026-08-13 17:00');
  // 画面を開いたまま 16:30 をまたいだ客が古い日付を送ってくる
  const v = verifySaleTarget('2026-08-13', now, anyDay(now));
  assert.equal(v.match, false, 'ずれを検出できていない');
  assert.equal(v.server, '2026-08-14', 'サーバーが出し直した日付が違う');
});

test('一致していれば match', () => {
  const now = jst('2026-08-13 17:00');
  assert.equal(verifySaleTarget('2026-08-14', now, anyDay(now)).match, true);
});

test('壊れた値・欠落でもサーバーの日付は返る', () => {
  const now = jst('2026-08-13 17:00');
  for (const bad of [null, undefined, '', 'yesterday', '2026/08/14', 42]) {
    const v = verifySaleTarget(bad, now, anyDay(now));
    assert.equal(v.match, false);
    assert.equal(v.server, '2026-08-14');
    assert.equal(v.claimed, null);
  }
});

// ── 決済再送・再読込で対象日が変わらない ──────────────────────
test('【重要】同じ時刻なら何度呼んでも同じ対象日（再送・再読込で変わらない）', () => {
  const now = jst('2026-08-13 17:05');
  const a = resolveSaleTarget(now);
  const b = resolveSaleTarget(now);
  const c = resolveSaleTarget(now);
  assert.equal(a.date, b.date);
  assert.equal(b.date, c.date);
  assert.equal(a.label, c.label);
});

test('【重要】同じ受付枠の中では時刻が進んでも対象日が変わらない', () => {
  // 16:30 に注文 → 23:59 に再送しても同じ 8/14 分
  assert.equal(resolveSaleTarget(jst('2026-08-13 16:30'), anyDay(jst('2026-08-13 16:30'))).date,
    resolveSaleTarget(jst('2026-08-13 23:59'), anyDay(jst('2026-08-13 23:59'))).date);
  // 00:00 に注文 → 16:29 に再送しても同じ 8/14 分
  assert.equal(resolveSaleTarget(jst('2026-08-14 00:00'), anyDay(jst('2026-08-14 00:00'))).date,
    resolveSaleTarget(jst('2026-08-14 16:29'), anyDay(jst('2026-08-14 16:29'))).date);
});

// ── 部品 ──────────────────────────────────────────────────────
test('jstParts / formatJstDate', () => {
  const p = jstParts(jst('2026-08-13 16:30'));
  assert.deepEqual([p.y, p.m, p.d], [2026, 8, 13]);
  assert.equal(p.minutes, 16 * 60 + 30);
  assert.equal(formatJstDate(p), '2026-08-13');
  assert.equal(formatJstDate(null), null);
});

// ══════════════════════════════════════════════════════════════
//  開催 — 既定は「ある」。例外日だけ次の販売日へ送る
//
//  平日は南関、週末は中央があり、中央・南関とも開催が無い日は年 1〜3 日。
//  そこで allow-list ではなく **例外リスト**にし、
//  **取込が無くても販売は止めない**。
// ══════════════════════════════════════════════════════════════
import {
  RACE_DAY, CIRCUIT, checkRaceDay, findNextRaceDay, addDays,
  shapeRaceCalendar, circuitForDate, checkCalendarFreshness,
} from './premiumPlusRaceCalendar.js';
import { resolveOrderSaleDate } from './premiumPlusSaleDate.js';

/** 中央・南関とも開催が無い例外日 */
const CAL = { noRaceDates: ['2026-08-15'], checkedUntil: '2026-09-30' };

test('【重要】例外リストが空でも通常販売を続ける', () => {
  const r = resolveSaleTarget(jst('2026-08-13 17:00'));
  assert.equal(r.sellable, true, '取込が無いだけで販売が止まっている');
  assert.equal(r.date, '2026-08-14');
});

test('【重要】確認期限を過ぎていても販売は止めない', () => {
  const old = { noRaceDates: [], checkedUntil: '2026-01-01' };
  const r = resolveSaleTarget(jst('2026-08-13 17:00'), { calendar: old });
  assert.equal(r.sellable, true, '期限切れで販売が止まっている');
  assert.equal(r.date, '2026-08-14');
});

test('【重要】2026-08-13 16:29 の申込は 2026-08-13 分', () => {
  const r = resolveSaleTarget(jst('2026-08-13 16:29'), { calendar: CAL });
  assert.equal(r.date, '2026-08-13');
  assert.equal(r.isNextDay, false);
  assert.equal(r.label, '8月13日分');
});

test('【重要】2026-08-13 16:30 の申込は 2026-08-14 分（8/14 は開催日）', () => {
  const r = resolveSaleTarget(jst('2026-08-13 16:30'), { calendar: CAL });
  assert.equal(r.date, '2026-08-14');
  assert.equal(r.isNextDay, true);
  assert.equal(r.shifted, false, '開催日なのに送っている');
});

test('【重要】翌日が例外日なら次の販売日分へ送る', () => {
  // 8/14 16:30 → 素の対象日は 8/15（例外日）→ 8/16
  const r = resolveSaleTarget(jst('2026-08-14 16:30'), { calendar: CAL });
  assert.equal(r.baseDate, '2026-08-15');
  assert.equal(r.date, '2026-08-16');
  assert.equal(r.shifted, true);
  assert.equal(r.sellable, true);
});

test('例外日が連続していても次の販売日を見つける', () => {
  const cal = { noRaceDates: ['2026-08-15', '2026-08-16'], checkedUntil: '2026-09-30' };
  const r = resolveSaleTarget(jst('2026-08-14 16:30'), { calendar: cal });
  assert.equal(r.date, '2026-08-17');
});

// ── 開催区分（平日=南関 / 週末=中央）────────────────────────────
test('【重要】平日は南関・週末は中央として扱う', () => {
  assert.equal(circuitForDate('2026-08-13'), CIRCUIT.NANKAN, '木曜が南関でない');
  assert.equal(circuitForDate('2026-08-14'), CIRCUIT.NANKAN, '金曜が南関でない');
  assert.equal(circuitForDate('2026-08-15'), CIRCUIT.CHUO, '土曜が中央でない');
  assert.equal(circuitForDate('2026-08-16'), CIRCUIT.CHUO, '日曜が中央でない');
  assert.equal(circuitForDate('2026-08-17'), CIRCUIT.NANKAN, '月曜が南関でない');
  assert.equal(circuitForDate('bad'), null);
});

test('対象日に開催区分のラベルが付く（画面・管理画面が使う）', () => {
  // ⚠️ 曜日から導いた**目安**であって実際の開催場ではない。
  //    「南関」「中央」と言い切らず、必ず「基本：」を付ける。
  assert.equal(resolveSaleTarget(jst('2026-08-13 12:00')).circuitLabel, '基本：南関');
  assert.equal(resolveSaleTarget(jst('2026-08-15 12:00')).circuitLabel, '基本：中央');
});

test('【重要】開催区分ラベルは開催場を断定しない（必ず「基本：」を付ける）', () => {
  for (const day of ['2026-08-13 12:00', '2026-08-15 12:00']) {
    const label = resolveSaleTarget(jst(day)).circuitLabel;
    assert.ok(label.startsWith('基本：'), `開催場を断定している: ${label}`);
  }
});

// ── 判定の部品 ──────────────────────────────────────────────
test('checkRaceDay は既定で開催あり', () => {
  assert.equal(checkRaceDay('2026-08-14', { calendar: CAL }).code, RACE_DAY.OPEN);
  assert.equal(checkRaceDay('2026-08-15', { calendar: CAL }).code, RACE_DAY.NO_RACE);
  assert.equal(checkRaceDay('2026-12-01', { calendar: CAL }).code, RACE_DAY.OPEN, '未確認の日を非開催にしている');
  assert.equal(checkRaceDay('2026-08-14', {}).code, RACE_DAY.OPEN, 'カレンダー無しで非開催にしている');
  assert.equal(checkRaceDay('bad', {}).code, RACE_DAY.BAD_DATE);
});

test('findNextRaceDay は例外日を飛ばす', () => {
  const r = findNextRaceDay('2026-08-15', { calendar: CAL });
  assert.equal(r.date, '2026-08-16');
});

test('addDays は月・年をまたいでも正しい', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-02-28', 1), '2028-02-29');
  assert.equal(addDays('bad', 1), null);
});

test('壊れたカレンダーでも例外を投げず、販売を止めない', () => {
  for (const bad of [null, undefined, {}, { noRaceDates: 'x' }, { noRaceDates: [1, 2] }]) {
    const c = shapeRaceCalendar(bad);
    assert.equal(c.size, 0);
    assert.equal(checkRaceDay('2026-08-14', { calendar: c }).code, RACE_DAY.OPEN);
  }
});

// ── 確認期限の警告（販売は止めない）──────────────────────────
test('【重要】確認期限切れは警告するが販売は止めない', () => {
  const f = checkCalendarFreshness({ calendar: { noRaceDates: [], checkedUntil: '2026-01-01' }, nowDate: '2026-08-14' });
  assert.equal(f.stale, true);
  assert.match(f.note, /販売は続きます/);
});

test('確認期限が近いと予告する', () => {
  const f = checkCalendarFreshness({ calendar: { noRaceDates: [], checkedUntil: '2026-08-20' }, nowDate: '2026-08-14' });
  assert.equal(f.stale, false);
  assert.equal(f.expiringSoon, true);
});

test('期限内なら警告しない', () => {
  const f = checkCalendarFreshness({ calendar: { noRaceDates: [], checkedUntil: '2026-12-31' }, nowDate: '2026-08-14' });
  assert.equal(f.stale, false);
  assert.equal(f.expiringSoon, false);
});

test('確認記録が無ければ stale として警告する', () => {
  const f = checkCalendarFreshness({ calendar: { noRaceDates: [] }, nowDate: '2026-08-14' });
  assert.equal(f.stale, true);
});

// ══════════════════════════════════════════════════════════════
//  冪等 — 一度確定した対象日は再計算しない
// ══════════════════════════════════════════════════════════════
test('【重要】初回申込で確定した対象日を再送で変えない', () => {
  const first = resolveOrderSaleDate({ nowMs: jst('2026-08-13 17:00'), calendar: CAL });
  assert.equal(first.date, '2026-08-14');
  assert.equal(first.reused, false);
  // 翌日以降に再実行しても変わらない
  const resend = resolveOrderSaleDate({
    storedDate: first.date, nowMs: jst('2026-08-16 18:00'), calendar: CAL,
  });
  assert.equal(resend.date, '2026-08-14', '再実行で対象日が動いている');
  assert.equal(resend.reused, true);
});

test('【重要】16:29 に確定した対象日は 16:30 の再送でも変わらない', () => {
  const first = resolveOrderSaleDate({ nowMs: jst('2026-08-14 16:29'), calendar: CAL });
  assert.equal(first.date, '2026-08-14', '本日分で確定していない');
  const resend = resolveOrderSaleDate({
    storedDate: first.date, nowMs: jst('2026-08-14 16:30'), calendar: CAL,
  });
  assert.equal(resend.date, '2026-08-14', '16:30 をまたいで対象日が翌日へ動いた');
  assert.equal(resend.reused, true);
});

test('【重要】23:59 に確定した対象日は翌 0:00 の再送でも変わらない', () => {
  const first = resolveOrderSaleDate({ nowMs: jst('2026-08-13 23:59'), calendar: CAL });
  assert.equal(first.date, '2026-08-14');
  const resend = resolveOrderSaleDate({
    storedDate: first.date, nowMs: jst('2026-08-14 00:00'), calendar: CAL,
  });
  assert.equal(resend.date, '2026-08-14');
  assert.equal(resend.reused, true);
});

test('【重要】翌日 16:30 以降に再実行しても対象日が動かない', () => {
  const first = resolveOrderSaleDate({ nowMs: jst('2026-08-13 17:00'), calendar: CAL });
  const resend = resolveOrderSaleDate({
    storedDate: first.date, nowMs: jst('2026-08-14 16:30'), calendar: CAL,
  });
  assert.equal(resend.date, '2026-08-14', '翌日の切替で対象日が動いた');
});

test('【重要】確定後はカレンダーが変わっても対象日を変えない', () => {
  const changed = { dates: ['2026-08-20'], coversUntil: '2026-09-30' };
  const r = resolveOrderSaleDate({ storedDate: '2026-08-14', nowMs: jst('2026-08-18 12:00'), calendar: changed });
  assert.equal(r.date, '2026-08-14', '客に約束した日を後から書き換えている');
  assert.equal(r.sellable, true);
});

test('保存値が壊れていれば計算し直す（不正な日付を採用しない）', () => {
  for (const bad of ['', 'x', '2026/08/14', null]) {
    const r = resolveOrderSaleDate({ storedDate: bad, nowMs: jst('2026-08-13 17:00'), calendar: CAL });
    assert.equal(r.reused, false);
    assert.equal(r.date, '2026-08-14');
  }
});

test('カレンダー未取込でも注文は成立する（販売を止めない）', () => {
  const r = resolveOrderSaleDate({ nowMs: jst('2026-08-13 17:00') });
  assert.equal(r.sellable, true);
  assert.equal(r.date, '2026-08-14');
});
