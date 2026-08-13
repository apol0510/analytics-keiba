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

// ══════════════════════════════════════════════════════════════
//  CTA の導線（クリック元）
//
//  0510apolone で既に記録されたクリックは**導線別計測より前**なので
//  「クリック元不明」になる。ダッシュボード経由だったと人間が知っていても、
//  データ上は dashboard へ書き換えない。
// ══════════════════════════════════════════════════════════════
import {
  FUNNEL_SOURCE, FUNNEL_SOURCE_ORDER, FUNNEL_SOURCE_LABEL,
  normalizeFunnelSource, shapeFunnelRow,
} from './premiumPlusFunnelStore.js';
import { summarizeFunnelBySource, countUnknownSource } from './premiumPlusFunnelAnalytics.js';

/** 導線内訳つきの実測セル */
const srcCell = (count, first, last, by) => ({ count, firstAtMs: first, lastAtMs: last, bySource: by });

test('【重要】allow-list 外の source は採らない（任意値を保存しない）', () => {
  assert.equal(normalizeFunnelSource('dashboard'), 'dashboard');
  assert.equal(normalizeFunnelSource('sanrenpuku'), 'sanrenpuku');
  assert.equal(normalizeFunnelSource(' DASHBOARD '), 'dashboard', '大小・空白は吸収する');
  for (const bad of ['', 'evil', 'admin', '../x', null, undefined, 42, {}, ['dashboard']]) {
    assert.equal(normalizeFunnelSource(bad), null, `採ってはいけない値: ${JSON.stringify(bad)}`);
  }
});

test('allow-list は 2 導線（画面もこの並びを使う）', () => {
  assert.deepEqual([...FUNNEL_SOURCE_ORDER], [FUNNEL_SOURCE.DASHBOARD, FUNNEL_SOURCE.SANRENPUKU]);
  assert.equal(FUNNEL_SOURCE_LABEL.dashboard, 'ダッシュボード');
  assert.equal(FUNNEL_SOURCE_LABEL.sanrenpuku, '三連複ページ');
  assert.equal(FUNNEL_SOURCE_LABEL.unknown, 'クリック元不明');
});

test('【重要】導線が無い既存データは全量「不明」（dashboard へ推測分類しない）', () => {
  // 0510apolone のクリック 1 回に相当（bySource が無い）
  const c = describeFunnelCell(shapeFunnelRow({ clicks: 1, click_first_at: T(1), click_last_at: T(1) }).click,
    { available: true });
  assert.equal(c.measured, true);
  assert.equal(c.count, 1);
  assert.deepEqual(c.sources, [], '推測で導線を作っている');
  assert.equal(c.unknownCount, 1);
  assert.equal(c.unknownLabel, 'クリック元不明');
});

test('内訳と合計の差が「不明」として残る（後方互換）', () => {
  const c = describeFunnelCell(
    srcCell(5, T(1), T(5), { dashboard: { firstAtMs: T(2), lastAtMs: T(4), count: 3 } }),
    { available: true });
  assert.equal(c.count, 5);
  assert.equal(c.sources.length, 1);
  assert.equal(c.sources[0].source, 'dashboard');
  assert.equal(c.sources[0].count, 3);
  assert.equal(c.unknownCount, 2, '合計 - 内訳 が不明として残っていない');
});

test('導線ごとの初回・最終を返す', () => {
  const c = describeFunnelCell(
    srcCell(2, T(1), T(4), { sanrenpuku: { firstAtMs: T(1), lastAtMs: T(4), count: 2 } }),
    { available: true });
  const s = c.sources[0];
  assert.equal(s.label, '三連複ページ');
  assert.match(s.firstAtJst, /^2026-08-13 \d{2}:\d{2}$/);
  assert.match(s.lastAtJst, /^2026-08-13 \d{2}:\d{2}$/);
});

test('【重要】不明は負にならない（内訳が合計を超えても壊さない）', () => {
  const c = describeFunnelCell(
    srcCell(1, T(1), T(1), { dashboard: { firstAtMs: T(1), lastAtMs: T(1), count: 9 } }),
    { available: true });
  assert.equal(c.unknownCount, 0);
});

test('allow-list 外の鍵は内訳から捨てる', () => {
  const shaped = shapeFunnelRow({
    cta_views: 3, cta_first_at: T(1), cta_last_at: T(3),
    cta_by_source: { dashboard: { firstAt: T(1), lastAt: T(2), count: 1 }, evil: { firstAt: T(1), lastAt: T(1), count: 2 } },
  });
  assert.deepEqual(Object.keys(shaped.cta.bySource), ['dashboard']);
});

test('未実測セルは内訳も空・不明も null（0 にしない）', () => {
  const c = describeFunnelCell(null, { available: true });
  assert.deepEqual(c.sources, []);
  assert.equal(c.unknownCount, null);
});

// ── 導線別の集計 ───────────────────────────────────────────
const withSrc = (over) => ({ available: true, cta: none, click: none, page: none, ...over });
const mCell = (count, by) => describeFunnelCell(srcCell(count, T(1), T(2), by), { available: true });

test('導線別の転換を人数で数える', () => {
  const rows = [
    { recordId: 'r1', realView: withSrc({
      cta: mCell(2, { dashboard: { firstAtMs: T(1), lastAtMs: T(2), count: 2 } }),
      click: mCell(1, { dashboard: { firstAtMs: T(2), lastAtMs: T(2), count: 1 } }),
      page: mCell(1, { dashboard: { firstAtMs: T(2), lastAtMs: T(2), count: 1 } }) }) },
    { recordId: 'r2', realView: withSrc({
      cta: mCell(1, { sanrenpuku: { firstAtMs: T(1), lastAtMs: T(1), count: 1 } }) }) },
  ];
  const by = summarizeFunnelBySource(rows);
  const dash = by.find((x) => x.source === 'dashboard');
  const srp = by.find((x) => x.source === 'sanrenpuku');
  assert.deepEqual([dash.viewed, dash.clicked, dash.reached], [1, 1, 1]);
  assert.deepEqual([srp.viewed, srp.clicked, srp.reached], [1, 0, 0]);
  assert.equal(dash.rates.viewToClick, 100);
  assert.equal(srp.rates.clickToReach, null, '分母 0 で 0% と書いている');
});

test('【重要】導線不明の記録はどの導線にも入れない', () => {
  const rows = [{ recordId: 'r1', realView: withSrc({ cta: mCell(3, {}) }) }];
  for (const s of summarizeFunnelBySource(rows)) {
    assert.equal(s.viewed, 0, `${s.source} に不明を混ぜている`);
  }
  const u = countUnknownSource(rows);
  assert.equal(u.cta, 1);
  assert.equal(u.label, 'クリック元不明');
});

test('読めなかった人は導線別にも数えない', () => {
  const rows = [{ recordId: 'r1', realView: { available: false } }];
  for (const s of summarizeFunnelBySource(rows)) assert.equal(s.viewed, 0);
  assert.equal(countUnknownSource(rows).cta, 0);
});

test('導線別の並びは allow-list の順', () => {
  assert.deepEqual(summarizeFunnelBySource([]).map((s) => s.source), [...FUNNEL_SOURCE_ORDER]);
});
