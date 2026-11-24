// KL・HIBI の Paddle 決済を中立サイト（checkout.tirol.link）で受ける（2026-11-24・ops/checkout-site/services.mjs・lib/servicePaddle.mjs）。
// プロトコルの正本は apol0510/keiba-live PR #57（paddleProvider.js の delegated・paddleWebhook.js・paddle-grant.js）。
// 偽の Paddle・偽のサービス（fetch は全て mock・実 Paddle / Stripe を呼ばない）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { SERVICES, SERVICE_ROUTES, planFor } from '../../../../../ops/checkout-site/services.mjs';
import { handleServiceIntent, routeServiceEvent, resolveEventService, paddleClient, SERVICE_KINDS } from '../../../../../ops/checkout-site/netlify/functions/lib/servicePaddle.mjs';
import { makeBlobStore } from '../../../../../ops/checkout-site/netlify/functions/lib/checkoutIdempotency.mjs';
import { handlePaddleWebhook } from '../../../../../ops/checkout-site/netlify/functions/paddle-webhook.mjs';
import { verifyPaddleSignature, signTsBody } from './paddleCore.js';
import { buildFiles, renderPayPage } from '../../../../../ops/checkout-site/site.mjs';

const KL_SECRET = 'kl-internal-secret-0123456789abcdef0123456789';
const HIBI_SECRET = 'hibi-internal-secret-0123456789abcdef01234567';
const AK_SECRET = 'ak-internal-secret-0123456789abcdef0123456789';
const WH_SECRET = 'pdl_ntfset_webhook_secret_0123456789';
const LIVE_KEY = 'pdl_live_apikey_01testtesttesttesttesttest';
const ENV = Object.freeze({ PADDLE_API_KEY: LIVE_KEY, KL_GRANT_INTERNAL_SECRET: KL_SECRET, HIBI_GRANT_INTERNAL_SECRET: HIBI_SECRET, CARD_GRANT_INTERNAL_SECRET: AK_SECRET, PADDLE_WEBHOOK_SECRET: WH_SECRET });
const NOW = new Date('2026-11-24T03:00:00Z');
const nowSec = () => Math.floor(Date.now() / 1000);
const PAY = 'https://checkout.tirol.link/pay/';
const API = 'https://api.paddle.com';
const BANNED = /keiba|horse|racing|betting|\bbets?\b|wager|gambl|odds|\bJRA\b|nankan|競馬|馬/i;

function fakeGetStore() {
  const m = new Map();
  const store = {
    async get(key) { const v = m.get(key); return v === undefined ? null : v; },
    async setJSON(key, val, opts) {
      if (opts && opts.onlyIfNew && m.has(key)) return { modified: false };
      m.set(key, val);
      return { modified: true };
    },
    async delete(key) { m.delete(key); },
  };
  const fn = () => store;
  fn._map = m;
  return fn;
}

const sub = (o = {}) => ({
  id: 'sub_01klsub0000000000000000', status: 'active', customer_id: 'ctm_01klctm0000000000000000',
  custom_data: { svc: 'kl', member_id: 'm_kl1', plan_code: 'PL-M' },
  items: [{ price: { id: 'pri_01nc0000000000000000000', unit_price: { amount: '2980', currency_code: 'JPY' }, billing_cycle: { interval: 'month', frequency: 1 } }, quantity: 1 }],
  scheduled_change: null, ...o,
});

/** 偽の Paddle API ＋偽のサービス。呼ばれた全リクエストを記録する */
function world({ subs = {}, txns = {}, services = {}, apiFail = false } = {}) {
  const calls = [];
  let n = 0;
  const j = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? String(init.body) : null;
    calls.push({ url: String(url), method: init.method || 'GET', headers: init.headers || {}, body });
    if (u.origin === API) {
      if (apiFail) return j(500, { error: { code: 'internal' } });
      assert.equal(init.headers.Authorization, `Bearer ${LIVE_KEY}`);
      const p = u.pathname;
      if (init.method === 'POST' && p === '/transactions') {
        n += 1;
        const id = `txn_01created${String(n).padStart(14, '0')}`;
        const b = JSON.parse(body);
        txns[id] = { id, status: 'ready', custom_data: b.custom_data, checkout: { url: `${PAY}?_ptxn=${id}` } };
        return j(201, { data: txns[id] });
      }
      let m = p.match(/^\/transactions\/(txn_[a-z0-9]+)$/);
      if (m) {
        const t = txns[m[1]];
        if (!t) return j(404, { error: { code: 'not_found' } });
        if (init.method === 'PATCH') { Object.assign(t, JSON.parse(body)); return j(200, { data: t }); }
        return j(200, { data: t });
      }
      m = p.match(/^\/subscriptions\/(sub_[a-z0-9]+)(\/cancel)?$/);
      if (m) {
        const s = subs[m[1]];
        if (!s) return j(404, { error: { code: 'not_found' } });
        if (init.method === 'PATCH') { Object.assign(s, JSON.parse(body)); return j(200, { data: s }); }
        if (m[2]) { s.scheduled_change = { action: 'cancel' }; return j(200, { data: s }); }
        return j(200, { data: s });
      }
      if (p === '/subscriptions' && init.method === 'GET') {
        const c = u.searchParams.get('customer_id');
        return j(200, { data: Object.values(subs).filter((s) => s.customer_id === c) });
      }
      m = p.match(/^\/customers\/(ctm_[a-z0-9]+)\/portal-sessions$/);
      if (m) return j(201, { data: { id: 'cpls_01x', urls: { general: { overview: `https://customer-portal.paddle.com/cpl_${m[1]}` } } } });
      return j(404, { error: { code: 'not_found' } });
    }
    const h = services[`${u.origin}${u.pathname}`];
    if (h) return h({ url: String(url), init, body });
    throw new Error(`unexpected fetch ${u.origin}${u.pathname}`);
  };
  return { fetchImpl, calls, subs, txns, apiCalls: () => calls.filter((c) => c.url.startsWith(API)) };
}

const intentReq = (svc, payload, { secret = svc === 'kl' ? KL_SECRET : HIBI_SECRET, ts = nowSec(), method = 'POST', raw } = {}) => {
  const body = raw ?? JSON.stringify({ v: 1, svc, nonce: `${Math.random().toString(16).slice(2)}0123456789abcdef`, issuedAt: ts, ...payload });
  return new Request(`https://checkout.tirol.link/.netlify/functions/${svc}-paddle`, {
    method,
    headers: { 'content-type': 'application/json', 'x-internal-signature': signTsBody({ rawBody: body, secret, nowSec: ts }) },
    ...(method === 'POST' ? { body } : {}),
  });
};
const call = async (svc, payload, w, o = {}) => {
  const res = await handleServiceIntent({ request: intentReq(svc, payload, o), env: o.env || ENV, svc: o.endpoint || svc, store: o.store || makeBlobStore(fakeGetStore()), fetchImpl: w.fetchImpl, now: new Date() });
  return { status: res.status, body: await res.json() };
};

test('表: KL は PR #57 の PADDLE_PLAN_TABLE と同じ値・HIBI は月額 5,980 円だけ・名前は中立名・戻り先は各サービスへ 302', () => {
  assert.deepEqual(SERVICES.kl.plans.map((p) => [p.planCode, p.amount, p.currency, p.interval, p.frequency, p.name]), [
    ['PL-M', '2980', 'JPY', 'month', 1, 'Live Analytics Premium Light (Monthly)'],
    ['PL-Y', '29800', 'JPY', 'year', 1, 'Live Analytics Premium Light (Annual)'],
    ['P-M', '5980', 'JPY', 'month', 1, 'Live Analytics Premium (Monthly)'],
    ['P-Y', '59800', 'JPY', 'year', 1, 'Live Analytics Premium (Annual)'],
  ]);
  assert.deepEqual(SERVICES.hibi.plans.map((p) => [p.planCode, p.amount, p.currency, p.interval, p.frequency, p.name]), [
    ['P-M', '5980', 'JPY', 'month', 1, 'Daily Analytics Premium (Monthly)'],
  ]);
  for (const s of Object.values(SERVICES)) for (const p of s.plans) assert.doesNotMatch(p.name, BANNED, p.name);
  assert.equal(SERVICES.kl.grantUrl, 'https://keiba-live.com/api/billing/paddle-grant');
  assert.equal(SERVICES.hibi.grantUrl, 'https://apolon.keibanahibi.com/api/billing/paddle-grant');
  assert.deepEqual([SERVICES.kl.secretEnv, SERVICES.hibi.secretEnv], ['KL_GRANT_INTERNAL_SECRET', 'HIBI_GRANT_INTERNAL_SECRET']);
  assert.deepEqual(SERVICE_ROUTES.map((r) => `${r.from} ${r.to} ${r.status}`), [
    '/r/kl/complete https://keiba-live.com/checkout/success 302!',
    '/r/kl/cancel https://keiba-live.com/pricing?checkout=canceled 302!',
    '/r/hibi/complete https://apolon.keibanahibi.com/checkout/success 302!',
    '/r/hibi/cancel https://apolon.keibanahibi.com/pricing?checkout=canceled 302!',
  ]);
  assert.deepEqual([...SERVICE_KINDS], ['checkout', 'checkout_status', 'checkout_cancel', 'portal', 'change_plan', 'cancel', 'resume']);
  assert.equal(planFor('hibi', 'PL-M'), null);
  assert.equal(planFor('ak', 'P-M'), null);
  assert.equal(planFor('__proto__', 'P-M'), null);
});

test('intent の認証: 405・知らないサービス 404・secret なし / 短い 503・署名不正 / 期限切れ 401・別サービスの secret は 401・svc の不一致 400・知らない kind 400・Sandbox 鍵 503', async () => {
  const w = world();
  const get = await handleServiceIntent({ request: new Request('https://checkout.tirol.link/.netlify/functions/kl-paddle'), env: ENV, svc: 'kl', fetchImpl: w.fetchImpl });
  assert.equal(get.status, 405);
  assert.equal((await call('kl', { kind: 'checkout', memberId: 'm', planCode: 'P-M' }, w, { endpoint: 'ak' })).status, 404);
  assert.equal((await call('kl', { kind: 'checkout', memberId: 'm', planCode: 'P-M' }, w, { endpoint: 'other' })).body.error, 'unknown_service');
  for (const env of [{ ...ENV, KL_GRANT_INTERNAL_SECRET: '' }, { ...ENV, KL_GRANT_INTERNAL_SECRET: 'short-secret' }, { PADDLE_API_KEY: LIVE_KEY, CARD_GRANT_INTERNAL_SECRET: AK_SECRET }]) {
    const r = await call('kl', { kind: 'checkout', memberId: 'm', planCode: 'P-M' }, w, { env });
    assert.deepEqual([r.status, r.body.error], [503, 'service_secret_missing']);
  }
  assert.equal((await call('kl', { kind: 'checkout', memberId: 'm', planCode: 'P-M' }, w, { secret: `${KL_SECRET}x` })).status, 401);
  assert.equal((await call('kl', { kind: 'checkout', memberId: 'm', planCode: 'P-M' }, w, { ts: nowSec() - 121 })).status, 401, '120 秒を超えた intent');
  // AK の secret・HIBI の secret で署名した KL の intent は通らない（secret とサービスの束縛）
  assert.equal((await call('kl', { kind: 'checkout', memberId: 'm', planCode: 'P-M' }, w, { secret: AK_SECRET })).status, 401);
  assert.equal((await call('kl', { kind: 'checkout', memberId: 'm', planCode: 'P-M' }, w, { secret: HIBI_SECRET })).status, 401);
  // HIBI の secret で正しく署名しても、本文が svc:'kl' なら HIBI の endpoint は受けない（逆も）
  const mismatch = await call('kl', { kind: 'checkout', memberId: 'm', planCode: 'P-M' }, w, { secret: HIBI_SECRET, endpoint: 'hibi' });
  assert.deepEqual([mismatch.status, mismatch.body.error], [400, 'service_mismatch']);
  const mismatch2 = await call('hibi', { kind: 'checkout', memberId: 'm', planCode: 'P-M' }, w, { secret: KL_SECRET, endpoint: 'kl' });
  assert.deepEqual([mismatch2.status, mismatch2.body.error], [400, 'service_mismatch']);
  assert.deepEqual((await call('kl', { kind: 'refund' }, w)).body.error, 'unknown_kind');
  const sbx = await call('kl', { kind: 'checkout', memberId: 'm', planCode: 'P-M' }, w, { env: { ...ENV, PADDLE_API_KEY: 'pdl_sdbx_apikey_01xxxxxxxx' } });
  assert.deepEqual([sbx.status, sbx.body.error], [503, 'paddle_not_configured']);
  const ts = nowSec();
  const raw = JSON.stringify({ svc: 'kl', kind: 'checkout' });
  const nov = await handleServiceIntent({ request: intentReq('kl', {}, { raw, ts }), env: ENV, svc: 'kl', fetchImpl: w.fetchImpl });
  assert.equal(nov.status, 400, 'v:1 の無い intent');
  assert.equal(w.apiCalls().length, 0, '拒否した intent では Paddle を呼ばない');
});

test('checkout: 非カタログ価格（JPY・税込・周期・数量 1）・custom_data {svc, member_id, plan_code}・checkout.url を送らない・/pay/?_ptxn=…&svc=… を返す', async () => {
  const w = world();
  const r = await call('kl', { kind: 'checkout', memberId: 'm_kl1', planCode: 'P-M' }, w);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.match(r.body.transactionId, /^txn_01created/);
  assert.equal(r.body.url, `${PAY}?_ptxn=${r.body.transactionId}&svc=kl`);
  const [post] = w.apiCalls().filter((c) => c.method === 'POST');
  const body = JSON.parse(post.body);
  assert.deepEqual(body, {
    items: [{ quantity: 1, price: {
      description: 'Live Analytics Premium (Monthly)', name: 'Live Analytics Premium (Monthly)',
      unit_price: { amount: '5980', currency_code: 'JPY' }, tax_mode: 'internal', billing_cycle: { interval: 'month', frequency: 1 },
      quantity: { minimum: 1, maximum: 1 }, product: { name: 'Live Analytics Premium (Monthly)', tax_category: 'standard' },
    } }],
    currency_code: 'JPY', collection_mode: 'automatic', custom_data: { svc: 'kl', member_id: 'm_kl1', plan_code: 'P-M' },
  });
  assert.equal('checkout' in body, false, 'checkout.url は送らない');
  assert.doesNotMatch(post.body, BANNED);
  const h = await call('hibi', { kind: 'checkout', memberId: 'm_h1', planCode: 'P-M' }, w);
  assert.equal(h.body.url, `${PAY}?_ptxn=${h.body.transactionId}&svc=hibi`);
  assert.equal(JSON.parse(w.apiCalls().filter((c) => c.method === 'POST')[1].body).items[0].price.name, 'Daily Analytics Premium (Monthly)');
  // HIBI のカードは月額だけ・表に無いプランは 400（Paddle を呼ばない）
  for (const planCode of ['PL-M', 'P-6', 'P-12', '']) assert.deepEqual((await call('hibi', { kind: 'checkout', memberId: 'm_h1', planCode }, w)).body.error, 'unknown_plan', planCode);
  assert.equal((await call('kl', { kind: 'checkout', memberId: 'bad id!', planCode: 'P-M' }, w)).body.error, 'invalid_member');
  // intent の金額・名前は使わない
  await call('kl', { kind: 'checkout', memberId: 'm_kl2', planCode: 'PL-M', amount: '1', name: 'x' }, w);
  assert.equal(JSON.parse(w.apiCalls().filter((c) => c.method === 'POST').at(-1).body).items[0].price.unit_price.amount, '2980');
});

test('checkout: Default payment link 以外の URL は 502 checkout_url_mismatch（使わない）', async () => {
  for (const url of ['https://keiba-live.com/pay?_ptxn=X', 'https://analytics.keiba.link/checkout/paddle/?_ptxn=X', 'https://checkout.tirol.link/pay/?_ptxn=txn_01otherxxxxxxxxxxx', null]) {
    const w = world();
    const base = w.fetchImpl;
    const f = async (u, init) => {
      const res = await base(u, init);
      if (String(u) === `${API}/transactions` && init.method === 'POST') {
        const d = (await res.json()).data;
        d.checkout = url ? { url: url.replace('X', d.id) } : null;
        return new Response(JSON.stringify({ data: d }), { status: 201 });
      }
      return res;
    };
    const r = await handleServiceIntent({ request: intentReq('kl', { kind: 'checkout', memberId: 'm', planCode: 'P-M' }), env: ENV, svc: 'kl', store: makeBlobStore(fakeGetStore()), fetchImpl: f });
    assert.deepEqual([r.status, (await r.json()).error], [502, 'checkout_url_mismatch'], String(url));
  }
});

test('checkout の冪等化: 同じ nonce の再送・別 nonce の二重クリックは同じ取引・別プランは別・サービスごとに名前空間・取消し / 支払い済みの取引は使い回さない', async () => {
  const gs = fakeGetStore();
  const store = makeBlobStore(gs);
  const w = world();
  const ts = nowSec();
  const raw = JSON.stringify({ v: 1, svc: 'kl', kind: 'checkout', nonce: 'nonce-0123456789abcdef', issuedAt: ts, memberId: 'm1', planCode: 'P-M' });
  const send = async (svc, rawBody, secret) => (await handleServiceIntent({ request: intentReq(svc, {}, { raw: rawBody, ts, secret }), env: ENV, svc, store, fetchImpl: w.fetchImpl })).json();
  const a = await send('kl', raw, KL_SECRET);
  const b = await send('kl', raw, KL_SECRET);
  assert.equal(a.transactionId, b.transactionId, '同じ intent の再送');
  const c = await call('kl', { kind: 'checkout', memberId: 'm1', planCode: 'P-M' }, w, { store });
  assert.equal(c.body.transactionId, a.transactionId, '別 nonce の二重クリック');
  const d = await call('kl', { kind: 'checkout', memberId: 'm1', planCode: 'PL-M' }, w, { store });
  assert.notEqual(d.body.transactionId, a.transactionId, '別プラン');
  // 同じ会員 ID・同じプランコードでも HIBI は別の取引（キーは svc で分ける）
  const hraw = raw.replace('"svc":"kl"', '"svc":"hibi"');
  const h = await send('hibi', hraw, HIBI_SECRET);
  assert.notEqual(h.transactionId, a.transactionId);
  assert.equal(w.apiCalls().filter((x) => x.method === 'POST').length, 3);
  const keys = [...gs._map.keys()];
  assert.ok(keys.includes('idem:kl:m1:P-M') && keys.includes('idem:hibi:m1:P-M') && keys.includes('nonce:kl:nonce-0123456789abcdef'), keys.join(','));
  assert.ok(keys.every((k) => /^(idem|nonce):(kl|hibi):/.test(k)), 'AK のキー（idem:rec…）と混ざらない');
  // 取消し（checkout_cancel）のあと同じプランへ戻ると新しい取引
  const cancel = await call('kl', { kind: 'checkout_cancel', transactionId: a.transactionId }, w, { store });
  assert.deepEqual(cancel.body, { ok: true, canceled: true });
  assert.equal(w.txns[a.transactionId].status, 'canceled');
  const e = await call('kl', { kind: 'checkout', memberId: 'm1', planCode: 'P-M' }, w, { store });
  assert.notEqual(e.body.transactionId, a.transactionId);
  // 支払い済みになった取引も使い回さない（予約を外して作り直す）
  w.txns[e.body.transactionId].status = 'completed';
  const f = await call('kl', { kind: 'checkout', memberId: 'm1', planCode: 'P-M' }, w, { store });
  assert.notEqual(f.body.transactionId, e.body.transactionId);
  assert.equal(w.txns[f.body.transactionId].status, 'ready');
});

test('checkout_status / checkout_cancel: 自サービスの取引だけ（HIBI・AK の取引は 403・PATCH しない）', async () => {
  const w = world({ txns: {
    txn_01klopen000000000000: { id: 'txn_01klopen000000000000', status: 'ready', custom_data: { svc: 'kl', member_id: 'm1', plan_code: 'P-M' } },
    txn_01kldone000000000000: { id: 'txn_01kldone000000000000', status: 'completed', custom_data: { svc: 'kl', member_id: 'm1', plan_code: 'P-M' } },
    txn_01hibi00000000000000: { id: 'txn_01hibi00000000000000', status: 'ready', custom_data: { svc: 'hibi', member_id: 'm1', plan_code: 'P-M' } },
    txn_01ak0000000000000000: { id: 'txn_01ak0000000000000000', status: 'ready', custom_data: { ak_record: 'recAAAAAAAAAAAAAA', ak_sub: 'A' } },
  } });
  assert.deepEqual((await call('kl', { kind: 'checkout_status', transactionId: 'txn_01klopen000000000000' }, w)).body, { ok: true, status: 'open', memberId: 'm1' });
  assert.deepEqual((await call('kl', { kind: 'checkout_status', transactionId: 'txn_01kldone000000000000' }, w)).body, { ok: true, status: 'complete', memberId: 'm1' });
  for (const t of ['txn_01hibi00000000000000', 'txn_01ak0000000000000000']) {
    assert.deepEqual((await call('kl', { kind: 'checkout_status', transactionId: t }, w)).status, 403);
    assert.deepEqual((await call('kl', { kind: 'checkout_cancel', transactionId: t }, w)).body.error, 'transaction_mismatch');
  }
  assert.equal(w.apiCalls().filter((c) => c.method === 'PATCH').length, 0);
  assert.deepEqual((await call('kl', { kind: 'checkout_cancel', transactionId: 'txn_01kldone000000000000' }, w)).body, { ok: true, canceled: false }, '支払い済みは取り消さない');
  assert.equal(w.apiCalls().filter((c) => c.method === 'PATCH').length, 0);
  assert.equal((await call('kl', { kind: 'checkout_status', transactionId: 'nope' }, w)).body.error, 'invalid_transaction');
});

test('購読の操作（change_plan・cancel・resume・portal）: custom_data の svc と member_id が一致する購読だけ・他の会員 / HIBI / AK の購読は 403 で触らない', async () => {
  const S = 'sub_01klsub0000000000000000';
  const others = {
    sub_01othermember000000000: sub({ id: 'sub_01othermember000000000', custom_data: { svc: 'kl', member_id: 'm_other', plan_code: 'PL-M' } }),
    sub_01hibisub0000000000000: sub({ id: 'sub_01hibisub0000000000000', custom_data: { svc: 'hibi', member_id: 'm_kl1', plan_code: 'P-M' } }),
    sub_01aksub000000000000000: sub({ id: 'sub_01aksub000000000000000', custom_data: { ak_record: 'recAAAAAAAAAAAAAA', ak_sub: 'A' } }),
  };
  const w = world({ subs: { [S]: sub(), ...others } });
  for (const id of Object.keys(others)) {
    for (const p of [{ kind: 'change_plan', planCode: 'P-M' }, { kind: 'cancel', atPeriodEnd: false }, { kind: 'resume' }]) {
      const r = await call('kl', { ...p, memberId: 'm_kl1', subscriptionId: id }, w);
      assert.deepEqual([r.status, r.body.error], [403, 'subscription_mismatch'], `${id} ${p.kind}`);
    }
  }
  assert.equal((await call('kl', { kind: 'cancel', memberId: null, subscriptionId: S }, w)).body.error, 'invalid_member');
  assert.equal(w.apiCalls().filter((c) => c.method !== 'GET').length, 0, '他人の購読へ書かない');

  // change_plan: 予約中の解約を先に外す → 非カタログ価格と custom_data.plan_code を同時に更新（サービスの webhook の照合と一致）
  w.subs[S].scheduled_change = { action: 'cancel' };
  const ch = await call('kl', { kind: 'change_plan', memberId: 'm_kl1', subscriptionId: S, planCode: 'P-M' }, w);
  assert.deepEqual(ch.body, { ok: true, changed: true });
  const patches = w.apiCalls().filter((c) => c.method === 'PATCH').map((c) => JSON.parse(c.body));
  assert.deepEqual(patches[0], { scheduled_change: null });
  assert.equal(patches[1].proration_billing_mode, 'prorated_immediately');
  assert.deepEqual(patches[1].custom_data, { svc: 'kl', member_id: 'm_kl1', plan_code: 'P-M' });
  assert.deepEqual([patches[1].items[0].price.unit_price, patches[1].items[0].price.billing_cycle, patches[1].items[0].price.tax_mode], [{ amount: '5980', currency_code: 'JPY' }, { interval: 'month', frequency: 1 }, 'internal']);
  assert.equal((await call('kl', { kind: 'change_plan', memberId: 'm_kl1', subscriptionId: S, planCode: 'XX' }, w)).body.error, 'unknown_plan');

  // cancel: 期末（next_billing_period）/ 即時（immediately）
  await call('kl', { kind: 'cancel', memberId: 'm_kl1', subscriptionId: S, atPeriodEnd: true }, w);
  await call('kl', { kind: 'cancel', memberId: 'm_kl1', subscriptionId: S, atPeriodEnd: false }, w);
  const cancels = w.apiCalls().filter((c) => c.url.endsWith('/cancel')).map((c) => JSON.parse(c.body).effective_from);
  assert.deepEqual(cancels, ['next_billing_period', 'immediately']);
  // resume: 予約中の解約があるときだけ外す
  const before = w.apiCalls().filter((c) => c.method === 'PATCH').length;
  assert.deepEqual((await call('kl', { kind: 'resume', memberId: 'm_kl1', subscriptionId: S }, w)).body, { ok: true, resumed: true });
  assert.deepEqual(JSON.parse(w.apiCalls().filter((c) => c.method === 'PATCH').at(-1).body), { scheduled_change: null });
  assert.deepEqual((await call('kl', { kind: 'resume', memberId: 'm_kl1', subscriptionId: S }, w)).body, { ok: true, resumed: false });
  assert.equal(w.apiCalls().filter((c) => c.method === 'PATCH').length, before + 1);

  // portal: 顧客の購読に本人のものがあるときだけ・その購読だけを渡す
  const pr = await call('kl', { kind: 'portal', memberId: 'm_kl1', customerId: 'ctm_01klctm0000000000000000' }, w);
  assert.deepEqual(pr.body, { ok: true, url: 'https://customer-portal.paddle.com/cpl_ctm_01klctm0000000000000000' });
  assert.deepEqual(JSON.parse(w.apiCalls().find((c) => c.url.includes('portal-sessions')).body), { subscription_ids: [S] });
  const pm = await call('kl', { kind: 'portal', memberId: 'm_nobody', customerId: 'ctm_01klctm0000000000000000' }, w);
  assert.deepEqual([pm.status, pm.body.error], [403, 'customer_mismatch']);
  const ph = await call('hibi', { kind: 'portal', memberId: 'm_other', customerId: 'ctm_01klctm0000000000000000' }, w);
  assert.deepEqual([ph.status, ph.body.error], [403, 'customer_mismatch'], 'HIBI から KL の会員の顧客は開けない');
  // Paddle の失敗は 502（本文・鍵は出さない）
  const down = world({ apiFail: true });
  const e = await call('kl', { kind: 'cancel', memberId: 'm_kl1', subscriptionId: S }, down);
  assert.deepEqual(e, { status: 502, body: { ok: false, error: 'paddle_error' } });
});

// ------------------------------------------------------------------------------------------------ 通知の振り分け

const pe = (type, data, id = 'evt_01test000000000000000000') => ({ event_id: id, event_type: type, occurred_at: NOW.toISOString(), notification_id: 'ntf_01x', data });
const whReq = (raw, secret = WH_SECRET) => new Request('https://checkout.tirol.link/hooks/paddle', { method: 'POST', headers: { 'content-type': 'application/json', 'paddle-signature': signTsBody({ rawBody: raw, secret }) }, body: raw });
const svcWorld = (o = {}, status = { kl: 200, hibi: 200 }) => {
  const got = { kl: [], hibi: [], ak: [] };
  const mk = (k) => ({ body, init }) => { got[k].push({ body, sig: init.headers['x-internal-signature'] }); return new Response('{"received":true}', { status: typeof status[k] === 'function' ? status[k]() : status[k] }); };
  const w = world({ ...o, services: {
    [SERVICES.kl.grantUrl]: mk('kl'),
    [SERVICES.hibi.grantUrl]: mk('hibi'),
    'https://analytics.keiba.link/.netlify/functions/internal-paddle-grant': mk('ak'),
  } });
  return { w, got };
};
const wh = async (w, payload, env = ENV) => {
  const raw = JSON.stringify(payload);
  const res = await handlePaddleWebhook({ request: whReq(raw), env, fetchImpl: w.fetchImpl });
  return { status: res.status, body: await res.json(), raw };
};

test('webhook: svc=kl / hibi の event は本文を変えずにそのサービスへ・そのサービスの secret で署名（他の secret では通らない）・AK の付与へは送らない', async () => {
  const { w, got } = svcWorld();
  const kl = await wh(w, pe('subscription.created', sub()));
  assert.deepEqual([kl.status, kl.body], [200, { received: true }]);
  assert.equal(got.kl.length, 1);
  assert.equal(got.kl[0].body, kl.raw, '本文はそのまま（再直列化しない）');
  assert.equal(verifyPaddleSignature({ header: got.kl[0].sig, rawBody: kl.raw, secret: KL_SECRET, toleranceSec: 300 }), true);
  for (const s of [HIBI_SECRET, AK_SECRET, WH_SECRET]) assert.equal(verifyPaddleSignature({ header: got.kl[0].sig, rawBody: kl.raw, secret: s, toleranceSec: 300 }), false);
  const hibiTxn = { id: 'txn_01hibitxn0000000000000', subscription_id: 'sub_01hibisub0000000000000', origin: 'web', status: 'completed', custom_data: { svc: 'hibi', member_id: 'h1', plan_code: 'P-M' } };
  const hb = await wh(w, pe('transaction.completed', hibiTxn));
  assert.equal(hb.status, 200);
  assert.equal(got.hibi.length, 1);
  assert.equal(got.hibi[0].body, hb.raw);
  assert.equal(verifyPaddleSignature({ header: got.hibi[0].sig, rawBody: hb.raw, secret: HIBI_SECRET, toleranceSec: 300 }), true);
  assert.equal(verifyPaddleSignature({ header: got.hibi[0].sig, rawBody: hb.raw, secret: KL_SECRET, toleranceSec: 300 }), false);
  assert.deepEqual([got.kl.length, got.ak.length], [1, 0]);
  assert.equal(w.apiCalls().length, 0, '印がある event は照会しない');
  // Paddle の署名が不正なら何もしない（転送しない）
  const raw = JSON.stringify(pe('subscription.created', sub()));
  assert.equal((await handlePaddleWebhook({ request: whReq(raw, 'wrong-secret-xxxxxxxxxxxx'), env: ENV, fetchImpl: w.fetchImpl })).status, 401);
  assert.equal(got.kl.length, 1);
});

test('webhook: サービスの応答 200 / 400 → 200（400 はログ）・5xx / 到達不能 → 500（Paddle が再送）・secret なし → 500 で送らない（fail closed）', async () => {
  for (const [st, want] of [[200, 200], [400, 200], [413, 200], [500, 500], [503, 500]]) {
    const { w, got } = svcWorld({}, { kl: st, hibi: 200 });
    const r = await wh(w, pe('subscription.updated', sub()));
    assert.equal(r.status, want, String(st));
    assert.equal(got.kl.length, 1);
  }
  const { w } = svcWorld({}, { kl: () => { throw new Error(`ECONNREFUSED ${KL_SECRET}`); } });
  const down = await wh(w, pe('subscription.updated', sub()));
  assert.deepEqual([down.status, down.body.error], [500, 'service_unreachable']);
  assert.equal(JSON.stringify(down.body).includes(KL_SECRET), false);
  for (const env of [{ ...ENV, KL_GRANT_INTERNAL_SECRET: undefined }, { ...ENV, KL_GRANT_INTERNAL_SECRET: 'short' }]) {
    const s = svcWorld();
    const r = await wh(s.w, pe('subscription.updated', sub()), env);
    assert.deepEqual([r.status, r.body.error], [500, 'service_secret_missing']);
    assert.equal(s.got.kl.length + s.got.ak.length + s.got.hibi.length, 0);
  }
  // HIBI の secret が無くても KL の転送は通る（サービスごとに独立）
  const s2 = svcWorld();
  assert.equal((await wh(s2.w, pe('subscription.updated', sub()), { ...ENV, HIBI_GRANT_INTERNAL_SECRET: undefined })).status, 200);
});

test('webhook: 本文に印の無い購読・更新の取引・返金は照会して振り分ける・照会の失敗は 500（AK へ誤って入れない）・知らない svc は 200 で無視', async () => {
  const S = 'sub_01klsub0000000000000000';
  const { w, got } = svcWorld({ subs: { [S]: sub() }, txns: { txn_01klpaid0000000000000: { id: 'txn_01klpaid0000000000000', subscription_id: S, custom_data: null } } });
  assert.equal((await wh(w, pe('subscription.past_due', { ...sub(), custom_data: null }))).status, 200);
  assert.equal((await wh(w, pe('transaction.completed', { id: 'txn_01klrenew000000000000', subscription_id: S, origin: 'subscription_recurring', custom_data: null }))).status, 200);
  assert.equal((await wh(w, pe('adjustment.created', { id: 'adj_01kladj0000000000000000', transaction_id: 'txn_01klpaid0000000000000' }))).status, 200);
  assert.equal(got.kl.length, 3);
  assert.equal(got.ak.length, 0);
  const fail = svcWorld({ apiFail: true });
  const r = await wh(fail.w, pe('subscription.canceled', { ...sub(), custom_data: null }));
  assert.deepEqual([r.status, r.body.error], [500, 'lookup_failed']);
  assert.equal(fail.got.kl.length + fail.got.ak.length, 0);
  const unk = svcWorld();
  const u = await wh(unk.w, pe('subscription.created', sub({ custom_data: { svc: 'other', member_id: 'm' } })));
  assert.deepEqual([u.status, u.body.ignored], [200, 'unknown_service']);
  assert.equal(unk.got.kl.length + unk.got.hibi.length + unk.got.ak.length, 0);
  assert.equal(unk.w.apiCalls().length, 0);
});

test('webhook: AK の event（ak_* の印・印なしで照会しても AK）は KL・HIBI へ送らず従来の処理へ', async () => {
  const AKSUB = 'sub_01aksub000000000000000';
  const akSub = sub({ id: AKSUB, custom_data: { ak_record: 'recAAAAAAAAAAAAAA', ak_sub: 'A' }, items: [{ price: { unit_price: { amount: '4980', currency_code: 'JPY' }, billing_cycle: { interval: 'month', frequency: 1 } }, quantity: 1 }],
    current_billing_period: { starts_at: '2026-11-24T00:00:00Z', ends_at: '2026-12-24T00:00:00Z' } });
  const api = paddleClient({ key: LIVE_KEY, fetchImpl: world({ subs: { [AKSUB]: akSub } }).fetchImpl });
  for (const p of [
    pe('transaction.completed', { id: 'txn_01aktxn0000000000000', custom_data: { ak_record: 'recAAAAAAAAAAAAAA', ak_product: 'premium-annual' } }),
    pe('subscription.updated', akSub),
    pe('subscription.updated', { ...akSub, custom_data: null }),
    pe('transaction.paid', { id: 'txn_01aktxn0000000000001', subscription_id: AKSUB, custom_data: null }),
    pe('transaction.completed', { id: 'txn_01aktxn0000000000002', custom_data: null }),
    pe('customer.updated', { id: 'ctm_01x' }),
  ]) {
    assert.deepEqual(await resolveEventService({ payload: p, api }), { route: 'ak' }, p.event_type);
  }
  // 鍵が無い（照会できない）ときは従来どおり AK の処理へ
  assert.deepEqual(await resolveEventService({ payload: pe('subscription.updated', { ...akSub, custom_data: null }), api: null }), { route: 'ak' });
  assert.equal(await routeServiceEvent({ raw: 'not json', env: ENV, fetchImpl: async () => { throw new Error('no'); } }), null);
  // 実 handler: AK の購読 event は Paddle を照会して AK の内部付与へだけ届く（KL・HIBI へは 0 件）
  const { w, got } = svcWorld({ subs: { [AKSUB]: akSub } });
  const r = await wh(w, pe('subscription.updated', akSub));
  assert.equal(r.status, 200);
  assert.deepEqual([got.ak.length, got.kl.length, got.hibi.length], [1, 0, 0]);
  assert.equal(JSON.parse(got.ak[0].body).apply.kind, 'subscription', 'AK の購読の写しは従来どおり AK の内部付与へ');
  for (const c of w.calls) assert.match(c.url, /^https:\/\/(api\.paddle\.com|analytics\.keiba\.link)\//, c.url);
  for (const c of w.calls.filter((x) => x.url.startsWith('https://analytics.keiba.link/'))) {
    assert.equal(verifyPaddleSignature({ header: c.headers['x-internal-signature'], rawBody: c.body, secret: AK_SECRET, toleranceSec: 300 }), true, 'AK の付与は従来どおり AK の secret');
  }
  // AK の一回払いの event も KL・HIBI へは送らない
  const one = svcWorld();
  await wh(one.w, pe('transaction.completed', { id: 'txn_01aktxn0000000000000', custom_data: { ak_record: 'recAAAAAAAAAAAAAA', ak_product: 'premium-annual' } }));
  assert.deepEqual([one.got.kl.length, one.got.hibi.length], [0, 0]);
});

test('決済ページ /pay/: svc=kl|hibi は /r/<svc>/complete・閉じたら /r/<svc>/cancel・`_redirects` で各サービスへ・画面の文言は増やさない', () => {
  const TOKEN = 'live_0123456789abcdef0123456789a';
  const h = renderPayPage({ paddleClientToken: TOKEN });
  assert.match(h, /"kl":\{"complete":"\/r\/kl\/complete","cancel":"\/r\/kl\/cancel"\}/);
  assert.match(h, /"hibi":\{"complete":"\/r\/hibi\/complete","cancel":"\/r\/hibi\/cancel"\}/);
  assert.match(h, /Object\.prototype\.hasOwnProperty\.call\(routes, sv\)/);
  assert.match(h, /successUrl: location\.origin \+ svc\.complete/);
  assert.match(h, /checkout\.closed' && !completed\) location\.href = svc\.cancel/);
  assert.doesNotMatch(h, /keiba-live|keibanahibi/, 'サービスのドメインはページに出さない（302 は _redirects）');
  const strip = (x) => x.replace(/<script>[\s\S]*<\/script>/, '');
  assert.equal(strip(h), strip(renderPayPage({ paddleClientToken: TOKEN, services: false })), '本文は同じ（文言を増やさない）');
  const redirects = buildFiles({ paddleClientToken: TOKEN })._redirects;
  for (const r of SERVICE_ROUTES) assert.ok(redirects.includes(`${r.from}  ${r.to}  ${r.status}\n`), r.from);
});

test('ログ・応答に secret・会員のメールを出さない', async () => {
  const lines = [];
  const orig = [console.log, console.error];
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try {
    const { w } = svcWorld({}, { kl: 400 });
    await wh(w, pe('subscription.updated', sub({ customer: { email: 'buyer@example.com' } })));
    await call('kl', { kind: 'checkout', memberId: 'm1', planCode: 'P-M', email: 'buyer@example.com' }, world());
  } finally { [console.log, console.error] = orig; }
  const all = lines.join('\n');
  for (const s of [KL_SECRET, HIBI_SECRET, AK_SECRET, WH_SECRET, LIVE_KEY, 'buyer@example.com']) assert.equal(all.includes(s), false, s);
  assert.ok(all.includes('svc_paddle_webhook_4xx'));
  // 署名の形（ts=…;h1=…・ts:rawBody）が KL の paddleSignature.js と同じ
  const raw = '{"a":1}';
  const sig = signTsBody({ rawBody: raw, secret: KL_SECRET, nowSec: 1764000000 });
  assert.equal(sig, `ts=1764000000;h1=${createHmac('sha256', KL_SECRET).update(`1764000000:${raw}`).digest('hex')}`);
});

test('HIBI のカムバック（offer:comeback）: HIBI・P-M だけ discount_id を付ける（単価は 5,980 のまま）・他のサービス / プラン / 知らない offer は 400・env なしは 503（通常料金で黙って請求しない）・冪等化のキーを分ける', async () => {
  const DSC = 'dsc_01comeback000000000000';
  const env = { ...ENV, HIBI_PADDLE_DISCOUNT_COMEBACK: DSC };
  const gs = fakeGetStore();
  const store = makeBlobStore(gs);
  const w = world();
  const cb = await call('hibi', { kind: 'checkout', memberId: 'h1', planCode: 'P-M', offer: 'comeback' }, w, { env, store });
  assert.equal(cb.status, 200);
  assert.equal(cb.body.offerApplied, true);
  const posts = () => w.apiCalls().filter((c) => c.method === 'POST').map((c) => JSON.parse(c.body));
  assert.equal(posts()[0].discount_id, DSC);
  assert.equal(posts()[0].items[0].price.unit_price.amount, '5980', '単価は通常料金（2 回目以降 5,980 円）');
  assert.deepEqual(posts()[0].custom_data, { svc: 'hibi', member_id: 'h1', plan_code: 'P-M' });
  // 同じ会員・同じプランでも特典の有無が違えば別の取引（通常料金の取引を特典で使い回さない・逆も）
  const normal = await call('hibi', { kind: 'checkout', memberId: 'h1', planCode: 'P-M' }, w, { env, store });
  assert.notEqual(normal.body.transactionId, cb.body.transactionId);
  assert.equal('discount_id' in posts()[1], false);
  assert.equal(normal.body.offerApplied, undefined);
  const again = await call('hibi', { kind: 'checkout', memberId: 'h1', planCode: 'P-M', offer: 'comeback' }, w, { env, store });
  assert.equal(again.body.transactionId, cb.body.transactionId, '特典付きの二重クリックは同じ取引');
  assert.ok(gs._map.has('idem:hibi:h1:P-M:comeback') && gs._map.has('idem:hibi:h1:P-M'));
  // 取り消せば特典付きの予約も外れる
  await call('hibi', { kind: 'checkout_cancel', transactionId: cb.body.transactionId }, w, { env, store });
  assert.equal(gs._map.has('idem:hibi:h1:P-M:comeback'), false);
  const n = posts().length;
  for (const [svc, planCode, offer] of [['kl', 'P-M', 'comeback'], ['kl', 'PL-M', 'comeback'], ['hibi', 'P-M', 'other'], ['hibi', 'P-M', '__proto__'], ['hibi', 'P-M', ''], ['hibi', 'P-M', 1]]) {
    const r = await call(svc, { kind: 'checkout', memberId: 'h1', planCode, offer }, w, { env: { ...env, KL_PADDLE_DISCOUNT_COMEBACK: DSC } });
    assert.deepEqual([r.status, r.body.error], [400, 'invalid_offer'], `${svc} ${planCode} ${offer}`);
  }
  for (const e of [{ ...ENV }, { ...ENV, HIBI_PADDLE_DISCOUNT_COMEBACK: '' }, { ...ENV, HIBI_PADDLE_DISCOUNT_COMEBACK: 'not-a-discount' }]) {
    const r = await call('hibi', { kind: 'checkout', memberId: 'h1', planCode: 'P-M', offer: 'comeback' }, w, { env: e });
    assert.deepEqual([r.status, r.body.error], [503, 'offer_not_configured']);
  }
  assert.equal(posts().length, n, '拒否した offer では取引を作らない');
});
