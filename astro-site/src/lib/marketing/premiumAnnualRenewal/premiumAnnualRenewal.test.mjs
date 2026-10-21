/**
 * premiumAnnualRenewal.test.mjs — 銀行振込の Premium 年払い 期限前リマインド（MK 決定 2026-10-21）の重要仕様
 *
 * 対象（銀行振込で実際に支払った Premium 年払いだけ・PayPal 年額 / Stripe / 支払い方法不明は送らない）/
 * 期限境界（月払いと同じ 1〜7 日前・失効後は送らない）/ 有効期限・プランが不明なら送らない /
 * 更新・申込済み・プラン変更後の停止 / 二重送信防止・冪等性 / 本文の価格・手順が /pricing/ と一致 /
 * 月払い・Light と名前空間・env・cron が分かれ、月払いの挙動が変わっていないこと を固定する。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isPaidPremiumAnnualBankTransfer, stageFor, evaluateCandidate, stillSendable, deliveryKeyFor, claimKeyFor, SKIP, STAGE,
  PREMIUM_ANNUAL_RENEWAL_CAMPAIGN_TYPE, PREMIUM_ANNUAL_YEN,
} from './premiumAnnualRenewalPolicy.js';
import { renderPremiumAnnualRenewalEmail, PREMIUM_ANNUAL_RENEWAL_CTA_URL } from './premiumAnnualRenewalEmail.js';
import { runPremiumAnnualRenewal, resolveMode, MODE } from './premiumAnnualRenewalRunner.js';
import {
  deliveryKeyFor as monthlyKeyFor, claimKeyFor as monthlyClaimFor, PREMIUM_RENEWAL_CAMPAIGN_TYPE,
  isPaidPremiumMonthly, PRE_WINDOW,
} from '../premiumRenewal/premiumRenewalPolicy.js';
import { resolveMode as resolveMonthlyMode } from '../premiumRenewal/premiumRenewalRunner.js';
import { LIGHT_RENEWAL_CAMPAIGN_TYPE } from '../lightRenewal/lightRenewalPolicy.js';
import { decideBankProductAvailability } from '../../payments/discontinuedBankProducts.js';
import { clearProviderSuppressionCache } from '../providerSuppression.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const NOW = Date.parse('2026-10-01T03:00:00Z'); // JST 2026-10-01 12:00
const PAID = (over = {}) => ({
  Email: 'y-a@example.com', '氏名': 'テスト', 'プラン': 'Premium', PlanType: 'Annual', PaymentMethod: 'Bank Transfer',
  PaidAt: '2025-10-05T01:00:00.000Z', Status: 'active', '有効期限': '2026-10-05', PaymentConfirmed: true, ...over,
});

test('対象: 銀行振込で実際に支払った Premium 年払いだけ（PayPal 年額・Stripe・支払い方法不明・月払い・買い切り・Light は対象外）', () => {
  assert.equal(isPaidPremiumAnnualBankTransfer(PAID()).ok, true);
  assert.equal(isPaidPremiumAnnualBankTransfer(PAID({ PaymentMethod: ' bank transfer ' })).ok, true);
  assert.equal(isPaidPremiumAnnualBankTransfer(PAID({ PaymentMethod: 'PayPal' })).reason, SKIP.AUTO_RENEW);
  assert.equal(isPaidPremiumAnnualBankTransfer(PAID({ PaymentMethod: 'Stripe' })).reason, SKIP.AUTO_RENEW);
  assert.equal(isPaidPremiumAnnualBankTransfer(PAID({ PaymentMethod: '' })).reason, SKIP.PAYMENT_METHOD_UNKNOWN);
  assert.equal(isPaidPremiumAnnualBankTransfer(PAID({ PaymentMethod: undefined })).reason, SKIP.PAYMENT_METHOD_UNKNOWN);
  assert.equal(isPaidPremiumAnnualBankTransfer(PAID({ PaymentMethod: 'Paddle' })).reason, SKIP.PAYMENT_METHOD_UNKNOWN);
  assert.equal(isPaidPremiumAnnualBankTransfer(PAID({ PaidAt: '' })).reason, SKIP.NOT_PAID);
  assert.equal(isPaidPremiumAnnualBankTransfer(PAID({ PlanType: 'Monthly' })).reason, SKIP.NOT_ANNUAL);
  assert.equal(isPaidPremiumAnnualBankTransfer(PAID({ PlanType: 'Lifetime' })).reason, SKIP.NOT_ANNUAL);
  assert.equal(isPaidPremiumAnnualBankTransfer(PAID({ PlanType: '' })).reason, SKIP.NOT_ANNUAL);
  assert.equal(isPaidPremiumAnnualBankTransfer(PAID({ 'プラン': 'Light' })).reason, SKIP.NOT_PREMIUM);
  assert.equal(isPaidPremiumAnnualBankTransfer(PAID({ 'プラン': '' })).reason, SKIP.NOT_PREMIUM);
  assert.equal(isPaidPremiumAnnualBankTransfer(PAID({ 'プラン': 'Premium Sanrenpuku' })).reason, SKIP.NOT_PREMIUM);
});

test('対象外: test・pending・停止・強制ログアウト・退会申請・配信停止・メール不正', () => {
  for (const [over, reason] of [
    [{ Status: 'test' }, SKIP.EXCLUDED_STATUS], [{ Status: 'pending' }, SKIP.EXCLUDED_STATUS],
    [{ Status: 'suspended' }, SKIP.EXCLUDED_STATUS], [{ ForceLogout: true }, SKIP.FORCE_LOGOUT],
    [{ WithdrawalRequested: true }, SKIP.WITHDRAWAL], [{ UnsubscribedAnalyticsKeiba: true }, SKIP.UNSUBSCRIBED],
    [{ Email: 'x' }, SKIP.INVALID_EMAIL], [{ Email: '' }, SKIP.INVALID_EMAIL],
  ]) assert.equal(isPaidPremiumAnnualBankTransfer(PAID(over)).reason, reason, JSON.stringify(over));
});

test('更新の振込報告が済んで入金確認待ちなら送らない（別商品の申込・承認済みの痕跡では止めない）', () => {
  assert.equal(isPaidPremiumAnnualBankTransfer(PAID({ RequestedPlan: 'Premium', RequestedPlanType: 'Annual', PaymentConfirmed: false })).reason, SKIP.RENEWAL_APPLIED);
  assert.equal(isPaidPremiumAnnualBankTransfer(PAID({ RequestedPlan: 'Premium', RequestedPlanType: 'Lifetime', PaymentConfirmed: false })).reason, SKIP.RENEWAL_APPLIED);
  assert.equal(isPaidPremiumAnnualBankTransfer(PAID({ RequestedPlan: 'Premium Sanrenpuku', RequestedPlanType: '', PaymentConfirmed: false })).ok, true);
  assert.equal(isPaidPremiumAnnualBankTransfer(PAID({ RequestedPlan: '', RequestedPlanType: '', PaymentConfirmed: true })).ok, true);
});

test('時期: 月払いと同じ期限の 1〜7 日前だけ（当日・8 日前・失効後は送らない）', () => {
  assert.deepEqual(PRE_WINDOW, { min: 1, max: 7 }, '月払いと同じ窓');
  const t = '2026-10-01';
  assert.equal(stageFor('2026-10-02', t), STAGE.PRE);
  assert.equal(stageFor('2026-10-08', t), STAGE.PRE);
  assert.equal(stageFor('2026-10-09', t), null);
  assert.equal(stageFor('2026-10-01', t), null);
  assert.equal(stageFor('2026-09-28', t), null, '失効後（月払いなら POST）は送らない');
  assert.equal(stageFor('2026-09-01', t), null);
});

test('有効期限が無い・読めないなら送らない（fail closed）', () => {
  assert.equal(evaluateCandidate(PAID({ '有効期限': '' }), NOW).reason, SKIP.NO_EXPIRY);
  assert.equal(evaluateCandidate(PAID({ '有効期限': '不明' }), NOW).reason, SKIP.NO_EXPIRY);
  assert.equal(evaluateCandidate(PAID({ '有効期限': undefined }), NOW).reason, SKIP.NO_EXPIRY);
  assert.equal(evaluateCandidate(PAID(), NOW).eligible, true);
  assert.equal(evaluateCandidate(PAID({ '有効期限': '2027-10-05' }), NOW).reason, SKIP.OUT_OF_WINDOW);
});

test('送信直前: 更新（期限が延びた）・申込済み・PayPal 年額へ変更・プラン変更の後は送らない', () => {
  const planned = { cycle: '2026-10-05', stage: STAGE.PRE };
  assert.equal(stillSendable(planned, PAID(), NOW).ok, true);
  assert.equal(stillSendable(planned, PAID({ '有効期限': '2027-10-03' }), NOW).reason, 'cycle_changed');
  assert.equal(stillSendable(planned, PAID({ RequestedPlan: 'Premium', RequestedPlanType: 'Annual', PaymentConfirmed: false }), NOW).reason, SKIP.RENEWAL_APPLIED);
  assert.equal(stillSendable(planned, PAID({ PaymentMethod: 'PayPal' }), NOW).reason, SKIP.AUTO_RENEW);
  assert.equal(stillSendable(planned, PAID({ PlanType: 'Lifetime' }), NOW).reason, SKIP.NOT_ANNUAL);
  assert.equal(stillSendable(planned, null, NOW).reason, 'record_missing');
});

test('月払い・Light と名前空間が分かれている（同じ会員・周期でも別の鍵・別の予約キー・別の CampaignType）', () => {
  const a = { recordId: 'recAAAAAAAAAAAAAA', cycle: '2026-10-05', stage: 'pre' };
  assert.notEqual(deliveryKeyFor(a), monthlyKeyFor(a));
  assert.notEqual(claimKeyFor('k'), monthlyClaimFor('k'));
  assert.equal(PREMIUM_ANNUAL_RENEWAL_CAMPAIGN_TYPE, 'premium-annual-renewal:v1');
  assert.notEqual(PREMIUM_ANNUAL_RENEWAL_CAMPAIGN_TYPE, PREMIUM_RENEWAL_CAMPAIGN_TYPE);
  assert.notEqual(PREMIUM_ANNUAL_RENEWAL_CAMPAIGN_TYPE, LIGHT_RENEWAL_CAMPAIGN_TYPE);
  assert.equal(deliveryKeyFor(a), deliveryKeyFor({ ...a }), '同じ会員・周期・段は同じ鍵（冪等）');
  assert.notEqual(deliveryKeyFor(a), deliveryKeyFor({ ...a, cycle: '2027-10-05' }), '次の周期は別の 1 通');
});

test('月払いの挙動は変えない: 年払いは月払いの対象外のまま・月払いの env で年払いは動かない', () => {
  assert.equal(isPaidPremiumMonthly(PAID()).reason, 'not_monthly');
  assert.equal(isPaidPremiumMonthly(PAID({ PlanType: 'Monthly' })).ok, true);
  assert.equal(resolveMode({ PREMIUM_RENEWAL_REMINDER_MODE: 'live' }), MODE.OFF, '月払いの env で年払いが送られてしまう');
  assert.equal(resolveMonthlyMode({ PREMIUM_ANNUAL_RENEWAL_REMINDER_MODE: 'live' }), MODE.OFF, '年払いの env で月払いが送られてしまう');
  assert.equal(resolveMode({ PREMIUM_ANNUAL_RENEWAL_REMINDER_MODE: 'live' }), MODE.LIVE);
  assert.equal(resolveMode({ PREMIUM_ANNUAL_RENEWAL_REMINDER_MODE: 'dry-run' }), MODE.DRY_RUN);
  assert.equal(resolveMode({ PREMIUM_ANNUAL_RENEWAL_REMINDER_MODE: 'yes' }), MODE.OFF);
  assert.equal(resolveMode({}), MODE.OFF);
});

test('本文: 価格・手順は /pricing/ の Premium 年払い（銀行振込）と同じ・割引や特典・月額・カードを書かない', () => {
  const pricing = readFileSync(`${ROOT}src/pages/pricing.astro`, 'utf8');
  assert.equal(PREMIUM_ANNUAL_YEN, 49800);
  assert.ok(pricing.includes(`openBankModal('Premium Annual', ${PREMIUM_ANNUAL_YEN}, 'annual')`), '/pricing/ の年払い（銀行振込）と金額がずれている');
  assert.match(pricing, /銀行振込の年払いは、有効期限が近づきましたらメールでお知らせいたします。継続をご希望の場合は、再度お振込みいただくことで延長できます。/);
  assert.match(pricing, /①お振込み → ②振込完了後、報告フォームをご送信 → ③入金確認後、ご利用開始です。/);
  assert.equal(decideBankProductAvailability({ planName: 'Premium', planType: 'annual', fields: null }).ok, true, '年払いの銀行振込が受付終了なら本文が嘘になる');
  const m = renderPremiumAnnualRenewalEmail({ stage: STAGE.PRE, cycle: '2026-10-05', name: '山田' });
  const all = `${m.subject}\n${m.text}\n${m.html}`;
  assert.match(m.subject, /年払い.*10月5日まで/);
  assert.match(m.text, /2026年10月5日/);
  assert.match(m.text, /¥49,800／年・中央＋南関/);
  assert.match(m.text, /「銀行振込で申し込む」から、再度お振込みいただくことで延長できます/);
  assert.match(m.text, /①お振込み → ②振込完了後、報告フォームをご送信 → ③入金確認後、ご利用開始です。/);
  assert.equal(/44,820|4,980|2,980|78,000|18,000|割引|特典|OFF|月額|自動更新|PayPal|Stripe|クレジット|Light/.test(all), false, '書いていない価格・特典・別の経路を書いている');
  assert.ok(m.html.includes(PREMIUM_ANNUAL_RENEWAL_CTA_URL) && m.text.includes(PREMIUM_ANNUAL_RENEWAL_CTA_URL));
  assert.equal(PREMIUM_ANNUAL_RENEWAL_CTA_URL, 'https://analytics.keiba.link/login/?next=/pricing/');
  assert.match(m.html, /\{\{unsubscribeUrl\}\}/);
  assert.throws(() => renderPremiumAnnualRenewalEmail({ stage: STAGE.POST, cycle: '2026-10-05' }), /unknown_stage/, '期限前以外の本文は無い');
});

// ── 実行（偽の fetch / Redis・ネットワークに出ない）────────
const RECS = {
  recAAAAAAAAAAAAAA: PAID({ Email: 'a@example.com', '有効期限': '2026-10-05' }),                          // 年払い・期限 4 日前 → 送る
  recBBBBBBBBBBBBBB: PAID({ Email: 'b@example.com', '有効期限': '2026-10-08' }),                          // 年払い・期限 7 日前 → 送る
  recCCCCCCCCCCCCCC: PAID({ Email: 'c@example.com', '有効期限': '2026-10-03', PaymentMethod: 'PayPal' }), // PayPal 年額（自動更新）
  recDDDDDDDDDDDDDD: PAID({ Email: 'd@example.com', '有効期限': '2026-10-03', PaymentMethod: '' }),       // 支払い方法不明
  recEEEEEEEEEEEEEE: PAID({ Email: 'e@example.com', '有効期限': '' }),                                    // 有効期限なし
  recFFFFFFFFFFFFFF: PAID({ Email: 'f@example.com', '有効期限': '2026-09-28' }),                          // 失効後
  recGGGGGGGGGGGGGG: PAID({ Email: 'g@example.com', '有効期限': '2026-10-03', PlanType: 'Monthly' }),     // 月払い（別の cron）
};

function harness({ suppressed = [], blacklist = [], sendOk = true, redisThrows = false, fresh = {}, deliveries = [] } = {}) {
  const redis = new Map();
  const calls = { sent: [], upserts: [], patches: [], redis: [], formulas: [] };
  const redisCmd = async (args) => {
    calls.redis.push(args[0]);
    if (redisThrows) throw new Error('down');
    const [op, key, val, nx] = args;
    if (op === 'SET') { if (nx === 'NX' && redis.has(key)) return null; redis.set(key, val); return 'OK'; }
    if (op === 'DEL') { redis.delete(key); return 1; }
    return null;
  };
  const json = (b, s = 200, headers = {}) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json', ...headers } });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const m = (init.method || 'GET').toUpperCase();
    if (u.includes('api.sendgrid.com/v3/suppression')) return json(suppressed === null ? {} : suppressed.map((email) => ({ email })), suppressed === null ? 500 : 200);
    if (u.includes('api.sendgrid.com/v3/mail/send')) {
      calls.sent.push(JSON.parse(init.body));
      return sendOk ? new Response('', { status: 202, headers: { 'x-message-id': 'msg1' } }) : new Response('err', { status: 500 });
    }
    if (u.includes('/Customers/rec')) {
      const id = u.split('/').pop();
      return RECS[id] ? json({ id, fields: { ...RECS[id], ...(fresh[id] || {}) } }) : new Response('{}', { status: 404 });
    }
    if (u.includes('/Customers')) {
      calls.formulas.push(new URL(u).searchParams.get('filterByFormula'));
      return json({ records: Object.entries(RECS).map(([id, fields]) => ({ id, fields })) });
    }
    if (u.includes('/EmailBlacklist')) return json({ records: blacklist.map((e) => ({ id: 'recBL', fields: { Email: e, Status: 'HARD_BOUNCE' } })) });
    if (u.includes('/CampaignDeliveries') && m === 'GET') return json({ records: deliveries });
    if (u.includes('/CampaignDeliveries') && m === 'PATCH' && JSON.parse(init.body).performUpsert) {
      calls.upserts.push(JSON.parse(init.body).records[0].fields);
      return json({ records: [{ id: `recDEL${String(calls.upserts.length).padStart(11, '0')}` }] });
    }
    if (u.includes('/CampaignDeliveries/rec') && m === 'PATCH') { calls.patches.push(JSON.parse(init.body).fields); return json({}); }
    throw new Error(`unexpected ${m} ${u}`);
  };
  const env = { AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'appX', SENDGRID_API_KEY: 'sg' };
  return { redis, calls, redisCmd, fetchImpl, env };
}
const run = (h, mode = MODE.LIVE) => runPremiumAnnualRenewal({ mode, env: h.env, nowMs: NOW, fetchImpl: h.fetchImpl, redisCmd: h.redisCmd });

beforeEach(() => clearProviderSuppressionCache());

test('off: 何も読まない・送らない', async () => {
  const h = harness();
  const r = await run(h, MODE.OFF);
  assert.equal(h.calls.sent.length + h.calls.upserts.length + h.calls.redis.length + h.calls.formulas.length, 0);
  assert.equal(r.sent, 0);
});

test('dry-run: 件数だけ（送信・書き込み・予約 0・アドレスを返さない）・不明は理由別に数える', async () => {
  const h = harness();
  const r = await run(h, MODE.DRY_RUN);
  assert.deepEqual(r.planned, { pre: 2, post: 0 });
  assert.equal(r.excludedByReason[SKIP.AUTO_RENEW], 1);
  assert.equal(r.excludedByReason[SKIP.PAYMENT_METHOD_UNKNOWN], 1);
  assert.equal(r.excludedByReason[SKIP.NO_EXPIRY], 1);
  assert.equal(r.excludedByReason[SKIP.OUT_OF_WINDOW], 1);
  assert.equal(r.excludedByReason[SKIP.NOT_ANNUAL], 1);
  assert.equal(h.calls.sent.length + h.calls.upserts.length + h.calls.redis.length, 0);
  assert.equal(JSON.stringify(r).includes('@'), false);
  assert.match(h.calls.formulas[0], /LOWER\(\{PlanType\}\)='annual'/);
  assert.match(h.calls.formulas[0], /premium/);
});

test('live: 対象の 2 名へ 1 通ずつ、年払いの CampaignType・配信停止ヘッダを付ける（PayPal・不明・期限なし・失効後・月払いへは送らない）', async () => {
  const h = harness();
  const r = await run(h);
  assert.equal(r.sent, 2);
  assert.deepEqual(h.calls.sent.map((s) => s.personalizations[0].to[0].email).sort(), ['a@example.com', 'b@example.com']);
  assert.ok(h.calls.upserts.every((u) => u.CampaignType === PREMIUM_ANNUAL_RENEWAL_CAMPAIGN_TYPE && u.EmailType === 'campaign' && u.StepNumber === 1));
  assert.ok(h.calls.upserts.every((u) => /^par-\d{4}-\d{2}-\d{2}-pre$/.test(u.ScheduledEmailJobId)));
  assert.ok(h.calls.sent.every((s) => s.headers['List-Unsubscribe'] && /年払い/.test(s.subject)));
  assert.ok(h.calls.sent.every((s) => JSON.stringify(s.custom_args).includes('premium-annual-renewal')));
});

test('二重送信しない: 同じ日の再実行は予約済み・配信行が sent なら止める・翌日も同じ周期には送らない', async () => {
  const h = harness();
  await run(h);
  const r2 = await run(h);
  assert.equal(r2.sent, 0);
  assert.equal(r2.skippedByReason.already_claimed, 2);
  const r3 = await runPremiumAnnualRenewal({ mode: MODE.LIVE, env: h.env, nowMs: NOW + 86400000, fetchImpl: h.fetchImpl, redisCmd: h.redisCmd });
  assert.equal(r3.sent, 0, '翌日（まだ窓の中）でも同じ周期は 1 通だけ');
  assert.equal(h.calls.sent.length, 2);
  const key = deliveryKeyFor({ recordId: 'recAAAAAAAAAAAAAA', cycle: '2026-10-05', stage: 'pre' });
  const h2 = harness({ deliveries: [{ id: 'recDEL1', fields: { EmailType: 'campaign', RecipientEmail: 'a@example.com', DeliveryKey: key, Status: 'sent', SentAt: '2026-09-28T01:00:00Z', CampaignType: PREMIUM_ANNUAL_RENEWAL_CAMPAIGN_TYPE } }] });
  const r4 = await run(h2);
  assert.equal(r4.skippedByReason.already_sent, 1, 'Redis が空でも配信行が sent なら送らない');
});

test('送信直前に更新・申込済み・PayPal 年額への切替を検知したら送らない', async () => {
  const h = harness({ fresh: {
    recAAAAAAAAAAAAAA: { '有効期限': '2027-10-01' },
    recBBBBBBBBBBBBBB: { RequestedPlan: 'Premium', RequestedPlanType: 'Annual', PaymentConfirmed: false },
  } });
  const r = await run(h);
  assert.equal(r.sent, 0);
  assert.equal(r.skippedByReason.cycle_changed, 1);
  assert.equal(r.skippedByReason[SKIP.RENEWAL_APPLIED], 1);
  const h2 = harness({ fresh: { recAAAAAAAAAAAAAA: { PaymentMethod: 'PayPal' }, recBBBBBBBBBBBBBB: { '有効期限': '' } } });
  const r2 = await run(h2);
  assert.equal(r2.sent, 0);
  assert.equal(r2.skippedByReason[SKIP.AUTO_RENEW], 1);
  assert.equal(r2.skippedByReason.cycle_changed, 1, '有効期限が読めなくなったら送らない');
});

test('配信停止・バウンス・provider suppression へは送らない／確認できなければ 1 通も送らない', async () => {
  const h = harness({ suppressed: ['a@example.com'], blacklist: ['b@example.com'] });
  const r = await run(h);
  assert.equal(r.sent, 0);
  assert.equal(r.skippedByReason.provider_suppressed, 1);
  assert.equal(r.skippedByReason.blacklist, 1);
  clearProviderSuppressionCache();
  const h2 = harness({ suppressed: null });
  await assert.rejects(() => run(h2), (e) => e.code === 'provider_suppression_unavailable');
  assert.equal(h2.calls.sent.length, 0);
});

test('Redis 障害なら送らない・送信失敗は配信行 failed で予約を外す（翌日再試行）', async () => {
  const h = harness({ redisThrows: true });
  await assert.rejects(() => run(h), (e) => e.code === 'redis_claim_unknown');
  assert.equal(h.calls.sent.length, 0);
  const h2 = harness({ sendOk: false });
  const r = await run(h2);
  assert.equal(r.failed, 2);
  assert.equal(h2.redis.size, 0);
  assert.ok(h2.calls.patches.every((p) => p.Status === 'failed'));
});

test('cron: 専用の env・時刻（Light 10:00・月払い 10:05 とずらす）・月額の経路ゲートや既存の自動化のゲートに依存しない', () => {
  const cron = readFileSync(`${ROOT}netlify/functions/cron-premium-annual-renewal-reminder.js`, 'utf8');
  const code = cron.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.match(code, /schedule: '10 1 \* \* \*'/);
  assert.match(code, /runPremiumAnnualRenewal/);
  assert.match(code, /const mode = resolveMode\(process\.env\);/);
  assert.equal(/PREMIUM_RENEWAL_REMINDER_MODE|LIGHT_RENEWAL_REMINDER_MODE|NEWSLETTER_AUTOMATION_ENABLED|MARKETING_CAMPAIGN_DISPATCH_ENABLED|resolveMonthlySalesChannel|gateModeOnStripeSales/.test(code), false);
  const monthly = readFileSync(`${ROOT}netlify/functions/cron-premium-renewal-reminder.js`, 'utf8');
  assert.match(monthly, /schedule: '5 1 \* \* \*'/);
  assert.match(monthly, /runPremiumRenewal\(/);
});
