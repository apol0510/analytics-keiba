/**
 * couponUsedVisible.test.mjs — 使い終わったクーポンが**お客様の画面でも使用済みになる**
 *
 * ## 直した障害（2026-08-23 / MK 報告）
 *
 * > Dashboard の取得済みクーポンが使用済みになりません。
 *
 * 管理画面は「クーポン使用済み」と正しく出ていた。お客様側だけが「取得済み・ご利用いただけます」
 * のままだった。原因は**見ている場所が違う**こと:
 *
 * | 事実 | どこにあるか |
 * |---|---|
 * | 渡した（保有）| Customers の 3 列。**使い終わっても消えない** |
 * | 使った | `PromotionalOffers` の予約行（`redeemed`）|
 *
 * お客様向けの面は保有しか見ていなかった。
 *
 * ## 併せて塞いだ穴（お金に関わる）
 *
 * 保有だけで判定していたため、**使用済みのクーポンを申込画面が何度でも提示**し、
 * 58,000円 の申込が通っていた。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describeCouponUsageForMember } from './premiumPlusReopenCoupon.js';
import { renderCouponPageHtml } from './premiumPlusPauseNoticePage.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// ── 状態の言い分け ──────────────────────────────────────────
test('使用済みは「ご利用済み」と言い、申込導線を出さない', () => {
  const u = describeCouponUsageForMember({ lifecycle: 'redeemed', ledgerAvailable: true, claimed: true });
  assert.equal(u.used, true);
  assert.equal(u.known, true);
  assert.match(u.badge, /ご利用済み/);
  assert.ok(u.note.length > 0, '何が起きたのか伝えていない');
  assert.equal(u.blocksOrder, true, '使用済みなのに申し込ませている');
});

test('入金確認待ちは「お申し込みに適用済み」。二重に申し込ませない', () => {
  const u = describeCouponUsageForMember({ lifecycle: 'reserved', ledgerAvailable: true, claimed: true });
  assert.equal(u.reserved, true);
  assert.equal(u.used, false, 'まだ使い終わっていない');
  assert.equal(u.blocksOrder, true);
  assert.match(u.note, /入金/);
});

test('まだ使っていなければ従来どおり（申込できる）', () => {
  const u = describeCouponUsageForMember({ lifecycle: 'held', ledgerAvailable: true, claimed: true });
  assert.equal(u.used, false);
  assert.equal(u.reserved, false);
  assert.equal(u.blocksOrder, false);
  assert.equal(u.note, '', '使っていないのに注意書きを出している');
});

test('予約を取り消したクーポンは使い直せる', () => {
  const u = describeCouponUsageForMember({ lifecycle: 'revoked', ledgerAvailable: true, claimed: true });
  assert.equal(u.blocksOrder, false);
});

test('台帳を読めないときは「使用済み」とも「未使用」とも言わない（fail closed）', () => {
  for (const input of [
    { lifecycle: 'held', ledgerAvailable: false, claimed: true },
    { lifecycle: 'unknown', ledgerAvailable: true, claimed: true },
  ]) {
    const u = describeCouponUsageForMember(input);
    assert.equal(u.known, false);
    assert.equal(u.used, false, '確認できないのに使用済みと断定している');
    assert.equal(u.blocksOrder, true, '確認できないまま申し込ませている');
    assert.ok(u.note.length > 0);
  }
});

// ── お客様が見る面に届いているか ────────────────────────────
test('マイページは使用状況をサーバーから受け取って出す', () => {
  const api = read('../../pages/api/upsell.json.js');
  assert.match(api, /describeCouponUsageForMember/, 'API が使用状況を解いていない');
  assert.match(api, /listReservationsFor/, '予約台帳を読んでいない（保有しか見ていない）');
  assert.match(api, /usage,/, '応答に載せていない');
  // 使用済み・適用済みなら申込 CTA を出さない
  assert.match(api, /usage\.blocksOrder \?/, '使用済みでも申込 CTA を出している');

  const page = read('../../pages/dashboard.astro');
  assert.match(page, /c\.usage/, 'マイページがサーバーの使用状況を読んでいない');
  assert.match(page, /usage\.badge/, 'バッジを切り替えていない');
  // 画面側で状態を推測しない（文言はサーバー由来）
  assert.doesNotMatch(page, /ご利用済み'/, 'マイページに状態文言をベタ書きしている');
});

test('クーポンページは使用済みなら取得も申込も出さない', () => {
  const base = {
    name: 'テストクーポン', discountText: '', priceText: '', expiryText: '',
    claimed: true, showClaimCta: true, storageReady: true,
    orderCta: { show: true, purchasable: true, href: '/premium-plus-v2/', label: '申し込む' },
  };
  const used = renderCouponPageHtml({
    coupon: { ...base, usage: describeCouponUsageForMember({ lifecycle: 'redeemed', ledgerAvailable: true, claimed: true }) },
  });
  assert.match(used, /ご利用済み/, '使用済みだと伝えていない');
  assert.doesNotMatch(used, /class="order-cta"/, '使用済みなのに申込リンクを出している');
  assert.doesNotMatch(used, /id="claimBtn"/, '使用済みなのに取得 CTA を出している');

  // まだ使っていなければ従来どおり出る（塞ぎすぎていないことの確認）
  const fresh = renderCouponPageHtml({
    coupon: { ...base, usage: describeCouponUsageForMember({ lifecycle: 'held', ledgerAvailable: true, claimed: true }) },
  });
  assert.match(fresh, /class="order-cta"/);
});

// ── お金の経路 ──────────────────────────────────────────────
test('申込画面は使用済みクーポンを提示しない', () => {
  const api = read('../../pages/api/premium-plus-order.json.js');
  assert.match(api, /listReservationsFor/, '予約台帳を読んでいない');
  assert.match(api, /usage\.blocksOrder \? \[\]/, '使用済みでもクーポンを選ばせている');
  assert.match(api, /usage\.blocksOrder\s*\n?\s*\? resolveOrderPricing\(\{ fields, couponId: null/,
    '使用済みでも割引価格を返している');
});

test('申込 Function は使用済みクーポンの申込を止める（副作用ゼロ）', () => {
  const fn = read('../../../netlify/functions/bank-transfer-application.js');
  assert.match(fn, /listReservationsFor/, '予約台帳を確かめていない');
  assert.match(fn, /couponUsable/, '利用可否を判定していない');
  // 止めるときは何も書かない
  const i = fn.indexOf('if (!couponUsable)');
  assert.ok(i > 0);
  const block = fn.slice(i, i + 700);
  assert.match(block, /statusCode: 409/);
  assert.match(block, /sideEffects: 'none'/);
  // ⚠️ 黙って通常価格へ落とさない（58,000円のつもりの人を 68,000円で受理しない）
  assert.doesNotMatch(block, /requestedAmount|finalPrice/);
});
