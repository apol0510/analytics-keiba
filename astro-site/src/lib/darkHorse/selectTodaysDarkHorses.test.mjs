/**
 * selectTodaysDarkHorses.test.mjs — 穴馬抽出「当日データのみ・過去日 fallback なし」回帰テスト
 *   node --test src/lib/darkHorse/selectTodaysDarkHorses.test.mjs
 *
 * 固定する仕様（/dark-horse-picks/）:
 *   - todayJst と日付文字列が完全一致するエントリだけ返す
 *   - 過去日（前日など）へ fallback しない・「最大日」ではなく todayJst 基準
 *   - todayJst 一致が無ければ空配列
 *   - 同日複数 venue は同日分だけ集約
 *   - darkHorses 空/欠落/非配列・date 不正でも throw しない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectTodaysEntries, entryHasDarkHorses } from './selectTodaysDarkHorses.js';

// darkHorses を n 頭持つレースを count 個並べた computer エントリを作る
const mk = (date, venueCode, category, dhCounts) => ({
  category,
  date,
  venueCode,
  data: {
    races: dhCounts.map((n, i) => ({
      raceNumber: i + 1,
      darkHorses: Array.from({ length: n }, (_, j) => ({ number: j + 1 })),
    })),
  },
});

// 1) todayJst=2026-07-08 → 2026-07-08 の darkHorses だけ返す
test('todayJst=2026-07-08: 2026-07-08 の darkHorses だけ返す', () => {
  const entries = [mk('2026-07-07', 'KAW', 'nankan', [1, 1]), mk('2026-07-08', 'KAW', 'nankan', [2, 1])];
  const r = selectTodaysEntries(entries, '2026-07-08');
  assert.equal(r.length, 1);
  assert.equal(r[0].date, '2026-07-08');
  assert.equal(r[0].venueCode, 'KAW');
});

// 2) 2026-07-07 の darkHorses が存在しても返さない
test('2026-07-07 が存在しても todayJst=2026-07-08 では返さない', () => {
  const entries = [mk('2026-07-07', 'KAW', 'nankan', [3]), mk('2026-07-08', 'KAW', 'nankan', [1])];
  const r = selectTodaysEntries(entries, '2026-07-08');
  assert.ok(r.every((e) => e.date === '2026-07-08'));
  assert.equal(r.some((e) => e.date === '2026-07-07'), false);
});

// 3) 2026-07-08 が無い場合、2026-07-07 へ fallback しない（空配列）
test('todayJst=2026-07-08 のデータが無ければ前日へ fallback せず空配列', () => {
  const entries = [mk('2026-07-07', 'KAW', 'nankan', [1, 2, 3])];
  const r = selectTodaysEntries(entries, '2026-07-08');
  assert.deepEqual(r, []);
});

// 4) 同日複数 venue → 同日分だけ集約（別日は混ぜない）
test('同日複数 venue は同日分だけ集約する', () => {
  const entries = [
    mk('2026-07-08', 'OOI', 'nankan', [1]),
    mk('2026-07-08', 'FUN', 'nankan', [2]),
    mk('2026-07-07', 'KAW', 'nankan', [3]),
    mk('2026-07-09', 'TOK', 'jra', [1]),
  ];
  const r = selectTodaysEntries(entries, '2026-07-08');
  assert.equal(r.length, 2);
  assert.deepEqual(r.map((e) => e.venueCode).sort(), ['FUN', 'OOI']);
  assert.ok(r.every((e) => e.date === '2026-07-08'));
});

// 5) darkHorses 空/欠落/非配列・races 非配列・data null・entry null でも落ちない
test('darkHorses 空/欠落/非配列・壊れたエントリでも throw せず有効分だけ返す', () => {
  const entries = [
    { category: 'nankan', date: '2026-07-08', venueCode: 'A', data: { races: [{ raceNumber: 1 }] } }, // 欠落
    { category: 'nankan', date: '2026-07-08', venueCode: 'B', data: { races: [{ raceNumber: 1, darkHorses: [] }] } }, // 空
    { category: 'nankan', date: '2026-07-08', venueCode: 'C', data: { races: [{ raceNumber: 1, darkHorses: 'nope' }] } }, // 非配列
    { category: 'nankan', date: '2026-07-08', venueCode: 'D', data: { races: 'nope' } }, // races 非配列
    { category: 'nankan', date: '2026-07-08', venueCode: 'E', data: null }, // data null
    null, // entry null
    mk('2026-07-08', 'F', 'nankan', [1]), // 有効
  ];
  let r;
  assert.doesNotThrow(() => {
    r = selectTodaysEntries(entries, '2026-07-08');
  });
  assert.equal(r.length, 1);
  assert.equal(r[0].venueCode, 'F');
});

test('entryHasDarkHorses は壊れた入力で false（throw しない）', () => {
  assert.equal(entryHasDarkHorses(null), false);
  assert.equal(entryHasDarkHorses({}), false);
  assert.equal(entryHasDarkHorses({ data: null }), false);
  assert.equal(entryHasDarkHorses({ data: { races: 'x' } }), false);
  assert.equal(entryHasDarkHorses({ data: { races: [{ darkHorses: [] }] } }), false);
  assert.equal(entryHasDarkHorses({ data: { races: [{ darkHorses: [{ number: 1 }] }] } }), true);
});

// 6) 日付比較は文字列完全一致（過去最大日ではなく todayJst 基準）
test('比較は todayJst 完全一致：より新しい日があっても todayJst の日を返す', () => {
  const entries = [mk('2026-07-07', 'KAW', 'nankan', [1]), mk('2026-07-08', 'KAW', 'nankan', [1])];
  const r = selectTodaysEntries(entries, '2026-07-07');
  assert.equal(r.length, 1);
  assert.equal(r[0].date, '2026-07-07'); // 「最大日 2026-07-08」ではない
  assert.equal(r.some((e) => e.date === '2026-07-08'), false); // 未来日は含めない
});

test('date 不正 / todayJst 不正 / entries 非配列 は空配列（安全）', () => {
  assert.deepEqual(selectTodaysEntries([{ date: 20260708, data: { races: [{ darkHorses: [{}] }] } }], '2026-07-08'), []);
  assert.deepEqual(selectTodaysEntries([mk('2026-07-08', 'KAW', 'nankan', [1])], ''), []);
  assert.deepEqual(selectTodaysEntries([mk('2026-07-08', 'KAW', 'nankan', [1])], null), []);
  assert.deepEqual(selectTodaysEntries(null, '2026-07-08'), []);
  assert.deepEqual(selectTodaysEntries(undefined, '2026-07-08'), []);
});
