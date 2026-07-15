/**
 * storeSelection.test.mjs — PREMIUM_PLUS_CANARY → ストア名 解決の fail-closed 検証（純粋）
 *   node --test src/lib/premiumPlus/storeSelection.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePremiumPlusStoreName, STORE_SELECT_REJECT } from './storeSelection.js';

test('1 未設定(undefined) → premium-plus', () => {
  assert.deepEqual(resolvePremiumPlusStoreName(undefined), { ok: true, storeName: 'premium-plus' });
});

test('2 "false" → premium-plus', () => {
  assert.deepEqual(resolvePremiumPlusStoreName('false'), { ok: true, storeName: 'premium-plus' });
});

test('3 "true" → premium-plus-canary', () => {
  assert.deepEqual(resolvePremiumPlusStoreName('true'), { ok: true, storeName: 'premium-plus-canary' });
});

function assertRejected(v) {
  const r = resolvePremiumPlusStoreName(v);
  assert.equal(r.ok, false, `value=${JSON.stringify(v)} は fail-closed のはず`);
  assert.equal(r.reason, STORE_SELECT_REJECT.INVALID_CANARY_FLAG);
  assert.equal(r.storeName, undefined);
}

test('4 空文字 → fail-closed', () => assertRejected(''));

test('5 "TRUE"/"False" など大小違い → fail-closed', () => {
  ['TRUE', 'True', 'False', 'FALSE'].forEach(assertRejected);
});

test('6 " true " など空白付き → fail-closed', () => {
  [' true ', 'true ', ' true', '\ttrue', 'true\n', ' false '].forEach(assertRejected);
});

test('7 任意 store 名・truthy 文字列 → fail-closed（自由 override を許さない）', () => {
  ['premium-plus', 'premium-plus-canary', 'foo', '1', '0', 'yes', 'no', 'on', 'off', 'null'].forEach(assertRejected);
});

test('8 slash・改行を含む値 → fail-closed', () => {
  ['premium-plus/evil', 'a/b', 'a\nb', 'true\nfalse', 'premium-plus\n'].forEach(assertRejected);
});

test('（防御）非文字列(null/数値/真偽/オブジェクト) → fail-closed', () => {
  [null, 0, 1, true, false, {}, []].forEach(assertRejected);
});
