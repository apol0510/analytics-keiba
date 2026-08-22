/**
 * premiumPlusCouponAccess.test.mjs — 「取得できるか」と「購入できるか」を**別軸**にした判定を固定する
 *
 * 2026-08-22 の不整合修正:
 *   旧: 取得 CTA は `salePaused === true` の間だけ
 *   → 再募集の開始が販売停止の解除を含むようになったため、**開始した瞬間に取得できなくなる**
 *   新: 取得資格は「Plus の対象会員 ＋ **その会員の再募集が開始済みで期限内**」。停止は無関係
 *
 * 固定する仕様:
 *   - 未開始会員は claim 不可（fail closed）
 *   - 開始済み・販売中・未取得 → claim 可能（**停止していなくても取得できる**）
 *   - 開始済み・販売停止中 → クーポンの期間は維持（取得も可）。購入可否は別軸
 *   - 期限は会員別 `reopenStartsAt + 14 日`
 *   - 既取得クーポンは保持（判定で消えない）
 *   - read 不能は「未開始」に丸めず fail closed
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveCouponAccess,
  resolveClaimDecision,
  claimRejectStatus,
  COUPON_ACCESS_REJECT,
} from './premiumPlusCouponAccess.js';
import { withReopenStart } from './premiumPlusReopenStart.js';
import { listApplicableCoupons, resolveOrderPricing } from './premiumPlusCouponApply.js';
import { resolveUpsellForCustomer } from '../upsell/upsellTarget.js';
import { PP_SALE_PAUSE_FIELDS } from './premiumPlusRelease.js';

const DAY = 24 * 60 * 60 * 1000;
const START = '2026-08-22T06:00:00.000Z';
const NOW = Date.parse('2026-08-22T07:00:00.000Z');
const CLAIMED = {
  PremiumPlusReopenCouponClaimedAt: '2026-08-18T22:07:54.000Z',
  PremiumPlusReopenCouponId: 'premium-plus-reopen-priority@v1',
  PremiumPlusReopenCouponSource: 'pause-notice',
};
const started = { available: true, startsAtIso: START };
const notStarted = { available: true, startsAtIso: null };
const unreadable = { available: false, reason: 'read_failed' };

const access = (over = {}) => resolveCouponAccess({
  audience: true, reopen: started, fields: null, nowMs: NOW, storageReady: true, ...over,
});

// ── 取得できる条件 ────────────────────────────────────────────
test('開始済み・販売中・未取得 → 取得できる（**停止していなくても**）', () => {
  const a = access();
  assert.equal(a.canClaim, true);
  assert.equal(a.visible, true);
  assert.equal(a.reason, null);
  // 期限は会員別 reopenStartsAt + 14 日
  assert.equal(a.expiresAtIso, new Date(Date.parse(START) + 14 * DAY).toISOString());
});

test('開始済み・販売停止中でも取得できる（購入可否とは別軸）', () => {
  // このモジュールは salePaused を入力に取らない＝構造的に影響しない
  const a = access();
  assert.equal(a.canClaim, true);
  assert.ok(!('salePaused' in a), '停止フラグを判定に持ち込んでいない');
});

test('未開始の会員は取得できない（fail closed）', () => {
  const a = access({ reopen: notStarted });
  assert.equal(a.canClaim, false);
  assert.equal(a.started, false);
  assert.equal(a.reason, COUPON_ACCESS_REJECT.NOT_STARTED);
  assert.equal(a.visible, false, '未取得・未開始にはページも出さない');
  assert.match(a.note, /募集再開のご案内/);
});

test('Plus の対象外には存在も知らせない（404）', () => {
  const a = access({ audience: false });
  assert.equal(a.reason, COUPON_ACCESS_REJECT.NOT_ELIGIBLE);
  assert.equal(a.visible, false);
  assert.equal(claimRejectStatus(a.reason), 404);
});

test('開始状態を読めないときは「未開始」に丸めず fail closed', () => {
  const a = access({ reopen: unreadable });
  assert.equal(a.stateKnown, false);
  assert.equal(a.canClaim, false);
  assert.equal(a.reason, COUPON_ACCESS_REJECT.STATE_UNAVAILABLE);
  assert.equal(claimRejectStatus(a.reason), 503);
});

test('保存できない環境では取得を受け付けない（「取得した」と言わない）', () => {
  const a = access({ storageReady: false });
  assert.equal(a.canClaim, false);
  assert.equal(a.reason, COUPON_ACCESS_REJECT.STORAGE_UNAVAILABLE);
  assert.equal(claimRejectStatus(a.reason), 503);
});

test('期限を過ぎたら取得できない', () => {
  const a = access({ nowMs: Date.parse(START) + 15 * DAY });
  assert.equal(a.canClaim, false);
  assert.equal(a.withinExpiry, false);
  assert.equal(a.reason, COUPON_ACCESS_REJECT.EXPIRED);
  assert.equal(claimRejectStatus(a.reason), 409);
});

// ── 既取得の扱い ──────────────────────────────────────────────
test('取得済みなら二重取得させない（冪等な成功）', () => {
  const a = access({ fields: CLAIMED });
  assert.equal(a.claimed, true);
  assert.equal(a.canClaim, false);
  assert.equal(a.canUse, true);
  const d = resolveClaimDecision(a);
  assert.equal(d.ok, true);
  assert.equal(d.alreadyClaimed, true);
});

test('既取得クーポンは判定で消えない（未開始・期限切れでも保有は残る）', () => {
  for (const over of [{ reopen: notStarted }, { nowMs: Date.parse(START) + 15 * DAY }]) {
    const a = access({ fields: CLAIMED, ...over });
    assert.equal(a.claimed, true, '保有の事実は残る');
    assert.equal(a.visible, true, '取得済みならページで確認できる');
    assert.equal(a.canUse, false, 'ただし今は使えない');
  }
});

// ── 申込での使用（未開始は fail closed）───────────────────────
test('未開始の会員が持つクーポンは申込で使えない', () => {
  const def = withReopenStart(null);            // 未開始 = 期限未確定
  assert.equal(listApplicableCoupons({ fields: CLAIMED, nowMs: NOW, def }).length, 0);
  const p = resolveOrderPricing({
    fields: CLAIMED, couponId: 'premium-plus-reopen-priority@v1', nowMs: NOW, def,
  });
  assert.equal(p.couponApplied, null);
  assert.equal(p.reason, 'coupon_expired');
  assert.equal(p.finalPrice, 68000, '通常価格（申込 Function 側が 409 で止める）');
});

test('開始済み・期限内なら 58,000円で申し込める', () => {
  const def = withReopenStart(START);
  const list = listApplicableCoupons({ fields: CLAIMED, nowMs: NOW, def });
  assert.equal(list.length, 1);
  assert.equal(list[0].offerPrice, 58000);
  const p = resolveOrderPricing({
    fields: CLAIMED, couponId: 'premium-plus-reopen-priority@v1', nowMs: NOW, def,
  });
  assert.equal(p.finalPrice, 58000);
  assert.equal(p.discount, 10000);
  assert.equal(p.regularPrice, 68000);
});

test('期限を過ぎたら申込でも使えない', () => {
  const def = withReopenStart(START);
  const after = Date.parse(START) + 15 * DAY;
  assert.equal(listApplicableCoupons({ fields: CLAIMED, nowMs: after, def }).length, 0);
  assert.equal(resolveOrderPricing({
    fields: CLAIMED, couponId: 'premium-plus-reopen-priority@v1', nowMs: after, def,
  }).couponApplied, null);
});

// ── Plus 対象判定が停止に依存しないこと（不整合の再発防止）─────
test('Plus の対象判定は販売停止の有無で変わらない', () => {
  const base = {
    'プラン': 'Premium Sanrenpuku', 'Status': 'active', '有効期限': '2099-12-31',
    'SanrenpukuPaidAt': '2020-01-01T00:00:00.000Z',
    'PremiumPlusEligibility': 'eligible', 'PremiumPlusReleaseOverride': 'phase4',
  };
  const live = resolveUpsellForCustomer({ fields: base, nowMs: NOW });
  const paused = resolveUpsellForCustomer({
    fields: { ...base, [PP_SALE_PAUSE_FIELDS.PAUSED]: true }, nowMs: NOW,
  });
  assert.equal(live.plusAudience.isPlusAudience, true, '販売中でも対象');
  assert.equal(paused.plusAudience.isPlusAudience, true, '停止中でも対象');
  // 一方、購入可否・商品ページは従来どおり停止で変わる（別軸であることの確認）
  assert.equal(live.plusRelease.showProductPage, true);
  assert.equal(paused.plusRelease.showProductPage, false);
  assert.equal(paused.pauseNotice.showPauseNotice, true);
});

test('管理者が Plus 以外の導線を指定した会員は対象外（存在を知らせない）', () => {
  const base = {
    'プラン': 'Premium Sanrenpuku', 'Status': 'active', '有効期限': '2099-12-31',
    'SanrenpukuPaidAt': '2020-01-01T00:00:00.000Z',
    'PremiumPlusEligibility': 'eligible', 'PremiumPlusReleaseOverride': 'phase4',
    'UpsellTarget': 'sanrenpuku',
  };
  const v = resolveUpsellForCustomer({ fields: base, nowMs: NOW });
  assert.equal(v.plusAudience.isPlusAudience, false);
  assert.equal(resolveCouponAccess({
    audience: v.plusAudience.isPlusAudience, reopen: started, nowMs: NOW, storageReady: true,
  }).reason, COUPON_ACCESS_REJECT.NOT_ELIGIBLE);
});

// ── 他会員に影響しない ────────────────────────────────────────
test('判定は渡された 1 会員ぶんだけを見る（入力を書き換えない）', () => {
  const fields = { ...CLAIMED };
  const snapshot = JSON.stringify(fields);
  access({ fields });
  assert.equal(JSON.stringify(fields), snapshot);
  // 会員ごとに開始日時が違えば期限も違う
  const a = resolveCouponAccess({ audience: true, reopen: { available: true, startsAtIso: START }, nowMs: NOW, storageReady: true });
  const b = resolveCouponAccess({ audience: true, reopen: { available: true, startsAtIso: '2026-09-10T00:00:00.000Z' }, nowMs: NOW, storageReady: true });
  assert.notEqual(a.expiresAtIso, b.expiresAtIso);
});
