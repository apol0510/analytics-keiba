/**
 * premiumPlusAudience.test.mjs — Premium Plus の販売対象（route × 販売資格 × anchor）の検証
 *   node --test src/lib/premiumPlus/premiumPlusAudience.test.mjs
 *
 * 対象:
 *   - ROUTE A（Premium Sanrenpuku 購入者）
 *   - ROUTE B（通常 Premium 会員・加入 30 日以上・Sanrenpuku 未購入）
 *   - PremiumPlusEligibility（eligible / review / blocked・fail closed）
 *   - anchor（購入日 / 販売許可日 / later）
 *   - Airtable fields → 判定入力のアダプタ（既存の権限正本を再利用しているか）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PP_PHASE,
  PP_PHASE_START_DAY,
  PP_ELIGIBILITY,
  PP_ELIGIBILITY_LABEL,
  PP_ROUTE,
  PP_INTAKE,
  PREMIUM_30D_DAYS,
  normalizeEligibility,
  resolvePlusRoute,
  resolvePhaseAnchorMs,
  teaserCopyForRoute,
  resolvePremiumPlusRelease,
  PP_RELEASE_COPY,
} from './premiumPlusRelease.js';
import { resolvePlusMemberFromFields } from './premiumPlusMember.js';

const DAY = 86400000;
const jst = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi) - 9 * 60 * 60 * 1000;
const NOW = jst(2026, 8, 3, 10, 0); // 月曜（平日 = 南関）10:00 JST
const daysAgo = (n) => NOW - n * DAY;

/** ROUTE A の既定シナリオ */
const routeA = (over = {}) => resolvePremiumPlusRelease({
  hasSanrenpuku: true,
  sanrenpukuPaidAtMs: daysAgo(PP_PHASE_START_DAY.SALE),
  eligibility: PP_ELIGIBILITY.ELIGIBLE,
  nowMs: NOW,
  ...over,
});

/** ROUTE B の既定シナリオ（Premium 有効・加入 40 日・三連複なし） */
const routeB = (over = {}) => resolvePremiumPlusRelease({
  hasSanrenpuku: false,
  premiumActive: true,
  premiumPaidAtMs: daysAgo(40),
  eligibility: PP_ELIGIBILITY.ELIGIBLE,
  nowMs: NOW,
  ...over,
});

// ── 販売資格の正規化 ──────────────────────────────────────────────
test('normalizeEligibility: 3 値のみ受理し、未設定・不正値は review（fail closed）', () => {
  assert.equal(normalizeEligibility('eligible'), PP_ELIGIBILITY.ELIGIBLE);
  assert.equal(normalizeEligibility(' ELIGIBLE '), PP_ELIGIBILITY.ELIGIBLE);
  assert.equal(normalizeEligibility('blocked'), PP_ELIGIBILITY.BLOCKED);
  assert.equal(normalizeEligibility('review'), PP_ELIGIBILITY.REVIEW);
  for (const v of [undefined, null, '', 'yes', 'true', 1, {}, 'allow', 'ok']) {
    assert.equal(normalizeEligibility(v), PP_ELIGIBILITY.REVIEW, `${String(v)} は review へ`);
  }
});

test('管理画面ラベルに「ブラックリスト」を使わない', () => {
  assert.equal(PP_ELIGIBILITY_LABEL.eligible, '販売可');
  assert.equal(PP_ELIGIBILITY_LABEL.review, '保留');
  assert.equal(PP_ELIGIBILITY_LABEL.blocked, '販売対象外');
  assert.doesNotMatch(JSON.stringify(PP_ELIGIBILITY_LABEL), /ブラックリスト/);
});

// ── ROUTE A ───────────────────────────────────────────────────────
test('ROUTE A: 三連複購入者 + eligible → 段階公開へ進む', () => {
  const r = routeA();
  assert.equal(r.allowed, true);
  assert.equal(r.route, PP_ROUTE.SANRENPUKU);
  assert.equal(r.phase, PP_PHASE.SALE);
  assert.equal(r.showPurchaseCta, true);
});

test('ROUTE A: review → 購入 CTA なし・商品ページも出さない', () => {
  const r = routeA({ eligibility: PP_ELIGIBILITY.REVIEW });
  assert.equal(r.eligibility, PP_ELIGIBILITY.REVIEW);
  assert.equal(r.route, PP_ROUTE.SANRENPUKU, 'route は判定される（管理画面の候補一覧用）');
  assert.equal(r.allowed, false);
  assert.equal(r.showPurchaseCta, false);
  assert.equal(r.showProductPage, false);
  assert.equal(r.purchaseEnabled, false);
});

test('ROUTE A: blocked → 何日経過しても購入 CTA を出さない', () => {
  for (const days of [PP_PHASE_START_DAY.SALE, 100, 3650]) {
    const r = routeA({ eligibility: PP_ELIGIBILITY.BLOCKED, sanrenpukuPaidAtMs: daysAgo(days) });
    assert.equal(r.eligibility, PP_ELIGIBILITY.BLOCKED);
    assert.equal(r.showPurchaseCta, false, `${days} 日経過でも CTA なし`);
    assert.equal(r.showProductPage, false);
    assert.equal(r.phase, PP_PHASE.LOCKED);
  }
});

test('ROUTE A: blocked → eligible で復帰する', () => {
  const blocked = routeA({ eligibility: PP_ELIGIBILITY.BLOCKED });
  assert.equal(blocked.showPurchaseCta, false);
  const restored = routeA({ eligibility: PP_ELIGIBILITY.ELIGIBLE });
  assert.equal(restored.showPurchaseCta, true);
});

test('ROUTE A: eligibility 未設定 → fail closed（販売不可）', () => {
  const r = routeA({ eligibility: undefined });
  assert.equal(r.eligibility, PP_ELIGIBILITY.REVIEW);
  assert.equal(r.allowed, false);
  assert.equal(r.purchaseEnabled, false);
});

test('ROUTE A: SanrenpukuPaidAt 不明 → anchor なしで PHASE 1（fail closed）', () => {
  const r = routeA({ sanrenpukuPaidAtMs: null });
  assert.equal(r.route, PP_ROUTE.SANRENPUKU);
  assert.equal(r.anchorMs, null);
  assert.equal(r.phase, PP_PHASE.LOCKED);
  assert.equal(r.showProductPage, false);
});

// ── ROUTE B ───────────────────────────────────────────────────────
test('ROUTE B: Premium 29 日 + eligible → まだ Plus 対象外', () => {
  const r = routeB({ premiumPaidAtMs: daysAgo(PREMIUM_30D_DAYS - 1) });
  assert.equal(r.route, PP_ROUTE.NONE);
  assert.equal(r.allowed, false);
  assert.equal(r.showTeaser, false);
  assert.equal(r.showPurchaseCta, false);
});

test('ROUTE B: Premium 30 日 + eligible → Plus 段階公開へ進む', () => {
  const r = routeB({ premiumPaidAtMs: daysAgo(PREMIUM_30D_DAYS) });
  assert.equal(r.route, PP_ROUTE.PREMIUM_30D);
  assert.equal(r.allowed, true);
  assert.equal(r.daysSincePremium, PREMIUM_30D_DAYS);
});

test('ROUTE B: Premium 30 日 + review / blocked → 購入 CTA なし', () => {
  for (const e of [PP_ELIGIBILITY.REVIEW, PP_ELIGIBILITY.BLOCKED]) {
    const r = routeB({ premiumPaidAtMs: daysAgo(PREMIUM_30D_DAYS), eligibility: e });
    assert.equal(r.allowed, false, e);
    assert.equal(r.showPurchaseCta, false, e);
    assert.equal(r.showProductPage, false, e);
  }
});

test('ROUTE B: Premium 60 日 + eligible → 正常（PHASE 4 まで進む）', () => {
  const r = routeB({ premiumPaidAtMs: daysAgo(60) });
  assert.equal(r.route, PP_ROUTE.PREMIUM_30D);
  assert.equal(r.phase, PP_PHASE.SALE);
  assert.equal(r.showPurchaseCta, true);
});

test('ROUTE B: Premium が無効（期限切れ等）なら 30 日超でも対象外', () => {
  const r = routeB({ premiumActive: false, premiumPaidAtMs: daysAgo(60) });
  assert.equal(r.route, PP_ROUTE.NONE);
  assert.equal(r.allowed, false);
});

test('ROUTE B: Premium 加入日が不明なら対象外（推測しない）', () => {
  const r = routeB({ premiumPaidAtMs: null });
  assert.equal(r.route, PP_ROUTE.NONE);
  assert.equal(r.daysSincePremium, null);
});

// ── route 切替（二重適用しない）─────────────────────────────────
test('route 切替: Premium 30 日超でも Sanrenpuku 購入済なら ROUTE A を使う', () => {
  const r = resolvePremiumPlusRelease({
    hasSanrenpuku: true,
    sanrenpukuPaidAtMs: daysAgo(1),
    premiumActive: true,
    premiumPaidAtMs: daysAgo(200),
    eligibility: PP_ELIGIBILITY.ELIGIBLE,
    nowMs: NOW,
  });
  assert.equal(r.route, PP_ROUTE.SANRENPUKU);
  // ROUTE A の anchor（1 日前）で判定される。ROUTE B の 200 日前が使われていない
  assert.equal(r.daysSincePurchase, 1);
  assert.equal(r.phase, PP_PHASE.LOCKED);
  assert.equal(r.daysSincePremium, null, 'ROUTE A では Premium 経過日数を使わない');
});

test('route 切替: ROUTE B 中に Sanrenpuku を購入すると ROUTE A へ移り二重にならない', () => {
  const before = resolvePremiumPlusRelease({
    hasSanrenpuku: false, premiumActive: true, premiumPaidAtMs: daysAgo(40),
    eligibility: PP_ELIGIBILITY.ELIGIBLE, nowMs: NOW,
  });
  assert.equal(before.route, PP_ROUTE.PREMIUM_30D);

  const after = resolvePremiumPlusRelease({
    hasSanrenpuku: true, sanrenpukuPaidAtMs: NOW, premiumActive: true, premiumPaidAtMs: daysAgo(40),
    eligibility: PP_ELIGIBILITY.ELIGIBLE, nowMs: NOW,
  });
  assert.equal(after.route, PP_ROUTE.SANRENPUKU);
  assert.notEqual(before.route, after.route);
  // route は常に単一値（両方が同時に立つ構造にしない）
  assert.ok([PP_ROUTE.SANRENPUKU, PP_ROUTE.PREMIUM_30D, PP_ROUTE.NONE].includes(after.route));
});

test('resolvePlusRoute: 単体でも同じ優先順位', () => {
  assert.equal(resolvePlusRoute({ hasSanrenpuku: true, premiumActive: true, premiumPaidAtMs: daysAgo(99), nowMs: NOW }).route, PP_ROUTE.SANRENPUKU);
  assert.equal(resolvePlusRoute({ hasSanrenpuku: false, premiumActive: true, premiumPaidAtMs: daysAgo(30), nowMs: NOW }).route, PP_ROUTE.PREMIUM_30D);
  assert.equal(resolvePlusRoute({ hasSanrenpuku: false, premiumActive: false, premiumPaidAtMs: daysAgo(99), nowMs: NOW }).route, PP_ROUTE.NONE);
});

// ── anchor ────────────────────────────────────────────────────────
test('anchor: 既定 later は購入日と販売許可日の遅い方', () => {
  const purchase = daysAgo(100);
  const eligible = daysAgo(2);
  assert.equal(
    resolvePhaseAnchorMs({ route: PP_ROUTE.SANRENPUKU, sanrenpukuPaidAtMs: purchase, eligibleAtMs: eligible }),
    eligible
  );
  assert.equal(
    resolvePhaseAnchorMs({ route: PP_ROUTE.SANRENPUKU, sanrenpukuPaidAtMs: purchase, eligibleAtMs: daysAgo(200) }),
    purchase
  );
});

test('anchor: mode purchase / eligible を定数で切り替えられる', () => {
  const p = daysAgo(100), e = daysAgo(2);
  assert.equal(resolvePhaseAnchorMs({ route: PP_ROUTE.SANRENPUKU, sanrenpukuPaidAtMs: p, eligibleAtMs: e, mode: 'purchase' }), p);
  assert.equal(resolvePhaseAnchorMs({ route: PP_ROUTE.SANRENPUKU, sanrenpukuPaidAtMs: p, eligibleAtMs: e, mode: 'eligible' }), e);
});

test('anchor: 購入日が無くても販売許可日があれば段階公開できる（既存会員の救済）', () => {
  const r = routeA({ sanrenpukuPaidAtMs: null, eligibleAtMs: daysAgo(PP_PHASE_START_DAY.PREVIEW) });
  assert.equal(r.anchorMs, daysAgo(PP_PHASE_START_DAY.PREVIEW));
  assert.equal(r.phase, PP_PHASE.PREVIEW);
  assert.equal(r.showProductPage, true);
  assert.equal(r.showPurchaseCta, false);
});

test('anchor: blocked 解除直後は PHASE 1 から段階的に見せる（later の効果）', () => {
  const r = routeA({ sanrenpukuPaidAtMs: daysAgo(300), eligibleAtMs: NOW });
  assert.equal(r.phase, PP_PHASE.LOCKED);
  assert.equal(r.daysSincePurchase, 0);
});

test('anchor: ROUTE B は Premium 加入日を anchor に使う', () => {
  const r = routeB({ premiumPaidAtMs: daysAgo(40) });
  assert.equal(r.anchorMs, daysAgo(40));
});

// ── 予告文言（route ごとの文脈）───────────────────────────────
test('予告文言は route ごとに分かれる（B は三連複前提の文章を使わない）', () => {
  assert.equal(teaserCopyForRoute(PP_ROUTE.SANRENPUKU), PP_RELEASE_COPY.teaser);
  assert.equal(teaserCopyForRoute(PP_ROUTE.PREMIUM_30D), PP_RELEASE_COPY.teaserPremium30d);
  assert.equal(teaserCopyForRoute(PP_ROUTE.NONE), null);
  assert.notEqual(PP_RELEASE_COPY.teaser.body, PP_RELEASE_COPY.teaserPremium30d.body);
  assert.doesNotMatch(JSON.stringify(PP_RELEASE_COPY.teaserPremium30d), /三連複/);
  // どちらの予告にも金額を出さない
  assert.doesNotMatch(JSON.stringify(PP_RELEASE_COPY.teaserPremium30d), /68,?000|98,?000|¥|円/);
});

// ── 受付ステータスは eligible + PHASE 4 のときだけ ──────────────
test('受付ステータスは PHASE 4 かつ eligible のときだけ出る', () => {
  assert.ok([PP_INTAKE.OPEN, PP_INTAKE.CLOSING, PP_INTAKE.CLOSED].includes(routeA().intake));
  assert.equal(routeA({ eligibility: PP_ELIGIBILITY.REVIEW }).intake, null);
  assert.equal(routeA({ sanrenpukuPaidAtMs: daysAgo(PP_PHASE_START_DAY.PREVIEW) }).intake, null);
});

// ── Airtable fields アダプタ（既存の権限正本を再利用）────────────
const FUTURE = '2099-12-31';
const PAST = '2000-01-01';

test('アダプタ: LifetimeSanrenpuku=true → ROUTE A（Premium 期限切れでも三連複は保持）', () => {
  const m = resolvePlusMemberFromFields(
    { 'プラン': 'Premium', 'Status': 'active', '有効期限': PAST, 'LifetimeSanrenpuku': true },
    { nowMs: NOW }
  );
  assert.equal(m.hasSanrenpuku, true);
  const r = resolvePremiumPlusRelease({ ...m, eligibility: PP_ELIGIBILITY.ELIGIBLE, nowMs: NOW });
  assert.equal(r.route, PP_ROUTE.SANRENPUKU);
});

test('アダプタ: 通常 Premium（有効・三連複なし）→ ROUTE B の材料が揃う', () => {
  const m = resolvePlusMemberFromFields(
    { 'プラン': 'Premium', 'PlanType': 'Annual', 'Status': 'active', '有効期限': FUTURE, 'PaidAt': new Date(daysAgo(40)).toISOString() },
    { nowMs: NOW }
  );
  assert.equal(m.hasSanrenpuku, false);
  assert.equal(m.premiumActive, true);
  assert.equal(m.premiumPaidAtMs, daysAgo(40));
  const r = resolvePremiumPlusRelease({ ...m, eligibility: PP_ELIGIBILITY.ELIGIBLE, nowMs: NOW });
  assert.equal(r.route, PP_ROUTE.PREMIUM_30D);
});

test('アダプタ: PremiumPlusEligibility / UpdatedAt を読む', () => {
  const m = resolvePlusMemberFromFields(
    {
      'プラン': 'Premium', 'Status': 'active', '有効期限': FUTURE, 'LifetimeSanrenpuku': true,
      'PremiumPlusEligibility': 'eligible',
      'PremiumPlusEligibilityUpdatedAt': new Date(daysAgo(5)).toISOString(),
      'SanrenpukuPaidAt': new Date(daysAgo(20)).toISOString(),
    },
    { nowMs: NOW }
  );
  assert.equal(m.eligibility, PP_ELIGIBILITY.ELIGIBLE);
  assert.equal(m.eligibleAtMs, daysAgo(5));
  assert.equal(m.sanrenpukuPaidAtMs, daysAgo(20));
  assert.equal(m.anchorSource, 'field');
});

test('アダプタ: fields が無い / 壊れている → すべて安全側（review・route なし）', () => {
  for (const f of [null, undefined, 'x', 42]) {
    const m = resolvePlusMemberFromFields(f, { nowMs: NOW });
    assert.equal(m.hasSanrenpuku, false);
    assert.equal(m.premiumActive, false);
    assert.equal(m.eligibility, PP_ELIGIBILITY.REVIEW);
    const r = resolvePremiumPlusRelease({ ...m, nowMs: NOW });
    assert.equal(r.allowed, false);
    assert.equal(r.route, PP_ROUTE.NONE);
  }
});

test('アダプタ: 退会申請・停止アカウントは Plus 対象外', () => {
  for (const f of [
    { 'プラン': 'Premium', 'Status': 'active', '有効期限': FUTURE, 'LifetimeSanrenpuku': true, 'WithdrawalRequested': true },
    { 'プラン': 'Premium', 'Status': 'suspended', '有効期限': FUTURE, 'LifetimeSanrenpuku': true },
    { 'プラン': 'Premium', 'Status': 'pending', '有効期限': FUTURE, 'PaidAt': new Date(daysAgo(40)).toISOString() },
  ]) {
    const m = resolvePlusMemberFromFields(f, { nowMs: NOW });
    const r = resolvePremiumPlusRelease({ ...m, eligibility: PP_ELIGIBILITY.ELIGIBLE, nowMs: NOW });
    assert.equal(r.route, PP_ROUTE.NONE);
    assert.equal(r.allowed, false);
  }
});

// ── 実績と非連動 ─────────────────────────────────────────────
test('的中 / 不的中の実績は route・phase・eligibility の入力にならない', () => {
  const base = { hasSanrenpuku: true, sanrenpukuPaidAtMs: daysAgo(12), eligibility: PP_ELIGIBILITY.ELIGIBLE, nowMs: NOW };
  const a = resolvePremiumPlusRelease(base);
  // 実績らしき値をいくら混ぜても結果が変わらない（そもそも読んでいない）
  const b = resolvePremiumPlusRelease({
    ...base, isHit: false, payout: 0, results: [{ isHit: false }], hitRate: 0, lossStreak: 99,
  });
  assert.deepEqual(a, b);
});
