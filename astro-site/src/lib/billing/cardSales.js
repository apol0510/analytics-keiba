/**
 * cardSales.js — カード決済（決済会社共通）の「どの環境で受け付けるか」の単一源（純粋・I/O なし）
 *
 * 2026-10-11 MK 確定: 直近の販売は銀行振込のみ。新規の月払いは停止したまま（MONTHLY_SALES_OPEN）。
 * 代替決済の候補は Paddle（第一）・PayPal（第二）・fincode（審査結果待ち）。Sandbox の準備は進めるが、
 * **本番での受付は、その決済会社が AK の取扱商品を承認したあと、MK の明示決定でこの表を変える PR だけ**で開く。
 * env では開かない（env を誤って入れても本番サイトでは受け付けない）。決済会社の準備が整っても自動では開かない。
 */

export const CARD_SALES_OPEN = Object.freeze({
  paddle: false,
  paypal: false,
  fincode: false,
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
