/**
 * planNormalization.test.mjs — plan / venue 正規化のテーブル駆動テスト
 *   node --test src/lib/auth/planNormalization.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePlan,
  isPaidPlan,
  normalizeVenueAccess,
  isValidVenueAccessArray,
  CANONICAL_PLANS,
} from './planNormalization.js';

const PLAN_CASES = [
  // [入力, 期待正規値 or null]
  ['free', 'free'],
  ['Free', 'free'],
  ['free-registered', 'free'],
  ['freeregistered', 'free'],
  ['無料', 'free'],
  ['expired', 'free'],
  ['light', 'light'],
  ['Light', 'light'],
  ['ライト', 'light'],
  ['ﾗｲﾄ', 'light'], // 半角カナ → NFKC → 'ライト'
  ['standard', 'light'],
  ['premium', 'premium'],
  ['Premium', 'premium'],
  ['プレミアム', 'premium'],
  ['premium predictions', 'premium-predictions'],
  ['Premium Sanrenpuku', 'premium-sanrenpuku'],
  ['プレミアム三連複', 'premium-sanrenpuku'],
  ['premium-sanrentan', 'premium-sanrentan'],
  ['プレミアム三連単', 'premium-sanrentan'],
  ['premium combo', 'premium-combo'],
  ['Premium Plus', 'premium-plus'],
  ['premium_plus', 'premium-plus'],
  ['pro', 'premium'],
  ['pro-plus', 'premium-plus'],
  // 未知・不正
  ['wizard', null],
  ['', null],
  ['   ', null],
  [null, null],
  [undefined, null],
  [42, null],
  [{}, null],
  [['light'], null],
];

for (const [input, expected] of PLAN_CASES) {
  test(`normalizePlan(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
    assert.equal(normalizePlan(input), expected);
  });
}

test('isPaidPlan: free / 未知 は false、有料は true', () => {
  assert.equal(isPaidPlan('free'), false);
  assert.equal(isPaidPlan('無料'), false);
  assert.equal(isPaidPlan('wizard'), false);
  assert.equal(isPaidPlan(null), false);
  for (const p of CANONICAL_PLANS.filter((x) => x !== 'free')) {
    assert.equal(isPaidPlan(p), true, `${p} should be paid`);
  }
});

const VENUE_CASES = [
  ['jra', ['jra']],
  ['JRA', ['jra']],
  ['中央', ['jra']],
  ['nankan', ['nankan']],
  ['南関', ['nankan']],
  ['all', ['jra', 'nankan']],
  ['both', ['jra', 'nankan']],
  ['すべて', ['jra', 'nankan']],
  [['jra'], ['jra']],
  [['nankan', 'jra'], ['jra', 'nankan']], // 正規順にソート
  [['jra', 'jra'], ['jra']], // 重複除去
  [['all', 'jra'], ['jra', 'nankan']],
  // 未知・不正 → null
  ['mars', null],
  [['jra', 'mars'], null],
  [[], null],
  ['', null],
  [null, null],
  [undefined, null],
  [42, null],
];

for (const [input, expected] of VENUE_CASES) {
  test(`normalizeVenueAccess(${JSON.stringify(input)}) === ${JSON.stringify(expected)}`, () => {
    assert.deepEqual(normalizeVenueAccess(input), expected);
  });
}

test('isValidVenueAccessArray: 正規配列のみ true', () => {
  assert.equal(isValidVenueAccessArray(['jra']), true);
  assert.equal(isValidVenueAccessArray(['jra', 'nankan']), true);
  assert.equal(isValidVenueAccessArray([]), false);
  assert.equal(isValidVenueAccessArray(['jra', 'jra']), false); // 重複
  assert.equal(isValidVenueAccessArray(['jra', 'mars']), false);
  assert.equal(isValidVenueAccessArray('jra'), false);
  assert.equal(isValidVenueAccessArray(null), false);
});
