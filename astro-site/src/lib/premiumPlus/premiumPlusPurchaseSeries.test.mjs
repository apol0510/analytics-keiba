/**
 * Premium Plus 購入件数の系列切替（2026-09-29 MK 決定 A）の重要仕様
 *
 *   - Plus 以外（Light / Premium / 三連複）の入金確認は Plus 購入件数へ入れない（fail closed）
 *   - 本物の Plus 購入は新系列（…:purchase:s2 / 日次 purchase_plus）へ 1 注文 1 回だけ記録する
 *   - 旧系列（…:purchase / 日次 purchase）は他商品混入の参考値。読まない・書かない・新系列と混ぜない
 *   - 他の段階（表示・クリック・到達・決済開始）の計測は変えない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createFunnelStore, FUNNEL_KEY, FUNNEL_EVENT, PURCHASE_DAILY_EVENT, PURCHASE_LEGACY_DAILY_EVENT,
  selectCurrentPurchaseSeries,
} from './premiumPlusFunnelStore.js';
import { recordPlusPurchase, isPlusPurchaseProduct } from './premiumPlusFunnelServer.js';
import { PURCHASE_SERIES_NOTE } from './premiumPlusFunnelAnalytics.js';

const ID = 'recSERIESTEST0001';
const T0 = Date.parse('2026-09-30T03:00:00Z');

function memRedis() {
  const db = new Map();
  const calls = [];
  const cmd = async (c) => {
    calls.push(c);
    const [op, key, a, b] = c;
    if (op === 'HGET') return db.get(`${key}|${a}`) ?? null;
    if (op === 'HSET') { db.set(`${key}|${a}`, b); return 1; }
    if (op === 'HSETNX') { const k = `${key}|${a}`; if (db.has(k)) return 0; db.set(k, b); return 1; }
    if (op === 'HINCRBY') { const k = `${key}|${a}`; const n = Number(db.get(k) || 0) + Number(b); db.set(k, String(n)); return n; }
    if (op === 'HDEL') { db.delete(`${key}|${a}`); return 1; }
    if (op === 'HGETALL') {
      const out = [];
      for (const [k, v] of db) if (k.startsWith(`${key}|`)) out.push(k.slice(key.length + 1), v);
      return out;
    }
    if (op === 'HMGET') return c.slice(2).map((id) => db.get(`${key}|${id}`) ?? null);
    return null;
  };
  return { db, calls, cmd };
}

test('Plus だけが購入件数の対象: Light / Premium / 三連複 / 不明は対象外', () => {
  assert.equal(isPlusPurchaseProduct('Premium Plus'), true);
  for (const p of ['Light', 'Premium', 'Premium Sanrenpuku', 'プレミアム', '', null, undefined]) {
    assert.equal(isPlusPurchaseProduct(p), false, String(p));
  }
});

test('【重要】Plus 以外の入金確認は Redis に一切書かない（fail closed）', async () => {
  for (const p of ['Light', 'Premium', 'Premium Sanrenpuku', undefined]) {
    const r = memRedis();
    const out = await recordPlusPurchase({ recordId: ID, productPlan: p, orderKey: 'k', nowMs: T0, redisCmd: r.cmd });
    assert.deepEqual(out, { counted: false, reason: 'not_plus_product' });
    assert.equal(r.calls.length, 0, `${p} で Redis を触った`);
  }
});

test('【重要】本物の Plus 購入は新系列へ 1 注文 1 回だけ（再実行で二重計上しない）', async () => {
  const r = memRedis();
  const a = await recordPlusPurchase({ recordId: ID, productPlan: 'Premium Plus', orderKey: `${ID}:premium-plus:2026-09-30`, nowMs: T0, redisCmd: r.cmd });
  const b = await recordPlusPurchase({ recordId: ID, productPlan: 'Premium Plus', orderKey: `${ID}:premium-plus:2026-09-30`, nowMs: T0 + 5000, redisCmd: r.cmd });
  assert.equal(a.counted, true);
  assert.equal(b.counted, false);
  assert.equal(b.reason, 'already_counted');
  // 別の対象日は別の注文
  const c = await recordPlusPurchase({ recordId: ID, productPlan: 'Premium Plus', orderKey: `${ID}:premium-plus:2026-10-01`, nowMs: T0 + 86400000, redisCmd: r.cmd });
  assert.equal(c.counted, true);
  assert.equal(JSON.parse(r.db.get(`${FUNNEL_KEY.PURCHASE}|${ID}`)).count, 2);
  // 旧系列のキー・日次 event には書かない
  const written = r.calls.filter((x) => ['HSET', 'HINCRBY', 'HSETNX'].includes(x[0]));
  assert.ok(written.every((x) => x[1] !== FUNNEL_KEY.PURCHASE_LEGACY));
  assert.ok(written.filter((x) => x[1] === FUNNEL_KEY.DAILY).every((x) => x[2].split('|')[1] === PURCHASE_DAILY_EVENT));
});

test('【重要】旧系列（他商品混入）は読まない: 個人の購入にも期間集計にも出ない', async () => {
  const r = memRedis();
  // 旧系列に混入データがある状態（本番の 2026-09-28 時点と同じ形）
  r.db.set(`${FUNNEL_KEY.PURCHASE_LEGACY}|${ID}`, JSON.stringify({ firstAt: T0 - 9e8, lastAt: T0 - 9e8, count: 2, orders: { x: 1 } }));
  r.db.set(`${FUNNEL_KEY.DAILY}|20260916|${PURCHASE_LEGACY_DAILY_EVENT}|none`, '1');
  const store = createFunnelStore({ redisCmd: r.cmd });
  const one = await store.read({ recordId: ID });
  assert.equal(one.row.purchase.count, null, '旧系列の購入が個人の購入として読まれた');
  assert.equal(one.row.purchase.firstAtMs, null);
  const daily = await store.readDaily({ nowMs: T0 });
  assert.equal(Object.keys(daily.entries).some((f) => f.includes(`|${FUNNEL_EVENT.PURCHASE}|`)), false);
  // 新系列の購入だけが `purchase` として出る
  await recordPlusPurchase({ recordId: ID, productPlan: 'Premium Plus', orderKey: 'n', nowMs: T0, redisCmd: r.cmd });
  const daily2 = await store.readDaily({ nowMs: T0 });
  const purchaseFields = Object.entries(daily2.entries).filter(([f]) => f.split('|')[1] === FUNNEL_EVENT.PURCHASE);
  assert.equal(purchaseFields.reduce((n, [, v]) => n + Number(v), 0), 1);
  // 旧系列のデータは消さない（参考値として残す）
  assert.ok(r.db.has(`${FUNNEL_KEY.PURCHASE_LEGACY}|${ID}`));
});

test('日次の系列選別は購入以外の段階を変えない', () => {
  const out = selectCurrentPurchaseSeries({
    '20260930|checkout_start|dashboard': '3',
    '20260930|cta_view|sanrenpuku': '5',
    '20260916|purchase|none': '1',
    '20260930|purchase_plus|dashboard': '1',
  });
  assert.deepEqual(out, {
    '20260930|checkout_start|dashboard': '3',
    '20260930|cta_view|sanrenpuku': '5',
    '20260930|purchase|dashboard': '1',
  });
});

test('新旧のキーは別物・管理画面に系列の常設注記を出す', () => {
  assert.notEqual(FUNNEL_KEY.PURCHASE, FUNNEL_KEY.PURCHASE_LEGACY);
  assert.match(FUNNEL_KEY.PURCHASE, /:purchase:s2$/);
  assert.match(PURCHASE_SERIES_NOTE, /2026-09-29/);
  const fn = readFileSync(new URL('../../../netlify/functions/premium-plus-eligibility.js', import.meta.url), 'utf8');
  assert.match(fn, /purchaseSeriesNote: PURCHASE_SERIES_NOTE/);
  const page = readFileSync(new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url), 'utf8');
  assert.match(page, /funnel\.purchaseSeriesNote/);
});

test('配線: 入金確認は申込内容（RequestedPlan）を渡し、Plus の注文鍵は対象日で区別する', () => {
  const src = readFileSync(new URL('../../../netlify/functions/confirm-bank-payment.js', import.meta.url), 'utf8');
  const at = src.indexOf('await recordPlusPurchase(');
  const block = src.slice(at, at + 700);
  assert.match(block, /productPlan: fields\['RequestedPlan'\]/);
  assert.match(block, /'premium-plus'/);
  assert.match(block, /fields\['SaleTargetDate'\]/);
  // 昇格 PATCH 成功後だけ
  assert.ok(at > src.indexOf('if (!patchRes.ok)'));
});
