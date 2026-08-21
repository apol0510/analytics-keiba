/**
 * premiumPlusReopenStart.test.mjs — 再募集開始日時の**判定**を固定する
 *
 * 固定する仕様（2026-08-21 MK 確定）:
 *   - 未開始のあいだは期限が確定しない ＝ **予約 write は fail closed**
 *   - 開始日時が入れば期限は「開始 + 14 日」で**導出**される（日数を 2 か所に書かない）
 *   - 「読めていない」を「未開始」に丸めない
 *   - 壊れた保存値を開始済みとして採用しない
 *   - admin 表示（`resolveReopenStatus`）と サーバー実効状態（`withReopenStart`）が一致する
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REOPEN_STATE,
  REOPEN_UNAVAILABLE,
  normalizeReopenStartsAt,
  withReopenStart,
  resolveReopenStatus,
  REOPEN_START_CONFIRM_TEXT,
} from './premiumPlusReopenStart.js';
import {
  PP_REOPEN_COUPON,
  PP_REOPEN_COUPON_EXPIRY_NOTE,
  resolveCouponExpiry,
  describeCouponExpiry,
} from './premiumPlusReopenCoupon.js';
import {
  isReservationEnabled,
  buildReservationFields,
  resolveReservationDecision,
  RESERVATION_REJECT,
} from './premiumPlusCouponReservation.js';
import { listApplicableCoupons, resolveOrderPricing } from './premiumPlusCouponApply.js';

const START = '2026-09-01T03:00:00.000Z';           // JST 2026-09-01 12:00
const DAY = 24 * 60 * 60 * 1000;
const CLAIMED = {
  PremiumPlusReopenCouponClaimedAt: '2026-08-18T22:07:54.000Z',
  PremiumPlusReopenCouponId: 'premium-plus-reopen-priority@v1',
  PremiumPlusReopenCouponSource: 'pause-notice',
};
const ENV_READY = { COMEBACK_OFFER_TABLE_READY: '1' };

// ── 基準定義は「未開始」のまま（他の作業で勝手に日付を入れない）──────────
test('基準定義の reopenStartsAt は null のまま（開始日時を捏造しない）', () => {
  assert.equal(PP_REOPEN_COUPON.terms.reopenStartsAt, null);
  assert.equal(PP_REOPEN_COUPON.terms.expiresAt, null);
  assert.equal(PP_REOPEN_COUPON.terms.expiresDetermined, false);
  assert.equal(PP_REOPEN_COUPON.terms.expiryDays, 14);
});

// ── 未開始 = 予約 write は作れない（fail closed）────────────────────
test('未開始のあいだは予約 write ができない（fail closed）', () => {
  assert.equal(isReservationEnabled(ENV_READY, PP_REOPEN_COUPON), false);
  assert.equal(buildReservationFields({
    customerRecordId: 'recX', email: 'a@example.invalid',
    applicationId: 'app-1', nowMs: Date.parse(START), def: PP_REOPEN_COUPON,
  }), null);
  const d = resolveReservationDecision({
    fields: CLAIMED, offerRows: [], customerRecordId: 'recX',
    nowMs: Date.parse(START), env: ENV_READY, def: PP_REOPEN_COUPON,
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, RESERVATION_REJECT.EXPIRY_UNDETERMINED);
});

test('未開始でも「期限切れ」で弾かない（勝手に日付を作らない）', () => {
  const list = listApplicableCoupons({ fields: CLAIMED, nowMs: Date.parse('2099-01-01T00:00:00Z') });
  assert.equal(list.length, 1);
  assert.equal(list[0].expiryDetermined, false);
  assert.equal(list[0].expiryText, PP_REOPEN_COUPON_EXPIRY_NOTE);
});

// ── 開始したら期限が導出される（既存の計算式のまま）────────────────
test('開始すると期限が「開始 + 14 日」で確定する', () => {
  const def = withReopenStart(START);
  assert.equal(def.terms.reopenStartsAt, START);
  assert.equal(def.terms.expiresDetermined, true);
  assert.equal(def.terms.expiresAt, new Date(Date.parse(START) + 14 * DAY).toISOString());
  // 期限の計算は 1 か所（resolveCouponExpiry）にしかない
  assert.equal(resolveCouponExpiry(def).expiresAtIso, def.terms.expiresAt);
  // 顧客表示は ISO 生値ではなく JST の日時
  assert.equal(describeCouponExpiry(def), '2026年9月15日 12:00（JST）まで');
});

test('開始後は予約 write が有効になる（他の gate は据え置き）', () => {
  const def = withReopenStart(START);
  assert.equal(isReservationEnabled(ENV_READY, def), true);
  // 台帳 gate が閉じていれば依然として作らない
  assert.equal(isReservationEnabled({}, def), false);

  const built = buildReservationFields({
    customerRecordId: 'recX', email: 'A@Example.invalid',
    applicationId: 'app-1', nowMs: Date.parse(START) + DAY, def,
  });
  assert.ok(built);
  assert.equal(built.fields.ExpiresAt, def.terms.expiresAt);
  assert.equal(built.fields.OfferPrice, 58000);
  assert.equal(built.fields.RegularPrice, 68000);
});

test('開始後は期限切れが実際に効く（新規利用だけ止まる）', () => {
  const def = withReopenStart(START);
  const after = Date.parse(START) + 15 * DAY;
  const d = resolveReservationDecision({
    fields: CLAIMED, offerRows: [], customerRecordId: 'recX',
    nowMs: after, env: ENV_READY, def,
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, RESERVATION_REJECT.EXPIRED);

  assert.equal(listApplicableCoupons({ fields: CLAIMED, nowMs: after, def }).length, 0);
  const pricing = resolveOrderPricing({
    fields: CLAIMED, couponId: 'premium-plus-reopen-priority@v1', nowMs: after, def,
  });
  assert.equal(pricing.couponApplied, null);
  assert.equal(pricing.finalPrice, 68000);   // 通常価格へは落ちるが、申込側が 409 で止める
});

test('期限内なら 58,000円（二重適用しても変わらない）', () => {
  const def = withReopenStart(START);
  const now = Date.parse(START) + DAY;
  const a = resolveOrderPricing({ fields: CLAIMED, couponId: 'premium-plus-reopen-priority@v1', nowMs: now, def });
  const b = resolveOrderPricing({ fields: CLAIMED, couponId: 'premium-plus-reopen-priority@v1', nowMs: now, def });
  assert.equal(a.finalPrice, 58000);
  assert.equal(b.finalPrice, 58000);
  assert.equal(a.discount, 10000);
});

// ── 壊れた値・範囲外を採用しない ───────────────────────────────
test('採用できない開始日時は「開始していない」ものとして扱う', () => {
  for (const bad of [null, '', '  ', 'あした', '1999-01-01T00:00:00Z', '2200-01-01T00:00:00Z', 'NaN']) {
    assert.equal(normalizeReopenStartsAt(bad), null, String(bad));
    assert.equal(withReopenStart(bad).terms.expiresDetermined, false, String(bad));
  }
});

// ── 「確認できない」を「未開始」に丸めない ─────────────────────
test('読めていないときは UNKNOWN（未開始と言わない・押させない）', () => {
  for (const reason of Object.values(REOPEN_UNAVAILABLE)) {
    const st = resolveReopenStatus({ available: false, startsAtIso: null, reason });
    assert.equal(st.state, REOPEN_STATE.UNKNOWN);
    assert.notEqual(st.state, REOPEN_STATE.NOT_STARTED);
    assert.equal(st.startable, false);
    assert.equal(st.started, false);
    assert.ok(st.note.length > 0);
  }
});

test('保存値が壊れているときも UNKNOWN（開始済みにしない）', () => {
  const st = resolveReopenStatus({ available: true, startsAtIso: 'こわれた値' });
  assert.equal(st.state, REOPEN_STATE.UNKNOWN);
  assert.equal(st.reason, REOPEN_UNAVAILABLE.CORRUPT);
  assert.equal(st.startable, false);
  assert.equal(st.expiryDetermined, false);
});

test('読めて値が無ければ未開始（押せる）', () => {
  const st = resolveReopenStatus({ available: true, startsAtIso: null });
  assert.equal(st.state, REOPEN_STATE.NOT_STARTED);
  assert.equal(st.startable, true);
  assert.equal(st.expiryDetermined, false);
  assert.equal(st.expiresAtText, PP_REOPEN_COUPON_EXPIRY_NOTE);
});

// ── admin 表示と サーバー実効状態の一致 ────────────────────────
test('admin 表示と実効クーポン定義が一致する（期限がズレない）', () => {
  const st = resolveReopenStatus({ available: true, startsAtIso: START });
  const def = withReopenStart(START);
  assert.equal(st.state, REOPEN_STATE.STARTED);
  assert.equal(st.startsAtIso, def.terms.reopenStartsAt);
  assert.equal(st.expiresAtIso, def.terms.expiresAt);
  assert.equal(st.expiryDetermined, def.terms.expiresDetermined);
  // 開始済みなら二度と押させない
  assert.equal(st.startable, false);
  // JST 表記（サーバーの TZ に依存しない）
  assert.equal(st.startsAtText, '2026年9月1日 12:00');
  assert.equal(st.expiresAtText, '2026年9月15日 12:00');
});

test('確認ダイアログの文言に「取り消せない」ことが必ず入る', () => {
  assert.match(REOPEN_START_CONFIRM_TEXT, /サーバー時刻/);
  assert.match(REOPEN_START_CONFIRM_TEXT, /変更・取り消しできません/);
  assert.match(REOPEN_START_CONFIRM_TEXT, /14日間/);
});

// ── 副作用ゼロ（純粋関数であること）───────────────────────────
test('withReopenStart は基準定義を書き換えない', () => {
  const before = JSON.stringify(PP_REOPEN_COUPON.terms);
  withReopenStart(START);
  withReopenStart('2027-01-01T00:00:00.000Z');
  assert.equal(JSON.stringify(PP_REOPEN_COUPON.terms), before);
  assert.equal(PP_REOPEN_COUPON.terms.expiresDetermined, false);
});
