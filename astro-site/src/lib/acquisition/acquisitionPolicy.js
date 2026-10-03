/**
 * acquisitionPolicy.js — 誰がどの予想を取得できるか（純粋）
 *
 * 判定は resolveEntitlements の結果だけを見る（プラン文字列で判定しない）。
 *   premium: その会場区分の Premium 閲覧権（会場別の権利があればそれ、無ければ canViewPremium）
 *   srp: 三連複の閲覧権 canViewSanrenpuku（買い切り・旧プランの権利を含む。既存権利を縮小しない）
 */
import { PRODUCTS } from './predictionKey.js';

export function canAcquire(ent, { product, cat } = {}) {
  if (!ent || typeof ent !== 'object') return false;
  if (product === PRODUCTS.SRP) return ent.canViewSanrenpuku === true;
  if (product !== PRODUCTS.PREMIUM) return false;
  const venueFlag = cat === 'jra' ? ent.canViewPremiumJra : cat === 'nankan' ? ent.canViewPremiumNankan : undefined;
  if (cat !== 'jra' && cat !== 'nankan') return false;
  if (typeof venueFlag === 'boolean') return venueFlag || ent.canViewPremium === true;
  return ent.canViewPremium === true;
}
