/**
 * Premium Plus の入金確認（Plus 専用の注文 / 2026-09-29 MK 決定 B）の重要仕様
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createOrderStore, recordOrderOnApplication, confirmOrder, repairOrder, cancelOrder, revokeOrder,
  PP_ORDERS_KEY,
} from './premiumPlusOrderService.js';
import { buildOrderId, purchaseOrderKey, ORDER_STATUS, COUPON_STATE, METRIC_STATE } from './premiumPlusOrders.js';
import { recordPlusPurchase, revokePlusPurchase } from './premiumPlusFunnelServer.js';
import { FUNNEL_KEY } from './premiumPlusFunnelStore.js';

const REC = 'recORDERTEST00001';
const OTHER = 'recORDERTEST00002';
const DAY = '2026-10-01';
const T0 = Date.parse('2026-09-30T08:00:00Z');
const OID = `${REC}:${DAY}`;

function memRedis() {
  const h = new Map(); const kv = new Map(); const calls = [];
  const H = (k) => { if (!h.has(k)) h.set(k, new Map()); return h.get(k); };
  const cmd = async (c) => {
    calls.push(c);
    const [op, k, a, b] = c;
    switch (op) {
      case 'HGET': return H(k).get(a) ?? null;
      case 'HSET': H(k).set(a, b); return 1;
      case 'HSETNX': if (H(k).has(a)) return 0; H(k).set(a, b); return 1;
      case 'HDEL': return H(k).delete(a) ? 1 : 0;
      case 'HINCRBY': { const n = Number(H(k).get(a) || 0) + Number(b); H(k).set(a, String(n)); return n; }
      case 'HGETALL': return [...H(k).entries()].flat();
      case 'SET': if (c.includes('NX') && kv.has(k)) return null; kv.set(k, a); return 'OK';
      case 'DEL': return kv.delete(k) ? 1 : 0;
      default: return null;
    }
  };
  return { h, kv, calls, cmd };
}

function fakeDeps(over = {}) {
  const log = { record: [], revoke: [], redeem: 0, release: 0 };
  return {
    log,
    deps: {
      recordPurchase: async (i) => { log.record.push(i); return over.record ? over.record(i) : { counted: true }; },
      revokePurchase: async (i) => { log.revoke.push(i); return { removed: true }; },
      redeemCoupon: async () => { log.redeem += 1; return over.redeem ? over.redeem() : 'redeemed'; },
      releaseCoupon: async () => { log.release += 1; return 'released'; },
    },
  };
}

async function seed(r, { couponId = null, amount = 68000 } = {}) {
  const store = createOrderStore({ redisCmd: r.cmd });
  await recordOrderOnApplication({ store, input: { recordId: REC, saleDate: DAY, saleLabel: '10/1 大井', amount, couponId, nowMs: T0 } });
  return store;
}

test('注文 ID は会員×対象日で一意・不正な識別子では作らない', async () => {
  assert.equal(buildOrderId(REC, DAY), OID);
  assert.equal(buildOrderId('taro@example.com', DAY), null);
  assert.equal(buildOrderId(REC, '10/1'), null);
  const r = memRedis();
  const out = await recordOrderOnApplication({ store: createOrderStore({ redisCmd: r.cmd }), input: { recordId: '', saleDate: DAY, nowMs: T0 } });
  assert.equal(out.outcome, 'invalid_input');
  assert.equal(r.h.get(PP_ORDERS_KEY), undefined);
});

test('報告の再送は同じ注文にまとまり、金額・クーポン・状態を上書きしない', async () => {
  const r = memRedis();
  const store = await seed(r, { couponId: 'pp-reopen@v1', amount: 58000 });
  const again = await recordOrderOnApplication({ store, input: { recordId: REC, saleDate: DAY, amount: 68000, couponId: null, nowMs: T0 + 1000 } });
  assert.equal(again.outcome, 're_reported');
  const o = await store.get(OID);
  assert.equal(o.amount, 58000);
  assert.equal(o.couponState, COUPON_STATE.PENDING);
  assert.equal(o.reportCount, 2);
  assert.equal(o.status, ORDER_STATUS.AWAITING);
});

test('【重要】入金確認は 1 回だけ数える: 再実行は already_confirmed で計測も呼ばない', async () => {
  const r = memRedis(); const store = await seed(r); const { deps, log } = fakeDeps();
  const a = await confirmOrder({ store, deps, orderId: OID, recordId: REC, actor: 'MK', nowMs: T0 + 5000 });
  assert.equal(a.ok, true); assert.equal(a.code, 'confirmed');
  const b = await confirmOrder({ store, deps, orderId: OID, recordId: REC, actor: 'MK', nowMs: T0 + 6000 });
  assert.equal(b.ok, false); assert.equal(b.code, 'already_confirmed'); assert.equal(b.idempotent, true);
  assert.equal(log.record.length, 1);
  assert.equal(log.record[0].orderKey, `${REC}:premium-plus:${DAY}`);
  assert.equal(log.record[0].productPlan, 'Premium Plus');
});

test('【重要】同時に 2 回押されても 1 回しか確定しない（ロック）', async () => {
  const r = memRedis(); const store = await seed(r); const { deps, log } = fakeDeps();
  const [x, y] = await Promise.all([
    confirmOrder({ store, deps, orderId: OID, recordId: REC, actor: 'MK', nowMs: T0 }),
    confirmOrder({ store, deps, orderId: OID, recordId: REC, actor: 'MK', nowMs: T0 }),
  ]);
  assert.equal([x, y].filter((o) => o.ok).length, 1);
  assert.equal(log.record.length, 1);
});

test('【重要】一意に確認できないときは何もしない（fail closed）', async () => {
  const r = memRedis(); const store = await seed(r); const { deps, log } = fakeDeps();
  const before = JSON.stringify([...r.h.get(PP_ORDERS_KEY)]);
  for (const [args, code] of [
    [{ orderId: `${REC}:2026-10-02`, recordId: REC, actor: 'MK' }, 'order_not_found'],
    [{ orderId: OID, recordId: OTHER, actor: 'MK' }, 'record_mismatch'],
    [{ orderId: OID, recordId: '', actor: 'MK' }, 'record_mismatch'],
    [{ orderId: OID, recordId: REC, actor: '' }, 'missing_actor'],
  ]) {
    const out = await confirmOrder({ store, deps, ...args, nowMs: T0 });
    assert.equal(out.ok, false); assert.equal(out.code, code);
  }
  assert.equal(log.record.length + log.redeem, 0);
  assert.equal(JSON.stringify([...r.h.get(PP_ORDERS_KEY)]), before);
});

test('クーポンなしの購入: クーポン処理を呼ばずに確定する', async () => {
  const r = memRedis(); const store = await seed(r); const { deps, log } = fakeDeps();
  const out = await confirmOrder({ store, deps, orderId: OID, recordId: REC, actor: 'MK', nowMs: T0 });
  assert.equal(out.order.couponState, COUPON_STATE.NONE);
  assert.equal(log.redeem, 0);
});

test('クーポンありの購入: 確定後に使用済みにする', async () => {
  const r = memRedis(); const store = await seed(r, { couponId: 'pp-reopen@v1', amount: 58000 }); const { deps, log } = fakeDeps();
  const out = await confirmOrder({ store, deps, orderId: OID, recordId: REC, actor: 'MK', nowMs: T0 });
  assert.equal(out.code, 'confirmed');
  assert.equal(out.order.couponState, COUPON_STATE.REDEEMED);
  assert.equal(log.redeem, 1);
});

test('【重要】クーポン処理の失敗で確定を巻き戻さず、要修復を明示 → 修復で完了', async () => {
  const r = memRedis(); const store = await seed(r, { couponId: 'pp-reopen@v1' });
  let fail = true;
  const { deps, log } = fakeDeps({ redeem: () => (fail ? 'ledger_unavailable:http_503' : 'redeemed') });
  const out = await confirmOrder({ store, deps, orderId: OID, recordId: REC, actor: 'MK', nowMs: T0 });
  assert.equal(out.ok, true);
  assert.equal(out.code, 'confirmed_needs_repair');
  assert.equal(out.order.status, ORDER_STATUS.CONFIRMED);
  assert.equal(out.order.metricState, METRIC_STATE.COUNTED);
  assert.equal(out.order.couponState, COUPON_STATE.NEEDS_REPAIR);
  assert.equal(out.order.needsRepair, true);
  fail = false;
  const rep = await repairOrder({ store, deps, orderId: OID, nowMs: T0 + 60000 });
  assert.equal(rep.code, 'repaired');
  assert.equal(rep.order.couponState, COUPON_STATE.REDEEMED);
  assert.equal(log.record.length, 1, '修復で計測を二重に呼んだ');
});

test('計測の失敗も要修復として残り、修復は同じ orderKey で再実行する', async () => {
  const r = memRedis(); const store = await seed(r);
  let n = 0;
  const { deps, log } = fakeDeps({ record: () => (n++ === 0 ? { counted: false, reason: 'timeout' } : { counted: true }) });
  const out = await confirmOrder({ store, deps, orderId: OID, recordId: REC, actor: 'MK', nowMs: T0 });
  assert.equal(out.order.metricState, METRIC_STATE.NEEDS_REPAIR);
  await repairOrder({ store, deps, orderId: OID, nowMs: T0 + 1 });
  assert.equal(log.record.length, 2);
  assert.equal(log.record[0].orderKey, log.record[1].orderKey);
  assert.equal((await store.get(OID)).metricState, METRIC_STATE.COUNTED);
});

test('取消（未入金・誤申込）: 未確認だけ・理由必須・クーポン予約を解除', async () => {
  const r = memRedis(); const store = await seed(r, { couponId: 'pp-reopen@v1' }); const { deps, log } = fakeDeps();
  assert.equal((await cancelOrder({ store, deps, orderId: OID, actor: 'MK', reason: '', nowMs: T0 })).code, 'missing_reason');
  const out = await cancelOrder({ store, deps, orderId: OID, actor: 'MK', reason: '未入金', nowMs: T0 });
  assert.equal(out.order.status, ORDER_STATUS.CANCELLED);
  assert.equal(out.order.couponState, COUPON_STATE.RELEASED);
  assert.equal(log.release, 1);
  // 取消後は入金確認できない
  const c = await confirmOrder({ store, deps, orderId: OID, recordId: REC, actor: 'MK', nowMs: T0 });
  assert.equal(c.ok, false);
  assert.match(c.code, /^not_awaiting/);
});

test('訂正（誤って確定）: 確認済みだけ・購入件数から外す・取消は二重にしない', async () => {
  const r = memRedis(); const store = await seed(r); const { deps, log } = fakeDeps();
  assert.match((await revokeOrder({ store, deps, orderId: OID, actor: 'MK', reason: 'x', nowMs: T0 })).code, /^not_confirmed/);
  await confirmOrder({ store, deps, orderId: OID, recordId: REC, actor: 'MK', nowMs: T0 });
  const out = await revokeOrder({ store, deps, orderId: OID, actor: 'MK', reason: '別人の振込だった', nowMs: T0 + 1 });
  assert.equal(out.order.status, ORDER_STATUS.REVOKED);
  assert.equal(out.order.metricState, METRIC_STATE.REMOVED);
  const again = await revokeOrder({ store, deps, orderId: OID, actor: 'MK', reason: 'x', nowMs: T0 + 2 });
  assert.equal(again.code, 'already_revoked');
  assert.equal(log.revoke.length, 1);
});

test('【重要】実際の計測ストアと通し: 新系列へ 1 件だけ・訂正で 0 件・旧系列は触らない', async () => {
  const r = memRedis();
  r.h.set(FUNNEL_KEY.PURCHASE_LEGACY, new Map([[REC, JSON.stringify({ count: 2, orders: { a: 1 } })]]));
  const store = await seed(r);
  const deps = {
    recordPurchase: (i) => recordPlusPurchase({ ...i, redisCmd: r.cmd }),
    revokePurchase: (i) => revokePlusPurchase({ ...i, redisCmd: r.cmd }),
    redeemCoupon: async () => 'redeemed',
    releaseCoupon: async () => 'released',
  };
  await confirmOrder({ store, deps, orderId: OID, recordId: REC, actor: 'MK', nowMs: T0 });
  await confirmOrder({ store, deps, orderId: OID, recordId: REC, actor: 'MK', nowMs: T0 + 1 });
  const p = JSON.parse(r.h.get(FUNNEL_KEY.PURCHASE).get(REC));
  assert.equal(p.count, 1);
  assert.deepEqual(Object.keys(p.orders), [purchaseOrderKey({ recordId: REC, saleDate: DAY })]);
  const dailyPurchase = [...r.h.get(FUNNEL_KEY.DAILY).entries()].filter(([f]) => f.includes('|purchase_plus|'));
  assert.equal(dailyPurchase.reduce((n, [, v]) => n + Number(v), 0), 1);
  await revokeOrder({ store, deps, orderId: OID, actor: 'MK', reason: '訂正', nowMs: T0 + 2 });
  assert.equal(r.h.get(FUNNEL_KEY.PURCHASE).has(REC), false, '訂正後も購入が残っている');
  assert.equal(dailyPurchase.length, 1);
  assert.equal([...r.h.get(FUNNEL_KEY.DAILY).entries()].filter(([f]) => f.includes('|purchase_plus|')).reduce((n, [, v]) => n + Number(v), 0), 0);
  // 旧系列は不変
  assert.equal(JSON.parse(r.h.get(FUNNEL_KEY.PURCHASE_LEGACY).get(REC)).count, 2);
});

// ── 配線・影響範囲 ───────────────────────────────────────
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('【重要】Plus 以外に影響しない: 注文操作は Customers・プラン・権利を書かない', () => {
  for (const f of ['./premiumPlusOrders.js', './premiumPlusOrderService.js', './premiumPlusOrderDeps.js']) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.equal(/Customers|PaymentConfirmed|RequestedPlan|'プラン'|PlanType|有効期限/.test(src), false, f);
  }
});

test('配線: 申込は Plus で会員を特定できたときだけ注文を作る（推測しない・失敗で申込を止めない）', () => {
  const src = read('../../../netlify/functions/bank-transfer-application.js');
  const at = src.indexOf('await recordOrderOnApplication(');
  assert.ok(at > 0);
  const block = src.slice(src.lastIndexOf('if (isPremiumPlusOrder) {', at), at);
  assert.match(block, /plusCustomerRecordId && saleOrder && saleOrder\.date/);
  assert.ok(at < src.indexOf("console.log('✅ Bank transfer completion report submitted:'"));
});

test('配線: 管理画面の操作は Plus 専用 action・2 段階ボタン・ダイアログを出さない', () => {
  const fn = read('../../../netlify/functions/premium-plus-eligibility.js');
  for (const a of ['plusOrders', 'plusOrderConfirm', 'plusOrderRepair', 'plusOrderCancel', 'plusOrderRevoke']) assert.ok(fn.includes(`'${a}'`), a);
  const page = read('../../pages/admin/premium-plus-eligibility.astro');
  assert.match(page, /id="ppOrders"/);
  assert.match(page, /armButton\(mkOrderBtn\('入金確認'\)/);
  const ordersUi = page.slice(page.indexOf('// ── Premium Plus 注文（入金確認）'), page.indexOf('async function load(opts = {})'));
  assert.equal(/window\.confirm|confirm\(|alert\(|prompt\(/.test(ordersUi.replace(/plusOrderConfirm/g, '')), false);
});

// ── 本番の実操作確認用テスト注文 ─────────────────────────────
import { createCanaryOrder, deleteCanaryOrder } from './premiumPlusOrderService.js';

test('テスト注文: env gate が閉じていれば作れない・消せない', async () => {
  const r = memRedis(); const store = createOrderStore({ redisCmd: r.cmd });
  assert.equal((await createCanaryOrder({ store, env: {}, recordId: REC, nowMs: T0 })).code, 'canary_disabled');
  assert.equal((await deleteCanaryOrder({ store, env: {}, orderId: `${REC}:2000-01-01`, nowMs: T0 })).code, 'canary_disabled');
});

test('【重要】テスト注文は実注文と衝突せず、訂正で計上から外した後にだけ消せる・実注文は消せない', async () => {
  const r = memRedis(); const store = await seed(r); const env = { PP_ORDER_CANARY_ENABLED: '1' };
  const c = await createCanaryOrder({ store, env, recordId: REC, nowMs: T0 });
  assert.equal(c.code, 'canary_created');
  assert.equal(c.order.orderId, `${REC}:2000-01-01`);
  assert.match(c.order.statusLabel, /^【テスト】/);
  const { deps } = fakeDeps();
  const cid = c.order.orderId;
  assert.match((await deleteCanaryOrder({ store, env, orderId: cid, nowMs: T0 })).code, /^not_terminal/);
  await confirmOrder({ store, deps, orderId: cid, recordId: REC, actor: 'MK', nowMs: T0 });
  await revokeOrder({ store, deps, orderId: cid, actor: 'MK', reason: '実操作確認の後片付け', nowMs: T0 + 1 });
  assert.equal((await deleteCanaryOrder({ store, env, orderId: cid, nowMs: T0 + 2 })).code, 'canary_deleted');
  assert.equal(await store.get(cid), null);
  // 実注文は消せない
  await cancelOrder({ store, deps, orderId: OID, actor: 'MK', reason: 'x', nowMs: T0 });
  assert.equal((await deleteCanaryOrder({ store, env, orderId: OID, nowMs: T0 })).code, 'not_canary');
});

test('管理画面の計測待ちは顧客ページ用の 700ms ではなく長い上限（本番で 700ms を超えて要修復になった）', async () => {
  const { ORDER_METRIC_TIMEOUT_MS, makeOrderDeps } = await import('./premiumPlusOrderDeps.js');
  const { RECORD_TIMEOUT_MS } = await import('./premiumPlusFunnelServer.js');
  assert.ok(ORDER_METRIC_TIMEOUT_MS >= 5000 && ORDER_METRIC_TIMEOUT_MS > RECORD_TIMEOUT_MS);
  const src = read('./premiumPlusOrderDeps.js');
  assert.equal((src.match(/timeoutMs: ORDER_METRIC_TIMEOUT_MS/g) || []).length, 2);
  assert.equal(typeof makeOrderDeps({}).recordPurchase, 'function');
});
