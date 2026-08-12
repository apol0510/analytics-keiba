/**
 * engagementPlanIntegration.test.mjs — 反応なし除外が **実際に送信対象から外れる**ことの検証
 *   node --test src/lib/marketing/engagementPlanIntegration.test.mjs
 *
 * 重点:
 *   - INACTIVE / HARD_INACTIVE は送信対象から外れる。LOW_ENGAGEMENT / UNKNOWN は外れない
 *   - 既存の除外（配信停止・バウンス・既送信・頻度）を壊さない・順序を奪わない
 *   - 下見（dry-run）と実 enqueue が **同じ材料から同じ結果**になる（再実行でも安定）
 *   - 材料が欠ければ 1 人も除外しない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { buildCampaignPlan, computePlanFingerprint, MK_EXCLUSION, MK_EXCLUSION_LABEL } from './campaignSend.js';
import { resolveCustomerMarketing } from './customerMarketingAudience.js';
import { buildEngagementView } from './engagementGuard.js';
import { appliesToEmailType } from './engagementPolicy.js';
import { checkBenefitForSend, BULK_THRESHOLD } from './campaignBenefit.js';

const NOW = Date.UTC(2026, 7, 12, 0, 0);
const DAY = 86400000;
const START = NOW - 200 * DAY;
const FROM = 'noreply@keiba.link';
const hashOf = (e) => createHash('sha256').update(e, 'utf8').digest('hex').slice(0, 32);

const campaign = Object.freeze({
  campaignId: 'test-generic', version: 1, name: 'テスト用',
  subject: 'テスト件名', body: '{{salutation}}\n\n本文',
  ctaLabel: '詳細', ctaUrl: 'https://analytics.keiba.link/',
  audienceRule: { contracts: [], plans: [], enforce: false },
  enabled: true,
});

const MEASURED = { open: 'enabled', click: 'disabled' };
const signals = (openers = ['opener@example.com']) => ({
  available: true,
  openByHash: new Map(openers.map((e) => [hashOf(e), NOW - DAY])),
  clickByHash: new Map(),
  meta: { startedAtMs: START, firstOpenAtMs: START + DAY, lastEventAtMs: NOW - 3600000 },
});

function customer(email, over = {}) {
  const fields = { Email: email, Status: 'active', 'プラン': 'Premium', '有効期限': '2020-01-01', ...over };
  return { recordId: `rec-${email}`, fields, marketing: resolveCustomerMarketing({ fields, nowMs: NOW }) };
}

const sends = (email, n, atMs = NOW - 30 * DAY) => Array.from({ length: n }, () => ({
  fields: {
    EmailType: 'campaign', RecipientEmail: email, Status: 'sent',
    SentAt: new Date(atMs).toISOString(),
  },
}));

/** 管理 Function と同じ組み立て（下見も enqueue もこの 1 本を通る） */
function planWith({ list, deliveries, measurement = MEASURED, sig = signals(), env = {} }) {
  const view = buildEngagementView({
    list, deliveries, signals: sig, measurement, nowMs: NOW, env,
  });
  const plan = buildCampaignPlan({
    campaign, selected: list, deliveredKeys: undefined,
    providerSuppressed: new Set(), brand: 'analytics-keiba', fromEmail: FROM, nowMs: NOW,
    engagementByEmail: view.engagementByEmail,
    engagementThresholds: view.thresholds,
  });
  return { view, plan };
}

// ── 除外される / されない ───────────────────────────────────
test('10 通 delivered で無反応の相手は送信対象から外れる', () => {
  const list = [customer('dead@example.com'), customer('fresh@example.com')];
  const { plan } = planWith({ list, deliveries: sends('dead@example.com', 10) });

  assert.equal(plan.ok, true);
  assert.equal(plan.counts.recipients, 1);
  assert.equal(plan.counts.byReason[MK_EXCLUSION.ENGAGEMENT_BLOCKED], 1);
  assert.equal(plan.recipients[0].email, 'fresh@example.com');
  const ex = plan.excluded.find((e) => e.reason === MK_EXCLUSION.ENGAGEMENT_BLOCKED);
  assert.equal(ex.recordId, 'rec-dead@example.com', '誰が落ちたかが recordId で分かる');
});

test('20 通 delivered（HARD_INACTIVE）も外れる', () => {
  const list = [customer('dead@example.com')];
  const { plan } = planWith({ list, deliveries: sends('dead@example.com', 20) });
  assert.equal(plan.counts.recipients, 0);
  assert.equal(plan.counts.byReason[MK_EXCLUSION.ENGAGEMENT_BLOCKED], 1);
});

test('5 通（LOW_ENGAGEMENT）と 4 通（UNKNOWN）は外れない', () => {
  const list = [customer('low@example.com'), customer('unknown@example.com')];
  const { plan } = planWith({
    list,
    deliveries: [...sends('low@example.com', 5), ...sends('unknown@example.com', 4)],
  });
  assert.equal(plan.counts.recipients, 2);
  assert.equal(plan.counts.byReason[MK_EXCLUSION.ENGAGEMENT_BLOCKED], undefined);
});

test('開封・購入・ログインがあれば何通送っていても外れない', () => {
  const list = [
    customer('opener@example.com'),
    customer('buyer@example.com', { PaidAt: '2026-01-01' }),
    customer('user@example.com', { LastLoginAt: '2026-07-01' }),
  ];
  const { plan } = planWith({
    list,
    deliveries: [
      ...sends('opener@example.com', 30), ...sends('buyer@example.com', 30), ...sends('user@example.com', 30),
    ],
  });
  assert.equal(plan.counts.recipients, 3);
});

// ── 既存の除外を壊さない ────────────────────────────────────
test('配信停止・ソフトバウンスは engagement より先に効く（理由が置き換わらない）', () => {
  const list = [
    customer('unsub@example.com', { UnsubscribedAnalyticsKeiba: true }),
    customer('bounce@example.com'),
  ];
  const deliveries = [...sends('unsub@example.com', 30), ...sends('bounce@example.com', 30)];
  const view = buildEngagementView({
    list, deliveries, signals: signals(), measurement: MEASURED, nowMs: NOW, env: {},
  });
  // 両方とも engagement 上は除外対象だが、より強い理由が先に当たる
  assert.deepEqual([...view.blockedEmails].sort(), ['bounce@example.com', 'unsub@example.com']);

  const plan = buildCampaignPlan({
    campaign, selected: list, providerSuppressed: new Set(),
    softBounced: new Set(['bounce@example.com']),
    brand: 'analytics-keiba', fromEmail: FROM, nowMs: NOW,
    engagementByEmail: view.engagementByEmail, engagementThresholds: view.thresholds,
  });
  const reasons = Object.fromEntries(plan.excluded.map((e) => [e.recordId, e.reason]));
  assert.equal(reasons['rec-unsub@example.com'], 'unsubscribed');
  assert.equal(reasons['rec-bounce@example.com'], MK_EXCLUSION.SOFT_BOUNCE);
  assert.equal(plan.counts.byReason[MK_EXCLUSION.ENGAGEMENT_BLOCKED], undefined);
});

test('provider suppression は engagement と無関係に効き続ける', () => {
  const list = [customer('sup@example.com')];
  const view = buildEngagementView({
    list, deliveries: [], signals: signals(), measurement: MEASURED, nowMs: NOW, env: {},
  });
  const plan = buildCampaignPlan({
    campaign, selected: list, providerSuppressed: new Set(['sup@example.com']),
    brand: 'analytics-keiba', fromEmail: FROM, nowMs: NOW,
    engagementByEmail: view.engagementByEmail, engagementThresholds: view.thresholds,
  });
  assert.equal(plan.counts.byReason[MK_EXCLUSION.PROVIDER_SUPPRESSED], 1);
});

test('除外理由には必ず日本語ラベルがある（未知コードで実行不可にならない）', () => {
  assert.ok(MK_EXCLUSION_LABEL[MK_EXCLUSION.ENGAGEMENT_BLOCKED]);
});

// ── 適用できないときは素通り ────────────────────────────────
test('開封を計測していなければ 1 人も外れない', () => {
  const list = [customer('dead@example.com')];
  const { view, plan } = planWith({
    list, deliveries: sends('dead@example.com', 30), measurement: { open: 'disabled' },
  });
  assert.equal(view.applied, false);
  assert.equal(plan.counts.recipients, 1);
  assert.equal(plan.counts.byReason[MK_EXCLUSION.ENGAGEMENT_BLOCKED], undefined);
});

test('集計を読めないときも 1 人も外れない', () => {
  const list = [customer('dead@example.com')];
  const { plan } = planWith({
    list,
    deliveries: sends('dead@example.com', 30),
    sig: { available: false, openByHash: new Map(), clickByHash: new Map(), meta: {} },
  });
  assert.equal(plan.counts.recipients, 1);
});

test('緊急停止（env=off）で即座に素通りへ戻せる', () => {
  const list = [customer('dead@example.com')];
  const { plan } = planWith({
    list, deliveries: sends('dead@example.com', 30), env: { MARKETING_ENGAGEMENT_GUARD: 'off' },
  });
  assert.equal(plan.counts.recipients, 1);
});

// ── 既存の安全装置を残す ────────────────────────────────────
test('取引メール（決済・認証・サポート・期限通知）には engagement を適用しない', () => {
  for (const t of ['payment', 'auth', 'support', 'expiry', 'step', 'race_main', 'transactional']) {
    assert.equal(appliesToEmailType(t), false, `${t} に適用してはいけない`);
  }
  assert.equal(appliesToEmailType('campaign'), true);
  assert.equal(appliesToEmailType(''), false, '種別不明にも適用しない（安全側）');
});

test('benefit の宣言が無い大量配信は引き続き送れない（engagement 除外で人数が減っても同じ）', () => {
  const vague = { ...campaign, benefitType: undefined, benefitDescription: undefined };
  const r = checkBenefitForSend({ campaign: vague, recipientCount: BULK_THRESHOLD + 1 });
  assert.equal(r.ok, false, '価値の宣言が無い大量配信は fail closed のまま');
});

// ── 下見と実行の一致・再実行の安定 ──────────────────────────
test('【重要】下見と実 enqueue で対象が一致し、再実行しても変わらない', () => {
  const list = [customer('dead@example.com'), customer('fresh@example.com')];
  const deliveries = sends('dead@example.com', 12);

  const dry = planWith({ list, deliveries });
  const live = planWith({ list, deliveries });     // 実 enqueue も同じ材料・同じ関数を通る
  const again = planWith({ list, deliveries });    // 再実行

  const fp = (p) => computePlanFingerprint({ campaign, recipients: p.plan.recipients });
  assert.equal(fp(dry), fp(live), '対象が変われば fingerprint が変わる = 一致していれば同じ母集団');
  assert.equal(fp(dry), fp(again));
  assert.deepEqual(
    dry.plan.recipients.map((r) => r.email),
    live.plan.recipients.map((r) => r.email),
  );
  assert.deepEqual([...dry.view.blockedEmails], [...again.view.blockedEmails]);
});

test('反応が届けば次回は対象へ戻る（除外は永続しない）', () => {
  const list = [customer('dead@example.com')];
  const deliveries = sends('dead@example.com', 12);

  const before = planWith({ list, deliveries });
  assert.equal(before.plan.counts.recipients, 0);

  // 開封が 1 件届いた後
  const after = planWith({ list, deliveries, sig: signals(['dead@example.com']) });
  assert.equal(after.plan.counts.recipients, 1);
});
