/**
 * customerLookup.test.mjs — Customers 検索結果分類（0/1/複数）の純粋関数テスト
 *   node --test src/lib/auth/customerLookup.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyCustomerMatches, CUSTOMER_LOOKUP } from './customerLookup.js';

const rec = (id, fields = {}) => ({ id, fields });

test('0件 → none / record は null', () => {
  const r = classifyCustomerMatches([]);
  assert.equal(r.kind, CUSTOMER_LOOKUP.NONE);
  assert.equal(r.record, null);
});

test('null / undefined / 非配列 → none（防御的）', () => {
  assert.equal(classifyCustomerMatches(null).kind, CUSTOMER_LOOKUP.NONE);
  assert.equal(classifyCustomerMatches(undefined).kind, CUSTOMER_LOOKUP.NONE);
  assert.equal(classifyCustomerMatches({}).kind, CUSTOMER_LOOKUP.NONE);
});

test('1件 → single / record は {id,fields}', () => {
  const r = classifyCustomerMatches([rec('recA', { 'プラン': 'Premium', Status: 'active' })]);
  assert.equal(r.kind, CUSTOMER_LOOKUP.SINGLE);
  assert.equal(r.record.id, 'recA');
  assert.equal(r.record.fields['プラン'], 'Premium');
});

test('1件で id/fields 欠落でも壊れない', () => {
  const r = classifyCustomerMatches([{}]);
  assert.equal(r.kind, CUSTOMER_LOOKUP.SINGLE);
  assert.equal(r.record.id, null);
  assert.deepEqual(r.record.fields, {});
});

test('複数件 → conflict / record は null（内部値を返さない）', () => {
  const r = classifyCustomerMatches([
    rec('recA', { 'プラン': 'Free' }),
    rec('recB', { 'プラン': 'Premium' }),
  ]);
  assert.equal(r.kind, CUSTOMER_LOOKUP.CONFLICT);
  assert.equal(r.record, null);
});

test('複数件（Paid 同士）→ conflict', () => {
  const r = classifyCustomerMatches([
    rec('recA', { 'プラン': 'Premium' }),
    rec('recB', { 'プラン': 'Premium Plus' }),
  ]);
  assert.equal(r.kind, CUSTOMER_LOOKUP.CONFLICT);
});

test('複数件（Free 同士）→ conflict', () => {
  const r = classifyCustomerMatches([
    rec('recA', { 'プラン': 'Free' }),
    rec('recB', { 'プラン': 'Free' }),
  ]);
  assert.equal(r.kind, CUSTOMER_LOOKUP.CONFLICT);
});

test('3件以上 → conflict', () => {
  const r = classifyCustomerMatches([rec('a'), rec('b'), rec('c')]);
  assert.equal(r.kind, CUSTOMER_LOOKUP.CONFLICT);
  assert.equal(r.record, null);
});
