/**
 * couponRegrant.test.mjs — 一度使った会員へ**もう一度渡せる**
 *
 * ## なぜ要るか（2026-08-23 / MK 依頼）
 *
 * > またこの会員を販売停止にすればクーポンを再取得できるようにしてほしい。
 * > 販売停止以外でもプレゼントしたい。
 *
 * それまでは、予約台帳に **使用済みの行が 1 つでもあると永久に塞がれ**、
 * 付与・再発行・お客様自身の取得すべてができなかった（1 会員 1 枚・生涯 1 回）。
 *
 * ## 直し方
 *
 * 判定を **「いま持っている 1 枚」に属する予約行だけ**に絞る（`resolveCouponCycleStartIso`）。
 * 過去の行は**台帳に残したまま**、現在の判定に混ぜない（監査は失われない）。
 *
 * 使い終わった 1 枚は管理操作 `closeUsed` で締める。締めたあとは:
 *   - 管理者は「再発行」で**いつでも**渡せる（販売停止中でなくてよい＝プレゼント）
 *   - 販売を止めていれば**お客様自身**も受け取り直せる
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveCouponCycleStartIso, isCurrentCycleReservation, PP_REOPEN_COUPON_FIELDS,
  couponIdWithVersion,
} from './premiumPlusReopenCoupon.js';
import { describeCouponLifecycle, resolveReservationDecision, COUPON_LIFECYCLE }
  from './premiumPlusCouponReservation.js';
import {
  describeCouponAdminActions, PP_COUPON_ADMIN_ACTION, PP_COUPON_BINDING, describeReservationView,
} from './premiumPlusCouponAdmin.js';
import { resolveCouponAccess } from './premiumPlusCouponAccess.js';
import { RESERVATION_SOURCE } from '../promotions/couponReservationSource.js';
import { COUPON_REJECT, COUPON_REJECT_TEXT, resolveCouponOperationPlan }
  from '../coupons/couponPlatform.js';

const REC = 'recSYNTH00000001';
const ENV = {
  PREMIUM_PLUS_FIELDS_READY: '1',
  PREMIUM_PLUS_REOPEN_COUPON_READY: '1',
  COMEBACK_OFFER_TABLE_READY: '1',
};
const DAY = 24 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse('2026-06-01T00:00:00.000Z');

/** 予約行 */
const row = (status, startsAtMs, over = {}) => ({
  id: `recOFFER${status}${startsAtMs}`,
  fields: {
    Source: RESERVATION_SOURCE, CustomerRecordId: REC, OfferId: couponIdWithVersion(),
    Status: status, StartsAt: iso(startsAtMs), ExpiresAt: iso(startsAtMs + 14 * DAY), ...over,
  },
});
/** 取得済みの会員（取得日時つき） */
const claimedAt = (ms, source = 'pause-notice') => ({
  [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: iso(ms),
  [PP_REOPEN_COUPON_FIELDS.COUPON_ID]: couponIdWithVersion(),
  [PP_REOPEN_COUPON_FIELDS.SOURCE]: source,
});
const actions = (fields, offerRows) => Object.fromEntries(
  describeCouponAdminActions({ fields, offerRows, ledgerAvailable: true, env: ENV, customerRecordId: REC })
    .actions.map((a) => [a.action, a]),
);

// ── サイクル境界 ────────────────────────────────────────────
test('取得済みなら、その取得日時が「いまの 1 枚」の始まり', () => {
  assert.equal(resolveCouponCycleStartIso(claimedAt(T0)), iso(T0));
});

test('未取得なら、直近の管理操作の時刻が境界（前の 1 枚を締めた時刻）', () => {
  const closed = {
    [PP_REOPEN_COUPON_FIELDS.SOURCE]: `admin-close-used|by=MK|at=${iso(T0 + 30 * DAY)}|op=x|why=再送`,
  };
  assert.equal(resolveCouponCycleStartIso(closed), iso(T0 + 30 * DAY));
});

test('境界より前の予約行は「いまの 1 枚」に属さない（台帳からは消さない）', () => {
  assert.equal(isCurrentCycleReservation(row('redeemed', T0), iso(T0 + 10 * DAY)), false);
  assert.equal(isCurrentCycleReservation(row('issued', T0 + 20 * DAY), iso(T0 + 10 * DAY)), true);
  // 境界も開始時刻も読めないときは除外しない（判定材料が無いなら現行として扱う）
  assert.equal(isCurrentCycleReservation(row('issued', T0), ''), true);
  assert.equal(isCurrentCycleReservation({ fields: { Source: RESERVATION_SOURCE } }, iso(T0)), true);
});

// ── 使い終わったあとの状態 ──────────────────────────────────
const usedFields = claimedAt(T0);
const usedRows = [row('redeemed', T0 + DAY)];

test('使い終わった直後は「使用済み」。まだ渡し直せない', () => {
  const life = describeCouponLifecycle({ fields: usedFields, offerRows: usedRows, customerRecordId: REC });
  assert.equal(life.state, COUPON_LIFECYCLE.REDEEMED);
  const a = actions(usedFields, usedRows);
  assert.equal(a[PP_COUPON_ADMIN_ACTION.GRANT].enabled, false);
  assert.equal(a[PP_COUPON_ADMIN_ACTION.REISSUE].enabled, false);
  // 締める操作だけが押せる
  assert.equal(a[PP_COUPON_ADMIN_ACTION.CLOSE_USED].enabled, true);
});

test('まだ使っていない会員に「締める」は出さない', () => {
  const a = actions(claimedAt(T0), []);
  assert.equal(a[PP_COUPON_ADMIN_ACTION.CLOSE_USED].enabled, false);
  assert.match(a[PP_COUPON_ADMIN_ACTION.CLOSE_USED].blockedBy, /まだ使い終わっていない/);
});

test('締める操作は保有だけを終わらせ、予約行には触らない', () => {
  const plan = resolveCouponOperationPlan({
    operation: PP_COUPON_ADMIN_ACTION.CLOSE_USED,
    holding: PP_COUPON_BINDING.readHolding(usedFields),
    reservations: describeReservationView({
      offerRows: usedRows, ledgerAvailable: true, customerRecordId: REC,
      cycleStartIso: resolveCouponCycleStartIso(usedFields),
    }),
    binding: PP_COUPON_BINDING, customerRecordId: REC,
    env: ENV, actor: 'MK', reason: '', nowMs: T0 + 40 * DAY,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.target, 'holding', '予約行を書き換えようとしている');
  // 保有 3 列だけ。取得日時を空にして履歴を Source へ畳む
  assert.equal(plan.fields[PP_REOPEN_COUPON_FIELDS.CLAIMED_AT], null);
  assert.match(plan.fields[PP_REOPEN_COUPON_FIELDS.SOURCE], /admin-close-used/);
  assert.match(plan.fields[PP_REOPEN_COUPON_FIELDS.SOURCE], new RegExp(`prev=${iso(T0)}`));
  // 理由は打たなくてよいが、履歴は空にしない
  assert.ok(plan.reason.length > 0);
});

// ── 締めたあと ──────────────────────────────────────────────
/** 締めた直後の会員（未取得・履歴あり）。過去の使用済み行は台帳に残っている */
const closedAtMs = T0 + 40 * DAY;
const closedFields = {
  [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: null,
  [PP_REOPEN_COUPON_FIELDS.SOURCE]:
    `admin-close-used|by=MK|at=${iso(closedAtMs)}|prev=${iso(T0)}|op=x|why=もう一度`,
};

test('締めたあとは「使用済み」ではなくなる（過去の行は残っている）', () => {
  const life = describeCouponLifecycle({ fields: closedFields, offerRows: usedRows, customerRecordId: REC });
  assert.equal(life.state, COUPON_LIFECYCLE.NONE, 'まだ使用済み扱いのまま');
  assert.equal(life.reservationCount, 0, 'いまの 1 枚には予約が無い');
  // 台帳の行そのものは消していない
  assert.equal(usedRows.length, 1);
});

test('締めたあとは管理者が **いつでも** 渡し直せる（販売停止中でなくてよい）', () => {
  const a = actions(closedFields, usedRows);
  assert.equal(a[PP_COUPON_ADMIN_ACTION.REISSUE].enabled, true, 'プレゼントできない');
  // 履歴があるので「付与」ではなく「再発行」を使う（取り違え防止は従来どおり）
  assert.equal(a[PP_COUPON_ADMIN_ACTION.GRANT].enabled, false);
  assert.match(a[PP_COUPON_ADMIN_ACTION.GRANT].blockedBy, /再発行/);
});

test('締めたあと、販売を止めればお客様自身も受け取り直せる', () => {
  const started = { available: true, startsAtIso: iso(closedAtMs) };
  const a = resolveCouponAccess({
    audience: true, salePaused: true, reopen: started,
    fields: closedFields, nowMs: closedAtMs + DAY, storageReady: true,
  });
  assert.equal(a.claimed, false);
  assert.equal(a.canClaim, true, '再取得できない');
});

test('締めたあとに受け取り直したクーポンは、また申し込める', () => {
  const reclaimed = claimedAt(closedAtMs + DAY, 'pause-notice');
  const d = resolveReservationDecision({
    fields: reclaimed, offerRows: usedRows, customerRecordId: REC,
    nowMs: closedAtMs + 2 * DAY, env: ENV,
    def: { ...PP_COUPON_BINDING, terms: { expiresDetermined: true, expiresAt: iso(closedAtMs + 20 * DAY) } },
  });
  assert.equal(d.ok, true, '過去の使用済み行で新しい申込が塞がれている');
});

// ── 塞ぎすぎない / 緩めすぎない ──────────────────────────────
test('締めずに再取得はできない（使ったまま二重取得させない）', () => {
  const started = { available: true, startsAtIso: iso(T0) };
  const a = resolveCouponAccess({
    audience: true, salePaused: true, reopen: started,
    fields: usedFields, nowMs: T0 + 2 * DAY, storageReady: true,
  });
  assert.equal(a.canClaim, false, '保有したまま二重に取得できてしまう');
});

test('いまの 1 枚が入金確認待ちなら締められない（先に確定させる）', () => {
  const a = actions(claimedAt(T0), [row('issued', T0 + DAY)]);
  assert.equal(a[PP_COUPON_ADMIN_ACTION.CLOSE_USED].enabled, false);
});

test('台帳を読めないときは締められない（使用済みか判断できないまま書かない）', () => {
  const view = describeCouponAdminActions({
    fields: usedFields, offerRows: usedRows, ledgerAvailable: false, env: ENV, customerRecordId: REC,
  });
  const close = view.actions.find((x) => x.action === PP_COUPON_ADMIN_ACTION.CLOSE_USED);
  assert.equal(close.enabled, false);
  assert.equal(close.blockedBy, COUPON_REJECT_TEXT[COUPON_REJECT.LEDGER_UNAVAILABLE]);
});
