/**
 * couponCatalog.test.mjs — クーポン定義の正本
 *
 * 固定すること:
 *   - Premium Plus は**最初の 1 件**であって特別扱いではない
 *   - 定義の中身は**各商品の単一源**から取る（数値を書き写さない）
 *   - 未確定の条件を既定値で埋めない
 *   - 併用可否が未確定なので **1 商品につき 1 枚まで**（fail closed）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const C = await import('./couponCatalog.js');
const { PRODUCT_KEY } = await import('./couponPlatform.js');
const { PP_REOPEN_COUPON } = await import('../premiumPlus/premiumPlusReopenCoupon.js');
const { REGULAR_PRICE } = await import('../promotions/promotionOfferCatalog.js');

test('商品識別子は価格の正本と同じ語彙（新しい語彙を作らない）', () => {
  for (const key of Object.values(PRODUCT_KEY)) {
    assert.ok(key in REGULAR_PRICE, `${key} が REGULAR_PRICE に無い`);
  }
});

test('定義はどれも商品識別子とクーポン識別子を持つ', () => {
  assert.ok(C.COUPON_DEFINITIONS.length >= 1);
  for (const d of C.COUPON_DEFINITIONS) {
    assert.ok(Object.values(PRODUCT_KEY).includes(d.productKey), d.couponId);
    assert.ok(d.couponId && Number.isFinite(d.version), d.couponId);
    assert.ok(d.bindingId, `${d.couponId}: 保有状態の置き場所が未指定`);
    assert.match(C.couponKey(d), /@v\d+$/);
  }
});

test('Premium Plus の定義は単一源の値をそのまま参照している（写していない）', () => {
  const pp = C.findCoupon(PP_REOPEN_COUPON.couponId);
  assert.ok(pp);
  assert.equal(pp.productKey, PRODUCT_KEY.PREMIUM_PLUS);
  // 同一オブジェクト参照（写した瞬間にズレるのを防ぐ）
  assert.equal(pp.terms, PP_REOPEN_COUPON.terms);
  assert.equal(pp.terms.regularPrice, REGULAR_PRICE.premium_plus);
});

test('couponId / couponId@vN のどちらでも引ける', () => {
  const id = PP_REOPEN_COUPON.couponId;
  assert.ok(C.findCoupon(id));
  assert.ok(C.findCoupon(`${id}@v${PP_REOPEN_COUPON.version}`));
  assert.equal(C.findCoupon(`${id}@v99`), null, '存在しない版を引けてしまう');
  assert.equal(C.findCoupon(''), null);
  assert.equal(C.findCoupon('unknown-coupon'), null);
});

test('併用可否が未確定なので 1 商品につき 1 枚までしか返さない', () => {
  const key = C.couponKey(C.COUPON_DEFINITIONS[0]);
  const got = C.resolveApplicableCoupons({
    productKey: PRODUCT_KEY.PREMIUM_PLUS, heldCouponKeys: [key, key],
  });
  assert.equal(got.length, 1);
  // 所持していないクーポンは返さない
  assert.equal(C.resolveApplicableCoupons({
    productKey: PRODUCT_KEY.PREMIUM_PLUS, heldCouponKeys: [],
  }).length, 0);
  // 別商品のクーポンは混ざらない
  assert.equal(C.resolveApplicableCoupons({
    productKey: PRODUCT_KEY.LIGHT_MONTHLY, heldCouponKeys: [key],
  }).length, 0);
});

test('未確定の条件を既定値で埋めていない', () => {
  const pp = C.findCoupon(PP_REOPEN_COUPON.couponId);
  // 有効期限は「開始日時が未定」なので確定していない（勝手に日付を作らない）
  assert.equal(pp.terms.expiresDetermined, false);
  assert.equal(pp.terms.expiresAt, null);
  assert.equal(pp.terms.reopenStartsAt, null);
});

test('商品ごとの件数を数えられる（admin の見出し用）', () => {
  const sum = C.summarizeCatalog();
  assert.equal(sum.total, C.COUPON_DEFINITIONS.length);
  assert.equal(sum.byProduct[PRODUCT_KEY.PREMIUM_PLUS], 1);
});
