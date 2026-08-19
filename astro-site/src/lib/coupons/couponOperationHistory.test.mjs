/**
 * couponOperationHistory.test.mjs — append-only 履歴（**設計のみ・本番テーブル未作成**）
 *
 * 固定すること:
 *   - テーブルを作るまで**書き込み計画を立てない**（fail closed）
 *   - 商品・会員・クーポン・操作を識別できる
 *   - 同じ操作を二重に積まない（冪等キー）
 *   - 課金・権限の列を持たない
 *   - 他会員の行が混ざらない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const H = await import('./couponOperationHistory.js');
const { COUPON_OPERATION, PRODUCT_KEY } = await import('./couponPlatform.js');

const AT = '2026-08-20T12:00:00.000Z';
const rec = (over = {}) => H.buildHistoryRecord({
  customerRecordId: 'recA', email: 'a@example.invalid',
  productKey: PRODUCT_KEY.PREMIUM_PLUS, couponId: 'premium-plus-reopen-priority', version: 1,
  operationType: COUPON_OPERATION.GRANT, actor: 'MK', reason: 'お電話でのご依頼',
  beforeState: 'none', afterState: 'held', detail: 'admin-grant|by=MK', atIso: AT, ...over,
});

test('本番テーブルが未有効のあいだは何も積まない（fail closed）', () => {
  assert.equal(H.isCouponHistoryEnabled({}), false);
  assert.equal(H.isCouponHistoryEnabled({ COUPON_HISTORY_TABLE_READY: '0' }), false);
  const p = H.planHistoryAppend({ record: rec(), existing: [], env: {} });
  assert.equal(p.append, false);
  assert.equal(p.reason, 'history_disabled');
});

test('本番テーブルへ書く経路をまだ作っていない（設計のみ）', () => {
  // Function から履歴テーブルへ PATCH/POST する配線が無いことを固定する
  const fn = read('../../../netlify/functions/premium-plus-eligibility.js');
  assert.doesNotMatch(fn, /CouponOperationHistory/,
    '本番テーブル未作成なのに書き込み経路がある');
});

test('商品・会員・クーポン・操作を識別できる', () => {
  const r = rec();
  assert.equal(r.fields.ProductKey, PRODUCT_KEY.PREMIUM_PLUS);
  assert.equal(r.fields.CustomerRecordId, 'recA');
  assert.equal(r.fields.CouponId, 'premium-plus-reopen-priority');
  assert.equal(r.fields.CouponVersion, 1);
  assert.equal(r.fields.OperationType, COUPON_OPERATION.GRANT);
  assert.equal(r.fields.Actor, 'MK');
  assert.equal(r.fields.BeforeState, 'none');
  assert.equal(r.fields.AfterState, 'held');
  assert.ok(r.fields.OccurredAt);
});

test('同じ操作は同じ OperationId になり、二重に積まない', () => {
  assert.equal(rec().operationId, rec().operationId, '乱数が混ざっている');
  const r = rec();
  const dup = H.planHistoryAppend({
    record: r, existing: [{ fields: { OperationId: r.operationId } }],
    env: { COUPON_HISTORY_TABLE_READY: '1' },
  });
  assert.equal(dup.append, false);
  assert.equal(dup.reason, 'already_recorded');
  // 別の操作は積める
  const ok = H.planHistoryAppend({
    record: rec({ operationType: COUPON_OPERATION.CORRECT }),
    existing: [{ fields: { OperationId: r.operationId } }],
    env: { COUPON_HISTORY_TABLE_READY: '1' },
  });
  assert.equal(ok.append, true);
});

test('情報が足りなければ行を作らない', () => {
  assert.equal(rec({ customerRecordId: '' }), null);
  assert.equal(rec({ couponId: '' }), null);
  assert.equal(rec({ atIso: '' }), null);
});

test('課金・権限の列を持たない（履歴が権利の根拠にならない）', () => {
  const keys = Object.keys(rec().fields);
  for (const k of keys) assert.ok(H.COUPON_HISTORY_FIELDS.includes(k), k);
  for (const bad of H.COUPON_HISTORY_FORBIDDEN_FIELDS) assert.ok(!keys.includes(bad), bad);
  assert.equal(H.assertOnlyHistoryFields({ プラン: 'Premium' }), false);
  assert.equal(H.assertOnlyHistoryFields({}), false);
});

test('会員 1 人ぶんだけを新しい順に取り出す（他会員は混ざらない）', () => {
  const row = (id, at) => ({ id, fields: { CustomerRecordId: id === 'x' ? 'recB' : 'recA', OccurredAt: at } });
  const got = H.listHistoryForCustomer({
    rows: [row('a', '2026-08-01T00:00:00Z'), row('x', '2026-08-05T00:00:00Z'), row('b', '2026-08-10T00:00:00Z')],
    customerRecordId: 'recA',
  });
  assert.deepEqual(got.map((r) => r.id), ['b', 'a']);
});

test('テーブル名は商品に依存しない', () => {
  assert.equal(H.COUPON_HISTORY_TABLE, 'CouponOperationHistory');
  assert.doesNotMatch(H.COUPON_HISTORY_TABLE, /premium|plus/i, '商品名がテーブル名に入っている');
});
