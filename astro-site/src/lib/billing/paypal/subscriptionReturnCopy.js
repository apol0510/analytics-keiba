/**
 * PayPal 定期課金の戻り先（/checkout/paypal-subscription-return/）で、反映済み（status: active）のときに出す文言とリンク。
 * 商品 ID は SUBSCRIPTION_PLANS（月額 3 本・年額 2 本）が正本。更新の周期は各商品の interval から決める
 * （年額の購入者に「毎月自動で更新されます」と出していた誤りの修正・2026-10-21）。
 */
import { SUBSCRIPTION_PLANS } from './paypalSubscriptionCore.js';

const LINKS = Object.freeze({
  jra: ['中央の Premium 予想へ', '/premium-prediction/jra/'],
  nankan: ['南関の Premium 予想へ', '/premium-prediction/nankan/'],
});

const NAMES = Object.freeze({
  'premium': 'Premium（中央＋南関）',
  'premium-jra': 'Premium 中央版',
  'premium-nankan': 'Premium 南関版',
  'premium-annual': 'Premium 年払い（中央＋南関）',
  'premium-annual-light': 'Premium 年払い（中央＋南関）',
});

const RENEWAL = Object.freeze({ MONTH: '毎月自動で更新されます', YEAR: '1 年ごとに自動で更新されます' });

/** planId → { text, links }。全商品に必ず 1 つ（無い商品は build 時に例外）。 */
export function buildSubscriptionReturnCopy(plans = SUBSCRIPTION_PLANS) {
  const out = {};
  for (const p of plans) {
    const name = NAMES[p.id];
    const renewal = RENEWAL[p.interval];
    if (!name || !renewal) throw new Error(`subscription return copy missing for ${p.id}`);
    const venues = Array.isArray(p.venues) ? p.venues : [];
    out[p.id] = { text: `${name}をご利用いただけます（${renewal}）。`, links: venues.map((v) => LINKS[v]).filter(Boolean) };
  }
  return out;
}

export const SUBSCRIPTION_RETURN_COPY = Object.freeze(buildSubscriptionReturnCopy());
