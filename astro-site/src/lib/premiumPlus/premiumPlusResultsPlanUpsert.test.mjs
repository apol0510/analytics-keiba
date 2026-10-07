/**
 * premiumPlusResultsPlanUpsert.test.mjs — 結果台帳の保存可否（planUpsert）
 *   node --test src/lib/premiumPlus/premiumPlusResultsPlanUpsert.test.mjs
 *
 * 2026-10-07: 未来日 10/29 を誤保存 → 同じ日付へ別内容で気付かず上書き、が起きた再発防止。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planUpsert, todayJst } from '../premiumPlusResults.js';

const TODAY = '2026-10-07';
const e = (date, extra = {}) => ({ date, venue: '船橋', raceNumber: 10, first: [1], second: [2], third: [3], ...extra });
const LEDGER = [e('2026-10-02', { isHit: true, payout: 45500, hitCombo: '1-2-3' }), e('2026-10-01')];

test('todayJst: JST の暦日（UTC 15:00 以降は翌日）', () => {
  assert.equal(todayJst(Date.parse('2026-10-06T14:59:00Z')), '2026-10-06');
  assert.equal(todayJst(Date.parse('2026-10-06T15:00:00Z')), '2026-10-07');
});

test('新しい日付は保存できる', () => {
  const r = planUpsert(LEDGER, { entry: e('2026-10-05'), today: TODAY });
  assert.equal(r.ok, true);
  assert.deepEqual(r.next.map((x) => x.date), ['2026-10-05', '2026-10-02', '2026-10-01']);
});

test('今日は保存できる / 未来の日付は 400', () => {
  assert.equal(planUpsert(LEDGER, { entry: e(TODAY), today: TODAY }).ok, true);
  const r = planUpsert(LEDGER, { entry: e('2026-10-29'), today: TODAY });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
  assert.match(r.error, /未来の日付/);
});

test('同じ日付は overwrite なしだと 409（既存を返す）', () => {
  const r = planUpsert(LEDGER, { entry: e('2026-10-02'), today: TODAY });
  assert.equal(r.status, 409);
  assert.equal(r.existing.date, '2026-10-02');
});

test('同じ日付は overwrite:true で上書きされ、件数は増えない', () => {
  const r = planUpsert(LEDGER, { entry: e('2026-10-02', { raceNumber: 11 }), overwrite: true, today: TODAY });
  assert.equal(r.ok, true);
  assert.equal(r.next.length, 2);
  assert.equal(r.next[0].raceNumber, 11);
  assert.match(r.summary, /上書き/);
});

test('編集で日付を直す: 元の日付は消え、新しい日付で 1 件になる', () => {
  const r = planUpsert(LEDGER, { entry: e('2026-09-29'), replaceDate: '2026-10-01', today: TODAY });
  assert.equal(r.ok, true);
  assert.deepEqual(r.next.map((x) => x.date), ['2026-10-02', '2026-09-29']);
  assert.match(r.summary, /2026-10-01 → 2026-09-29/);
});

test('編集で直した先の日付が既にあると、overwrite なしでは 409', () => {
  const r = planUpsert(LEDGER, { entry: e('2026-10-02'), replaceDate: '2026-10-01', today: TODAY });
  assert.equal(r.status, 409);
});

test('編集元の日付が台帳に無ければ 409（古い画面からの保存で別の日を消さない）', () => {
  const r = planUpsert(LEDGER, { entry: e('2026-09-29'), replaceDate: '2026-09-01', today: TODAY });
  assert.equal(r.status, 409);
});

test('入力不正は 400', () => {
  assert.equal(planUpsert(LEDGER, { entry: { date: '2026-10-05' }, today: TODAY }).status, 400);
});
