/**
 * couponOrderCta.test.mjs — 取得後に**申込へ到達できる**こと（dashboard / クーポン詳細）
 *
 * 確定仕様（2026-08-19）:
 *   取得済み → 申込導線 → 10,000円OFF 適用 → 68,000 − 10,000 = 58,000 → 申込
 *   販売停止中・再募集前は購入させない（**押せる購入 CTA を偽装しない**）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const {
  describeCouponOrderCta, describeCouponForMember, readReopenCoupon,
  PP_REOPEN_COUPON_FIELDS, PP_ORDER_PATH,
} = await import('./premiumPlusReopenCoupon.js');
const { renderCouponPageHtml } = await import('./premiumPlusPauseNoticePage.js');

const HELD = readReopenCoupon({ [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-18T22:07:54.803Z' });
const NONE = readReopenCoupon({});
const view = (coupon, purchasable) => describeCouponForMember({
  coupon, paused: !purchasable, claimable: false, purchasable,
});

// ── 未取得 ──────────────────────────────────────────────────
test('未取得ならカードも申込 CTA も出ない', () => {
  const cta = describeCouponOrderCta({ claimed: false, purchasable: true });
  assert.equal(cta.show, false);
  assert.equal(cta.href, null);
  const html = renderCouponPageHtml({ coupon: view(NONE, true) });
  const body = html.slice(html.indexOf('<body>'));
  assert.doesNotMatch(body, /order-cta|order-wait/, '未取得に CTA が出ている');
});

// ── 取得済み + 販売停止中 / 再募集前 ────────────────────────
test('取得済み + 販売停止中: 表示はするが購入させない（リンクにしない）', () => {
  const cta = describeCouponOrderCta({ claimed: true, purchasable: false });
  assert.equal(cta.show, true);
  assert.equal(cta.purchasable, false);
  assert.equal(cta.href, null, '押せるリンクを偽装している');
  assert.match(cta.label, /再募集時に10,000円OFFで申し込めます/);
  assert.match(cta.note, /再募集時にこのクーポンをご利用いただけます/);
});

test('停止中のクーポン詳細は非購入表示（<a> ではなく <p>）', () => {
  const html = renderCouponPageHtml({ coupon: view(HELD, false) });
  const body = html.slice(html.indexOf('<body>'));
  assert.match(body, /<p class="order-wait"/, '非購入表示になっていない');
  assert.doesNotMatch(body, /<a class="order-cta"/, '押せるリンクが出ている');
});

test('停止中でも 10,000円OFF / 68,000→58,000 / 14日間 は出す', () => {
  const html = renderCouponPageHtml({ coupon: view(HELD, false) });
  assert.match(html, /10,000円OFF/);
  assert.match(html, /通常 68,000円 → 58,000円/);
  assert.match(html, /14日間/);
});

// ── 取得済み + 再募集後（購入可能）────────────────────────────
test('購入可能なら「10,000円OFFで申し込む」の申込リンクになる', () => {
  const cta = describeCouponOrderCta({ claimed: true, purchasable: true });
  assert.equal(cta.purchasable, true);
  assert.equal(cta.label, '10,000円OFFで申し込む');
  assert.ok(cta.href.startsWith(PP_ORDER_PATH), '申込画面へ向いていない');
  assert.equal(PP_ORDER_PATH, '/premium-plus-v2/');
});

test('購入可能なクーポン詳細は申込リンクを出す', () => {
  const html = renderCouponPageHtml({ coupon: view(HELD, true) });
  const body = html.slice(html.indexOf('<body>'));
  assert.match(body, /<a class="order-cta" href="\/premium-plus-v2\/[^"]*">10,000円OFFで申し込む<\/a>/);
});

test('「クーポン詳細を確認」は補助導線として残る', () => {
  const cta = describeCouponOrderCta({ claimed: true, purchasable: true });
  assert.equal(cta.detailHref, '/premium-plus-coupon/');
  assert.equal(cta.detailLabel, 'クーポン詳細を確認');
});

// ── dashboard の配線 ────────────────────────────────────────
test('dashboard は主 CTA を申込導線にし、購入不可ならリンクにしない', () => {
  const dash = read('../../pages/dashboard.astro');
  assert.match(dash, /id="reopen-coupon-cta"/);
  assert.match(dash, /id="reopen-coupon-wait"/);
  const fn = dash.slice(dash.indexOf('function renderReopenCoupon'));
  assert.match(fn.slice(0, 4200), /cta\.purchasable === true && cta\.href/);
  // 停止中は wait 表示（リンクにしない）
  assert.match(fn.slice(0, 4200), /waitEl\.textContent = cta\.label/);
});

test('dashboard の CTA に href="#" のプレースホルダを置かない', () => {
  // BaseLayout が a[href^="#"] へ preventDefault を仕込むため、
  // href="#" で出すと**あとから href を変えてもクリックで遷移しない**
  const dash = read('../../pages/dashboard.astro');
  assert.doesNotMatch(dash, /id="reopen-coupon-cta"[^>]*href="#"/, 'クリックで遷移しなくなる');
  const layout = read('../../layouts/BaseLayout.astro');
  assert.match(layout, /a\[href\^="#"\]/, '前提（スムーススクロール）が変わった');
});

test('dashboard は価格・文言をハードコードせずサーバーの値を使う', () => {
  const dash = read('../../pages/dashboard.astro');
  const fn = dash.slice(dash.indexOf('function renderReopenCoupon'), dash.indexOf('function renderReopenCoupon') + 4400);
  assert.doesNotMatch(fn, /68,?000|58,?000|10,?000|申し込む'/, '文言・金額を直書きしている');
  assert.match(fn, /cta\.label/);
  assert.match(fn, /cta\.href/);
});

// ── 遷移だけでは副作用なし ──────────────────────────────────
test('CTA の遷移先は GET のみで、状態を変える口を持たない', () => {
  const cta = describeCouponOrderCta({ claimed: true, purchasable: true });
  assert.doesNotMatch(cta.href, /claim|redeem|confirm|apply=/, '遷移で状態を変えようとしている');
  // 申込画面が読む API は read-only
  const api = read('../../pages/api/premium-plus-order.json.js');
  assert.doesNotMatch(api, /method:\s*'(PATCH|POST|PUT|DELETE)'/);
});

// ── 申込画面の初期選択 ──────────────────────────────────────
test('申込画面は本人のクーポンを初期選択し、価格はサーバーに計算させる', () => {
  const c = read('../../components/PremiumPlusCouponApply.astro');
  assert.match(c, /var first = \(data\.coupons && data\.coupons\[0\]\) \? data\.coupons\[0\]\.couponId : ''/);
  assert.match(c, /load\(first\)/, '初期選択の価格をサーバーへ問い合わせていない');
  // URL パラメータ・localStorage を価格の根拠にしない（**実コード**を見る）
  const code = c.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(code, /localStorage/, 'localStorage を価格の根拠にしている');
  assert.doesNotMatch(code, /searchParams|location\.search/, 'URL パラメータを価格の根拠にしている');
});
