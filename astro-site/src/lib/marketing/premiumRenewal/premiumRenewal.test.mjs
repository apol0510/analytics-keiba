/**
 * premiumRenewal.test.mjs — Premium 月払い 期限前・失効後リマインド（MK 決定 2026-09-29 / ①）の重要仕様
 *
 * 対象（実際に支払った Premium 月払いだけ）/ 期限境界 / 更新・再開・年払い等への切替後の停止 /
 * 配信停止・バウンス・suppression / 二重送信防止・冪等性 / 本文の価格が /pricing/ と一致 /
 * 更新率・復帰率の集計 / Light と名前空間・env・cron が分かれていること を固定する。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isPaidPremiumMonthly, stageFor, stillSendable, deliveryKeyFor, claimKeyFor, SKIP, STAGE,
  PREMIUM_RENEWAL_CAMPAIGN_TYPE, PREMIUM_MONTHLY_YEN,
} from './premiumRenewalPolicy.js';
import { renderPremiumRenewalEmail, PREMIUM_RENEWAL_CTA_URL } from './premiumRenewalEmail.js';
import { runPremiumRenewal, resolveMode, MODE } from './premiumRenewalRunner.js';
import { summarizePremiumRenewalOutcomes } from './premiumRenewalReport.js';
import { deliveryKeyFor as lightKeyFor, claimKeyFor as lightClaimFor, LIGHT_RENEWAL_CAMPAIGN_TYPE } from '../lightRenewal/lightRenewalPolicy.js';
import { clearProviderSuppressionCache } from '../providerSuppression.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const NOW = Date.parse('2026-10-01T03:00:00Z'); // JST 2026-10-01 12:00
const PAID = (over = {}) => ({
  Email: 'p-a@example.com', '氏名': 'テスト', 'プラン': 'Premium', PlanType: 'Monthly',
  PaidAt: '2026-09-05T01:00:00.000Z', Status: 'active', '有効期限': '2026-10-05', ...over,
});

test('対象: 実際に支払った Premium 月払いだけ（無料付与・年払い・買い切り・Light・三連複プランは対象外）', () => {
  assert.equal(isPaidPremiumMonthly(PAID()).ok, true);
  assert.equal(isPaidPremiumMonthly(PAID({ PaidAt: '' })).reason, SKIP.NOT_PAID);
  assert.equal(isPaidPremiumMonthly(PAID({ PlanType: 'Annual' })).reason, SKIP.NOT_MONTHLY);
  assert.equal(isPaidPremiumMonthly(PAID({ PlanType: 'Lifetime' })).reason, SKIP.NOT_MONTHLY);
  assert.equal(isPaidPremiumMonthly(PAID({ 'プラン': 'Light' })).reason, SKIP.NOT_PREMIUM);
  assert.equal(isPaidPremiumMonthly(PAID({ 'プラン': 'Premium Sanrenpuku' })).reason, SKIP.NOT_PREMIUM);
});

test('対象外: test・pending・停止・強制ログアウト・退会申請・配信停止・メール不正', () => {
  for (const [over, reason] of [
    [{ Status: 'test' }, SKIP.EXCLUDED_STATUS], [{ Status: 'pending' }, SKIP.EXCLUDED_STATUS],
    [{ Status: 'suspended' }, SKIP.EXCLUDED_STATUS], [{ ForceLogout: true }, SKIP.FORCE_LOGOUT],
    [{ WithdrawalRequested: true }, SKIP.WITHDRAWAL], [{ UnsubscribedAnalyticsKeiba: true }, SKIP.UNSUBSCRIBED],
    [{ Email: 'x' }, SKIP.INVALID_EMAIL],
  ]) assert.equal(isPaidPremiumMonthly(PAID(over)).reason, reason, JSON.stringify(over));
});

test('時期: PRE は期限の 1〜7 日前・POST は失効後 3〜30 日（当日・8 日前・2 日後・31 日後は送らない）', () => {
  const t = '2026-10-01';
  assert.equal(stageFor('2026-10-02', t), STAGE.PRE);
  assert.equal(stageFor('2026-10-08', t), STAGE.PRE);
  assert.equal(stageFor('2026-10-09', t), null);
  assert.equal(stageFor('2026-10-01', t), null);
  assert.equal(stageFor('2026-09-29', t), null);
  assert.equal(stageFor('2026-09-28', t), STAGE.POST);
  assert.equal(stageFor('2026-09-01', t), STAGE.POST);
  assert.equal(stageFor('2026-08-31', t), null);
});

test('送信直前: 更新・再開（期限が延びた）・年払い等への切替・プラン変更の後は送らない', () => {
  const planned = { cycle: '2026-10-05', stage: STAGE.PRE };
  assert.equal(stillSendable(planned, PAID(), NOW).ok, true);
  assert.equal(stillSendable(planned, PAID({ '有効期限': '2026-11-04' }), NOW).reason, 'cycle_changed');
  assert.equal(stillSendable(planned, PAID({ PlanType: 'Annual', '有効期限': '2027-10-05' }), NOW).reason, SKIP.NOT_MONTHLY);
  assert.equal(stillSendable(planned, PAID({ 'プラン': 'Light' }), NOW).reason, SKIP.NOT_PREMIUM);
  assert.equal(stillSendable(planned, null, NOW).reason, 'record_missing');
});

test('Light と名前空間が分かれている（同じ会員・周期でも別の鍵・別の予約キー・別の CampaignType）', () => {
  const a = { recordId: 'recAAAAAAAAAAAAAA', cycle: '2026-10-05', stage: 'pre' };
  assert.notEqual(deliveryKeyFor(a), lightKeyFor(a));
  assert.notEqual(claimKeyFor('k'), lightClaimFor('k'));
  assert.notEqual(PREMIUM_RENEWAL_CAMPAIGN_TYPE, LIGHT_RENEWAL_CAMPAIGN_TYPE);
  assert.equal(PREMIUM_RENEWAL_CAMPAIGN_TYPE, 'premium-renewal:v1');
});

test('本文: 価格は /pricing/ の Premium 月額（Stripe）と同じ・割引や特典を書かない・ログイン経由の /pricing/', async () => {
  const pricing = readFileSync(`${ROOT}src/pages/pricing.astro`, 'utf8');
  const { planById } = await import('../../billing/stripePlans.js');
  assert.equal(planById('premium').amountYen, PREMIUM_MONTHLY_YEN, 'Stripe の Premium 月額と本文の金額がずれている');
  assert.match(pricing, /data-checkout="premium"/, '/pricing/ に Premium 月額（Stripe）の申込ボタンが無い');
  assert.equal(/openBankModal\('Premium Monthly'/.test(pricing), false, '販売終了した銀行振込の月払いが /pricing/ に残っている');
  for (const stage of [STAGE.PRE, STAGE.POST]) {
    const m = renderPremiumRenewalEmail({ stage, cycle: '2026-10-05', name: '山田' });
    assert.match(m.text, /¥4,980／月・中央＋南関・クレジットカードで毎月自動更新/);
    assert.match(m.text, /中央版・南関版（各 ¥2,980／月）/);
    assert.equal(/Light/.test(m.text), false, 'Premium 会員向けに Light を案内している');
    assert.equal(/18,000|銀行振込で/.test(m.text), false, '販売終了した月払いの案内が残っている');
    assert.ok(m.html.includes(PREMIUM_RENEWAL_CTA_URL) && m.text.includes(PREMIUM_RENEWAL_CTA_URL));
    assert.equal(/44,820|49,800|割引|特典|OFF/.test(m.text + m.subject), false, '書いていない価格・特典を書いている');
    assert.match(m.html, /\{\{unsubscribeUrl\}\}/);
  }
  assert.match(renderPremiumRenewalEmail({ stage: STAGE.PRE, cycle: '2026-10-05' }).subject, /10月5日まで/);
  assert.match(renderPremiumRenewalEmail({ stage: STAGE.POST, cycle: '2026-09-25' }).subject, /終了/);
});

// ── 実行（偽の fetch / Redis・ネットワークに出ない）────────
const RECS = {
  recAAAAAAAAAAAAAA: PAID({ Email: 'a@example.com', '有効期限': '2026-10-05' }), // PRE
  recBBBBBBBBBBBBBB: PAID({ Email: 'b@example.com', '有効期限': '2026-09-25' }), // POST
  recCCCCCCCCCCCCCC: PAID({ Email: 'c@example.com', '有効期限': '2026-10-03', PaidAt: '' }), // 無料付与のみ
  recDDDDDDDDDDDDDD: PAID({ Email: 'd@example.com', '有効期限': '2026-10-03', PlanType: 'Annual' }), // 年払い
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
const run = (h, mode = MODE.LIVE) => runPremiumRenewal({ mode, env: h.env, nowMs: NOW, fetchImpl: h.fetchImpl, redisCmd: h.redisCmd });

beforeEach(() => clearProviderSuppressionCache());

test('モード: 専用の env（PREMIUM_RENEWAL_REMINDER_MODE）だけを見る・既定は off', async () => {
  assert.equal(resolveMode({}), MODE.OFF);
  assert.equal(resolveMode({ LIGHT_RENEWAL_REMINDER_MODE: 'live' }), MODE.OFF, 'Light の env で動いてしまう');
  assert.equal(resolveMode({ PREMIUM_RENEWAL_REMINDER_MODE: 'live' }), MODE.LIVE);
  const h = harness();
  const r = await run(h, MODE.OFF);
  assert.equal(h.calls.sent.length + h.calls.upserts.length + h.calls.redis.length, 0);
  assert.equal(r.sent, 0);
});

test('dry-run: 件数だけ（送信・書き込み・予約 0・アドレスを返さない）', async () => {
  const h = harness();
  const r = await run(h, MODE.DRY_RUN);
  assert.deepEqual(r.planned, { pre: 1, post: 1 });
  assert.equal(r.excludedByReason[SKIP.NOT_PAID], 1);
  assert.equal(r.excludedByReason[SKIP.NOT_MONTHLY], 1);
  assert.equal(h.calls.sent.length + h.calls.upserts.length + h.calls.redis.length, 0);
  assert.equal(JSON.stringify(r).includes('@'), false);
  assert.match(h.calls.formulas[0], /premium/);
});

test('live: PRE と POST を 1 通ずつ送り、Premium の CampaignType・配信停止ヘッダを付ける', async () => {
  const h = harness();
  const r = await run(h);
  assert.equal(r.sent, 2);
  assert.ok(h.calls.upserts.every((u) => u.CampaignType === PREMIUM_RENEWAL_CAMPAIGN_TYPE && u.EmailType === 'campaign'));
  assert.ok(h.calls.upserts.every((u) => /^pr-/.test(u.ScheduledEmailJobId)));
  assert.ok(h.calls.sent.every((s) => s.headers['List-Unsubscribe'] && /Premium/.test(s.subject)));
  assert.ok(h.calls.sent.every((s) => s.custom_args.campaign_id === 'premium-renewal' || JSON.stringify(s.custom_args).includes('premium-renewal')));
});

test('二重送信しない: 同じ日の再実行は予約済み・配信行が sent なら止める', async () => {
  const h = harness();
  await run(h);
  const r2 = await run(h);
  assert.equal(r2.sent, 0);
  assert.equal(r2.skippedByReason.already_claimed, 2);
  assert.equal(h.calls.sent.length, 2);
  const key = deliveryKeyFor({ recordId: 'recAAAAAAAAAAAAAA', cycle: '2026-10-05', stage: 'pre' });
  const h2 = harness({ deliveries: [{ id: 'recDEL1', fields: { EmailType: 'campaign', RecipientEmail: 'a@example.com', DeliveryKey: key, Status: 'sent', SentAt: '2026-09-30T01:00:00Z', CampaignType: PREMIUM_RENEWAL_CAMPAIGN_TYPE } }] });
  const r3 = await run(h2);
  assert.equal(r3.skippedByReason.already_sent, 1);
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

test('送信直前に更新・年払いへの切替を検知したら送らない', async () => {
  const h = harness({ fresh: { recAAAAAAAAAAAAAA: { '有効期限': '2026-11-04' }, recBBBBBBBBBBBBBB: { PlanType: 'Annual', '有効期限': '2027-09-25' } } });
  const r = await run(h);
  assert.equal(r.sent, 0);
  assert.equal(r.skippedByReason.cycle_changed, 1);
  assert.equal(r.skippedByReason[SKIP.NOT_MONTHLY], 1);
});

test('Redis 障害なら送らない・送信失敗は配信行 failed で予約を外す（冪等）', async () => {
  const h = harness({ redisThrows: true });
  await assert.rejects(() => run(h), (e) => e.code === 'redis_claim_unknown');
  assert.equal(h.calls.sent.length, 0);
  const h2 = harness({ sendOk: false });
  const r = await run(h2);
  assert.equal(r.failed, 2);
  assert.equal(h2.redis.size, 0);
});

// ── 集計（更新率・復帰率）──────────────────────────────────
test('集計: 期限内更新・失効後の復帰・失効・結論前を分け、年払い等への切替も内訳に出す', () => {
  const sent = (rid, cycle, stage = 'pre') => ({ fields: { CampaignType: PREMIUM_RENEWAL_CAMPAIGN_TYPE, Status: 'sent', CustomerRecordId: rid, SentAt: '2026-09-01T01:00:00Z', Metadata: JSON.stringify({ cycle, stage }) } });
  const deliveries = [
    sent('recR', '2026-09-10'), sent('recR', '2026-09-10', 'post'),   // 1 周期として数える
    sent('recT', '2026-09-10', 'post'),
    sent('recS', '2026-09-10'),
    sent('recL', '2026-08-20', 'post'),
    sent('recO', '2026-09-25'),
    { fields: { CampaignType: LIGHT_RENEWAL_CAMPAIGN_TYPE, Status: 'sent', CustomerRecordId: 'recX', Metadata: JSON.stringify({ cycle: '2026-09-10' }) } },
  ];
  const customersById = new Map([
    ['recR', { 'プラン': 'Premium', PlanType: 'Monthly', '有効期限': '2026-10-10', PaidAt: '2026-09-09T02:00:00Z' }], // 期限内に更新
    ['recT', { 'プラン': 'Premium', PlanType: 'Monthly', '有効期限': '2026-10-20', PaidAt: '2026-09-20T02:00:00Z' }], // 失効後に復帰
    ['recS', { 'プラン': 'Premium', PlanType: 'Annual', '有効期限': '2027-09-08', PaidAt: '2026-09-08T02:00:00Z' }], // 年払いへ切替
    ['recL', { 'プラン': 'Premium', PlanType: 'Monthly', '有効期限': '2026-08-20' }],                                  // 失効
    ['recO', { 'プラン': 'Premium', PlanType: 'Monthly', '有効期限': '2026-09-25' }],                                  // 結論前
  ]);
  const s = summarizePremiumRenewalOutcomes({ deliveries, customersById, nowMs: NOW });
  assert.equal(s.cycles, 5);
  assert.equal(s.renewed, 2);
  assert.equal(s.returned, 1);
  assert.equal(s.switchedPlanType, 1);
  assert.equal(s.lapsed, 1);
  assert.equal(s.open, 1);
  assert.equal(s.decided, 4);
  assert.equal(s.renewalRatePct, 50);
  assert.equal(s.returnRatePct, 25);
});

test('Light と分離: cron・env・時刻が別で、既存の自動化のゲートに依存しない', () => {
  const cron = readFileSync(`${ROOT}netlify/functions/cron-premium-renewal-reminder.js`, 'utf8');
  assert.match(cron, /schedule: '5 1 \* \* \*'/);
  assert.match(cron, /runPremiumRenewal/);
  assert.equal(/LIGHT_RENEWAL_REMINDER_MODE|NEWSLETTER_AUTOMATION_ENABLED|MARKETING_CAMPAIGN_DISPATCH_ENABLED/.test(cron.replace(/\/\*[\s\S]*?\*\//g, '')), false);
  const lightCron = readFileSync(`${ROOT}netlify/functions/cron-light-renewal-reminder.js`, 'utf8');
  assert.match(lightCron, /schedule: '0 1 \* \* \*'/);
  assert.match(lightCron, /runLightRenewal/);
});

test('Stripe 会員（自動更新）には期限のお知らせを送らない', () => {
  const base = {
    'プラン': 'Premium', PlanType: 'Monthly', PaidAt: '2026-09-01T00:00:00Z', Status: 'active',
    Email: 'a@example.com', '有効期限': '2026-10-05',
  };
  assert.equal(isPaidPremiumMonthly({ ...base, PaymentMethod: 'Stripe' }).reason, 'stripe_auto_renew');
  assert.equal(isPaidPremiumMonthly({ ...base, PaymentMethod: 'Bank Transfer' }).ok, true);
});
