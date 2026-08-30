/**
 * selectTodaysDarkHorses.js — 穴馬抽出ページの「当日データのみ」選定を固定する純粋関数
 *
 * `/dark-horse-picks/`（dark-horse-picks.astro / **SSR: prerender = false**）は、
 * **リクエスト時** JST の当日 (`todayJst` = `jstDateString(new Date())`) と
 * **日付文字列が完全一致**する computer エントリだけを表示対象にする。
 *
 * ⚠️ ビルド時に `todayJst` を決めてはいけない（2026-08-30 不具合の再発防止）。
 *    ビルドは前日夕方の自動取込でしか走らないため、静的生成だと当日は終日
 *    前日データが表示される。判定は必ずリクエスト時に行う。
 *
 * 恒久仕様（回帰防止の対象）:
 *   - 過去日への fallback を **しない**（「最新日」ではなく「todayJst 一致」で選ぶ）。
 *   - todayJst に一致する darkHorses 入りエントリが無ければ **空配列**を返す
 *     （前日などの古い日付を代わりに出さない）。
 *   - 同日に複数会場（venue）があれば、その **同日分だけ**すべて対象にする。
 *   - date 不正 / races 非配列 / darkHorses 欠落・非配列・空 は安全に無視（throw しない）。
 *
 * I/O なし・依存ゼロ。当日分の computer JSON を `{ category, date, venueCode, data }` 形で
 * 読み出すのは `loadComputerEntriesForDate.js`（fs 読み込み）の役目。表示・整形はしない。
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

/**
 * 「今日（JST）」を 'YYYY-MM-DD' で返す純粋関数。
 *
 * ⚠️ なぜ独立した関数なのか（2026-08-30 の不具合）:
 *   `/dark-horse-picks/` は `prerender = true`（ビルド時静的生成）のまま、この計算を
 *   **ビルド時**に 1 回だけ行っていた。ビルドは前日夕方の自動取込でしか走らないため
 *   `todayJst` が前日で固定され、**当日は終日「前日の穴馬」が表示され続けていた**
 *   （2026-08-30 12 時時点の本番 HTML が 2026-08-29 のデータだった）。
 *   恒久対応としてページを SSR (`prerender = false`) 化し、この関数を
 *   **リクエストごと**に呼ぶ。日付境界（JST 0 時）はテストで固定する。
 *
 * UTC+9 を足してから UTC 表現の日付を取り出す。`toLocaleDateString` は環境依存の
 * 書式差が出るため使わない。
 *
 * @param {Date} [now] 基準時刻（省略時は現在時刻）。テストから固定時刻を渡す。
 * @returns {string} JST の 'YYYY-MM-DD'。now が不正なら空文字（呼び出し側は空で 0 件になる）
 */
export function jstDateString(now = new Date()) {
  const t = now instanceof Date ? now.getTime() : NaN;
  if (!Number.isFinite(t)) return '';
  return new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
