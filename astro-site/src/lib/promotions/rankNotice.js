/**
 * rankNotice.js — 会員ランク別の「常設お知らせ」の単一源（純粋・I/O なし）
 *
 * ## なぜ要るか（2026-09-08 / MK 指示）
 *
 * > 期限が切れたら自動で新しい通知にしたい　会員ランクに応じたお知らせ
 *
 * Premium Plus の再募集クーポンが期限切れになると、それまで出ていた
 * 「お使いいただけるクーポンがあります」が消える（使えないものを使えると言わないため）。
 * ところが**三連複会員はキャンペーン割引の対象外**（最上位で売るものが無い）なので、
 * そのあとお知らせが 1 件も無くなり、ベルが空になっていた。
 *
 * ここは「他に出すお知らせが無いとき」に出す**土台のお知らせ**を決める。
 *
 * ## 位置づけ（ここで決めないこと）
 *
 * - **クーポン・キャンペーン割引より優先しない。** 具体的な行動（受け取る・使う・
 *   割引で買う）があるお知らせが 1 件でもあるときは、そちらだけを出す。
 *   まとめ役 `describeAllNotices()` がフォールバックとして扱う。
 * - **金額を持たない。** 価格・割引額は別の単一源（`promotionOfferCatalog.js` /
 *   各商品ページ）にあり、ここに書き写すと二重管理になる。案内先の URL だけを持つ。
 * - **権限を配らない。** これは案内であって、付与でも割引でもない。
 *
 * ## 出し分け（`resolveEntitlements()` の結果で決める）
 *
 * | いまのご契約 | ご案内 |
 * |---|---|
 * | 無料 | 有料プランのご案内（/pricing/）|
 * | Light | Premium のご案内（/pricing/）|
 * | Premium（三連複なし）| 三連複のご案内（/sanrenpuku-demo/）|
 * | 三連複あり・**販売中** | Premium Plus の募集再開のお知らせ（/premium-plus-v2/）|
 * | 三連複あり・**販売停止中** | **出さない**（2026-09-08 MK 確定）|
 *
 * ## 販売停止中に出さない理由（2026-09-08 MK 確定・変更禁止）
 *
 * 停止中は Premium Plus について**お知らせを 1 件も出さない**。
 * 「募集再開をお待ちください」を常設すると、お客様にできることが何も無いお知らせが
 * ベルに残り続ける。**再開したときにだけ**「募集を再開しました」を出す。
 *
 * ⚠️ **すでに持っているものは勧めない**（`campaignOffers.js` と同じ原則）。
 * ⚠️ **存在秘匿**: Premium Plus に触れてよいのは `plusAllowed`（= upsell の channel が
 *    plus）のときだけ。三連複というランクだけで判断しない。管理画面で対象外に
 *    設定された方に商品名を出さない。
 * ⚠️ **独自判定を作らない**（2026-09-08 MK 確定）。存在秘匿・販売資格・停止判定は
 *    すべて呼び出し側が既存の単一源から解決して渡す:
 *      plusAllowed     … `resolveUpsellForCustomer().channel === UPSELL_CHANNEL.PLUS`
 *      plusPurchasable … `resolveUpsellForCustomer().plus.purchaseEnabled`
 *      reopenStartsAt  … `loadReopenStart()`（会員ごとの再募集開始日時）
 *    このモジュールで日付比較や販売可否を再計算しないこと。
 */

/** 案内先（URL は**ここだけ**が持つ。画面で組み立てない） */
export const RANK_NOTICE_HREF = Object.freeze({
  PRICING: '/pricing/',
  SANRENPUKU: '/sanrenpuku-demo/',
  PLUS: '/premium-plus-v2/',
});

/** 文言（画面で作らない）*/
const TEXT = Object.freeze({
  free: '有料プランのご案内',
  light: 'Premium のご案内',
  premium: '三連複のご案内',
  // 停止中の文言は**持たない**。停止中は出さないと確定しているので、
  // 文言を残すと「いつか出す」と誤読されて復活する
  plus_reopened: 'Premium Plus の募集を再開しました',
});

/**
 * ランク別の常設お知らせを 1 つ返す（無ければ `show: false`）。
 *
 * @param {{
 *   entitlements?: { canViewLight?: boolean, canViewPremium?: boolean, canViewSanrenpuku?: boolean },
 *   plusAllowed?: boolean,     // upsell の channel が plus（= Plus を案内してよい相手）
 *   plusPurchasable?: boolean, // いま購入できるか（停止中は false）＝停止判定の単一源
 *   reopenStartsAt?: string,   // その会員の再募集開始日時（`loadReopenStart().startsAtIso`）
 * }} input
 * @returns {{ show: boolean, kind: string, label: string, href: string, signature: string, count: number }}
 */
export function describeRankNotice({
  entitlements, plusAllowed, plusPurchasable, reopenStartsAt,
} = {}) {
  const e = entitlements || {};
  const none = { show: false, kind: '', label: '', href: '', signature: '', count: 0 };
  const out = (key, href, suffix = '') => ({
    show: true,
    kind: 'rank',
    label: TEXT[key],
    href,
    // ⚠️ 中身から決まる signature。ランクが変わったときだけ「新しいお知らせ」になる
    //    （毎回赤い点が出ると、他の本当に新しいお知らせが埋もれる）。
    //    募集再開だけは**開始日時を含める**。再開のたびに別のお知らせとして
    //    赤い点が出ないと「再開したら自動で表示」が 2 回目以降に働かない。
    signature: `rank:${key}${suffix}`,
    count: 1,
  });

  if (e.canViewSanrenpuku === true) {
    // 最上位。売るものは Premium Plus だけで、**案内してよい相手にしか触れない**
    if (plusAllowed !== true) return none;
    // 停止中は Premium Plus のお知らせを出さない（2026-09-08 MK 確定）。
    // 停止判定は呼び出し側が渡す `plusPurchasable` だけを見る（ここで再計算しない）。
    if (plusPurchasable !== true) return none;
    const at = String(reopenStartsAt || '').trim();
    return out('plus_reopened', RANK_NOTICE_HREF.PLUS, at ? `:${at}` : '');
  }
  if (e.canViewPremium === true) return out('premium', RANK_NOTICE_HREF.SANRENPUKU);
  if (e.canViewLight === true) return out('light', RANK_NOTICE_HREF.PRICING);
  return out('free', RANK_NOTICE_HREF.PRICING);
}
