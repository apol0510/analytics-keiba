/**
 * couponCatalog.js — **どんなクーポンが存在するか**の正本（純粋・I/O なし）
 *
 * ## 確定方針（2026-08-20 MK）
 *
 * クーポンは **Premium Plus 専用ではない**。今後ほかの商品・プランでも使う。
 * ここは「クーポン定義の一覧」で、**商品ごとに 1 つずつ足していく**。
 *
 * ## 1 件の定義が持つもの
 *
 * | 項目 | 意味 |
 * |---|---|
 * | `couponId` / `version` | クーポンの識別（保存値は `couponId@vN`）|
 * | `productKey` | **どの商品に使えるか**（`PRODUCT_KEY`。価格の正本と同じ語彙）|
 * | `name` / `description` | 顧客に見せる名前・説明 |
 * | `terms` | 割引条件・有効期限（**商品ごとに MK が決める**）|
 * | `bindingId` | 保有状態をどこに置くか（binding の識別子）|
 *
 * ## まだ決まっていないもの（**創作しない**）
 *
 * Premium Plus 以外でどの商品に入れるか / 各商品の割引額・率 / 有効期限 /
 * 配布条件 / 併用可否 / 自動付与条件 は **未確定**。
 * 商品ごとに MK が決めてから、このファイルへ 1 件足す。
 * ⚠️ 決まっていない条件を既定値で埋めない（`terms.determined = false` のまま置く）。
 *
 * ## 併用可否は「まだ無い」ので**併用させない**
 *
 * 複数クーポンの併用ルールが未確定なので、いまは
 * `resolveApplicableCoupons()` が **1 商品につき 1 枚**しか返さない（fail closed）。
 * 併用が必要になったら、ここに規則を足す（呼び出し側に判断を分散させない）。
 */

import { PRODUCT_KEY } from './couponPlatform.js';
import { PP_REOPEN_COUPON } from '../premiumPlus/premiumPlusReopenCoupon.js';

/** 保有状態の置き場所（binding）の識別子 */
export const COUPON_BINDING = Object.freeze({
  /**
   * Customers の `PremiumPlusReopenCoupon*` 3 列。
   * ⚠️ **Premium Plus の再募集クーポン専用**。2 商品目でこの列を再利用しない
   *    （1 会員が複数クーポンを持てないため）。共通の保有テーブルは未作成。
   */
  PP_REOPEN_COLUMNS: 'customers.premium_plus_reopen_columns',
});

/**
 * クーポン定義の一覧（**正本**）。
 *
 * ⚠️ 定義の中身（割引額・期限）は**各商品の単一源から取る**。ここで数値を書き写さない。
 */
export const COUPON_DEFINITIONS = Object.freeze([
  Object.freeze({
    couponId: PP_REOPEN_COUPON.couponId,
    version: PP_REOPEN_COUPON.version,
    /** 共通クーポン基盤の**最初の利用商品** */
    productKey: PRODUCT_KEY.PREMIUM_PLUS,
    name: PP_REOPEN_COUPON.name,
    description: PP_REOPEN_COUPON.description,
    /** 条件の正本は `premiumPlusReopenCoupon.js`（10,000円OFF / 68,000→58,000 / 開始+14日）*/
    terms: PP_REOPEN_COUPON.terms,
    bindingId: COUPON_BINDING.PP_REOPEN_COLUMNS,
    enabled: true,
  }),
]);

/** `couponId@vN` 形式の保存値（**保存も比較もこの形**） */
export function couponKey(def) {
  return def ? `${def.couponId}@v${def.version}` : '';
}

/** couponId（version 有無どちらでも）から定義を引く */
export function findCoupon(idOrKey) {
  const raw = String(idOrKey || '').trim();
  if (!raw) return null;
  const bare = raw.split('@')[0];
  const wantVersion = raw.includes('@v') ? Number(raw.split('@v')[1]) : null;
  return COUPON_DEFINITIONS.find((d) => d.couponId === bare
    && (wantVersion === null || d.version === wantVersion)) || null;
}

/** その商品に使えるクーポン定義（**有効なものだけ**） */
export function couponsForProduct(productKey) {
  return COUPON_DEFINITIONS.filter((d) => d.productKey === productKey && d.enabled !== false);
}

/**
 * いまこの会員がこの商品へ適用できるクーポン。
 *
 * ⚠️ **併用可否が未確定なので 1 枚まで**（fail closed）。
 * ⚠️ 所持の判定は呼び出し側が binding 経由で行う。ここは定義の絞り込みだけ。
 *
 * @param {{ productKey: string, heldCouponKeys?: string[] }} input
 */
export function resolveApplicableCoupons({ productKey, heldCouponKeys = [] } = {}) {
  const held = new Set((heldCouponKeys || []).map((k) => String(k || '').trim()).filter(Boolean));
  const usable = couponsForProduct(productKey).filter((d) => held.has(couponKey(d)));
  // 併用ルールが無いあいだは**先頭 1 枚だけ**。2 枚目を黙って足さない
  return usable.slice(0, 1);
}

/** 商品ごとのクーポン件数（管理画面の見出し用） */
export function summarizeCatalog() {
  const byProduct = {};
  for (const d of COUPON_DEFINITIONS) {
    byProduct[d.productKey] = (byProduct[d.productKey] || 0) + 1;
  }
  return { total: COUPON_DEFINITIONS.length, byProduct };
}
