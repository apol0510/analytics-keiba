/**
 * checkoutResponse.js — 申込の入口（monthly-create-checkout）がお客様へ返す本文
 *
 * 2026-11-27: Paddle の申込は「請求される額」（price）を返していたが、入口が url・subscription・provider だけを返していたため、
 * 料金ページの「特別価格の対象外 → 通常価格で決済へ進む」の案内が出ず、GA4 begin_checkout にも金額が付かなかった。
 * 返すのは金額と特別価格の有無だけ（会員 ID・メールは返さない）。形が崩れた price は返さない（画面は従来どおり進む）。
 */
const yen = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/** 決済会社の申込結果の price を、お客様へ返してよい形に絞る。不正なら null */
export function publicCheckoutPrice(price) {
  if (!price || typeof price !== 'object') return null;
  const firstYen = yen(price.firstYen);
  const regularYen = yen(price.regularYen);
  const discountYen = yen(price.discountYen);
  if (firstYen === null || regularYen === null || discountYen === null || typeof price.campaign !== 'boolean') return null;
  return { firstYen, regularYen, discountYen, campaign: price.campaign };
}

/** 申込成功時の本文（url・subscription・provider と、あれば price） */
export function checkoutResponseBody(r) {
  const price = publicCheckoutPrice(r?.price);
  return { url: r.url, subscription: r.subscriptionId, provider: r.provider, ...(price ? { price } : {}) };
}
