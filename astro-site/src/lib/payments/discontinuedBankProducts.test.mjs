import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discontinuedBankProductWarning } from './discontinuedBankProducts.js';

test('Premium 月払いの振込報告は警告（拒否はしない）', () => {
  assert.match(discontinuedBankProductWarning({ planName: 'Premium', planType: 'Monthly', fields: null }), /販売を終了/);
});

test('Premium 年払い・買い切りは警告なし', () => {
  assert.equal(discontinuedBankProductWarning({ planName: 'Premium', planType: 'Annual', fields: null }), null);
  assert.equal(discontinuedBankProductWarning({ planName: 'Premium', planType: 'Lifetime', fields: null }), null);
});

test('Light: 有料 Light 会員の更新は警告なし・それ以外は新規募集停止の警告', () => {
  const paidLight = { 'プラン': 'Light', PaidAt: '2026-09-01T00:00:00Z' };
  assert.equal(discontinuedBankProductWarning({ planName: 'Light', planType: 'Monthly', fields: paidLight }), null);
  assert.match(discontinuedBankProductWarning({ planName: 'Light', planType: 'Monthly', fields: null }), /新規募集を停止/);
  assert.match(discontinuedBankProductWarning({ planName: 'Light', planType: 'Monthly', fields: { 'プラン': 'Light' } }), /新規募集を停止/);
  assert.match(discontinuedBankProductWarning({ planName: 'Light', planType: 'Monthly', fields: { 'プラン': 'Free', PaidAt: 'x' } }), /新規募集を停止/);
});
