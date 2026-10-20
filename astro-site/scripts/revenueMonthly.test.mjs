import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDoc, buildRevenueMonth, fetchPaypalMonth, fetchRevenueMonth, measurementPeriod, monthRangeJst, previousMonthJst, readPrevious,
  summarizePaypal, summarizeStripe, summaryLine, sustainedMonths, RevenueError, TARGET_JPY,
} from './revenueMonthly.mjs';

const summary = (over = {}) => ({ month: '2026-10', confirmedCount: 3, pricedCount: 3, confirmedYen: 1_200_000, yenByPlan: {}, firstPricedDay: '20261001', ...over });
const full = { partial: false, periodEnd: '2026-10-31' };

test('前月は JST', () => {
  assert.equal(previousMonthJst(Date.parse('2026-10-31T15:30:00Z')), '2026-10'); // JST 11/1 00:30
});

test('JST の月境界・当月は速報値・未来は拒否', () => {
  const r = monthRangeJst('2026-10');
  assert.equal(new Date(r.startMs).toISOString(), '2026-09-30T15:00:00.000Z');
  assert.equal(new Date(r.endMs).toISOString(), '2026-10-31T15:00:00.000Z');
  assert.equal(new Date(monthRangeJst('2026-12').endMs).toISOString(), '2026-12-31T15:00:00.000Z');
  assert.throws(() => monthRangeJst('2026-13'), RevenueError);
  const now = Date.parse('2026-10-19T03:00:00Z');
  const p = measurementPeriod('2026-10', now);
  assert.deepEqual({ partial: p.partial, periodEnd: p.periodEnd, untilMs: p.untilMs }, { partial: true, periodEnd: '2026-10-19', untilMs: now });
  const q = measurementPeriod('2026-09', now);
  assert.deepEqual({ partial: q.partial, periodEnd: q.periodEnd }, { partial: false, periodEnd: '2026-09-30' });
  assert.throws(() => measurementPeriod('2026-11', now), /future/);
});

test('目標達成と連続月数（全手段を計上）', () => {
  const channels = { stripe: { gross: 0, refunds: 0, payments: 0 }, paypal: { gross: 0, refunds: 0, payments: 0 } };
  const d = buildDoc({ month: '2026-10', summary: summary(), channels, period: full, previous: new Map([['2026-09', TARGET_JPY]]), nowMs: 0 });
  assert.equal(d.schema, 'kao.revenue-month/v1');
  assert.equal(d.currency, 'JPY');
  assert.equal(d.net_jpy, 1_200_000);
  assert.equal(d.achieved, true);
  assert.equal(d.sustained_months, 2);
  assert.equal(d.partial, undefined);
  assert.deepEqual(d.data_quality, ['銀行振込: 返金は記録が無く差し引いていない']);
  assert.equal(sustainedMonths('2026-10', TARGET_JPY - 1, new Map()), 0);
});

test('Stripe・PayPal を合算し、返金を引く', () => {
  const d = buildDoc({ month: '2026-10', summary: summary({ confirmedYen: 68_000, pricedCount: 1, confirmedCount: 1 }),
    channels: { stripe: { gross: 4980, refunds: 0, payments: 1 }, paypal: { gross: 5960, refunds: 2980, payments: 2 } }, period: full, nowMs: 0 });
  assert.equal(d.gross_jpy, 68_000 + 4980 + 5960);
  assert.equal(d.refunds_jpy, 2980);
  assert.equal(d.net_jpy, 68_000 + 4980 + 2980);
  assert.deepEqual(d.by_channel.paypal, { gross_jpy: 5960, refunds_jpy: 2980, net_jpy: 2980, payments: 2 });
});

test('鍵なし・取得失敗の手段は 0 円として数えず未計上と明記する', () => {
  const d = buildDoc({ month: '2026-10', summary: summary({ confirmedYen: 68_000 }),
    channels: { stripe: { unavailable: 'stripe charges: HTTP 401' } }, period: full, nowMs: 0 });
  assert.equal(d.net_jpy, 68_000);
  assert.deepEqual(d.by_channel.stripe, { measured: false });
  assert.deepEqual(d.by_channel.paypal, { measured: false });
  assert.ok(d.data_quality.includes('Stripe: 未計上（取得失敗: stripe charges: HTTP 401）'));
  assert.ok(d.data_quality.includes('PayPal: 未計上（読取り鍵が未設定）'));
});

test('月途中は速報値（partial）で、達成・連続月数に数えない', () => {
  const d = buildDoc({ month: '2026-10', summary: summary({ confirmedYen: 2_000_000 }), period: { partial: true, periodEnd: '2026-10-19' },
    previous: new Map([['2026-09', TARGET_JPY]]), nowMs: 0 });
  assert.equal(d.partial, true);
  assert.equal(d.period_end, '2026-10-19');
  assert.equal(d.achieved, false);
  assert.equal(d.sustained_months, 0);
  assert.match(d.data_quality[0], /月途中の速報値（2026-10-19 まで）/);
});

test('金額が記録されなかった入金確認・記録開始前の月は data_quality に出す', () => {
  const d = buildDoc({ month: '2026-10', summary: summary({ confirmedCount: 5, pricedCount: 3, firstPricedDay: '20261015' }), period: full, nowMs: 0 });
  assert.ok(d.data_quality.some((q) => q.includes('2 件は金額の記録が無く')));
  assert.ok(d.data_quality.some((q) => q.includes('月の途中')));
});

test('Stripe: 成功した charge だけを数え、返金を引く・JPY 以外は fail-closed', () => {
  const s = summarizeStripe(
    [{ status: 'succeeded', paid: true, currency: 'jpy', amount_captured: 4980 },
     { status: 'succeeded', paid: true, currency: 'jpy', amount_captured: 2980 },
     { status: 'failed', paid: false, currency: 'jpy', amount_captured: 0, amount: 4980 }],
    [{ status: 'succeeded', currency: 'jpy', amount: 2980 }, { status: 'failed', currency: 'jpy', amount: 100 }]);
  assert.deepEqual(s, { gross: 7960, refunds: 2980, payments: 2 });
  assert.throws(() => summarizeStripe([{ status: 'succeeded', paid: true, currency: 'usd', amount_captured: 1 }], []), RevenueError);
});

test('PayPal: 完了した入金（T00xx）と返金（T11xx）だけ・保留・手数料は数えない', () => {
  const tx = (code, value, status = 'S', currency = 'JPY') => ({ transaction_info: { transaction_event_code: code, transaction_status: status, transaction_amount: { value: String(value), currency_code: currency } } });
  const s = summarizePaypal([tx('T0002', 4980), tx('T0006', 2980), tx('T0002', 4980, 'P'), tx('T1107', -2980), tx('T0400', -5000), tx('T0002', 0)]);
  assert.deepEqual(s, { gross: 7960, refunds: 2980, payments: 2 });
  assert.throws(() => summarizePaypal([tx('T0002', 10, 'S', 'USD')]), RevenueError);
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

test('銀行振込の取得失敗・形の違う応答・鍵なしは fail-closed', async () => {
  await assert.rejects(fetchRevenueMonth({ siteUrl: 'https://x.invalid/', secret: '', month: '2026-10' }), RevenueError);
  await assert.rejects(fetchRevenueMonth({ siteUrl: 'https://x.invalid/', secret: 's', month: '2026-10', fetchImpl: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  await assert.rejects(fetchRevenueMonth({ siteUrl: 'https://x.invalid/', secret: 's', month: '2026-10',
    fetchImpl: async () => ({ ok: true, json: async () => ({ month: '2026-10', confirmedCount: 1, pricedCount: 1, confirmedYen: -5 }) }) }), RevenueError);
});

/** 偽の API: 決済会社へは GET（と PayPal の token 取得）だけを送ることを確かめる。 */
function fakeApis({ stripeStatus = 200, paypalStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ host: u.host, path: u.pathname, method: init.method || 'GET', search: u.searchParams });
    if (u.pathname.endsWith('/admin-payment-funnel')) return { ok: true, status: 200, json: async () => summary({ confirmedYen: 68_000, pricedCount: 1, confirmedCount: 1 }) };
    if (u.host === 'api.stripe.com') {
      if (stripeStatus !== 200) return { ok: false, status: stripeStatus };
      const kind = u.pathname.split('/').pop();
      if (kind === 'charges' && !u.searchParams.get('starting_after')) {
        return { ok: true, json: async () => ({ has_more: true, data: [{ id: 'ch_1', status: 'succeeded', paid: true, currency: 'jpy', amount_captured: 4980 }] }) };
      }
      if (kind === 'charges') return { ok: true, json: async () => ({ has_more: false, data: [{ id: 'ch_2', status: 'succeeded', paid: true, currency: 'jpy', amount_captured: 2980 }] }) };
      return { ok: true, json: async () => ({ has_more: false, data: [] }) };
    }
    if (u.host === 'api-m.paypal.com') {
      if (u.pathname === '/v1/oauth2/token') return paypalStatus === 200 ? { ok: true, json: async () => ({ access_token: 'tok' }) } : { ok: false, status: paypalStatus };
      return { ok: true, json: async () => ({ total_pages: 1, transaction_details: [{ transaction_info: { transaction_event_code: 'T0002', transaction_status: 'S', transaction_amount: { value: '4980', currency_code: 'JPY' } } }] }) };
    }
    throw new Error(`unexpected ${url}`);
  };
  return { calls, fetchImpl };
}

test('全手段を読み、決済会社へは読み取り（GET・token 取得）しか送らない', async () => {
  const { calls, fetchImpl } = fakeApis();
  const nowMs = Date.parse('2026-11-01T01:00:00Z');
  const d = await buildRevenueMonth({ month: '2026-10', fetchImpl, nowMs,
    env: { PAYMENT_FUNNEL_READ_SECRET: 's', STRIPE_READ_KEY: 'rk', PAYPAL_READ_CLIENT_ID: 'id', PAYPAL_READ_CLIENT_SECRET: 'sec' } });
  assert.equal(d.net_jpy, 68_000 + 4980 + 2980 + 4980);
  assert.equal(d.partial, undefined);
  for (const c of calls.filter((x) => x.host !== 'analytics.keiba.link')) {
    assert.ok(c.method === 'GET' || (c.method === 'POST' && c.path === '/v1/oauth2/token'), `${c.method} ${c.path}`);
  }
  const charges = calls.find((c) => c.path === '/v1/charges');
  assert.equal(charges.search.get('created[gte]'), String(Date.parse('2026-09-30T15:00:00Z') / 1000));
  assert.equal(charges.search.get('created[lt]'), String(Date.parse('2026-10-31T15:00:00Z') / 1000));
  const pp = calls.find((c) => c.path === '/v1/reporting/transactions');
  assert.equal(pp.search.get('start_date'), '2026-09-30T15:00:00Z');
  assert.equal(pp.search.get('end_date'), '2026-10-31T14:59:59Z');
});

test('任意の手段の失敗は未計上として記録し、鍵を出力に含めない', async () => {
  const { fetchImpl } = fakeApis({ stripeStatus: 401, paypalStatus: 403 });
  const d = await buildRevenueMonth({ month: '2026-10', fetchImpl, nowMs: Date.parse('2026-10-19T03:00:00Z'),
    env: { PAYMENT_FUNNEL_READ_SECRET: 'funnel-secret-x', STRIPE_READ_KEY: 'stripe-read-key-x', PAYPAL_READ_CLIENT_ID: 'id-x', PAYPAL_READ_CLIENT_SECRET: 'sec-x' } });
  assert.equal(d.net_jpy, 68_000);
  assert.equal(d.partial, true);
  assert.ok(d.data_quality.includes('Stripe: 未計上（取得失敗: stripe charges: HTTP 401）'));
  assert.ok(d.data_quality.includes('PayPal: 未計上（取得失敗: paypal token: HTTP 403）'));
  const text = JSON.stringify(d) + JSON.stringify(summaryLine(d));
  for (const secret of ['funnel-secret-x', 'stripe-read-key-x', 'id-x', 'sec-x', 'ch_1']) assert.ok(!text.includes(secret), secret);
});

test('出力は集計値だけ（識別子・明細の key を持たない）', async () => {
  const { fetchImpl } = fakeApis();
  const d = await buildRevenueMonth({ month: '2026-10', fetchImpl, nowMs: Date.parse('2026-11-01T01:00:00Z'),
    env: { PAYMENT_FUNNEL_READ_SECRET: 's', STRIPE_READ_KEY: 'rk', PAYPAL_READ_CLIENT_ID: 'id', PAYPAL_READ_CLIENT_SECRET: 'sec' } });
  assert.deepEqual(Object.keys(d).sort(), ['achieved', 'by_channel', 'currency', 'data_quality', 'generatedAt', 'gross_jpy', 'month', 'net_jpy', 'next_tasks',
    'refunds_jpy', 'repo', 'schema', 'sustained_months', 'target_jpy'].sort());
  for (const ch of Object.values(d.by_channel)) {
    for (const k of Object.keys(ch)) assert.ok(['gross_jpy', 'refunds_jpy', 'net_jpy', 'payments', 'measured'].includes(k), k);
  }
});

test('既存の measurement を読む（壊れた file・速報値は連続月数に数えない）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ak-rev-'));
  writeFileSync(join(dir, 'revenue-2026-08-01.json'), JSON.stringify({ schema: 'kao.revenue-month/v1', month: '2026-08', net_jpy: 1_200_000 }));
  writeFileSync(join(dir, 'revenue-2026-09-01.json'), JSON.stringify({ schema: 'kao.revenue-month/v1', month: '2026-09', net_jpy: 1_500_000, partial: true }));
  writeFileSync(join(dir, 'revenue-2026-07-01.json'), '{broken');
  writeFileSync(join(dir, 'other.json'), JSON.stringify({ schema: 'kao.revenue-month/v1', month: '2026-06', net_jpy: 1 }));
  assert.deepEqual([...readPrevious(dir)], [['2026-08', 1_200_000]]);
});

test('commit 済みの measurement は KAO の契約の形を満たす', () => {
  const dir = new URL('../../docs/measurements/', import.meta.url);
  const names = existsSync(dir) ? readdirSync(dir) : [];
  for (const name of names) {
    if (!/^revenue-20\d{2}-\d{2}-01\.json$/.test(name)) continue;
    const doc = JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
    assert.equal(doc.schema, 'kao.revenue-month/v1');
    assert.equal(doc.currency, 'JPY');
    assert.match(doc.month, /^20\d{2}-(0[1-9]|1[0-2])$/);
    assert.equal(name, `revenue-${doc.month}-01.json`);
    assert.ok(!Number.isNaN(Date.parse(doc.generatedAt)));
    for (const k of ['net_jpy', 'target_jpy', 'sustained_months']) assert.equal(typeof doc[k], 'number', k);
    assert.ok(Array.isArray(doc.data_quality));
    if (doc.partial) assert.ok(doc.data_quality.length > 0, '速報値は data_quality で明示する');
  }
});


test('PayPal: 0 件の応答（transaction_details 省略・total_items=0）は 0 円で計上し、それ以外の形は fail-closed', async () => {
  const period = { startMs: Date.parse('2026-09-30T15:00:00Z'), untilMs: Date.parse('2026-10-31T15:00:00Z') };
  const fakePaypal = (body) => async (url) => (new URL(url).pathname === '/v1/oauth2/token'
    ? { ok: true, json: async () => ({ access_token: 'tok' }) }
    : { ok: true, json: async () => body });
  const empty = { account_number: 'x', start_date: 's', end_date: 'e', last_refreshed_datetime: 'r', links: [], page: 1, total_items: 0, total_pages: 0 };
  assert.deepEqual(await fetchPaypalMonth({ clientId: 'id', clientSecret: 'sec', period, fetchImpl: fakePaypal(empty) }), { gross: 0, refunds: 0, payments: 0 });
  for (const bad of [{ ...empty, total_items: 3 }, { ...empty, total_items: undefined }, { ...empty, total_items: '0' }, null]) {
    await assert.rejects(fetchPaypalMonth({ clientId: 'id', clientSecret: 'sec', period, fetchImpl: fakePaypal(bad) }), (e) => {
      assert.ok(e instanceof RevenueError);
      assert.match(e.message, /^paypal transactions: unexpected response/);
      assert.ok(!e.message.includes('tok'));
      return true;
    });
  }
});
