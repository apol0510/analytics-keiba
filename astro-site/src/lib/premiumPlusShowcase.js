/**
 * Premium Plus 実績ショーケース 単一源（純粋・Node/ブラウザ両対応）
 *
 * Premium Plus は「1 日 1 鞍・三連単フォーメーション」の単品商品。
 * 実際に投票した投票内容照会スクショを毎日 1 枚アップロードし、その入力値
 * （的中/不的中・払戻・投票額）から**ページに出す実績数値を自動集計**する。
 *
 * 設計原則:
 * - ページに手書きの実績数値を置かない。数値は必ず computeStats() の戻り値を使う。
 *   旧 premium-plus.astro の「的中率78% / 平均配当¥281,340 / 満足度4.9 / 継続率94%」は
 *   根拠のない固定値で、更新も止まっていた。同じ事故を構造的に起こさないため。
 * - Airtable / Netlify Blobs / DOM に依存しない純粋モジュール。
 *   Function・管理画面・ページ・テストの全てがこの 1 ファイルを参照する。
 *
 * legacy フラグ（重要）:
 *   2026-07 の刷新以前に保存されていた 30 枚は**的中した日だけ**を保存したもので、
 *   不的中の日の画像が存在しない。これを的中率の母数に入れると「的中率100%」という
 *   嘘の数字になる。そのため legacy=true のエントリは
 *     - 的中率・回収率の集計から**除外**する
 *     - 最高払戻・的中時平均払戻（的中時の条件付き統計）には**含める**
 *   刷新後は不的中も含めて毎日アップロードするため、legacy=false のサンプルが
 *   MIN_RATE_SAMPLE 件たまった時点で的中率タイルが自動的に表示される。
 */

/** 的中率・回収率の集計に使う直近件数 */
export const STATS_WINDOW = 30;

/** 的中率タイルを表示するのに必要な最低サンプル数（これ未満は非表示 = 出さない） */
export const MIN_RATE_SAMPLE = 10;

/** ページのギャラリーに出す最大枚数 */
export const GALLERY_LIMIT = 5;

/** 三連複ページ CTA のプレビューに出す枚数 */
export const CTA_PREVIEW_LIMIT = 3;

/** 買い目の式別（Premium Plus は三連単フォーメーション固定） */
export const DEFAULT_BET_TYPE = '三連単フォーメーション';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function toInt(value) {
  const n = typeof value === 'string' ? Number(value.replace(/[^\d.-]/g, '')) : Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function toBool(value) {
  return value === true || value === 'true' || value === 1 || value === '1';
}

/**
 * アップロード入力 1 件を正規化する。
 * date が不正なら null を返す（マニフェストに入れない）。
 */
export function normalizeEntry(input) {
  if (!input || typeof input !== 'object') return null;

  const date = typeof input.date === 'string' ? input.date.trim() : '';
  if (!DATE_RE.test(date)) return null;

  const payout = Math.max(0, toInt(input.payout));
  // 払戻額が入っていれば的中とみなす（isHit の入力漏れを払戻額で補正する）
  const isHit = toBool(input.isHit) || payout > 0;

  return {
    date,
    venue: typeof input.venue === 'string' ? input.venue.trim() : '',
    raceNumber: toInt(input.raceNumber) || null,
    betType: (typeof input.betType === 'string' && input.betType.trim()) || DEFAULT_BET_TYPE,
    stake: Math.max(0, toInt(input.stake)),
    payout: isHit ? payout : 0,
    isHit,
    legacy: toBool(input.legacy),
    imageKey: typeof input.imageKey === 'string' ? input.imageKey : '',
    contentType: typeof input.contentType === 'string' ? input.contentType : 'image/png',
    uploadedAt: typeof input.uploadedAt === 'string' ? input.uploadedAt : '',
  };
}

/** 日付降順（同日は uploadedAt 降順）。最新が index 0。 */
export function sortEntries(entries) {
  return [...(entries || [])]
    .filter(Boolean)
    .sort((a, b) =>
      a.date === b.date
        ? String(b.uploadedAt).localeCompare(String(a.uploadedAt))
        : b.date.localeCompare(a.date)
    );
}

/**
 * 同じ日付のエントリは 1 件だけ残す（1 日 1 鞍のため）。後勝ち。
 * 撮り直し・入力ミスの上書きがそのまま効く。
 */
export function upsertEntry(entries, entry) {
  const normalized = normalizeEntry(entry);
  if (!normalized) return sortEntries(entries);
  const rest = (entries || []).filter((e) => e && e.date !== normalized.date);
  return sortEntries([...rest, normalized]);
}

export function removeEntry(entries, date) {
  return sortEntries((entries || []).filter((e) => e && e.date !== date));
}

/**
 * 実績数値を集計する。ページに出す数値は必ずここを通す（手書き禁止）。
 *
 * 返り値:
 *   rate     … 的中率・回収率。legacy を除いた直近 window 件から算出。
 *              サンプルが MIN_RATE_SAMPLE 未満なら available=false（＝表示しない）。
 *   payout   … 最高払戻・的中時平均払戻。legacy を含む全的中エントリから算出。
 */
export function computeStats(entries, { window = STATS_WINDOW, minRateSample = MIN_RATE_SAMPLE } = {}) {
  const sorted = sortEntries(entries);

  // --- 的中率・回収率: legacy 除外 ---
  const rateSample = sorted.filter((e) => !e.legacy).slice(0, Math.max(0, window));
  const rateHits = rateSample.filter((e) => e.isHit);
  const rateStake = rateSample.reduce((sum, e) => sum + e.stake, 0);
  const ratePayout = rateSample.reduce((sum, e) => sum + e.payout, 0);

  const rate = {
    available: rateSample.length >= minRateSample,
    races: rateSample.length,
    hits: rateHits.length,
    hitRate: rateSample.length > 0 ? Math.round((rateHits.length / rateSample.length) * 100) : 0,
    roi: rateStake > 0 ? Math.round((ratePayout / rateStake) * 100) : 0,
    totalStake: rateStake,
    totalPayout: ratePayout,
    periodFrom: rateSample.length > 0 ? rateSample[rateSample.length - 1].date : '',
    periodTo: rateSample.length > 0 ? rateSample[0].date : '',
  };

  // --- 払戻実績: legacy 含む全的中エントリ（的中時の条件付き統計なので混ぜてよい） ---
  const hitEntries = sorted.filter((e) => e.isHit);
  const hitPayoutTotal = hitEntries.reduce((sum, e) => sum + e.payout, 0);

  const payout = {
    available: hitEntries.length > 0,
    hits: hitEntries.length,
    max: hitEntries.reduce((max, e) => Math.max(max, e.payout), 0),
    avg: hitEntries.length > 0 ? Math.round(hitPayoutTotal / hitEntries.length) : 0,
    periodFrom: hitEntries.length > 0 ? hitEntries[hitEntries.length - 1].date : '',
    periodTo: hitEntries.length > 0 ? hitEntries[0].date : '',
  };

  return { rate, payout, total: sorted.length };
}

/** ¥1,234,567 */
export function formatYen(value) {
  return `¥${toInt(value).toLocaleString('ja-JP')}`;
}

/** 2026-04-10 → 4/10 */
export function formatShortDate(date) {
  if (!DATE_RE.test(String(date))) return '';
  const [, month, day] = String(date).split('-');
  return `${Number(month)}/${Number(day)}`;
}

/** 「川崎6R」。venue / raceNumber が欠けていても壊れない。 */
export function formatRaceLabel(entry) {
  if (!entry) return '';
  const venue = entry.venue || '';
  const race = entry.raceNumber ? `${entry.raceNumber}R` : '';
  return `${venue}${race}`.trim();
}
