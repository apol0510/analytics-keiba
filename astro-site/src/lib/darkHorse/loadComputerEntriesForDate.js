/**
 * loadComputerEntriesForDate.js — 穴馬抽出ページ（SSR）が **リクエスト時**に読む computer JSON loader
 *
 * `src/data/computer/{jra,nankan}/YYYY/MM/YYYY-MM-DD-{VENUE}.json` から
 * **指定 1 日分だけ**を読み、`selectTodaysEntries` が受け取る
 * `{ path, category, date, venueCode, data }` 形へ正規化して返す。
 *
 * ── なぜ作ったか（2026-08-30 不具合）────────────────────────────
 * 旧実装は `import.meta.glob('/src/data/computer/**\/*.json', { eager: true })` で
 * **全日付（約 41MB）をビルド時にバンドルへ焼き込み**、`prerender = true` のページが
 * ビルド時刻の JST で当日を決めていた。ビルドは前日夕方の自動取込でしか走らないため、
 * 当日は終日「前日の穴馬」が表示され続けた。
 * SSR 化に合わせて **当日分だけを fs で読む** loader へ置き換える
 * （バンドル肥大も同時に解消。SSR 関数へ残す日数は runtimeDataRetention.js が決める）。
 *
 * 設計方針:
 *   - **読むだけ**。算出・書込・整形なし。値は改変せず `data` にそのまま載せる。
 *   - **throw しない**。ディレクトリ無し / 読み取り失敗 / JSON 破損は
 *     その 1 件を捨てて空配列 or 残りを返す（SSR ページを 500 にしない）。
 *   - **他日への fallback をしない**。指定日のファイルが無ければ空配列。
 *     「前日を代わりに出す」挙動は絶対に足さない（本不具合そのもの）。
 *   - 外部 API（Airtable / SendGrid 等）は**一切呼ばない**。fs のみ。
 *   - `date` は **ファイル名**から取る（旧 glob 実装と同一の契約）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 穴馬抽出の対象カテゴリ（表示順は呼び出し側が決める）。 */
export const DARK_HORSE_CATEGORIES = Object.freeze(['jra', 'nankan']);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * 指定日の computer JSON が置かれるディレクトリ。date 不正なら null。
 *
 * @param {string} category 'jra' | 'nankan'
 * @param {string} date 'YYYY-MM-DD'
 * @param {string} projectRoot 既定: process.cwd()
 * @returns {string|null}
 */
export function computerDirForDate(category, date, projectRoot = process.cwd()) {
  const m = DATE_RE.exec(String(date ?? ''));
  if (!m || !category) return null;
  return join(projectRoot, 'src', 'data', 'computer', String(category), m[1], m[2]);
}

/**
 * 指定 1 日分の computer エントリを読む。**他日は絶対に混ぜない**。
 *
 * @param {string} date 'YYYY-MM-DD'（リクエスト時 JST の当日）
 * @param {object} [opts]
 * @param {string} [opts.projectRoot] 既定: process.cwd()
 * @param {string[]} [opts.categories] 既定: DARK_HORSE_CATEGORIES
 * @returns {Array<{ path: string, category: string, date: string, venueCode: string, data: object }>}
 *          指定日のファイルが無ければ空配列（fallback しない）
 */
export function loadComputerEntriesForDate(date, opts = {}) {
  const { projectRoot = process.cwd(), categories = DARK_HORSE_CATEGORIES } = opts;
  const day = String(date ?? '');
  if (!DATE_RE.test(day)) return [];

  // day は上のガードで [0-9-] のみ。RegExp へ埋めても安全。
  const fileRe = new RegExp(`^${day}-([A-Z]+)\\.json$`);
  const out = [];

  for (const category of categories) {
    const dir = computerDirForDate(category, day, projectRoot);
    if (!dir || !existsSync(dir)) continue;

    let names;
    try {
      names = readdirSync(dir);
    } catch (e) {
      console.warn(`[loadComputerEntriesForDate] ディレクトリを読めない (${dir}): ${e.message}`);
      continue;
    }

    for (const name of names.slice().sort()) {
      const fm = fileRe.exec(name);
      if (!fm) continue;
      const file = join(dir, name);

      let data;
      try {
        data = JSON.parse(readFileSync(file, 'utf-8'));
      } catch (e) {
        console.warn(`[loadComputerEntriesForDate] JSON parse 失敗 (${file}): ${e.message}`);
        continue;
      }
      if (!data || typeof data !== 'object' || !Array.isArray(data.races)) continue;

      out.push({ path: file, category, date: day, venueCode: fm[1], data });
    }
  }

  return out;
}
