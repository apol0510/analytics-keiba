/**
 * offerRevokePlan.test.mjs — 割引オファーの取り消し判定
 *   node --test src/lib/promotions/offerRevokePlan.test.mjs
 *
 * 固定する性質:
 *   1. issued だけ取り消せる（redeemed / expired / revoked / 不存在はすべて不可）
 *   2. 書き込むのは Status と Notes だけ（Customers のフィールド名が 1 つも出ない）
 *   3. 対象の取り違えを構造的に防ぐ（operationId / CustomerRecordId / OfferKey の一致）
 *   4. 状態が動けば fingerprint が変わる（＝実行直前に 409 で止められる）
 *   5. 取り消し後のトークンは再利用できない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planOfferRevoke,
  resolveOfferStatus,
  describeOfferForRevoke,
  computeOfferRevokeFingerprint,
  listOffersForRevoke,
  OFFER_REVOKE_SKIP,
} from './offerRevokePlan.js';
import {
  OFFER_STATUS,
  OFFER_FORBIDDEN_FIELDS,
  OFFER_WRITABLE_FIELDS,
  verifyOfferToken,
  signOfferToken,
  hashOfferToken,
} from './promotionalOffer.js';

const NOW = Date.parse('2026-07-31T06:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const SECRET = 'x'.repeat(48);

const OP = 'cb-premium-annual-half-2026-07-31-1a01706e';
const CUST = 'recY4nBEnU2LBrfoY';
const KEY_ = 'b4fea31b3ba0e86a6c2f647f816fcfb6';

const baseFields = (over = {}) => ({
  OfferKey: KEY_,
  CustomerRecordId: CUST,
  Email: 'someone@example.com',
  OfferId: 'premium-annual-half',
  OfferVersion: 1,
  TargetTier: 'premium',
  BillingTerm: 'annual',
  PlanName: 'Premium Annual',
  PlanType: 'Annual',
  RegularPrice: 49800,
  OfferPrice: 24900,
  DiscountType: 'percent',
  DiscountValue: '50',
  StartsAt: new Date(NOW - DAY).toISOString(),
  ExpiresAt: new Date(NOW + 13 * DAY).toISOString(),
  Status: OFFER_STATUS.ISSUED,
  OperationId: OP,
  Source: 'offer-e2e-2026-07-31',
  TokenHash: 'a'.repeat(64),
  ...over,
});
const rec = (over = {}, id = 'recOFFER0000000001') => ({ id, fields: baseFields(over) });

test('1. issued → 取り消しできる。書き込むのは Status と Notes だけ', () => {
  const p = planOfferRevoke({ record: rec(), nowMs: NOW, reason: '誤発行' });
  assert.equal(p.ok, true);
  assert.deepEqual(Object.keys(p.fields).sort(), ['Notes', 'Status']);
  assert.equal(p.fields.Status, OFFER_STATUS.REVOKED);
  assert.match(p.fields.Notes, /revoked /);
  assert.match(p.fields.Notes, /誤発行/);
  assert.ok(p.fingerprint && p.fingerprint.length === 64);
});

test('2. Customers 側のフィールドを 1 つも書かない（副作用ゼロ）', () => {
  const p = planOfferRevoke({ record: rec(), nowMs: NOW });
  const written = Object.keys(p.fields);
  // 台帳の allowlist の内側であること
  assert.ok(written.every((k) => OFFER_WRITABLE_FIELDS.includes(k)));
  // 課金・権限・申込のフィールド名が 1 つも現れないこと
  for (const banned of OFFER_FORBIDDEN_FIELDS) {
    assert.equal(written.includes(banned), false, `${banned} を書こうとしている`);
  }
  for (const banned of ['Status_Customer', 'プラン', 'PlanType', '有効期限', 'PaidAt',
    'PaymentConfirmed', 'PaymentEmailSent', 'RequestedPlan', 'RequestedPlanType',
    'RequestedAmount', 'LifetimeSanrenpuku', 'UpsellTarget', 'PremiumPlusEligibility',
    'LightGrantLifetime', 'PremiumGrantLifetime', 'LightGrantUntil', 'PremiumGrantUntil']) {
    assert.equal(written.includes(banned), false, `${banned} を書こうとしている`);
  }
  // 返り値（画面に出る情報）にも PII / token を含めない
  const view = describeOfferForRevoke({ record: rec(), nowMs: NOW });
  for (const leak of ['Email', 'email', 'TokenHash', 'tokenHash', 'token', 'name', '氏名']) {
    assert.equal(leak in view, false, `${leak} が露出している`);
  }
});

test('3. redeemed は取り消せない（申込済みの記録を壊さない）', () => {
  const p = planOfferRevoke({
    record: rec({ Status: OFFER_STATUS.REDEEMED, RedeemedAt: new Date(NOW).toISOString() }),
    nowMs: NOW,
  });
  assert.equal(p.ok, false);
  assert.equal(p.reason, OFFER_REVOKE_SKIP.ALREADY_REDEEMED);
  assert.equal(p.fields, undefined);
});

test('4. expired は取り消せない（Status が issued のままでも時刻で判定する）', () => {
  const expired = rec({ ExpiresAt: new Date(NOW - DAY).toISOString() });
  assert.equal(resolveOfferStatus({ record: expired, nowMs: NOW }), OFFER_STATUS.EXPIRED);
  const p = planOfferRevoke({ record: expired, nowMs: NOW });
  assert.equal(p.ok, false);
  assert.equal(p.reason, OFFER_REVOKE_SKIP.EXPIRED);
});

test('5. revoked の二重取り消しはしない', () => {
  const p = planOfferRevoke({ record: rec({ Status: OFFER_STATUS.REVOKED }), nowMs: NOW });
  assert.equal(p.ok, false);
  assert.equal(p.reason, OFFER_REVOKE_SKIP.ALREADY_REVOKED);
});

test('6. 不存在は fail closed', () => {
  for (const r of [null, undefined, {}, { id: 'rec1' }]) {
    const p = planOfferRevoke({ record: r, nowMs: NOW });
    assert.equal(p.ok, false);
    assert.equal(p.reason, OFFER_REVOKE_SKIP.NOT_FOUND);
  }
});

test('7. operationId 不一致は fail closed', () => {
  const p = planOfferRevoke({ record: rec(), nowMs: NOW, expect: { operationId: 'cb-other-op' } });
  assert.equal(p.ok, false);
  assert.equal(p.reason, OFFER_REVOKE_SKIP.OPERATION_MISMATCH);
  // 一致すれば通る
  assert.equal(planOfferRevoke({ record: rec(), nowMs: NOW, expect: { operationId: OP } }).ok, true);
});

test('8. CustomerRecordId 不一致は fail closed', () => {
  const p = planOfferRevoke({ record: rec(), nowMs: NOW, expect: { customerRecordId: 'recOTHER' } });
  assert.equal(p.ok, false);
  assert.equal(p.reason, OFFER_REVOKE_SKIP.CUSTOMER_MISMATCH);
  assert.equal(planOfferRevoke({ record: rec(), nowMs: NOW, expect: { customerRecordId: CUST } }).ok, true);
});

test('9. OfferKey 不一致は fail closed', () => {
  const p = planOfferRevoke({ record: rec(), nowMs: NOW, expect: { offerKey: 'deadbeef' } });
  assert.equal(p.ok, false);
  assert.equal(p.reason, OFFER_REVOKE_SKIP.OFFER_KEY_MISMATCH);
});

test('10. 有効期限が読めない台帳行は fail closed', () => {
  for (const bad of ['', 'not-a-date', undefined]) {
    const p = planOfferRevoke({ record: rec({ ExpiresAt: bad }), nowMs: NOW });
    assert.equal(p.ok, false);
    assert.ok([OFFER_REVOKE_SKIP.NO_EXPIRY, OFFER_REVOKE_SKIP.EXPIRED].includes(p.reason));
  }
});

test('11. 状態が動けば fingerprint が変わる（実行直前に 409 で止まる）', () => {
  const before = computeOfferRevokeFingerprint({ record: rec() });
  // dry-run のあとに顧客が申し込んだ
  const after = computeOfferRevokeFingerprint({
    record: rec({ Status: OFFER_STATUS.REDEEMED, RedeemedAt: new Date(NOW).toISOString() }),
  });
  assert.notEqual(before, after);
  // 同じ内容なら同じ値（正常系で無駄に 409 にならない）
  assert.equal(before, computeOfferRevokeFingerprint({ record: rec() }));
  // 別レコードなら別の値
  assert.notEqual(before, computeOfferRevokeFingerprint({ record: rec({}, 'recOFFER0000000002') }));
});

test('12. 取り消し後のトークンは再利用できない（申込に進めない）', () => {
  const email = 'someone@example.com';
  const token = signOfferToken({ offerKey: KEY_, email, secret: SECRET });
  const issued = rec({ Email: email, TokenHash: hashOfferToken(token) });

  // 取り消し前は通る
  assert.equal(verifyOfferToken({ token, record: issued, secret: SECRET, nowMs: NOW, claimedEmail: email }).ok, true);

  // 取り消しの結果を台帳に反映する
  const p = planOfferRevoke({ record: issued, nowMs: NOW, reason: 'E2E' });
  assert.equal(p.ok, true);
  const revoked = { id: issued.id, fields: { ...issued.fields, ...p.fields } };

  const v = verifyOfferToken({ token, record: revoked, secret: SECRET, nowMs: NOW, claimedEmail: email });
  assert.equal(v.ok, false);
  assert.equal(v.reason, `not_issued:${OFFER_STATUS.REVOKED}`);
});

test('13. 一覧は issued にだけ canRevoke を立てる', () => {
  const rows = listOffersForRevoke({
    records: [
      rec({}, 'recA'),
      rec({ Status: OFFER_STATUS.REDEEMED }, 'recB'),
      rec({ Status: OFFER_STATUS.REVOKED }, 'recC'),
      rec({ ExpiresAt: new Date(NOW - DAY).toISOString() }, 'recD'),
    ],
    nowMs: NOW,
  });
  const by = Object.fromEntries(rows.map((r) => [r.offerRecordId, r]));
  assert.equal(by.recA.canRevoke, true);
  assert.equal(by.recB.canRevoke, false);
  assert.equal(by.recC.canRevoke, false);
  assert.equal(by.recD.canRevoke, false);
  // 表示項目（画面に出す値）が揃っている
  for (const k of ['offerId', 'targetTier', 'billingTerm', 'regularPrice', 'offerPrice', 'status', 'expiresAt']) {
    assert.ok(k in by.recA, `${k} が無い`);
  }
  // PII / token は 1 行にも含まれない
  for (const r of rows) {
    assert.equal('email' in r || 'Email' in r, false);
    assert.equal('tokenHash' in r || 'TokenHash' in r, false);
  }
});

test('14. 顧客で絞り込める（無関係な offer を出さない）', () => {
  const rows = listOffersForRevoke({
    records: [rec({}, 'recA'), rec({ CustomerRecordId: 'recOTHER' }, 'recB')],
    nowMs: NOW,
    customerRecordId: CUST,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].offerRecordId, 'recA');
});
