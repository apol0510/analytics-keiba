/**
 * couponEndState.test.mjs — 使い終わった / 期限が切れたクーポンの扱いを固定する
 *
 * ## 方針（2026-08-25 MK 相談への回答）
 *
 * > 使用済みクーポン・期限切れクーポンは非表示ですか？残しますか？
 *
 * **残す。ただし使えないことを必ず言い、押せるボタンは出さない。**
 *
 * | なぜ残すか |
 * |---|
 * | お金の記録。「割引は効いたのか」をお客様自身が確認できる必要がある |
 * | 消えると「取り上げられた」と読まれる（期限切れは特にそう見える）|
 * | 1 会員が持てるのは 1 枚（Customers の 3 列）なので、残しても散らからない |
 *
 * | なぜ出しっぱなしではいけないか |
 * |---|
 * | 期限切れが **「取得済み」のまま**表示され、期限を過ぎたと画面のどこにも出ていなかった |
 * | 販売再開後は**押せる申込ボタンが出る**（申込は 409 で弾かれる＝押した先で落胆する）|
 *
 * ⚠️ 「使えるか」の判断は 1 か所（`resolveCouponAccess`）。
 *    画面でもここでも日付を比べ直さない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { describeCouponUsageForMember } from './premiumPlusReopenCoupon.js';
import { resolveCouponAccess, COUPON_ACCESS_REJECT } from './premiumPlusCouponAccess.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url).pathname, 'utf8');
const usage = (over = {}) => describeCouponUsageForMember({
  lifecycle: 'held', ledgerAvailable: true, claimed: true, ...over,
});

// ── 残す ────────────────────────────────────────────────────
test('期限が切れても保有は消えない（カードは出す）', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const start = '2026-08-01T00:00:00.000Z';
  const a = resolveCouponAccess({
    audience: true, salePaused: false,
    reopen: { available: true, startsAtIso: start },
    fields: {
      PremiumPlusReopenCouponClaimedAt: start,
      PremiumPlusReopenCouponId: 'premium-plus-reopen-priority@v1',
      PremiumPlusReopenCouponSource: 'pause-notice',
    },
    nowMs: Date.parse(start) + 30 * DAY,
    storageReady: true,
  });
  assert.equal(a.claimed, true, '保有の事実が消えている');
  assert.equal(a.visible, true, '**カードごと消している**（記録を確認できない）');
  assert.equal(a.canUse, false);
  assert.equal(a.reason, COUPON_ACCESS_REJECT.EXPIRED);
});

// ── ただし「使えない」と必ず言う ────────────────────────────
test('期限切れは「取得済み」で済ませない', () => {
  const u = usage({ expired: true });
  assert.equal(u.expired, true);
  assert.equal(u.badge, 'ご利用期限切れ');
  assert.equal(u.title, '期限切れのクーポン');
  assert.match(u.note, /有効期限を過ぎた/);
  // 押せる申込ボタンを出さない（押した先で 409 に会わせない）
  assert.equal(u.blocksOrder, true);
});

test('使い終わった・申込に適用済みは従来どおり（期限より優先して伝える）', () => {
  const used = usage({ lifecycle: 'redeemed', expired: true });
  assert.equal(used.used, true);
  assert.equal(used.badge, 'ご利用済み');
  assert.equal(used.expired, false, '使った事実より期限を優先して伝えている');

  const reserved = usage({ lifecycle: 'reserved', expired: true });
  assert.equal(reserved.reserved, true);
  assert.equal(reserved.badge, 'お申し込みに適用済み');
  assert.match(reserved.note, /入金の確認/);
});

test('使えるクーポンは今までどおり（消しすぎない）', () => {
  const u = usage();
  assert.equal(u.blocksOrder, false, '使えるのにボタンを消している');
  assert.equal(u.badge, '取得済み');
  assert.equal(u.title, '取得済みクーポン');
  assert.equal(u.note, '');
});

test('確認できないときは断定しない（期限切れとも言わない）', () => {
  const u = usage({ ledgerAvailable: false, expired: true });
  assert.equal(u.known, false);
  assert.equal(u.expired, false);
  assert.equal(u.blocksOrder, true, '確認できないのに申し込ませている');
});

test('取得していない人を「期限切れ」にしない', () => {
  assert.equal(usage({ claimed: false, expired: true }).expired, false);
});

// ── 画面は判断しない ────────────────────────────────────────
test('API は「使えるか」の単一源から期限切れを渡す（日付を比べ直さない）', () => {
  const api = read('../../pages/api/upsell.json.js');
  assert.match(api, /expired:\s*couponAccess\.reason === COUPON_ACCESS_REJECT\.EXPIRED/,
    '単一源の結論を使っていない');
  // 使えないものに申込導線を出さない
  assert.match(api, /usage\.blocksOrder \?/, '使えないクーポンで申し込ませている');
});

test('マイページは状態名を自分で作らない（サーバーの見出しを出す）', () => {
  const page = read('../../pages/dashboard.astro');
  const fn = page.slice(page.indexOf('function renderReopenCoupon'));
  const body = fn.slice(0, fn.indexOf('\n      }\n'));
  const code = body.replace(/\/\/[^\n]*/g, '');
  assert.match(code, /usage\.title/, 'サーバーの見出しを使っていない');
  assert.doesNotMatch(code, /'ご利用済みクーポン'/, '画面で状態名を作っている');
  // 使えないカードは控えめに（消しはしない）
  assert.match(code, /is-inactive/, '使えるカードと同じ見た目のまま');
  assert.match(page, /\.coupon-section\.is-inactive \.coupon-card/, '控えめにする指定が無い');
});
