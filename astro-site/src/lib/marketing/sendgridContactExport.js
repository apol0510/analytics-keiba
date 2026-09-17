/**
 * sendgridContactExport.js — prospect → **SendGrid Marketing Campaigns の contact** 変換層
 * （純粋・I/O なし）
 *
 * ## 責務
 *
 * 「次に送るべき通し番号」が決まった prospect を、SendGrid の
 * `PUT /v3/marketing/contacts`（upsert）へそのまま渡せる形にする。**送らない・書かない**。
 *
 * ## 守ること（1 つでも崩れたら import してはいけない）
 *
 * 1. **`ready` 以外は 1 件も出さない。** 反応済み・昇格済み・打ち切り・抑止・判定不能は
 *    変換の時点で落とす（SendGrid 側の除外設定に頼らない）。
 * 2. **通し番号ごとに宛先リストを分ける。** SendGrid の Automation は
 *    「最初の 1 通目」から始まるので、**4 通目から始めたい人は 4 通目始まりの
 *    Automation（＝専用リスト）**へ入れる以外に再送を避ける方法が無い。
 * 3. **custom field の id が 1 つでも解決できなければ何も作らない**（fail closed）。
 *    id を取り違えると、別の意味の値が contact へ入る。
 * 4. **リスト id が解決できない通し番号は出さない。** 宛先不明のまま upsert すると
 *    「どの Automation にも入らない contact」が残る。
 * 5. **集計にアドレスを含めない。** 応答・ログ・docs に出してよいのは件数だけ
 *    （`summarizeContactExport`）。アドレスを載せてよいのは **SendGrid へ送る本体だけ**。
 *
 * ⚠️ この層は **contact を作るための材料**しか持たない。名前・属性・購入履歴などは
 *    prospect プールに無いので**足さない**（推測で属性を作らない）。
 * ⚠️ 生成物（アドレスを含む配列 / CSV）を **repo・docs・ログへ保存しない**。
 *    受け渡しは実行時のメモリと SendGrid API のみ。
 */

import { normalizeEmail } from './prospectPolicy.js';
import { MIGRATION_STATUS, assertNoResend } from './sendgridNextMessage.js';
import { TOTAL_MESSAGES } from './sendgridMessagePlan.js';

/**
 * SendGrid 側に用意する custom field。
 *
 * ⚠️ **名前は SendGrid の制約に合わせて英小文字 + `_` のみ**。
 * ⚠️ `ak_prospect_hash` は `sha256(email)`。アドレスそのものは contact の
 *    `email` にしか置かない（AK 側の照合はこの hash で行う）。
 */
export const CONTACT_FIELDS = Object.freeze([
  Object.freeze({ name: 'ak_next_message', type: 'Number', note: '次に送る通し番号（1〜10）' }),
  Object.freeze({ name: 'ak_prospect_hash', type: 'Text', note: 'sha256(email)。AK 側の照合鍵' }),
  Object.freeze({ name: 'ak_delivered', type: 'Number', note: '移行時点の delivered 累計（打ち切りの分母）' }),
  Object.freeze({ name: 'ak_migrated_at', type: 'Text', note: '移行した日時（ISO8601 / UTC）' }),
]);

export const CONTACT_FIELD_NAMES = Object.freeze(CONTACT_FIELDS.map((f) => f.name));

/** 1 リクエストへ詰める contact 数。SendGrid の上限より十分小さく取る */
export const CONTACTS_PER_REQUEST = 1000;

/** 変換できない理由（**黙って落とさない**） */
export const EXPORT_REFUSE = Object.freeze({
  NOT_READY: 'not_ready',
  NO_EMAIL: 'no_email',
  NO_LIST: 'list_id_missing',
  BAD_MESSAGE_NUMBER: 'bad_message_number',
  RESEND_RISK: 'resend_risk',
  DUPLICATE: 'duplicate_email',
});

export const EXPORT_FAIL = Object.freeze({
  FIELD_IDS_MISSING: 'custom_field_ids_missing',
  NO_ENTRIES: 'no_entries',
});

const intOr = (v, dflt) => (Number.isInteger(Number(v)) ? Number(v) : dflt);

/**
 * SendGrid の `GET /v3/marketing/field_definitions` の応答 → `{name: id}`。
 * **宣言した field が 1 つでも欠けていたら `ok:false`**（勝手に作らない・推測しない）。
 */
export function resolveFieldIds(definitions) {
  const list = Array.isArray(definitions && definitions.custom_fields)
    ? definitions.custom_fields
    : (Array.isArray(definitions) ? definitions : []);
  const byName = new Map();
  for (const f of list) {
    const name = String((f && f.name) || '').trim();
    const id = String((f && f.id) || '').trim();
    if (name && id) byName.set(name, id);
  }
  const ids = {};
  const missing = [];
  for (const name of CONTACT_FIELD_NAMES) {
    if (byName.has(name)) ids[name] = byName.get(name);
    else missing.push(name);
  }
  if (missing.length > 0) {
    return { ok: false, reason: EXPORT_FAIL.FIELD_IDS_MISSING, missing, ids: {} };
  }
  return { ok: true, ids, missing: [] };
}

/**
 * contact の upsert 本体を組む。
 *
 * @param {{
 *   entries: Array<{email: string, hash?: string|null, status: string,
 *                   nextMessageNumber: number|null, highestSent?: number, delivered?: number}>,
 *   fieldIds: Record<string,string>,          // `resolveFieldIds` の出力
 *   listIdByMessage: Map<number,string>|object, // 通し番号 → SendGrid list id
 *   migratedAt: string,                        // ISO8601（呼び出し側が決める）
 *   perRequest?: number,
 * }} input
 * @returns {{ok: boolean, reason?: string, missing?: string[],
 *   batches: Array<{list_ids: string[], contacts: object[], startMessage: number}>,
 *   refused: Record<string, number>, counts: object}}
 */
export function buildContactUpserts({
  entries, fieldIds, listIdByMessage, migratedAt, perRequest,
} = {}) {
  const refused = {};
  const bump = (r) => { refused[r] = (refused[r] || 0) + 1; };

  const ids = fieldIds && typeof fieldIds === 'object' ? fieldIds : {};
  const missing = CONTACT_FIELD_NAMES.filter((n) => !ids[n]);
  if (missing.length > 0) {
    return {
      ok: false, reason: EXPORT_FAIL.FIELD_IDS_MISSING, missing, batches: [], refused, counts: {},
    };
  }

  const listOf = (n) => {
    if (listIdByMessage instanceof Map) return listIdByMessage.get(n) || null;
    const v = listIdByMessage && typeof listIdByMessage === 'object' ? listIdByMessage[n] : null;
    return v ? String(v) : null;
  };

  const at = String(migratedAt || '').trim();
  const size = Math.max(1, Math.min(intOr(perRequest, CONTACTS_PER_REQUEST), CONTACTS_PER_REQUEST));

  /** 通し番号ごとに集める（Automation の入口がそれぞれ違うため） */
  const byMessage = new Map();
  const seen = new Set();
  let accepted = 0;

  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e) continue;
    if (e.status !== MIGRATION_STATUS.READY) { bump(EXPORT_REFUSE.NOT_READY); continue; }
    const email = normalizeEmail(e.email);
    if (!email) { bump(EXPORT_REFUSE.NO_EMAIL); continue; }
    if (seen.has(email)) { bump(EXPORT_REFUSE.DUPLICATE); continue; }

    const n = intOr(e.nextMessageNumber, 0);
    if (n < 1 || n > TOTAL_MESSAGES) { bump(EXPORT_REFUSE.BAD_MESSAGE_NUMBER); continue; }

    // ⚠️ **ここでもう一度**再送を確かめる（判定と変換のどちらが壊れても止まるように）
    const guard = assertNoResend({ highestSent: intOr(e.highestSent, n - 1), nextMessageNumber: n });
    if (!guard.ok) { bump(EXPORT_REFUSE.RESEND_RISK); continue; }

    const listId = listOf(n);
    if (!listId) { bump(EXPORT_REFUSE.NO_LIST); continue; }

    seen.add(email);
    accepted += 1;
    if (!byMessage.has(n)) byMessage.set(n, { listId, contacts: [] });
    byMessage.get(n).contacts.push({
      email,
      custom_fields: {
        [ids.ak_next_message]: n,
        [ids.ak_prospect_hash]: String(e.hash || ''),
        [ids.ak_delivered]: intOr(e.delivered, 0),
        [ids.ak_migrated_at]: at,
      },
    });
  }

  if (accepted === 0) {
    return { ok: false, reason: EXPORT_FAIL.NO_ENTRIES, batches: [], refused, counts: { 受理: 0 } };
  }

  const batches = [];
  for (const [n, group] of [...byMessage.entries()].sort((a, b) => a[0] - b[0])) {
    for (let i = 0; i < group.contacts.length; i += size) {
      batches.push({
        startMessage: n,
        list_ids: [group.listId],
        contacts: group.contacts.slice(i, i + size),
      });
    }
  }
  return {
    ok: true,
    batches,
    refused,
    counts: {
      受理: accepted,
      拒否: Object.values(refused).reduce((a, b) => a + b, 0),
      リクエスト数: batches.length,
    },
  };
}

/**
 * 集計（**アドレスを 1 つも含めない**）。応答・ログ・docs へ出してよいのはこれだけ。
 */
export function summarizeContactExport(result) {
  const byMessage = {};
  for (const b of (result && result.batches) || []) {
    byMessage[b.startMessage] = (byMessage[b.startMessage] || 0) + b.contacts.length;
  }
  return {
    ok: result ? result.ok === true : false,
    理由: (result && result.reason) || null,
    通し番号別: byMessage,
    件数: (result && result.counts) || {},
    拒否の内訳: (result && result.refused) || {},
  };
}

/**
 * SendGrid の CSV import 用の行（画面から入れる運用も残せるように）。
 *
 * ⚠️ **戻り値はアドレスを含む。** repo / docs / ログへ保存しない。
 */
export function buildContactCsv({ entries, migratedAt } = {}) {
  const header = ['email', ...CONTACT_FIELD_NAMES];
  const rows = [];
  const refused = {};
  const bump = (r) => { refused[r] = (refused[r] || 0) + 1; };
  const seen = new Set();
  const at = String(migratedAt || '').trim();

  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.status !== MIGRATION_STATUS.READY) { bump(EXPORT_REFUSE.NOT_READY); continue; }
    const email = normalizeEmail(e.email);
    if (!email) { bump(EXPORT_REFUSE.NO_EMAIL); continue; }
    if (seen.has(email)) { bump(EXPORT_REFUSE.DUPLICATE); continue; }
    const n = intOr(e.nextMessageNumber, 0);
    if (n < 1 || n > TOTAL_MESSAGES) { bump(EXPORT_REFUSE.BAD_MESSAGE_NUMBER); continue; }
    seen.add(email);
    rows.push([email, String(n), String(e.hash || ''), String(intOr(e.delivered, 0)), at]);
  }
  return { header, rows, refused, counts: { 行数: rows.length } };
}

export default buildContactUpserts;
