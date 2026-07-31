/**
 * offerCampaignLink.test.mjs — 割引オファーと案内メールの結合
 *   node --test src/lib/promotions/offerCampaignLink.test.mjs
 *
 * 固定する性質:
 *   1. 有効な（issued・期限内）オファーを持つ人にしか URL を作らない
 *   2. 複数該当・内容不一致は**選ばない**（fail closed）。汎用 URL へ倒さない
 *   3. URL は台帳から決定的に再生成でき、生トークンを保存・中継しない
 *   4. 生成した URL は実際に `verifyOfferToken` を通る（＝顧客が本当に使える）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  linkOfferForRecipient,
  resolveRecipientOffer,
  matchesCampaignOffer,
  buildOfferUrl,
  isLiveOffer,
  requiresOfferUrl,
  OFFER_LINK_SKIP,
  OFFER_URL_PLACEHOLDER,
} from './offerCampaignLink.js';
import { OFFER_STATUS, verifyOfferToken, hashOfferToken } from './promotionalOffer.js';

const NOW = Date.parse('2026-08-01T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const SECRET = 's'.repeat(48);
const CUST = 'recCUSTOMER0000001';
const EMAIL = 'someone@example.com';

const CAMPAIGN = {
  campaignId: 'comeback-offer',
  requiresOfferUrl: true,
  offerId: 'premium-annual-half',
  regularPrice: 49800,
  offerPrice: 24900,
};

const offer = (over = {}, id = 'recOFFER0000000001') => ({
  id,
  fields: {
    OfferKey: 'a'.repeat(32),
    CustomerRecordId: CUST,
    Email: EMAIL,
    OfferId: 'premium-annual-half',
    OfferVersion: 1,
    TargetTier: 'premium',
    BillingTerm: 'annual',
    PlanName: 'Premium Annual',
    PlanType: 'Annual',
    RegularPrice: 49800,
    OfferPrice: 24900,
    StartsAt: new Date(NOW - DAY).toISOString(),
    ExpiresAt: new Date(NOW + 13 * DAY).toISOString(),
    Status: OFFER_STATUS.ISSUED,
    ...over,
  },
});

const link = (records, extra = {}) => linkOfferForRecipient({
  records, customerRecordId: CUST, email: EMAIL, campaign: CAMPAIGN, secret: SECRET, nowMs: NOW, ...extra,
});

test('1. 有効なオファーが 1 件あれば URL を作る', () => {
  const r = link([offer()]);
  assert.equal(r.ok, true);
  assert.match(r.url, /^https:\/\/analytics\.keiba\.link\/offer\/\?t=[0-9a-f]{32}\.[0-9a-f]{32}$/);
});

test('2. 生成した URL は実際に検証を通る（顧客が本当に使える）', () => {
  const rec = offer();
  const r = link([rec]);
  const token = new URL(r.url).searchParams.get('t');
  // 台帳にはハッシュしか無いが、署名は決定的なので再現できる
  rec.fields.TokenHash = hashOfferToken(token);
  const v = verifyOfferToken({ token, record: rec, secret: SECRET, nowMs: NOW, claimedEmail: EMAIL });
  assert.equal(v.ok, true, `検証に失敗: ${v.reason}`);
  assert.equal(v.offer.offerPrice, 24900);
});

test('3. オファーが無い / 期限切れ / redeemed / revoked は送らない', () => {
  assert.equal(link([]).reason, OFFER_LINK_SKIP.MISSING);
  assert.equal(link([offer({ ExpiresAt: new Date(NOW - DAY).toISOString() })]).reason, OFFER_LINK_SKIP.MISSING);
  assert.equal(link([offer({ Status: OFFER_STATUS.REDEEMED })]).reason, OFFER_LINK_SKIP.MISSING);
  assert.equal(link([offer({ Status: OFFER_STATUS.REVOKED })]).reason, OFFER_LINK_SKIP.MISSING);
  // 期限は Status 列ではなく時刻でも判定する
  assert.equal(isLiveOffer({ record: offer({ ExpiresAt: new Date(NOW - 1).toISOString() }), nowMs: NOW }), false);
});

test('4. 有効なオファーが複数あれば選ばない（推測しない）', () => {
  const r = link([offer({}, 'recA'), offer({ OfferKey: 'b'.repeat(32) }, 'recB')]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, OFFER_LINK_SKIP.AMBIGUOUS);
});

test('5. 他人のオファーを拾わない（recordId と email の両方が一致）', () => {
  assert.equal(link([offer({ CustomerRecordId: 'recOTHER' })]).reason, OFFER_LINK_SKIP.MISSING);
  assert.equal(link([offer({ Email: 'other@example.com' })]).reason, OFFER_LINK_SKIP.MISSING);
  // email の大小・空白は正規化して比較する
  assert.equal(link([offer({ Email: '  SOMEONE@Example.COM ' })]).ok, true);
});

test('6. 本文に書いた条件と違うオファーは送らない（価格の食い違いを配らない）', () => {
  assert.equal(link([offer({ OfferPrice: 9900 })]).reason, OFFER_LINK_SKIP.MISMATCH);
  assert.equal(link([offer({ RegularPrice: 18000 })]).reason, OFFER_LINK_SKIP.MISMATCH);
  assert.equal(link([offer({ OfferId: 'premium-lifetime-half' })]).reason, OFFER_LINK_SKIP.MISMATCH);
  assert.equal(matchesCampaignOffer({ record: offer(), campaign: CAMPAIGN }), true);
});

test('7. 署名鍵が無ければ URL を作らない（推測 URL を配らない）', () => {
  const r = link([offer()], { secret: '' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, OFFER_LINK_SKIP.NO_SECRET);
  assert.equal(buildOfferUrl({ record: offer(), secret: '' }), null);
  assert.equal(buildOfferUrl({ record: offer(), secret: 'short' }), null);
});

test('8. 同じ入力なら同じ URL（決定的＝送信直前に再生成できる）', () => {
  assert.equal(link([offer()]).url, link([offer()]).url);
  // 鍵が違えば別の URL（他ブランドの鍵で作った URL は通らない）
  assert.notEqual(link([offer()]).url, link([offer()], { secret: 'z'.repeat(48) }).url);
});

test('9. requiresOfferUrl の判定と差し込み印', () => {
  assert.equal(requiresOfferUrl(CAMPAIGN), true);
  assert.equal(requiresOfferUrl({ campaignId: 'x' }), false);
  assert.equal(requiresOfferUrl(null), false);
  assert.equal(OFFER_URL_PLACEHOLDER, '{{offerUrl}}');
});

test('10. 台帳を 1 バイトも書き換えない（純粋関数）', () => {
  const rec = offer();
  const before = JSON.stringify(rec);
  link([rec]);
  resolveRecipientOffer({ records: [rec], customerRecordId: CUST, email: EMAIL, nowMs: NOW });
  assert.equal(JSON.stringify(rec), before, 'レコードが変更されている');
});
