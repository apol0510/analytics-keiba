/**
 * campaignControl.js — キャンペーンの「いま配ってよいか」の単一源（純粋・I/O なし）
 *
 * ## 3 つの条件（すべて満たしたときだけ配る）
 *
 * 1. **開催期間内**（`campaignOffers.js` の窓）
 * 2. **運営が止めていない**（管理画面の停止スイッチ）
 * 3. **その会員が除外されていない**（管理画面の個別除外）
 *
 * ## 読めないときは配らない（fail closed）
 *
 * 停止スイッチ・除外リストを読めないまま割引を出すと、
 * **止めたはずの割引が出続ける**。お金が動く側の事故なので、
 * 確認できないときは**配らない**方へ倒す。
 *
 * ⚠️ 逆（読めないから配る）にしないこと。運営が止められない状態になる。
 */

/** 配らない理由（画面・ログにそのまま出す） */
export const CAMPAIGN_BLOCK = Object.freeze({
  /** 開催期間外 */
  OUTSIDE_WINDOW: 'outside_window',
  /** 運営が停止している */
  PAUSED: 'paused',
  /** この会員は対象外にしている */
  EXCLUDED: 'excluded',
  /** 停止スイッチ・除外リストを読めていない */
  UNKNOWN: 'control_unavailable',
});

export const CAMPAIGN_BLOCK_TEXT = Object.freeze({
  outside_window: '開催期間外です。',
  paused: '運営が停止しています。',
  excluded: 'この会員は対象外に設定されています。',
  control_unavailable: '停止スイッチ・除外リストを確認できないため、割引を出していません。'
    + '確認できないまま出すと、止めたはずの割引が出続けます。',
});

/**
 * いまこの会員へ配ってよいか。
 *
 * @param {{ withinWindow?: boolean,
 *           control?: { available?: boolean, paused?: boolean },
 *           excluded?: boolean|null }} input
 *   `excluded` は null（判断できない）を許す
 * @returns {{ allowed: boolean, reason: string, note: string }}
 */
export function resolveCampaignAllowed({ withinWindow, control, excluded } = {}) {
  const no = (reason) => ({ allowed: false, reason, note: CAMPAIGN_BLOCK_TEXT[reason] || '' });
  const c = control || {};
  // ⚠️ 順序に意味がある。「期間外」を先に返すと、停止していても
  //    期間外としか出ず、運営が「止まっているのか期限切れか」を判別できない。
  //    ただし期間外は最も外側の事実なので、先に返して良い（止める必要すら無い）。
  if (withinWindow !== true) return no(CAMPAIGN_BLOCK.OUTSIDE_WINDOW);
  if (c.available !== true) return no(CAMPAIGN_BLOCK.UNKNOWN);
  if (c.paused === true) return no(CAMPAIGN_BLOCK.PAUSED);
  if (excluded !== false) {
    // true（除外済み）も null（判断できない）も配らない
    return no(excluded === true ? CAMPAIGN_BLOCK.EXCLUDED : CAMPAIGN_BLOCK.UNKNOWN);
  }
  return { allowed: true, reason: '', note: '' };
}

/** 管理画面に出す状態の 1 行 */
export function describeCampaignControl({ control, withinWindow, excludedCount } = {}) {
  const c = control || {};
  if (c.available !== true) {
    return {
      state: 'unavailable',
      label: '⚠️ 確認できない',
      note: CAMPAIGN_BLOCK_TEXT.control_unavailable,
      excludedCountText: '確認できない',
    };
  }
  const n = Number.isFinite(excludedCount) ? excludedCount : null;
  const excludedCountText = n === null ? '確認できない' : `${n} 名`;
  if (c.paused === true) {
    return { state: 'paused', label: '⏸ 停止中', note: '配布を止めています。', excludedCountText };
  }
  if (withinWindow !== true) {
    return {
      state: 'outside', label: '開催期間外',
      note: '期間内になると自動的に配布が始まります。', excludedCountText,
    };
  }
  return { state: 'live', label: '✅ 配布中', note: '', excludedCountText };
}
