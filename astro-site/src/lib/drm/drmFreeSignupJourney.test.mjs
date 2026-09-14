/**
 * drmFreeSignupJourney.test.mjs — **無料登録 → 育成 → 反応別分岐 → 購入で停止**の通し
 *   node --test src/lib/drm/drmFreeSignupJourney.test.mjs
 *
 * 実カタログの `free-signup-onboarding` と、実際の進行・反応・routing を通す。
 * ⚠️ **合成 campaign（オーバーレイ）を作らない。** 作ったらこのテストの意味が無い。
 * ⚠️ 合成データのみ（`example.com`）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CAMPAIGNS, getCampaign } from '../marketing/campaignCatalog.js';
import { resolveCustomerMarketing } from '../marketing/customerMarketingAudience.js';
import {
  buildSequenceProgress, indexDeliveries, SEQ_STATUS, SEQ_STOP,
} from '../marketing/sequenceProgress.js';
import { computeCampaignDeliveryKey } from '../marketing/campaignSend.js';
import { resolveSequenceStep } from '../marketing/campaignSequence.js';
import { planSequenceTick, readSequenceGates } from '../marketing/sequenceAutomation.js';
import { buildResponseByEmail } from './drmResponseInputs.js';
import { planAutoStartEntries } from './drmAutoStart.js';
import { FUNNEL_STAGE, resolveFunnelStage } from './drmFunnel.js';

const BRAND = 'analytics-keiba';
const FROM = 'sender@example.com';
const DAY = 86400_000;
const NOW = Date.UTC(2026, 8, 14);
const EMAIL = 'newbie@example.com';
const C = getCampaign('free-signup-onboarding', { includeDisabled: true });

function member(over = {}, daysAgo = 1) {
  const fields = { Email: EMAIL, 'プラン': 'Free', ...over };
  return {
    recordId: 'rec1', fields, createdTimeMs: NOW - daysAgo * DAY,
    marketing: resolveCustomerMarketing({ fields, nowMs: NOW }),
  };
}

const keyFor = (step) => computeCampaignDeliveryKey({
  campaign: resolveSequenceStep(C, step), recipientEmail: EMAIL, brand: BRAND, fromEmail: FROM,
});

/** step 1..n を送信済みにする（間隔は実定義より十分に空ける） */
function sent(upTo) {
  const rows = [];
  for (let i = 1; i <= upTo; i += 1) {
    rows.push({
      fields: {
        DeliveryKey: keyFor(i), EmailType: 'campaign', Status: 'sent',
        SentAt: new Date(NOW - (upTo - i + 1) * 30 * DAY).toISOString(),
      },
    });
  }
  return rows;
}

function events(upTo, { opened }) {
  const m = new Map();
  for (let i = 1; i <= upTo; i += 1) {
    m.set(keyFor(i), {
      deliveredAtMs: NOW - (upTo - i + 1) * 30 * DAY + 60_000,
      firstOpenAtMs: opened ? NOW - (upTo - i + 1) * 30 * DAY + 120_000 : null,
      lastOpenAtMs: null, openCount: opened ? 1 : 0,
    });
  }
  return m;
}

function progressOf({ cust, upTo, eventByKey }) {
  const deliveries = sent(upTo);
  const deliveredIndex = indexDeliveries(deliveries);
  const resp = eventByKey ? buildResponseByEmail({
    campaign: C, recipients: [{ email: EMAIL, marketing: cust.marketing }],
    deliveredIndex, eventByKey, brand: BRAND, fromEmail: FROM,
    providerSuppressed: new Set(), softBounced: new Set(),
  }) : { ok: false, byEmail: null };
  return buildSequenceProgress({
    campaign: C, selected: [cust], deliveries,
    brand: BRAND, fromEmail: FROM, nowMs: NOW,
    providerSuppressed: new Set(), softBounced: new Set(),
    responseByEmail: resp.ok ? resp.byEmail : undefined,
  });
}

// ══════════════════════════════════════════════════════════════════
//  ① 入口 — 無料登録から自動で始まる
// ══════════════════════════════════════════════════════════════════

test('【重要】無料登録した人が入口（step1）の対象になる', () => {
  const entry = planAutoStartEntries({
    campaign: C, candidates: [member()], deliveredIndex: new Map(),
    brand: BRAND, fromEmail: FROM, nowMs: NOW, expectedStage: FUNNEL_STAGE.FREE_TO_PAID,
  });
  assert.deepEqual(entry.recordIds, ['rec1']);

  // その人を進行へ渡すと、次は step1 で「いま送れる」
  const p = progressOf({ cust: member(), upTo: 0, eventByKey: null });
  assert.equal(p.rows[0].nextStep, 1);
  assert.equal(p.rows[0].status, SEQ_STATUS.DUE);
});

test('【重要】入口が開いているときだけ step1 を自動で撃てる', () => {
  const p = progressOf({ cust: member(), upTo: 0, eventByKey: null });
  const gates = readSequenceGates({
    MARKETING_SEQUENCE_SCHEDULER_ENABLED: 'true',
    MARKETING_SEQUENCE_ARMED: new Date(NOW).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }),
    MARKETING_CAMPAIGN_ENABLED: 'true',
    MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true',
  }, NOW);
  assert.equal(gates.allOpen, true, 'ゲートの前提が崩れている');

  // 既定（入口を開けない）＝ step1 は撃たない
  assert.equal(planSequenceTick({ progress: p, gates }).ok, false);
  // 入口を開けたときだけ step1
  const open = planSequenceTick({ progress: p, gates, allowFirstStep: true });
  assert.equal(open.ok, true);
  assert.equal(open.step, 1);
});

// ══════════════════════════════════════════════════════════════════
//  ② 反応で次の訴求が変わる
// ══════════════════════════════════════════════════════════════════

test('【重要】開封している人はプランの違い（step5）へ進む', () => {
  const r = progressOf({ cust: member(), upTo: 2, eventByKey: events(2, { opened: true }) }).rows[0];
  assert.equal(r.nextStep, 5, '開封層の行き先が線形のまま');
  assert.equal(r.routedBy, 'opened:5');
});

test('【重要】届いても開かない人は実績（step3）へ進む', () => {
  const r = progressOf({ cust: member(), upTo: 2, eventByKey: events(2, { opened: false }) }).rows[0];
  assert.equal(r.nextStep, 3);
  assert.equal(r.routedBy, 'delivered:3');
});

test('【重要】同じ配信実績でも反応が違えば行き先が違う', () => {
  const a = progressOf({ cust: member(), upTo: 2, eventByKey: events(2, { opened: true }) }).rows[0];
  const b = progressOf({ cust: member(), upTo: 2, eventByKey: events(2, { opened: false }) }).rows[0];
  assert.notEqual(a.nextStep, b.nextStep, '反応が違うのに同じ 1 通が行く');
});

test('【安全】反応が読めなければ線形（推測で分岐しない）', () => {
  const r = progressOf({ cust: member(), upTo: 2, eventByKey: null }).rows[0];
  assert.equal(r.nextStep, 3 - 0, '線形は次 step3');
  assert.equal(r.routedBy, null);
});

// ══════════════════════════════════════════════════════════════════
//  ③ 停止が最優先（purchase / suppression）
// ══════════════════════════════════════════════════════════════════

test('【最重要】Light を買ったら入口の育成は止まる', () => {
  const cust = member({
    'プラン': 'Light', PlanType: 'Monthly', Status: 'active',
    有効期限: new Date(NOW + 60 * DAY).toISOString(),
  });
  const r = progressOf({ cust, upTo: 2, eventByKey: events(2, { opened: true }) }).rows[0];
  assert.equal(r.nextStep, null);
  assert.equal(r.stopReason, SEQ_STOP.PURCHASED);
});

test('【最重要】Premium を買ったら入口の育成は止まり、段は三連複へ進む', () => {
  const cust = member({
    'プラン': 'Premium', PlanType: 'Annual', Status: 'active',
    有効期限: new Date(NOW + 200 * DAY).toISOString(),
  });
  const r = progressOf({ cust, upTo: 2, eventByKey: events(2, { opened: true }) }).rows[0];
  assert.equal(r.stopReason, SEQ_STOP.PURCHASED, '購入しても入口の案内が続いている');

  // 段は次へ進んでいる（次段の接続は resolveStageEntry が担当）
  assert.equal(resolveFunnelStage(cust.marketing), FUNNEL_STAGE.PREMIUM_TO_SANRENPUKU);
});

test('【最重要】三連複まで買った人には入口の案内を送らない', () => {
  const cust = member({
    'プラン': 'Premium', PlanType: 'Annual', Status: 'active', LifetimeSanrenpuku: true,
    有効期限: new Date(NOW + 200 * DAY).toISOString(),
  });
  const r = progressOf({ cust, upTo: 2, eventByKey: events(2, { opened: true }) }).rows[0];
  assert.equal(r.nextStep, null);
  assert.equal(r.stopReason, SEQ_STOP.PURCHASED);
});

test('【最重要】配信停止には送らない（反応があっても）', () => {
  const cust = member({
    MarketingUnsubscribedAnalyticsKeiba: true, UnsubscribedAnalyticsKeiba: true,
  });
  const r = progressOf({ cust, upTo: 2, eventByKey: events(2, { opened: true }) }).rows[0];
  assert.equal(r.nextStep, null);
  assert.equal(r.stopReason, SEQ_STOP.NOT_SENDABLE);
});

test('【安全】有料会員は対象条件から外れる（入口の案内を受け取らない）', () => {
  const cust = member({
    'プラン': 'Premium', PlanType: 'Annual', Status: 'active',
    有効期限: new Date(NOW + 200 * DAY).toISOString(),
  });
  const entry = planAutoStartEntries({
    campaign: C, candidates: [cust], deliveredIndex: new Map(),
    brand: BRAND, fromEmail: FROM, nowMs: NOW, expectedStage: FUNNEL_STAGE.FREE_TO_PAID,
  });
  assert.deepEqual(entry.recordIds, []);
});

test('【最重要】同じ人へ同じ step を二度送らない（既送は選ばれない）', () => {
  // step5 まで送っている状態で開封あり → route の step5 は既送なので線形 6 へ
  const r = progressOf({ cust: member(), upTo: 5, eventByKey: events(5, { opened: true }) }).rows[0];
  assert.equal(r.nextStep, 6);
  assert.ok(!r.sentSteps.includes(r.nextStep));
});

test('【安全】全部送り終えたら完了（上限を超えない）', () => {
  const r = progressOf({ cust: member(), upTo: 6, eventByKey: events(6, { opened: true }) }).rows[0];
  assert.equal(r.status, SEQ_STATUS.COMPLETED);
  assert.equal(r.stopReason, SEQ_STOP.MAX_SENDS_REACHED);
});
