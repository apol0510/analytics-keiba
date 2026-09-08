/**
 * sequencePurchaseStop.js — 連続配信の「もう買った人には送らない」判定（純粋・I/O なし）
 *
 * ## なぜ独立した単一源にするか（2026-09-08 の障害）
 *
 * 以前は `sequenceProgress.js` の中に
 *
 * ```js
 * function hasPurchased(m) { return m.premiumActive === true || m.lightActive === true; }
 * ```
 *
 * が直書きされていた。「有料契約が有効なら目的達成なので止める」という意図で、
 * **無料会員を有料へ引き上げる**シーケンスでは正しい。
 *
 * ところが 2026-08-24 のキャンペーンで、**すでに有料の方へ上位商品を案内する**
 * シーケンスを 2 本追加した。
 *
 * | campaign | 宛先 | 売るもの |
 * |---|---|---|
 * | `campaign-discount-light` | **Light が有効な方** | Premium 年額 / 買い切り |
 * | `campaign-discount-premium` | **Premium が有効な方** | 三連複 買い切り |
 *
 * **宛先条件そのものが停止条件と一致してしまい**、1 通目を送った直後から
 * 全員が `stopReason: 'purchased'` の恒久停止になった。`selectNextDueStep` は
 * due 0 になるので、2 通目は **エラーも警告も出さずに永久に出ない**
 * （本番実測: light 5 名 / premium 13 名の 2 通目が 8/31 に出ず、
 * 台帳を 1 周読み切った集計にも step2 の行が 1 つも無い）。
 *
 * ## 直し方
 *
 * 「何を買ったら目的達成か」は **campaign ごとに違う**ので、campaign 側の宣言にする。
 * 宣言が無ければ**従来どおり**（Light / Premium のどちらかが有効なら止める）。
 *
 * ```js
 * stopOnPurchase: { signals: ['premium', 'sanrenpuku'] }  // Light 会員向けアップセル
 * stopOnPurchase: false                                    // 購入では止めない
 * ```
 *
 * ⚠️ **既定を緩めない。** 宣言の無い campaign は 1 ミリも挙動を変えない。
 * ⚠️ ここで「送ってよいか」の他の条件（配信停止・バウンス・対象外・反応なし）は
 *    見ない。それらは従来どおり `sequenceProgress.js` が担当する。
 */

import { MK_CONTRACT, MK_PLAN } from './customerMarketingAudience.js';

/** 「もう買った」と数える権利。`resolveCustomerMarketing()` の出力に対応する */
export const PURCHASE_SIGNAL = Object.freeze({
  /** Light が有効（`mk.lightActive`） */
  LIGHT: 'light',
  /** Premium が有効（`mk.premiumActive`） */
  PREMIUM: 'premium',
  /** 三連複 買い切りを保有（`mk.hasSanrenpuku`） */
  SANRENPUKU: 'sanrenpuku',
});

const ALL_SIGNALS = Object.freeze(Object.values(PURCHASE_SIGNAL));

/**
 * 宣言が無いときの既定。**旧 `hasPurchased()` と同じ**
 * （Light か Premium が有効なら止める）。
 */
export const DEFAULT_PURCHASE_STOP_SIGNALS = Object.freeze([
  PURCHASE_SIGNAL.LIGHT, PURCHASE_SIGNAL.PREMIUM,
]);

/** 契約が「いま有効」と言える状態（期限切れ・不明は含めない） */
const ACTIVE_CONTRACTS = Object.freeze([MK_CONTRACT.ACTIVE, MK_CONTRACT.EXPIRING_SOON]);

const asArray = (v) => (Array.isArray(v) ? v : []);
const normalizeSignal = (v) => {
  const s = String(v ?? '').trim().toLowerCase();
  return ALL_SIGNALS.includes(s) ? s : null;
};

/**
 * この campaign で「もう買った」と数える権利の一覧。
 *
 * - 宣言なし … 既定（light / premium）
 * - `stopOnPurchase: false` / `{ signals: [] }` … **購入では止めない**（空配列）
 * - `stopOnPurchase: { signals: [...] }` … 宣言どおり（未知の値は捨てる）
 * - `stopOnPurchase: [...]` … 配列の短縮形
 *
 * ⚠️ 宣言が壊れている（object でも配列でも false でもない）ときは**既定へ倒す**。
 *    「止めない」に倒すと、買った人へ売り続ける事故になる。
 */
export function resolvePurchaseStopSignals(campaign) {
  const declared = campaign && Object.prototype.hasOwnProperty.call(campaign, 'stopOnPurchase')
    ? campaign.stopOnPurchase : undefined;
  if (declared === undefined || declared === null) return [...DEFAULT_PURCHASE_STOP_SIGNALS];
  if (declared === false) return [];
  if (declared === true) return [...DEFAULT_PURCHASE_STOP_SIGNALS];
  const raw = Array.isArray(declared) ? declared : asArray(declared.signals);
  if (!Array.isArray(declared) && !Array.isArray(declared.signals)) {
    return [...DEFAULT_PURCHASE_STOP_SIGNALS];
  }
  const out = [];
  for (const v of raw) {
    const s = normalizeSignal(v);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** その人が持っている権利（`resolveCustomerMarketing()` の出力 → signal の集合） */
export function describeHeldSignals(marketing) {
  const m = marketing || {};
  const held = [];
  if (m.lightActive === true) held.push(PURCHASE_SIGNAL.LIGHT);
  if (m.premiumActive === true) held.push(PURCHASE_SIGNAL.PREMIUM);
  if (m.hasSanrenpuku === true) held.push(PURCHASE_SIGNAL.SANRENPUKU);
  return held;
}

/**
 * この campaign にとって「もう買った人」か。
 *
 * @param {{campaign: object, marketing: object}} input
 * @returns {boolean}
 */
export function hasPurchasedForCampaign({ campaign, marketing } = {}) {
  const stopSignals = resolvePurchaseStopSignals(campaign);
  if (stopSignals.length === 0) return false;
  const held = describeHeldSignals(marketing);
  return held.some((s) => stopSignals.includes(s));
}

/**
 * その campaign の**宛先条件**が要求している権利（`audienceRule` の宣言から導く）。
 *
 * ⚠️ 「いま有効な契約」を要求しているときだけ数える。`expired` / `none` を宛先に
 *    したシーケンス（無料会員向け）は権利を要求していないので空になる。
 */
export function describeAudienceRequiredSignals(campaign) {
  const rule = (campaign && campaign.audienceRule) || null;
  if (!rule) return [];
  const plans = asArray(rule.plans);
  const contracts = asArray(rule.contracts);
  const activeContract = contracts.length === 0
    || contracts.some((c) => ACTIVE_CONTRACTS.includes(c));
  const out = [];
  if (plans.includes(MK_PLAN.PREMIUM_SANRENPUKU)) out.push(PURCHASE_SIGNAL.SANRENPUKU);
  if (!activeContract) return out;
  if (plans.includes(MK_PLAN.LIGHT)) out.push(PURCHASE_SIGNAL.LIGHT);
  if (plans.includes(MK_PLAN.PREMIUM)) out.push(PURCHASE_SIGNAL.PREMIUM);
  return out;
}

/**
 * **宛先条件と停止条件がぶつかっていないか**（＝ 1 通目を送った瞬間に全員が
 * 恒久停止する構造になっていないか）。
 *
 * 連続配信でない campaign は対象外（1 通しか送らないなら衝突しても実害が無い）。
 *
 * @returns {Array<{campaignId: string, signal: string}>} 衝突（空なら健全）
 */
export function findPurchaseStopAudienceConflicts(campaign) {
  const isSequence = Boolean(campaign
    && campaign.sequence && Array.isArray(campaign.sequence.steps)
    && campaign.sequence.steps.length > 1);
  if (!isSequence) return [];
  const stopSignals = resolvePurchaseStopSignals(campaign);
  const required = describeAudienceRequiredSignals(campaign);
  return required
    .filter((s) => stopSignals.includes(s))
    .map((signal) => ({ campaignId: String(campaign.campaignId || ''), signal }));
}

export default hasPurchasedForCampaign;
