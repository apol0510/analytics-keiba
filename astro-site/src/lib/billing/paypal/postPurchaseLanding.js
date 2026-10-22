/**
 * postPurchaseLanding.js — PayPal 定期課金の購入直後に、お客様を Premium の利用画面へ自動で届ける（2026-10-22 MK 確定）
 *
 * 背景: 2026-10-22 の初回購入者が「有料版のリンクが届かない」と問い合わせた（権限は付与済み・ログインも成功していた）。
 * 方針: 利用開始メールは足さない。決済完了 → 自動遷移を正式仕様にする。
 *
 * - ログイン中の購入者: 戻り先（/checkout/paypal-subscription-return/）が反映済み（active）を受け取ったら、そのまま利用画面へ。
 * - 未ログインの購入者: 戻り先で完了を表示 → ログイン画面へ自動遷移。ログインリンクを開いた後（メールアプリ内ブラウザ・別端末でも）
 *   verify-magic-link が購入直後の印を読み、利用画面へ送る。印はサーバー側（Redis・会員単位・24 時間・1 回で消す）なので、
 *   戻り先の Cookie（ak_pp_return）をログインの代わりに使わない。ログイン（マジックリンク）は従来どおり必須。
 *
 * ⚠️ 遷移先は「買った商品の会場」と「いまの権限（resolveEntitlements）」の両方を満たすときだけ。どちらかが欠ければ null（＝従来のマイページ）。
 * ⚠️ 印は利便のためだけ。権限の根拠ではない（有料ページは gatePaidPage が毎回 Airtable の正本で判定する）。印の失敗は付与・ログインを止めない。
 */
import { subscriptionPlanById } from './paypalSubscriptionCore.js';

/**
 * 両会場（中央＋南関）: マイページの Premium 枠（中央／南関を選べる）。dashboard がこの位置まで送って強調する。
 * `?from=purchase` はマイページの SSR に「会員レコードをキャッシュ（最長 10 分）から読まず読み直す」よう伝えるだけ
 * （ログイン中の Light 会員が買った直後に Light のまま表示される事故の防止・E2E で検出）。権限の根拠ではない。
 */
export const BOTH_VENUES_DESTINATION = '/dashboard/?from=purchase#premium-predictions';
export const VENUE_DESTINATIONS = Object.freeze({
  jra: '/premium-prediction/jra/',
  nankan: '/premium-prediction/nankan/',
});
/** 遷移先として出しうる値はこの 3 つだけ（オープンリダイレクトを作らない） */
export const POST_PURCHASE_DESTINATIONS = Object.freeze([BOTH_VENUES_DESTINATION, VENUE_DESTINATIONS.jra, VENUE_DESTINATIONS.nankan]);

export const POST_PURCHASE_TTL_SECONDS = 24 * 60 * 60;
export const postPurchaseKey = (recordId) => `ak:paypal:post-purchase:v1:${recordId}`;

const isRecordId = (v) => /^rec[A-Za-z0-9]{14}$/.test(String(v || ''));

/** 商品 → 会場の配列（知らない商品は []） */
export function venuesForPlan(planId) {
  const p = subscriptionPlanById(planId);
  return p && Array.isArray(p.venues) ? [...p.venues] : [];
}

/** 会場の配列 → 遷移先。両会場ならマイページの Premium 枠・片方ならその会場の予想ページ・それ以外は null */
export function destinationForVenues(venues) {
  const v = new Set(Array.isArray(venues) ? venues : []);
  if (v.has('jra') && v.has('nankan')) return BOTH_VENUES_DESTINATION;
  if (v.size === 1 && v.has('jra')) return VENUE_DESTINATIONS.jra;
  if (v.size === 1 && v.has('nankan')) return VENUE_DESTINATIONS.nankan;
  return null;
}

/** 買った商品の遷移先（戻り先ページ用。confirm が active を返したとき＝反映済みのときだけ使う） */
export function destinationForPlan(planId) {
  return destinationForVenues(venuesForPlan(planId));
}

/**
 * 買った商品 × いまの権限 → 遷移先。買った会場がすべて閲覧可能なときだけ（権限が付いていなければ null）。
 * @param {string} planId
 * @param {{canViewPremiumJra?:boolean, canViewPremiumNankan?:boolean}|null} entitlements
 */
export function destinationForPurchase(planId, entitlements) {
  const venues = venuesForPlan(planId);
  if (!venues.length || !entitlements) return null;
  const can = { jra: entitlements.canViewPremiumJra === true, nankan: entitlements.canViewPremiumNankan === true };
  if (!venues.every((v) => can[v])) return null;
  return destinationForVenues(venues);
}

/** 購入直後の印を置く（反映で購読が新たに会員へ結び付いたときだけ呼ぶ・best-effort） */
export async function markPostPurchase(redis, { recordId, planId, subscriptionId, now = new Date() }) {
  if (!redis || !isRecordId(recordId) || !subscriptionPlanById(planId)) return false;
  try {
    const value = JSON.stringify({ planId, subscriptionId: String(subscriptionId || ''), at: now.toISOString() });
    await redis(['SET', postPurchaseKey(recordId), value, 'EX', POST_PURCHASE_TTL_SECONDS]);
    return true;
  } catch { return false; }
}

/** 購入直後の印を取り出して消す（1 回だけ使う）。無い・壊れている・知らない商品は null */
export async function takePostPurchase(redis, recordId) {
  if (!redis || !isRecordId(recordId)) return null;
  const key = postPurchaseKey(recordId);
  let raw = null;
  try {
    raw = await redis(['GETDEL', key]);
  } catch {
    try {
      raw = await redis(['GET', key]);
      if (raw) await redis(['DEL', key]);
    } catch { return null; }
  }
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    return o && subscriptionPlanById(o.planId) ? { planId: o.planId, subscriptionId: String(o.subscriptionId || '') } : null;
  } catch { return null; }
}

/**
 * ログイン成功時の遷移先（verify-magic-link から呼ぶ）。印があり、いまの権限で買った会場が見られるときだけ遷移先を返す。
 * 失敗・印なし・権限なしは null（＝従来どおり /dashboard/）。例外を投げない。
 */
export async function resolvePostLoginDestination({ redis, recordId, entitlements }) {
  try {
    const mark = await takePostPurchase(redis, recordId);
    if (!mark) return null;
    return destinationForPurchase(mark.planId, entitlements);
  } catch { return null; }
}
