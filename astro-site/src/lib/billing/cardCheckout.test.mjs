// 2026-10-13 MK 確定: 決済会社は冗長化（お客様に選ばせない）。申込は ACTIVE_CARD_PROVIDER の 1 社だけ・自動で別社へ作り直さない。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVE_CARD_PROVIDER, CARD_PROVIDER_ROLES, CARD_SALES_OPEN, checkoutProviderGate } from './cardSales.js';
import { startCardCheckout, openCheckoutKey, OPEN_CHECKOUT_TTL_SEC, resolveActiveCardMode } from './cardCheckout.js';

const REC = 'recAAAAAAAAAAAAAA';
const NOW = new Date('2026-10-13T03:00:00Z');

function world(open = null) {
  const store = new Map(open ? [[openCheckoutKey(REC), JSON.stringify(open)]] : []);
  const sets = [];
  const calls = [];
  const redis = async ([cmd, key, val, ...rest]) => {
    if (cmd === 'GET') return store.get(key) ?? null;
    if (cmd === 'SET') { store.set(key, val); sets.push([key, JSON.parse(val), rest]); return 'OK'; }
    throw new Error(`unexpected ${cmd}`);
  };
  const ok = (p) => async (a) => { calls.push([p, a.entry]); return { ok: true, url: `https://x/${p}`, orderId: `${p}_1` }; };
  return { store, sets, calls, redis, creators: { paddle: ok('paddle'), paypal: ok('paypal') } };
}
const run = (w, extra = {}) => startCardCheckout({ env: {}, origin: 'https://o', recordId: REC, productId: 'premium-annual', redis: w.redis, creators: w.creators, now: NOW, ...extra });

test('役割: 第一 Paddle・予備 PayPal（不変）。Paddle 審査中のため、受付を開けた PayPal が申込先（MK の決定＝PR merge）', () => {
  assert.equal(ACTIVE_CARD_PROVIDER, 'paypal');
  assert.deepEqual({ ...CARD_PROVIDER_ROLES }, { paddle: 'primary', paypal: 'standby' });
  assert.deepEqual({ ...CARD_SALES_OPEN }, { paddle: false, paypal: true });
  assert.equal(CARD_SALES_OPEN[ACTIVE_CARD_PROVIDER], true, '申込先は受付を開けた決済会社でなければならない（閉じた会社を申込先にしない）');
});

test('本番の新規申込は共通入口から、運営が選んだ 1 社だけ。Sandbox は各社とも検証できる', () => {
  assert.deepEqual(checkoutProviderGate({ provider: 'paypal', mode: 'live', entry: 'card' }), { ok: true });
  assert.equal(checkoutProviderGate({ provider: 'paddle', mode: 'live', entry: 'card' }).reason, 'provider_not_active');
  assert.equal(checkoutProviderGate({ provider: 'paypal', mode: 'live' }).reason, 'use_card_checkout', '決済会社別の入口は本番で使わせない');
  assert.equal(checkoutProviderGate({ provider: 'paddle', mode: 'live', entry: 'card', active: 'paddle' }).ok, true, '運営が切り替えれば第一が受ける');
  for (const p of ['paddle', 'paypal']) assert.equal(checkoutProviderGate({ provider: p, mode: 'test' }).ok, true);
  assert.equal(checkoutProviderGate({ provider: 'paddle' }).ok, false, 'モード不明は受け付けない');
});

test('申込先の判定は各社の受付条件と同じ（本番は鍵なし・販売前で止まる）', () => {
  assert.equal(resolveActiveCardMode({ env: {}, origin: 'https://analytics.keiba.link' }).reason, 'paypal_key_missing');
  const PP = { PAYPAL_CLIENT_ID: 'id', PAYPAL_CLIENT_SECRET: 'secret' };
  assert.deepEqual(resolveActiveCardMode({ env: { ...PP, PAYPAL_ENV: 'live' }, origin: 'https://analytics.keiba.link' }), { ok: true, mode: 'live', apiBase: 'https://api-m.paypal.com' });
  assert.equal(resolveActiveCardMode({ env: { ...PP, PAYPAL_ENV: 'sandbox' }, origin: 'https://analytics.keiba.link' }).reason, 'test_key_on_production');
  assert.equal(resolveActiveCardMode({ env: { PADDLE_API_KEY: 'pdl_live_apikey_x' }, origin: 'https://analytics.keiba.link', active: 'paddle' }).reason, 'card_sales_not_open', 'Paddle は閉じたまま');
  assert.equal(resolveActiveCardMode({ env: {}, origin: 'https://o', active: 'none' }).reason, 'card_provider_unset');
});

test('申込は運営が選んだ 1 社だけに作り、共通入口の印（entry=card）を付ける', async () => {
  const w = world();
  const r = await run(w);
  assert.deepEqual(r, { ok: true, provider: 'paypal', url: 'https://x/paypal', orderId: 'paypal_1' });
  assert.deepEqual(w.calls, [['paypal', 'card']]);
  const [key, val, rest] = w.sets[0];
  assert.equal(key, openCheckoutKey(REC));
  assert.deepEqual(val, { provider: 'paypal', orderId: 'paypal_1', at: NOW.toISOString() });
  assert.deepEqual(rest, ['EX', String(OPEN_CHECKOUT_TTL_SEC)]);
});

test('作成に失敗しても別の決済会社へ自動で作り直さない（失敗も例外も）', async () => {
  const w = world();
  w.creators.paypal = async () => { w.calls.push(['paypal']); return { ok: false, status: 502, code: 'checkout_failed' }; };
  assert.equal((await run(w)).code, 'checkout_failed');
  assert.deepEqual(w.calls, [['paypal']]);
  assert.equal(w.sets.length, 0, '失敗した申込の印は残さない');

  const w2 = world();
  w2.creators.paypal = async () => { w2.calls.push(['paypal']); throw new Error('paypal_500'); };
  await assert.rejects(run(w2));
  assert.deepEqual(w2.calls, [['paypal']], '別の決済会社（Paddle）へ流さない');
  assert.equal(w2.sets.length, 0);
});

test('切替前の決済会社の申込が残る会員は、切替後の決済会社で申込を作れない（二重決済を作らない）', async () => {
  const w = world({ provider: 'paddle', orderId: 'txn_old', at: NOW.toISOString() });
  const r = await run(w, { active: 'paypal' });
  assert.equal(r.status, 409);
  assert.equal(r.code, 'checkout_in_progress');
  assert.equal(w.calls.length, 0);
  // 同じ決済会社なら作り直してよい（決済画面を閉じた人の再申込）
  const w2 = world({ provider: 'paddle', orderId: 'txn_old', at: NOW.toISOString() });
  assert.equal((await run(w2, { active: 'paddle' })).ok, true);
});

test('Redis が無い・読めないときは申込を作らない（印で守れないため）', async () => {
  const w = world();
  assert.equal((await run(w, { redis: null })).code, 'redis_missing');
  assert.equal((await run(w, { redis: async () => { throw new Error('down'); } })).code, 'redis_unavailable');
  assert.equal(w.calls.length, 0);
  assert.equal((await run(world(), { recordId: null })).code, 'login_required');
});

test('guard: 各社の申込作成は必ず checkoutProviderGate を通り、お客様のページは決済会社別の入口を呼ばない', () => {
  for (const f of ['paddle/paddleServer.js', 'paypal/paypalServer.js']) {
    const src = readFileSync(new URL(`./${f}`, import.meta.url), 'utf8');
    assert.match(src, /checkoutProviderGate\(\{ provider: PROVIDER, mode: mode\.mode, entry \}\)/, f);
  }
  const root = new URL('../../', import.meta.url).pathname;
  const files = [];
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); statSync(p).isDirectory() ? walk(p) : /\.(astro|js|ts|mjs)$/.test(n) && files.push(p); } };
  for (const d of ['pages', 'components', 'layouts']) walk(join(root, d));
  const direct = files.filter((p) => /(paddle-create-checkout|paypal-create-order)/.test(readFileSync(p, 'utf8')));
  assert.deepEqual(direct, [], '選択 UI・決済会社別の申込ボタンを作らない（共通入口 card-create-checkout だけ）');
});
