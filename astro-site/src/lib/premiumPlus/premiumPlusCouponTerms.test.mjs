/**
 * premiumPlusCouponTerms.test.mjs — 確定した優待条件（10,000円OFF / 68,000円 → 58,000円）
 *
 * 固定する仕様:
 *   - 割引額・通常価格・適用価格の**単一源が 1 つだけ**で、全表示面が同じ値になる
 *   - 通常価格は商品ページの実売価格と一致する（ズレたら落ちる）
 *   - 適用価格は引き算で導出（68,000 と 58,000 を別々に書かない）
 *   - **二重割引・二重適用が起きない**
 *   - 有効期限は未確定のまま（勝手に補完しない）
 *   - 再募集の offer はまだ実体化していない（＝ 2 つ目の価格経路が無い）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
/** 説明コメントを落として**実コード**だけを見る（解説文の数値を誤検知しない） */
const code = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const {
  PP_REOPEN_COUPON, PP_REOPEN_COUPON_DISCOUNT_YEN,
  describeCouponTerms, describeCouponDiscount, describeCouponPrice, describeCouponExpiry,
  resolveCouponPrice, describeCouponForMember, formatYen, buildReopenCouponClaimFields,
} = await import('./premiumPlusReopenCoupon.js');
const { REGULAR_PRICE, PROMOTION_OFFERS, OFFER_KIND } = await import('../promotions/promotionOfferCatalog.js');
const { renderPauseNoticeHtml, renderCouponPageHtml } = await import('./premiumPlusPauseNoticePage.js');

const DISCOUNT = 10000;
const REGULAR = 68000;
const OFFER = 58000;

// ── 単一源 ──────────────────────────────────────────────────
test('割引額の定義は 1 か所だけ（10,000円）', () => {
  assert.equal(PP_REOPEN_COUPON_DISCOUNT_YEN, DISCOUNT);
  assert.equal(PP_REOPEN_COUPON.terms.discountValue, DISCOUNT);
});

test('通常価格は価格の正本（REGULAR_PRICE.premium_plus）から取る', () => {
  assert.equal(REGULAR_PRICE.premium_plus, REGULAR);
  assert.equal(PP_REOPEN_COUPON.terms.regularPrice, REGULAR_PRICE.premium_plus);
});

test('通常価格が商品ページの実売価格と一致する（ズレたら落ちる）', () => {
  for (const f of ['../../pages/premium-plus.astro', '../../pages/premium-plus-v2.astro']) {
    const m = /const PRICE = (\d+);/.exec(read(f));
    assert.ok(m, `${f}: PRICE を読み取れない`);
    assert.equal(Number(m[1]), REGULAR_PRICE.premium_plus, `${f}: 商品ページの価格と正本がズレている`);
  }
});

test('適用価格は引き算で導出している（58,000 を直書きしない）', () => {
  assert.equal(PP_REOPEN_COUPON.terms.offerPrice, OFFER);
  assert.equal(PP_REOPEN_COUPON.terms.regularPrice - PP_REOPEN_COUPON.terms.discountValue, OFFER);
  // 実コード（コメントを除く）に 58000 が無いこと
  assert.doesNotMatch(code(read('./premiumPlusReopenCoupon.js')), /58000/, '適用価格を直書きしている');
});

// ── 二重割引の防止 ───────────────────────────────────────────
test('価格計算は入力価格を無視する（二重割引が構造的に起きない）', () => {
  const a = resolveCouponPrice();
  // 既に割引済みの価格を渡しても結果は変わらない（引数から引き算しない）
  const b = resolveCouponPrice({ terms: { ...PP_REOPEN_COUPON.terms } });
  assert.deepEqual(a, b);
  assert.equal(a.offerPrice, OFFER);
  // 2 回「適用」しても 48,000 にはならない
  assert.notEqual(a.offerPrice, REGULAR - DISCOUNT * 2);
  // 実装が「渡された現在価格」から引くコードを持っていない
  const src = code(read('./premiumPlusReopenCoupon.js'));
  assert.doesNotMatch(src, /currentPrice|basePrice|price\s*-\s*discount/i, '入力価格から引き算している');
});

test('再募集の purchase_offer はまだ実体化していない（2 つ目の価格経路が無い）', () => {
  const plus = PROMOTION_OFFERS.filter((o) => /plus/i.test(o.offerId) || /Plus/.test(o.name));
  assert.equal(plus.length, 0, 'Premium Plus の offer が増えている。単一源との整合テストを先に足すこと');
});

test('将来 Premium Plus の offer を足すときは単一源と一致させる', () => {
  const plus = PROMOTION_OFFERS.filter((o) => /plus/i.test(o.offerId));
  for (const o of plus) {
    // 足された瞬間から検査が効く（10,000円OFF / 58,000円 以外は落ちる）
    assert.equal(o.kind, OFFER_KIND.PURCHASE, `${o.offerId}: 無料付与になっている`);
    assert.equal(o.regularPrice, REGULAR_PRICE.premium_plus, `${o.offerId}: 通常価格がズレている`);
    assert.equal(o.offerPrice, PP_REOPEN_COUPON.terms.offerPrice, `${o.offerId}: 適用価格がズレている`);
    assert.equal(o.discountValue, PP_REOPEN_COUPON.terms.discountValue, `${o.offerId}: 割引額がズレている`);
  }
});

// ── 表示 ────────────────────────────────────────────────────
test('文言はすべて単一源から作られ、全画面で同一', () => {
  assert.equal(describeCouponDiscount(), '10,000円OFF');
  assert.equal(describeCouponPrice(), '通常 68,000円 → 58,000円');
  assert.equal(describeCouponTerms(), '10,000円OFF（通常 68,000円 → 58,000円）');
  assert.equal(formatYen(58000), '58,000円');

  const v = describeCouponForMember({ coupon: { claimed: true, claimedAtIso: '2026-08-18T22:07:54.803Z' }, paused: true, claimable: false });
  for (const html of [renderPauseNoticeHtml({ coupon: v }), renderCouponPageHtml({ coupon: v })]) {
    assert.ok(html.includes(describeCouponDiscount()), '割引額が画面に出ていない');
    assert.ok(html.includes(describeCouponPrice()), '価格が画面に出ていない');
  }
});

// ── 有効期限 ────────────────────────────────────────────────
test('有効期限のルールは確定（再募集開始日 + 14日）だが、具体的な日付はまだ作らない', () => {
  // ルール: 14 日。開始日時（reopenStartsAt）は未定なので絶対日時は出さない
  assert.equal(PP_REOPEN_COUPON.terms.expiryDays, 14);
  assert.equal(PP_REOPEN_COUPON.terms.reopenStartsAt, null);
  assert.equal(PP_REOPEN_COUPON.terms.expiresAt, null);
  assert.equal(PP_REOPEN_COUPON.terms.expiresDetermined, false);
  const txt = describeCouponExpiry();
  assert.match(txt, /14日間/);
  assert.doesNotMatch(txt, /\d{4}-\d{2}-\d{2}|\d+月\d+日/, '具体的な日付を作っている');
});

// ── クーポンは権利でも購入可否でもない ────────────────────────
test('条件確定でも salePaused / 販売可否には一切触れない', () => {
  // 書き込んでよいのはクーポン 3 列だけ（条件確定で増えていない）
  const built = buildReopenCouponClaimFields({ current: {}, now: Date.UTC(2026, 7, 19), enabled: true });
  assert.deepEqual(Object.keys(built.fields).sort(), [
    'PremiumPlusReopenCouponClaimedAt', 'PremiumPlusReopenCouponId', 'PremiumPlusReopenCouponSource',
  ].sort());
  // 価格情報を返すだけで、購入可否（salePaused / 販売できるか）は返さない
  const p = resolveCouponPrice();
  assert.deepEqual(Object.keys(p).sort(), ['discountType', 'discountValue', 'offerPrice', 'regularPrice']);
  assert.ok(!('salePaused' in p) && !('purchasable' in p) && !('canPurchase' in p));
});
