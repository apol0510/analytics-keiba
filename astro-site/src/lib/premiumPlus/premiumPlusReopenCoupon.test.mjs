/**
 * premiumPlusReopenCoupon.test.mjs — 再募集クーポンの保有状態（純粋部分）
 *
 * 固定する仕様:
 *   - 取得できるのは「停止中の案内対象」だけ（それ以外は not_eligible）
 *   - 二重取得しない（冪等・取得日時を上書きしない）
 *   - 資格 / 停止 / 会員権 / 決済フィールドを 1 つも書かない
 *   - 保存先が有効化されていないときは「取得した」と言わない（fail closed）
 *   - 割引条件は**未確定**のまま（金額・割引率・期限を作らない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PP_REOPEN_COUPON,
  PP_REOPEN_COUPON_FIELDS,
  PP_REOPEN_COUPON_WRITABLE_FIELDS,
  PP_REOPEN_COUPON_FORBIDDEN_FIELDS,
  PP_REOPEN_COUPON_SOURCE,
  COUPON_CLAIM_REJECT,
  readReopenCoupon,
  buildReopenCouponClaimFields,
  resolveCouponClaimDecision,
  assertOnlyCouponFields,
  isReopenCouponEnabled,
  normalizeCouponSource,
  describeCouponForMember,
  hasClaimedReopenCoupon,
  couponIdWithVersion,
} from './premiumPlusReopenCoupon.js';

const NOW = Date.parse('2026-08-18T02:30:00.000Z');
const ENV_ON = { PREMIUM_PLUS_FIELDS_READY: '1', PREMIUM_PLUS_REOPEN_COUPON_READY: '1' };
const NOTICE_ON = { showPauseNotice: true };
const NOTICE_OFF = { showPauseNotice: false };

// ── 割引条件を創作していない ───────────────────────────────────
test('クーポンの割引条件は未確定のまま（金額・割引率・期限を持たない）', () => {
  assert.equal(PP_REOPEN_COUPON.terms.determined, false);
  assert.equal(PP_REOPEN_COUPON.terms.discountType, null);
  assert.equal(PP_REOPEN_COUPON.terms.discountValue, null);
  assert.equal(PP_REOPEN_COUPON.terms.offerPrice, null);
  assert.equal(PP_REOPEN_COUPON.terms.expiresAt, null);
});

test('顧客向けの文言に金額・割引率・「好評につき」を含めない', () => {
  const texts = [PP_REOPEN_COUPON.name, PP_REOPEN_COUPON.description];
  for (const t of texts) {
    assert.doesNotMatch(t, /[0-9]{3,}|%|OFF|好評/i, `文言に条件らしき値がある: ${t}`);
  }
});

// ── 読み取り ────────────────────────────────────────────────
test('フィールド未作成・未設定は「未取得」（fail safe）', () => {
  for (const f of [null, undefined, {}, { 'プラン': 'Premium' }]) {
    const c = readReopenCoupon(f);
    assert.equal(c.claimed, false);
    assert.equal(c.claimedAtMs, null);
    assert.equal(hasClaimedReopenCoupon(f), false);
  }
});

test('取得済みかどうかは ClaimedAt の有無だけで決まる', () => {
  const c = readReopenCoupon({
    [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-18T02:30:00.000Z',
    [PP_REOPEN_COUPON_FIELDS.COUPON_ID]: 'premium-plus-reopen-priority@v1',
    [PP_REOPEN_COUPON_FIELDS.SOURCE]: 'pause-notice',
  });
  assert.equal(c.claimed, true);
  assert.equal(c.claimedAtIso, '2026-08-18T02:30:00.000Z');
  assert.equal(c.couponId, 'premium-plus-reopen-priority@v1');
});

test('壊れた日時は「未取得」に倒す（嘘の取得済みを作らない）', () => {
  const c = readReopenCoupon({ [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: 'not-a-date' });
  assert.equal(c.claimed, false);
});

// ── 取得可否（サーバー側の唯一の判定）──────────────────────────
test('停止中の案内対象でなければ取得できない（API 直打ち防止）', () => {
  const r = resolveCouponClaimDecision({ pauseNotice: NOTICE_OFF, coupon: { claimed: false }, enabled: true });
  assert.deepEqual(r, { ok: false, reason: COUPON_CLAIM_REJECT.NOT_ELIGIBLE });
});

test('pauseNotice が未指定でも取得できない（fail closed）', () => {
  for (const n of [null, undefined, {}, { showPauseNotice: 'true' }]) {
    const r = resolveCouponClaimDecision({ pauseNotice: n, coupon: { claimed: false }, enabled: true });
    assert.equal(r.ok, false);
    assert.equal(r.reason, COUPON_CLAIM_REJECT.NOT_ELIGIBLE);
  }
});

test('対象でも保存先が有効化されていなければ取得させない（fail closed）', () => {
  const r = resolveCouponClaimDecision({ pauseNotice: NOTICE_ON, coupon: { claimed: false }, enabled: false });
  assert.deepEqual(r, { ok: false, reason: COUPON_CLAIM_REJECT.STORAGE_UNAVAILABLE });
});

test('対象・有効化済み・未取得なら取得できる', () => {
  const r = resolveCouponClaimDecision({ pauseNotice: NOTICE_ON, coupon: { claimed: false }, enabled: true });
  assert.deepEqual(r, { ok: true, alreadyClaimed: false });
});

test('取得済みは「取得済み」として成功（gate が off でも書き込みへ進まない）', () => {
  const r = resolveCouponClaimDecision({ pauseNotice: NOTICE_ON, coupon: { claimed: true }, enabled: false });
  assert.deepEqual(r, { ok: true, alreadyClaimed: true });
});

// ── 書き込み ────────────────────────────────────────────────
test('取得はクーポン 3 フィールドだけを書く', () => {
  const built = buildReopenCouponClaimFields({ current: {}, now: NOW, source: 'pause-notice', enabled: true });
  assert.equal(built.changed, true);
  assert.deepEqual(Object.keys(built.fields).sort(), [...PP_REOPEN_COUPON_WRITABLE_FIELDS].sort());
  assert.equal(built.fields[PP_REOPEN_COUPON_FIELDS.CLAIMED_AT], new Date(NOW).toISOString());
  assert.equal(built.fields[PP_REOPEN_COUPON_FIELDS.COUPON_ID], couponIdWithVersion());
});

test('資格 / 停止 / 会員権 / 決済のフィールドを 1 つも書かない', () => {
  const built = buildReopenCouponClaimFields({ current: {}, now: NOW, enabled: true });
  for (const k of PP_REOPEN_COUPON_FORBIDDEN_FIELDS) {
    assert.ok(!(k in built.fields), `禁止フィールドを書いている: ${k}`);
  }
  // 代表例を名指しでも確認（将来リストを削られても落ちるように）
  for (const k of ['PremiumPlusEligibility', 'PremiumPlusSalePaused', 'プラン', '有効期限', 'PaidAt', 'PaymentConfirmed']) {
    assert.ok(!(k in built.fields), `禁止フィールドを書いている: ${k}`);
  }
});

test('二重取得しない（取得済みなら PATCH させず日時も上書きしない）', () => {
  const current = { [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-01T00:00:00.000Z' };
  const built = buildReopenCouponClaimFields({ current, now: NOW, enabled: true });
  assert.equal(built.changed, false);
  assert.deepEqual(built.fields, {});
  assert.equal(built.claimedAtIso, '2026-08-01T00:00:00.000Z');
});

test('保存先が無効 / now が不正なら null（「取得した」と言わせない）', () => {
  assert.equal(buildReopenCouponClaimFields({ current: {}, now: NOW, enabled: false }), null);
  assert.equal(buildReopenCouponClaimFields({ current: {}, now: NaN, enabled: true }), null);
  assert.equal(buildReopenCouponClaimFields({ current: {}, now: 'x', enabled: true }), null);
});

test('取得元は allow-list を通した値しか保存しない', () => {
  const built = buildReopenCouponClaimFields({
    current: {}, now: NOW, enabled: true,
    source: '<script>alert(1)</script>',
  });
  assert.equal(built.fields[PP_REOPEN_COUPON_FIELDS.SOURCE], PP_REOPEN_COUPON_SOURCE.PAUSE_NOTICE);
  assert.equal(normalizeCouponSource('coupon-page'), PP_REOPEN_COUPON_SOURCE.COUPON_PAGE);
  assert.equal(normalizeCouponSource(undefined), PP_REOPEN_COUPON_SOURCE.PAUSE_NOTICE);
});

test('assertOnlyCouponFields は許可外を弾く', () => {
  assert.equal(assertOnlyCouponFields({ [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: 'x' }), true);
  assert.equal(assertOnlyCouponFields({ [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: 'x', 'プラン': 'Premium' }), false);
  assert.equal(assertOnlyCouponFields({}), false);
  assert.equal(assertOnlyCouponFields(null), false);
});

// ── gate ────────────────────────────────────────────────────
test('gate は Plus フィールド gate と専用 gate の両方が必要', () => {
  assert.equal(isReopenCouponEnabled(ENV_ON), true);
  assert.equal(isReopenCouponEnabled({ PREMIUM_PLUS_FIELDS_READY: '1' }), false);
  assert.equal(isReopenCouponEnabled({ PREMIUM_PLUS_REOPEN_COUPON_READY: '1' }), false);
  assert.equal(isReopenCouponEnabled({}), false);
  assert.equal(isReopenCouponEnabled(undefined), false);
});

// ── 顧客向け表示モデル ───────────────────────────────────────
test('取得済みなら取得 CTA を出さない（二重取得させない）', () => {
  const v = describeCouponForMember({
    coupon: readReopenCoupon({ [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-01T00:00:00Z' }),
    paused: true, claimable: true,
  });
  assert.equal(v.claimed, true);
  assert.equal(v.showClaimCta, false);
  assert.equal(v.usableNote.length > 0, true);
});

test('未取得でも案内対象でなければ取得 CTA を出さない', () => {
  const v = describeCouponForMember({ coupon: { claimed: false }, paused: false, claimable: false });
  assert.equal(v.showClaimCta, false);
});

test('条件が未確定であることを表示モデルが隠さない', () => {
  const v = describeCouponForMember({ coupon: { claimed: false }, paused: true, claimable: true });
  assert.equal(v.termsDetermined, false);
  assert.ok(v.termsNote.length > 0);
  assert.equal(v.showClaimCta, true);
});

test('保存先が未有効化なら storageReady=false を隠さない', () => {
  const v = describeCouponForMember({ coupon: { claimed: false }, paused: true, claimable: true, storageReady: false });
  assert.equal(v.storageReady, false);
});
