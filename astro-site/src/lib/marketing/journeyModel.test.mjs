/**
 * journeyModel.test.mjs — 2 キャンペーンを 1 本の道のり（通し番号 1〜24）として数える
 *   node --test src/lib/marketing/journeyModel.test.mjs
 *
 * 守る性質:
 *   - 体験中 6 通 + 終了後 18 通 = **24**（どちらかを増やしたら気づく）
 *   - 接点の範囲が**重ならない / 飛ばない**
 *   - 未知のキャンペーン・範囲外は **null**（0 や 1 で埋めない）
 *   - 上限 24 を超えない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  JOURNEY_ID, MAX_TOUCHES, JOURNEY_PHASE, JOURNEY_PHASES,
  findPhase, isJourneyCampaign, toTouch, fromTouch, totalTouches,
  summarizeTouches, canSendMore, describeJourney,
} from './journeyModel.js';
import { getCampaign } from './campaignCatalog.js';
import { getSequenceSteps } from './campaignSequence.js';

const ACTIVE = 'light-trial-to-premium-sequence';
const POST = 'light-trial-post-expiry-sequence';

test('【重要】合計は 24（フェーズの合計と上限が一致する）', () => {
  assert.equal(totalTouches(), MAX_TOUCHES);
  assert.equal(MAX_TOUCHES, 24);
});

test('【重要】定義した通数と、実際のキャンペーンの Step 数が一致する', () => {
  for (const p of JOURNEY_PHASES) {
    const c = getCampaign(p.campaignId, { includeDisabled: true });
    assert.ok(c, `${p.campaignId} が無い`);
    assert.equal(getSequenceSteps(c).length, p.steps,
      `${p.campaignId} の Step 数が定義（${p.steps}）と違う`);
  }
});

test('【重要】体験中 = 接点 1〜6 / 終了後 = 接点 7〜24', () => {
  assert.equal(toTouch(ACTIVE, 1), 1);
  assert.equal(toTouch(ACTIVE, 6), 6);
  assert.equal(toTouch(POST, 1), 7);
  assert.equal(toTouch(POST, 18), 24);
});

test('【重要】範囲外の Step は null（丸めない）', () => {
  assert.equal(toTouch(ACTIVE, 7), null, '体験中に 7 通目は無い');
  assert.equal(toTouch(POST, 19), null);
  assert.equal(toTouch(ACTIVE, 0), null);
  assert.equal(toTouch(ACTIVE, -1), null);
  assert.equal(toTouch(ACTIVE, 1.5), null);
});

test('【重要】知らないキャンペーンは道のりに数えない', () => {
  assert.equal(toTouch('marketing-canary', 1), null);
  assert.equal(findPhase('marketing-canary'), null);
  assert.equal(isJourneyCampaign('marketing-canary'), false);
  assert.equal(isJourneyCampaign(ACTIVE), true);
  assert.equal(isJourneyCampaign(POST), true);
});

test('【重要】通し番号 → キャンペーン と Step（往復して一致する）', () => {
  for (let t = 1; t <= MAX_TOUCHES; t += 1) {
    const r = fromTouch(t);
    assert.ok(r, `touch${t} が解決できない`);
    assert.equal(toTouch(r.campaignId, r.step), t, `touch${t} の往復が合わない`);
  }
  assert.equal(fromTouch(0), null);
  assert.equal(fromTouch(25), null);
  assert.equal(fromTouch('x'), null);
});

test('【重要】接点の範囲が重ならない・飛ばない', () => {
  const seen = new Set();
  for (const p of JOURNEY_PHASES) {
    for (let s = 1; s <= p.steps; s += 1) {
      const t = toTouch(p.campaignId, s);
      assert.equal(seen.has(t), false, `接点 ${t} が重複している`);
      seen.add(t);
    }
  }
  assert.equal(seen.size, MAX_TOUCHES);
  for (let t = 1; t <= MAX_TOUCHES; t += 1) assert.ok(seen.has(t), `接点 ${t} が抜けている`);
});

test('いま何通目か（フェーズをまたいで数える）', () => {
  const r = summarizeTouches({ active: [1, 2, 3, 4, 5, 6], post_expiry: [1, 2] });
  assert.deepEqual(r.touches, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(r.current, 8);
  assert.equal(r.remaining, 16);
  assert.equal(r.completed, false);
});

test('【重要】24 通に達したら completed（それ以上は送らない）', () => {
  const all = {
    active: [1, 2, 3, 4, 5, 6],
    post_expiry: Array.from({ length: 18 }, (_, i) => i + 1),
  };
  const r = summarizeTouches(all);
  assert.equal(r.touches.length, 24);
  assert.equal(r.current, 24);
  assert.equal(r.remaining, 0);
  assert.equal(r.completed, true);
  assert.equal(canSendMore(all), false);
});

test('【重要】体験中が途中で終わっても、合計は 24 を超えない', () => {
  // 期限切れが早くて体験中 3 通で終わった人が、終了後 18 通を受け取る
  const r = summarizeTouches({
    active: [1, 2, 3],
    post_expiry: Array.from({ length: 18 }, (_, i) => i + 1),
  });
  assert.equal(r.touches.length, 21);
  assert.ok(r.touches.length <= 24);
  assert.equal(r.remaining, 3);
});

test('壊れた入力でも数えない（推測で埋めない）', () => {
  assert.deepEqual(summarizeTouches(null).touches, []);
  assert.deepEqual(summarizeTouches({ active: 'x' }).touches, []);
  assert.deepEqual(summarizeTouches({ active: [99] }).touches, [], '範囲外を数えている');
});

test('同じ Step が二重に記録されても 1 接点として数える', () => {
  const r = summarizeTouches({ active: [1, 1, 2], post_expiry: [1, 1] });
  assert.deepEqual(r.touches, [1, 2, 7]);
});

test('画面向けの要約に PII を入れない', () => {
  const d = describeJourney();
  assert.equal(d.journeyId, JOURNEY_ID);
  assert.equal(d.maxTouches, 24);
  assert.equal(d.phases.length, 2);
  assert.deepEqual(d.phases.map((p) => [p.touchFrom, p.touchTo]), [[1, 6], [7, 24]]);
  assert.equal(/@/.test(JSON.stringify(d)), false);
});

test('フェーズ名は 2 つだけ（増えたら画面と docs を直す）', () => {
  assert.deepEqual(JOURNEY_PHASES.map((p) => p.phase), [JOURNEY_PHASE.ACTIVE, JOURNEY_PHASE.POST_EXPIRY]);
});
