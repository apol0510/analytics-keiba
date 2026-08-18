/**
 * premiumPlusAdminEligibilityAxis.js — 管理一覧の「販売資格の軸」を停止から切り離す（純粋）
 *
 * ## 直している事故
 *
 * 会員を一時停止すると `resolvePremiumPlusRelease` は denied を返す。denied は
 * `phase = LOCKED(1)` / `overrideApplied = false` なので、これをそのまま管理一覧へ流すと:
 *
 *   - 資格バッジが「即時販売」→「PHASE 1」に化ける
 *   - 「即時販売」の件数が減る（`rows.filter(r => r.overrideApplied)` のため）
 *
 * 保存値（`PremiumPlusEligibility` / `PremiumPlusReleaseOverride` /
 * `PremiumPlusEligibleAt`）は**一切変わっていない**のに、画面上は資格が下がったように見える。
 * これは確定仕様「**資格の軸は停止で動かさない**」「**eligibility と pause は別軸**」に反する。
 *
 * ## 直し方
 *
 * 停止中の会員だけ、**停止フラグを外した状態**で同じ単一源をもう一度解決し、
 * その結果を「資格の軸」の表示（phase / overrideApplied）に使う。
 * 判定ロジックを書き写さないので、停止していない会員との差が構造的に生まれない。
 *
 * ⚠️ **顧客向けの表示・申込の可否には使わないこと。** それらは停止を反映した本来の
 *    release（`upsellChannel` / `state` / `showProductPage` など）が正本。
 *    ここが返すのは**管理画面で資格を読むためだけ**の軸。
 */

import { PP_SALE_PAUSE_FIELDS } from './premiumPlusRelease.js';
import { resolveUpsellForCustomer } from '../upsell/upsellTarget.js';

/**
 * 「停止していなかったら資格はどう見えるか」を返す。
 *
 * 停止していない会員では **渡された release をそのまま返す**（再計算しない）。
 *
 * @param {{ fields: object|null, nowMs: number, release: object|null, fallbackAnchor?: unknown }} input
 * @returns {object|null} 資格の軸として読む release
 */
export function eligibilityAxisRelease({ fields, nowMs, release, fallbackAnchor } = {}) {
  if (!release || release.salePaused !== true) return release;
  const unpaused = {
    ...(fields && typeof fields === 'object' ? fields : {}),
    [PP_SALE_PAUSE_FIELDS.PAUSED]: false,
  };
  const view = resolveUpsellForCustomer({ fields: unpaused, nowMs, fallbackAnchor });
  return view.plusRelease;
}

/**
 * 管理一覧の 1 行に載せる「資格の軸」の値だけを取り出す。
 * 呼び出し側が phase / overrideApplied を個別に組み立て直さないための入口。
 *
 * @returns {{ phase: number, overrideApplied: boolean }}
 */
export function eligibilityAxisFields({ fields, nowMs, release, fallbackAnchor } = {}) {
  const axis = eligibilityAxisRelease({ fields, nowMs, release, fallbackAnchor }) || {};
  return {
    phase: Number(axis.phase) || 0,
    overrideApplied: axis.overrideApplied === true,
  };
}
