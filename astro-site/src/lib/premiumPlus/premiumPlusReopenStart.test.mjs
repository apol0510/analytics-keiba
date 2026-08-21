/**
 * premiumPlusReopenStart.test.mjs — **会員ごとの**再募集開始日時の判定を固定する
 *
 * 固定する仕様（2026-08-22 MK 仕様変更）:
 *   - 開始は**会員単位**。A を開始しても B は未開始のまま
 *   - B を後日開始したら **B の期限は B の開始 + 14 日**
 *   - 未開始の会員は期限が確定せず **予約 write は fail closed**
 *   - 「読めていない」を「未開始」に丸めない
 *   - 壊れた保存値を開始済みとして採用しない
 *   - admin 表示（`resolveReopenStatus`）と サーバー実効状態（`withReopenStart`）が一致する
 *   - 販売可否（salePaused / eligibility / phase / route）とは**別軸**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  REOPEN_STATE,
  REOPEN_UNAVAILABLE,
  normalizeReopenStartsAt,
  withReopenStart,
  resolveReopenStatus,
  buildReopenStartConfirmText,
  isSafeCustomerRecordId,
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

const A_START = '2026-09-01T03:00:00.000Z';          // JST 2026-09-01 12:00
const B_START = '2026-09-20T03:00:00.000Z';          // JST 2026-09-20 12:00（後日）
const DAY = 24 * 60 * 60 * 1000;
const CLAIMED = {
  PremiumPlusReopenCouponClaimedAt: '2026-08-18T22:07:54.000Z',
  PremiumPlusReopenCouponId: 'premium-plus-reopen-priority@v1',
  PremiumPlusReopenCouponSource: 'pause-notice',
};
const ENV_READY = { COMEBACK_OFFER_TABLE_READY: '1' };

// ── 会員単位であること ────────────────────────────────────────
test('A 会員を開始しても B 会員は未開始のまま（他会員へ影響しない）', () => {
  const defA = withReopenStart(A_START);
  const defB = withReopenStart(null);            // B は未開始

  assert.equal(defA.terms.expiresDetermined, true);
  assert.equal(defA.terms.reopenStartsAt, A_START);

  assert.equal(defB.terms.expiresDetermined, false);
  assert.equal(defB.terms.reopenStartsAt, null);
  // B は予約 write を作れない（fail closed のまま）
  assert.equal(isReservationEnabled(ENV_READY, defB), false);
  assert.equal(buildReservationFields({
    customerRecordId: 'recBBBBBBBBBBBBBB', email: 'b@example.invalid',
    applicationId: 'app-b', nowMs: Date.parse(A_START), def: defB,
  }), null);
  // A は作れる
  assert.ok(buildReservationFields({
    customerRecordId: 'recAAAAAAAAAAAAAA', email: 'a@example.invalid',
    applicationId: 'app-a', nowMs: Date.parse(A_START), def: defA,
  }));
});

test('B を後日開始すると B の期限は B の開始 + 14 日（A とは別の期限）', () => {
  const defA = withReopenStart(A_START);
  const defB = withReopenStart(B_START);
  assert.equal(defA.terms.expiresAt, new Date(Date.parse(A_START) + 14 * DAY).toISOString());
  assert.equal(defB.terms.expiresAt, new Date(Date.parse(B_START) + 14 * DAY).toISOString());
  assert.notEqual(defA.terms.expiresAt, defB.terms.expiresAt);

  // A の期限が切れたあとでも、B はまだ期限内
  const afterAExpiry = Date.parse(A_START) + 15 * DAY;
  assert.equal(listApplicableCoupons({ fields: CLAIMED, nowMs: afterAExpiry, def: defA }).length, 0);
  assert.equal(listApplicableCoupons({ fields: CLAIMED, nowMs: afterAExpiry, def: defB }).length, 1);
});

test('既に取得済みのクーポンも、その会員の開始後に 14 日間使える', () => {
  // 取得は 8/18。開始が 9/1 でも、期限は「開始 + 14 日」で数える（取得日からではない）
  const def = withReopenStart(A_START);
  const justBefore = Date.parse(A_START) + 14 * DAY - 1000;
  const pricing = resolveOrderPricing({
    fields: CLAIMED, couponId: 'premium-plus-reopen-priority@v1', nowMs: justBefore, def,
  });
  assert.equal(pricing.finalPrice, 58000);
  assert.equal(pricing.discount, 10000);
});

// ── 未開始 = fail closed ─────────────────────────────────────
test('未開始の会員は予約 write ができない（fail closed）', () => {
  assert.equal(isReservationEnabled(ENV_READY, PP_REOPEN_COUPON), false);
  const d = resolveReservationDecision({
    fields: CLAIMED, offerRows: [], customerRecordId: 'recBBBBBBBBBBBBBB',
    nowMs: Date.parse(A_START), env: ENV_READY, def: PP_REOPEN_COUPON,
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

// ── 期限の導出（計算式は 1 か所）────────────────────────────
test('開始すると期限が「開始 + 14 日」で確定する', () => {
  const def = withReopenStart(A_START);
  assert.equal(resolveCouponExpiry(def).expiresAtIso, def.terms.expiresAt);
  assert.equal(describeCouponExpiry(def), '2026年9月15日 12:00（JST）まで');
});

test('開始後は期限切れが実際に効く（新規利用だけ止まる）', () => {
  const def = withReopenStart(A_START);
  const after = Date.parse(A_START) + 15 * DAY;
  const d = resolveReservationDecision({
    fields: CLAIMED, offerRows: [], customerRecordId: 'recAAAAAAAAAAAAAA',
    nowMs: after, env: ENV_READY, def,
  });
  assert.equal(d.ok, false);
  assert.equal(d.reason, RESERVATION_REJECT.EXPIRED);
});

// ── 会員識別子 ──────────────────────────────────────────────
test('会員の識別子は Airtable の recordId 形式だけ', () => {
  assert.equal(isSafeCustomerRecordId('recAAAAAAAAAAAAAA'), true);
  for (const bad of ['', 'nope', 'rec', 'recSHORT', 'rec../etc', null, undefined, 123,
    'recAAAAAAAAAAAAAAA' /* 15 桁 */]) {
    assert.equal(isSafeCustomerRecordId(bad), false, String(bad));
  }
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
test('admin 表示と実効クーポン定義が一致する（会員ごとに）', () => {
  for (const iso of [A_START, B_START]) {
    const st = resolveReopenStatus({ available: true, startsAtIso: iso });
    const def = withReopenStart(iso);
    assert.equal(st.state, REOPEN_STATE.STARTED);
    assert.equal(st.startsAtIso, def.terms.reopenStartsAt);
    assert.equal(st.expiresAtIso, def.terms.expiresAt);
    assert.equal(st.expiryDetermined, def.terms.expiresDetermined);
    assert.equal(st.startable, false);
  }
  assert.equal(resolveReopenStatus({ available: true, startsAtIso: A_START }).startsAtText,
    '2026年9月1日 12:00');
});

test('確認ダイアログの文言に対象会員・取り消せないこと・他会員無影響が入る', () => {
  const t = buildReopenStartConfirmText({ memberLabel: 'daniel@example.invalid' });
  assert.match(t, /daniel@example\.invalid/);
  assert.match(t, /サーバー時刻/);
  assert.match(t, /変更・取り消しできません/);
  assert.match(t, /14日間/);
  assert.match(t, /他の会員には影響しません/);
  // 「売れるようになる」と誤解させない
  assert.match(t, /販売を開ける操作ではありません/);
  // 会員が分からないときでも文言は壊れない
  assert.match(buildReopenStartConfirmText({}), /この会員/);
});

// ── 販売可否とは別軸 ────────────────────────────────────────
test('再募集の開始は販売可否・資格・停止を 1 つも変えない（別軸）', () => {
  const before = { ...CLAIMED, PremiumPlusSalePaused: true, PremiumPlusEligibility: 'eligible' };
  const def = withReopenStart(A_START);
  // 判定に渡しても入力オブジェクトは変わらない
  const snapshot = JSON.stringify(before);
  listApplicableCoupons({ fields: before, nowMs: Date.parse(A_START), def });
  resolveOrderPricing({ fields: before, couponId: 'premium-plus-reopen-priority@v1', nowMs: Date.parse(A_START), def });
  resolveReservationDecision({
    fields: before, offerRows: [], customerRecordId: 'recAAAAAAAAAAAAAA',
    nowMs: Date.parse(A_START), env: ENV_READY, def,
  });
  assert.equal(JSON.stringify(before), snapshot);
  // 実効定義にも販売可否の情報は入らない（クーポンの条件だけ）
  assert.equal(def.terms.salePaused, undefined);
  assert.equal(def.terms.eligibility, undefined);
});

// ── 副作用ゼロ（純粋関数であること）───────────────────────────
test('withReopenStart は基準定義を書き換えない（会員間で汚染しない）', () => {
  const before = JSON.stringify(PP_REOPEN_COUPON.terms);
  const a = withReopenStart(A_START);
  const b = withReopenStart(B_START);
  assert.equal(JSON.stringify(PP_REOPEN_COUPON.terms), before);
  assert.equal(PP_REOPEN_COUPON.terms.expiresDetermined, false);
  // A の定義が B の合成で書き換わらない
  assert.equal(a.terms.reopenStartsAt, A_START);
  assert.equal(b.terms.reopenStartsAt, B_START);
});
