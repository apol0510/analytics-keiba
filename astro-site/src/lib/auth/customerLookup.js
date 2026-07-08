/**
 * customerLookup.js — Customers 検索結果の 0件 / 1件 / 複数件を明確に区別する純粋関数
 *
 * PR-B 追加（マージブロッカー1）:
 *   同一正規化 email に対する Customers ヒットは **0 / 1 / 複数** で意味が異なる。
 *   これまで各 Function が `records[0]` を無条件採用していたため、重複レコードで
 *   「たまたま先頭の会員」で判定・トークン発行・Cookie 発行が起きうる汚染経路になっていた。
 *
 *   本関数で分類を 1 箇所に集約し、**複数件は fail closed**（会員判定・トークン作成・
 *   メール送信・Cookie 発行・Airtable 更新をいずれも行わない）ことを呼び出し側に強制する。
 *
 * I/O なし・依存ゼロ。Airtable の record 配列（各要素は `.id` / `.fields` を持つ）を受け取り、
 * plan / Status / recordId 等の内部値は返さない（SINGLE のときだけ record を渡す）。
 */

export const CUSTOMER_LOOKUP = Object.freeze({
  NONE: 'none',       // 未登録
  SINGLE: 'single',   // 一意（この record だけで会員判定してよい）
  CONFLICT: 'conflict', // 複数件 → fail closed（判定・発行・更新を一切しない）
});

/**
 * Customers 検索結果を分類する。
 * @param {Array<{ id?: string, fields?: Record<string, unknown> }>|null|undefined} rows
 * @returns {{ kind: 'none'|'single'|'conflict', record: { id: string|null, fields: object }|null }}
 */
export function classifyCustomerMatches(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { kind: CUSTOMER_LOOKUP.NONE, record: null };
  }
  if (rows.length === 1) {
    const r = rows[0] || {};
    return {
      kind: CUSTOMER_LOOKUP.SINGLE,
      record: { id: r.id ?? null, fields: r.fields ?? {} },
    };
  }
  return { kind: CUSTOMER_LOOKUP.CONFLICT, record: null };
}
