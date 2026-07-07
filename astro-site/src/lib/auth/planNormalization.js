/**
 * planNormalization.js — plan / venueAccess の正規化（ランタイム非依存・純粋関数）
 *
 * 旧表記・大小文字・日本語表記・全角/半角を、明示した正規値へ変換する。
 * 未知の値は null を返して「拒否」させる（fail closed）。
 *
 * ※ 現行 Airtable PlanType の完全な語彙合わせ込みは PR-B の責務。
 *   ここでは「新設計が扱う正規値」と、確度の高い別名だけを定義する。
 *   別名を増やすときは必ずこの表に追記し、表示側にローカル判定を作らない。
 */

/** 正規プラン値（このセットのみが有効）。 */
export const CANONICAL_PLANS = Object.freeze([
  'free',
  'light',
  'premium',
  'premium-predictions',
  'premium-sanrenpuku',
  'premium-sanrentan',
  'premium-combo',
  'premium-plus',
]);

/** 有料とみなす正規プラン（free は有料セッションとして発行不可）。 */
export const PAID_PLANS = Object.freeze(
  CANONICAL_PLANS.filter((p) => p !== 'free'),
);

/** 正規 venue トークン（venueAccess の構成要素）。 */
export const CANONICAL_VENUES = Object.freeze(['jra', 'nankan']);

const CANONICAL_PLAN_SET = new Set(CANONICAL_PLANS);
const PAID_PLAN_SET = new Set(PAID_PLANS);
const CANONICAL_VENUE_SET = new Set(CANONICAL_VENUES);

/**
 * 別名 → 正規プラン。
 * キーは normalizeToken() を通した後の値（小文字 / NFKC / 空白・アンダースコアをハイフンに）。
 */
const PLAN_ALIASES = Object.freeze({
  // free 系（有料セッションとしては発行不可）
  'free': 'free',
  'free-registered': 'free',
  'freeregistered': 'free',
  'expired': 'free',
  '無料': 'free',
  '無料会員': 'free',

  // light 系（旧 standard は light 相当）
  'light': 'light',
  'ライト': 'light',
  'standard': 'light',

  // premium 系
  'premium': 'premium',
  'プレミアム': 'premium',
  'premium-predictions': 'premium-predictions',
  'プレミアム予想': 'premium-predictions',
  'premium-sanrenpuku': 'premium-sanrenpuku',
  'プレミアム三連複': 'premium-sanrenpuku',
  'premium-sanrentan': 'premium-sanrentan',
  'プレミアム三連単': 'premium-sanrentan',
  'premium-combo': 'premium-combo',
  'プレミアムコンボ': 'premium-combo',
  'premium-plus': 'premium-plus',
  'プレミアムプラス': 'premium-plus',
  'pro-plus': 'premium-plus',
  'pro': 'premium',
});

/**
 * 別名 → 正規 venue。'all'/'both' は複数 venue に展開する。
 */
const VENUE_ALIASES = Object.freeze({
  'jra': ['jra'],
  '中央': ['jra'],
  'nankan': ['nankan'],
  '南関': ['nankan'],
  'all': ['jra', 'nankan'],
  'both': ['jra', 'nankan'],
  '全': ['jra', 'nankan'],
  'すべて': ['jra', 'nankan'],
});

/**
 * 生値を比較用トークンへ正規化する。
 * - 文字列以外は null
 * - NFKC（全角→半角・互換文字畳み込み）
 * - trim / 小文字化
 * - 連続する空白・アンダースコアを 1 個のハイフンに
 */
function normalizeToken(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.normalize('NFKC').trim().toLowerCase().replace(/[\s_]+/g, '-');
  return t.length > 0 ? t : null;
}

/**
 * plan を正規値へ変換する。未知なら null。
 * @param {unknown} raw
 * @returns {string|null} CANONICAL_PLANS のいずれか、または null
 */
export function normalizePlan(raw) {
  const token = normalizeToken(raw);
  if (token === null) return null;
  if (CANONICAL_PLAN_SET.has(token)) return token;
  return PLAN_ALIASES[token] ?? null;
}

/**
 * plan が「有料」正規値か。free / 未知 は false。
 * @param {unknown} raw 生値でも正規値でも可
 */
export function isPaidPlan(raw) {
  const plan = normalizePlan(raw);
  return plan !== null && PAID_PLAN_SET.has(plan);
}

/**
 * venueAccess を正規 venue の配列へ変換する。
 * - 入力は文字列（'all'|'jra'|'nankan' 等）または配列
 * - 1 つでも未知の venue が混ざれば null（fail closed）
 * - 重複除去のうえ CANONICAL_VENUES の順（jra, nankan）でソート
 * - 空配列は null（venue 指定なしは拒否）
 * @param {unknown} raw
 * @returns {string[]|null}
 */
export function normalizeVenueAccess(raw) {
  const items = Array.isArray(raw) ? raw : [raw];
  if (items.length === 0) return null;

  const acc = new Set();
  for (const item of items) {
    const token = normalizeToken(item);
    if (token === null) return null;
    const mapped = VENUE_ALIASES[token];
    if (!mapped) return null;
    for (const v of mapped) acc.add(v);
  }
  if (acc.size === 0) return null;
  // 正規順で返す（決定的な payload のため）
  return CANONICAL_VENUES.filter((v) => acc.has(v));
}

/**
 * 正規 venue 配列としての妥当性検証（検証パス用）。
 * - 非空配列であること
 * - 全要素が CANONICAL_VENUES のいずれか
 * - 重複がないこと
 */
export function isValidVenueAccessArray(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  const seen = new Set();
  for (const v of value) {
    if (!CANONICAL_VENUE_SET.has(v)) return false;
    if (seen.has(v)) return false;
    seen.add(v);
  }
  return true;
}
