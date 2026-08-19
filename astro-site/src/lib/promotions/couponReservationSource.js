/**
 * couponReservationSource.js — offer 台帳のうち「クーポン利用予約」を見分ける印（純粋・最小）
 *
 * `PromotionalOffers` には 2 種類の行が混ざりうる:
 *   1. 管理者が発行した**販促オファー**（割引を提示した）
 *   2. 顧客がクーポンを使って申し込んだ**利用予約**（入金確認待ち）
 *
 * 意味がまったく違うので、admin の分類で混ぜてはいけない。
 * 区別は既存列 `Source` だけで行う（**schema は増やさない**）。
 *
 * ⚠️ このモジュールは**販促側（marketing / promotions）からも読む**ため、
 *    Premium Plus の販売判定モジュールに依存させないこと
 *    （`adminMarketingFunction.guard.test.mjs` が「販売と販促の分離」を検査している）。
 */

/** 利用予約行の `Source` 値 */
export const RESERVATION_SOURCE = 'premium-plus-coupon-reservation';

/** その行がクーポンの利用予約か（通常の販促オファーと区別する唯一の判定） */
export function isReservationRow(record) {
  const f = (record && record.fields) || record || {};
  return String(f.Source || '').trim() === RESERVATION_SOURCE;
}
