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
  FUNNEL_SOURCE_KIND, FUNNEL_SOURCE_KIND_OF, FUNNEL_SOURCE_KIND_LABEL,
  ENTRY_SOURCE_ORDER, isOnPageSource,
  normalizeFunnelSource, normalizeEntrySource,
  shapeFunnelRow, flatten, createFunnelStore, DEDUPE_MS,
} from './premiumPlusFunnelStore.js';
import { readPlusSourceFromUrl } from './premiumPlusFunnelServer.js';
import {
  summarizeFunnelBySource, countUnknownSource, hasSourceTotalMismatch, SOURCE_TOTAL_NOTE,
  ON_PAGE_REACH_NOTE,
} from './premiumPlusFunnelAnalytics.js';

test('【重要】allow-list 外の source は採らない（任意値を保存しない）', () => {
  assert.equal(normalizeFunnelSource('dashboard'), 'dashboard');
  assert.equal(normalizeFunnelSource('sanrenpuku'), 'sanrenpuku');
  assert.equal(normalizeFunnelSource('plus_page'), 'plus_page');
  assert.equal(normalizeFunnelSource(' DASHBOARD '), 'dashboard', '大小・空白は吸収する');
  assert.equal(normalizeFunnelSource(' PLUS_PAGE '), 'plus_page', '大小・空白は吸収する');
  for (const bad of ['', 'evil', 'admin', '../x', 'plus-page', null, undefined, 42, {}, ['dashboard']]) {
    assert.equal(normalizeFunnelSource(bad), null, `採ってはいけない値: ${JSON.stringify(bad)}`);
  }
});

test('allow-list は 3 導線（画面もこの並びを使う）', () => {
  assert.deepEqual([...FUNNEL_SOURCE_ORDER],
    [FUNNEL_SOURCE.DASHBOARD, FUNNEL_SOURCE.SANRENPUKU, FUNNEL_SOURCE.PLUS_PAGE]);
  assert.equal(FUNNEL_SOURCE_LABEL.dashboard, 'ダッシュボード');
  assert.equal(FUNNEL_SOURCE_LABEL.sanrenpuku, '三連複ページ');
  assert.equal(FUNNEL_SOURCE_LABEL.plus_page, 'Premium Plus 商品ページ内');
  assert.match(FUNNEL_SOURCE_LABEL.legacy, /クリック元不明/);
  assert.match(FUNNEL_SOURCE_LABEL.noSource, /クリック元なし/);
  // 3 導線すべてにラベルがある（画面が source 値をそのまま出さない）
  for (const s of FUNNEL_SOURCE_ORDER) {
    assert.ok(FUNNEL_SOURCE_LABEL[s], `ラベルが無い: ${s}`);
    assert.ok(FUNNEL_SOURCE_KIND_OF[s], `種類が無い: ${s}`);
  }
});

test('【重要】導線の種類を分ける（流入 / 商品ページ内）', () => {
  assert.equal(FUNNEL_SOURCE_KIND_OF.dashboard, FUNNEL_SOURCE_KIND.ENTRY);
  assert.equal(FUNNEL_SOURCE_KIND_OF.sanrenpuku, FUNNEL_SOURCE_KIND.ENTRY);
  assert.equal(FUNNEL_SOURCE_KIND_OF.plus_page, FUNNEL_SOURCE_KIND.ON_PAGE);
  assert.equal(isOnPageSource('plus_page'), true);
  assert.equal(isOnPageSource('dashboard'), false);
  assert.equal(isOnPageSource('evil'), false);
  assert.deepEqual([...ENTRY_SOURCE_ORDER], ['dashboard', 'sanrenpuku'], '流入導線だけを取り出せていない');
  assert.ok(FUNNEL_SOURCE_KIND_LABEL.entry && FUNNEL_SOURCE_KIND_LABEL.on_page);
});

test('【重要】?from= は流入導線だけ受ける（plus_page を名乗らせない）', () => {
  assert.equal(normalizeEntrySource('dashboard'), 'dashboard');
  assert.equal(normalizeEntrySource('sanrenpuku'), 'sanrenpuku');
  assert.equal(normalizeEntrySource('plus_page'), null, '商品ページ内を流入として採っている');
  assert.equal(readPlusSourceFromUrl('https://analytics.keiba.link/premium-plus/?from=dashboard'), 'dashboard');
  assert.equal(readPlusSourceFromUrl('https://analytics.keiba.link/premium-plus/?from=plus_page'), null,
    'URL から plus_page を名乗れてしまう（到達の内訳が汚れる）');
  assert.equal(readPlusSourceFromUrl('https://analytics.keiba.link/premium-plus/?from=evil'), null);
  assert.equal(readPlusSourceFromUrl('https://analytics.keiba.link/premium-plus/'), null);
});

test('【重要】既存の source なし記録は source 不明のまま（dashboard へ推測分類しない）', () => {
  // 0510apolone のクリック 1 回に相当（sv も bySource も無い）
  const c = describeFunnelCell(shapeFunnelRow(flatten({ click: { firstAt: T(1), lastAt: T(1), count: 1 } })).click,
    { available: true });
  assert.equal(c.measured, true);
  assert.equal(c.count, 1);
  assert.deepEqual(c.sources, [], '推測で導線を作っている');
  assert.equal(c.legacyCount, 1, '計測前の記録が legacy として残っていない');
  assert.equal(c.noSourceCount, 0, 'legacy を noSource と混同している');
  assert.match(c.legacyLabel, /計測前/);
});

test('【重要】source 別合計が aggregate を超えても正常（引き算しない）', () => {
  // 合計 1（全導線共通の 30 分窓）に対し、導線別は dashboard 1 + sanrenpuku 1 = 2
  const c = describeFunnelCell(shapeFunnelRow(flatten({
    click: {
      firstAt: T(1), lastAt: T(1), count: 1, sv: 1, legacy: 0,
      bySource: {
        dashboard: { firstAt: T(1), lastAt: T(1), count: 1 },
        sanrenpuku: { firstAt: T(1), lastAt: T(1), count: 1 },
      },
    },
  })).click, { available: true });
  assert.equal(c.count, 1);
  assert.equal(c.sourceTotal, 2, '導線別の和が出ていない');
  assert.equal(c.sourceTotalDiffers, true);
  assert.equal(c.legacyCount, 0, '引き算で負や誤った不明を作っている');
  assert.equal(c.noSourceCount, 0);
});

test('【重要】legacy と noSource を別々に数える', () => {
  const c = describeFunnelCell(shapeFunnelRow(flatten({
    click: {
      firstAt: T(1), lastAt: T(5), count: 3, sv: 1, legacy: 1,
      bySource: { dashboard: { firstAt: T(2), lastAt: T(2), count: 1 } },
      noSource: { firstAt: T(5), lastAt: T(5), count: 1 },
    },
  })).click, { available: true });
  assert.equal(c.legacyCount, 1);
  assert.equal(c.noSourceCount, 1);
  assert.equal(c.sources.length, 1);
  assert.notEqual(c.legacyLabel, c.noSourceLabel, 'legacy と noSource が同じ扱いになっている');
});

test('導線ごとの初回・最終を返す', () => {
  const c = describeFunnelCell(shapeFunnelRow(flatten({
    cta: { firstAt: T(1), lastAt: T(4), count: 2, sv: 1, legacy: 0,
      bySource: { sanrenpuku: { firstAt: T(1), lastAt: T(4), count: 2 } } },
  })).cta, { available: true });
  const s = c.sources[0];
  assert.equal(s.label, '三連複ページ');
  assert.match(s.firstAtJst, /^2026-08-13 \d{2}:\d{2}$/);
  assert.match(s.lastAtJst, /^2026-08-13 \d{2}:\d{2}$/);
});

test('【重要】内訳が合計を大きく超えても不明が負にならない', () => {
  const c = describeFunnelCell(shapeFunnelRow(flatten({
    click: { firstAt: T(1), lastAt: T(1), count: 1, sv: 1, legacy: 0,
      bySource: { dashboard: { firstAt: T(1), lastAt: T(1), count: 9 } } },
  })).click, { available: true });
  assert.equal(c.legacyCount, 0);
  assert.equal(c.noSourceCount, 0);
  assert.ok(c.legacyCount >= 0 && c.noSourceCount >= 0, '不明が負になっている');
});

test('【重要】不正 source は任意の導線へ分類されない', () => {
  const shaped = shapeFunnelRow(flatten({
    cta: { firstAt: T(1), lastAt: T(3), count: 3, sv: 1, legacy: 0,
      bySource: { dashboard: { firstAt: T(1), lastAt: T(2), count: 1 }, evil: { firstAt: T(1), lastAt: T(1), count: 2 } } },
  }));
  assert.deepEqual(Object.keys(shaped.cta.bySource), ['dashboard'], 'allow-list 外の鍵が残っている');
  const c = describeFunnelCell(shaped.cta, { available: true });
  assert.deepEqual(c.sources.map((x) => x.source), ['dashboard']);
  // evil の 2 回が dashboard / sanrenpuku へ流れ込んでいないこと
  assert.equal(c.sources[0].count, 1);
});

test('未実測セルは内訳も空・不明も null（0 にしない）', () => {
  const c = describeFunnelCell(null, { available: true });
  assert.deepEqual(c.sources, []);
  assert.equal(c.legacyCount, null);
  assert.equal(c.noSourceCount, null);
});

// ── 導線別の集計 ───────────────────────────────────────────
const withSrc = (over) => ({ available: true, cta: none, click: none, page: none, ...over });
const mCell = (count, by) => describeFunnelCell(
  shapeFunnelRow(flatten({ cta: { firstAt: T(1), lastAt: T(2), count, sv: 1, legacy: Object.keys(by || {}).length ? 0 : count, bySource: by } })).cta,
  { available: true });

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

test('【重要】商品ページ内の導線は到達を出さない（0 名と書かない）', () => {
  // 商品ページ内で「見た → 押した」。到達はこの導線より前に起きている
  const rows = [
    { recordId: 'r1', realView: withSrc({
      cta: mCell(1, { plus_page: { firstAtMs: T(1), lastAtMs: T(1), count: 1 } }),
      click: mCell(1, { plus_page: { firstAtMs: T(2), lastAtMs: T(2), count: 1 } }),
      // 到達は流入導線（dashboard）側に記録されている
      page: mCell(1, { dashboard: { firstAtMs: T(1), lastAtMs: T(1), count: 1 } }) }) },
  ];
  const by = summarizeFunnelBySource(rows);
  const pp = by.find((x) => x.source === 'plus_page');
  assert.equal(pp.kind, FUNNEL_SOURCE_KIND.ON_PAGE);
  assert.equal(pp.kindLabel, FUNNEL_SOURCE_KIND_LABEL.on_page);
  assert.deepEqual([pp.viewed, pp.clicked], [1, 1], '商品ページ内の表示・クリックを数えていない');
  assert.equal(pp.reached, null, '到達を 0 と書いている（指標が存在しないので null）');
  assert.equal(pp.rates.clickToReach, null, 'クリック→到達を 0% と書いている');
  assert.equal(pp.rates.viewToClick, 100, '表示→クリックは商品ページ内でも意味がある');
  assert.ok(pp.reachNote && /0 名という意味ではありません/.test(pp.reachNote), '理由を返していない');
  assert.equal(ON_PAGE_REACH_NOTE, pp.reachNote, '文言が単一源になっていない');
  // 流入導線は従来どおり到達を数える（後方互換）
  const dash = by.find((x) => x.source === 'dashboard');
  assert.equal(dash.kind, FUNNEL_SOURCE_KIND.ENTRY);
  assert.equal(dash.reached, 1);
  assert.equal(typeof dash.reachNote, 'object', 'entry に理由文言は要らない（null）');
});

test('【重要】plus_page を足しても既存データの集計が変わらない（後方互換）', () => {
  // 導線別計測より前の記録（sv も bySource も無い）
  const legacyRow = { recordId: 'r1', realView: withSrc({ cta: mCell(3, {}) }) };
  const by = summarizeFunnelBySource([legacyRow]);
  assert.equal(by.length, 3, '導線が 3 行にならない');
  for (const s of by) {
    assert.equal(s.viewed, 0, `${s.source} に過去データを混ぜている`);
    assert.equal(s.clicked, 0);
  }
  // 過去データに plus_page のバケツを勝手に作らない（未計測は 0 回ではない）
  const cell = describeFunnelCell(shapeFunnelRow(flatten({
    cta: { firstAt: T(1), lastAt: T(1), count: 1 },
  })).cta, { available: true });
  assert.deepEqual(cell.sources, [], '過去データに導線の内訳を作っている');
  assert.equal(cell.sources.some((x) => x.source === 'plus_page'), false);
});

test('【重要】導線不明の記録はどの導線にも入れない', () => {
  const rows = [{ recordId: 'r1', realView: withSrc({ cta: mCell(3, {}) }) }];
  for (const s of summarizeFunnelBySource(rows)) {
    assert.equal(s.viewed, 0, `${s.source} に不明を混ぜている`);
  }
  const u = countUnknownSource(rows);
  assert.equal(u.legacy.cta, 1, 'legacy として数えていない');
  assert.equal(u.noSource.cta, 0);
});

test('読めなかった人は導線別にも数えない', () => {
  const rows = [{ recordId: 'r1', realView: { available: false } }];
  for (const s of summarizeFunnelBySource(rows)) assert.equal(s.viewed, 0);
  assert.equal(countUnknownSource(rows).legacy.cta, 0);
  assert.equal(countUnknownSource(rows).noSource.cta, 0);
});

test('導線別の並びは allow-list の順', () => {
  assert.deepEqual(summarizeFunnelBySource([]).map((s) => s.source), [...FUNNEL_SOURCE_ORDER]);
});

// ══════════════════════════════════════════════════════════════
//  重複除外は「イベント種別 × source」単位
//
//  全導線共通で除外すると、dashboard を押した直後の sanrenpuku クリックが
//  丸ごと消える。各導線で 1 回ずつ数える必要がある。
// ══════════════════════════════════════════════════════════════

/** 実 Redis を使わない store（HSET/HGET をメモリで再現） */
function memStore() {
  const db = new Map();
  const store = createFunnelStore({
    redisCmd: async (cmd) => {
      const [op, key, field, value] = cmd;
      if (op === 'HGET') return db.get(`${key}|${field}`) ?? null;
      if (op === 'HSET') { db.set(`${key}|${field}`, value); return 1; }
      if (op === 'HSETNX') { const k = `${key}|${field}`; if (db.has(k)) return 0; db.set(k, value); return 1; }
      return null;
    },
  });
  const read = (key, id) => { const v = db.get(`${key}|${id}`); return v ? JSON.parse(v) : null; };
  return { store, read, db };
}

const ID = 'recDEDUPETEST0001';
const UA = 'Mozilla/5.0 (Macintosh) Safari/605.1';
const CLICK_KEY = 'ak:pp:funnel:v1:click';
const click = (store, at, source) => store.record({
  recordId: ID, event: 'cta_click', nowMs: at, userAgent: UA, authenticated: true, source,
});

test('【重要】dashboard → sanrenpuku を 30 分以内にクリックすると各 1 回', async () => {
  const { store, read } = memStore();
  const t0 = Date.parse('2026-08-13T05:00:00Z');
  const r1 = await click(store, t0, 'dashboard');
  const r2 = await click(store, t0 + 10 * 60 * 1000, 'sanrenpuku');
  assert.equal(r1.counted, true);
  assert.equal(r2.counted, true, '別導線のクリックが除外されている');

  const v = read(CLICK_KEY, ID);
  assert.equal(v.bySource.dashboard.count, 1);
  assert.equal(v.bySource.sanrenpuku.count, 1, 'sanrenpuku が記録されていない');
  // 合計は従来どおり全導線共通の 30 分窓なので 1 のまま（互換維持）
  assert.equal(v.count, 1, '合計の意味が変わっている（互換が壊れている）');
});

test('【重要】同じ source を 30 分以内に再クリックしても 1 回', async () => {
  const { store, read } = memStore();
  const t0 = Date.parse('2026-08-13T05:00:00Z');
  await click(store, t0, 'dashboard');
  const again = await click(store, t0 + 5 * 60 * 1000, 'dashboard');
  assert.equal(again.counted, false, '同一導線の連打を数えている');
  assert.equal(again.reason, 'deduped');
  assert.equal(read(CLICK_KEY, ID).bySource.dashboard.count, 1);
});

test('同じ source でも 30 分を超えれば数える', async () => {
  const { store, read } = memStore();
  const t0 = Date.parse('2026-08-13T05:00:00Z');
  await click(store, t0, 'dashboard');
  const later = await click(store, t0 + DEDUPE_MS + 1000, 'dashboard');
  assert.equal(later.counted, true);
  assert.equal(read(CLICK_KEY, ID).bySource.dashboard.count, 2);
});

test('【重要】source 別合計が aggregate を超えても正常に読める', async () => {
  const { store, read } = memStore();
  const t0 = Date.parse('2026-08-13T05:00:00Z');
  await click(store, t0, 'dashboard');
  await click(store, t0 + 60 * 1000, 'sanrenpuku');
  const raw = read(CLICK_KEY, ID);
  const c = describeFunnelCell(shapeFunnelRow(flatten({ click: raw })).click, { available: true });
  assert.equal(c.count, 1);
  assert.equal(c.sourceTotal, 2, '導線別の和が出ていない');
  assert.equal(c.sourceTotalDiffers, true, '食い違いを画面へ伝えられない');
  assert.ok(c.legacyCount >= 0 && c.noSourceCount >= 0, '不明が負になっている');
});

test('【重要】既存の source なし記録は source 不明のまま（後から書き換えない）', async () => {
  const { store, read, db } = memStore();
  const t0 = Date.parse('2026-08-13T05:00:00Z');
  // 導線別計測より前の記録（sv も bySource も無い）= 0510apolone のクリック相当
  db.set(`${CLICK_KEY}|${ID}`, JSON.stringify({ firstAt: t0 - 86400000, lastAt: t0 - 86400000, count: 1 }));

  // そのあと dashboard からのクリックが来る
  await click(store, t0, 'dashboard');
  const v = read(CLICK_KEY, ID);
  assert.equal(v.legacy, 1, '計測前の 1 回が legacy として保持されていない');
  assert.equal(v.bySource.dashboard.count, 1);
  assert.ok(!v.bySource.sanrenpuku, '身に覚えのない導線が生えている');

  const c = describeFunnelCell(shapeFunnelRow(flatten({ click: v })).click, { available: true });
  assert.equal(c.legacyCount, 1, '過去の記録が dashboard へ書き換えられている');
  assert.equal(c.sources.length, 1);
  assert.equal(c.sources[0].count, 1);
});

test('【重要】不正 source は任意の導線へ分類されない（記録経路）', async () => {
  const { store, read } = memStore();
  const t0 = Date.parse('2026-08-13T05:00:00Z');
  for (const bad of ['evil', '', 'admin', null]) {
    // eslint-disable-next-line no-await-in-loop -- 順に時刻をずらして記録する
    await click(store, t0 + DEDUPE_MS * (1 + ['evil', '', 'admin', null].indexOf(bad)), bad);
  }
  const v = read(CLICK_KEY, ID);
  assert.ok(!v.bySource || Object.keys(v.bySource).length === 0, '不正 source が導線として保存されている');
  assert.ok(v.noSource.count >= 1, 'source なしとして数えられていない');
});

test('【重要】Daniel 相当 fixture で 2 導線が独立して計測される', async () => {
  const { store, read } = memStore();
  const t0 = Date.parse('2026-08-13T05:00:00Z');
  const rec = (event, at, source) => store.record({
    recordId: ID, event, nowMs: at, userAgent: UA, authenticated: true, source,
  });
  // 三連複ページで表示 → クリック、その 5 分後にダッシュボードでも表示 → クリック
  await rec('cta_view', t0, 'sanrenpuku');
  await rec('cta_click', t0 + 60000, 'sanrenpuku');
  await rec('cta_view', t0 + 5 * 60000, 'dashboard');
  await rec('cta_click', t0 + 6 * 60000, 'dashboard');
  await rec('page_view', t0 + 7 * 60000, 'dashboard');

  const row = shapeFunnelRow(flatten({
    cta: read('ak:pp:funnel:v1:cta', ID),
    click: read(CLICK_KEY, ID),
    page: read('ak:pp:funnel:v1:page', ID),
  }));
  const view = {
    available: true,
    cta: describeFunnelCell(row.cta, { available: true }),
    click: describeFunnelCell(row.click, { available: true }),
    page: describeFunnelCell(row.page, { available: true }),
  };
  // 2 導線それぞれ 1 回ずつ独立して数えられている
  assert.deepEqual(view.cta.sources.map((s) => [s.source, s.count]).sort(),
    [['dashboard', 1], ['sanrenpuku', 1]]);
  assert.deepEqual(view.click.sources.map((s) => [s.source, s.count]).sort(),
    [['dashboard', 1], ['sanrenpuku', 1]]);
  assert.deepEqual(view.page.sources.map((s) => [s.source, s.count]), [['dashboard', 1]]);
  // 合計は全導線共通の窓なので 1（導線別の和 2 と食い違うが正常）
  assert.equal(view.cta.count, 1);
  assert.equal(view.cta.sourceTotalDiffers, true);

  const by = summarizeFunnelBySource([{ recordId: ID, realView: view }]);
  const dash = by.find((x) => x.source === 'dashboard');
  const srp = by.find((x) => x.source === 'sanrenpuku');
  assert.deepEqual([dash.viewed, dash.clicked, dash.reached], [1, 1, 1]);
  assert.deepEqual([srp.viewed, srp.clicked, srp.reached], [1, 1, 0], '三連複導線が独立して数えられていない');
  assert.equal(hasSourceTotalMismatch([{ recordId: ID, realView: view }]), true);
});

test('【重要】3 サーフェスが 1 人の中で独立して判別できる（合成 fixture）', async () => {
  // ⚠️ これは**合成データ**。実在の会員の本番記録ではない。
  // 三連複ページ → ダッシュボード → 商品ページ到達 → 商品ページ内の購入ボタン、の順。
  const { store, read } = memStore();
  const t0 = Date.parse('2026-08-14T05:00:00Z');
  const rec = (event, at, source) => store.record({
    recordId: ID, event, nowMs: at, userAgent: UA, authenticated: true, source,
  });
  await rec('cta_view', t0, 'sanrenpuku');
  await rec('cta_click', t0 + 60000, 'sanrenpuku');
  await rec('cta_view', t0 + 5 * 60000, 'dashboard');
  await rec('cta_click', t0 + 6 * 60000, 'dashboard');
  await rec('page_view', t0 + 7 * 60000, 'dashboard');
  // 商品ページに着いてから、ページ内の購入ボタンを見て押した
  await rec('cta_view', t0 + 8 * 60000, 'plus_page');
  await rec('cta_click', t0 + 9 * 60000, 'plus_page');

  const row = shapeFunnelRow(flatten({
    cta: read('ak:pp:funnel:v1:cta', ID),
    click: read(CLICK_KEY, ID),
    page: read('ak:pp:funnel:v1:page', ID),
  }));
  const view = {
    available: true,
    cta: describeFunnelCell(row.cta, { available: true }),
    click: describeFunnelCell(row.click, { available: true }),
    page: describeFunnelCell(row.page, { available: true }),
  };
  // 3 サーフェスが混ざらずに 1 回ずつ立っている
  assert.deepEqual(view.click.sources.map((s) => [s.source, s.count]).sort(),
    [['dashboard', 1], ['plus_page', 1], ['sanrenpuku', 1]],
    'クリック元を 3 サーフェスで判別できていない');
  assert.deepEqual(view.page.sources.map((s) => [s.source, s.count]), [['dashboard', 1]],
    '到達に商品ページ内の導線が混ざっている');

  const by = summarizeFunnelBySource([{ recordId: ID, realView: view }]);
  const pp = by.find((x) => x.source === 'plus_page');
  assert.deepEqual([pp.viewed, pp.clicked], [1, 1]);
  assert.equal(pp.reached, null, '商品ページ内に到達を作っている');
  assert.equal(by.find((x) => x.source === 'dashboard').reached, 1);
});

test('画面へ出す注記が「一致しない場合がある」と述べている', () => {
  assert.match(SOURCE_TOTAL_NOTE, /導線別/);
  assert.match(SOURCE_TOTAL_NOTE, /一致しない/);
});
