import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BENEFIT_TYPE, BULK_THRESHOLD, BENEFIT_REJECT, isTooVague, checkBenefitForSend,
} from './campaignBenefit.js';
import { listCampaigns, getCampaign } from './campaignCatalog.js';

const OK = { benefitType: BENEFIT_TYPE.FREE_ACCESS, benefitDescription: 'Lightプランを30日間 無料でご利用いただけます' };

test('少数配信は benefit 未設定でも送れる（個別対応を止めない）', () => {
  const r = checkBenefitForSend({ campaign: {}, recipientCount: BULK_THRESHOLD });
  assert.equal(r.ok, true);
  assert.equal(r.bulk, false);
});

test('【fail closed】大量配信で benefitType 未設定なら送れない', () => {
  const r = checkBenefitForSend({ campaign: {}, recipientCount: BULK_THRESHOLD + 1 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, BENEFIT_REJECT.MISSING_TYPE);
  assert.equal(r.bulk, true);
});

test('認めていない benefitType は送れない', () => {
  const r = checkBenefitForSend({
    campaign: { benefitType: 'whatever', benefitDescription: '無料で使えます' }, recipientCount: 1000,
  });
  assert.equal(r.reason, BENEFIT_REJECT.UNKNOWN_TYPE);
});

test('説明が無い / 曖昧なら送れない', () => {
  assert.equal(checkBenefitForSend({
    campaign: { benefitType: BENEFIT_TYPE.DISCOUNT }, recipientCount: 1000,
  }).reason, BENEFIT_REJECT.MISSING_DESCRIPTION);
  assert.equal(checkBenefitForSend({
    campaign: { benefitType: BENEFIT_TYPE.DISCOUNT, benefitDescription: 'サイトを見てください' },
    recipientCount: 1000,
  }).reason, BENEFIT_REJECT.DESCRIPTION_TOO_VAGUE);
});

test('曖昧判定: 「見てください」だけは弾き、具体的な得があれば通す', () => {
  assert.equal(isTooVague('サイトを見てください'), true);
  assert.equal(isTooVague('昨日の結果をご覧ください'), true);
  assert.equal(isTooVague('更新しました'), true);
  assert.equal(isTooVague('短い'), true);
  assert.equal(isTooVague('Lightプランを30日間 無料でご利用いただけます'), false);
  assert.equal(isTooVague('Premiumを4,980円 割引でご案内します'), false);
  assert.equal(isTooVague('三連複プランの特別価格をご案内します'), false);
});

test('bulkSendAllowed:false は理由付きで拒否される', () => {
  const r = checkBenefitForSend({
    campaign: { ...OK, bulkSendAllowed: false }, recipientCount: 1000,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, BENEFIT_REJECT.BULK_NOT_ALLOWED);
});

test('正しく宣言していれば大量配信できる', () => {
  assert.equal(checkBenefitForSend({ campaign: OK, recipientCount: 14279 }).ok, true);
});

// ── カタログ側 ─────────────────────────────────────────────────
test('【本件】dormant-reactivation v2 は大量配信の対象から外れている', () => {
  const c = getCampaign('dormant-reactivation');
  assert.equal(c.bulkSendAllowed, false, '14,279 名へ送った文面が再び大量配信できる状態にある');
  const r = checkBenefitForSend({ campaign: c, recipientCount: 14279 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, BENEFIT_REJECT.BULK_NOT_ALLOWED);
});

test('全キャンペーンが「メリットを宣言」か「大量配信禁止」のどちらかを明示している', () => {
  // 宣言も禁止も無い＝**気づかないまま大量配信できてしまう**状態を許さない。
  for (const c0 of listCampaigns()) {
    const c = getCampaign(c0.campaignId, { includeDisabled: true });
    const declared = Boolean(c.benefitType && c.benefitDescription);
    const quarantined = c.bulkSendAllowed === false;
    assert.ok(declared || quarantined,
      `${c.campaignId}: benefit の宣言も bulkSendAllowed:false も無い`);
  }
});

test('宣言済みキャンペーンは（禁止されていなければ）大量配信を通る', () => {
  for (const c0 of listCampaigns()) {
    const c = getCampaign(c0.campaignId, { includeDisabled: true });
    const r = checkBenefitForSend({ campaign: c, recipientCount: 14279 });
    if (c.bulkSendAllowed === false) {
      assert.equal(r.reason, BENEFIT_REJECT.BULK_NOT_ALLOWED, `${c.campaignId}`);
    } else {
      assert.equal(r.ok, true, `${c.campaignId} が ${r.reason} で弾かれる`);
    }
  }
});
