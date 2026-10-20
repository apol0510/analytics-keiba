/**
 * Paddle 連携（Sandbox 相当）を偽の Paddle API・Airtable・Redis で通しで確かめる。ネットワークに出ない。
 * Checkout（取引作成）→ 支払い確認（API 照会）→ 会員権限付与 → Webhook 再送 → 返金 → 再購入。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  CARD_SALES_OPEN, resolvePaddleMode, buildTransactionBody, verifyPaddleSignature, parsePaddleWebhook,
  matchTransaction, decideAdjustment, clientTokenMode,
} from './paddleCore.js';
import { createPaddleCheckout, handlePaddleEvent, readPaddleOrderStatus } from './paddleServer.js';
import { PRODUCTION_ORIGIN } from '../cardSales.js';
import { hasBannedPaymentWord } from '../paymentDisplayNames.js';

const PREVIEW = 'https://deploy-preview-1--analytics-keiba.netlify.app';
const REC = 'recAAAAAAAAAAAAAA';
const KEY = 'pdl_sdbx_apikey_TESTONLY'; // 偽の値（実鍵の形式に似せない＝push protection の誤検知を避ける）
const ENV = { PADDLE_API_KEY: KEY, AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'appX' };
const LATER = () => Date.now() + 60 * 60 * 1000;

function world({ fields = { 'プラン': 'Free', Email: 'a+card-e2e@example.com' } } = {}) {
  const st = { fields: { ...fields }, txns: {}, adjs: {}, patches: [], created: [], redis: new Map(), calls: [], notes: [] };
  const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  let n = 0;
  st.fetch = async (url, init = {}) => {
    st.calls.push(url);
    const u = new URL(url);
    if (u.host === 'api.airtable.com') {
      if (init.method === 'PATCH') { const f = JSON.parse(init.body).fields; st.patches.push(f); Object.assign(st.fields, f); }
      return res(200, { id: REC, fields: st.fields });
    }
    assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
    if (u.pathname === '/transactions' && init.method === 'POST') {
      const b = JSON.parse(init.body);
      n += 1;
      const id = `txn_${String(n).padStart(2, '0')}abcdefghijklmnopqrstu`;
      st.created.push(b);
      st.txns[id] = {
        id, origin: 'api', status: 'ready', currency_code: 'JPY', custom_data: b.custom_data,
        details: { totals: { grand_total: b.items[0].price.unit_price.amount } }, checkout: { url: `${st.defaultLink}?_ptxn=${id}` },
      };
      return res(201, { data: st.txns[id] });
    }
    const m = u.pathname.match(/^\/transactions\/(txn_[a-z0-9]+)$/);
    if (m) return st.txns[m[1]] ? res(200, { data: st.txns[m[1]] }) : res(404, { error: { code: 'not_found' } });
    if (u.pathname === '/adjustments') { const a = st.adjs[u.searchParams.get('id')]; return res(200, { data: a ? [a] : [] }); }
    return res(404, {});
  };
  st.redisCmd = async ([cmd, key, val, ...rest]) => {
    if (cmd === 'GET') return st.redis.has(key) ? st.redis.get(key) : null;
    if (cmd === 'DEL') { st.redis.delete(key); return 1; }
    if (cmd === 'SET') { if (rest.includes('NX') && st.redis.has(key)) return null; st.redis.set(key, val); return 'OK'; }
    throw new Error(`unexpected ${cmd}`);
  };
  st.notify = async (kind, d) => { st.notes.push([kind, d.reason || '']); };
  st.defaultLink = `${PREVIEW}/checkout/paddle/`; // アカウントの Default payment link
  st.pay = (id) => { Object.assign(st.txns[id], { status: 'completed', billed_at: '2026-10-11T03:00:00Z' }); };
  return st;
}
const ev = (w, eventType, data, now) => handlePaddleEvent({
  env: ENV, origin: PREVIEW, parsed: parsePaddleWebhook({ event_id: 'evt_1', event_type: eventType, data }),
  redis: w.redisCmd, notify: w.notify, fetchImpl: w.fetch, ...(now ? { now } : {}),
});
const checkout = async (w, productId = 'premium-annual') => {
  const r = await createPaddleCheckout({ env: ENV, origin: PREVIEW, recordId: REC, productId, fetchImpl: w.fetch });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.transactionId;
};

test('販売は閉じている。本番サイトは Sandbox 鍵・販売前の本番鍵とも受け付けない。Preview は本番鍵を受け付けない', () => {
  assert.equal(CARD_SALES_OPEN, false);
  assert.equal(resolvePaddleMode({ key: KEY, origin: PRODUCTION_ORIGIN }).reason, 'test_key_on_production');
  assert.equal(resolvePaddleMode({ key: 'pdl_live_apikey_x', origin: PRODUCTION_ORIGIN }).reason, 'card_sales_not_open');
  assert.equal(resolvePaddleMode({ key: 'pdl_live_apikey_x', origin: PREVIEW }).reason, 'live_key_outside_production');
  assert.equal(resolvePaddleMode({ key: 'legacy-key-without-prefix', origin: PREVIEW }).reason, 'paddle_key_missing');
  assert.equal(resolvePaddleMode({ key: KEY, origin: PREVIEW }).apiBase, 'https://sandbox-api.paddle.com');
  assert.equal(clientTokenMode('test_abc123'), 'test');
  assert.equal(clientTokenMode('live_abc123'), 'live');
  assert.equal(clientTokenMode('pdl_sdbx_apikey_x'), null, 'API 鍵をクライアントトークンとして扱わない');
});

test('取引: 金額はサーバー・JPY 税込（internal）・メールを載せない・禁止語なし・月払いは作れない', () => {
  const b = buildTransactionBody({ productId: 'premium-lifetime', recordId: REC, origin: PREVIEW });
  assert.equal(b.items.length, 1);
  assert.deepEqual(b.items[0].price.unit_price, { amount: '78000', currency_code: 'JPY' });
  assert.equal(b.items[0].price.tax_mode, 'internal');
  assert.equal(b.items[0].price.billing_cycle, undefined, '一回払い（定期課金にしない）');
  assert.deepEqual(b.custom_data, { ak_record: REC, ak_product: 'premium-lifetime' });
  assert.equal(b.checkout, undefined, 'checkout.url は送らない（Default payment link に任せる）');
  assert.equal(JSON.stringify(b).includes('@'), false);
  const p = b.items[0].price;
  assert.equal([p.description, p.name, p.product.name].some(hasBannedPaymentWord), false, '決済会社に出る名前に禁止語なし');
  assert.throws(() => buildTransactionBody({ productId: 'premium-monthly', recordId: REC, origin: PREVIEW }));
  assert.throws(() => buildTransactionBody({ productId: 'premium-annual', recordId: 'x', origin: PREVIEW }));
});

test('署名: HMAC-SHA256(ts:rawBody)・時刻のずれ・改ざん・鍵切替中の複数 h1', () => {
  const secret = 'pdl_ntfset_secret';
  const body = '{"event_type":"transaction.completed"}';
  const ts = 1760000000;
  const h = createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
  assert.equal(verifyPaddleSignature({ header: `ts=${ts};h1=${h}`, rawBody: body, secret, nowSec: ts + 10 }), true);
  assert.equal(verifyPaddleSignature({ header: `ts=${ts};h1=${'0'.repeat(64)};h1=${h}`, rawBody: body, secret, nowSec: ts }), true);
  assert.equal(verifyPaddleSignature({ header: `ts=${ts};h1=${h}`, rawBody: `${body} `, secret, nowSec: ts }), false, '本文の改ざん');
  assert.equal(verifyPaddleSignature({ header: `ts=${ts};h1=${h}`, rawBody: body, secret, nowSec: ts + 3600 }), false, '古い通知の再利用');
  assert.equal(verifyPaddleSignature({ header: `ts=${ts};h1=${h}`, rawBody: body, secret: 'other', nowSec: ts }), false);
  assert.equal(verifyPaddleSignature({ header: '', rawBody: body, secret, nowSec: ts }), false);
  assert.equal(verifyPaddleSignature({ header: `ts=${ts};h1=${h}`, rawBody: body, secret: '', nowSec: ts }), false);
});

test('E2E: Checkout → 支払い確認（API 照会）→ 付与 → Webhook 再送は 1 回だけ → 完了画面は active', async () => {
  const w = world();
  assert.equal((await createPaddleCheckout({ env: ENV, origin: PREVIEW, recordId: null, productId: 'premium-annual', fetchImpl: w.fetch })).code, 'login_required');
  assert.equal((await createPaddleCheckout({ env: ENV, origin: PRODUCTION_ORIGIN, recordId: REC, productId: 'premium-annual', fetchImpl: w.fetch })).code, 'test_key_on_production');
  assert.equal(w.calls.length, 0, '止めるときは何も呼ばない');
  w.defaultLink = 'https://elsewhere.example/checkout/paddle/';
  assert.equal((await createPaddleCheckout({ env: ENV, origin: PREVIEW, recordId: REC, productId: 'premium-annual', fetchImpl: w.fetch })).code, 'checkout_url_mismatch', '別サイトの決済画面へは送らない');
  w.defaultLink = `${PREVIEW}/checkout/paddle/`;
  const t = await checkout(w);
  assert.equal(w.txns[t].checkout.url, `${PREVIEW}/checkout/paddle/?_ptxn=${t}`);
  assert.equal((await readPaddleOrderStatus({ redis: w.redisCmd, transactionId: t, recordId: REC })).status, 'pending');
  // 未払いの通知（ready）は何もしない
  assert.equal((await ev(w, 'transaction.completed', { id: t })).result, 'mismatch_status_ready');
  assert.equal(w.patches.length, 0);
  w.pay(t);
  assert.equal((await ev(w, 'transaction.paid', { id: t })).result, 'granted');
  assert.equal(w.fields['プラン'], 'Premium');
  assert.equal(w.fields.PlanType, 'Annual');
  assert.equal(w.fields['有効期限'], '2027-10-11');
  assert.equal(w.fields.PaymentMethod, 'paddle');
  assert.equal((await ev(w, 'transaction.completed', { id: t })).result, 'already_applied');
  assert.equal((await ev(w, 'transaction.completed', { id: t })).result, 'already_applied', 'Webhook 再送');
  assert.equal(w.patches.length, 1, '再送で二重に延ばさない');
  assert.equal((await readPaddleOrderStatus({ redis: w.redisCmd, transactionId: t, recordId: REC })).status, 'active');
  assert.equal((await readPaddleOrderStatus({ redis: w.redisCmd, transactionId: t, recordId: 'recBBBBBBBBBBBBBB' })).status, 'not_found');
  assert.deepEqual(w.notes.map((x) => x[0]), ['granted'], '顧客向けではなく管理者通知だけ・1 回');
});

test('同時に 2 通届いても反映は 1 回', async () => {
  const w = world();
  const t = await checkout(w);
  w.pay(t);
  const rs = await Promise.all([ev(w, 'transaction.paid', { id: t }), ev(w, 'transaction.completed', { id: t })]);
  assert.deepEqual(rs.map((r) => r.result).sort(), ['already_applied', 'granted']);
  assert.equal(w.patches.length, 1);
});

test('照会結果が違えば書かない（Paddle.js 由来・金額・通貨・会員・商品）', async () => {
  const w = world();
  const t = await checkout(w);
  w.pay(t);
  const base = { ...w.txns[t] };
  const cases = [
    [{ origin: 'web' }, 'mismatch_origin_not_api'],
    [{ details: { totals: { grand_total: '100' } } }, 'mismatch_amount_mismatch'],
    [{ currency_code: 'USD' }, 'mismatch_currency_mismatch'],
    [{ custom_data: { ak_record: 'x', ak_product: 'premium-annual' } }, 'mismatch_invalid_record'],
    [{ custom_data: { ak_record: REC, ak_product: 'premium-monthly' } }, 'mismatch_invalid_product'],
  ];
  for (const [patch, expected] of cases) {
    w.txns[t] = { ...base, ...patch };
    assert.equal((await ev(w, 'transaction.completed', { id: t })).result, expected);
  }
  assert.equal(w.patches.length, 0);
  assert.equal((await ev(w, 'transaction.completed', { id: 'txn_0000notexisting00000' })).result, 'transaction_lookup_failed');
  assert.equal(matchTransaction(null).ok, false);
});

test('返金: 承認済みの全額返金だけ付与前へ戻す（申請中・一部・却下は戻さない）→ 再購入できる', async () => {
  const w = world();
  const t = await checkout(w);
  w.pay(t);
  await ev(w, 'transaction.completed', { id: t });
  const adj = (id, extra) => { w.adjs[id] = { id, transaction_id: t, action: 'refund', type: 'full', status: 'pending_approval', ...extra }; return { id, transaction_id: t }; };
  assert.equal((await ev(w, 'adjustment.created', adj('adj_01abcdefghijklmnop'))).result, 'ignored_status_pending_approval');
  assert.equal((await ev(w, 'adjustment.updated', adj('adj_02abcdefghijklmnop', { status: 'rejected' }))).result, 'ignored_status_rejected');
  assert.equal((await ev(w, 'adjustment.updated', adj('adj_03abcdefghijklmnop', { type: 'partial', status: 'approved' }))).result, 'partial_refund_no_change');
  assert.equal(w.fields['プラン'], 'Premium');
  assert.equal((await ev(w, 'adjustment.updated', adj('adj_04abcdefghijklmnop', { status: 'approved' }))).result, 'reverted');
  assert.equal(w.fields['プラン'], 'Free');
  assert.equal(w.fields['有効期限'], null);
  assert.equal((await ev(w, 'adjustment.updated', { id: 'adj_04abcdefghijklmnop', transaction_id: t })).result, 'already_reverted');
  assert.equal((await readPaddleOrderStatus({ redis: w.redisCmd, transactionId: t, recordId: REC })).status, 'refunded');
  // 返金直後の再購入は二重購入扱いにしない
  // 買い切りはカードでは申込を作らない（2026-10-20 MK 決定）。再購入は年払いで確かめる
  assert.equal((await createPaddleCheckout({ env: ENV, origin: PREVIEW, recordId: REC, productId: 'premium-lifetime', fetchImpl: w.fetch })).code, 'lifetime_bank_transfer_only');
  const t2 = await checkout(w, 'premium-annual');
  w.pay(t2);
  assert.equal((await ev(w, 'transaction.completed', { id: t2 })).result, 'granted');
  assert.equal(w.fields.PlanType, 'Annual');
  assert.equal(decideAdjustment({ transaction_id: 'other' }, t).action, 'ignore');
  assert.deepEqual(decideAdjustment({ transaction_id: t, action: 'chargeback', status: 'approved', type: 'partial' }, t), { action: 'revert', full: true });
});

test('買い切り会員は申込を作らない・30 分以内の 2 本目は権限を変えず管理者へ（二重課金の後始末）', async () => {
  const lw = world({ fields: { 'プラン': 'Premium', PlanType: 'Lifetime', '有効期限': '2099-12-31' } });
  assert.equal((await createPaddleCheckout({ env: ENV, origin: PREVIEW, recordId: REC, productId: 'premium-annual', fetchImpl: lw.fetch })).code, 'already_lifetime');
  const w = world();
  const t1 = await checkout(w);
  const t2 = await checkout(w);
  w.pay(t1); w.pay(t2);
  assert.equal((await ev(w, 'transaction.completed', { id: t1 })).result, 'granted');
  assert.equal((await ev(w, 'transaction.completed', { id: t2 })).result, 'conflict_possible_duplicate_purchase');
  assert.equal(w.fields['有効期限'], '2027-10-11', '2 年延ばさない');
  assert.equal((await ev(w, 'transaction.completed', { id: t2 }, LATER)).result, 'conflict_possible_duplicate_purchase', '一度疑いにした決済は再送でも付与しない');
  assert.equal((await readPaddleOrderStatus({ redis: w.redisCmd, transactionId: t2, recordId: REC })).status, 'needs_support');
  assert.deepEqual(w.notes.at(-1), ['conflict', 'possible_duplicate_purchase']);
});

test('本番サイト宛ての通知は Sandbox 鍵では処理しない（照会もしない）／Redis 無しは再送させる', async () => {
  const w = world();
  const parsed = parsePaddleWebhook({ event_type: 'transaction.completed', data: { id: 'txn_01abcdefghijklmnopqrstu' } });
  assert.equal((await handlePaddleEvent({ env: ENV, origin: PRODUCTION_ORIGIN, parsed, redis: w.redisCmd, fetchImpl: w.fetch })).result, 'ignored_test_key_on_production');
  assert.equal(w.calls.length, 0);
  assert.deepEqual(await handlePaddleEvent({ env: ENV, origin: PREVIEW, parsed, redis: null, fetchImpl: w.fetch }), { result: 'redis_missing', retry: true });
  assert.equal((await handlePaddleEvent({ env: ENV, origin: PREVIEW, parsed: parsePaddleWebhook({ event_type: 'subscription.created', data: {} }), redis: w.redisCmd, fetchImpl: w.fetch })).result, 'ignored_event');
});
