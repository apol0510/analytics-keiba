/**
 * predictionKey.js — 取得単位（1 予想）のキー（純粋）
 *
 * 形式: `{product}:{cat}:{date}:{venue}:{raceNumber}`
 *   product: premium（Premium の馬単＋三連複通常）/ srp（Premium Sanrenpuku のレース選別）
 *   cat: jra / nankan
 *   venue: JRA は会場コード（TOK 等）、南関は slug（ooi / kawasaki / funabashi / urawa）
 * 形式外は null（クライアントから来たキーは必ずここを通す）。正本 docs/PREDICTION_ACQUISITION.md §4
 */
export const PRODUCTS = Object.freeze({ PREMIUM: 'premium', SRP: 'srp' });
export const CATEGORIES = Object.freeze(['jra', 'nankan']);

export const JRA_VENUES = Object.freeze({
  '東京': 'TOK', '中山': 'NAK', '京都': 'KYO', '阪神': 'HAN', '中京': 'CHU',
  '新潟': 'NII', '福島': 'FKS', '小倉': 'KOK', '札幌': 'SAP', '函館': 'HKD',
});
export const NANKAN_VENUES = Object.freeze({ '大井': 'ooi', '川崎': 'kawasaki', '船橋': 'funabashi', '浦和': 'urawa' });

const NAME_BY_VENUE = Object.freeze(Object.fromEntries([
  ...Object.entries(JRA_VENUES).map(([n, c]) => [`jra:${c}`, n]),
  ...Object.entries(NANKAN_VENUES).map(([n, s]) => [`nankan:${s}`, n]),
]));

const KEY_RE = /^(premium|srp):(jra|nankan):(\d{4}-\d{2}-\d{2}):([A-Za-z]{3,9}):([1-9]|1[0-2])$/;

export function venueIdOf(cat, venueName) {
  const clean = String(venueName || '').replace('競馬場', '').replace('競馬', '').trim();
  if (cat === 'jra') return JRA_VENUES[clean] || null;
  if (cat === 'nankan') return NANKAN_VENUES[clean] || null;
  return null;
}

export function venueNameOf(cat, venueId) {
  return NAME_BY_VENUE[`${cat}:${venueId}`] || null;
}

export function buildPredictionKey({ product, cat, date, venue, raceNumber }) {
  const key = `${product}:${cat}:${date}:${venue}:${Number(raceNumber)}`;
  return parsePredictionKey(key) ? key : null;
}

/** @returns {null | { product, cat, date, venue, venueName, raceNumber, key }} */
export function parsePredictionKey(raw) {
  const m = KEY_RE.exec(String(raw ?? ''));
  if (!m) return null;
  const [, product, cat, date, venue, race] = m;
  const venueName = venueNameOf(cat, venue);
  if (!venueName) return null;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) return null;
  return { product, cat, date, venue, venueName, raceNumber: Number(race), key: m[0] };
}
