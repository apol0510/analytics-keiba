/**
 * airtableWritableFields.js — **作成時に書き戻せる field だけ**を選り分ける（純粋・I/O なし）
 *
 * ## なぜ要るか
 *
 * 控え（export）は監査のために**全フィールド**を持つ。
 * ところが Airtable には**書き込めない field** があり、それを混ぜて POST すると
 * **復元そのものが失敗する**（rollback が効かない ＝ 削除が取り返しのつかない操作になる）。
 *
 * 本番 Customers の `登録日` は **`createdTime`**（作成時刻の自動値）。
 * 控えをそのまま POST すると、ここで落ちる。
 *
 * ## ⚠️ 許可制（allow-list）にする
 *
 * 「計算 field を除く」ではなく「**書けると分かっている型だけ通す**」。
 * 新しい型が増えたときに**黙って書きに行かない**ため（fail closed）。
 */

/**
 * 作成時に値を渡せる型。**ここに無い型は通さない**。
 * （Airtable の field type 名。`multipleLookupValues` などの計算型は意図的に入れていない）
 */
export const WRITABLE_FIELD_TYPES = Object.freeze(new Set([
  'singleLineText', 'multilineText', 'richText', 'email', 'url', 'phoneNumber',
  'number', 'currency', 'percent', 'rating', 'duration',
  'checkbox', 'singleSelect', 'multipleSelects',
  'date', 'dateTime', 'barcode',
]));

/**
 * **絶対に POST しない**型（読み取り専用・自動計算）。
 * `WRITABLE_FIELD_TYPES` の裏返しだが、**意図を残すために明示**しておく
 * （「うっかり allow-list へ足す」ことへの歯止め）。
 */
export const NEVER_WRITE_FIELD_TYPES = Object.freeze(new Set([
  'createdTime', 'lastModifiedTime', 'createdBy', 'lastModifiedBy',
  'formula', 'rollup', 'count', 'multipleLookupValues', 'autoNumber',
  'button', 'aiText', 'externalSyncSource',
]));

/**
 * 復元で**リンクを張り直したくない**型。
 *
 * ⚠️ `multipleRecordLinks` は書けるが、**復元では使わない**。
 *    控えに入っているのは削除前のリンク相手の id で、こちら側の recordId は
 *    復元で変わる。リンクの復旧は**別工程**（再配線）として明示的に扱う。
 */
export const LINK_FIELD_TYPES = Object.freeze(new Set(['multipleRecordLinks']));

/**
 * schema（Meta API の `fields`）から「作成時に書ける field 名」を作る。
 *
 * @param {Array<{name:string,type:string}>} fields
 * @returns {{writable: Set<string>, computed: Set<string>, links: Set<string>, unknown: Set<string>}}
 */
export function classifyFields(fields) {
  const writable = new Set(); const computed = new Set();
  const links = new Set(); const unknown = new Set();
  for (const f of Array.isArray(fields) ? fields : []) {
    const name = String((f && f.name) || '');
    const type = String((f && f.type) || '');
    if (!name) continue;
    if (LINK_FIELD_TYPES.has(type)) { links.add(name); continue; }
    if (NEVER_WRITE_FIELD_TYPES.has(type)) { computed.add(name); continue; }
    if (WRITABLE_FIELD_TYPES.has(type)) { writable.add(name); continue; }
    // ⚠️ 知らない型は**書かない**（黙って POST しない）
    unknown.add(name);
  }
  return { writable, computed, links, unknown };
}

/**
 * 控えの 1 レコードから、**そのまま POST してよい fields** だけを作る。
 *
 * @param {object} fields 控えの fields（全フィールド）
 * @param {Set<string>} writable `classifyFields().writable`
 * @returns {{fields: object, dropped: string[]}}
 */
export function buildRestoreFields(fields, writable) {
  const src = (fields && typeof fields === 'object') ? fields : {};
  const allow = writable instanceof Set ? writable : new Set();
  const out = {}; const dropped = [];
  for (const [k, v] of Object.entries(src)) {
    if (!allow.has(k)) { dropped.push(k); continue; }
    if (v === undefined || v === null || v === '') continue;   // 空は送らない
    out[k] = v;
  }
  return { fields: out, dropped };
}

/**
 * 復元 payload が本番 schema に対して**成立するか**を確かめる（送る前の検算）。
 *
 * @returns {{ok:boolean, reasons:string[], checked:number}}
 */
export function validateRestorePayload({ records, writable, computed, links, unknown } = {}) {
  const list = Array.isArray(records) ? records : [];
  const reasons = [];
  const allow = writable instanceof Set ? writable : new Set();
  const bad = new Set([
    ...(computed instanceof Set ? computed : []),
    ...(links instanceof Set ? links : []),
    ...(unknown instanceof Set ? unknown : []),
  ]);
  if (list.length === 0) reasons.push('no_records');
  for (const r of list) {
    const f = (r && r.fields) || {};
    for (const k of Object.keys(f)) {
      if (bad.has(k)) reasons.push(`computed_field_in_payload:${k}`);
      else if (!allow.has(k)) reasons.push(`unknown_field_in_payload:${k}`);
    }
    if (!String(f.Email || '').trim()) reasons.push('missing_email');
  }
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], checked: list.length };
}
