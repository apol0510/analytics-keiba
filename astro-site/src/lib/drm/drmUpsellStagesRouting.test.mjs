/**
 * drmUpsellStagesRouting.test.mjs — 第 2・3 段が**実カタログで反応別に分岐する**
 *   node --test src/lib/drm/drmUpsellStagesRouting.test.mjs
 *
 * 完成条件は「実 campaign で反応に応じて次の訴求が分岐すること」。
 * ⚠️ 合成 campaign（オーバーレイ）を作らない。**実カタログの定義で**通す。
 * ⚠️ 合成データのみ（`example.com`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CAMPAIGNS, getCampaign } from '../marketing/campaignCatalog.js';
import { resolveCustomerMarketing } from '../marketing/customerMarketingAudience.js';
import {
  buildSequenceProgress, indexDeliveries, SEQ_STOP,
} from '../marketing/sequenceProgress.js';
import { computeCampaignDeliveryKey } from '../marketing/campaignSend.js';
import { resolveSequenceStep } from '../marketing/campaignSequence.js';
import { resolvePurchaseStopSignals } from '../marketing/sequencePurchaseStop.js';
import { buildResponseByEmail } from './drmResponseInputs.js';
import { resolveFunnelStage, FUNNEL_STAGE } from './drmFunnel.js';
import { resolveStageEntry } from './drmAutoStart.js';

const BRAND = 'analytics-keiba';
const FROM = 'sender@example.com';
const DAY = 86400_000;
const NOW = Date.UTC(2026, 8, 14);

/** 段ごとの: campaign / 受信者 / 期待する分岐先 */
const CASES = [
  {
    stage: FUNNEL_STAGE.LIGHT_TO_PREMIUM,
    campaignId: 'light-to-premium-sequence',
    email: 'light@example.com',
    fields: {
      'プラン': 'Light', PlanType: 'Monthly', Status: 'active',
      有効期限: new Date(NOW + 60 * DAY).toISOString(),
    },
    openedStep: 4,
    deliveredStep: 3,
    /** 目的達成（この段を卒業する購入） */
    goalFields: {
      'プラン': 'Premium', PlanType: 'Annual', Status: 'active',
      有効期限: new Date(NOW + 300 * DAY).toISOString(),
    },
  },
  {
    stage: FUNNEL_STAGE.PREMIUM_TO_SANRENPUKU,
    campaignId: 'sanrenpuku-upsell-sequence',
    email: 'premium@example.com',
    fields: {
      'プラン': 'Premium', PlanType: 'Annual', Status: 'active',
      有効期限: new Date(NOW + 300 * DAY).toISOString(),
    },
    openedStep: 4,
    deliveredStep: 3,
    goalFields: {
      'プラン': 'Premium', PlanType: 'Annual', Status: 'active', LifetimeSanrenpuku: true,
      有効期限: new Date(NOW + 300 * DAY).toISOString(),
    },
  },
];

function customer(c, over = {}) {
  const fields = { Email: c.email, ...c.fields, ...over };
  return { recordId: `rec-${c.email}`, fields, marketing: resolveCustomerMarketing({ fields, nowMs: NOW }) };
}

const keyFor = (campaign, step, email) => computeCampaignDeliveryKey({
  campaign: resolveSequenceStep(campaign, step), recipientEmail: email, brand: BRAND, fromEmail: FROM,
});

function sent(campaign, upTo, email) {
  const rows = [];
  for (let i = 1; i <= upTo; i += 1) {
    rows.push({
      fields: {
        DeliveryKey: keyFor(campaign, i, email), EmailType: 'campaign', Status: 'sent',
        SentAt: new Date(NOW - (upTo - i + 1) * 30 * DAY).toISOString(),
      },
    });
  }
  return rows;
}

function events(campaign, upTo, email, opened) {
  const m = new Map();
  for (let i = 1; i <= upTo; i += 1) {
    m.set(keyFor(campaign, i, email), {
      deliveredAtMs: NOW - (upTo - i + 1) * 30 * DAY + 60_000,
      firstOpenAtMs: opened ? NOW - (upTo - i + 1) * 30 * DAY + 120_000 : null,
      lastOpenAtMs: null, openCount: opened ? 1 : 0,
    });
  }
  return m;
}

function row({ c, upTo, opened, cust }) {
  const campaign = getCampaign(c.campaignId, { includeDisabled: true });
  const deliveries = sent(campaign, upTo, c.email);
  const deliveredIndex = indexDeliveries(deliveries);
  const who = cust || customer(c);
  const resp = opened === null ? { ok: false, byEmail: null } : buildResponseByEmail({
    campaign, recipients: [{ email: c.email, marketing: who.marketing }],
    deliveredIndex, eventByKey: events(campaign, upTo, c.email, opened),
    brand: BRAND, fromEmail: FROM, providerSuppressed: new Set(), softBounced: new Set(),
  });
  return buildSequenceProgress({
    campaign, selected: [who], deliveries,
    brand: BRAND, fromEmail: FROM, nowMs: NOW,
    providerSuppressed: new Set(), softBounced: new Set(),
    responseByEmail: resp.ok ? resp.byEmail : undefined,
  }).rows[0];
}

for (const c of CASES) {
  test(`【重要】${c.campaignId}: 開封層と未開封層で行き先が違う`, () => {
    const opened = row({ c, upTo: 2, opened: true });
    const delivered = row({ c, upTo: 2, opened: false });
    assert.equal(opened.nextStep, c.openedStep, '開封層の行き先が違う');
    assert.equal(delivered.nextStep, c.deliveredStep, '未開封層の行き先が違う');
    assert.notEqual(opened.nextStep, delivered.nextStep,
      '反応が違うのに同じ 1 通が行く＝分岐していない');
    assert.equal(opened.routedBy, `opened:${c.openedStep}`);
    assert.equal(delivered.routedBy, `delivered:${c.deliveredStep}`);
  });

  test(`【安全】${c.campaignId}: 反応が読めなければ線形`, () => {
    const r = row({ c, upTo: 2, opened: null });
    assert.equal(r.nextStep, 3, '未計測なのに分岐している');
    assert.equal(r.routedBy, null);
  });

  test(`【最重要】${c.campaignId}: 宛先の資格そのものでは止まらない（2 通目が出る）`, () => {
    // 2026-09-08 の障害: 宛先条件と停止条件が一致し、1 通目の直後に全員が恒久停止した
    const r = row({ c, upTo: 1, opened: null });
    assert.equal(r.stopReason, null, `宛先条件で止まっている（${r.stopReason}）`);
    assert.equal(r.nextStep, 2);
  });

  test(`【最重要】${c.campaignId}: 目的の商品を買ったら止まる`, () => {
    const bought = customer(c, c.goalFields);
    const r = row({ c, upTo: 2, opened: true, cust: bought });
    assert.equal(r.nextStep, null, '購入後も案内が続いている');
    assert.equal(r.stopReason, SEQ_STOP.PURCHASED);
  });

  test(`【最重要】${c.campaignId}: 配信停止には送らない`, () => {
    const off = customer(c, {
      MarketingUnsubscribedAnalyticsKeiba: true, UnsubscribedAnalyticsKeiba: true,
    });
    const r = row({ c, upTo: 2, opened: true, cust: off });
    assert.equal(r.nextStep, null);
    assert.equal(r.stopReason, SEQ_STOP.NOT_SENDABLE);
  });

  test(`【定義】${c.campaignId}: 入口のプランで止めない / 目的で止める`, () => {
    const campaign = getCampaign(c.campaignId, { includeDisabled: true });
    const signals = resolvePurchaseStopSignals(campaign);
    const plan = String(c.fields['プラン']).toLowerCase();
    assert.equal(signals.includes(plan), false,
      `宛先が ${plan} なのに ${plan} で停止する（2 通目が永久に出ない）`);
  });
}

// ── 段の遷移 ──────────────────────────────────────────────────
test('【重要】段が進むと次段の育成へ繋がる（Light → Premium → 三連複）', () => {
  const light = customer(CASES[0]);
  const premium = customer(CASES[1]);
  assert.equal(resolveFunnelStage(light.marketing), FUNNEL_STAGE.LIGHT_TO_PREMIUM);
  assert.equal(resolveStageEntry({ marketing: light.marketing, campaigns: CAMPAIGNS, nowMs: NOW }).campaignId,
    'light-to-premium-sequence');

  assert.equal(resolveFunnelStage(premium.marketing), FUNNEL_STAGE.PREMIUM_TO_SANRENPUKU);
  assert.equal(resolveStageEntry({ marketing: premium.marketing, campaigns: CAMPAIGNS, nowMs: NOW }).campaignId,
    'sanrenpuku-upsell-sequence');
});

test('【最重要】三連複まで買った人には次の入口を作らない（終点）', () => {
  const done = customer(CASES[1], CASES[1].goalFields);
  const r = resolveStageEntry({ marketing: done.marketing, campaigns: CAMPAIGNS, nowMs: NOW });
  assert.equal(r.stage, FUNNEL_STAGE.COMPLETED);
  assert.equal(r.campaignId, null);
  assert.equal(r.reason, 'funnel_completed');
});
