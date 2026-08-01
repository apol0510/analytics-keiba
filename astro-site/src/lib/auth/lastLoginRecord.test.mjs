/**
 * lastLoginRecord.test.mjs — ログイン時刻記録の判定
 *   node --test src/lib/auth/lastLoginRecord.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planLastLoginUpdate,
  assertOnlyLastLoginField,
  LAST_LOGIN_FIELD,
  MIN_UPDATE_INTERVAL_MS,
} from './lastLoginRecord.js';

const NOW = Date.parse('2026-08-01T02:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

test('記録が無ければ書く', () => {
  const r = planLastLoginUpdate({ fields: {}, nowMs: NOW });
  assert.equal(r.update, true);
  assert.deepEqual(Object.keys(r.fields), [LAST_LOGIN_FIELD]);
  assert.equal(r.fields[LAST_LOGIN_FIELD], iso(NOW));
});

test('最小間隔（6時間）以内は書かない', () => {
  const recent = planLastLoginUpdate({ fields: { [LAST_LOGIN_FIELD]: iso(NOW - 60 * 1000) }, nowMs: NOW });
  assert.equal(recent.update, false);
  assert.equal(recent.reason, 'recently_updated');

  const old = planLastLoginUpdate({
    fields: { [LAST_LOGIN_FIELD]: iso(NOW - MIN_UPDATE_INTERVAL_MS - 1000) }, nowMs: NOW,
  });
  assert.equal(old.update, true);
});

test('未来日時（不正データ）は上書きして正常化する', () => {
  const r = planLastLoginUpdate({ fields: { [LAST_LOGIN_FIELD]: iso(NOW + 365 * 24 * 3600 * 1000) }, nowMs: NOW });
  assert.equal(r.update, true, '未来日時が残ると永久に更新されない');
  assert.equal(r.fields[LAST_LOGIN_FIELD], iso(NOW));
});

test('壊れた値は無視して書く', () => {
  for (const bad of ['', '   ', 'not-a-date', null, undefined]) {
    assert.equal(planLastLoginUpdate({ fields: { [LAST_LOGIN_FIELD]: bad }, nowMs: NOW }).update, true);
  }
});

test('now が不正なら書かない（fail closed）', () => {
  assert.equal(planLastLoginUpdate({ fields: {}, nowMs: NaN }).update, false);
  assert.equal(planLastLoginUpdate({ fields: {} }).update, false);
});

test('書き込み対象は LastLoginAt 1 列だけ', () => {
  assert.equal(assertOnlyLastLoginField({ [LAST_LOGIN_FIELD]: iso(NOW) }), true);
  // 契約・課金の列が混ざったら弾く
  assert.equal(assertOnlyLastLoginField({ [LAST_LOGIN_FIELD]: iso(NOW), 'プラン': 'Premium' }), false);
  assert.equal(assertOnlyLastLoginField({ '有効期限': '2027-01-01' }), false);
  assert.equal(assertOnlyLastLoginField({}), false);
});

test('生成される値は ISO 文字列（Airtable dateTime 互換）', () => {
  const r = planLastLoginUpdate({ fields: {}, nowMs: NOW });
  assert.match(r.fields[LAST_LOGIN_FIELD], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
