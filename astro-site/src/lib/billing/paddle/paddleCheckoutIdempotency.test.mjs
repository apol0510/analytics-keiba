/**
 * paddleCheckoutIdempotency.test.mjs — 分離サイトの取引作成の冪等化（2026-10-24 MK 監査対応）。
 *
 * 検証:
 *  - 同一 intent（同じ nonce）の再送・リプレイ → 新しい Paddle 取引を作らず同じ取引を返す（nonce 単回使用相当）。
 *  - 別 intent（別 nonce）でも同じ会員・同じ商品の二重クリック → 同じ取引を返す（再送時の重複防止）。
 *  - 別商品・TTL 経過後・作成失敗はキャッシュしない（新規作成する）。
 *  - ストア障害は fail-open（dedup を諦めても取引作成は通す）。
 *  - 実 handler を通した正常系: 署名検証 → 冪等化 → 作成、の一連が配線されている。
 * ネットワークには出ない（createTransaction を注入）。CARD_SALES_OPEN は変えない（注入 creator で正常系を再現）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  idempotentCreateCheckout, makeBlobStore, NONCE_TTL_SEC, IDEM_TTL_SEC,
} from '../../../../../ops/checkout-site/netlify/functions/lib/checkoutIdempotency.mjs';
import { handleCreateCheckout } from '../../../../../ops/checkout-site/netlify/functions/paddle-create-checkout.mjs';
import { signTsBody } from './paddleCore.js';
import { PRODUCTION_ORIGIN } from '../cardSales.js';

const SECRET = 'internal-secret-0123456789abcdef0123456789abcdef';
const REC = 'recAAAAAAAAAAAAAA';

// Netlify Blobs 互換の偽ストア（Map 実装）。makeBlobStore の expiresAt 判定もまとめて検証する。
function fakeGetStore() {
  const m = new Map();
  const store = {
    async get(key) { const v = m.get(key); return v === undefined ? null : v; },
    async setJSON(key, val) { m.set(key, val); },
    async delete(key) { m.delete(key); },
  };
  const fn = () => store;
  fn._map = m;
  return fn;
}

function counter(result = { ok: true, url: `${PRODUCTION_ORIGIN}/checkout/paddle/?_ptxn=txn_01`, transactionId: 'txn_01' }) {
  let n = 0;
  const create = async () => { n += 1; return typeof result === 'function' ? result(n) : result; };
  return { create, calls: () => n };
}

test('冪等: 同一 nonce の再送 → 作成は1回だけ・同じ取引を返す（reused=nonce）', async () => {
  const store = makeBlobStore(fakeGetStore());
  const { create, calls } = counter();
  const args = { store, nonce: 'n-1', recordId: REC, productId: 'premium-annual', create };
  const a = await idempotentCreateCheckout(args);
  const b = await idempotentCreateCheckout(args);
  assert.equal(a.ok, true); assert.equal(a.transactionId, 'txn_01'); assert.equal(a.reused, undefined);
  assert.equal(b.ok, true); assert.equal(b.transactionId, 'txn_01'); assert.equal(b.reused, 'nonce');
  assert.equal(calls(), 1); // 2回目は Paddle を叩いていない
});

test('冪等: 別 nonce・同じ会員+商品（二重クリック）→ 作成1回・同じ取引（reused=idem）', async () => {
  const store = makeBlobStore(fakeGetStore());
  const { create, calls } = counter();
  const a = await idempotentCreateCheckout({ store, nonce: 'n-A', recordId: REC, productId: 'premium-annual', create });
  const b = await idempotentCreateCheckout({ store, nonce: 'n-B', recordId: REC, productId: 'premium-annual', create });
  assert.equal(a.transactionId, 'txn_01');
  assert.equal(b.transactionId, 'txn_01'); assert.equal(b.reused, 'idem');
  assert.equal(calls(), 1);
});

test('別商品は別取引（冪等キーが違う）', async () => {
  const store = makeBlobStore(fakeGetStore());
  const { create, calls } = counter((n) => ({ ok: true, url: `${PRODUCTION_ORIGIN}/checkout/paddle/?_ptxn=txn_0${n}`, transactionId: `txn_0${n}` }));
  await idempotentCreateCheckout({ store, nonce: 'n-A', recordId: REC, productId: 'premium-annual', create });
  const b = await idempotentCreateCheckout({ store, nonce: 'n-B', recordId: REC, productId: 'premium-annual-light', create });
  assert.equal(b.transactionId, 'txn_02'); assert.equal(b.reused, undefined);
  assert.equal(calls(), 2);
});

test('TTL 経過後は作り直す（idem/nonce 両方失効）', async () => {
  const store = makeBlobStore(fakeGetStore());
  const { create, calls } = counter((n) => ({ ok: true, url: `${PRODUCTION_ORIGIN}/x?_ptxn=txn_0${n}`, transactionId: `txn_0${n}` }));
  const t0 = new Date('2026-10-24T00:00:00Z');
  await idempotentCreateCheckout({ store, nonce: 'n-A', recordId: REC, productId: 'premium-annual', create, now: t0 });
  const later = new Date(t0.getTime() + (IDEM_TTL_SEC + NONCE_TTL_SEC + 10) * 1000);
  const b = await idempotentCreateCheckout({ store, nonce: 'n-B', recordId: REC, productId: 'premium-annual', create, now: later });
  assert.equal(b.transactionId, 'txn_02'); assert.equal(b.reused, undefined);
  assert.equal(calls(), 2);
});

test('作成失敗はキャッシュしない（次回は再作成を試みる）', async () => {
  const store = makeBlobStore(fakeGetStore());
  let n = 0;
  const create = async () => { n += 1; return n === 1 ? { ok: false, status: 503, code: 'card_sales_not_open' } : { ok: true, url: `${PRODUCTION_ORIGIN}/x?_ptxn=txn_9`, transactionId: 'txn_9' }; };
  const a = await idempotentCreateCheckout({ store, nonce: 'n-A', recordId: REC, productId: 'premium-annual', create });
  assert.equal(a.ok, false); assert.equal(a.code, 'card_sales_not_open');
  const b = await idempotentCreateCheckout({ store, nonce: 'n-B', recordId: REC, productId: 'premium-annual', create });
  assert.equal(b.ok, true); assert.equal(b.transactionId, 'txn_9');
  assert.equal(n, 2);
});

test('ストア障害は fail-open（毎回作成するが例外を出さない）', async () => {
  const store = makeBlobStore(() => { throw new Error('blobs down'); }); // getStore が throw → null ストア
  const { create, calls } = counter();
  const a = await idempotentCreateCheckout({ store, nonce: 'n-A', recordId: REC, productId: 'premium-annual', create });
  const b = await idempotentCreateCheckout({ store, nonce: 'n-A', recordId: REC, productId: 'premium-annual', create });
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.equal(calls(), 2); // dedup されない（作成は通る）
});

// --- 実 handler を通した配線（署名検証 → 冪等化 → 作成） ---
const ENV = { CARD_GRANT_INTERNAL_SECRET: SECRET, PADDLE_API_KEY: 'pdl_live_apikey_TESTONLY' };
function signedRequest(intentObj) {
  const raw = JSON.stringify(intentObj);
  const sig = signTsBody({ rawBody: raw, secret: SECRET });
  return new Request('https://checkout.tirol.link/.netlify/functions/paddle-create-checkout', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-signature': sig }, body: raw,
  });
}
const intent = (over = {}) => ({ v: 1, recordId: REC, productId: 'premium-annual', origin: PRODUCTION_ORIGIN, entry: 'card', nonce: 'nonce-1', ...over });

test('handler 正常系: 署名付き intent → 200・作成1回。同一 raw の再送 → 作成せず同じ取引', async () => {
  const store = makeBlobStore(fakeGetStore());
  const { create, calls } = counter();
  const createTransaction = create;
  const req1 = signedRequest(intent());
  const raw = await req1.clone().text();
  const r1 = await handleCreateCheckout({ request: req1, env: ENV, store, createTransaction });
  assert.equal(r1.status, 200);
  const b1 = await r1.json(); assert.equal(b1.transactionId, 'txn_01');
  // 同一 raw（同じ nonce・同じ署名）の再送
  const req2 = new Request(req1.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-signature': signTsBody({ rawBody: raw, secret: SECRET }) }, body: raw });
  const r2 = await handleCreateCheckout({ request: req2, env: ENV, store, createTransaction });
  assert.equal(r2.status, 200);
  const b2 = await r2.json(); assert.equal(b2.transactionId, 'txn_01');
  assert.equal(calls(), 1); // リプレイ/再送でも新規取引を作らない
});

test('handler: 別 nonce・同じ会員+商品 → 同じ取引（作成1回）', async () => {
  const store = makeBlobStore(fakeGetStore());
  const { create, calls } = counter();
  await handleCreateCheckout({ request: signedRequest(intent({ nonce: 'nonce-A' })), env: ENV, store, createTransaction: create });
  const r = await handleCreateCheckout({ request: signedRequest(intent({ nonce: 'nonce-B' })), env: ENV, store, createTransaction: create });
  const b = await r.json(); assert.equal(b.transactionId, 'txn_01');
  assert.equal(calls(), 1);
});

test('handler: 署名が無い/壊れている intent は 401・作成を呼ばない', async () => {
  const store = makeBlobStore(fakeGetStore());
  const { create, calls } = counter();
  const raw = JSON.stringify(intent());
  const noSig = new Request('https://checkout.tirol.link/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
  const r = await handleCreateCheckout({ request: noSig, env: ENV, store, createTransaction: create });
  assert.equal(r.status, 401);
  assert.equal(calls(), 0);
});

test('handler: 作成失敗(card_sales_not_open) はキャッシュせず 503 を返す', async () => {
  const store = makeBlobStore(fakeGetStore());
  let n = 0;
  const createTransaction = async () => { n += 1; return { ok: false, status: 503, code: 'card_sales_not_open' }; };
  const r = await handleCreateCheckout({ request: signedRequest(intent()), env: ENV, store, createTransaction });
  assert.equal(r.status, 503);
  const b = await r.json(); assert.equal(b.error, 'card_sales_not_open');
  // もう一度（別 nonce）→ また作成を試みる（失敗はキャッシュされない）
  await handleCreateCheckout({ request: signedRequest(intent({ nonce: 'nonce-2' })), env: ENV, store, createTransaction });
  assert.equal(n, 2);
});
