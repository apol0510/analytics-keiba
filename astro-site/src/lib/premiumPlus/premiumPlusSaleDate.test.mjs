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

test('締切は既存の受付締切と同じ 16:30', () => {
  assert.equal(SALE_CUTOVER_MIN, 16 * 60 + 30);
});

// ── 境界（ご指定の時刻）────────────────────────────────────────
test('【重要】12:29 は本日分', () => {
  const r = resolveSaleTarget(jst('2026-08-13 12:29'));
  assert.equal(r.date, '2026-08-13');
  assert.equal(r.isNextDay, false);
  assert.equal(r.target, SALE_TARGET.TODAY);
});

test('【重要】12:30 も本日分（販売開始であって切替ではない）', () => {
  const r = resolveSaleTarget(jst('2026-08-13 12:30'));
  assert.equal(r.date, '2026-08-13');
  assert.equal(r.isNextDay, false);
});

test('【重要】16:29 は本日分（切替の直前）', () => {
  const r = resolveSaleTarget(jst('2026-08-13 16:29'));
  assert.equal(r.date, '2026-08-13');
  assert.equal(r.isNextDay, false);
  assert.equal(r.intakeLabel, '本日分 受付中');
});

test('【重要】16:30 ちょうどで翌日分へ切り替わる', () => {
  const r = resolveSaleTarget(jst('2026-08-13 16:30'));
  assert.equal(r.date, '2026-08-14');
  assert.equal(r.isNextDay, true);
  assert.equal(r.target, SALE_TARGET.NEXT_DAY);
  assert.equal(r.intakeLabel, '翌日分 受付中');
  assert.equal(r.label, '8月14日分');
});

test('【重要】23:59 も翌日分（同じ日付のまま）', () => {
  const r = resolveSaleTarget(jst('2026-08-13 23:59'));
  assert.equal(r.date, '2026-08-14');
  assert.equal(r.isNextDay, true);
});

test('【重要】翌日 00:00 で「本日分」に戻り、日付は同じ 8/14 のまま', () => {
  const r = resolveSaleTarget(jst('2026-08-14 00:00'));
  assert.equal(r.date, '2026-08-14', '日付が飛んでいる');
  assert.equal(r.isNextDay, false, '日付は同じなのに翌日分のままになっている');
  assert.equal(r.intakeLabel, '本日分 受付中');
});

test('【重要】23:59 → 00:00 をまたいでも対象日は連続する', () => {
  const before = resolveSaleTarget(jst('2026-08-13 23:59'));
  const after = resolveSaleTarget(jst('2026-08-14 00:00'));
  assert.equal(before.date, after.date, '日付が飛んでいる（買った日と届く日がズレる）');
});

// ── JST の暦日 ────────────────────────────────────────────────
test('【重要】JST 00:00〜08:59 で UTC 基準の 1 日ズレを起こさない', () => {
  // UTC ではまだ 8/13 の時刻
  for (const hhmm of ['00:00', '01:23', '08:59']) {
    const r = resolveSaleTarget(jst(`2026-08-14 ${hhmm}`));
    assert.equal(r.date, '2026-08-14', `${hhmm} で日付がずれている`);
  }
});

test('【重要】月をまたぐ切替（8/31 16:30 → 9/1 分）', () => {
  const r = resolveSaleTarget(jst('2026-08-31 16:30'));
  assert.equal(r.date, '2026-09-01');
  assert.equal(r.label, '9月1日分');
});

test('【重要】年をまたぐ切替（12/31 16:30 → 1/1 分）', () => {
  const r = resolveSaleTarget(jst('2026-12-31 16:30'));
  assert.equal(r.date, '2027-01-01');
  assert.equal(r.label, '1月1日分');
});

test('うるう日をまたぐ切替（2/28 16:30 → 2/29 分・2028 年）', () => {
  const r = resolveSaleTarget(jst('2028-02-28 16:30'));
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
  const r = resolveSaleTarget(jst('2026-08-13 17:00'));
  assert.equal(r.label, '8月14日分');
  assert.equal(r.productLabel, '8月14日分 Premium Plus');
});

test('商品名に対象日が必ず入る（注文・メール・履歴が運ぶ）', () => {
  const r = resolveSaleTarget(jst('2026-08-13 17:00'));
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
  const v = verifySaleTarget('2026-08-13', now);
  assert.equal(v.match, false, 'ずれを検出できていない');
  assert.equal(v.server, '2026-08-14', 'サーバーが出し直した日付が違う');
});

test('一致していれば match', () => {
  const now = jst('2026-08-13 17:00');
  assert.equal(verifySaleTarget('2026-08-14', now).match, true);
});

test('壊れた値・欠落でもサーバーの日付は返る', () => {
  const now = jst('2026-08-13 17:00');
  for (const bad of [null, undefined, '', 'yesterday', '2026/08/14', 42]) {
    const v = verifySaleTarget(bad, now);
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
  assert.equal(resolveSaleTarget(jst('2026-08-13 16:30')).date,
    resolveSaleTarget(jst('2026-08-13 23:59')).date);
  // 00:00 に注文 → 16:29 に再送しても同じ 8/14 分
  assert.equal(resolveSaleTarget(jst('2026-08-14 00:00')).date,
    resolveSaleTarget(jst('2026-08-14 16:29')).date);
});

// ── 部品 ──────────────────────────────────────────────────────
test('jstParts / formatJstDate', () => {
  const p = jstParts(jst('2026-08-13 16:30'));
  assert.deepEqual([p.y, p.m, p.d], [2026, 8, 13]);
  assert.equal(p.minutes, 16 * 60 + 30);
  assert.equal(formatJstDate(p), '2026-08-13');
  assert.equal(formatJstDate(null), null);
});
