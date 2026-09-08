/**
 * sequencePurchaseStop.test.mjs — 「もう買った人には送らない」の単一源
 *   node --test src/lib/marketing/sequencePurchaseStop.test.mjs
 *
 * 重点（2026-09-08 の障害の再発防止）:
 *   - 宣言が無い campaign は**従来どおり**（Light / Premium が有効なら止める）
 *   - 宣言した campaign は**その権利を買ったときだけ**止まる
 *   - **宛先条件と停止条件がぶつかっている campaign をカタログに置けない**
 *     （置くと 1 通目の直後に全員が恒久停止し、2 通目が無言で出なくなる）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PURCHASE_SIGNAL, DEFAULT_PURCHASE_STOP_SIGNALS,
  resolvePurchaseStopSignals, describeHeldSignals, hasPurchasedForCampaign,
  describeAudienceRequiredSignals, findPurchaseStopAudienceConflicts,
} from './sequencePurchaseStop.js';
import { CAMPAIGNS } from './campaignCatalog.js';
import { buildSequenceProgress, SEQ_STATUS, SEQ_STOP } from './sequenceProgress.js';
import { selectNextDueStep } from './sequenceProgress.js';
import { resolveSequenceStep } from './campaignSequence.js';
import { computeCampaignDeliveryKey } from './campaignSend.js';
import { resolveCustomerMarketing, MK_CONTRACT, MK_PLAN } from './customerMarketingAudience.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 8, 1, 3, 0);
const BRAND = 'analytics-keiba';
const FROM = 'noreply@keiba.link';

const mkStep = (n, delayDays) => ({
  stepNumber: n, delayDays, subject: `件名${n}`, preheader: `p${n}`, body: `本文${n}`,
  ctaLabel: `CTA${n}`, ctaUrl: 'https://analytics.keiba.link/',
  benefitType: 'discount', benefitDescription: '割引価格でご案内します',
});

/** 実在の `campaign-discount-light` と同じ宣言（宛先 = Light 有効な方） */
const UPSELL = Object.freeze({
  campaignId: 'upsell-test', version: 1, name: 'アップセル',
  subject: '既定', body: '既定本文', ctaLabel: 'CTA', ctaUrl: 'https://analytics.keiba.link/',
  benefitType: 'discount', benefitDescription: '割引価格でご案内します',
  audienceRule: {
    contracts: [MK_CONTRACT.ACTIVE, MK_CONTRACT.EXPIRING_SOON],
    plans: [MK_PLAN.LIGHT],
    enforce: true,
  },
  enabled: true,
  sequence: { maxSends: 2, steps: [mkStep(1, 0), mkStep(2, 6)] },
  stopOnPurchase: { signals: [PURCHASE_SIGNAL.PREMIUM, PURCHASE_SIGNAL.SANRENPUKU] },
});

/** 宣言だけを外した同じ campaign（旧実装の再現） */
const UPSELL_OLD = Object.freeze({ ...UPSELL, campaignId: 'upsell-old', stopOnPurchase: undefined });

function lightMember(email) {
  const fields = {
    Email: email, Status: 'active', 'プラン': 'Light',
    '有効期限': new Date(NOW + 90 * DAY).toISOString().slice(0, 10),
  };
  return { recordId: `rec-${email}`, fields, marketing: resolveCustomerMarketing({ fields, nowMs: NOW }) };
}
const delivered = (campaign, email, n, atMs) => ({
  fields: {
    EmailType: 'campaign',
    DeliveryKey: computeCampaignDeliveryKey({
      campaign: resolveSequenceStep(campaign, n), recipientEmail: email, brand: BRAND, fromEmail: FROM,
    }),
    RecipientEmail: email, Status: 'sent', SentAt: new Date(atMs).toISOString(),
  },
});
const progressOf = (campaign, selected, deliveries) => buildSequenceProgress({
  campaign, selected, deliveries, brand: BRAND, fromEmail: FROM, nowMs: NOW,
  providerSuppressed: new Set(), softBounced: new Set(),
});

// ── 宣言の解釈 ──────────────────────────────────────────────
test('宣言が無ければ従来どおり（Light / Premium が有効なら止める）', () => {
  assert.deepEqual(resolvePurchaseStopSignals({}), [...DEFAULT_PURCHASE_STOP_SIGNALS]);
  assert.equal(hasPurchasedForCampaign({ campaign: {}, marketing: { lightActive: true } }), true);
  assert.equal(hasPurchasedForCampaign({ campaign: {}, marketing: { premiumActive: true } }), true);
  assert.equal(hasPurchasedForCampaign({ campaign: {}, marketing: { hasSanrenpuku: true } }), false);
  assert.equal(hasPurchasedForCampaign({ campaign: {}, marketing: {} }), false);
});

test('宣言した権利だけで止まる', () => {
  const c = { stopOnPurchase: { signals: ['premium'] } };
  assert.deepEqual(resolvePurchaseStopSignals(c), ['premium']);
  assert.equal(hasPurchasedForCampaign({ campaign: c, marketing: { lightActive: true } }), false);
  assert.equal(hasPurchasedForCampaign({ campaign: c, marketing: { premiumActive: true } }), true);
});

test('`false` は「購入では止めない」/ 壊れた宣言は既定へ倒す（fail closed）', () => {
  assert.deepEqual(resolvePurchaseStopSignals({ stopOnPurchase: false }), []);
  assert.equal(
    hasPurchasedForCampaign({ campaign: { stopOnPurchase: false }, marketing: { premiumActive: true } }),
    false,
  );
  for (const broken of ['premium', 42, {}, { signals: 'premium' }]) {
    assert.deepEqual(
      resolvePurchaseStopSignals({ stopOnPurchase: broken }), [...DEFAULT_PURCHASE_STOP_SIGNALS],
      `壊れた宣言 ${JSON.stringify(broken)} で「止めない」に倒れている`,
    );
  }
  // 未知の signal は捨てる（勝手に増やさない）
  assert.deepEqual(resolvePurchaseStopSignals({ stopOnPurchase: { signals: ['premium', 'nope'] } }), ['premium']);
});

test('持っている権利の読み取り', () => {
  assert.deepEqual(describeHeldSignals({ lightActive: true }), ['light']);
  assert.deepEqual(describeHeldSignals({ premiumActive: true, hasSanrenpuku: true }), ['premium', 'sanrenpuku']);
  assert.deepEqual(describeHeldSignals(null), []);
});

// ── 実際の進行（これが 8/31 に出なかった 2 通目）────────────────
test('【再現】宣言が無いと Light 会員向けアップセルは 1 通目の直後に恒久停止する', () => {
  const email = 'light@example.com';
  const p = progressOf(UPSELL_OLD, [lightMember(email)], [delivered(UPSELL_OLD, email, 1, NOW - 7 * DAY)]);
  assert.equal(p.rows[0].status, SEQ_STATUS.STOPPED);
  assert.equal(p.rows[0].stopReason, SEQ_STOP.PURCHASED, '旧実装の再現になっていない');
  assert.equal(selectNextDueStep(p).step, null, '2 通目の対象が居ないこと（障害の再現）');
});

test('【修正】宣言すれば 2 通目が期日どおり due になる', () => {
  const email = 'light@example.com';
  const p = progressOf(UPSELL, [lightMember(email)], [delivered(UPSELL, email, 1, NOW - 7 * DAY)]);
  assert.equal(p.rows[0].stopReason, null, `止まっている: ${p.rows[0].stopReason}`);
  assert.equal(p.rows[0].status, SEQ_STATUS.DUE);
  assert.equal(p.rows[0].nextStep, 2);
  assert.equal(selectNextDueStep(p).step, 2);
});

test('【修正】上位商品を買ったら止まる（止める力は落ちていない）', () => {
  const email = 'bought@example.com';
  const fields = {
    Email: email, Status: 'active', 'プラン': 'Premium',
    '有効期限': new Date(NOW + 90 * DAY).toISOString().slice(0, 10),
  };
  const bought = {
    recordId: `rec-${email}`, fields, marketing: resolveCustomerMarketing({ fields, nowMs: NOW }),
  };
  const p = progressOf(UPSELL, [bought], [delivered(UPSELL, email, 1, NOW - 7 * DAY)]);
  assert.equal(p.rows[0].status, SEQ_STATUS.STOPPED);
  assert.equal(p.rows[0].stopReason, SEQ_STOP.PURCHASED);
});

// ── 宛先条件との衝突（カタログ全体の不変条件）──────────────────
test('宛先が要求している権利を読み取れる', () => {
  assert.deepEqual(describeAudienceRequiredSignals(UPSELL), ['light']);
  assert.deepEqual(
    describeAudienceRequiredSignals({
      audienceRule: { contracts: [MK_CONTRACT.NONE, MK_CONTRACT.EXPIRED], plans: [MK_PLAN.FREE] },
    }),
    [], '無料・期限切れ向けは権利を要求しない',
  );
});

test('【検知】宛先条件と停止条件がぶつかっていれば衝突として出る', () => {
  const conflicts = findPurchaseStopAudienceConflicts(UPSELL_OLD);
  assert.equal(conflicts.length, 1, '旧宣言の衝突を検知できていない');
  assert.equal(conflicts[0].signal, 'light');
  assert.deepEqual(findPurchaseStopAudienceConflicts(UPSELL), [], '修正後に衝突が残っている');
});

test('【不変条件】カタログの連続配信に「宛先＝停止条件」の campaign を置かない', () => {
  const conflicts = CAMPAIGNS.flatMap((c) => findPurchaseStopAudienceConflicts(c));
  assert.deepEqual(
    conflicts, [],
    `1 通目の直後に全員が停止する campaign がある: ${JSON.stringify(conflicts)}`,
  );
});
