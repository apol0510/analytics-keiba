/**
 * journeyTotals.test.mjs — 2 フェーズの人数を**二重に数えずに**まとめる
 *   node --test src/lib/marketing/journeyTotals.test.mjs
 *
 * 守る性質:
 *   - 同じ人を 2 回数えない（両フェーズが同じ母集団を見ているため）
 *   - 1 人が必ず 1 分類に入る（合計 = 母集団）
 *   - 読めない値は **null**（0 と書かない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildJourneyTotals, toMetricsTotals, JOURNEY_STATE_LABEL,
  STILL_ACTIVE_REASON, PURCHASED_REASON,
} from './journeyTotals.js';

/** 終了後フェーズの集計（100 人の母集団） */
const post = (over = {}) => ({
  total: 100, due: 10, waiting: 20, completed: 5, stopped: 65,
  byStopReason: { [STILL_ACTIVE_REASON]: 40, [PURCHASED_REASON]: 15, unsubscribed: 10 },
  ...over,
});

test('【重要】1 人が 1 分類に入る（合計が母集団と一致）', () => {
  const r = buildJourneyTotals({ active: { due: 5, waiting: 35 }, postExpiry: post() });
  assert.equal(r.ok, true);
  const t = r.totals;
  assert.equal(t.observed, 100);
  assert.equal(t.inTrial, 40);        // まだ体験中
  assert.equal(t.inFollowUp, 30);     // 10 + 20
  assert.equal(t.purchased, 15);
  assert.equal(t.stopped, 10);        // 65 - 40 - 15
  assert.equal(t.completed, 5);
  assert.equal(t.inTrial + t.inFollowUp + t.purchased + t.stopped + t.completed, 100);
  assert.equal(t.balanced, true);
});

test('【重要】体験中の人を「停止」に数えない', () => {
  const r = buildJourneyTotals({ active: null, postExpiry: post() });
  assert.equal(r.totals.stopped, 10, '体験中や購入を停止に混ぜている');
  assert.equal(r.totals.inTrial, 40);
});

test('【重要】購入は購入として数える（停止に混ぜない）', () => {
  const r = buildJourneyTotals({ active: null, postExpiry: post() });
  assert.equal(r.totals.purchased, 15);
});

test('【重要】終了後フェーズの集計が無ければ数えない', () => {
  const r = buildJourneyTotals({ active: { due: 1, waiting: 2 }, postExpiry: null });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'post_expiry_summary_missing');
});

test('【重要】集計に欠けがあれば数えない（0 と書かない）', () => {
  for (const k of ['total', 'due', 'waiting', 'completed', 'stopped']) {
    const r = buildJourneyTotals({ active: null, postExpiry: post({ [k]: undefined }) });
    assert.equal(r.ok, false, `${k} が無くても数えている`);
    assert.equal(r.reason, 'summary_incomplete');
  }
});

test('停止理由が無くても壊れない（全員が進行中）', () => {
  const r = buildJourneyTotals({
    active: null,
    postExpiry: { total: 10, due: 4, waiting: 6, completed: 0, stopped: 0, byStopReason: {} },
  });
  assert.equal(r.ok, true);
  assert.equal(r.totals.inFollowUp, 10);
  assert.equal(r.totals.balanced, true);
});

test('停止の内訳が合わない場合でも負の数にしない', () => {
  const r = buildJourneyTotals({
    active: null,
    // stopped(2) より byStopReason の合計(50)が大きい壊れた入力
    postExpiry: post({ stopped: 2, byStopReason: { [STILL_ACTIVE_REASON]: 50 } }),
  });
  assert.ok(r.totals.stopped >= 0, '負の人数になっている');
  assert.equal(r.totals.balanced, false, 'ズレているのに balanced を名乗っている');
});

test('体験中フェーズの内訳は補足として返す（読めなければ null）', () => {
  const withActive = buildJourneyTotals({ active: { due: 3, waiting: 7 }, postExpiry: post() });
  assert.deepEqual(withActive.totals.trial, { due: 3, waiting: 7 });
  const without = buildJourneyTotals({ active: null, postExpiry: post() });
  assert.deepEqual(without.totals.trial, { due: null, waiting: null });
});

test('集計へ書く形に変換できる（granted は状態から持ち込む）', () => {
  const r = buildJourneyTotals({ active: null, postExpiry: post() });
  const m = toMetricsTotals({ totals: r.totals, granted: 14479 });
  assert.equal(m.granted, 14479);
  assert.equal(m.inTrial, 40);
  assert.equal(m.inFollowUp, 30);
  assert.equal(m.inProgress, 70, '旧来の「進行中」が 2 フェーズの合計になっていない');
  assert.equal(m.purchased, 15);
  assert.equal(m.completed, 5);
});

test('画面のラベルは 5 分類（増えたら docs も直す）', () => {
  assert.deepEqual(Object.keys(JOURNEY_STATE_LABEL),
    ['inTrial', 'inFollowUp', 'purchased', 'stopped', 'completed']);
  assert.equal(JOURNEY_STATE_LABEL.inTrial, '体験中');
  assert.equal(JOURNEY_STATE_LABEL.inFollowUp, '体験終了・フォロー中');
});

test('応答に PII を含めない', () => {
  const r = buildJourneyTotals({ active: null, postExpiry: post() });
  assert.equal(/@|rec[A-Za-z0-9]{14}/.test(JSON.stringify(r)), false);
});
