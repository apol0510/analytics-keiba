/**
 * cardSales.js — カード決済（決済会社共通）の「どの環境で受け付けるか」の単一源（純粋・I/O なし）
 *
 * 2026-10-11 MK 確定: 直近の販売は銀行振込のみ。新規の月払いは停止したまま（MONTHLY_SALES_OPEN）。
 * 代替決済の候補は Paddle（第一）・PayPal（第二）。fincode は 2026-10-15 MK 決定で不使用・コードごと削除。Sandbox の準備は進めるが、
 * **本番での受付は、その決済会社が AK の取扱商品を承認したあと、MK の明示決定でこの表を変える PR だけ**で開く。
 * env では開かない（env を誤って入れても本番サイトでは受け付けない）。決済会社の準備が整っても自動では開かない。
 */

export const CARD_SALES_OPEN = Object.freeze({
  paddle: false, // 審査中（2026-10-15 MK 報告）。承認と MK の決定まで閉じたまま
  paypal: true, // 年払い・買い切りのカード一回払い（MK の決定＝この PR の merge）。PayPal 審査通過 2026-10-15・Sandbox E2E #796
});

export const PRODUCTION_ORIGIN = 'https://analytics.keiba.link';

/**
 * この決済会社を、このサイト（オリジン）で、この鍵の種類で使ってよいか。
 * - 本番サイト: 本番鍵 かつ CARD_SALES_OPEN[provider] のときだけ
 * - Deploy Preview / ローカル: テスト鍵（Sandbox）のときだけ
 * @param {{ provider: string, keyMode: 'test'|'live'|null, origin: string, salesOpen?: boolean }} input
 * @returns {{ ok: true, mode: 'test'|'live' } | { ok: false, reason: string }}
 */
export function resolveCardMode({ provider, keyMode, origin, salesOpen } = {}) {
  const open = salesOpen === undefined ? CARD_SALES_OPEN[provider] === true : salesOpen === true;
  if (keyMode !== 'test' && keyMode !== 'live') return { ok: false, reason: `${provider}_key_missing` };
  const isProdSite = String(origin || '') === PRODUCTION_ORIGIN;
  if (isProdSite) {
    if (keyMode !== 'live') return { ok: false, reason: 'test_key_on_production' };
    if (!open) return { ok: false, reason: 'card_sales_not_open' };
    return { ok: true, mode: 'live' };
  }
  if (keyMode !== 'test') return { ok: false, reason: 'live_key_outside_production' };
  return { ok: true, mode: 'test' };
}

/**
 * 2026-10-13 MK 確定: 決済会社は**冗長化**（利用停止・障害・契約終了に備える事業継続）であって、お客様に選ばせる併設ではない。
 * - お客様に見せるのは「カードで支払う」1 本だけ（`card-create-checkout`）。決済会社の選択 UI は作らない。
 * - 本番で新しい申込を受ける決済会社は ACTIVE_CARD_PROVIDER の 1 社だけ。切替は運営側がこの値を変える PR で行う
 *   （env では切り替えない＝誤設定で 2 社同時受付・意図しない切替をしない）。
 * - 第一優先 Paddle、予備 PayPal。
 * - 切替えても、既に作られた取引の確定・返金の反映（Webhook・capture）は元の決済会社で続ける。未確定の取引を別の決済会社へ自動で作り直さない。
 */
// 一回払いの受付を開けた PayPal を申込先にする（Paddle は審査中で受付できないため）。
// 役割（CARD_PROVIDER_ROLES: 第一 Paddle・予備 PayPal）は変えない。Paddle の承認後に戻すのは、この値を変える PR。
export const ACTIVE_CARD_PROVIDER = 'paypal';
export const CARD_PROVIDER_ROLES = Object.freeze({ paddle: 'primary', paypal: 'standby' });

/**
 * 新しい申込（取引の作成）を始めてよいか。確定・返金の反映には使わない（そちらは resolveCardMode だけ）。
 * - test（Sandbox）: 各社の検証のため、どの決済会社・どの入口でも可
 * - live（本番）: 共通入口（entry='card'）から、ACTIVE_CARD_PROVIDER への申込だけ
 * @param {{ provider: string, mode: 'test'|'live', entry?: 'card'|'direct', active?: string }} input
 */
export function checkoutProviderGate({ provider, mode, entry = 'direct', active = ACTIVE_CARD_PROVIDER } = {}) {
  if (mode === 'test') return { ok: true };
  if (mode !== 'live') return { ok: false, reason: 'mode_unknown' };
  if (entry !== 'card') return { ok: false, reason: 'use_card_checkout' };
  if (provider !== active) return { ok: false, reason: 'provider_not_active' };
  return { ok: true };
}

/**
 * 月額の定期課金（2026-10-15 MK 決定）: 「PayPal で先に進める。PayPal は月額の定期課金で決済を受け付ける。
 * 年払い・買い切りは銀行振込を維持。銀行振込の 1 ヶ月プランは停止のまま。Paddle がメイン」。
 * - 商品・価格・権利・退会は既存の月額の確定仕様（spec「Stripe 定期購読」2026-10-02・即時退会 2026-10-07）と同じ
 *   （Premium ¥4,980・中央版 ¥2,980・南関版 ¥2,980／月）。Stripe の新規月払い（MONTHLY_SALES_OPEN）は閉じたまま。
 * - お客様に決済会社を選ばせない（冗長化 2026-10-13 と同じ）。共通入口 `monthly-create-checkout` から
 *   ACTIVE_SUBSCRIPTION_PROVIDER の 1 社だけ。自動フォールバックしない。
 * - 本番の受付はこの表を true にする PR だけで開く（env では開かない）。一回払い（CARD_SALES_OPEN）とは別の表。
 */
export const SUBSCRIPTION_SALES_OPEN = Object.freeze({
  paypal: true, // 2026-10-15 MK 決定で受付開始（Live の Plan・Webhook・production env 設定済み）
});
export const ACTIVE_SUBSCRIPTION_PROVIDER = 'paypal';

/** 月額の申込を始めてよいか（live は共通入口 entry='monthly' から ACTIVE_SUBSCRIPTION_PROVIDER だけ）*/
export function subscriptionProviderGate({ provider, mode, entry = 'direct', active = ACTIVE_SUBSCRIPTION_PROVIDER } = {}) {
  if (mode === 'test') return { ok: true };
  if (mode !== 'live') return { ok: false, reason: 'mode_unknown' };
  if (entry !== 'monthly') return { ok: false, reason: 'use_monthly_checkout' };
  if (provider !== active) return { ok: false, reason: 'provider_not_active' };
  return { ok: true };
}
