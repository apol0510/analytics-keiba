/**
 * loadComputerEntriesForDate.test.mjs — 穴馬抽出 SSR loader の回帰テスト
 *   node --test src/lib/darkHorse/loadComputerEntriesForDate.test.mjs
 *
 * 守りたい事故（2026-08-30）:
 *   `/dark-horse-picks/` が `prerender = true` のままビルド時刻で「当日」を決めていたため、
 *   当日は終日「前日の穴馬」が表示され続けた（本番 8/30 12 時の HTML が 8/29 のデータ）。
 *   SSR 化後に固定したい仕様:
 *     1. 読むのは **指定 1 日分だけ**。前日ファイルが実在しても混ざらない
 *     2. 指定日が無ければ **空配列**（前日へ fallback しない）
 *     3. 同日複数会場は取りこぼさない
 *     4. 壊れた JSON / 想定外 schema で **throw しない**（SSR ページを 500 にしない）
 *     5. **JST 0 時の境界**（8/29 23:59:59 → 8/30 00:00:00）で読む日が切り替わる
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadComputerEntriesForDate, computerDirForDate } from './loadComputerEntriesForDate.js';
import { jstDateString, selectTodaysEntries } from './selectTodaysDarkHorses.js';

/** computer JSON 1 本（darkHorses 入り races を n レース）。 */
const mkJson = (date, races = 2) => ({
  date,
  races: Array.from({ length: races }, (_, i) => ({
    raceNumber: String(i + 1),
    darkHorses: [{ number: i + 1, computerIndex: 60 }],
  })),
});

/** fixture ツリーを作る。files = [[category, 'YYYY-MM-DD', 'VENUE', json?]] */
function mkRoot(files) {
  const root = mkdtempSync(join(tmpdir(), 'ak-darkhorse-'));
  for (const [category, date, venue, json] of files) {
    const [y, m] = date.split('-');
    const dir = join(root, 'src', 'data', 'computer', category, y, m);
    mkdirSync(dir, { recursive: true });
    const body = json === undefined ? JSON.stringify(mkJson(date)) : json;
    writeFileSync(join(dir, `${date}-${venue}.json`), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

const cleanup = (root) => rmSync(root, { recursive: true, force: true });

// ── 1. 指定 1 日分だけ読む ────────────────────────────────────
test('指定日だけ読む：前日ファイルが実在しても混ざらない', () => {
  const root = mkRoot([
    ['jra', '2026-08-29', 'NII'],
    ['jra', '2026-08-30', 'NII'],
  ]);
  try {
    const r = loadComputerEntriesForDate('2026-08-30', { projectRoot: root });
    assert.equal(r.length, 1);
    assert.equal(r[0].date, '2026-08-30');
    assert.equal(r[0].venueCode, 'NII');
    assert.equal(r.some((e) => e.date === '2026-08-29'), false, '前日が混ざっている');
  } finally { cleanup(root); }
});

// ── 2. 指定日が無ければ空配列（fallback 禁止）──────────────────
test('指定日が無ければ前日へ fallback せず空配列', () => {
  const root = mkRoot([['jra', '2026-08-29', 'NII'], ['nankan', '2026-08-28', 'FUN']]);
  try {
    assert.deepEqual(loadComputerEntriesForDate('2026-08-30', { projectRoot: root }), []);
  } finally { cleanup(root); }
});

// ── 3. 同日複数会場・複数カテゴリを取りこぼさない ──────────────
test('同日複数会場（JRA 3 場）+ 南関 を全部読む', () => {
  const root = mkRoot([
    ['jra', '2026-08-30', 'NII'],
    ['jra', '2026-08-30', 'CHU'],
    ['jra', '2026-08-30', 'SAP'],
    ['nankan', '2026-08-30', 'OOI'],
    ['jra', '2026-08-23', 'TOK'],
  ]);
  try {
    const r = loadComputerEntriesForDate('2026-08-30', { projectRoot: root });
    assert.equal(r.length, 4);
    assert.deepEqual(r.filter((e) => e.category === 'jra').map((e) => e.venueCode).sort(), ['CHU', 'NII', 'SAP']);
    assert.deepEqual(r.filter((e) => e.category === 'nankan').map((e) => e.venueCode), ['OOI']);
    assert.ok(r.every((e) => e.date === '2026-08-30'));
  } finally { cleanup(root); }
});

// ── 4. 壊れた入力で throw しない ──────────────────────────────
test('JSON 破損は該当 1 件だけ捨てて残りを返す（throw しない）', () => {
  const root = mkRoot([
    ['jra', '2026-08-30', 'NII', '{壊れたJSON'],
    ['jra', '2026-08-30', 'CHU'],
  ]);
  try {
    let r;
    assert.doesNotThrow(() => { r = loadComputerEntriesForDate('2026-08-30', { projectRoot: root }); });
    assert.deepEqual(r.map((e) => e.venueCode), ['CHU']);
  } finally { cleanup(root); }
});

test('races 非配列 / 想定外 schema は捨てる', () => {
  const root = mkRoot([
    ['jra', '2026-08-30', 'NII', { date: '2026-08-30', races: 'nope' }],
    ['jra', '2026-08-30', 'CHU', 'null'],
    ['jra', '2026-08-30', 'SAP'],
  ]);
  try {
    const r = loadComputerEntriesForDate('2026-08-30', { projectRoot: root });
    assert.deepEqual(r.map((e) => e.venueCode), ['SAP']);
  } finally { cleanup(root); }
});

test('date 不正 / null / ディレクトリ無しは空配列（throw しない）', () => {
  const root = mkRoot([['jra', '2026-08-30', 'NII']]);
  try {
    for (const bad of ['', null, undefined, '2026-8-30', '20260830', 'today', 42]) {
      assert.deepEqual(loadComputerEntriesForDate(bad, { projectRoot: root }), [], `bad=${String(bad)}`);
    }
    assert.deepEqual(loadComputerEntriesForDate('2026-08-30', { projectRoot: join(root, 'nope') }), []);
  } finally { cleanup(root); }
});

test('computerDirForDate は date 不正で null', () => {
  assert.equal(computerDirForDate('jra', 'nope', '/x'), null);
  assert.equal(computerDirForDate('', '2026-08-30', '/x'), null);
  assert.equal(computerDirForDate('jra', '2026-08-30', '/x'), join('/x', 'src', 'data', 'computer', 'jra', '2026', '08'));
});

// ── 5. JST 0 時の境界で読む日が切り替わる（8/29 → 8/30）────────
test('JST 0 時境界：8/29 23:59:59 は 8/29、8/30 00:00:00 は 8/30 を読む', () => {
  const root = mkRoot([
    ['jra', '2026-08-29', 'NII'],
    ['jra', '2026-08-30', 'CHU'],
  ]);
  try {
    // 2026-08-29T14:59:59Z = JST 2026-08-29 23:59:59
    const before = jstDateString(new Date('2026-08-29T14:59:59.000Z'));
    // 2026-08-29T15:00:00Z = JST 2026-08-30 00:00:00
    const after = jstDateString(new Date('2026-08-29T15:00:00.000Z'));
    assert.equal(before, '2026-08-29');
    assert.equal(after, '2026-08-30');

    const rBefore = loadComputerEntriesForDate(before, { projectRoot: root });
    assert.deepEqual(rBefore.map((e) => `${e.date}-${e.venueCode}`), ['2026-08-29-NII']);

    const rAfter = loadComputerEntriesForDate(after, { projectRoot: root });
    assert.deepEqual(rAfter.map((e) => `${e.date}-${e.venueCode}`), ['2026-08-30-CHU']);
  } finally { cleanup(root); }
});

// ── 6. ページと同じ経路（loader → selectTodaysEntries）で当日だけ残る ──
test('ページ経路（loader → selectTodaysEntries）で当日分だけが残る', () => {
  const root = mkRoot([
    ['jra', '2026-08-29', 'NII'],
    ['jra', '2026-08-30', 'NII'],
    ['jra', '2026-08-30', 'CHU'],
  ]);
  try {
    const today = jstDateString(new Date('2026-08-30T03:00:00.000Z')); // JST 12:00
    assert.equal(today, '2026-08-30');
    const entries = selectTodaysEntries(loadComputerEntriesForDate(today, { projectRoot: root }), today);
    assert.equal(entries.length, 2);
    assert.ok(entries.every((e) => e.date === '2026-08-30'));
  } finally { cleanup(root); }
});

test('当日データが 0 件でも前日を出さない（ページは「未公開」表示になる）', () => {
  const root = mkRoot([['jra', '2026-08-29', 'NII']]);
  try {
    const today = jstDateString(new Date('2026-08-30T03:00:00.000Z'));
    const entries = selectTodaysEntries(loadComputerEntriesForDate(today, { projectRoot: root }), today);
    assert.deepEqual(entries, []);
  } finally { cleanup(root); }
});
