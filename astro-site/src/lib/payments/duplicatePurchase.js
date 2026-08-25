/**
 * duplicatePurchase.js — 「すでにお持ちの商品を、もう一度お申し込みしていないか」の単一源
 * （純粋関数・I/O なし）
 *
 * ## なぜ要るか（2026-08-25）
 *
 * 三連複は買い切りの**追加権**で、Airtable では `プラン` ではなく
 * 別フィールド `LifetimeSanrenpuku` が持つ。そのため購入後も `プラン` は `'Premium'` のまま。
 * 画面の出し分けがプラン名だけを見ていると、**買った当日でも
 * 「三連複 買い切り 10,000円OFF」の案内が出続ける**（実在の会員で発生）。
 *
 * 案内の側は直したが、それだけでは
 *   - 端末に残った古い契約情報
 *   - 古いタブ・ブックマーク・戻るボタン
 * から申込が飛ぶ経路が残る。**お金が動く側で止める**のが最後の砦。
 *
 * ⚠️ 判定材料は `resolveEntitlements()` の戻り値だけ。画面からの申告は見ない。
 * ⚠️ 権利を確認できないときは**止めない**（fail open）。
 *    ここで止めすぎると、本当に買いたい方の申込を落とす。
 *    二重課金は入金確認（人の目）で気づけるが、買えないことには誰も気づけない。
 */

/** 断る理由（呼び出し側はそのまま返す） */
export const DUPLICATE_PURCHASE = Object.freeze({
  SANRENPUKU_OWNED: 'sanrenpuku_already_owned',
});

const MESSAGE = Object.freeze({
  [DUPLICATE_PURCHASE.SANRENPUKU_OWNED]:
    '三連複プランはすでにお持ちです。マイページからご覧いただけます。'
    + 'ご不明な点がございましたら、お問い合わせください。',
});

/**
 * @param {{ planName?: string, planType?: string, entitlements?: object }} input
 *   `planName` / `planType` は申込 Function の語彙（`RequestedPlan` / `RequestedPlanType`）
 * @returns {{ blocked: boolean, reason: string, message: string }}
 */
export function resolveDuplicatePurchase({ planName, planType, entitlements } = {}) {
  const ok = { blocked: false, reason: '', message: '' };
  const e = entitlements || {};
  const name = String(planName || '').trim().toLowerCase();

  // 三連複の申込だけを見る（他の商品は更新・乗り換えがあるので止めない）
  if (name !== 'premium sanrenpuku') return ok;
  // ⚠️ true と**確認できたときだけ**止める（未確認・undefined では止めない）
  if (e.canViewSanrenpuku !== true) return ok;

  return {
    blocked: true,
    reason: DUPLICATE_PURCHASE.SANRENPUKU_OWNED,
    message: MESSAGE[DUPLICATE_PURCHASE.SANRENPUKU_OWNED],
  };
}
