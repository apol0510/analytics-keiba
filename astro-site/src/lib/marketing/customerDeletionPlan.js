/**
 * customerDeletionPlan.js — **どの Customers 行なら消してよいか**を決める（純粋・I/O なし）
 *
 * ## 前提
 *
 * CSV 取り込み分を prospect プール（Redis）へ移したので、Customers 側の重複行を消す。
 * ただし **消してよいのは「本当に Redis へ移り終わっていて、かつ移して良かった人」だけ**。
 *
 * ## ⚠️ 5 つ全部を満たしたときだけ消す（1 つでも欠けたら消さない）
 *
 * | # | 条件 | なぜ |
 * |---|---|---|
 * | 1 | `decideForRecord()` が **`migrate`** | 取り込み由来でない / 本人が動いた / 反応あり / 配信停止 /
 * |   |                                     | 運営付与のみ / 由来不明 を**構造的に除外**する（単一源）|
 * | 2 | prospect **レコードが存在する** | 移っていない人を消すと復元手段が消える |
 * | 3 | prospect が **送信候補の state** | 移った先で送れない状態なら、まだ消せない |
 * | 4 | **`ACTIVE_INDEX` に居る** | レコードだけあって索引に居ない事故（2026-08-27）を通さない |
 * | 5 | **開封の集計が読めている** | 読めないと反応した人を `migrate` と誤判定する |
 *
 * ⚠️ 1 を自前で書き直さない。`decideForRecord()`（`prospectMigrationPlan.js`）が単一源で、
 *    native / converted / engaged / operator grant / suppressed / ambiguous の除外はそこが持つ。
 *
 * ⚠️ 索引・プール・開封のいずれかが**読めなかったら対象 0 件**（fail closed）。
 *    「読めない」を「移り終わっている」と扱うと、**移っていない人を消す**。
 */

import { decideForRecord, MIGRATION_DECISION } from './prospectMigrationPlan.js';
import { isSendableState } from './prospectStore.js';

/** 消さなかった理由 */
export const DELETE_BLOCK = Object.freeze({
  /** 移行対象ではない（＝残すべき顧客）。内訳は `decision` に入る */
  NOT_MIGRATE: 'not_migrate',
  /** prospect レコードが無い（＝移り終わっていない）*/
  NOT_IN_POOL: 'not_in_pool',
  /** prospect は在るが送信できない状態 */
  NOT_SENDABLE: 'not_sendable',
  /** ⚠️ レコードは在るが送信候補の索引に居ない（2026-08-27 の事故と同じ形）*/
  NOT_IN_ACTIVE_INDEX: 'not_in_active_index',
  /** アドレスが空など、hash を作れない */
  NO_EMAIL: 'no_email',
});

/** 全体を止める理由（**1 件も消さない**）*/
export const DELETE_ABORT = Object.freeze({
  ENGAGEMENT_UNAVAILABLE: 'engagement_unavailable',
  POOL_UNAVAILABLE: 'pool_unavailable',
  INDEX_UNAVAILABLE: 'index_unavailable',
});

const norm = (v) => String(v ?? '').trim().toLowerCase();

/**
 * 1 ページぶんの削除計画。**recordId と件数だけ**を返す（アドレスは持ち回らない）。
 *
 * @param {{
 *   records: Array<{id:string, fields:object}>,
 *   engagedEmails: Set<string>|null,     // null = 開封を読めていない → 中止
 *   engagementApplied: boolean,
 *   prospectByHash: Map<string, object>|null,  // null = プールを読めていない → 中止
 *   activeByHash: Map<string, boolean>|null,   // null = 索引を読めていない → 中止
 *   hashOf: (email: string) => string,
 * }} input
 */
export function planCustomerDeletion({
  records, engagedEmails, engagementApplied, prospectByHash, activeByHash, hashOf,
} = {}) {
  const out = {
    ok: true,
    abort: null,
    checked: 0,
    deletableIds: [],
    /** 消さなかった内訳 */
    blocked: {},
    /** 移行判定の内訳（`decideForRecord` の decision ごと）*/
    decisions: {},
  };
  const list = Array.isArray(records) ? records : [];
  out.checked = list.length;

  // ⚠️ 材料が欠けていたら **1 件も消さない**
  if (engagementApplied !== true || !(engagedEmails instanceof Set)) {
    return { ...out, ok: false, abort: DELETE_ABORT.ENGAGEMENT_UNAVAILABLE, deletableIds: [] };
  }
  if (!(prospectByHash instanceof Map)) {
    return { ...out, ok: false, abort: DELETE_ABORT.POOL_UNAVAILABLE, deletableIds: [] };
  }
  if (!(activeByHash instanceof Map)) {
    return { ...out, ok: false, abort: DELETE_ABORT.INDEX_UNAVAILABLE, deletableIds: [] };
  }
  if (typeof hashOf !== 'function') {
    return { ...out, ok: false, abort: DELETE_ABORT.POOL_UNAVAILABLE, deletableIds: [] };
  }

  const bumpBlock = (k) => { out.blocked[k] = (out.blocked[k] || 0) + 1; };
  const bumpDecision = (k) => { out.decisions[k] = (out.decisions[k] || 0) + 1; };

  for (const r of list) {
    const fields = (r && r.fields) || {};
    const { decision } = decideForRecord({ fields, engagedEmails });
    bumpDecision(decision);

    // ① 移行対象でなければ**消さない**（残すべき顧客）
    if (decision !== MIGRATION_DECISION.MIGRATE) { bumpBlock(DELETE_BLOCK.NOT_MIGRATE); continue; }

    const email = norm(fields.Email);
    if (!email) { bumpBlock(DELETE_BLOCK.NO_EMAIL); continue; }
    const hash = hashOf(email);

    // ② prospect レコードが在る（＝移り終わっている）
    const rec = prospectByHash.get(hash);
    if (!rec) { bumpBlock(DELETE_BLOCK.NOT_IN_POOL); continue; }

    // ③ 移った先で送れる状態
    if (!isSendableState(rec.state)) { bumpBlock(DELETE_BLOCK.NOT_SENDABLE); continue; }

    // ④ 送信候補の索引に居る（レコードだけ在る事故を通さない）
    if (activeByHash.get(hash) !== true) { bumpBlock(DELETE_BLOCK.NOT_IN_ACTIVE_INDEX); continue; }

    out.deletableIds.push(r.id);
  }
  return out;
}

/** 削除を許す確認文字列（画面から流し込めない値にしておく）*/
export const DELETE_CONFIRM = 'DELETE MIGRATED CUSTOMERS';
/** 1 回の実行で消せる上限（**取り違えの被害を構造的に小さくする**）*/
export const DELETE_MAX_PER_CALL = 200;

/** 削除を止める理由 */
export const DELETE_GATE = Object.freeze({
  NOT_CONFIRMED: 'not_confirmed',
  NO_IDS: 'no_ids',
  TOO_MANY: 'too_many',
  EXPORT_NOT_PROVEN: 'export_not_proven',
});

/**
 * 実削除を許すか。**下見が既定**なので、ここが true になるのは明示したときだけ。
 *
 * ⚠️ `exportProven` は「**消す前に全フィールドを控えた**」ことの申告。
 *    Airtable の削除は元に戻せないので、控えを取っていない実行は通さない。
 */
export function canDeleteCustomers({ confirmed, ids, exportProven } = {}) {
  const reasons = [];
  if (confirmed !== true) reasons.push(DELETE_GATE.NOT_CONFIRMED);
  const list = Array.isArray(ids) ? ids : [];
  if (list.length === 0) reasons.push(DELETE_GATE.NO_IDS);
  if (list.length > DELETE_MAX_PER_CALL) reasons.push(DELETE_GATE.TOO_MANY);
  if (exportProven !== true) reasons.push(DELETE_GATE.EXPORT_NOT_PROVEN);
  return { allowed: reasons.length === 0, reasons };
}

/**
 * 実行するときに**実際に消す id** を決める。
 *
 * ⚠️ 呼び出し側が渡した id を**そのまま消さない**。サーバ側で作り直した計画に
 *    入っている id だけを消す（要求と現在の状態が食い違ったら消さない）。
 * ⚠️ Customers に見つからない id は **already_deleted**（2 回実行しても安全）。
 *
 * @param {{requestedIds: string[], deletableIds: string[], presentIds: string[]}} input
 */
export function reconcileDeletionTargets({ requestedIds, deletableIds, presentIds } = {}) {
  const requested = [...new Set((requestedIds || []).map(String))];
  const deletable = new Set((deletableIds || []).map(String));
  const present = new Set((presentIds || []).map(String));
  const toDelete = []; const alreadyDeleted = []; const refused = [];
  for (const id of requested) {
    if (deletable.has(id)) { toDelete.push(id); continue; }
    // ⚠️ もう Customers に無い＝前回の実行で消えている（冪等）
    if (!present.has(id)) { alreadyDeleted.push(id); continue; }
    // 居るのに消せない＝状態が変わった。**消さない**
    refused.push(id);
  }
  return { toDelete, alreadyDeleted, refused };
}
