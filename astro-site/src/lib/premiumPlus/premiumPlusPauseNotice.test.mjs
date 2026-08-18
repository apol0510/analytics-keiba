/**
 * premiumPlusPauseNotice.test.mjs — 受付休止ページの「誰に出すか」と「何を出すか」
 *
 * 固定する仕様:
 *   - 停止していない会員では一切変化しない（既存の CTA / 404 挙動を壊さない）
 *   - 停止中でも「停止を外したら商品ページを見られたはずの人」だけに出す
 *     （blocked / route 未成立 / 管理者が他の導線を指定 → 従来どおり 404）
 *   - 休止ページに購入 CTA・価格・申込導線が 1 つも無い
 *   - 事実確認できない表現（「好評につき」等）を含まない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolvePlusPauseNoticeView } from './premiumPlusRelease.js';
import { resolveUpsellForCustomer, UPSELL_CHANNEL } from '../upsell/upsellTarget.js';
import { describeCouponForMember, readReopenCoupon, PP_REOPEN_COUPON_FIELDS } from './premiumPlusReopenCoupon.js';
import {
  renderPauseNoticeHtml, renderCouponPageHtml, formatClaimedAtJst,
  PAUSE_NOTICE_COPY, COUPON_API_PATH, COUPON_PAGE_PATH,
} from './premiumPlusPauseNoticePage.js';

/** 2026-08-18(火) 11:30 JST = 受付時間内 */
const NOW = Date.parse('2026-08-18T02:30:00.000Z');

/** 三連複保有の販売可会員（ROUTE A / PHASE 4 相当） */
const SALEABLE = Object.freeze({
  'プラン': 'Premium Sanrenpuku',
  'Status': 'active',
  '有効期限': '2027-12-31',
  'SanrenpukuPaidAt': '2026-01-01T00:00:00.000Z',
  'PremiumPlusEligibility': 'eligible',
});

const view = (fields) => resolveUpsellForCustomer({ fields, nowMs: NOW });

// ── 誰に出すか ──────────────────────────────────────────────
test('停止していない会員では休止案内を出さない（既存挙動そのまま）', () => {
  const v = view({ ...SALEABLE });
  assert.equal(v.channel, UPSELL_CHANNEL.PLUS);
  assert.equal(v.pauseNotice.paused, false);
  assert.equal(v.pauseNotice.showPauseNotice, false);
});

test('停止中の販売対象会員には休止案内を出す（404 にしない）', () => {
  const v = view({ ...SALEABLE, PremiumPlusSalePaused: true });
  // 通常導線は従来どおり閉じたまま
  assert.equal(v.channel, UPSELL_CHANNEL.NONE);
  assert.equal(v.plusRelease.showPurchaseCta, false);
  assert.equal(v.plusRelease.showProductPage, false);
  // 直 URL だけ救う
  assert.equal(v.pauseNotice.showPauseNotice, true);
  assert.equal(v.pauseNotice.wouldShowProductPage, true);
});

test('販売対象外(blocked)には停止中でも出さない（恒久判断を一時停止で上書きしない）', () => {
  const v = view({ ...SALEABLE, PremiumPlusSalePaused: true, PremiumPlusEligibility: 'blocked' });
  assert.equal(v.pauseNotice.showPauseNotice, false);
});

test('資格が保留(review)なら停止中でも出さない（もともと商品ページを見られない）', () => {
  const v = view({ ...SALEABLE, PremiumPlusSalePaused: true, PremiumPlusEligibility: 'review' });
  assert.equal(v.pauseNotice.showPauseNotice, false);
});

test('Plus の候補ですらない会員（無料）には出さない（存在秘匿）', () => {
  const v = view({ 'プラン': 'Free', 'Status': 'active', PremiumPlusSalePaused: true });
  assert.equal(v.pauseNotice.showPauseNotice, false);
});

test('管理者が販売導線に「なし」「三連複」を指定した会員には出さない', () => {
  for (const t of ['none', 'sanrenpuku']) {
    const v = view({ ...SALEABLE, PremiumPlusSalePaused: true, UpsellTarget: t });
    assert.equal(v.pauseNotice.showPauseNotice, false, `UpsellTarget=${t} で出ている`);
  }
});

test('管理者が Plus を明示指定した停止中会員には出す', () => {
  const v = view({ ...SALEABLE, PremiumPlusSalePaused: true, UpsellTarget: 'plus' });
  assert.equal(v.pauseNotice.showPauseNotice, true);
});

test('停止を解除すれば元の状態がそのまま戻る（資格・PHASE を壊さない）', () => {
  const before = view({ ...SALEABLE });
  const paused = view({ ...SALEABLE, PremiumPlusSalePaused: true });
  const after = view({ ...SALEABLE, PremiumPlusSalePaused: false });
  assert.equal(paused.pauseNotice.showPauseNotice, true);
  assert.equal(after.channel, before.channel);
  assert.equal(after.plusRelease.phase, before.plusRelease.phase);
  assert.equal(after.plusRelease.eligibility, before.plusRelease.eligibility);
  assert.equal(after.plusRelease.showPurchaseCta, before.plusRelease.showPurchaseCta);
  assert.equal(after.pauseNotice.showPauseNotice, false);
});

test('クーポン取得の有無は販売判定に一切影響しない', () => {
  const withCoupon = view({ ...SALEABLE, [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-01T00:00:00Z' });
  const without = view({ ...SALEABLE });
  assert.equal(withCoupon.channel, without.channel);
  assert.equal(withCoupon.plusRelease.phase, without.plusRelease.phase);
  assert.equal(withCoupon.plusRelease.showPurchaseCta, without.plusRelease.showPurchaseCta);
  assert.equal(withCoupon.plusRelease.salePaused, without.plusRelease.salePaused);
});

test('解決器そのもの: 停止していなければ再計算すらしない', () => {
  const v = resolvePlusPauseNoticeView({ nowMs: NOW, salePaused: false });
  assert.deepEqual(v, {
    paused: false, showPauseNotice: false,
    wouldShowProductPage: false, wouldShowPurchaseCta: false,
  });
});

// ── 何を出すか ──────────────────────────────────────────────
const notClaimed = describeCouponForMember({ coupon: { claimed: false }, paused: true, claimable: true });
const claimed = describeCouponForMember({
  coupon: readReopenCoupon({ [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-18T02:30:00.000Z' }),
  paused: true, claimable: true,
});

test('休止ページに購入導線・価格・振込情報が 1 つも無い', () => {
  for (const html of [
    renderPauseNoticeHtml({ coupon: notClaimed }),
    renderPauseNoticeHtml({ coupon: claimed }),
    renderCouponPageHtml({ coupon: claimed }),
  ]) {
    assert.doesNotMatch(html, /68,?000|98,?000|¥\s*\d/, '価格が出ている');
    assert.doesNotMatch(html, /申し?込|購入|お支払|振込|口座|カート|決済/, '購入導線が出ている');
    assert.doesNotMatch(html, /openBankModal/, '申込モーダルを開ける導線がある');
  }
});

test('事実確認できない表現を含めない', () => {
  const html = renderPauseNoticeHtml({ coupon: notClaimed });
  assert.doesNotMatch(html, /好評|大反響|満席|完売|残りわずか|殺到/);
});

test('休止ページはお客様を立てる文言と取得 CTA を含む', () => {
  const html = renderPauseNoticeHtml({ coupon: notClaimed });
  assert.ok(html.includes(PAUSE_NOTICE_COPY.lead));
  assert.ok(html.includes(PAUSE_NOTICE_COPY.body));
  assert.ok(html.includes(PAUSE_NOTICE_COPY.couponLead));
  assert.ok(html.includes(PAUSE_NOTICE_COPY.cta));
  assert.ok(html.includes(COUPON_API_PATH));
});

test('取得済みなら取得 CTA を描画しない（二重取得させない）', () => {
  const html = renderPauseNoticeHtml({ coupon: claimed });
  assert.doesNotMatch(html, /id="claimBtn"/);
  assert.ok(html.includes('取得済み'));
  assert.ok(html.includes(COUPON_API_PATH) === false);
});

test('クーポンページは名称・取得済み・取得日時・利用時期・受付状況を出す', () => {
  const html = renderCouponPageHtml({ coupon: claimed });
  assert.ok(html.includes(claimed.name));
  assert.ok(html.includes('取得済み'));
  assert.ok(html.includes('取得日時'));
  assert.ok(html.includes(claimed.usableNote));
  assert.ok(html.includes('新規受付を休止しております'));
});

test('未取得のクーポンページには取得 CTA が出る', () => {
  const html = renderCouponPageHtml({ coupon: notClaimed });
  assert.match(html, /id="claimBtn"/);
  assert.ok(html.includes('未取得'));
});

test('取得日時は JST で表示する（UTC 基準で日付をズラさない）', () => {
  // 2026-08-18T23:30Z = JST では 2026-08-19 08:30
  assert.equal(formatClaimedAtJst('2026-08-18T23:30:00.000Z'), '2026年8月19日 08:30');
  assert.equal(formatClaimedAtJst(''), '');
  assert.equal(formatClaimedAtJst('bad'), '');
});

test('HTML は noindex（検索結果に出さない）', () => {
  for (const html of [renderPauseNoticeHtml({ coupon: notClaimed }), renderCouponPageHtml({ coupon: claimed })]) {
    assert.match(html, /<meta name="robots" content="noindex, nofollow" \/>/);
  }
});

test('クーポンページへの導線はあるが、そこにも購入経路は無い', () => {
  const html = renderPauseNoticeHtml({ coupon: notClaimed });
  assert.ok(html.includes(COUPON_PAGE_PATH));
});

test('顧客が入れた値を HTML へ素通しにしない（エスケープ）', () => {
  const html = renderCouponPageHtml({
    coupon: { ...notClaimed, name: '<img src=x onerror=alert(1)>' },
  });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});
