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

// Netlify Blobs 互換の偽ストア（Map 実装）。
// ⚠️ 条件付き書込 onlyIfNew（CAS）を忠実に模す: 既存キーには書かず { modified:false } を返す。
//    これが無いと原子的予約 reserve の race 検証ができない（Blobs v10 の実挙動と同じにする）。
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

// --- 原子性・同時実行（#838 の非原子 get→create→set の race を閉じたことの検証） ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('reserve は原子的: 同じキーの 2 回目は taken（CAS・onlyIfNew）', async () => {
  const store = makeBlobStore(fakeGetStore());
  const k = `idem:${REC}:premium-annual`;
  assert.equal(await store.reserve(k, IDEM_TTL_SEC), 'won');
  assert.equal(await store.reserve(k, IDEM_TTL_SEC), 'taken');
});

test('🛑 同時 2 リクエスト（別 nonce・同一 rec+product）: 原子的予約で create は 1 回・両者同じ取引', async () => {
  const store = makeBlobStore(fakeGetStore());
  let creates = 0;
  let releaseGate;
  const gate = new Promise((r) => { releaseGate = r; });
  // 最初に予約を取った側だけが create する。create は gate が開くまで未確定（＝勝者が作成中の状態）。
  const create = async () => { creates += 1; await gate; return { ok: true, url: `${PRODUCTION_ORIGIN}/x?_ptxn=txn_A`, transactionId: 'txn_A' }; };
  const pA = idempotentCreateCheckout({ store, nonce: 'n-A', recordId: REC, productId: 'premium-annual', create });
  await sleep(5); // A が予約を取り、create（gate 待ち）へ入るのを待つ
  const pB = idempotentCreateCheckout({ store, nonce: 'n-B', recordId: REC, productId: 'premium-annual', create, waitTries: 50, waitDelayMs: 5 });
  await sleep(5);
  releaseGate(); // A の create 完了 → 結果を idem に確定
  const [a, b] = await Promise.all([pA, pB]);
  assert.equal(a.transactionId, 'txn_A');
  assert.equal(b.transactionId, 'txn_A'); // B は新規作成せず同じ取引を得る
  assert.equal(b.reused, 'idem');
  assert.equal(creates, 1);               // ⚠️ 初版はここが 2 になりえた（非原子的 get→create→set）
});

test('予約競合で勝者の結果が出ないと 409 checkout_in_progress（二重作成しない）', async () => {
  const store = makeBlobStore(fakeGetStore());
  // 勝者が予約だけ取って未確定、の状態を模す
  await store.reserve(`idem:${REC}:premium-annual`, IDEM_TTL_SEC);
  let creates = 0;
  const create = async () => { creates += 1; return { ok: true, url: 'x', transactionId: 'txn_X' }; };
  const r = await idempotentCreateCheckout({ store, nonce: 'n-Z', recordId: REC, productId: 'premium-annual', create, waitTries: 3, waitDelayMs: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.code, 'checkout_in_progress');
  assert.equal(creates, 0); // 勝者を待つだけで二重作成しない
});

test('create 失敗時は予約を解放する（次の試行が 409 で塞がれない）', async () => {
  const store = makeBlobStore(fakeGetStore());
  let n = 0;
  const create = async () => { n += 1; return n === 1 ? { ok: false, status: 503, code: 'card_sales_not_open' } : { ok: true, url: 'x', transactionId: 'txn_9' }; };
  const a = await idempotentCreateCheckout({ store, nonce: 'n-A', recordId: REC, productId: 'premium-annual', create });
  assert.equal(a.ok, false);
  const b = await idempotentCreateCheckout({ store, nonce: 'n-B', recordId: REC, productId: 'premium-annual', create, waitTries: 2, waitDelayMs: 1 });
  assert.equal(b.ok, true); assert.equal(b.transactionId, 'txn_9'); // 予約が解放され、作り直せた
  assert.equal(n, 2);
});

test('ストア不達は fail-open だが degraded を立てる（無言の fail-open にしない）', async () => {
  const store = makeBlobStore(() => { throw new Error('blobs down'); });
  const create = async () => ({ ok: true, url: `${PRODUCTION_ORIGIN}/x?_ptxn=txn_D`, transactionId: 'txn_D' });
  const a = await idempotentCreateCheckout({ store, nonce: 'n', recordId: REC, productId: 'premium-annual', create });
  assert.equal(a.ok, true);
  assert.equal(a.transactionId, 'txn_D');
  assert.equal(a.degraded, true); // 呼び出し側（handler）がログできる
});
