/**
 * archiveRedirect.mjs — `/results` `/results-jra` から月別アーカイブへ飛ばす先を決める
 *
 * ── なぜ要るか（2026-08-31 の不具合）────────────────────────────
 * `/results` は **404 へ飛ばしていた**。
 *
 *   /results → 301 → /results/ → 302 → /archive/2026/08/ → **404**
 *
 * 実ページは `src/pages/archive/nankan/[year]/[month]/index.astro` にあり、
 * 正しい URL は `/archive/nankan/2026/08/` である（`/archive/2026/08/` は存在しない）。
 * `results-jra.astro` は `/archive/jra/...` と category を入れていたのに、
 * `results.astro` だけ **`/nankan` が抜けていた**。
 *
 * ── fail-closed の方針 ────────────────────────────────────────
 * 1. **`archive[0]` を最新と決め打ちしない。** 並び順は保証されていない
 *    （keiba-intelligence で同じ決め打ちが過去に事故になっている）。
 *    実際に最大の `date` を採る。
 * 2. **存在しない URL を組み立てない。** 日付を1件も確定できないときは、
 *    「今月」を推測して `/archive/{cat}/{今年}/{今月}/` へ飛ばさない
 *    （その月にデータが無ければまた 404 になる）。
 *    **必ず存在するカテゴリ索引 `/archive/{cat}/` へ落とす。**
 * 3. 壊れた JSON・想定外の形は握り潰さず、索引へ落とす（表示は壊さない）。
 */

/** `YYYY-MM-DD` 形式か。ここを緩めると不正な値から URL を組み立ててしまう。 */
function isIsoDate(v) {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

/**
 * archive の中から最新の `YYYY-MM` を求める。**順序に依存しない。**
 * 対応する形:
 *   - flat array: `[{ date: 'YYYY-MM-DD', ... }, ...]`
 *   - nested:     `{ 'YYYY': { 'MM': ... } }`
 * @returns {{year: string, month: string} | null} 確定できなければ null
 */
export function latestArchiveMonth(archive) {
  if (Array.isArray(archive)) {
    const dates = archive
      .map((x) => (x && typeof x === 'object' ? x.date : null))
      .filter(isIsoDate);
    if (dates.length === 0) return null;
    const [year, month] = dates.reduce((a, b) => (a > b ? a : b)).split('-');
    return { year, month };
  }

  if (archive && typeof archive === 'object') {
    const years = Object.keys(archive).filter((y) => /^\d{4}$/.test(y));
    if (years.length === 0) return null;
    const year = years.reduce((a, b) => (a > b ? a : b));
    const inner = archive[year];
    if (!inner || typeof inner !== 'object') return null;
    const months = Object.keys(inner).filter((m) => /^\d{2}$/.test(m));
    if (months.length === 0) return null;
    return { year, month: months.reduce((a, b) => (a > b ? a : b)) };
  }

  return null;
}

/**
 * リダイレクト先を決める。
 * @param {unknown} archive 読み込んだ archive JSON（読めなかったときは null を渡す）
 * @param {'nankan'|'jra'} category
 * @returns {string} 必ず**実在する**パス
 */
export function resolveArchiveRedirect(archive, category) {
  if (category !== 'nankan' && category !== 'jra') {
    throw new TypeError(`unknown archive category: ${String(category)}`);
  }
  const index = `/archive/${category}/`;
  const latest = latestArchiveMonth(archive);
  // 日付を確定できないときに「今月」を推測しない（存在しない月なら 404 になる）
  if (!latest) return index;
  return `/archive/${category}/${latest.year}/${latest.month}/`;
}
