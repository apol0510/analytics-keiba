/**
 * lightRenewal.test.mjs — Light 月払い 期限前・失効後リマインド（MK 決定 2026-09-29 / 1-B）の重要仕様
 *   node --test src/lib/marketing/lightRenewal/*.test.mjs
 *
 * 対象判定 / 期限境界 / 二重送信防止 / 更新・乗り換え後の停止 / 配信停止・バウンス・suppression /
 * 冪等性（予約の fail closed・失敗時の解放）/ 2 つの導線と ¥44,820・期限の表示 / 集計 を固定する。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  isPaidLightMonthly, evaluateCandidate, stageFor, stillSendable, deliveryKeyFor, switchDeadlineFor,
  SKIP, STAGE, LIGHT_SWITCH_GRACE_DAYS, POST_WINDOW, LIGHT_RENEWAL_CAMPAIGN_TYPE,
} from './lightRenewalPolicy.js';
import { renderLightRenewalEmail, LIGHT_RENEWAL_CTA_URL } from './lightRenewalEmail.js';
import { runLightRenewal, resolveMode, MODE } from './lightRenewalRunner.js';
import { summarizeLightRenewalOutcomes } from './lightRenewalReport.js';
import { clearProviderSuppressionCache } from '../providerSuppression.js';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const NOW = Date.parse('2026-10-01T03:00:00Z'); // JST 2026-10-01 12:00
const PAID = (over = {}) => ({
  Email: 'light-a@example.com', '氏名': 'テスト', 'プラン': 'Light', PlanType: 'Monthly',
  PaidAt: '2026-09-05T01:00:00.000Z', Status: 'active', '有効期限': '2026-10-05', ...over,
});

// ── 対象判定 ─────────────────────────────────────────────
test('対象: 実際に支払った Light 月払いだけ（無料付与のみ・年払い・Premium は対象外）', () => {
  assert.equal(isPaidLightMonthly(PAID()).ok, true);
  assert.equal(isPaidLightMonthly(PAID({ 'プラン': 'Standard' })).ok, true, '旧 Standard は Light 扱い');
  assert.equal(isPaidLightMonthly(PAID({ PaidAt: '' })).reason, SKIP.NOT_PAID, '無料付与のみ（入金なし）');
  assert.equal(isPaidLightMonthly(PAID({ PlanType: 'Annual' })).reason, SKIP.NOT_MONTHLY);
  assert.equal(isPaidLightMonthly(PAID({ 'プラン': 'Premium' })).reason, SKIP.NOT_LIGHT);
});

test('対象外: test・pending・停止・強制ログアウト・退会申請・配信停止・乗り換え済み・メール不正', () => {
  for (const [over, reason] of [
    [{ Status: 'test' }, SKIP.EXCLUDED_STATUS], [{ Status: 'pending' }, SKIP.EXCLUDED_STATUS],
    [{ Status: 'suspended' }, SKIP.EXCLUDED_STATUS], [{ ForceLogout: true }, SKIP.FORCE_LOGOUT],
    [{ WithdrawalRequested: true }, SKIP.WITHDRAWAL], [{ UnsubscribedAnalyticsKeiba: true }, SKIP.UNSUBSCRIBED],
    [{ PremiumConvertedAt: '2026-09-30T00:00:00Z' }, SKIP.CONVERTED], [{ Email: 'broken' }, SKIP.INVALID_EMAIL],
  ]) assert.equal(isPaidLightMonthly(PAID(over)).reason, reason, JSON.stringify(over));
});

// ── 期限境界（JST 暦日）──────────────────────────────────
test('PRE は期限の 1〜7 日前だけ（8 日前・当日は送らない）', () => {
  const cycle = '2026-10-10';
  assert.equal(stageFor(cycle, '2026-10-02'), null, '8 日前');
  assert.equal(stageFor(cycle, '2026-10-03'), STAGE.PRE, '7 日前');
  assert.equal(stageFor(cycle, '2026-10-09'), STAGE.PRE, '1 日前');
  assert.equal(stageFor(cycle, '2026-10-10'), null, '当日');
});

test('POST は失効後 3〜30 日だけ（2 日後・31 日後は送らない）＝ ¥44,820 の期限と一致', () => {
  const cycle = '2026-09-01';
  assert.equal(stageFor(cycle, '2026-09-03'), null, '2 日後');
  assert.equal(stageFor(cycle, '2026-09-04'), STAGE.POST, '3 日後');
  assert.equal(stageFor(cycle, '2026-10-01'), STAGE.POST, '30 日後');
  assert.equal(stageFor(cycle, '2026-10-02'), null, '31 日後');
  assert.equal(POST_WINDOW.max, LIGHT_SWITCH_GRACE_DAYS);
  assert.equal(switchDeadlineFor('2026-09-01'), '2026-10-01');
});

test('JST で日付を切る（UTC 15:00 以降は翌日扱い）', () => {
  // JST 2026-10-03 00:30 = 7 日前
  assert.equal(evaluateCandidate(PAID({ '有効期限': '2026-10-10' }), Date.parse('2026-10-02T15:30:00Z')).stage, STAGE.PRE);
  assert.equal(evaluateCandidate(PAID({ '有効期限': '2026-10-10' }), Date.parse('2026-10-02T14:30:00Z')).reason, SKIP.OUT_OF_WINDOW);
});

test('乗り換え特典の期限は pricingEligibility（表示と申込判定の単一源）と同じ値・再定義しない', async () => {
  const pricing = await import('../../pricing/pricingEligibility.js');
  const policy = await import('./lightRenewalPolicy.js');
  assert.equal(policy.LIGHT_SWITCH_GRACE_DAYS, pricing.LIGHT_SWITCH_GRACE_DAYS);
  assert.equal(policy.LIGHT_SWITCH_GRACE_DAYS, 30);
  const src = readFileSync(`${ROOT}src/lib/marketing/lightRenewal/lightRenewalPolicy.js`, 'utf8');
  assert.equal(/LIGHT_SWITCH_GRACE_DAYS\s*=\s*\d/.test(src), false, 'ここで値を再定義している');
  // メールの「◯月◯日まで」とサーバーの価格資格の最終日が一致する（D+30 の終わりまで資格あり・D+31 は通常条件）
  const f = { 'プラン': 'Light', 'PlanType': 'Monthly', 'Status': 'active', 'PaidAt': '2026-08-01T00:00:00.000Z', '有効期限': '2026-09-01' };
  const last = policy.switchDeadlineFor('2026-09-01');
  assert.equal(pricing.resolvePaidPricingTierFromFields(f, Date.parse(`${last}T23:59:00+09:00`)), pricing.PRICING_TIER.LIGHT);
  const dayAfter = new Date(Date.parse(`${last}T00:00:00+09:00`) + 86400000 + 1000);
  assert.equal(pricing.resolvePaidPricingTierFromFields(f, dayAfter.getTime()), pricing.PRICING_TIER.NONE);
});

// ── 冪等性・送信直前の停止 ───────────────────────────────
test('DeliveryKey は 会員 × 周期 × 段 ごとに 1 つ（新しい周期は別の鍵）', () => {
  const a = deliveryKeyFor({ recordId: 'recAAAAAAAAAAAAAA', cycle: '2026-10-05', stage: 'pre' });
  assert.match(a, /^[a-f0-9]{64}$/);
  assert.equal(a, deliveryKeyFor({ recordId: 'recAAAAAAAAAAAAAA', cycle: '2026-10-05', stage: 'pre' }));
  assert.notEqual(a, deliveryKeyFor({ recordId: 'recAAAAAAAAAAAAAA', cycle: '2026-10-05', stage: 'post' }));
  assert.notEqual(a, deliveryKeyFor({ recordId: 'recAAAAAAAAAAAAAA', cycle: '2026-11-05', stage: 'pre' }));
});

test('送信直前に更新・乗り換え・プラン変更を検知したら送らない', () => {
  const planned = { cycle: '2026-10-05', stage: STAGE.PRE };
  assert.equal(stillSendable(planned, PAID(), NOW).ok, true);
  assert.equal(stillSendable(planned, PAID({ '有効期限': '2026-11-05' }), NOW).ok, false, '更新（期限が延びた）');
  assert.equal(stillSendable(planned, PAID({ 'プラン': 'Premium', PlanType: 'Annual' }), NOW).ok, false, 'Premium へ');
  assert.equal(stillSendable(planned, PAID({ PremiumConvertedAt: '2026-10-01T00:00:00Z' }), NOW).ok, false, '乗り換え記録');
  assert.equal(stillSendable(planned, null, NOW).ok, false, 'レコードが消えた');
});

// ── 本文 ─────────────────────────────────────────────────
test('期限前: 2 つの導線（Light を続ける / Premium ¥44,820）が分かれ、どちらもログイン経由の /pricing/', () => {
  const m = renderLightRenewalEmail({ stage: STAGE.PRE, cycle: '2026-10-05', name: 'テスト' });
  assert.equal(LIGHT_RENEWAL_CTA_URL, 'https://analytics.keiba.link/login/?next=/pricing/');
  assert.match(m.subject, /有効期限が近づいています（10月5日まで）/);
  assert.match(m.html, /Light を続ける手続きへ/);
  assert.match(m.html, /Premium 年額 ¥44,820 で申し込む/);
  assert.equal((m.html.match(/href="https:\/\/analytics\.keiba\.link\/login\/\?next=\/pricing\/"/g) || []).length, 2);
  assert.match(m.text, /Light を続ける手続きへ:\nhttps:\/\/analytics\.keiba\.link\/login\/\?next=\/pricing\//);
  assert.ok(m.html.includes('{{unsubscribeUrl}}'), '配信停止の印（共通シェル）');
  assert.ok(m.html.indexOf('Light を続ける手続きへ') < m.html.indexOf('Premium 年額 ¥44,820 で申し込む'));
});

test('失効後: Light を再開 / Premium ¥44,820 と、特典の期限日（失効後 30 日）・翌日から通常価格を書く', () => {
  const m = renderLightRenewalEmail({ stage: STAGE.POST, cycle: '2026-09-25' });
  assert.match(m.subject, /10月25日まで Premium 年額 ¥44,820/);
  assert.match(m.html, /Light を再開する手続きへ/);
  assert.match(m.text, /2026年10月25日 までは、Light 会員の乗り換え特典として Premium 年額を ¥44,820（通常 ¥49,800）/);
  assert.match(m.text, /2026年10月26日 以降は通常の価格/);
  assert.ok(m.text.replace(/\s/g, '').length >= 180, '本文 180 字以上');
});

// ── 実行（偽の fetch / Redis・ネットワークに出ない）────────
const RECS = {
  recAAAAAAAAAAAAAA: PAID({ Email: 'a@example.com', '有効期限': '2026-10-05' }), // PRE
  recBBBBBBBBBBBBBB: PAID({ Email: 'b@example.com', '有効期限': '2026-09-25' }), // POST
  recCCCCCCCCCCCCCC: PAID({ Email: 'c@example.com', '有効期限': '2026-10-03', PaidAt: '' }), // 無料付与のみ
  recDDDDDDDDDDDDDD: PAID({ Email: 'd@example.com', '有効期限': '2026-10-20' }), // 窓の外
};

function harness({ suppressed = [], blacklist = [], sendOk = true, redisThrows = false, fresh = {}, deliveries = [] } = {}) {
  const redis = new Map();
  const calls = { sent: [], upserts: [], patches: [], redis: [] };
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
    if (u.includes('/Customers')) return json({ records: Object.entries(RECS).map(([id, fields]) => ({ id, fields })) });
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

beforeEach(() => clearProviderSuppressionCache());

test('モード: 未設定・不明な値は off（何もしない）', async () => {
  assert.equal(resolveMode({}), MODE.OFF);
  assert.equal(resolveMode({ LIGHT_RENEWAL_REMINDER_MODE: 'yes' }), MODE.OFF);
  const h = harness();
  const r = await runLightRenewal({ mode: MODE.OFF, env: h.env, nowMs: NOW, fetchImpl: h.fetchImpl, redisCmd: h.redisCmd });
  assert.equal(r.sent, 0);
  assert.equal(h.calls.sent.length + h.calls.upserts.length + h.calls.redis.length, 0);
});

test('dry-run: 件数だけ（送信・書き込み・予約 0）', async () => {
  const h = harness();
  const r = await runLightRenewal({ mode: MODE.DRY_RUN, env: h.env, nowMs: NOW, fetchImpl: h.fetchImpl, redisCmd: h.redisCmd });
  assert.deepEqual(r.planned, { pre: 1, post: 1 });
  assert.equal(r.excludedByReason[SKIP.NOT_PAID], 1);
  assert.equal(r.excludedByReason[SKIP.OUT_OF_WINDOW], 1);
  assert.equal(h.calls.sent.length + h.calls.upserts.length + h.calls.redis.length, 0);
  assert.equal(JSON.stringify(r).includes('@'), false, 'アドレスを返さない');
});

test('live: PRE と POST を 1 通ずつ送り、配信行・custom_args・配信停止ヘッダを付ける', async () => {
  const h = harness();
  const r = await runLightRenewal({ mode: MODE.LIVE, env: h.env, nowMs: NOW, fetchImpl: h.fetchImpl, redisCmd: h.redisCmd });
  assert.equal(r.sent, 2);
  assert.deepEqual(h.calls.upserts.map((u) => u.StepNumber).sort(), [1, 2]);
  assert.ok(h.calls.upserts.every((u) => u.CampaignType === LIGHT_RENEWAL_CAMPAIGN_TYPE && u.EmailType === 'campaign'));
  assert.ok(h.calls.sent.every((s) => s.custom_args && /^[a-f0-9]{64}$/.test(s.custom_args.delivery_key)));
  assert.ok(h.calls.sent.every((s) => s.headers['List-Unsubscribe'] && s.from.email === 'noreply@keiba.link' && s.reply_to.email === 'support@keiba.link'));
  assert.ok(h.calls.patches.filter((p) => p.Status === 'sent').length === 2);
});

test('二重送信しない: 同じ日にもう一度走っても予約済みで送らない', async () => {
  const h = harness();
  await runLightRenewal({ mode: MODE.LIVE, env: h.env, nowMs: NOW, fetchImpl: h.fetchImpl, redisCmd: h.redisCmd });
  const r2 = await runLightRenewal({ mode: MODE.LIVE, env: h.env, nowMs: NOW, fetchImpl: h.fetchImpl, redisCmd: h.redisCmd });
  assert.equal(r2.sent, 0);
  assert.equal(r2.skippedByReason.already_claimed, 2);
  assert.equal(h.calls.sent.length, 2);
});

test('二重送信しない: 配信行が既に sent なら予約を見ずに止める', async () => {
  const key = deliveryKeyFor({ recordId: 'recAAAAAAAAAAAAAA', cycle: '2026-10-05', stage: 'pre' });
  const h = harness({ deliveries: [{ id: 'recDEL1', fields: { EmailType: 'campaign', RecipientEmail: 'a@example.com', DeliveryKey: key, Status: 'sent', SentAt: '2026-09-30T01:00:00Z', CampaignType: LIGHT_RENEWAL_CAMPAIGN_TYPE } }] });
  const r = await runLightRenewal({ mode: MODE.LIVE, env: h.env, nowMs: NOW, fetchImpl: h.fetchImpl, redisCmd: h.redisCmd });
  assert.equal(r.skippedByReason.already_sent, 1);
  assert.equal(r.sent, 1);
});

test('配信停止・バウンス・provider suppression の相手へは送らない', async () => {
  const h = harness({ suppressed: ['a@example.com'], blacklist: ['b@example.com'] });
  const r = await runLightRenewal({ mode: MODE.LIVE, env: h.env, nowMs: NOW, fetchImpl: h.fetchImpl, redisCmd: h.redisCmd });
  assert.equal(r.sent, 0);
  assert.equal(r.skippedByReason.provider_suppressed, 1);
  assert.equal(r.skippedByReason.blacklist, 1);
});

test('provider suppression を確認できなければ 1 通も送らない（fail closed）', async () => {
  const h = harness({ suppressed: null });
  await assert.rejects(() => runLightRenewal({ mode: MODE.LIVE, env: h.env, nowMs: NOW, fetchImpl: h.fetchImpl, redisCmd: h.redisCmd }),
    (e) => e.code === 'provider_suppression_unavailable');
  assert.equal(h.calls.sent.length, 0);
});

test('送信直前に更新 / 乗り換えを検知したら送らない', async () => {
  const h = harness({ fresh: { recAAAAAAAAAAAAAA: { '有効期限': '2026-11-05' }, recBBBBBBBBBBBBBB: { PremiumConvertedAt: '2026-09-30T00:00:00Z', 'プラン': 'Premium' } } });
  const r = await runLightRenewal({ mode: MODE.LIVE, env: h.env, nowMs: NOW, fetchImpl: h.fetchImpl, redisCmd: h.redisCmd });
  assert.equal(r.sent, 0);
  assert.equal(r.skippedByReason.cycle_changed, 1);
  assert.ok(r.skippedByReason[SKIP.NOT_LIGHT] === 1 || r.skippedByReason[SKIP.CONVERTED] === 1);
});

test('予約の結果が分からない（Redis 障害）なら送らない（fail closed）', async () => {
  const h = harness({ redisThrows: true });
  await assert.rejects(() => runLightRenewal({ mode: MODE.LIVE, env: h.env, nowMs: NOW, fetchImpl: h.fetchImpl, redisCmd: h.redisCmd }),
    (e) => e.code === 'redis_claim_unknown');
  assert.equal(h.calls.sent.length, 0);
});

test('送信に失敗したら配信行を failed にし、予約を外す（翌日再試行できる）', async () => {
  const h = harness({ sendOk: false });
  const r = await runLightRenewal({ mode: MODE.LIVE, env: h.env, nowMs: NOW, fetchImpl: h.fetchImpl, redisCmd: h.redisCmd });
  assert.equal(r.sent, 0);
  assert.equal(r.failed, 2);
  assert.equal(h.redis.size, 0, '予約が残っていない');
  assert.equal(h.calls.patches.filter((p) => p.Status === 'failed').length, 2);
});

// ── 集計 ─────────────────────────────────────────────────
test('集計: 会員 × 周期を 1 件とし、更新・乗り換え・失効・結論前に分けて率を出す', () => {
  const row = (rid, cycle, stage, sentAt) => ({ fields: { CampaignType: LIGHT_RENEWAL_CAMPAIGN_TYPE, Status: 'sent', CustomerRecordId: rid, SentAt: sentAt, Metadata: JSON.stringify({ cycle, stage }) } });
  const deliveries = [
    row('rec1', '2026-10-05', 'pre', '2026-10-01T01:00:00Z'),
    row('rec1', '2026-10-05', 'post', '2026-10-08T01:00:00Z'), // 同じ周期は 1 件
    row('rec2', '2026-10-05', 'pre', '2026-10-01T01:00:00Z'),
    row('rec3', '2026-10-05', 'pre', '2026-10-01T01:00:00Z'),
    row('rec4', '2026-11-20', 'pre', '2026-11-15T01:00:00Z'),
  ];
  const customersById = new Map([
    ['rec1', { 'プラン': 'Light', '有効期限': '2026-11-07' }], // 更新
    ['rec2', { 'プラン': 'Premium', PremiumConvertedAt: '2026-10-03T00:00:00Z', PremiumConvertedFrom: 'Light/Monthly' }], // 乗り換え
    ['rec3', { 'プラン': 'Light', '有効期限': '2026-10-05' }], // 失効（期限 + 30 日を過ぎた）
    ['rec4', { 'プラン': 'Light', '有効期限': '2026-11-20' }], // 結論前
  ]);
  const s = summarizeLightRenewalOutcomes({ deliveries, customersById, nowMs: Date.parse('2026-11-16T03:00:00Z') });
  assert.equal(s.cycles, 4);
  assert.deepEqual([s.renewed, s.converted, s.lapsed, s.open], [1, 1, 1, 1]);
  assert.equal(s.decided, 3);
  assert.equal(s.renewalRatePct, 33.3);
  assert.equal(s.conversionRatePct, 33.3);
});

test('既存の自動化のゲートを開けない（cron-marketing-automation / NEWSLETTER_AUTOMATION_ENABLED に依存しない）', () => {
  for (const f of ['netlify/functions/cron-light-renewal-reminder.js', 'src/lib/marketing/lightRenewal/lightRenewalRunner.js']) {
    const src = readFileSync(`${ROOT}${f}`, 'utf8');
    for (const w of ['NEWSLETTER_AUTOMATION_ENABLED', 'MARKETING_AUTOMATION_SCHEDULER_ENABLED', 'MARKETING_AUTOMATION_DISPATCH_ARMED']) {
      assert.equal(src.includes(w), false, `${f}: ${w}`);
    }
  }
  assert.match(readFileSync(`${ROOT}netlify/functions/cron-light-renewal-reminder.js`, 'utf8'), /schedule: '0 1 \* \* \*'/);
});
