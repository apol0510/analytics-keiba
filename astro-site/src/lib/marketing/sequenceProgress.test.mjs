/**
 * sequenceProgress.test.mjs — 進行（1→2→3）と停止条件と冪等性
 *   node --test src/lib/marketing/sequenceProgress.test.mjs
 *
 * 重点:
 *   - 進行は**送信の事実**（CampaignDeliveries）から導く。状態を別に持たない
 *   - 停止条件（購入 / 配信停止 / バウンス / suppression / 反応なし / 条件変化 / 上限）
 *   - **UNKNOWN・計測不足では止めない**
 *   - 何度実行しても同じ答え（二重 queue しない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSequenceProgress, resolveRecipientProgress, indexDeliveries,
  selectNextDueStep, SEQ_STATUS, SEQ_STOP, SEQ_STOP_LABEL,
} from './sequenceProgress.js';
import { resolveSequenceStep } from './campaignSequence.js';
import { computeCampaignDeliveryKey } from './campaignSend.js';
import { resolveCustomerMarketing, MK_CONTRACT, MK_PLAN } from './customerMarketingAudience.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 20, 0, 0);
const BRAND = 'analytics-keiba';
const FROM = 'noreply@keiba.link';

const mkStep = (n) => ({
  stepNumber: n,
  delayDays: n === 1 ? 0 : 3,
  subject: `件名${n}`,
  preheader: `プリヘッダー${n}`,
  body: `本文${n}`,
  ctaLabel: `CTA${n}`,
  ctaUrl: 'https://analytics.keiba.link/',
  benefitType: 'content_unlock',
  benefitDescription: '無料で見られる予想を開放してご案内します',
});

const CAMPAIGN = Object.freeze({
  campaignId: 'seq-test', version: 1, name: 'テスト連続配信',
  subject: '既定', body: '既定本文', ctaLabel: 'CTA', ctaUrl: 'https://analytics.keiba.link/',
  benefitType: 'content_unlock', benefitDescription: '無料で見られる予想を開放してご案内します',
  audienceRule: { contracts: [MK_CONTRACT.NONE], plans: [MK_PLAN.FREE], enforce: true },
  enabled: true,
  sequence: { maxSends: 3, steps: [mkStep(1), mkStep(2), mkStep(3)] },
});

/** 無料会員（このシーケンスの対象） */
function customer(email, over = {}) {
  const fields = { Email: email, Status: 'active', ...over };
  return { recordId: `rec-${email}`, fields, marketing: resolveCustomerMarketing({ fields, nowMs: NOW }) };
}

/** step n を送った事実（CampaignDeliveries の 1 行） */
function delivered(email, n, atMs = NOW - 10 * DAY, status = 'sent') {
  const key = computeCampaignDeliveryKey({
    campaign: resolveSequenceStep(CAMPAIGN, n), recipientEmail: email, brand: BRAND, fromEmail: FROM,
  });
  return {
    fields: {
      EmailType: 'campaign', DeliveryKey: key, RecipientEmail: email,
      Status: status, SentAt: new Date(atMs).toISOString(),
      CampaignType: `${CAMPAIGN.campaignId}:v${CAMPAIGN.version}`,
    },
  };
}

const run = (selected, deliveries, over = {}) => buildSequenceProgress({
  campaign: CAMPAIGN, selected, deliveries, brand: BRAND, fromEmail: FROM, nowMs: NOW,
  providerSuppressed: new Set(), softBounced: new Set(), ...over,
});

const rowOf = (p, email) => p.rows.find((r) => r.email === email);

// ── 進行 ────────────────────────────────────────────────────
test('未送信なら step1 が「いま送れる」', () => {
  const p = run([customer('a@example.com')], []);
  const r = rowOf(p, 'a@example.com');
  assert.equal(r.currentStep, 0);
  assert.equal(r.nextStep, 1);
  assert.equal(r.status, SEQ_STATUS.DUE);
  assert.equal(p.summary.due, 1);
  assert.equal(p.summary.dueByStep[1], 1);
});

test('step1 → step2 → step3 と進む', () => {
  const email = 'a@example.com';
  const c = [customer(email)];

  const after1 = run(c, [delivered(email, 1)]);
  assert.equal(rowOf(after1, email).currentStep, 1);
  assert.equal(rowOf(after1, email).nextStep, 2);
  assert.equal(rowOf(after1, email).status, SEQ_STATUS.DUE, '3 日経過しているので送れる');

  const after2 = run(c, [delivered(email, 1), delivered(email, 2)]);
  assert.equal(rowOf(after2, email).currentStep, 2);
  assert.equal(rowOf(after2, email).nextStep, 3);

  const after3 = run(c, [delivered(email, 1), delivered(email, 2), delivered(email, 3)]);
  assert.equal(rowOf(after3, email).currentStep, 3);
  assert.equal(rowOf(after3, email).status, SEQ_STATUS.COMPLETED);
});

test('間隔が来ていなければ waiting（次回予定を出す）', () => {
  const email = 'a@example.com';
  const p = run([customer(email)], [delivered(email, 1, NOW - 1 * DAY)]);
  const r = rowOf(p, email);
  assert.equal(r.status, SEQ_STATUS.WAITING);
  assert.equal(r.nextSendAtMs, NOW - 1 * DAY + 3 * DAY);
  assert.equal(p.summary.waiting, 1);
});

test('queued（キュー登録済み・未送信）も「送った」として数える（二重 queue 防止）', () => {
  const email = 'a@example.com';
  const p = run([customer(email)], [delivered(email, 1, NOW - 5 * DAY, 'queued')]);
  assert.equal(rowOf(p, email).currentStep, 1);
});

test('【重要】上限まで送ったら completed（それ以上送らない）', () => {
  const email = 'a@example.com';
  const p = run([customer(email)], [1, 2, 3].map((n) => delivered(email, n)));
  const r = rowOf(p, email);
  assert.equal(r.status, SEQ_STATUS.COMPLETED);
  assert.equal(r.stopReason, SEQ_STOP.MAX_SENDS_REACHED);
  assert.equal(selectNextDueStep(p).step, null, '送る相手がいない');
});

// ── 停止条件 ────────────────────────────────────────────────
test('【停止】購入（有料契約が有効）で止まる', () => {
  const email = 'a@example.com';
  const paid = customer(email, { 'プラン': 'Premium', '有効期限': '2027-01-01' });
  const p = run([paid], [delivered(email, 1)]);
  const r = rowOf(p, email);
  assert.equal(r.status, SEQ_STATUS.STOPPED);
  assert.equal(r.stopReason, SEQ_STOP.PURCHASED);
  assert.equal(p.summary.byStopReason.purchased, 1);
});

test('【停止】配信停止（unsubscribe）で止まる', () => {
  const email = 'a@example.com';
  const p = run([customer(email, { UnsubscribedAnalyticsKeiba: true })], [delivered(email, 1)]);
  assert.equal(rowOf(p, email).stopReason, SEQ_STOP.NOT_SENDABLE);
});

test('【停止】配信基盤 suppression / ソフトバウンスで止まる', () => {
  const email = 'a@example.com';
  const sup = run([customer(email)], [delivered(email, 1)], { providerSuppressed: new Set([email]) });
  assert.equal(rowOf(sup, email).stopReason, SEQ_STOP.PROVIDER_SUPPRESSED);

  const soft = run([customer(email)], [delivered(email, 1)], { softBounced: new Set([email]) });
  assert.equal(rowOf(soft, email).stopReason, SEQ_STOP.SOFT_BOUNCE);
});

test('【停止】対象条件から外れたら止まる（プラン・契約の変化）', () => {
  const email = 'a@example.com';
  // 期限切れ = contract:expired。このシーケンスは contract:none 限定なので対象外になる
  const changed = customer(email, { 'プラン': 'Premium', '有効期限': '2020-01-01' });
  const p = run([changed], [delivered(email, 1)]);
  assert.equal(rowOf(p, email).stopReason, SEQ_STOP.AUDIENCE_MISMATCH);
});

test('【停止】反応なし（INACTIVE）で止まる', () => {
  const email = 'a@example.com';
  const p = run([customer(email)], [delivered(email, 1)], {
    engagementByEmail: new Map([[email, { sent: 12, delivered: 12, open: 0 }]]),
  });
  assert.equal(rowOf(p, email).stopReason, SEQ_STOP.ENGAGEMENT_BLOCKED);
});

test('【重要】UNKNOWN・計測不足では止めない', () => {
  const email = 'a@example.com';
  // 判定 Map を渡さない = 反応を確認できていない → 止めない
  const noMap = run([customer(email)], [delivered(email, 1)]);
  assert.equal(noMap.rows[0].status, SEQ_STATUS.DUE);

  // Map はあるが判断材料不足（UNKNOWN）→ 止めない
  const unknown = run([customer(email)], [delivered(email, 1)], {
    engagementByEmail: new Map([[email, { sent: 1, delivered: 1, open: 0 }]]),
  });
  assert.equal(unknown.rows[0].status, SEQ_STATUS.DUE);

  // 観察段階（LOW_ENGAGEMENT = 5 通無反応）でも止めない
  const low = run([customer(email)], [delivered(email, 1)], {
    engagementByEmail: new Map([[email, { sent: 5, delivered: 5, open: 0 }]]),
  });
  assert.equal(low.rows[0].status, SEQ_STATUS.DUE);
});

test('【停止】キャンペーン停止中は全員止まる', () => {
  const p = buildSequenceProgress({
    campaign: { ...CAMPAIGN, enabled: false }, selected: [customer('a@example.com')],
    deliveries: [], brand: BRAND, fromEmail: FROM, nowMs: NOW, providerSuppressed: new Set(),
  });
  assert.equal(p.rows[0].stopReason, SEQ_STOP.CAMPAIGN_DISABLED);
});

test('停止理由には必ず日本語ラベルがある', () => {
  for (const code of Object.values(SEQ_STOP)) assert.ok(SEQ_STOP_LABEL[code], code);
});

// ── 冪等性・整合性 ──────────────────────────────────────────
test('【重要】同じ入力で何度計算しても同じ（再実行で二重 queue しない）', () => {
  const email = 'a@example.com';
  const c = [customer(email)];
  const d = [delivered(email, 1)];
  const a = selectNextDueStep(run(c, d));
  const b = selectNextDueStep(run(c, d));
  assert.deepEqual(a, b);
  assert.equal(a.step, 2);

  // step2 を送った直後に再実行すると、step2 はもう選ばれない
  const after = selectNextDueStep(run(c, [...d, delivered(email, 2, NOW)]));
  assert.equal(after.step, null, 'まだ間隔が来ていないので送る相手はいない');
});

test('同一アドレスの重複レコードは 1 人として数える', () => {
  const email = 'a@example.com';
  const dup = [customer(email), { ...customer(email), recordId: 'rec-dup' }];
  const p = run(dup, []);
  assert.equal(p.summary.total, 1);
});

test('1 回に流すのは 1 ステップだけ（混ぜない）', () => {
  const p = run([customer('a@example.com'), customer('b@example.com')], [delivered('b@example.com', 1)]);
  const next = selectNextDueStep(p);
  assert.equal(next.step, 1, 'いちばん小さい due ステップ');
  assert.deepEqual(next.emails, ['a@example.com']);
});

test('上限人数を超える分は切り出す（cap）', () => {
  const many = Array.from({ length: 5 }, (_, i) => customer(`u${i}@example.com`));
  const next = selectNextDueStep(run(many, []), { maxRecipients: 2 });
  assert.equal(next.recordIds.length, 2);
  assert.equal(next.truncated, true);
});

test('検算が合う（母数 = due + waiting + completed + stopped）', () => {
  const p = run([
    customer('a@example.com'),
    customer('b@example.com', { UnsubscribedAnalyticsKeiba: true }),
    customer('c@example.com', { 'プラン': 'Light', '有効期限': '2027-01-01' }),
  ], [delivered('a@example.com', 1)]);
  assert.equal(p.summary.balanced, true);
  assert.equal(p.summary.total, 3);
});

test('取引メールの配信履歴は進行に混ぜない', () => {
  const email = 'a@example.com';
  const payment = { fields: { EmailType: 'payment', DeliveryKey: 'x', RecipientEmail: email, Status: 'sent' } };
  assert.equal(indexDeliveries([payment]).size, 0);
  const p = run([customer(email)], [payment]);
  assert.equal(rowOf(p, email).currentStep, 0);
});

test('version が変わると進行はリセットされる（別の配信として扱う）', () => {
  const email = 'a@example.com';
  const d = [delivered(email, 1), delivered(email, 2)];
  const v2 = buildSequenceProgress({
    campaign: { ...CAMPAIGN, version: 2 }, selected: [customer(email)], deliveries: d,
    brand: BRAND, fromEmail: FROM, nowMs: NOW, providerSuppressed: new Set(),
  });
  assert.equal(v2.rows[0].currentStep, 0, 'v1 の送信実績は v2 の進行に数えない');
  assert.equal(v2.rows[0].nextStep, 1);
});

test('resolveRecipientProgress 単体でも同じ答え', () => {
  const email = 'a@example.com';
  const idx = indexDeliveries([delivered(email, 1)]);
  const r = resolveRecipientProgress({
    campaign: CAMPAIGN, customer: customer(email), deliveredIndex: idx,
    brand: BRAND, fromEmail: FROM, nowMs: NOW, providerSuppressed: new Set(),
  });
  assert.equal(r.nextStep, 2);
  assert.deepEqual(r.sentSteps, [1]);
});

// ── Light 無料体験を前提にしたシーケンス ────────────────────
// 付与の正本は `promotionOfferCatalog.js` の `light-30d-free`
// （grantTier: light / durationDays: 30）。**シーケンスは付与を 1 件も作らない**。
const GRANT_CAMPAIGN = Object.freeze({
  ...CAMPAIGN,
  campaignId: 'seq-grant-test',
  requiresActiveGrant: 'light',
  audienceRule: { contracts: [], plans: [], enforce: false },
});

const grantFields = (over = {}) => ({ Email: 'g@example.com', Status: 'active', ...over });
const grantCustomer = (over = {}) => {
  const fields = grantFields(over);
  return { recordId: 'rec-g', fields, marketing: resolveCustomerMarketing({ fields, nowMs: NOW }) };
};
const grantRun = (selected, deliveries = []) => buildSequenceProgress({
  campaign: GRANT_CAMPAIGN, selected, deliveries, brand: BRAND, fromEmail: FROM, nowMs: NOW,
  providerSuppressed: new Set(), softBounced: new Set(),
});

test('【停止】無料付与がまだなら送らない（シーケンスは付与しない）', () => {
  const p = grantRun([grantCustomer()]);
  assert.equal(p.rows[0].stopReason, SEQ_STOP.GRANT_REQUIRED);
  assert.equal(p.summary.due, 0, '付与前に step1 を送ってしまっている');
});

test('無料期間中なら step1 から進む', () => {
  const p = grantRun([grantCustomer({ LightGrantUntil: new Date(NOW + 20 * DAY).toISOString() })]);
  assert.equal(p.rows[0].status, SEQ_STATUS.DUE);
  assert.equal(p.rows[0].nextStep, 1);
});

test('【停止】無料期間が終わったら止まる（「未付与」とは区別する）', () => {
  const expired = grantCustomer({ LightGrantUntil: new Date(NOW - DAY).toISOString() });
  const p = grantRun([expired], []);
  assert.equal(p.rows[0].stopReason, SEQ_STOP.GRANT_EXPIRED);
  assert.notEqual(p.rows[0].stopReason, SEQ_STOP.GRANT_REQUIRED);
});

test('永久無料（Lifetime）でも対象になる', () => {
  const p = grantRun([grantCustomer({ LightGrantLifetime: true })]);
  assert.equal(p.rows[0].status, SEQ_STATUS.DUE);
});

test('取り消した付与では送らない（値が消え RevokedAt が残る）', () => {
  const revoked = grantCustomer({
    LightGrantUntil: null, LightGrantRevokedAt: new Date(NOW - DAY).toISOString(),
  });
  const p = grantRun([revoked]);
  assert.equal(p.rows[0].status, SEQ_STATUS.STOPPED);
});

test('【停止】無料体験中に有料契約が成立したら目的達成として止まる', () => {
  const bought = grantCustomer({
    LightGrantUntil: new Date(NOW + 20 * DAY).toISOString(),
    'プラン': 'Premium', '有効期限': '2027-01-01',
  });
  const p = grantRun([bought], []);
  assert.equal(p.rows[0].stopReason, SEQ_STOP.PURCHASED, '購入が付与より先に評価されていない');
});

test('無料付与を要求しないシーケンスは従来どおり（既存を壊さない）', () => {
  const p = run([customer('a@example.com')], []);
  assert.equal(p.rows[0].status, SEQ_STATUS.DUE);
});
