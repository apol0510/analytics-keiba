/**
 * premiumPlusFunnelAnalytics.test.mjs — 実閲覧の段階・並び順・転換率を固定する
 *   node --test src/lib/premiumPlus/premiumPlusFunnelAnalytics.test.mjs
 *
 * ここで守る一線は 1 つ。**「記録が無い」を「0 回・未表示」と言い換えない。**
 * 記録が無い理由には「計測開始より前」「Redis を読めない」も含まれ、どれも確認不能。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  FUNNEL_STAGE,
  FUNNEL_STAGE_LABEL,
  FUNNEL_STAGE_ORDER,
  resolveFunnelStage,
  lastReactionAtMs,
  isNewReaction,
  summarizeFunnel,
  sortByLastReaction,
  filterByStage,
} from './premiumPlusFunnelAnalytics.js';
import { describeFunnelRow, describeFunnelCell } from './premiumPlusFunnelStore.js';

const T = (h) => Date.parse(`2026-08-13T0${h}:00:00Z`);
/** 実測セル */
const cell = (count, first, last) => ({ measured: true, count, firstAtMs: first, lastAtMs: last });
/** 未実測セル */
const none = { measured: false, count: null, firstAtMs: null, lastAtMs: null };
const view = (over = {}) => ({ available: true, cta: none, click: none, page: none, ...over });

// ── 段階 ──────────────────────────────────────────────────────
test('記録が無ければ「未確認」（未表示ではない）', () => {
  const r = resolveFunnelStage(view());
  assert.equal(r.stage, FUNNEL_STAGE.UNKNOWN);
  assert.equal(r.label, '未確認');
});

test('読めなかったときも「未確認」', () => {
  assert.equal(resolveFunnelStage({ available: false }).stage, FUNNEL_STAGE.UNKNOWN);
  assert.equal(resolveFunnelStage(null).stage, FUNNEL_STAGE.UNKNOWN);
});

test('表示のみ → 表示済み・未クリック', () => {
  assert.equal(resolveFunnelStage(view({ cta: cell(1, T(1), T(1)) })).stage, FUNNEL_STAGE.VIEWED_NOT_CLICKED);
});

test('クリックまで → クリック済み・未到達', () => {
  const v = view({ cta: cell(1, T(1), T(1)), click: cell(1, T(2), T(2)) });
  assert.equal(resolveFunnelStage(v).stage, FUNNEL_STAGE.CLICKED_NOT_REACHED);
});

test('商品ページ到達 → 到達済み（先の段階を優先）', () => {
  const v = view({ cta: cell(1, T(1), T(1)), click: cell(1, T(2), T(2)), page: cell(1, T(3), T(3)) });
  assert.equal(resolveFunnelStage(v).stage, FUNNEL_STAGE.REACHED);
});

test('【重要】表示記録が無くてもクリックがあれば「押した」を優先する', () => {
  // 表示は IntersectionObserver 由来なので落ちることがある。
  // そこで unknown に倒すと「押したのに未確認」という誤表示になる。
  assert.equal(resolveFunnelStage(view({ click: cell(1, T(2), T(2)) })).stage, FUNNEL_STAGE.CLICKED_NOT_REACHED);
  assert.equal(resolveFunnelStage(view({ page: cell(1, T(3), T(3)) })).stage, FUNNEL_STAGE.REACHED);
});

test('全段階にラベルがあり、絞り込みの並びに未確認が含まれる', () => {
  for (const s of Object.values(FUNNEL_STAGE)) {
    assert.ok(FUNNEL_STAGE_LABEL[s], `${s} のラベルが無い`);
  }
  assert.equal(FUNNEL_STAGE_ORDER.length, 4);
  assert.equal(FUNNEL_STAGE_ORDER[FUNNEL_STAGE_ORDER.length - 1], FUNNEL_STAGE.UNKNOWN, '未確認は最後');
});

// ── 最終反応 ───────────────────────────────────────────────────
test('最終反応は 3 種別のうち最も新しい時刻', () => {
  const v = view({ cta: cell(2, T(1), T(2)), click: cell(1, T(3), T(3)), page: cell(1, T(1), T(1)) });
  assert.equal(lastReactionAtMs(v), T(3));
});

test('記録が無ければ最終反応は null（0 ではない）', () => {
  assert.equal(lastReactionAtMs(view()), null);
  assert.equal(lastReactionAtMs({ available: false }), null);
});

test('【重要】基準時刻が無いとき全員を新規反応にしない', () => {
  const v = view({ cta: cell(1, T(1), T(5)) });
  assert.equal(isNewReaction(v, null), false);
  assert.equal(isNewReaction(v, undefined), false);
  assert.equal(isNewReaction(v, NaN), false);
});

test('基準より後の反応だけを新規とする', () => {
  const v = view({ cta: cell(1, T(1), T(5)) });
  assert.equal(isNewReaction(v, T(4)), true);
  assert.equal(isNewReaction(v, T(5)), false, '同時刻は新規にしない');
  assert.equal(isNewReaction(v, T(6)), false);
});

test('記録が無い人は新規反応にならない', () => {
  assert.equal(isNewReaction(view(), T(1)), false);
});

// ── 転換率 ────────────────────────────────────────────────────
test('人数は累積で数える（到達者は表示・クリックにも数える）', () => {
  const rows = [
    { recordId: 'r1', realView: view({ cta: cell(1, T(1), T(1)) }) },
    { recordId: 'r2', realView: view({ cta: cell(1, T(1), T(1)), click: cell(1, T(2), T(2)) }) },
    { recordId: 'r3', realView: view({ cta: cell(1, T(1), T(1)), click: cell(1, T(2), T(2)), page: cell(1, T(3), T(3)) }) },
    { recordId: 'r4', realView: view() },
  ];
  const s = summarizeFunnel(rows);
  assert.equal(s.total, 4);
  assert.equal(s.viewed, 3);
  assert.equal(s.clicked, 2);
  assert.equal(s.reached, 1);
  assert.equal(s.unknown, 1);
  assert.equal(s.rates.viewToClick, 66.7);
  assert.equal(s.rates.clickToReach, 50);
  assert.equal(s.rates.viewToReach, 33.3);
});

test('【重要】分母が 0 のとき率は null（0% と書かない）', () => {
  const s = summarizeFunnel([{ recordId: 'r1', realView: view() }]);
  assert.equal(s.viewed, 0);
  assert.equal(s.rates.viewToClick, null);
  assert.equal(s.rates.clickToReach, null);
  assert.equal(s.rates.viewToReach, null);
});

test('【重要】1 人でも読めなければ available=false にして注記を変える', () => {
  const s = summarizeFunnel([
    { recordId: 'r1', realView: view({ cta: cell(1, T(1), T(1)) }) },
    { recordId: 'r2', realView: { available: false } },
  ]);
  assert.equal(s.available, false);
  assert.equal(s.unknown, 1);
  assert.match(s.note, /0 回という意味ではありません/);
});

test('空配列でも壊れない', () => {
  const s = summarizeFunnel([]);
  assert.equal(s.total, 0);
  assert.equal(s.rates.viewToClick, null);
});

// ── 並べ替え・絞り込み ─────────────────────────────────────────
test('反応が新しい順。記録が無い人は必ず後ろ', () => {
  const rows = [
    { recordId: 'a', realView: view() },
    { recordId: 'b', realView: view({ cta: cell(1, T(1), T(1)) }) },
    { recordId: 'c', realView: view({ click: cell(1, T(3), T(3)) }) },
  ];
  assert.deepEqual(sortByLastReaction(rows).map((r) => r.recordId), ['c', 'b', 'a']);
});

test('並べ替えは元配列を壊さない', () => {
  const rows = [{ recordId: 'a', realView: view() }, { recordId: 'b', realView: view({ cta: cell(1, T(1), T(2)) }) }];
  const before = rows.map((r) => r.recordId);
  sortByLastReaction(rows);
  assert.deepEqual(rows.map((r) => r.recordId), before);
});

test('段階で絞り込める', () => {
  const rows = [
    { recordId: 'a', realView: view({ cta: cell(1, T(1), T(1)) }) },
    { recordId: 'b', realView: view({ click: cell(1, T(2), T(2)) }) },
    { recordId: 'c', realView: view({ page: cell(1, T(3), T(3)) }) },
    { recordId: 'd', realView: view() },
  ];
  assert.deepEqual(filterByStage(rows, FUNNEL_STAGE.VIEWED_NOT_CLICKED).map((r) => r.recordId), ['a']);
  assert.deepEqual(filterByStage(rows, FUNNEL_STAGE.CLICKED_NOT_REACHED).map((r) => r.recordId), ['b']);
  assert.deepEqual(filterByStage(rows, FUNNEL_STAGE.REACHED).map((r) => r.recordId), ['c']);
  assert.deepEqual(filterByStage(rows, FUNNEL_STAGE.UNKNOWN).map((r) => r.recordId), ['d']);
});

test('【重要】未知の絞り込み値では人を隠さない', () => {
  const rows = [{ recordId: 'a', realView: view() }, { recordId: 'b', realView: view() }];
  assert.equal(filterByStage(rows, 'nonexistent').length, 2);
  assert.equal(filterByStage(rows, '').length, 2);
  assert.equal(filterByStage(rows, null).length, 2);
});

// ── store 側が構造化された値を返すこと ──────────────────────────
test('実測セルは初回・最終・回数を構造化して返す', () => {
  const c = describeFunnelCell({ count: 3, firstAtMs: T(1), lastAtMs: T(4) }, { available: true });
  assert.equal(c.measured, true);
  assert.equal(c.count, 3);
  assert.equal(c.firstAtMs, T(1));
  assert.equal(c.lastAtMs, T(4));
  assert.match(c.firstAtJst, /^2026-08-13 \d{2}:\d{2}$/);
  assert.match(c.lastAtJst, /^2026-08-13 \d{2}:\d{2}$/);
});

test('【重要】未実測セルの count は null（0 にしない）', () => {
  for (const ctx of [{ available: true }, { available: false }]) {
    const c = describeFunnelCell(null, ctx);
    assert.equal(c.measured, false);
    assert.equal(c.count, null, '未実測を 0 回にしている');
    assert.equal(c.firstAtJst, null);
    assert.equal(c.lastAtJst, null);
  }
});

test('describeFunnelRow から段階を解決できる（実配線と同じ流れ）', () => {
  const row = describeFunnelRow(
    { cta: { count: 1, firstAtMs: T(1), lastAtMs: T(1) }, click: { count: 1, firstAtMs: T(2), lastAtMs: T(2) }, page: { count: null } },
    { available: true, startedAtMs: T(0) },
  );
  assert.equal(resolveFunnelStage(row).stage, FUNNEL_STAGE.CLICKED_NOT_REACHED);
  assert.equal(lastReactionAtMs(row), T(2));
});

// ── 個人情報を増やさない ───────────────────────────────────────
test('【重要】このモジュールはアドレス・氏名を扱わない', () => {
  const src = readFileSync(new URL('./premiumPlusFunnelAnalytics.js', import.meta.url), 'utf8');
  for (const bad of ['email', 'Email', '氏名', 'name']) {
    assert.ok(!new RegExp(`\\b${bad}\\b`).test(src.replace(/\/\*[\s\S]*?\*\//g, '')),
      `個人情報を触っている: ${bad}`);
  }
});

test('【重要】戻り値に recordId 以外の識別子を載せない', () => {
  const rows = [{ recordId: 'recAAAAAAAAAAAAAA', email: 'x@example.com', realView: view({ cta: cell(1, T(1), T(1)) }) }];
  const s = summarizeFunnel(rows);
  assert.ok(!JSON.stringify(s).includes('example.com'), '集計にアドレスが混ざっている');
});
