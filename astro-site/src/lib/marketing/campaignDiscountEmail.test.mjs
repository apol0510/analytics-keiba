/**
 * campaignDiscountEmail.test.mjs — 割引メールが**サイトの割引とズレない**ことを固定する
 *
 * ## なぜ要るか
 *
 * キャンペーン割引はサイト側（マイページのお知らせ / 申込モーダル）で先に動いており、
 * メールは**同じ割引を案内するだけ**。にもかかわらず金額・対象・期限を
 * メール側にもう一度書けば、どちらかを直したときに必ず食い違う。
 *
 * 2026-08-24〜25 に本番で実際に起きた食い違い:
 *   - 案内は出るのに申込画面は元の金額のまま（#436）
 *   - 実在しない商品（三連複 月額）を案内し、割引が永久に適用されない（#431）
 *   - 「全会員向け」と言いながら有料の方にしか届いていない（#432）
 *
 * よってここでは **メール文面と `campaignOffers.js` の出し分けが 1 対 1 であること**を、
 * 文字列ではなく**同じ関数の出力**で突き合わせる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CAMPAIGNS, getCampaign, matchesCampaignAudience, validateCampaignSequences } from './campaignCatalog.js';
import { getSequenceSteps, resolveSequenceStep } from './campaignSequence.js';
import { checkBenefitForSend } from './campaignBenefit.js';
import { MK_CONTRACT, MK_PLAN } from './customerMarketingAudience.js';
import {
  DISCOUNT_SEGMENT_OFFER_IDS, DISCOUNT_CTA, DISCOUNT_DEADLINE, discountItems,
} from './campaignDiscountSteps.js';
import {
  resolveCampaignOfferIdsFor, describeCampaignDeadline, describeCampaignOfferLine,
  CAMPAIGN_OFFER_IDS, isCampaignActive,
} from '../promotions/campaignOffers.js';
import { resolveOffer } from '../promotions/promotionOfferCatalog.js';

const IDS = ['campaign-discount-free', 'campaign-discount-light', 'campaign-discount-premium'];

/** 宛先区分 → その区分の会員が実際に持っている権利 */
const ENTITLEMENTS = {
  'campaign-discount-free': {},
  'campaign-discount-light': { canViewLight: true },
  'campaign-discount-premium': { canViewPremium: true, canViewLight: true },
};

const SEGMENT_OF = {
  'campaign-discount-free': 'free',
  'campaign-discount-light': 'light',
  'campaign-discount-premium': 'premium',
};

/** 期間内かどうかに関係なく定義を取り出す（期間外は enabled=false になるため） */
const def = (id) => getCampaign(id, { includeDisabled: true });

test('3 つの宛先区分が存在し、連続配信として定義されている', () => {
  for (const id of IDS) {
    const c = def(id);
    assert.ok(c, `${id} が無い`);
    assert.equal(c.benefitType, 'discount');
    assert.ok(getSequenceSteps(c).length >= 2, `${id}: 連続配信になっていない`);
  }
  assert.equal(validateCampaignSequences().ok, true, JSON.stringify(validateCampaignSequences().errors));
});

test('【核心】案内する割引は、その会員がマイページで見る割引と完全に一致する', () => {
  for (const id of IDS) {
    const expected = resolveCampaignOfferIdsFor(ENTITLEMENTS[id]);
    assert.deepEqual(
      [...DISCOUNT_SEGMENT_OFFER_IDS[SEGMENT_OF[id]]], expected,
      `${id}: メールの案内内容が campaignOffers の出し分けと違う`,
    );
  }
});

test('【核心】特典欄の金額は offer カタログの現在値そのもの（書き写しではない）', () => {
  for (const id of IDS) {
    const items = discountItems(SEGMENT_OF[id]);
    const expected = DISCOUNT_SEGMENT_OFFER_IDS[SEGMENT_OF[id]].map((offerId) => {
      const r = resolveOffer(offerId);
      assert.equal(r.ok, true, `${offerId} を解決できない`);
      return describeCampaignOfferLine(r.offer);
    });
    assert.deepEqual(items, expected, `${id}: 金額がカタログと違う`);
    // 実際に届く本文（特典カード）にも入っていること
    for (const s of getSequenceSteps(def(id))) {
      const eff = resolveSequenceStep(def(id), s.stepNumber);
      if (!Array.isArray(eff.benefitItems)) continue;
      const isPriceCard = eff.benefitItems.some((x) => x.includes('OFF'));
      if (isPriceCard) assert.deepEqual(eff.benefitItems, expected, `${id} step${s.stepNumber}`);
    }
  }
});

test('文面ファイルに金額を直書きしていない（価格を直したらメールも自動で変わる）', () => {
  const src = readFileSync(new URL('./campaignDiscountSteps.js', import.meta.url), 'utf8');
  // ドキュメントコメントを除いた実コードだけを見る
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/¥\s*\d/.test(code), false, '¥ 付きの金額が直書きされている');
  assert.equal(/\d{1,3},\d{3}/.test(code), false, '3 桁区切りの金額が直書きされている');
  assert.equal(/\d+\s*円OFF/.test(code), false, '割引額が直書きされている');
  assert.equal(/\d+年\d+月\d+日/.test(code), false, '期限が直書きされている');
});

test('期限の表示はサイトと同じ 1 つの文字列から作る', () => {
  assert.equal(DISCOUNT_DEADLINE, describeCampaignDeadline());
  for (const id of IDS) {
    for (const s of getSequenceSteps(def(id))) {
      const eff = resolveSequenceStep(def(id), s.stepNumber);
      const all = `${eff.subject} ${eff.body} ${eff.benefitTitle || ''}`;
      // 日付を書いているステップは、必ず正本の文字列で書いている
      const dates = all.match(/\d{4}年\d{1,2}月\d{1,2}日[^、。\s]*/g) || [];
      for (const d of dates) {
        assert.ok(d.startsWith(DISCOUNT_DEADLINE), `${id} step${s.stepNumber}: 期限表記が正本と違う (${d})`);
      }
    }
  }
});

test('【誤爆防止】三連複をお持ちの方に当たるキャンペーンは 1 つも無い', () => {
  const holder = { contract: MK_CONTRACT.ACTIVE, plan: MK_PLAN.PREMIUM_SANRENPUKU };
  for (const id of IDS) {
    const m = matchesCampaignAudience(def(id), holder);
    assert.equal(m.ok, false, `${id}: 三連複保有者に当たってしまう`);
    assert.equal(m.enforced, true, `${id}: enforce されていない（除外されない）`);
  }
  // 出し分けの正本でも「売るものが無い」
  assert.deepEqual(resolveCampaignOfferIdsFor({ canViewSanrenpuku: true }), []);
});

test('【誤爆防止】1 人が 2 つの区分に当たらない（同じ人に別内容が 2 通届かない）', () => {
  const people = [
    { contract: MK_CONTRACT.NONE, plan: MK_PLAN.FREE },
    { contract: MK_CONTRACT.EXPIRED, plan: MK_PLAN.PREMIUM },
    { contract: MK_CONTRACT.EXPIRED, plan: MK_PLAN.LIGHT },
    { contract: MK_CONTRACT.ACTIVE, plan: MK_PLAN.LIGHT },
    { contract: MK_CONTRACT.EXPIRING_SOON, plan: MK_PLAN.LIGHT },
    { contract: MK_CONTRACT.ACTIVE, plan: MK_PLAN.PREMIUM },
    { contract: MK_CONTRACT.EXPIRING_SOON, plan: MK_PLAN.PREMIUM },
    { contract: MK_CONTRACT.ACTIVE, plan: MK_PLAN.PREMIUM_SANRENPUKU },
    { contract: MK_CONTRACT.UNKNOWN, plan: MK_PLAN.PREMIUM },
  ];
  for (const p of people) {
    const hit = IDS.filter((id) => matchesCampaignAudience(def(id), p).ok);
    assert.ok(hit.length <= 1, `${p.plan}/${p.contract} が ${hit.join(' + ')} の 2 つに当たる`);
  }
});

test('状態を確定できない会員（UNKNOWN）には送らない', () => {
  for (const id of IDS) {
    assert.equal(matchesCampaignAudience(def(id), { contract: MK_CONTRACT.UNKNOWN, plan: MK_PLAN.PREMIUM }).ok, false);
    assert.equal(matchesCampaignAudience(def(id), null).ok, false);
  }
});

test('行き先はマイページだけ（未ログインでは割引価格が出ないため）', () => {
  assert.equal(DISCOUNT_CTA.url, 'https://analytics.keiba.link/dashboard/');
  for (const id of IDS) {
    for (const s of getSequenceSteps(def(id))) {
      const eff = resolveSequenceStep(def(id), s.stepNumber);
      assert.equal(eff.ctaUrl, DISCOUNT_CTA.url, `${id} step${s.stepNumber}`);
      // 本文に URL を書かない（CTA に寄せる）。/pricing/ へ送らない
      assert.equal(/https?:\/\//.test(eff.body), false, `${id} step${s.stepNumber}: 本文に URL`);
      assert.equal(eff.body.includes('/pricing/'), false, `${id} step${s.stepNumber}: pricing へ誘導`);
    }
  }
});

test('大量配信の benefit guard を通る（15,000 名規模で送れる）', () => {
  for (const id of IDS) {
    for (const s of getSequenceSteps(def(id))) {
      const eff = resolveSequenceStep(def(id), s.stepNumber);
      const r = checkBenefitForSend({ campaign: eff, recipientCount: 15000 });
      assert.equal(r.ok, true, `${id} step${s.stepNumber}: ${r.reason}`);
    }
  }
});

test('【fail closed】キャンペーン期間外は自動的に使用停止になる', () => {
  const real = Date.now;
  try {
    Date.now = () => Date.parse('2026-09-08T00:00:00+09:00');
    assert.equal(isCampaignActive(), false, '前提: 期間外');
    for (const id of IDS) {
      assert.equal(def(id).enabled, false, `${id}: 期間外なのに有効`);
      // fail closed: 通常の取得経路では取り出せない = dry-run も送信もできない
      assert.equal(getCampaign(id), null, `${id}: 期間外に取得できてしまう`);
    }
    Date.now = () => Date.parse('2026-08-23T23:59:00+09:00');
    for (const id of IDS) assert.equal(def(id).enabled, false, `${id}: 開始前なのに有効`);
    Date.now = () => Date.parse('2026-08-25T12:00:00+09:00');
    for (const id of IDS) assert.equal(def(id).enabled, true, `${id}: 期間内なのに無効`);
  } finally {
    Date.now = real;
  }
});

test('キャンペーン割引以外のキャンペーンには影響していない', () => {
  // 既存キャンペーンが 1 つも消えていないこと（件数は他の作業で増えうるので固定しない）
  const ids = new Set(CAMPAIGNS.map((c) => c.campaignId));
  for (const id of [
    'marketing-canary', 'expired-comeback', 'comeback-light-30d-granted', 'premium-renewal',
    'sanrenpuku-offer', 'premium-plus-offer', 'dormant-reactivation', 'free-member-activation',
    'light-trial-to-premium-sequence', 'light-trial-post-expiry-sequence', 'comeback-offer',
    'general-announcement',
  ]) assert.ok(ids.has(id), `${id} が消えている`);
  assert.equal(CAMPAIGNS.filter((c) => String(c.campaignId).startsWith('campaign-discount')).length, 3);
  // 既存の割引案内（カムバック）は別の offer を使っており、混ざらない
  const comeback = def('comeback-offer');
  assert.equal(Object.values(CAMPAIGN_OFFER_IDS).includes(comeback.offerId), false);
});
