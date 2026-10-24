/**
 * paddleCheckoutDelegation.test.mjs — 分離案 B の「取引作成」側の検証。
 * 本番サイト（鍵なし・資格確認）→ 分離サイト（鍵あり・取引作成）の委譲が、
 *  - 直接（鍵がローカルにある本番呼び出し）と同じ取引本文になり、
 *  - 金額・通貨・商品名はサーバー（カタログ）だけが決め（クライアント改ざん不可）、
 *  - 署名が無い/誤り/期限切れ（リプレイ）の intent を弾き、
 *  - 会員資格（買い切り等）は本番で先に止めて分離サイトを呼ばない、
 *  - CARD_SALES_OPEN.paddle=false の間は分離サイトの実関数が fail closed になる
 * ことを確かめる。ネットワークには出ない（偽の Paddle API / Airtable）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPaddleCheckout, createPaddleTransaction } from './paddleServer.js';
import { signTsBody, verifyPaddleSignature } from './paddleCore.js';
import { PRODUCTION_ORIGIN } from '../cardSales.js';
import { PADDLE_CHECKOUT_CREATE_URL, PADDLE_LIVE_PAYMENT_LINK } from '../neutralCheckoutHost.js';
import sepCreateHandler from '../../../../../ops/checkout-site/netlify/functions/paddle-create-checkout.mjs';

const PROD = PRODUCTION_ORIGIN;
const REC = 'recAAAAAAAAAAAAAA';
const LIVE_KEY = 'pdl_live_apikey_TESTONLY';
const SECRET = 'internal-secret-0123456789abcdef0123456789abcdef';
// 本番サイト（鍵なし・内部 secret あり）＝委譲元。分離サイト（鍵あり・内部 secret あり）＝委譲先。
const MAIN_ENV = { AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'appX', CARD_GRANT_INTERNAL_SECRET: SECRET };
const SEP_ENV = { PADDLE_API_KEY: LIVE_KEY, CARD_GRANT_INTERNAL_SECRET: SECRET, AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'appX' };

function world({ fields = { 'プラン': 'Free', Email: 'a+card-e2e@example.com' }, salesOpen = true, sepSecret = SECRET } = {}) {
  const st = { fields: { ...fields }, salesOpen, sepSecret, createBodies: [], sepCalls: 0, txns: {} };
  const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  let n = 0;
  st.fetch = async (url, init = {}) => {
    const u = new URL(url);
    // 本番サイト → 分離サイトの取引作成（署名検証 → 分離サイト core を呼ぶ）
    if (`${u.origin}${u.pathname}` === PADDLE_CHECKOUT_CREATE_URL) {
      st.sepCalls += 1;
      const raw = init.body;
      const header = (init.headers || {})['x-internal-signature'] || '';
      if (!verifyPaddleSignature({ header, rawBody: raw, secret: st.sepSecret, toleranceSec: 120 })) return res(401, { error: 'invalid_signature' });
      const intent = JSON.parse(raw);
      if (String(intent.origin) !== PROD) return res(400, { error: 'origin_mismatch' });
      const r = await createPaddleTransaction({
        env: SEP_ENV, origin: PROD, recordId: String(intent.recordId || ''), productId: String(intent.productId || ''),
        entry: intent.entry === 'card' ? 'card' : 'direct', salesOpen: st.salesOpen, fetchImpl: st.fetch,
      });
      return r.ok ? res(200, { url: r.url, transactionId: r.transactionId }) : res(r.status || 502, { error: r.code });
    }
    if (u.host === 'api.airtable.com') return res(200, { id: REC, fields: st.fields });
    if (u.host === 'api.paddle.com' && u.pathname === '/transactions' && init.method === 'POST') {
      const b = JSON.parse(init.body); st.createBodies.push(b); n += 1;
      const id = `txn_${String(n).padStart(2, '0')}abcdefghijklmnopqrst`;
      st.txns[id] = { id, checkout: { url: `${PADDLE_LIVE_PAYMENT_LINK}?_ptxn=${id}` } };
      return res(201, { data: st.txns[id] });
    }
    return res(404, {});
  };
  return st;
}

test('委譲: 本番（鍵なし）→ 分離サイト で、直接（鍵あり）と同じ取引本文になる', async () => {
  const direct = world();
  const rDirect = await createPaddleCheckout({ env: SEP_ENV, origin: PROD, recordId: REC, productId: 'premium-annual', entry: 'card', salesOpen: true, fetchImpl: direct.fetch });
  assert.equal(rDirect.ok, true, JSON.stringify(rDirect));
  assert.equal(direct.sepCalls, 0, '鍵がローカルにあるので委譲しない');

  const del = world();
  const rDel = await createPaddleCheckout({ env: MAIN_ENV, origin: PROD, recordId: REC, productId: 'premium-annual', entry: 'card', salesOpen: true, fetchImpl: del.fetch });
  assert.equal(rDel.ok, true, JSON.stringify(rDel));
  assert.equal(del.sepCalls, 1, '鍵が無いので分離サイトへ委譲する');

  assert.deepEqual(del.createBodies[0], direct.createBodies[0], '委譲でも取引本文が同一');
  assert.match(rDel.url, /^https:\/\/checkout\.tirol\.link\/pay\/\?_ptxn=txn_/);
  assert.match(rDel.transactionId, /^txn_/);
});

test('改ざん不可: 金額・通貨・商品名はサーバー（カタログ）だけが決める（intent に金額は無い）', async () => {
  const del = world();
  const r = await createPaddleCheckout({ env: MAIN_ENV, origin: PROD, recordId: REC, productId: 'premium-annual', entry: 'card', salesOpen: true, fetchImpl: del.fetch });
  assert.equal(r.ok, true, JSON.stringify(r));
  const body = del.createBodies[0];
  assert.equal(body.currency_code, 'JPY');
  assert.equal(body.items[0].price.unit_price.amount, '49800', 'カタログの金額（会員限定でない通常年払い）');
  assert.equal(body.items[0].price.unit_price.currency_code, 'JPY');
  assert.deepEqual(body.custom_data, { ak_record: REC, ak_product: 'premium-annual' }, 'custom_data は recordId と商品 ID だけ');
});

test('会員限定価格: 鍵を持つ側は fields なしでも premium-annual-light を弾かない（資格は委譲元が確認済み）', async () => {
  // createPaddleTransaction（分離サイト core）は商品カタログだけ見る。会員限定の判定を fields:null で再実行しない。
  const w = world();
  const r = await createPaddleTransaction({ env: SEP_ENV, origin: PROD, recordId: REC, productId: 'premium-annual-light', entry: 'card', salesOpen: true, fetchImpl: w.fetch });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(w.createBodies[0].items[0].price.unit_price.amount, '44820', 'Light 会員特典価格（カタログ）');
  // 買い切りはカード不可（fail closed）
  const r2 = await createPaddleTransaction({ env: SEP_ENV, origin: PROD, recordId: REC, productId: 'premium-lifetime', entry: 'card', salesOpen: true, fetchImpl: w.fetch });
  assert.equal(r2.code, 'lifetime_bank_transfer_only');
});

test('署名: 誤った内部 secret の intent は分離サイトが 401 → 委譲元は 502（別社へ作り直さない）', async () => {
  const del = world({ sepSecret: 'different-secret-than-main' });
  const r = await createPaddleCheckout({ env: MAIN_ENV, origin: PROD, recordId: REC, productId: 'premium-annual', entry: 'card', salesOpen: true, fetchImpl: del.fetch });
  assert.equal(r.ok, false);
  assert.equal(r.status, 502);
  assert.equal(r.code, 'checkout_failed');
  assert.equal(del.createBodies.length, 0, '取引は作られない');
});

test('リプレイ防止: 期限切れ（短窓超過）の署名は弾く', () => {
  const body = JSON.stringify({ v: 1, recordId: REC, productId: 'premium-annual', origin: PROD });
  const old = Math.floor(Date.now() / 1000) - 300; // 120 秒窓を超える
  const header = signTsBody({ rawBody: body, secret: SECRET, nowSec: old });
  assert.equal(verifyPaddleSignature({ header, rawBody: body, secret: SECRET, toleranceSec: 120 }), false, '期限切れは通さない');
  const fresh = signTsBody({ rawBody: body, secret: SECRET });
  assert.equal(verifyPaddleSignature({ header: fresh, rawBody: body, secret: SECRET, toleranceSec: 120 }), true, '新しい署名は通る');
  assert.equal(verifyPaddleSignature({ header: fresh, rawBody: `${body} `, secret: SECRET, toleranceSec: 120 }), false, '本文改ざんは通さない');
});

test('資格は本番で先に止める: 買い切り会員は分離サイトを呼ばずに 409', async () => {
  const del = world({ fields: { 'プラン': 'Premium', PlanType: 'Lifetime' } });
  const r = await createPaddleCheckout({ env: MAIN_ENV, origin: PROD, recordId: REC, productId: 'premium-annual', entry: 'card', salesOpen: true, fetchImpl: del.fetch });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.code, 'already_lifetime');
  assert.equal(del.sepCalls, 0, '資格で止まったら委譲しない');
});

test('受付前（CARD_SALES_OPEN=false）: 委譲元は card_sales_not_open・分離サイトも呼ばない', async () => {
  const del = world();
  // salesOpen 未指定＝本番定数（paddle=false）。委譲元の resolveCardModeDelegated が先に止める。
  const r = await createPaddleCheckout({ env: MAIN_ENV, origin: PROD, recordId: REC, productId: 'premium-annual', entry: 'card', fetchImpl: del.fetch });
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
  assert.equal(r.code, 'card_sales_not_open');
  assert.equal(del.sepCalls, 0);
});

// --- 分離サイトの実関数（paddle-create-checkout.mjs）のガード ---
const mkReq = (method, { sig, body } = {}) => new Request('https://checkout.tirol.link/.netlify/functions/paddle-create-checkout', {
  method, ...(body === undefined ? {} : { body }),
  headers: { 'content-type': 'application/json', ...(sig ? { 'x-internal-signature': sig } : {}) },
});
async function withEnv(patch, fn) {
  const saved = { ...process.env };
  try { Object.assign(process.env, patch); if (patch._unset) for (const k of patch._unset) delete process.env[k]; return await fn(); }
  finally { for (const k of Object.keys(process.env)) delete process.env[k]; Object.assign(process.env, saved); }
}

test('実関数: GET は 405 / 署名なしは 401 / secret 未設定は 503', async () => {
  await withEnv({ CARD_GRANT_INTERNAL_SECRET: SECRET, PADDLE_API_KEY: LIVE_KEY }, async () => {
    assert.equal((await sepCreateHandler(mkReq('GET'))).status, 405);
    const body = JSON.stringify({ v: 1, recordId: REC, productId: 'premium-annual', origin: PROD, entry: 'card' });
    assert.equal((await sepCreateHandler(mkReq('POST', { body }))).status, 401, '署名なしは 401');
    assert.equal((await sepCreateHandler(mkReq('POST', { body, sig: signTsBody({ rawBody: `${body}x`, secret: SECRET }) }))).status, 401, '本文と不一致の署名は 401');
  });
  await withEnv({ _unset: ['CARD_GRANT_INTERNAL_SECRET'], PADDLE_API_KEY: LIVE_KEY }, async () => {
    const body = JSON.stringify({ v: 1, recordId: REC, productId: 'premium-annual', origin: PROD });
    assert.equal((await sepCreateHandler(mkReq('POST', { body }))).status, 503, 'secret 未設定は 503');
  });
});

test('実関数: 正しい署名でも origin が本番でなければ 400・受付前は 503（fail closed）', async () => {
  await withEnv({ CARD_GRANT_INTERNAL_SECRET: SECRET, PADDLE_API_KEY: LIVE_KEY }, async () => {
    const bad = JSON.stringify({ v: 1, recordId: REC, productId: 'premium-annual', origin: 'https://evil.example' });
    assert.equal((await sepCreateHandler(mkReq('POST', { body: bad, sig: signTsBody({ rawBody: bad, secret: SECRET }) }))).status, 400, 'origin 不一致は 400');
    // 正しい intent・live 鍵でも、CARD_SALES_OPEN.paddle=false の間は取引を作らない
    const ok = JSON.stringify({ v: 1, recordId: REC, productId: 'premium-annual', origin: PROD, entry: 'card' });
    const r = await sepCreateHandler(mkReq('POST', { body: ok, sig: signTsBody({ rawBody: ok, secret: SECRET }) }));
    assert.equal(r.status, 503, '受付前は作成しない');
    assert.equal((await r.json()).error, 'card_sales_not_open');
  });
});
