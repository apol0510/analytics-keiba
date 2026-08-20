/**
 * drmResponseState.js — 顧客 1 人の**反応**を既存単一源だけから解決する（純粋・I/O なし）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * Direct Response Marketing は「送った数」ではなく「**どう反応したか**」で次を変える。
 * ところが材料は既に repo 中に散らばっている:
 *
 *   delivered / opened  … `webhooks/deliveryEventIndex.js`（DeliveryKey 単位の索引）
 *   purchased           … `customerMarketingAudience.js` の `premiumActive` / `lightActive`
 *                         （**課金契約のみ**。無料特典 `promo*` は購入ではない）
 *   送信可否・退会・停止 … `resolveSendability` / `providerSuppressed` / `softBounced`
 *
 * ここはそれを **1 人 1 つの状態へ畳むだけ**。新しい正本を作らない。
 *
 * ── 測っていないものを 0 にしない ──────────────────────────────
 * ⚠️ `click` は **provider 側の tracking が OFF**（`deliveryEventIndex.js` の注記どおり、
 *    有効化するとアカウント全体に掛かりマジックリンクが壊れる）。
 *    したがって `clicked` は **常に `null`（未計測）**であって `false` ではない。
 * ⚠️ `open` も索引が読めなければ `null`。**「開いていない」と言い切らない。**
 * ⚠️ `null` を偽と扱って分岐してはいけない（`drmRouting.js` が明示的に扱う）。
 */

/** 反応の段階（**強い順**。routing はこの順で最初に当たったものを使う） */
export const RESPONSE = Object.freeze({
  PURCHASED: 'purchased',
  SUPPRESSED: 'suppressed',        // 退会・配信停止・バウンス・provider 停止リスト
  CLICKED: 'clicked',
  OPENED: 'opened',
  DELIVERED: 'delivered',
  SENT: 'sent',
  NOT_SENT: 'not_sent',
  UNKNOWN: 'unknown',              // 材料が読めない（**推測しない**）
});

/** 反応層のラベル（画面にそのまま出す） */
export const RESPONSE_LABEL = Object.freeze({
  purchased: '購入済み',
  suppressed: '送信対象外（退会・停止・バウンス）',
  clicked: 'クリック済み・未購入',
  opened: '開封済み・未クリック',
  delivered: '到達・未開封',
  sent: '送信済み（到達は未確認）',
  not_sent: '未送信',
  unknown: '判定できません（未計測）',
});

/** 送信対象外の理由（既存の停止理由をそのまま持ち回る） */
export const SUPPRESS_REASON = Object.freeze({
  UNSUBSCRIBED: 'unsubscribed',
  HARD_BOUNCE: 'hard_bounce',
  COMPLAINT: 'complaint',
  PROVIDER_SUPPRESSED: 'provider_suppressed',
  SOFT_BOUNCE: 'soft_bounce',
  NOT_SENDABLE: 'not_sendable',
});

const str = (v) => String(v ?? '').trim();
const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * その顧客が **課金契約を持っているか**（＝購入）。
 *
 * ⚠️ `promoPremiumActive` / `promoLightActive` は**無料特典**なので購入に数えない
 *    （`customerMarketingAudience.js` の注記どおり、無料特典で「支払済み」に見せない）。
 */
export function hasPurchased(marketing) {
  const m = marketing || {};
  return m.premiumActive === true || m.lightActive === true;
}

/**
 * 送信対象外か（理由つき）。**既存の判定結果を受け取るだけ**で、ここでは作らない。
 */
export function resolveSuppression({ marketing, providerSuppressed, softBounced } = {}) {
  const m = marketing || {};
  const email = str(m.email).toLowerCase();
  if (providerSuppressed instanceof Set && email && providerSuppressed.has(email)) {
    return SUPPRESS_REASON.PROVIDER_SUPPRESSED;
  }
  if (softBounced instanceof Set && email && softBounced.has(email)) return SUPPRESS_REASON.SOFT_BOUNCE;
  const reasons = Array.isArray(m.suppressionReasons) ? m.suppressionReasons.map(str) : [];
  if (reasons.includes('unsubscribed')) return SUPPRESS_REASON.UNSUBSCRIBED;
  if (reasons.includes('hard_bounce')) return SUPPRESS_REASON.HARD_BOUNCE;
  if (reasons.includes('complaint')) return SUPPRESS_REASON.COMPLAINT;
  if (reasons.includes('blacklist')) return SUPPRESS_REASON.HARD_BOUNCE;
  if (m.sendable === false) return SUPPRESS_REASON.NOT_SENDABLE;
  return null;
}

/**
 * その顧客の**この campaign における**反応を 1 つに解決する。
 *
 * @param {{
 *   marketing: object,                       // `resolveCustomerMarketing` の戻り
 *   touches: Array<{step:number, deliveryKey:string, sentAtMs:number|null,
 *                   delivered:boolean|null, opened:boolean|null, clicked:boolean|null}>,
 *   providerSuppressed?: Set<string>|null,
 *   softBounced?: Set<string>|null,
 *   measured?: {open: boolean, click: boolean},   // 計測が有効か（`deliveryMeasurement` 由来）
 * }} input
 * @returns {{state: string, suppressReason: string|null, sentCount: number,
 *            deliveredCount: number|null, openedCount: number|null, clickedCount: number|null,
 *            lastSentAtMs: number|null, lastTouchStep: number|null,
 *            openMeasured: boolean, clickMeasured: boolean}}
 */
export function resolveResponseState({
  marketing, touches, providerSuppressed = null, softBounced = null, measured = null,
} = {}) {
  const list = Array.isArray(touches) ? touches : [];
  const openMeasured = measured ? measured.open === true : false;
  const clickMeasured = measured ? measured.click === true : false;

  let sentCount = 0;
  let deliveredCount = 0;
  let openedCount = 0;
  let clickedCount = 0;
  let lastSentAtMs = null;
  let lastTouchStep = null;
  let anyDeliveredUnknown = false;

  for (const t of list) {
    const step = num(t && t.step);
    const at = num(t && t.sentAtMs);
    if (t && t.deliveryKey) {
      sentCount += 1;
      if (at !== null && (lastSentAtMs === null || at > lastSentAtMs)) {
        lastSentAtMs = at;
        lastTouchStep = step;
      }
    }
    if (t && t.delivered === true) deliveredCount += 1;
    else if (!t || t.delivered === null || t.delivered === undefined) anyDeliveredUnknown = true;
    if (t && t.opened === true) openedCount += 1;
    if (t && t.clicked === true) clickedCount += 1;
  }

  const base = {
    sentCount,
    // ⚠️ 計測していないものは **null**（0 と書かない）
    deliveredCount: sentCount === 0 ? 0 : (anyDeliveredUnknown && deliveredCount === 0 ? null : deliveredCount),
    openedCount: openMeasured ? openedCount : null,
    clickedCount: clickMeasured ? clickedCount : null,
    lastSentAtMs,
    lastTouchStep,
    openMeasured,
    clickMeasured,
  };

  // ── 強い順に 1 つ ────────────────────────────────────────────
  if (hasPurchased(marketing)) return { state: RESPONSE.PURCHASED, suppressReason: null, ...base };
  const suppress = resolveSuppression({ marketing, providerSuppressed, softBounced });
  if (suppress) return { state: RESPONSE.SUPPRESSED, suppressReason: suppress, ...base };

  if (clickMeasured && clickedCount > 0) return { state: RESPONSE.CLICKED, suppressReason: null, ...base };
  if (openMeasured && openedCount > 0) return { state: RESPONSE.OPENED, suppressReason: null, ...base };
  if (sentCount === 0) return { state: RESPONSE.NOT_SENT, suppressReason: null, ...base };
  if (base.deliveredCount !== null && base.deliveredCount > 0) {
    // 到達は分かるが開封は測れていない → **未開封と断定しない**
    if (!openMeasured) return { state: RESPONSE.UNKNOWN, suppressReason: null, ...base };
    return { state: RESPONSE.DELIVERED, suppressReason: null, ...base };
  }
  // 送ったが到達も開封も確認できない
  if (!openMeasured || base.deliveredCount === null) {
    return { state: RESPONSE.UNKNOWN, suppressReason: null, ...base };
  }
  return { state: RESPONSE.SENT, suppressReason: null, ...base };
}

export default resolveResponseState;
