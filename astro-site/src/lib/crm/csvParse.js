/**
 * csvParse.js — 外部保有リストの CSV を**読むだけ**（純粋・I/O なし・書き込みなし）
 *
 * ── 何のためにあるか ──────────────────────────────────────────
 * 外部で保有している約 13,000 件の無料ユーザーリストを AK へ取り込む。その **前段**として、
 * 受け取ったファイルを「AK が扱える行の並び」へ変換する。判定（誰を入れる / 入れない）は
 * `customerImport.js` の仕事で、このモジュールは**形を整えるだけ**。
 *
 * ── 実ファイルはまだ無い ──────────────────────────────────────
 * 実 CSV は未受領。したがって**列名を推測で固定しない**。列名のゆらぎは
 * `customerImport.js` の別名表で吸収し、そこを増やせば新しい列に対応できるようにする。
 * ここでは「どの文字コードでも」「どの改行でも」「引用符付きでも」読めることに集中する。
 *
 * ── 個人情報 ──────────────────────────────────────────────────
 * このモジュールは `console` を一切使わない。戻り値に行の中身は入るが（判定に要る）、
 * **呼び出し側は件数しか外へ出さない**。エラーメッセージにも値を入れない
 *（「3 行目の xxx@example.com が不正」ではなく「不正なメールアドレス 1 件」と数える）。
 */

import { createHash } from 'node:crypto';

/**
 * パーサーの版。**挙動を変えたら必ず上げる**。
 * 下見（preview）に刻まれ、実行時に一致しなければ実行を拒否する
 * （＝古い下見の結果で新しいパーサーを走らせない）。
 */
export const PARSER_VERSION = 'csv-1';

/** 受け付ける最大バイト数。13,000 行 × 200 バイトでも 2.6MB 程度なので十分な余裕 */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** 受け付ける最大行数（ヘッダを除く）。想定 13,000 に対し余裕を持たせつつ青天井にしない */
export const MAX_ROWS = 60000;

/** 1 行あたりの最大列数（壊れたファイルで無限に列を作らせない） */
export const MAX_COLUMNS = 64;

/** 読み取りを断った理由（固定コード。値は入れない） */
export const CSV_ERROR = Object.freeze({
  EMPTY: 'empty_file',
  TOO_LARGE: 'file_too_large',
  TOO_MANY_ROWS: 'too_many_rows',
  UNSUPPORTED_ENCODING: 'unsupported_encoding',
  DECODE_FAILED: 'decode_failed',
  NO_HEADER: 'no_header',
  TOO_MANY_COLUMNS: 'too_many_columns',
});

export const CSV_ERROR_LABEL = Object.freeze({
  empty_file: 'ファイルが空です',
  file_too_large: `ファイルが大きすぎます（上限 ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)}MB）`,
  too_many_rows: `行数が多すぎます（上限 ${MAX_ROWS.toLocaleString()} 行）`,
  unsupported_encoding: '対応していない文字コードです（UTF-8 / Shift_JIS のみ）',
  decode_failed: '文字コードを判別できませんでした',
  no_header: '見出し行がありません',
  too_many_columns: '列が多すぎます',
});

/** 検出した文字コード */
export const ENCODING = Object.freeze({
  UTF8: 'utf-8',
  UTF8_BOM: 'utf-8-bom',
  SHIFT_JIS: 'shift_jis',
});

const BOM_UTF8 = [0xEF, 0xBB, 0xBF];
const BOM_UTF16LE = [0xFF, 0xFE];
const BOM_UTF16BE = [0xFE, 0xFF];

const startsWith = (bytes, sig) => sig.every((b, i) => bytes[i] === b);

/** ファイル内容の指紋。**中身は復元できない**（改ざん・差し替えの検知にだけ使う） */
export function hashBytes(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * バイト列 → 文字列。**MIME や拡張子は信用しない**（中身だけを見る）。
 *
 * 判定の順序:
 *   1. UTF-8 BOM があれば UTF-8（BOM は落とす）
 *   2. UTF-16 の BOM があれば**受け付けない**（対応表明しない文字コードを推測で読まない）
 *   3. UTF-8 として厳格に読めれば UTF-8
 *   4. 読めなければ Shift_JIS（CP932）として読む。ここで置換文字が出たら復号失敗
 *
 * @param {Uint8Array} bytes
 */
export function decodeCsv(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length === 0) return { ok: false, error: CSV_ERROR.EMPTY };
  if (b.length > MAX_FILE_BYTES) return { ok: false, error: CSV_ERROR.TOO_LARGE };
  if (startsWith(b, BOM_UTF16LE) || startsWith(b, BOM_UTF16BE)) {
    return { ok: false, error: CSV_ERROR.UNSUPPORTED_ENCODING };
  }

  const hasBom = startsWith(b, BOM_UTF8);
  const body = hasBom ? b.subarray(BOM_UTF8.length) : b;

  // 1) UTF-8 として厳格に読む（不正バイトがあれば例外）
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    return { ok: true, text, encoding: hasBom ? ENCODING.UTF8_BOM : ENCODING.UTF8, hasBom, bytes: b.length };
  } catch {
    // UTF-8 ではない → 2) Shift_JIS（CP932 を含む WHATWG shift_jis）として読む
  }

  try {
    const text = new TextDecoder('shift_jis').decode(body);
    // 置換文字が出るのは復号失敗。**推測で直さない**（気づかせる）
    if (text.includes('�')) return { ok: false, error: CSV_ERROR.DECODE_FAILED };
    return { ok: true, text, encoding: ENCODING.SHIFT_JIS, hasBom: false, bytes: b.length };
  } catch {
    return { ok: false, error: CSV_ERROR.DECODE_FAILED };
  }
}

/**
 * CSV 本文 → 二次元配列（RFC 4180 準拠）。
 *
 * 対応:
 *   - 引用符の中のカンマ・改行・二重引用符（`""` → `"`)
 *   - CRLF / LF / CR のいずれの改行でも同じ結果
 *   - 空行は**行として数えない**（末尾の改行で 1 行増えない）
 *
 * @param {string} text
 * @returns {{ ok: true, rows: string[][] } | { ok: false, error: string }}
 */
export function parseCsvText(text) {
  const s = String(text ?? '');
  if (!s.trim()) return { ok: false, error: CSV_ERROR.EMPTY };

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let started = false;   // この行に 1 文字でも入ったか（空行判定用）

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => {
    endField();
    // 全列が空の行は捨てる（空行・末尾改行）
    if (started && row.some((c) => c.trim() !== '')) rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 1; }   // "" → "
        else quoted = false;
      } else field += ch;
      started = true;
      continue;
    }
    if (ch === '"') { quoted = true; started = true; continue; }
    if (ch === ',') { endField(); started = true; continue; }
    if (ch === '\r') {
      if (s[i + 1] === '\n') i += 1;                      // CRLF
      endRow();
      continue;
    }
    if (ch === '\n') { endRow(); continue; }
    field += ch;
    if (ch.trim() !== '') started = true;
  }
  endRow();   // 最終行（改行で終わっていない場合）

  if (rows.length === 0) return { ok: false, error: CSV_ERROR.EMPTY };
  if (rows[0].length > MAX_COLUMNS) return { ok: false, error: CSV_ERROR.TOO_MANY_COLUMNS };
  return { ok: true, rows };
}

/** 値の掃除。**全角空白も落とす**（見えない差で「別人」にしない） */
export function cleanCell(v) {
  return String(v ?? '')
    .replace(/[​-‍﻿]/g, '')   // ゼロ幅
    .replace(/[　]/g, ' ')               // 全角空白 → 半角
    .trim();
}

/**
 * 見出し行を正規化した指紋。**列の順番が違っても同じ値**になる
 *（順不同のファイルを「別物」と誤判定しないため）。
 * 下見に刻み、実行時に一致しなければ拒否する。
 */
export function normalizedHeaderHash(header) {
  const cols = (Array.isArray(header) ? header : [])
    .map((h) => cleanCell(h).normalize('NFKC').toLowerCase().replace(/[\s_-]/g, ''))
    .filter(Boolean)
    .sort();
  return createHash('sha256').update(cols.join('|'), 'utf8').digest('hex').slice(0, 16);
}

/**
 * バイト列 → 行オブジェクトの配列（判定に渡せる形）。
 *
 * ⚠️ **知らない列は落とす**（勝手に顧客レコードへ書かないため）。落とした列名は
 *    件数と一緒に呼び出し側へ返して「取り込まれない列がある」と見せる。
 *
 * @param {{ bytes: Uint8Array, mapColumnsFn: (header: string[]) => object }} input
 *   mapColumnsFn は `customerImport.mapColumns` を渡す（別名表の単一源をここに複製しない）
 */
export function buildImportRows({ bytes, mapColumnsFn }) {
  const decoded = decodeCsv(bytes);
  if (!decoded.ok) return { ok: false, error: decoded.error };

  const parsed = parseCsvText(decoded.text);
  if (!parsed.ok) return { ok: false, error: parsed.error, encoding: decoded.encoding };

  const [header, ...body] = parsed.rows;
  if (!header || header.length === 0) {
    return { ok: false, error: CSV_ERROR.NO_HEADER, encoding: decoded.encoding };
  }
  if (body.length > MAX_ROWS) {
    return { ok: false, error: CSV_ERROR.TOO_MANY_ROWS, encoding: decoded.encoding, rowCount: body.length };
  }

  const cleanHeader = header.map(cleanCell);
  const mapping = typeof mapColumnsFn === 'function' ? mapColumnsFn(cleanHeader) : { ok: false, mapped: {}, missing: ['email'], unknown: [] };

  const rows = [];
  let unsupportedRows = 0;
  for (const cells of body) {
    const obj = {};
    for (const [key, idx] of Object.entries(mapping.mapped || {})) {
      obj[key] = cleanCell(cells[idx]);
    }
    // 列数が見出しより多い行は、どの値がどの列か決められない。
    // **黙って捨てず・黙って取り込まず**、印を付けて「要確認」へ回す
    if (cells.length > cleanHeader.length) {
      obj.__unsupported = true;
      unsupportedRows += 1;
    }
    rows.push(obj);
  }

  return {
    ok: mapping.ok === true,
    error: mapping.ok === true ? null : 'missing_required_column',
    missing: mapping.missing || [],
    rows,
    rowCount: rows.length,
    unsupportedRows,
    encoding: decoded.encoding,
    hasBom: decoded.hasBom === true,
    bytes: decoded.bytes,
    /** 検出した列（AK が意味を知っている列だけ）。**値は含まない** */
    detectedColumns: Object.keys(mapping.mapped || {}),
    /** 取り込まない列の**名前だけ**（値は返さない） */
    ignoredColumns: (mapping.unknown || []).map((h) => cleanCell(h)).filter(Boolean),
    headerHash: normalizedHeaderHash(cleanHeader),
    parserVersion: PARSER_VERSION,
  };
}

export default buildImportRows;
