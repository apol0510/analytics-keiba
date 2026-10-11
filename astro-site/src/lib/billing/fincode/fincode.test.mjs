/**
 * fincode 連携（Sandbox 相当）を偽の fincode API・Airtable・Redis で通しで確かめる。ネットワークに出ない。
 * 購入 → 入金成功確認（API 照会）→ 会員反映 → 再送・同時着信 → 更新（年払いの再購入）→ 返金 → 再契約。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CARD_SALES_OPEN, resolveFincodeMode, buildSessionBody, verifyWebhookSignature, parseWebhook, matchPayment,
  decideRefundRevert, PRODUCTION_ORIGIN,
} from './fincodeCore.js';
import { handleFincodeEvent, createCardSession, readCardOrderStatus } from './fincodeServer.js';
import { hasBannedPaymentWord } from '../paymentDisplayNames.js';

const PREVIEW = 'https://deploy-preview-1--analytics-keiba.netlify.app';
const REC = 'recAAAAAAAAAAAAAA';
const ENV = { FINCODE_SECRET_KEY: 'm_test_x', AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'appX' };

function world({ fields = { 'プラン': 'Free', Email: 'a+fincode-e2e@example.com' }, payments = {} } = {}) {
  const st = { fields: { ...fields }, payments, patches: [], sessions: [], redis: new Map(), calls: [] };
  const res = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  st.fetch = async (url, init = {}) => {
    st.calls.push(url);
    const u = new URL(url);
    if (u.host === 'api.airtable.com') {
      if (init.method === 'PATCH') { const f = JSON.parse(init.body).fields; st.patches.push(f); Object.assign(st.fields, f); return res(200, { id: REC, fields: st.fields }); }
      return res(200, { id: REC, fields: st.fields });
    }
    if (u.pathname === '/v1/sessions') { const b = JSON.parse(init.body); st.sessions.push({ b, h: init.headers }); return res(200, { link_url: 'https://pay.test/x', id: 's1' }); }
    const m = u.pathname.match(/^\/v1\/payments\/([^/]+)$/);
    if (m) { const p = st.payments[decodeURIComponent(m[1])]; return p ? res(200, p) : res(404, { errors: [{ error_code: 'E01' }] }); }
    return res(404, {});
  };
  st.redisCmd = async (args) => {
    const [cmd, key, val, ...rest] = args;
    if (cmd === 'GET') return st.redis.has(key) ? st.redis.get(key) : null;
    if (cmd === 'DEL') { st.redis.delete(key); return 1; }
    if (cmd === 'SET') {
      if (rest.includes('NX') && st.redis.has(key)) return null;
      st.redis.set(key, val); return 'OK';
    }
    throw new Error(`unexpected ${cmd}`);
  };
  st.notes = [];
  st.notify = async (kind, d) => { st.notes.push([kind, d.reason || '']); };
  return st;
}
const pay = (orderId, productId, amount, status = 'CAPTURED', recordId = REC) => ({
  id: orderId, order_id: orderId, amount, status, client_field_1: recordId, client_field_2: productId, process_date: '2026/10/11 12:00:00', access_id: 'a1',
});
const run = (w, event, orderId, origin = PREVIEW, now) => handleFincodeEvent({
  env: ENV, origin, event, orderId, redis: w.redisCmd, notify: w.notify, fetchImpl: w.fetch, ...(now ? { now } : {}),
});
const LATER = () => Date.now() + 60 * 60 * 1000; // 二重購入の疑い（30 分以内）を越えた別の日の更新

test('販売は閉じている。本番サイトではテストキー・販売前の本番キーとも受け付けない。Preview は本番キーを受け付けない', () => {
  assert.equal(CARD_SALES_OPEN, false);
  assert.equal(resolveFincodeMode({ key: 'm_test_x', origin: PRODUCTION_ORIGIN }).reason, 'test_key_on_production');
  assert.equal(resolveFincodeMode({ key: 'm_prod_x', origin: PRODUCTION_ORIGIN }).reason, 'card_sales_not_open');
  assert.equal(resolveFincodeMode({ key: 'm_prod_x', origin: PREVIEW }).reason, 'live_key_outside_production');
  assert.equal(resolveFincodeMode({ key: '', origin: PREVIEW }).reason, 'fincode_key_missing');
  assert.equal(resolveFincodeMode({ key: 'm_test_x', origin: PREVIEW }).apiBase, 'https://api.test.fincode.jp');
  const src = readFileSync(fileURLToPath(new URL('../cardSales.js', import.meta.url)), 'utf8');
  assert.match(src, /\n  fincode: false,\n/);
});

test('決済画面: 金額はサーバー・即時売上（CAPTURE）・3DS2 必須・メールを載せない・禁止語なし', () => {
  const b = buildSessionBody({ productId: 'premium-lifetime', orderId: 'ak-premium-lifetime-abc', recordId: REC, origin: PREVIEW, expireAt: '2026/10/11 13:00:00' });
  assert.equal(b.transaction.amount, '78000');
  assert.deepEqual(b.transaction.pay_type, ['Card']);
  assert.equal(b.card.job_code, 'CAPTURE');
  assert.equal(b.card.tds_type, '2');
  assert.equal(b.card.tds2_type, '2');
  assert.equal(b.transaction.client_field_1, REC);
  assert.equal(JSON.stringify(b).includes('@'), false);
  assert.equal(hasBannedPaymentWord(b.shop_service_name) || hasBannedPaymentWord(b.card.td_tenant_name), false);
  assert.throws(() => buildSessionBody({ productId: 'premium-monthly', orderId: 'x', recordId: REC, origin: PREVIEW }));
});

test('createCardSession: 未ログイン・本番サイトは作らない／Preview＋テストキーで作る（冪等キー付き）', async () => {
  const w = world();
  assert.equal((await createCardSession({ env: ENV, origin: PREVIEW, recordId: null, productId: 'premium-annual', fetchImpl: w.fetch })).code, 'login_required');
  assert.equal((await createCardSession({ env: ENV, origin: PRODUCTION_ORIGIN, recordId: REC, productId: 'premium-annual', fetchImpl: w.fetch })).code, 'test_key_on_production');
  assert.equal(w.calls.length, 0, '止めるときは何も呼ばない');
  const r = await createCardSession({ env: ENV, origin: PREVIEW, recordId: REC, productId: 'premium-annual', fetchImpl: w.fetch, rand: 'r1' });
  assert.equal(r.ok, true);
  assert.equal(r.orderId, 'ak-premium-annual-r1');
  assert.equal(w.sessions[0].b.transaction.amount, '49800');
  assert.equal(w.sessions[0].h.idempotent_key, 'ak-premium-annual-r1');
  // 資格のない会員価格・買い切り会員は 409
  assert.equal((await createCardSession({ env: ENV, origin: PREVIEW, recordId: REC, productId: 'premium-annual-light', fetchImpl: w.fetch })).code, 'not_eligible');
});

test('署名: 固定文字列を定数時間で比較（空・長さ違い・不一致は拒否）／通知の形式検査', () => {
  assert.equal(verifyWebhookSignature('abc', 'abc'), true);
  assert.equal(verifyWebhookSignature('abd', 'abc'), false);
  assert.equal(verifyWebhookSignature('ab', 'abc'), false);
  assert.equal(verifyWebhookSignature('', ''), false);
  assert.deepEqual(parseWebhook('{"event":"payments.card.exec","order_id":"ak-premium-annual-r1"}'), { event: 'payments.card.exec', orderId: 'ak-premium-annual-r1' });
  assert.equal(parseWebhook('{"event":"x","order_id":"other"}'), null);
  assert.equal(parseWebhook('not json'), null);
});

test('E2E: 購入→API 照会で成功確認→反映→再送は 1 回だけ→完了画面は active', async () => {
  const o = 'ak-premium-annual-r1';
  const w = world({ payments: { [o]: pay(o, 'premium-annual', 49800) } });
  assert.equal((await readCardOrderStatus({ redis: w.redisCmd, orderId: o, recordId: REC })).status, 'pending');
  assert.equal((await run(w, 'payments.card.exec', o)).result, 'granted');
  assert.equal(w.fields['プラン'], 'Premium');
  assert.equal(w.fields.PlanType, 'Annual');
  assert.equal(w.fields['有効期限'], '2027-10-11');
  assert.equal(w.fields.PaymentMethod, 'fincode');
  assert.equal((await run(w, 'payments.card.exec', o)).result, 'already_applied');
  assert.equal((await run(w, 'payments.card.capture', o)).result, 'already_applied');
  assert.equal(w.patches.length, 1, '再送で二重に延ばさない');
  assert.equal((await readCardOrderStatus({ redis: w.redisCmd, orderId: o, recordId: REC })).status, 'active');
  assert.equal((await readCardOrderStatus({ redis: w.redisCmd, orderId: o, recordId: 'recBBBBBBBBBBBBBB' })).status, 'not_found', '他人の注文は見せない');
});

test('同時に 2 通届いても反映は 1 回（会員ロック＋注文の状態）', async () => {
  const o = 'ak-premium-annual-r2';
  const w = world({ payments: { [o]: pay(o, 'premium-annual', 49800) } });
  const rs = await Promise.all([run(w, 'payments.card.exec', o), run(w, 'payments.card.secure', o)]);
  assert.deepEqual(rs.map((r) => r.result).sort(), ['already_applied', 'granted']);
  assert.equal(w.patches.length, 1);
});

test('PATCH 後に止まって再送されても二重に延ばさない（pending からの回復）', async () => {
  const o = 'ak-premium-annual-r3';
  const w = world({ payments: { [o]: pay(o, 'premium-annual', 49800) } });
  await run(w, 'payments.card.exec', o);
  const k = `ak:card:fincode:applied:${o}`;
  w.redis.set(k, JSON.stringify({ ...JSON.parse(w.redis.get(k)), state: 'pending' })); // done を書く前に落ちた状態
  assert.equal((await run(w, 'payments.card.exec', o)).result, 'recovered_applied');
  assert.equal(w.patches.length, 1);
  assert.equal(w.fields['有効期限'], '2027-10-11');
});

test('照会結果が申込と違えば書かない（金額・会員・商品・未確定・注文なし）', async () => {
  const cases = [
    ['ak-premium-annual-m1', pay('ak-premium-annual-m1', 'premium-annual', 100), 'mismatch_amount_mismatch'],
    ['ak-premium-annual-m2', pay('ak-premium-annual-m2', 'premium-lifetime', 49800), 'mismatch_no_reservation'],
    ['ak-premium-annual-m3', pay('ak-premium-annual-m3', 'premium-annual', 49800, 'AUTHORIZED'), 'mismatch_status_authorized'],
    ['ak-premium-annual-m4', pay('ak-premium-annual-m4', 'premium-annual', 49800, 'CAPTURED', 'not-a-record'), 'mismatch_invalid_record'],
  ];
  for (const [o, p, expected] of cases) {
    const w = world({ payments: { [o]: p } });
    const r = await run(w, 'payments.card.exec', o);
    if (expected) assert.equal(r.result, expected, o);
    assert.equal(w.patches.length, 0, o);
  }
  const w = world();
  assert.equal((await run(w, 'payments.card.exec', 'ak-premium-annual-none')).result, 'payment_lookup_failed');
  assert.equal(w.patches.length, 0);
});

test('本番サイト宛ての通知はテストキーでは処理しない（照会もしない）／Redis 無しは再送させる', async () => {
  const o = 'ak-premium-annual-p1';
  const w = world({ payments: { [o]: pay(o, 'premium-annual', 49800) } });
  assert.equal((await run(w, 'payments.card.exec', o, PRODUCTION_ORIGIN)).result, 'ignored_test_key_on_production');
  assert.equal(w.calls.length, 0);
  const r = await handleFincodeEvent({ env: ENV, origin: PREVIEW, event: 'payments.card.exec', orderId: o, redis: null, fetchImpl: w.fetch });
  assert.deepEqual(r, { result: 'redis_missing', retry: true });
});

test('買い切り会員の決済は権限を変えず管理者へ（二重課金の後始末）', async () => {
  const o = 'ak-premium-annual-c1';
  const w = world({ fields: { 'プラン': 'Premium', PlanType: 'Lifetime', '有効期限': '2099-12-31' }, payments: { [o]: pay(o, 'premium-annual', 49800) } });
  assert.equal((await run(w, 'payments.card.exec', o)).result, 'conflict_existing_lifetime');
  assert.equal(w.patches.length, 0);
  assert.deepEqual(w.notes.at(-1), ['conflict', 'existing_lifetime']);
});

test('更新（年払いの再購入）は残りの期限から 1 年・返金は付与前へ戻す・再契約できる', async () => {
  const o1 = 'ak-premium-annual-u1';
  const o2 = 'ak-premium-annual-u2';
  const w = world({ payments: { [o1]: pay(o1, 'premium-annual', 49800), [o2]: pay(o2, 'premium-annual', 49800) } });
  await run(w, 'payments.card.exec', o1);
  assert.equal(w.fields['有効期限'], '2027-10-11');
  assert.equal((await run(w, 'payments.card.exec', o2)).result, 'conflict_possible_duplicate_purchase', '30 分以内の別決済は二重購入の疑い');
  assert.equal(w.fields['有効期限'], '2027-10-11');
  w.redis.delete(`ak:card:fincode:applied:${o2}`);
  await run(w, 'payments.card.exec', o2, PREVIEW, LATER); // 更新（時間を置いた再購入）
  assert.equal(w.fields['有効期限'], '2028-10-11');
  // 2 本目を返金 → 1 本目の状態へ戻る
  w.payments[o2] = { ...w.payments[o2], status: 'CANCELED' };
  assert.equal((await run(w, 'payments.card.cancel', o2)).result, 'reverted');
  assert.equal(w.fields['有効期限'], '2027-10-11');
  assert.equal((await run(w, 'payments.card.cancel', o2)).result, 'already_reverted');
  // 1 本目の返金は、後から別の変更（2 本目の付与→返金）を経ても値が付与時と同じなら戻せる
  w.payments[o1] = { ...w.payments[o1], status: 'CANCELED' };
  assert.equal((await run(w, 'payments.card.cancel', o1)).result, 'reverted');
  assert.equal(w.fields['プラン'], 'Free');
  assert.equal(w.fields['有効期限'], null);
  assert.equal((await readCardOrderStatus({ redis: w.redisCmd, orderId: o1, recordId: REC })).status, 'refunded');
  // 再契約
  const o3 = 'ak-premium-lifetime-u3';
  w.payments[o3] = pay(o3, 'premium-lifetime', 78000);
  assert.equal((await run(w, 'payments.card.exec', o3)).result, 'granted');
  assert.equal(w.fields['有効期限'], '2099-12-31');
});

test('返金時に付与後の別変更があれば戻さない（管理者へ）／付与していない注文の返金は何もしない', async () => {
  const o = 'ak-premium-annual-x1';
  const w = world({ payments: { [o]: pay(o, 'premium-annual', 49800) } });
  await run(w, 'payments.card.exec', o);
  w.fields['有効期限'] = '2030-01-01'; // 管理者が延長
  w.payments[o] = { ...w.payments[o], status: 'CANCELED' };
  assert.equal((await run(w, 'payments.card.cancel', o)).result, 'refund_conflict_changed_after_grant:有効期限');
  assert.equal(w.fields['有効期限'], '2030-01-01');
  const o2 = 'ak-premium-annual-x2';
  w.payments[o2] = pay(o2, 'premium-annual', 49800, 'CANCELED');
  assert.equal((await run(w, 'payments.card.cancel', o2)).result, 'refund_without_grant');
  assert.equal(decideRefundRevert({ current: {}, applied: null }).action, 'noop');
  assert.equal(matchPayment({ payment: null, reservation: null }).ok, false);
});

test('Function: 本番サイトで受付しない・署名必須・E2E 経路はテストモード限定で +fincode-e2e のレコードだけ', () => {
  const read = (f) => readFileSync(fileURLToPath(new URL(`../../../../netlify/functions/${f}`, import.meta.url)), 'utf8');
  const wh = read('fincode-webhook.js');
  assert.match(wh, /if \(!verifyWebhookSignature\(sig, env\.FINCODE_WEBHOOK_SIGNATURE\)\) return \{ statusCode: 401/);
  const cs = read('fincode-create-session.js');
  assert.match(cs, /if \(!mode\.ok \|\| mode\.mode !== 'test'\) return null;/);
  assert.match(cs, /secret\.length < 24/);
  assert.match(cs, /\\\+fincode-e2e\[\^@\]\*@/);
  assert.equal(/console\.(log|error)\([^)]*(Email|email|FINCODE_SECRET_KEY)/.test(wh + cs), false, 'ログにメール・鍵を出さない');
});
