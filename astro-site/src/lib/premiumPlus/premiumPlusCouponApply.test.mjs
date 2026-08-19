/**
 * premiumPlusCouponApply.test.mjs — 申込へのクーポン適用（価格はサーバーが決める）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const stripComments = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const {
  listApplicableCoupons, resolveOrderPricing, describeOrderBreakdown,
  COUPON_APPLY_REJECT, COUPON_PRODUCT,
} = await import('./premiumPlusCouponApply.js');
const { PP_REOPEN_COUPON_FIELDS, couponIdWithVersion } = await import('./premiumPlusReopenCoupon.js');

const ID = couponIdWithVersion();
const HELD = { [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-18T22:07:54.803Z' };
const NOT_HELD = {};

// ── 所持者だけ ──────────────────────────────────────────────
test('所持している本人だけクーポンを選べる', () => {
  const list = listApplicableCoupons({ fields: HELD });
  assert.equal(list.length, 1);
  assert.equal(list[0].couponId, ID);
  assert.equal(list[0].discountText, '10,000円OFF');
  assert.equal(list[0].priceText, '通常 68,000円 → 58,000円');
});

test('未所持は選択肢が 0 件（申込画面は選択欄ごと出さない）', () => {
  assert.deepEqual(listApplicableCoupons({ fields: NOT_HELD }), []);
  assert.deepEqual(listApplicableCoupons({ fields: null }), []);
});

// ── 価格 ────────────────────────────────────────────────────
test('未選択なら通常価格 68,000円', () => {
  const p = resolveOrderPricing({ fields: HELD });
  assert.equal(p.regularPrice, 68000);
  assert.equal(p.discount, 0);
  assert.equal(p.finalPrice, 68000);
  assert.equal(p.couponApplied, null);
});

test('適用すると 68,000円 − 10,000円 = 58,000円', () => {
  const p = resolveOrderPricing({ fields: HELD, couponId: ID });
  assert.equal(p.regularPrice, 68000);
  assert.equal(p.discount, 10000);
  assert.equal(p.finalPrice, 58000);
  assert.equal(p.couponApplied.couponId, ID);
  const b = describeOrderBreakdown(p);
  assert.equal(b.regularText, '通常価格 68,000円');
  assert.equal(b.discountText, 'クーポン割引 -10,000円');
  assert.equal(b.finalText, 'お支払い金額 58,000円');
});

// ── 改ざん・なりすまし ───────────────────────────────────────
test('他会員のクーポンは使えない（未所持で id を送っても割引されない）', () => {
  const p = resolveOrderPricing({ fields: NOT_HELD, couponId: ID });
  assert.equal(p.finalPrice, 68000);
  assert.equal(p.discount, 0);
  assert.equal(p.reason, COUPON_APPLY_REJECT.NOT_HELD);
});

test('任意の couponId 直打ちは通らない', () => {
  for (const bad of ['evil@v9', 'premium-plus-reopen-priority@v99', '../../etc', '1', ' ']) {
    const p = resolveOrderPricing({ fields: HELD, couponId: bad });
    assert.equal(p.finalPrice, 68000, `${bad} が通っている`);
    assert.equal(p.discount, 0);
  }
});

test('価格を渡す口が無い（改ざんできない）', () => {
  // 余計な入力を渡しても無視される
  const p = resolveOrderPricing({
    fields: HELD, couponId: ID,
    discount: 60000, offerPrice: 1, finalPrice: 1, regularPrice: 1,
  });
  assert.equal(p.finalPrice, 58000);
  assert.equal(p.discount, 10000);
  assert.equal(p.regularPrice, 68000);
});

test('対象商品でなければ割引しない', () => {
  const p = resolveOrderPricing({ fields: HELD, couponId: ID, product: 'something_else' });
  assert.equal(p.discount, 0);
  assert.equal(p.reason, COUPON_APPLY_REJECT.WRONG_PRODUCT);
  assert.equal(COUPON_PRODUCT.PREMIUM_PLUS, 'premium_plus');
});

// ── 二重適用・再送 ──────────────────────────────────────────
test('二重適用しても 48,000円にならない', () => {
  const a = resolveOrderPricing({ fields: HELD, couponId: ID });
  const b = resolveOrderPricing({ fields: HELD, couponId: ID });
  const c = resolveOrderPricing({ fields: HELD, couponId: ID });
  assert.equal(a.finalPrice, 58000);
  assert.equal(b.finalPrice, 58000);
  assert.equal(c.finalPrice, 58000);
  assert.notEqual(a.finalPrice, 48000);
});

test('再読込・戻る・再送でも価格がぶれない', () => {
  const runs = Array.from({ length: 5 }, () => resolveOrderPricing({ fields: HELD, couponId: ID }));
  for (const r of runs) assert.deepEqual(r, runs[0]);
});

// ── 有効期限 ────────────────────────────────────────────────
test('有効期限が未確定のあいだは期限切れ扱いにしない（勝手に補完しない）', () => {
  const far = Date.parse('2099-12-31T00:00:00Z');
  const p = resolveOrderPricing({ fields: HELD, couponId: ID, nowMs: far });
  assert.equal(p.finalPrice, 58000, '未確定の期限で弾いている');
  const list = listApplicableCoupons({ fields: HELD, nowMs: far });
  assert.equal(list.length, 1);
  assert.match(list[0].expiryText, /未定/);
  assert.equal(list[0].expiryDetermined, false);
});

// ── 状態を変えない ──────────────────────────────────────────
test('適用は会員レコードを 1 バイトも書き換えない（純粋関数）', () => {
  const before = JSON.stringify(HELD);
  resolveOrderPricing({ fields: HELD, couponId: ID });
  listApplicableCoupons({ fields: HELD });
  assert.equal(JSON.stringify(HELD), before);
  const src = stripComments(read('./premiumPlusCouponApply.js'));
  for (const f of ['PremiumPlusSalePaused', 'PremiumPlusEligibility', 'PremiumPlusReleaseOverride',
    'プラン', 'PlanType', 'PaidAt', 'PaymentConfirmed', 'Status']) {
    assert.doesNotMatch(src, new RegExp(`${f}['"]?\\s*:`), `${f} を書いている`);
  }
  assert.doesNotMatch(src, /fetch\(|PATCH|POST/, 'I/O を持っている');
});

// ── 配線（申込 Function / API / 画面）────────────────────────
test('申込 Function はクライアントの金額を採用せずサーバー確定値を使う', () => {
  const fn = stripComments(read('../../../netlify/functions/bank-transfer-application.js'));
  assert.match(fn, /resolveOrderPricing\(/);
  assert.match(fn, /requestedAmount = pricing\.finalPrice/);
  // client からは couponId だけを読む
  assert.doesNotMatch(fn, /\bdiscount\s*[,}]/, 'client の割引額を読んでいる');
  assert.doesNotMatch(fn, /\bofferPrice\b/, 'client の適用価格を読んでいる');
  assert.doesNotMatch(fn, /\bfinalPrice\s*[,}]/, 'client の最終価格を読んでいる');
  // 販売停止の 403 は従来どおり残っている
  assert.match(fn, /code:\s*'sale_paused'/);
});

test('API は本人セッションだけで会員を決め、書き込みをしない', () => {
  const api = stripComments(read('../../pages/api/premium-plus-order.json.js'));
  assert.match(api, /verifyPlanAccess\(/);
  assert.match(api, /access\.payload\?\.sub/);
  assert.doesNotMatch(api, /method:\s*'(PATCH|POST|PUT|DELETE)'/);
  assert.doesNotMatch(api, /body\.(recordId|email|id)/);
  // POST でクーポンを確定させる口を作らない
  assert.match(api, /export function POST\(\)/);
});

test('申込画面は価格を送らず couponId だけ送る', () => {
  for (const f of ['../../pages/premium-plus.astro', '../../pages/premium-plus-v2.astro']) {
    const src = read(f);
    assert.match(src, /couponId: \(typeof window\.__akPpCouponId/, `${f}: couponId を送っていない`);
    const payload = src.slice(src.indexOf('const formData = {'), src.indexOf('const formData = {') + 1200);
    assert.doesNotMatch(payload, /discount|offerPrice|finalPrice/, `${f}: 価格を送っている`);
  }
});

test('クーポン UI は金額をハードコードしない', () => {
  const c = read('../../components/PremiumPlusCouponApply.astro');
  assert.doesNotMatch(c, /68,?000|58,?000|10,?000/, '金額を直書きしている');
  assert.match(c, /premium-plus-order\.json/);
  // 未所持なら描画しない
  assert.match(c, /hidden/);
  assert.match(c, /if \(!coupons\.length\) \{ block\.hidden = true; return; \}/);
});
