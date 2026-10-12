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

/**
 * 2026-10-13 MK 確定: 決済会社は**冗長化**（利用停止・障害・契約終了に備える事業継続）であって、お客様に選ばせる併設ではない。
 * - お客様に見せるのは「カードで支払う」1 本だけ（`card-create-checkout`）。決済会社の選択 UI は作らない。
 * - 本番で新しい申込を受ける決済会社は ACTIVE_CARD_PROVIDER の 1 社だけ。切替は運営側がこの値を変える PR で行う
 *   （env では切り替えない＝誤設定で 2 社同時受付・意図しない切替をしない）。
 * - 第一優先 Paddle、予備 PayPal。fincode は審査結果待ちの候補のまま（役割・販売停止状態は変えない）。
 * - 切替えても、既に作られた取引の確定・返金の反映（Webhook・capture）は元の決済会社で続ける。未確定の取引を別の決済会社へ自動で作り直さない。
 */
export const ACTIVE_CARD_PROVIDER = 'paddle';
export const CARD_PROVIDER_ROLES = Object.freeze({ paddle: 'primary', paypal: 'standby', fincode: 'candidate' });

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
