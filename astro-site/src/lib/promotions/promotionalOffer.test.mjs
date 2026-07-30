/**
 * promotionalOffer.test.mjs — 割引オファーの台帳行・トークン・状態遷移
 *   node --test src/lib/promotions/promotionalOffer.test.mjs
 *
 * 守る性質:
 *   - offer 行に課金・権限フィールドが 1 つも現れない（発行しても権利は増えない）
 *   - URL を知っている第三者が使えない（署名 + email 一致）
 *   - 生トークンは保存しない（ハッシュだけ）
 *   - 同じ operationId の再発行で行が増えない（OfferKey で upsert）
 *   - 二重利用できない（issued → redeemed の一方向）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OFFER_STATUS,
  OFFER_WRITABLE_FIELDS,
  OFFER_FORBIDDEN_FIELDS,
  DEFAULT_OFFER_TTL_DAYS,
  assertOnlyOfferFields,
  computeOfferKey,
  signOfferToken,
  parseOfferToken,
  hashOfferToken,
  verifyOfferToken,
  buildOfferRecord,
  buildRedeemFields,
  buildOfferRevokeFields,
  hasActiveOffer,
  findOfferByKey,
  isOfferTableEnabled,
  getOfferSecret,
} from './promotionalOffer.js';
import { resolveOffer } from './promotionOfferCatalog.js';

const NOW = Date.parse('2026-07-30T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const SECRET = 'test-offer-secret-0123456789';
const OP = 'cb-premium-annual-half-2026-07-30-abcd1234';
const CUSTOMER = { recordId: 'rec1', email: 'Ex1@Example.com' };
const OFFER = resolveOffer('premium-annual-half').offer;

const build = (over = {}) => buildOfferRecord({
  offer: OFFER, customer: CUSTOMER, nowMs: NOW, operationId: OP,
  source: 'comeback-2026-07', secret: SECRET, ...over,
});

// ═══ allowlist ═══════════════════════════════════════════════════════

test('offer 行に課金・権限フィールドが 1 つも現れない', () => {
  const { fields } = build();
  for (const f of OFFER_FORBIDDEN_FIELDS) {
    assert.equal(f in fields, false, `${f} を書いている`);
    assert.equal(OFFER_WRITABLE_FIELDS.includes(f), false, `${f} が許可リストにある`);
  }
  assert.equal(assertOnlyOfferFields(fields), true);
  assert.equal(assertOnlyOfferFields({ ...fields, 'プラン': 'Premium' }), false);
  assert.equal(assertOnlyOfferFields({}), false);
});

test('env gate は既定 false（fail closed）', () => {
  assert.equal(isOfferTableEnabled({}), false);
  assert.equal(isOfferTableEnabled({ COMEBACK_OFFER_TABLE_READY: '1' }), true);
  assert.equal(getOfferSecret({}), null);
  assert.equal(getOfferSecret({ PROMO_OFFER_SECRET: 'short' }), null, '短い鍵を通している');
  assert.equal(getOfferSecret({ PROMO_OFFER_SECRET: SECRET }), SECRET);
});

// ═══ 台帳行 ══════════════════════════════════════════════════════════

test('台帳行は価格・期間・状態を持ち、email は正規化される', () => {
  const { fields, token, expiresMs } = build();
  assert.equal(fields.Email, 'ex1@example.com');
  assert.equal(fields.RegularPrice, 49800);
  assert.equal(fields.OfferPrice, 24900);
  assert.equal(fields.PlanName, 'Premium Annual');
  assert.equal(fields.PlanType, 'Annual');
  assert.equal(fields.Status, OFFER_STATUS.ISSUED);
  assert.equal(fields.OperationId, OP);
  assert.equal(expiresMs, NOW + DEFAULT_OFFER_TTL_DAYS * DAY);
  assert.ok(token);
});

test('無料 offer（grant）は台帳に入れられない', () => {
  const free = resolveOffer('light-lifetime-free').offer;
  assert.equal(buildOfferRecord({
    offer: free, customer: CUSTOMER, nowMs: NOW, operationId: OP, secret: SECRET,
  }).error, 'not_a_purchase_offer');
});

test('顧客情報が欠けていれば発行しない（fail closed）', () => {
  assert.equal(build({ customer: { recordId: '', email: 'a@b.co' } }).error, 'invalid_customer');
  assert.equal(build({ customer: { recordId: 'rec1', email: '' } }).error, 'invalid_customer');
  assert.equal(build({ operationId: '' }).error, 'invalid_operation');
});

test('OfferKey は同じ入力なら同じ（再実行で行が増えない）', () => {
  const a = build().fields.OfferKey;
  const b = build().fields.OfferKey;
  assert.equal(a, b);
  // operationId が変われば別の offer
  assert.notEqual(a, build({ operationId: 'other-op' }).fields.OfferKey);
  // 顧客が変われば別の offer
  assert.notEqual(a, build({ customer: { recordId: 'rec2', email: 'b@example.com' } }).fields.OfferKey);
  assert.equal(computeOfferKey({ operationId: '', offerId: 'x', customerRecordId: 'r' }), null);
});

// ═══ トークン ════════════════════════════════════════════════════════

test('生トークンは保存しない（ハッシュだけ）', () => {
  const { fields, token } = build();
  assert.ok(token.includes('.'));
  assert.equal(fields.TokenHash, hashOfferToken(token));
  assert.equal(JSON.stringify(fields).includes(token), false, '生トークンが台帳に入っている');
});

test('鍵が無ければトークンを作らない（台帳行は残る）', () => {
  const r = build({ secret: null });
  assert.equal(r.token, null);
  assert.equal('TokenHash' in r.fields, false);
  assert.equal(signOfferToken({ offerKey: 'x'.repeat(32), email: 'a@b.co', secret: 'short' }), null);
});

test('正しいトークン + 正しい email なら検証を通る', () => {
  const { fields, token } = build();
  const r = verifyOfferToken({ token, record: { fields }, secret: SECRET, nowMs: NOW + DAY, claimedEmail: 'EX1@example.com' });
  assert.equal(r.ok, true);
  assert.equal(r.offer.offerPrice, 24900);
  assert.equal(r.offer.planType, 'Annual');
});

test('URL を拾った第三者は使えない（署名・email・改ざん）', () => {
  const { fields, token } = build();
  const rec = { fields };
  // 署名を書き換えた
  const tampered = `${parseOfferToken(token).offerKey}.${'0'.repeat(32)}`;
  assert.equal(verifyOfferToken({ token: tampered, record: rec, secret: SECRET, nowMs: NOW }).reason, 'bad_signature');
  // 別人の email で申し込んだ
  assert.equal(verifyOfferToken({
    token, record: rec, secret: SECRET, nowMs: NOW, claimedEmail: 'other@example.com',
  }).reason, 'email_mismatch');
  // 鍵が違う
  assert.equal(verifyOfferToken({ token, record: rec, secret: 'another-secret-0123456789', nowMs: NOW }).reason, 'bad_signature');
  // 形式不正
  for (const bad of ['', 'abc', 'x.y', null]) {
    assert.equal(verifyOfferToken({ token: bad, record: rec, secret: SECRET, nowMs: NOW }).reason, 'malformed_token');
  }
  // 行が無い
  assert.equal(verifyOfferToken({ token, record: null, secret: SECRET, nowMs: NOW }).reason, 'offer_not_found');
});

test('期限切れ・利用済み・取り消し済みは使えない', () => {
  const { fields, token } = build();
  assert.equal(verifyOfferToken({
    token, record: { fields }, secret: SECRET, nowMs: NOW + 30 * DAY,
  }).reason, 'expired');
  for (const st of [OFFER_STATUS.REDEEMED, OFFER_STATUS.REVOKED, OFFER_STATUS.EXPIRED]) {
    const r = verifyOfferToken({
      token, record: { fields: { ...fields, Status: st } }, secret: SECRET, nowMs: NOW + DAY,
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /^not_issued/);
  }
});

// ═══ 状態遷移（二重利用の防止）════════════════════════════════════════

test('利用は issued → redeemed の一方向。二重利用できない', () => {
  const { fields } = build();
  const first = buildRedeemFields({ record: { fields }, nowMs: NOW + DAY });
  assert.equal(first.fields.Status, OFFER_STATUS.REDEEMED);
  const second = buildRedeemFields({
    record: { fields: { ...fields, ...first.fields } }, nowMs: NOW + 2 * DAY,
  });
  assert.equal(second.skipped, 'not_issued', '二重利用できてしまう');
});

test('利用済み offer は取り消せない（記録を壊さない）', () => {
  const { fields } = build();
  const redeemed = { ...fields, Status: OFFER_STATUS.REDEEMED };
  assert.equal(buildOfferRevokeFields({ record: { fields: redeemed }, nowMs: NOW }).skipped, 'already_redeemed');
  const r = buildOfferRevokeFields({ record: { fields }, nowMs: NOW, reason: '誤発行' });
  assert.equal(r.fields.Status, OFFER_STATUS.REVOKED);
  assert.ok(String(r.fields.Notes).includes('誤発行'));
});

// ═══ 重複発行の抑止 ══════════════════════════════════════════════════

test('有効な同一 offer があれば重複発行しない', () => {
  const { fields } = build();
  const records = [{ fields }];
  assert.equal(hasActiveOffer({
    records, offerId: 'premium-annual-half', customerRecordId: 'rec1', nowMs: NOW + DAY,
  }), true);
  // 期限切れ後は「有効な offer なし」
  assert.equal(hasActiveOffer({
    records, offerId: 'premium-annual-half', customerRecordId: 'rec1', nowMs: NOW + 30 * DAY,
  }), false);
  // 別の顧客・別の offer は無関係
  assert.equal(hasActiveOffer({
    records, offerId: 'premium-annual-half', customerRecordId: 'rec2', nowMs: NOW,
  }), false);
  assert.equal(hasActiveOffer({
    records, offerId: 'premium-lifetime-half', customerRecordId: 'rec1', nowMs: NOW,
  }), false);
  // OfferKey で引ける
  assert.ok(findOfferByKey({ records, offerKey: fields.OfferKey }));
  assert.equal(findOfferByKey({ records, offerKey: 'nope' }), null);
});
