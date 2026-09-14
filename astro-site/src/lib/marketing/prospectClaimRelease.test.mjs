/**
 * prospectClaimRelease.test.mjs — 「送っていないのに予約だけ焼けた」人を安全に救う
 *   node --test src/lib/marketing/prospectClaimRelease.test.mjs
 *
 * 重点:
 *   - **step1 は絶対に剥がさない**（実送信済み。剥がすと再送になる）
 *   - **1 通でも送信実績があれば剥がさない**（fail closed）
 *   - 送信実績を確かめられなければ剥がさない
 *   - 予約集合に入っている鍵**だけ**を剥がす
 *   - 下見と件数が違えば何もしない（母集団が動いた）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planProspectClaimRelease, summarizeClaimRelease, RELEASE_REFUSE, RELEASE_CONFIRM,
} from './prospectClaimRelease.js';
import { computeCampaignDeliveryKey } from './campaignSend.js';
import { resolveSequenceStep } from './campaignSequence.js';
import { MK_CONTRACT, MK_PLAN } from './customerMarketingAudience.js';

const BRAND = 'analytics-keiba';
const FROM = 'noreply@keiba.link';

const mkStep = (n) => ({
  stepNumber: n, delayDays: n === 1 ? 0 : 6,
  subject: `件名${n}`, preheader: `p${n}`, body: `本文${n}`,
  ctaLabel: 'CTA', ctaUrl: 'https://analytics.keiba.link/',
  benefitType: 'content_unlock', benefitDescription: '無料で見られる予想を開放してご案内します',
});
const CAMPAIGN = Object.freeze({
  campaignId: 'campaign-discount-free', version: 1, name: 'テスト',
  subject: '既定', body: '既定本文', ctaLabel: 'CTA', ctaUrl: 'https://analytics.keiba.link/',
  benefitType: 'content_unlock', benefitDescription: '無料で見られる予想を開放してご案内します',
  audienceRule: { contracts: [MK_CONTRACT.NONE], plans: [MK_PLAN.FREE], enforce: true },
  enabled: true, sequence: { maxSends: 3, steps: [mkStep(1), mkStep(2), mkStep(3)] },
});

const keyFor = (email, step) => computeCampaignDeliveryKey({
  campaign: resolveSequenceStep(CAMPAIGN, step), recipientEmail: email, brand: BRAND, fromEmail: FROM,
});

const PROSPECTS = ['a@example.invalid', 'b@example.invalid', 'c@example.invalid'].map((email) => ({ email }));
const NO_SENT = { ok: true, sentJobs: 0 };
const base = (over = {}) => ({
  prospects: PROSPECTS, campaign: CAMPAIGN, step: 2, brand: BRAND, fromEmail: FROM,
  deliveredKeys: new Set(PROSPECTS.map((p) => keyFor(p.email, 2))),
  sentEvidence: NO_SENT,
  ...over,
});

test('予約が入っている step2 の鍵だけを剥がす', () => {
  const r = planProspectClaimRelease(base());
  assert.equal(r.ok, true);
  assert.equal(r.keys.length, 3);
  assert.equal(r.counts['予約あり'], 3);
  assert.equal(r.counts['予約なし'], 0);
});

test('【重要】予約集合に無い人は触らない', () => {
  const r = planProspectClaimRelease(base({
    deliveredKeys: new Set([keyFor('a@example.invalid', 2)]),
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.keys, [keyFor('a@example.invalid', 2)]);
  assert.equal(r.counts['予約なし'], 2);
});

test('【重要】step1 は絶対に剥がさない（実送信済み＝再送になる）', () => {
  for (const step of [1, 0, -1, 1.5, null, undefined, 'a']) {
    const r = planProspectClaimRelease(base({ step }));
    assert.equal(r.ok, false, String(step));
    assert.equal(r.refuse, RELEASE_REFUSE.FIRST_STEP, String(step));
    assert.equal(r.keys.length, 0);
  }
});

test('【重要】その step に送信実績があれば剥がさない', () => {
  const r = planProspectClaimRelease(base({ sentEvidence: { ok: true, sentJobs: 1 } }));
  assert.equal(r.ok, false);
  assert.equal(r.refuse, RELEASE_REFUSE.HAS_SENT);
  assert.equal(r.keys.length, 0);
});

test('【重要】送信実績を確かめられなければ剥がさない（fail closed）', () => {
  for (const ev of [null, undefined, { ok: false }, {}]) {
    const r = planProspectClaimRelease(base({ sentEvidence: ev }));
    assert.equal(r.ok, false);
    assert.equal(r.refuse, RELEASE_REFUSE.SENT_UNKNOWN);
  }
});

test('【重要】予約集合を読めなければ剥がさない', () => {
  for (const d of [null, undefined, [], 'x']) {
    const r = planProspectClaimRelease(base({ deliveredKeys: d }));
    assert.equal(r.ok, false);
    assert.equal(r.refuse, RELEASE_REFUSE.LEDGER_UNAVAILABLE);
  }
});

test('【重要】下見と件数が違えば何もしない（母集団が動いた）', () => {
  const r = planProspectClaimRelease(base({ expectedCount: 2 }));
  assert.equal(r.ok, false);
  assert.equal(r.refuse, RELEASE_REFUSE.COUNT_MISMATCH);
  assert.equal(r.keys.length, 0);
  // 一致していれば通る
  assert.equal(planProspectClaimRelease(base({ expectedCount: 3 })).ok, true);
});

test('step2 の鍵だけを作る（step1 / step3 の鍵は混ざらない）', () => {
  const r = planProspectClaimRelease(base());
  for (const k of r.keys) {
    assert.ok(!PROSPECTS.some((p) => keyFor(p.email, 1) === k), 'step1 の鍵が混ざっている');
    assert.ok(!PROSPECTS.some((p) => keyFor(p.email, 3) === k), 'step3 の鍵が混ざっている');
  }
});

test('同じ人が重複していても鍵は 1 つ', () => {
  const dup = [...PROSPECTS, { email: 'A@Example.invalid' }];
  const r = planProspectClaimRelease(base({ prospects: dup }));
  assert.equal(new Set(r.keys).size, r.keys.length);
  assert.equal(r.keys.length, 3);
});

test('要約にアドレスも鍵も含めない', () => {
  const s = summarizeClaimRelease({
    campaignId: 'campaign-discount-free', step: 2,
    counts: { 母数: 3, 予約あり: 3, 予約なし: 0 }, released: 3, dryRun: false,
  });
  const json = JSON.stringify(s);
  assert.equal(json.includes('@'), false);
  assert.equal(/[a-f0-9]{64}/.test(json), false);
});

test('確認文字列は画面から流し込めない固定値', () => {
  assert.equal(RELEASE_CONFIRM, 'RELEASE PROSPECT CLAIMS');
});
