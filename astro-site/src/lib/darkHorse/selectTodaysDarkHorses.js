/**
 * selectTodaysDarkHorses.js — 穴馬抽出ページの「当日データのみ」選定を固定する純粋関数
 *
 * `/dark-horse-picks/`（dark-horse-picks.astro / prerender）は、build 時 JST の当日
 * (`todayJst`) と **日付文字列が完全一致**する computer エントリだけを表示対象にする。
 *
 * 恒久仕様（回帰防止の対象）:
 *   - 過去日への fallback を **しない**（「最新日」ではなく「todayJst 一致」で選ぶ）。
 *   - todayJst に一致する darkHorses 入りエントリが無ければ **空配列**を返す
 *     （前日などの古い日付を代わりに出さない）。
 *   - 同日に複数会場（venue）があれば、その **同日分だけ**すべて対象にする。
 *   - date 不正 / races 非配列 / darkHorses 欠落・非配列・空 は安全に無視（throw しない）。
 *
 * I/O なし・依存ゼロ。呼び出し側（Astro frontmatter）が computer JSON を
 * `{ category, date, venueCode, data }` 形へ正規化して渡す。表示・整形はしない。
 */

/**
 * エントリが「darkHorses を1頭以上持つレース」を含むか。
 * races 非配列 / darkHorses 欠落・非配列・空 は false（throw しない）。
 * @param {{ data?: { races?: Array<{ darkHorses?: unknown }> } }} entry
 * @returns {boolean}
 */
export function entryHasDarkHorses(entry) {
  const races = entry && entry.data && entry.data.races;
  if (!Array.isArray(races)) return false;
  return races.some((r) => Array.isArray(r && r.darkHorses) && r.darkHorses.length > 0);
}

/**
 * todayJst と日付が完全一致し、かつ darkHorses を持つエントリだけを返す。
 * 過去日 fallback はしない。一致なしなら空配列。入力順は保持する。
 *
 * @param {Array<{ category?: string, date?: string, venueCode?: string, data?: object }>} entries
 * @param {string} todayJst  build 時 JST の当日（'YYYY-MM-DD'）
 * @returns {Array} todayJst 一致 & darkHorses ありのエントリ（同日複数 venue は全件）
 */
export function selectTodaysEntries(entries, todayJst) {
  if (!Array.isArray(entries)) return [];
  if (typeof todayJst !== 'string' || todayJst.length === 0) return [];
  return entries.filter(
    (e) => e && typeof e.date === 'string' && e.date === todayJst && entryHasDarkHorses(e),
  );
}
