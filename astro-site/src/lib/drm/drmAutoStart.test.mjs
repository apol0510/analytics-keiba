/**
 * drmAutoStart.test.mjs — **入口の自動開始**と**次段への接続**
 *   node --test src/lib/drm/drmAutoStart.test.mjs
 *
 * ⚠️ 合成データのみ（`example.com`）。実顧客・実 Redis・実 Airtable は使わない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CAMPAIGNS, getCampaign } from '../marketing/campaignCatalog.js';
import { resolveCustomerMarketing } from '../marketing/customerMarketingAudience.js';
import { indexDeliveries } from '../marketing/sequenceProgress.js';
import { computeCampaignDeliveryKey } from '../marketing/campaignSend.js';
import { resolveSequenceStep, resolveAutoStart } from '../marketing/campaignSequence.js';
import {
  readAutoStartGate, canAutoStart, hasStarted, planAutoStartEntries,
  resolveStageEntry, AUTOSTART_SKIP, AUTOSTART_ABORT, AUTOSTART_ENV,
} from './drmAutoStart.js';
import { FUNNEL_STAGE } from './drmFunnel.js';

const BRAND = 'analytics-keiba';
const FROM = 'sender@example.com';
const DAY = 86400_000;
const NOW = Date.UTC(2026, 8, 14);
const ENTRY = getCampaign('free-signup-onboarding', { includeDisabled: true });

function freeMember(over = {}, { recordId = 'rec1', daysAgo = 1 } = {}) {
  const fields = { Email: `${recordId}@example.com`, 'プラン': 'Free', ...over };
  return {
    recordId,
    fields,
    createdTimeMs: NOW - daysAgo * DAY,
    marketing: resolveCustomerMarketing({ fields, nowMs: NOW }),
  };
}

const run = (candidates, deliveries = []) => planAutoStartEntries({
  campaign: ENTRY, candidates, deliveredIndex: indexDeliveries(deliveries),
  brand: BRAND, fromEmail: FROM, nowMs: NOW, expectedStage: FUNNEL_STAGE.FREE_TO_PAID,
});

// ══════════════════════════════════════════════════════════════════
//  ① ゲート（既定は閉）
// ══════════════════════════════════════════════════════════════════

test('【安全】入口のゲートは既定で閉じている', () => {
  assert.equal(readAutoStartGate({}).open, false);
  assert.equal(readAutoStartGate({ [AUTOSTART_ENV]: 'false' }).open, false);
  assert.equal(readAutoStartGate({ [AUTOSTART_ENV]: '1' }).open, false, '"true" 以外で開いている');
  assert.equal(readAutoStartGate({ [AUTOSTART_ENV]: 'true' }).open, true);
  assert.deepEqual(readAutoStartGate({}).missing, [AUTOSTART_ENV]);
});

test('【安全】宣言の無い campaign では入口を開けない', () => {
  const plain = getCampaign('light-trial-post-expiry-sequence', { includeDisabled: true });
  assert.equal(resolveAutoStart(plain), null);
  assert.equal(canAutoStart(plain).ok, false);
  assert.equal(canAutoStart(plain).reason, AUTOSTART_ABORT.NO_AUTOSTART);
});

test('【配線】入口の campaign は宣言を持ち、使用可能', () => {
  const gate = canAutoStart(ENTRY);
  assert.equal(gate.ok, true, canAutoStart(ENTRY).reason || '');
  assert.equal(gate.autoStart.kind, 'free_signup');
  assert.ok(gate.autoStart.withinDays >= 1);
  assert.ok(gate.autoStart.maxPerTick >= 1);
});

// ══════════════════════════════════════════════════════════════════
//  ② 誰を入れるか（停止が最優先・推測しない）
// ══════════════════════════════════════════════════════════════════

test('【重要】新規の無料会員は入口に入る', () => {
  const r = run([freeMember()]);
  assert.equal(r.ok, true);
  assert.equal(r.step, 1);
  assert.deepEqual(r.recordIds, ['rec1']);
});

test('【最重要】購入済みは入口に入らない（販促を始めない）', () => {
  const paid = freeMember({
    'プラン': 'Premium', PlanType: 'Annual', Status: 'active',
    有効期限: new Date(NOW + 200 * DAY).toISOString(),
  });
  const r = run([paid]);
  assert.deepEqual(r.recordIds, []);
  // 有料は対象条件からも外れる。**どちらの理由でも入らない**ことが要件
  assert.ok(
    (r.skipped[AUTOSTART_SKIP.PURCHASED] || 0) + (r.skipped[AUTOSTART_SKIP.AUDIENCE_MISMATCH] || 0)
      + (r.skipped[AUTOSTART_SKIP.STAGE_MISMATCH] || 0) > 0,
    '購入済みが理由なく素通りしている',
  );
});

test('【最重要】配信停止・退会には入口を開けない', () => {
  const off = freeMember({
    MarketingUnsubscribedAnalyticsKeiba: true, UnsubscribedAnalyticsKeiba: true,
  });
  const r = run([off]);
  assert.deepEqual(r.recordIds, []);
  assert.equal(r.skipped[AUTOSTART_SKIP.NOT_SENDABLE], 1);
});

test('【安全】登録から時間が経った人へ遡って撃たない', () => {
  const old = freeMember({}, { recordId: 'recOld', daysAgo: 90 });
  const r = run([old]);
  assert.deepEqual(r.recordIds, []);
  assert.equal(r.skipped[AUTOSTART_SKIP.OUTSIDE_WINDOW], 1);
});

test('【安全】登録時刻が読めない人は入れない（推測しない）', () => {
  const c = freeMember();
  c.createdTimeMs = null;
  const r = run([c]);
  assert.deepEqual(r.recordIds, []);
  assert.equal(r.skipped[AUTOSTART_SKIP.NO_REGISTRATION_TIME], 1);
});

test('【最重要】すでに受け取っている人を二重に入口へ入れない', () => {
  const c = freeMember();
  const key = computeCampaignDeliveryKey({
    campaign: resolveSequenceStep(ENTRY, 1), recipientEmail: c.marketing.email,
    brand: BRAND, fromEmail: FROM,
  });
  const deliveries = [{
    fields: {
      DeliveryKey: key, EmailType: 'campaign', Status: 'sent',
      SentAt: new Date(NOW - DAY).toISOString(),
    },
  }];
  assert.equal(hasStarted({
    campaign: ENTRY, email: c.marketing.email,
    deliveredIndex: indexDeliveries(deliveries), brand: BRAND, fromEmail: FROM,
  }), true);
  const r = run([c], deliveries);
  assert.deepEqual(r.recordIds, []);
  assert.equal(r.skipped[AUTOSTART_SKIP.ALREADY_STARTED], 1);
});

test('【安全】段が違う人は入れない', () => {
  const light = freeMember({
    'プラン': 'Light', PlanType: 'Monthly', Status: 'active',
    有効期限: new Date(NOW + 60 * DAY).toISOString(),
  }, { recordId: 'recLight' });
  const r = run([light]);
  assert.deepEqual(r.recordIds, []);
});

test('【安全】1 回の上限を超えたら次回へ回す（黙って捨てない）', () => {
  const max = resolveAutoStart(ENTRY).maxPerTick;
  const many = Array.from({ length: max + 5 }, (_, i) => freeMember({}, { recordId: `rec${String(i).padStart(3, '0')}` }));
  const r = run(many);
  assert.equal(r.recordIds.length, max);
  assert.equal(r.capped, true);
  assert.equal(r.carriedOver, 5);
});

test('【安全】並びは決定的（実行ごとに対象が入れ替わらない）', () => {
  const people = ['recC', 'recA', 'recB'].map((id) => freeMember({}, { recordId: id }));
  assert.deepEqual(run(people).recordIds, ['recA', 'recB', 'recC']);
  assert.deepEqual(run([...people].reverse()).recordIds, ['recA', 'recB', 'recC']);
});

// ══════════════════════════════════════════════════════════════════
//  ③ 次段への接続
// ══════════════════════════════════════════════════════════════════

test('【重要】無料会員は第 1 段の育成 campaign へ繋がる', () => {
  const r = resolveStageEntry({ marketing: freeMember().marketing, campaigns: CAMPAIGNS, nowMs: NOW });
  assert.equal(r.stage, FUNNEL_STAGE.FREE_TO_PAID);
  assert.equal(r.campaignId, 'free-signup-onboarding');
  assert.equal(r.reason, null);
});

test('【重要】Premium 会員は三連複の段として解決される（段は進む）', () => {
  const mk = resolveCustomerMarketing({
    fields: {
      Email: 'p@example.com', 'プラン': 'Premium', PlanType: 'Annual', Status: 'active',
      有効期限: new Date(NOW + 200 * DAY).toISOString(),
    },
    nowMs: NOW,
  });
  const r = resolveStageEntry({ marketing: mk, campaigns: CAMPAIGNS, nowMs: NOW });
  assert.equal(r.stage, FUNNEL_STAGE.PREMIUM_TO_SANRENPUKU, '段が進んでいない');
  assert.equal(r.campaignId, 'sanrenpuku-upsell-sequence', '次段の育成へ繋がっていない');
  assert.equal(r.reason, null);
  // ⚠️ 後段は**段の遷移で入る**。自動で撃つ宣言は持たない（入口の段だけ）
  assert.equal(r.autoStart, false, '後段に自動開始を勝手に足している');
  // オファー（期間限定・単発）は育成とは別に持ち回る
  assert.ok(r.offerCampaignIds.includes('campaign-discount-premium'));
});

test('【最重要】三連複まで買った人には入口を作らない（終点）', () => {
  const mk = resolveCustomerMarketing({
    fields: {
      Email: 's@example.com', 'プラン': 'Premium', PlanType: 'Annual', Status: 'active',
      LifetimeSanrenpuku: true, 有効期限: new Date(NOW + 200 * DAY).toISOString(),
    },
    nowMs: NOW,
  });
  const r = resolveStageEntry({ marketing: mk, campaigns: CAMPAIGNS, nowMs: NOW });
  assert.equal(r.stage, FUNNEL_STAGE.COMPLETED);
  assert.equal(r.campaignId, null);
  assert.equal(r.reason, 'funnel_completed');
});

test('【安全】段が判定できない人に入口を作らない', () => {
  const r = resolveStageEntry({ marketing: { plan: 'premium', contract: 'unknown' }, campaigns: CAMPAIGNS, nowMs: NOW });
  assert.equal(r.campaignId, null);
  assert.equal(r.reason, 'stage_unknown');
});
