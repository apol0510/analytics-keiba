/**
 * Airtable を **打ち切らずに**読むための共通ロジック（純粋 + fetch 注入）。
 *
 * ── なぜ専用に作るか ────────────────────────────────────────
 * 既存の `fetchAll` は `MAX_PAGES` で **`break` するだけ**で、打ち切りをエラーに
 * しない。移行でこれを使うと「少ない集合を全部だと思い込む」ため、
 *   - Redis へ入れ損ねた鍵ができる → **その相手へ再送する**
 *   - 突合が **偽の「一致」** を出す
 * のどちらかが必ず起きる。ここでは **打ち切り＝例外**にする。
 *
 * ページ上限は「無限ループの安全弁」であって「読む量の制限」ではない。
 */

export class IncompleteReadError extends Error {
  constructor(table, pages) {
    super(`incomplete_read:${table}:pages=${pages}`);
    this.name = 'IncompleteReadError';
    this.table = table;
    this.pages = pages;
  }
}

/** 100,000 行ぶん。到達したら設計の想定外なので例外にする */
export const SAFETY_MAX_PAGES = 1000;

/**
 * ページを 1 枚ずつ読み進める generator 相当。IO は `fetchPage` に注入する。
 *
 * @param {{
 *   table: string,
 *   fetchPage: (offset: string|null) => Promise<{records: object[], offset?: string|null}>,
 *   onPage?: (records: object[], pageIndex: number) => Promise<void>|void,
 *   maxPages?: number,
 * }} input
 * @returns {Promise<{ pages: number, records: number }>}
 */
export async function readAllPages({ table, fetchPage, onPage, maxPages = SAFETY_MAX_PAGES } = {}) {
  if (typeof fetchPage !== 'function') throw new Error('complete_read:fetch_page_missing');
  let offset = null;
  let pages = 0;
  let records = 0;
  do {
    const page = await fetchPage(offset);
    if (!page || !Array.isArray(page.records)) {
      // 取得できなかったものを「0 件」と扱わない
      throw new IncompleteReadError(table, pages);
    }
    records += page.records.length;
    pages += 1;
    if (typeof onPage === 'function') await onPage(page.records, pages - 1);
    offset = page.offset || null;
    if (offset && pages >= maxPages) throw new IncompleteReadError(table, pages);
  } while (offset);
  return { pages, records };
}

/**
 * 読み終えた集合が期待どおりの大きさか。
 * **期待値が分からないときは検査しない**（推測の期待値で落とさない）。
 */
export function assertExpectedCount({ table, actual, expected }) {
  if (expected === null || expected === undefined) return { checked: false, ok: true };
  const e = Number(expected);
  if (!Number.isFinite(e)) return { checked: false, ok: true };
  if (Number(actual) !== e) {
    throw new Error(`complete_read:count_mismatch:${table}:${actual}!=${e}`);
  }
  return { checked: true, ok: true };
}
