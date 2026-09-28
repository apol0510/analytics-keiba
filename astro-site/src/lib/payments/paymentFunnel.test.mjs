/**
 * 決済ファネル（申込受理 → 入金確認）の重要仕様
 *   - 語彙は閉じている（PII・自由文字列を Redis に入れない）
 *   - 同じ日・同じ申込は 1 回だけ数える（再送・二重送信で水増ししない）
 *   - 入金確認で「報告からの日数」を数え、確認待ちから外す
 *   - Redis 未設定・障害・遅延で申込／昇格を止めない（例外を投げない）
 *   - 配線: 申込受理は保存成功後だけ・入金確認は昇格 PATCH 成功後だけ
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createPaymentFunnelStore, funnelPlan, funnelPlanType, leadBucket, jstDay, summarize,
  PAYMENT_FUNNEL_KEY, FUNNEL_PLANS, FUNNEL_PLAN_TYPES,
} from './paymentFunnel.js';
import {
  recordPaymentApplication, recordPaymentConfirmation, readPaymentFunnelSummary,
} from './paymentFunnelServer.js';

const REC = 'recAAAAAAAAAAAAAA';
const REC2 = 'recBBBBBBBBBBBBBB';
const T0 = Date.parse('2026-09-29T01:00:00Z'); // JST 10:00
const DAY = 86400000;

/** Upstash の HASH 相当（使うコマンドだけ） */
function fakeRedis() {
  const h = new Map();
  const log = [];
  const get = (k) => { if (!h.has(k)) h.set(k, new Map()); return h.get(k); };
  const cmd = async (args) => {
    log.push(args);
    const [c, k, f, v] = args;
    const m = get(k);
    switch (c) {
      case 'HSETNX': if (m.has(f)) return 0; m.set(f, v); return 1;
      case 'HSET': m.set(f, v); return 1;
      case 'HGET': return m.has(f) ? m.get(f) : null;
      case 'HDEL': return m.delete(f) ? 1 : 0;
      case 'HINCRBY': { const n = Number(m.get(f) || 0) + Number(v); m.set(f, String(n)); return n; }
      case 'HGETALL': return [...m.entries()].flat();
      default: throw new Error(`unexpected ${c}`);
    }
  };
  return { cmd, h, log };
}

test('語彙は閉じている: 未知のプラン・PlanType は other に畳む', () => {
  assert.equal(funnelPlan('Light'), 'light');
  assert.equal(funnelPlan('Premium'), 'premium');
  assert.equal(funnelPlan('Premium Sanrenpuku'), 'premium-sanrenpuku');
  assert.equal(funnelPlan('Premium Plus'), 'premium-plus');
  assert.equal(funnelPlan('taro@example.com'), 'other');
  assert.equal(funnelPlan(undefined), 'other');
  assert.equal(funnelPlanType('annual'), 'Annual');
  assert.equal(funnelPlanType('月払い 山田'), 'other');
  for (const p of ['Light', 'x', null, 'Premium Plus']) assert.ok(FUNNEL_PLANS.includes(funnelPlan(p)));
  for (const t of ['Monthly', 'y', null]) assert.ok(FUNNEL_PLAN_TYPES.includes(funnelPlanType(t)));
});

test('日付は JST・日数の区分は境界どおり', () => {
  assert.equal(jstDay(Date.parse('2026-09-28T15:00:00Z')), '20260929'); // JST 0:00
  assert.equal(jstDay(Date.parse('2026-09-28T14:59:59Z')), '20260928');
  assert.equal(leadBucket(0), 'd0');
  assert.equal(leadBucket(DAY - 1), 'd0');
  assert.equal(leadBucket(DAY), 'd1');
  assert.equal(leadBucket(3 * DAY), 'd2-3');
  assert.equal(leadBucket(7 * DAY), 'd4-7');
  assert.equal(leadBucket(8 * DAY), 'd8plus');
  assert.equal(leadBucket(-5), 'd0');
});

test('Redis に入るのは recordId と閉じた語彙だけ（メール・氏名・金額は入らない）', async () => {
  const r = fakeRedis();
  const s = createPaymentFunnelStore({ redisCmd: r.cmd });
  await s.recordApplication({ recordId: REC, planName: 'Premium', planType: 'Annual', nowMs: T0, email: 'a@b.jp', amount: 44820 });
  const dump = JSON.stringify(r.log);
  assert.ok(!dump.includes('@'));
  assert.ok(!dump.includes('44820'));
  for (const [, k] of r.log) assert.ok(Object.values(PAYMENT_FUNNEL_KEY).includes(k));
});

test('同じ日の同じ申込は 1 回だけ数える／別の日・別の人は数える', async () => {
  const r = fakeRedis();
  const s = createPaymentFunnelStore({ redisCmd: r.cmd });
  assert.equal((await s.recordApplication({ recordId: REC, planName: 'Light', planType: 'Monthly', nowMs: T0 })).counted, true);
  assert.equal((await s.recordApplication({ recordId: REC, planName: 'Light', planType: 'Monthly', nowMs: T0 + 3600000 })).counted, false);
  assert.equal((await s.recordApplication({ recordId: REC2, planName: 'Light', planType: 'Monthly', nowMs: T0 })).counted, true);
  assert.equal((await s.recordApplication({ recordId: REC, planName: 'Light', planType: 'Monthly', nowMs: T0 + DAY })).counted, true);
  const sum = await s.summary({ days: 30, nowMs: T0 + DAY });
  assert.equal(sum.received, 3);
  assert.equal(sum.receivedByPlan['light/Monthly'], 3);
});

test('入金確認: 報告からの日数を数え、確認待ちから外す／確認待ちの経過日数が見える', async () => {
  const r = fakeRedis();
  const s = createPaymentFunnelStore({ redisCmd: r.cmd });
  await s.recordApplication({ recordId: REC, planName: 'Premium', planType: 'Annual', nowMs: T0 });
  await s.recordApplication({ recordId: REC2, planName: 'Light', planType: 'Monthly', nowMs: T0 - 10 * DAY });
  const c = await s.recordConfirmation({ recordId: REC, planName: 'Premium', planType: 'Annual', nowMs: T0 + 2 * DAY });
  assert.equal(c.counted, true);
  assert.equal(c.lead, 'd2-3');
  const sum = await s.summary({ days: 30, nowMs: T0 + 2 * DAY });
  assert.equal(sum.confirmed, 1);
  assert.equal(sum.confirmLead['d2-3'], 1);
  assert.equal(sum.open.count, 1);          // REC2 だけが確認待ち
  assert.equal(sum.open.byAge.d8plus, 1);   // 12 日放置
  // 再実行（Automation の再発火）は二重に数えない
  assert.equal((await s.recordConfirmation({ recordId: REC, planName: 'Premium', planType: 'Annual', nowMs: T0 + 2 * DAY })).counted, false);
});

test('申込記録の無い入金確認（計測開始前の申込）は件数だけ数え、日数は推測しない', async () => {
  const r = fakeRedis();
  const s = createPaymentFunnelStore({ redisCmd: r.cmd });
  const c = await s.recordConfirmation({ recordId: REC, planName: 'Premium Sanrenpuku', planType: 'Lifetime', nowMs: T0 });
  assert.equal(c.counted, true);
  assert.equal(c.lead, null);
  const sum = await s.summary({ nowMs: T0 });
  assert.deepEqual(sum.confirmLead, {});
  assert.equal(sum.confirmedByPlan['premium-sanrenpuku/Lifetime'], 1);
});

test('集計期間外は数えない', () => {
  const daily = ['20260801|application_received|light|Monthly', '5', '20260929|application_received|light|Monthly', '2'];
  const s = summarize({ daily, open: [], days: 30, nowMs: T0 });
  assert.equal(s.received, 2);
  assert.equal(s.byDay['20260929'].received, 2);
});

test('サーバー用ラッパー: Redis 未設定は 0 件ではなく measurement_unavailable／障害・遅延でも例外を投げない', async () => {
  assert.deepEqual(await recordPaymentApplication({ recordId: REC, planName: 'Light', env: {} }),
    { counted: false, reason: 'measurement_unavailable', lead: null });
  assert.equal(await readPaymentFunnelSummary({ env: {} }), null);
  const boom = async () => { throw new Error('down'); };
  assert.equal((await recordPaymentConfirmation({ recordId: REC, planName: 'Light', redisCmd: boom })).reason, 'record_failed');
  const slow = () => new Promise(() => {});
  const t = Date.now();
  const out = await recordPaymentApplication({ recordId: REC, planName: 'Light', redisCmd: slow, timeoutMs: 30 });
  assert.equal(out.reason, 'timeout');
  assert.ok(Date.now() - t < 1000);
});

// ── 配線（Function のソースを読んで固定する）───────────────────────────
const fnSrc = (name) => readFileSync(new URL(`../../../netlify/functions/${name}`, import.meta.url), 'utf8');

test('配線: 申込受理は Airtable 保存成功の後だけ・成功応答の前で記録する', () => {
  const src = fnSrc('bank-transfer-application.js');
  const call = src.indexOf('await recordPaymentApplication(');
  assert.ok(call > 0);
  assert.ok(call < src.indexOf("console.log('✅ Bank transfer completion report submitted:'"));
  // recordId を埋めるのは各分岐の保存成功ログの後
  for (const marker of ["console.log('✅ Airtable updated (existing customer):'", 'Airtable update failed (race fallback)', "console.log('✅ Airtable created (new customer):'"]) {
    const at = src.indexOf(marker);
    assert.ok(at > 0, marker);
    assert.ok(src.indexOf('paymentFunnelRecord = {', at) > at, marker);
  }
  // 識別子は recordId だけ（メール・氏名を計測に渡さない）
  const block = src.slice(call, call + 200);
  assert.ok(!/email|fullName/.test(block));
});

test('配線: 入金確認は昇格 PATCH 成功（!patchRes.ok で return）の後だけ記録する', () => {
  const src = fnSrc('confirm-bank-payment.js');
  const guard = src.indexOf('if (!patchRes.ok)');
  const call = src.indexOf('await recordPaymentConfirmation(');
  assert.ok(guard > 0 && call > guard);
  assert.ok(src.slice(call, call + 300).includes("fields['RequestedPlan']"));
});

test('admin API は読み取り専用・secret 必須', () => {
  const src = fnSrc('admin-payment-funnel.js');
  assert.ok(src.includes("provided !== SECRET"));
  assert.ok(!/recordPayment(Application|Confirmation)|HSET|HINCRBY|HDEL/.test(src));
});
