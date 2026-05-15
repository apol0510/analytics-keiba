// CSV 出力ヘルパー
// 仕様: docs/NEWSLETTER_BRAND_BACKFILL_SPEC.md §8.3

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// UTF-8 BOM (U+FEFF) - Excel が日本語 CSV を正しく開けるように先頭に付与する。
// 明示的な escape で書くことで、ソース上で不可視文字に依存しない。
const BOM = '\uFEFF';

/**
 * RFC 4180 準拠の CSV フィールドエスケープ
 * @param {*} value
 * @returns {string}
 */
export function escapeCsvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * CSV を書き出す。UTF-8 BOM 付き、改行 LF。
 * @param {string} filepath
 * @param {object[]} rows
 * @param {string[]} columns - ヘッダ列名（rows の各 key と一致するもの）
 * @returns {Promise<{ rows: number, bytes: number }>}
 */
export async function writeCsv(filepath, rows, columns) {
  await mkdir(dirname(filepath), { recursive: true });
  const header = columns.map((c) => escapeCsvField(c)).join(',');
  const body = rows
    .map((row) => columns.map((c) => escapeCsvField(row[c])).join(','))
    .join('\n');
  const content = rows.length === 0
    ? `${BOM}${header}\n`
    : `${BOM}${header}\n${body}\n`;
  await writeFile(filepath, content, 'utf8');
  return { rows: rows.length, bytes: Buffer.byteLength(content, 'utf8') };
}
