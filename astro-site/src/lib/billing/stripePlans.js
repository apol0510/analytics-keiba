/**
 * stripePlans.js — Stripe 定期購読で売るプランの**単一源**（純粋・I/O なし）
 *
 * ## 商品（2026-10-02 MK 確定 / docs/spec.md「Stripe 定期購読」）
 *
 * | planId          | 表示名              | 月額   | 閲覧できる予想            | env（Price ID）               |
 * |-----------------|---------------------|--------|---------------------------|-------------------------------|
 * | premium         | Premium（中央+南関）| ¥4,980 | 中央・南関の Premium 両方 | STRIPE_PRICE_PREMIUM          |
 * | premium-jra     | Premium 中央版      | ¥2,980 | 中央（JRA）の Premium だけ | STRIPE_PRICE_PREMIUM_JRA      |
 * | premium-nankan  | Premium 南関版      | ¥2,980 | 南関の Premium だけ        | STRIPE_PRICE_PREMIUM_NANKAN   |
 *
 * - 中央版・南関版は「Premium を会場で分けただけ」。中身（買い目・指数・全レース）は Premium と同じ。
 * - Airtable には **プラン=Premium のまま** `VenueAccess` で会場を絞って書く
 *   （新しいプラン値を作らない＝既存の Premium 判定・アップセル・メールの分岐を増やさない）。
 *   `VenueAccess` 空 = 両会場（既存の全会員はこれ）。
 * - 三連複買い切りの購入資格・Premium Plus は**両会場の Premium だけ**（会場限定には付けない）。
 *
 * ⚠️ 金額の正本は Stripe の Price。ここの `amountYen` は**表示と突き合わせ用**で、
 *    Checkout で請求される金額は Stripe 側の Price で決まる（クライアントの言い値は使わない）。
 *    Live の Price 金額を後から編集しない（既存契約者の価格が変わる）。変えるときは新しい Price を作る。
 */

export const STRIPE_PLANS = Object.freeze([
  Object.freeze({
    id: 'premium',
    label: 'Premium（中央＋南関）',
    shortLabel: 'Premium',
    amountYen: 4980,
    venues: Object.freeze(['jra', 'nankan']),
    priceEnv: 'STRIPE_PRICE_PREMIUM',
  }),
  Object.freeze({
    id: 'premium-jra',
    label: 'Premium 中央版',
    shortLabel: '中央版',
    amountYen: 2980,
    venues: Object.freeze(['jra']),
    priceEnv: 'STRIPE_PRICE_PREMIUM_JRA',
  }),
  Object.freeze({
    id: 'premium-nankan',
    label: 'Premium 南関版',
    shortLabel: '南関版',
    amountYen: 2980,
    venues: Object.freeze(['nankan']),
    priceEnv: 'STRIPE_PRICE_PREMIUM_NANKAN',
  }),
]);

/**
 * Price ID・ポータル設定 ID（**秘密ではない**ので env に置かずコードに持つ）。
 *
 * ⚠️ 2026-10-02: これらを env（production）に足したところ、関数の環境変数が AWS Lambda の
 *    上限 4KB を超え、**本番デプロイがすべて失敗**した（予想データの取込も反映されなくなった）。
 *    env に置くのは秘密鍵と Webhook 署名鍵の 2 つだけにする。
 *    値は `scripts/stripe-setup.mjs` が Stripe から読んで、ここと一致するかを検査する。
 * モードは秘密鍵の種類（sk_live / rk_live = live、それ以外 = test）で決める。
 */
export const STRIPE_IDS = Object.freeze({
  test: Object.freeze({
    prices: Object.freeze({
      'premium': 'price_1ULyOHQ9vgG2OwCpuQjaTdvX',
      'premium-jra': 'price_1ULyOIQ9vgG2OwCpf5ymCFVL',
      'premium-nankan': 'price_1ULyOIQ9vgG2OwCpy1sWO9uH',
    }),
    portalConfiguration: 'bpc_1ULyOJQ9vgG2OwCpKk6LwQyB',
  }),
  live: Object.freeze({
    prices: Object.freeze({
      'premium': 'price_1UM2FmLeaWtQI3ZUPyh3e7DW',
      'premium-jra': 'price_1UM2FmLeaWtQI3ZU5srPM50x',
      'premium-nankan': 'price_1UM2FnLeaWtQI3ZU6uW8mvzH',
    }),
    portalConfiguration: 'bpc_1UM2FoLeaWtQI3ZUwjrypDK6',
  }),
});

/** 秘密鍵の種類から 'live' | 'test'（鍵が無ければ null）*/
export function stripeModeOf(env = {}) {
  const k = String(env.STRIPE_SECRET_KEY ?? '').trim();
  if (/^(sk|rk)_live_/.test(k)) return 'live';
  if (/^(sk|rk)_test_/.test(k)) return 'test';
  return null;
}

/** ポータル設定 ID（env の上書きがあればそれ）*/
export function portalConfigurationFor(env = {}) {
  const override = String(env.STRIPE_PORTAL_CONFIGURATION_ID ?? '').trim();
  if (override) return override;
  const mode = stripeModeOf(env);
  return mode ? STRIPE_IDS[mode].portalConfiguration : null;
}

/** Stripe の秘密鍵・Webhook 署名鍵の env 名 */
export const STRIPE_ENV = Object.freeze({
  SECRET_KEY: 'STRIPE_SECRET_KEY',
  WEBHOOK_SECRET: 'STRIPE_WEBHOOK_SECRET',
});

/** planId → plan。未知は null（fail closed） */
export function planById(id) {
  const key = String(id ?? '').trim();
  return STRIPE_PLANS.find((p) => p.id === key) || null;
}

/** plan の Price ID。env の上書き（STRIPE_PRICE_*）があればそれ、無ければ鍵のモードの既定値。鍵も無ければ null */
export function priceIdFor(plan, env = {}) {
  const p = typeof plan === 'string' ? planById(plan) : plan;
  if (!p) return null;
  const v = String(env[p.priceEnv] ?? '').trim();
  if (v) return v;
  const mode = stripeModeOf(env);
  return mode ? STRIPE_IDS[mode].prices[p.id] || null : null;
}

/**
 * Price ID → plan。Webhook / 照合の入口。
 * **env に登録された Price だけ**を認める（Stripe 側で誰かが作った別 Price では権限を付けない）。
 */
export function planFromPriceId(priceId, env = {}) {
  const id = String(priceId ?? '').trim();
  if (!id) return null;
  return STRIPE_PLANS.find((p) => priceIdFor(p, env) === id) || null;
}

/** 秘密鍵が設定済みか（値は返さない） */
export function hasStripeSecret(env = {}) {
  return /^(sk|rk)_(test|live)_/.test(String(env[STRIPE_ENV.SECRET_KEY] ?? '').trim());
}

/** Airtable `VenueAccess` に書く値。両会場は空（＝既存会員と同じ表現） */
export function venueAccessValue(plan) {
  const p = typeof plan === 'string' ? planById(plan) : plan;
  if (!p) return null;
  return p.venues.length >= 2 ? '' : p.venues.join(',');
}

/** 両会場（＝通常の Premium）か */
export function isFullPremiumPlan(plan) {
  const p = typeof plan === 'string' ? planById(plan) : plan;
  return Boolean(p && p.venues.includes('jra') && p.venues.includes('nankan'));
}
