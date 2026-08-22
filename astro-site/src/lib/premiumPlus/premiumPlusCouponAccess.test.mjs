/**
 * premiumPlusCouponAccess.test.mjs — 「誰に配るか」「いつ使えるか」を固定する
 *
 * ## この機能の目的
 *
 * > Premium Plus を買おうとした → いまは売っていない → **代わりにクーポンをどうぞ**
 *
 * クーポンは**買えなかった人への埋め合わせ**。だから配る相手は「いま購入できない会員」。
 *
 * ⚠️ 2026-08-22 に一度、取得条件を「その会員の再募集が開始済み」にしてしまい、
 *    再募集の開始＝販売再開なので **「買える人だけが取得できる」＝目的と正反対**になった。
 *    このファイルはその再発を防ぐためのもの。
 *
 * | 軸 | 条件 |
 * |---|---|
 * | 取得できる（配る）| Plus の対象会員 ＋ **販売停止中** ＋ 未取得 |
 * | 使える（割引が乗る）| 取得済み ＋ **その会員の再募集が開始済みで期限内** |
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
const NOW = Date.parse('2026-08-22T10:00:00.000Z');
const CLAIMED = {
  PremiumPlusReopenCouponClaimedAt: '2026-08-18T22:07:54.000Z',
  PremiumPlusReopenCouponId: 'premium-plus-reopen-priority@v1',
  PremiumPlusReopenCouponSource: 'pause-notice',
};
const started = { available: true, startsAtIso: START };
const notStarted = { available: true, startsAtIso: null };
const unreadable = { available: false, reason: 'read_failed' };

const access = (over = {}) => resolveCouponAccess({
  audience: true, salePaused: true, reopen: notStarted,
  fields: null, nowMs: NOW, storageReady: true, ...over,
});

// ── 配る相手は「いま買えない人」────────────────────────────
test('販売停止中の会員には配る（**再募集が未開始でも**）', () => {
  const a = access();
  assert.equal(a.canClaim, true, '買えない人に配れていない＝この機能の目的が壊れている');
  assert.equal(a.visible, true);
  assert.equal(a.reason, null);
  assert.deepEqual(resolveClaimDecision(a), { ok: true, alreadyClaimed: false });
});

test('販売停止中なら、再募集が開始済みでも配る（開始は取得の条件ではない）', () => {
  const a = access({ reopen: started });
  assert.equal(a.canClaim, true);
});

test('**いま購入できる会員には配らない**（埋め合わせが要らない）', () => {
  const a = access({ salePaused: false, reopen: started });
  assert.equal(a.canClaim, false);
  assert.equal(a.visible, false);
  assert.equal(a.reason, COUPON_ACCESS_REJECT.NOT_PAUSED);
  assert.equal(claimRejectStatus(a.reason), 409);
});

test('取得条件は再募集の開始状態に依存しない（読めなくても配れる）', () => {
  // ⚠️ ここが `started` に依存すると「買える人だけ取得できる」へ逆戻りする
  const a = access({ reopen: unreadable });
  assert.equal(a.stateKnown, false);
  assert.equal(a.canClaim, true, '開始状態の読み取り失敗で配れなくなっている');
});

test('Plus の対象外には存在も知らせない（404）', () => {
  const a = access({ audience: false });
  assert.equal(a.reason, COUPON_ACCESS_REJECT.NOT_ELIGIBLE);
  assert.equal(a.visible, false);
  assert.equal(claimRejectStatus(a.reason), 404);
});

test('保存できない環境では取得を受け付けない（「取得した」と言わない）', () => {
  const a = access({ storageReady: false });
  assert.equal(a.canClaim, false);
  assert.equal(a.reason, COUPON_ACCESS_REJECT.STORAGE_UNAVAILABLE);
  assert.equal(claimRejectStatus(a.reason), 503);
});

// ── 使えるのは「再募集が開始してから」──────────────────────
test('取得済みでも、その会員の再募集が未開始なら使えない', () => {
  const a = access({ fields: CLAIMED });
  assert.equal(a.claimed, true);
  assert.equal(a.canUse, false);
  assert.equal(a.visible, true, '取得済みは常に確認できる');
  assert.equal(a.reason, COUPON_ACCESS_REJECT.NOT_STARTED);
});

test('再募集が開始され期限内なら使える（販売中でも停止中でも保有は同じ）', () => {
  for (const salePaused of [true, false]) {
    const a = access({ fields: CLAIMED, reopen: started, salePaused });
    assert.equal(a.canUse, true, `salePaused=${salePaused}`);
    assert.equal(a.expiresAtIso, new Date(Date.parse(START) + 14 * DAY).toISOString());
  }
});

test('期限を過ぎたら使えない（保有の事実は消えない）', () => {
  const a = access({ fields: CLAIMED, reopen: started, nowMs: Date.parse(START) + 15 * DAY });
  assert.equal(a.claimed, true);
  assert.equal(a.canUse, false);
  assert.equal(a.reason, COUPON_ACCESS_REJECT.EXPIRED);
  assert.equal(a.visible, true);
});

test('開始状態を読めないときは、取得済みでも「使える」と言わない', () => {
  const a = access({ fields: CLAIMED, reopen: unreadable });
  assert.equal(a.canUse, false);
  assert.equal(a.reason, COUPON_ACCESS_REJECT.STATE_UNAVAILABLE);
});

test('取得済みには二重取得させない（冪等な成功）', () => {
  const a = access({ fields: CLAIMED, reopen: started });
  assert.equal(a.canClaim, false);
  assert.deepEqual(resolveClaimDecision(a), { ok: true, alreadyClaimed: true });
});

// ── 申込での使用（未開始は 58,000円 を作らせない）─────────────
test('未開始の会員が持つクーポンは申込で使えない', () => {
  const def = withReopenStart(null);
  assert.equal(listApplicableCoupons({ fields: CLAIMED, nowMs: NOW, def }).length, 0);
  const p = resolveOrderPricing({
    fields: CLAIMED, couponId: 'premium-plus-reopen-priority@v1', nowMs: NOW, def,
  });
  assert.equal(p.couponApplied, null);
  assert.equal(p.finalPrice, 68000);
});

test('開始済み・期限内なら 58,000円で申し込める', () => {
  const def = withReopenStart(START);
  assert.equal(listApplicableCoupons({ fields: CLAIMED, nowMs: NOW, def })[0].offerPrice, 58000);
  const p = resolveOrderPricing({
    fields: CLAIMED, couponId: 'premium-plus-reopen-priority@v1', nowMs: NOW, def,
  });
  assert.equal(p.finalPrice, 58000);
  assert.equal(p.discount, 10000);
});

// ── Plus 対象判定は停止に依存しない（存在秘匿だけを担う）──────
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
  assert.equal(live.plusAudience.isPlusAudience, true);
  assert.equal(paused.plusAudience.isPlusAudience, true);
  // 購入可否は従来どおり停止で変わる（別軸であることの確認）
  assert.equal(live.plusRelease.showProductPage, true);
  assert.equal(paused.plusRelease.showProductPage, false);
  assert.equal(paused.plusRelease.salePaused, true);
});

test('管理者が Plus 以外の導線を指定した会員は対象外（存在を知らせない）', () => {
  const v = resolveUpsellForCustomer({
    fields: {
      'プラン': 'Premium Sanrenpuku', 'Status': 'active', '有効期限': '2099-12-31',
      'SanrenpukuPaidAt': '2020-01-01T00:00:00.000Z',
      'PremiumPlusEligibility': 'eligible', 'PremiumPlusReleaseOverride': 'phase4',
      [PP_SALE_PAUSE_FIELDS.PAUSED]: true, 'UpsellTarget': 'sanrenpuku',
    },
    nowMs: NOW,
  });
  assert.equal(v.plusAudience.isPlusAudience, false);
  assert.equal(access({ audience: false }).reason, COUPON_ACCESS_REJECT.NOT_ELIGIBLE);
});

// ── 他会員に影響しない ────────────────────────────────────────
test('判定は渡された 1 会員ぶんだけを見る（入力を書き換えない）', () => {
  const fields = { ...CLAIMED };
  const snapshot = JSON.stringify(fields);
  access({ fields, reopen: started });
  assert.equal(JSON.stringify(fields), snapshot);
  const a = access({ fields: CLAIMED, reopen: started });
  const b = access({ fields: CLAIMED, reopen: { available: true, startsAtIso: '2026-09-10T00:00:00.000Z' } });
  assert.notEqual(a.expiresAtIso, b.expiresAtIso);
});
