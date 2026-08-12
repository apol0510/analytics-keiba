/**
 * lightTrialBarrier.test.mjs — 「案内していない付与」を溜めない関所
 *   node --test src/lib/comeback/lightTrialBarrier.test.mjs
 *
 * 重点:
 *   - Step1 が未処理の間は次の付与バッチへ進まない
 *   - 送信できない人が**永久に関所を塞がない**
 *   - 関所は**数えるだけ**（queue も送信もしない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  evaluateStep1Barrier, collectReachedKeys, isAutoGranted, barrierToken,
  AUTOGRANT_SOURCE, BARRIER_RESOLVED,
} from './lightTrialBarrier.js';
import {
  buildTrialGrantPlan, readAutoGrantGates, AUTOGRANT_ENV, AUTOGRANT_ABORT,
} from './lightTrialAutoGrant.js';
import { getCampaign } from '../marketing/campaignCatalog.js';
import { resolveSequenceStep } from '../marketing/campaignSequence.js';
import { computeCampaignDeliveryKey } from '../marketing/campaignSend.js';
import { resolveCustomerMarketing } from '../marketing/customerMarketingAudience.js';
import { jstDateString } from '../marketing/campaignSend.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 20, 3, 0);
const BRAND = 'analytics-keiba';
const FROM = 'noreply@keiba.link';
const CAMPAIGN = getCampaign('light-trial-to-premium-sequence');
const OPEN_ENV = {
  [AUTOGRANT_ENV.FIELDS_READY]: '1',
  [AUTOGRANT_ENV.GRANT_ENABLED]: 'true',
  [AUTOGRANT_ENV.ENABLED]: 'true',
  [AUTOGRANT_ENV.ARMED]: jstDateString(NOW),
};

/** 自動付与で Light 無料期間中になった人 */
function granted(email, over = {}) {
  const fields = {
    Email: email, Status: 'active', Source: 'customer-import:imp-A',
    ComebackGrantSource: AUTOGRANT_SOURCE,
    LightGrantUntil: new Date(NOW + 20 * DAY).toISOString(),
    LightGrantedAt: new Date(NOW - DAY).toISOString(),
    ...over,
  };
  return { recordId: `rec${email.slice(0, 3)}00000000000`, fields, marketing: resolveCustomerMarketing({ fields, nowMs: NOW }) };
}

/** その人へ Step1 が queue / sent された事実 */
function step1Delivery(email, status = 'queued') {
  const key = computeCampaignDeliveryKey({
    campaign: resolveSequenceStep(CAMPAIGN, 1), recipientEmail: email, brand: BRAND, fromEmail: FROM,
  });
  return { fields: { EmailType: 'campaign', DeliveryKey: key, RecipientEmail: email, Status: status } };
}

const run = (records, deliveries = [], providerSuppressed = new Set()) => evaluateStep1Barrier({
  records, campaign: CAMPAIGN, deliveries, providerSuppressed, brand: BRAND, fromEmail: FROM, nowMs: NOW,
});

test('自動付与で配った人だけが関所の対象（手動付与は数えない）', () => {
  const manual = granted('m@example.com', { ComebackGrantSource: 'admin-comeback-grants' });
  const auto = granted('a@example.com');
  assert.equal(isAutoGranted(auto.fields), true);
  assert.equal(isAutoGranted(manual.fields), false);
  const b = run([manual, auto]);
  assert.equal(b.granted, 1);
  assert.equal(b.outstanding, 1);
});

test('【重要】Step1 が未処理なら関所は閉じる', () => {
  const b = run([granted('a@example.com'), granted('b@example.com')]);
  assert.equal(b.outstanding, 2);
  assert.equal(b.nextBatchAllowed, false);
});

test('Step1 が queue / sent になったら片付く', () => {
  const b = run([granted('a@example.com')], [step1Delivery('a@example.com', 'queued')]);
  assert.equal(b.outstanding, 0);
  assert.equal(b.resolved, 1);
  assert.equal(b.byReason[BARRIER_RESOLVED.STEP1_QUEUED], 1);
  assert.equal(b.nextBatchAllowed, true);

  const sent = run([granted('a@example.com')], [step1Delivery('a@example.com', 'sent')]);
  assert.equal(sent.nextBatchAllowed, true);
});

test('【重要】一部でも未処理なら次バッチへ進まない', () => {
  const b = run(
    [granted('a@example.com'), granted('b@example.com'), granted('c@example.com')],
    [step1Delivery('a@example.com'), step1Delivery('b@example.com')],
  );
  assert.equal(b.outstanding, 1);
  assert.equal(b.nextBatchAllowed, false);
});

test('【重要】送信できない人が関所を永久に塞がない', () => {
  // 配信停止
  const unsub = run([granted('u@example.com', { UnsubscribedAnalyticsKeiba: true })]);
  assert.equal(unsub.outstanding, 0);
  assert.equal(unsub.byReason[BARRIER_RESOLVED.NOT_SENDABLE], 1);

  // 配信基盤の suppression（bounce 等）
  const sup = run([granted('s@example.com')], [], new Set(['s@example.com']));
  assert.equal(sup.outstanding, 0);
  assert.equal(sup.byReason[BARRIER_RESOLVED.PROVIDER_SUPPRESSED], 1);

  // 有料契約が成立した
  const paid = run([granted('p@example.com', { 'プラン': 'Premium', '有効期限': '2027-01-01' })]);
  assert.equal(paid.outstanding, 0);
  assert.equal(paid.byReason[BARRIER_RESOLVED.PURCHASED], 1);

  // 無料期間が終わった / 取り消された
  const ended = run([granted('e@example.com', { LightGrantUntil: new Date(NOW - DAY).toISOString() })]);
  assert.equal(ended.outstanding, 0);
  assert.equal(ended.byReason[BARRIER_RESOLVED.GRANT_ENDED], 1);
});

test('取引メール・他キャンペーンの配信行は関所の判定に使わない', () => {
  const other = { fields: { EmailType: 'payment', DeliveryKey: 'x', RecipientEmail: 'a@example.com', Status: 'sent' } };
  assert.equal(collectReachedKeys([other]).size, 0);
  const b = run([granted('a@example.com')], [other]);
  assert.equal(b.outstanding, 1, '別種のメールで片付いたことにしている');
});

// ── 付与計画との接続 ────────────────────────────────────────
const rowFor = (i) => {
  const email = `u${String(i).padStart(5, '0')}@example.com`;
  const fields = { Email: email, Status: 'active', Source: 'customer-import:imp-A' };
  return { recordId: `rec${String(i).padStart(14, '0')}`, fields, marketing: resolveCustomerMarketing({ fields, nowMs: NOW }) };
};

test('【重要】Step1 未処理があると付与計画を作らない（waiting_for_step1）', () => {
  const records = [...Array.from({ length: 150 }, (_, i) => rowFor(i)), granted('a@example.com')];
  const p = buildTrialGrantPlan({
    records, env: OPEN_ENV, nowMs: NOW,
    sequenceCampaign: CAMPAIGN, deliveries: [], providerSuppressed: new Set(), brand: BRAND, fromEmail: FROM,
  });
  assert.equal(p.ok, false);
  assert.equal(p.abort, AUTOGRANT_ABORT.WAITING_FOR_STEP1);
  assert.equal(p.outstandingStep1, 1);
  assert.equal(p.targets, 0, '1 件でも付与しようとしている');
});

test('Step1 が片付いたら次の 100 名を付与できる', () => {
  const records = [...Array.from({ length: 150 }, (_, i) => rowFor(i)), granted('a@example.com')];
  const p = buildTrialGrantPlan({
    records, env: OPEN_ENV, nowMs: NOW,
    sequenceCampaign: CAMPAIGN, deliveries: [step1Delivery('a@example.com')],
    providerSuppressed: new Set(), brand: BRAND, fromEmail: FROM,
  });
  assert.equal(p.ok, true);
  assert.equal(p.targets, 100);
  assert.equal(p.counts.remaining, 50);
});

test('送信対象外が確定していれば関所は開く（永久停止しない）', () => {
  const records = [
    ...Array.from({ length: 120 }, (_, i) => rowFor(i)),
    granted('x@example.com', { UnsubscribedAnalyticsKeiba: true }),
  ];
  const p = buildTrialGrantPlan({
    records, env: OPEN_ENV, nowMs: NOW,
    sequenceCampaign: CAMPAIGN, deliveries: [], providerSuppressed: new Set(), brand: BRAND, fromEmail: FROM,
  });
  assert.equal(p.ok, true, '退会者 1 人で自動付与が止まっている');
});

test('【重要】指紋に関所の状態が反映される', () => {
  const records = [...Array.from({ length: 120 }, (_, i) => rowFor(i)), granted('a@example.com')];
  const base = { records, env: OPEN_ENV, nowMs: NOW, sequenceCampaign: CAMPAIGN, providerSuppressed: new Set(), brand: BRAND, fromEmail: FROM };
  const open = buildTrialGrantPlan({ ...base, deliveries: [step1Delivery('a@example.com')] });
  const wait = buildTrialGrantPlan({ ...base, deliveries: [] });
  assert.notEqual(open.planFingerprint, wait.planFingerprint);
  assert.equal(wait.planFingerprint, '');
  assert.match(barrierToken(open.barrier), /^barrier:open:0$/);
  assert.match(barrierToken(wait.barrier), /^barrier:wait:1$/);
});

test('下見と実計画が同じ関所・同じ指紋を見る', () => {
  const records = [...Array.from({ length: 120 }, (_, i) => rowFor(i)), granted('a@example.com')];
  const args = {
    records, nowMs: NOW, sequenceCampaign: CAMPAIGN,
    deliveries: [step1Delivery('a@example.com')], providerSuppressed: new Set(), brand: BRAND, fromEmail: FROM,
  };
  const preview = buildTrialGrantPlan({ ...args, env: {} });        // ゲート閉（下見）
  const real = buildTrialGrantPlan({ ...args, env: OPEN_ENV });     // ゲート開（実行）
  assert.equal(preview.barrier.outstanding, real.barrier.outstanding);
  assert.equal(preview.barrier.nextBatchAllowed, real.barrier.nextBatchAllowed);
  assert.equal(preview.planFingerprint, real.planFingerprint);
});

test('関所は queue も送信もしない（数えるだけ）', () => {
  const src = readFileSync(new URL('./lightTrialBarrier.js', import.meta.url), 'utf8');
  for (const bad of ['ScheduledEmails', 'buildScheduledEmailFields', 'buildDeliveryRecords', 'fetch(']) {
    assert.equal(src.includes(bad), false, `関所が書き込み側を持っている: ${bad}`);
  }
});