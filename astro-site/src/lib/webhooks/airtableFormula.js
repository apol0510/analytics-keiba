/**
 * airtableFormula.js — Airtable `filterByFormula` へ外部入力を埋め込むための単一源（純粋関数）。
 *
 * 背景（2026-07-21）:
 * `sendgrid-webhook.js` が `SEARCH("${email}", {Email})` と**未エスケープの外部入力**を
 * formula へ直挿ししていた。`"` を含む入力で formula 構造が壊れ、意図しないレコードが
 * マッチ→ PATCH される（formula injection）。
 *
 * 恒久ルール:
 * - formula へ文字列を埋めるときは **必ず `formulaString()` を通す**。テンプレート直挿し禁止。
 * - 制御文字・改行は除去する（formula を複数行に割らせない）。
 */

/** 制御文字（C0 + DEL）。formula を壊す / ログを汚すため除去する。 */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f]', 'g');

/**
 * 文字列を Airtable formula の**ダブルクォート文字列リテラル**へ安全に変換する。
 * 戻り値は前後の `"` を含む完成したリテラル。
 *
 * @param {unknown} value
 * @returns {string} 例: `"a\"b"`
 */
export function formulaString(value) {
  const s = value === undefined || value === null ? '' : String(value);
  const sanitized = s
    .replace(CONTROL_CHARS, '')  // 制御文字・改行を除去
    .replace(/\\/g, '\\\\')      // バックスラッシュを先にエスケープ
    .replace(/"/g, '\\"');       // ダブルクォートをエスケープ
  return `"${sanitized}"`;
}

/**
 * `{Email}` の完全一致検索用 formula を組み立てる。
 * 旧実装の `SEARCH()` は部分一致で、`a@b.com` が `xa@b.com` にもマッチしうるため
 * **完全一致（`=`）**へ寄せる。
 *
 * @param {string} fieldName Airtable のフィールド名（コード内固定値のみを渡すこと）
 * @param {unknown} value 外部入力可
 */
export function equalsFormula(fieldName, value) {
  return `{${fieldName}}=${formulaString(value)}`;
}
