/**
 * Premium Plus 注文の監視・最初の本物の注文の自動確認（2026-09-29）の重要仕様
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { summarizePlusOrders, operatorActions, actionsFingerprint } from './premiumPlusOrderMonitor.js';
import { judgeFirstPlusOrder } from '../ops/plusOrderCheck.js';

const A = 'recMONITORTEST001';
const B = 'recMONITORTEST002';
const NOW = Date.parse('2026-10-05T03:00:00Z');
const order = (rec, day, over = {}) => ({
  orderId: `${rec}:${day}`, recordId: rec, saleDate: day, status: 'awaiting_payment',
  couponState: 'none', metricState: 'not_yet', receivedAt: NOW - 5 * 3600000, ...over,
});
const confirmed = (rec, day, over = {}) => order(rec, day, { status: 'confirmed', metricState: 'counted', ...over });
const purchase = (rec, days) => [rec, { count: days.length, orders: Object.fromEntries(days.map((d) => [`${rec}:premium-plus:${d}`, NOW])) }];
const code = (fn) => { try { fn(); return 'ok'; } catch (e) { return e.code; } };

test('販売停止中（注文 0）は待機中・対応不要', () => {
  const s = summarizePlusOrders({ orders: [], purchaseRows: [], nowMs: NOW });
  assert.equal(code(() => judgeFirstPlusOrder(s)), 'no_plus_order_yet');
  assert.deepEqual(operatorActions(s), []);
});

test('【重要】未確認の注文は運営者への対応として必ず出る（経過時間つき）・自動確認は待機中', () => {
  const s = summarizePlusOrders({ orders: [order(A, '2026-10-05')], purchaseRows: [], nowMs: NOW });
  const acts = operatorActions(s);
  assert.equal(acts[0].key, 'awaiting');
  assert.match(acts[0].text, /約 5 時間/);
  assert.equal(code(() => judgeFirstPlusOrder(s)), 'no_plus_confirmation_yet');
});

test('【重要】入金確認後、新系列にちょうど 1 件なら成功', () => {
  const s = summarizePlusOrders({ orders: [confirmed(A, '2026-10-05')], purchaseRows: [purchase(A, ['2026-10-05'])], nowMs: NOW });
  assert.equal(s.consistent, true);
  assert.equal(s.purchase.recorded, 1);
  assert.equal(code(() => judgeFirstPlusOrder(s)), 'ok');
  assert.deepEqual(operatorActions(s), []);
});

test('【重要】二重計上・計上漏れ・注文に無い計上はすべて不一致（赤）', () => {
  const dup = summarizePlusOrders({ orders: [confirmed(A, '2026-10-05')], purchaseRows: [[A, { count: 2, orders: { [`${A}:premium-plus:2026-10-05`]: NOW } }]], nowMs: NOW });
  assert.equal(dup.purchase.duplicated, true);
  assert.equal(code(() => judgeFirstPlusOrder(dup)), 'plus_purchase_mismatch');
  const miss = summarizePlusOrders({ orders: [confirmed(A, '2026-10-05')], purchaseRows: [], nowMs: NOW });
  assert.equal(miss.purchase.missing, 1);
  assert.equal(code(() => judgeFirstPlusOrder(miss)), 'plus_purchase_mismatch');
  const extra = summarizePlusOrders({ orders: [confirmed(A, '2026-10-05')], purchaseRows: [purchase(A, ['2026-10-05']), purchase(B, ['2026-10-04'])], nowMs: NOW });
  assert.equal(extra.purchase.unexpected, 1);
  assert.equal(operatorActions(extra).some((a) => a.key === 'mismatch'), true);
});

test('要修復は赤・対応に出る／テスト注文は本物に数えず後片付け漏れとして出す', () => {
  const s = summarizePlusOrders({ orders: [confirmed(A, '2026-10-05', { metricState: 'needs_repair' })], purchaseRows: [], nowMs: NOW });
  assert.equal(code(() => judgeFirstPlusOrder(s)), 'plus_order_needs_repair');
  const c = summarizePlusOrders({ orders: [order(A, '2000-01-01', { canary: true })], purchaseRows: [], nowMs: NOW });
  assert.equal(c.real.total, 0);
  assert.equal(operatorActions(c).some((a) => a.key === 'canary'), true);
});

test('集計は識別子を返さない', () => {
  const s = summarizePlusOrders({ orders: [confirmed(A, '2026-10-05')], purchaseRows: [purchase(A, ['2026-10-05'])], nowMs: NOW });
  assert.equal(/rec[A-Za-z0-9]{14}/.test(JSON.stringify(s)), false);
});

test('通知は状態が変わったときだけ（同じ状態なら指紋が同じ）', () => {
  const a = summarizePlusOrders({ orders: [order(A, '2026-10-05')], purchaseRows: [], nowMs: NOW });
  const b = summarizePlusOrders({ orders: [order(A, '2026-10-05')], purchaseRows: [], nowMs: NOW + 3600000 });
  const c = summarizePlusOrders({ orders: [order(A, '2026-10-05'), order(B, '2026-10-05')], purchaseRows: [], nowMs: NOW });
  assert.equal(actionsFingerprint(a), actionsFingerprint(b));
  assert.notEqual(actionsFingerprint(a), actionsFingerprint(c));
});

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('監視 workflow: 毎時・読み取り鍵だけ・Issue 1 つを開閉・状態変化でだけコメント', () => {
  const wf = read('../../../../.github/workflows/premium-plus-order-monitor.yml');
  assert.match(wf, /cron: '17 \* \* \* \*'/);
  assert.match(wf, /PAYMENT_FUNNEL_READ_SECRET: \$\{\{ secrets\.PAYMENT_FUNNEL_READ_SECRET \}\}/);
  assert.equal(/PREMIUM_PLUS_ADMIN_SECRET|MARKETING_ADMIN_SECRET/.test(wf), false);
  assert.match(wf, /\[Plus 注文\] 要対応/);
  assert.match(wf, /if \[ "\$old" != "fingerprint:\$fp" \]/);
  assert.match(wf, /gh issue close "\$no"/);
});

test('読み取り API は件数だけ・書き込みを持たない', () => {
  const fn = read('../../../netlify/functions/admin-payment-funnel.js');
  assert.match(fn, /action === 'plusOrdersSummary'/);
  assert.equal(/HSET|HDEL|HINCRBY|confirmOrder|revokeOrder|cancelOrder/.test(fn), false);
});

test('自動確認が登録されている（販売を再開しない・未来の確認の 5 要素）', () => {
  const reg = JSON.parse(read('../../../../ops/scheduled-checks.json'));
  const c = reg.checks.find((x) => x.id === 'premium-plus-first-order-2026');
  assert.ok(c);
  assert.equal(c.kind, 'premium-plus-first-order');
  assert.match(c.trigger, /販売は再開しない/);
  for (const k of ['runFrom', 'runUntil', 'trigger', 'compare', 'record', 'onFailure']) assert.ok(c[k], k);
});
