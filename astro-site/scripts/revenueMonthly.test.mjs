import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDoc, fetchRevenueMonth, previousMonthJst, sustainedMonths, RevenueError, TARGET_JPY } from './revenueMonthly.mjs';

const summary = (over = {}) => ({ month: '2026-10', confirmedCount: 3, pricedCount: 3, confirmedYen: 1_200_000, yenByPlan: {}, firstPricedDay: '20261001', ...over });

test('前月は JST', () => {
  assert.equal(previousMonthJst(Date.parse('2026-10-31T15:30:00Z')), '2026-10'); // JST 11/1 00:30
});

test('目標達成と連続月数', () => {
  const d = buildDoc({ month: '2026-10', summary: summary(), previous: new Map([['2026-09', TARGET_JPY]]), nowMs: 0 });
  assert.equal(d.schema, 'kao.revenue-month/v1');
  assert.equal(d.net_jpy, 1_200_000);
  assert.equal(d.achieved, true);
  assert.equal(d.sustained_months, 2);
  assert.deepEqual(d.data_quality, ['PayPal 決済は未計上（銀行振込の入金確認のみ）']);
  assert.equal(sustainedMonths('2026-10', TARGET_JPY - 1, new Map()), 0);
});

test('金額が記録されなかった入金確認・記録開始前の月は data_quality に出す', () => {
  const d = buildDoc({ month: '2026-10', summary: summary({ confirmedCount: 5, pricedCount: 3, firstPricedDay: '20261015' }), nowMs: 0 });
  assert.ok(d.data_quality.some((q) => q.includes('2 件は金額の記録が無く')));
  assert.ok(d.data_quality.some((q) => q.includes('月の途中')));
});

test('read 用の鍵で revenueMonth を読み、応答の形を検証する', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url: String(url), init }; return { ok: true, status: 200, json: async () => summary() }; };
  const s = await fetchRevenueMonth({ siteUrl: 'https://example.invalid/', secret: 's', month: '2026-10', fetchImpl });
  assert.equal(s.confirmedYen, 1_200_000);
  assert.ok(seen.url.endsWith('/.netlify/functions/admin-payment-funnel'));
  assert.equal(seen.init.headers['x-funnel-read-secret'], 's');
  assert.deepEqual(JSON.parse(seen.init.body), { action: 'revenueMonth', month: '2026-10' });
});

test('取得失敗・形の違う応答・鍵なしは fail-closed', async () => {
  await assert.rejects(fetchRevenueMonth({ siteUrl: 'https://x.invalid/', secret: '', month: '2026-10' }), RevenueError);
  await assert.rejects(fetchRevenueMonth({ siteUrl: 'https://x.invalid/', secret: 's', month: '2026-10', fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  await assert.rejects(fetchRevenueMonth({ siteUrl: 'https://x.invalid/', secret: 's', month: '2026-10',
    fetchImpl: async () => ({ ok: true, json: async () => ({ month: '2026-10', confirmedCount: 1, pricedCount: 1, confirmedYen: -5 }) }) }), RevenueError);
});
