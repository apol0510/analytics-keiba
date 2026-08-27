/**
 * deliveryRewirePlan.js — 復元後の `CampaignDeliveries.CustomerRecordId` を張り直す（純粋・I/O なし）
 *
 * ## なぜ要るか
 *
 * `CustomerRecordId` は **`singleLineText`（ただの文字列コピー）**でリンクではない。
 * Customers を消して復元すると **recordId が変わる**のに、Airtable は何も直さない。
 * 本番実測で **23,452 行**が削除対象を参照しており、放置すると
 * 「どの会員へ何通送ったか」を recordId で辿れなくなる。
 *
 * ⚠️ **「prospect は hash だから配信は続く」は rollback の完了条件ではない。**
 *    配信は続くが、監査の線は切れたままになる。
 *
 * ## ⚠️ 他人の行を絶対に書き換えない
 *
 * 対応表に載っている `oldId` の行だけを対象にし、さらに
 * **`RecipientEmail` が対応表の相手と一致すること**を確かめてから書き換える。
 * recordId は使い回されないが、**取り違えたときの被害が大きすぎる**ので二重に確かめる。
 */

/** 書き換えなかった理由 */
export const REWIRE_REFUSE = Object.freeze({
  /** 対応表に無い（＝別の会員の行。**触らない**）*/
  NOT_IN_MAPPING: 'not_in_mapping',
  /** ⚠️ 行のアドレスが対応表の相手と違う（**取り違え**）*/
  EMAIL_MISMATCH: 'email_mismatch',
  /** 行にアドレスが無く、突き合わせられない */
  NO_EMAIL_ON_ROW: 'no_email_on_row',
  /** 新しい recordId が recordId の形をしていない */
  BAD_NEW_ID: 'bad_new_id',
});

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;
const lower = (v) => String(v ?? '').trim().toLowerCase();

/**
 * 対応表を作る。**`oldId` / `newId` / `email` が揃っている行だけ**通す。
 *
 * @param {Array<{oldId:string,newId:string,email:string}>} entries
 * @returns {Map<string,{newId:string,email:string}>}
 */
export function buildRewireMapping(entries) {
  const m = new Map();
  for (const e of Array.isArray(entries) ? entries : []) {
    const oldId = String((e && e.oldId) || '').trim();
    const newId = String((e && e.newId) || '').trim();
    const email = lower(e && e.email);
    if (!RECORD_ID_RE.test(oldId) || !RECORD_ID_RE.test(newId) || !email) continue;
    if (oldId === newId) continue;                 // 変わっていないものは対象にしない
    m.set(oldId, { newId, email });
  }
  return m;
}

/**
 * 1 まとまりぶんの張り替え計画。
 *
 * @param {{rows: Array<{id:string, fields:object}>, mapping: Map<string,{newId,email}>}} input
 * @returns {{
 *   updates: Array<{id:string, fields:{CustomerRecordId:string}}>,
 *   alreadyRewired: string[],
 *   refused: Array<{id:string, reason:string}>,
 *   counts: {rows:number, updates:number, already:number, refused:number},
 * }}
 */
export function planDeliveryRewire({ rows, mapping } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const map = mapping instanceof Map ? mapping : new Map();
  const updates = []; const alreadyRewired = []; const refused = [];
  /** 新 id の集合（**張り替え済みの行**を「未処理」と誤認しないため）*/
  const newIds = new Set([...map.values()].map((v) => v.newId));

  for (const r of list) {
    const id = String((r && r.id) || '');
    const f = (r && r.fields) || {};
    const cur = String(f.CustomerRecordId || '').trim();

    // ⚠️ 既に新しい id を指している＝前回の実行で終わっている（冪等）
    if (newIds.has(cur)) { alreadyRewired.push(id); continue; }

    const hit = map.get(cur);
    // ⚠️ 対応表に無い＝**別の会員の行**。1 文字も触らない
    if (!hit) { refused.push({ id, reason: REWIRE_REFUSE.NOT_IN_MAPPING }); continue; }
    if (!RECORD_ID_RE.test(hit.newId)) {
      refused.push({ id, reason: REWIRE_REFUSE.BAD_NEW_ID }); continue;
    }
    const rowEmail = lower(f.RecipientEmail);
    if (!rowEmail) { refused.push({ id, reason: REWIRE_REFUSE.NO_EMAIL_ON_ROW }); continue; }
    // ⚠️ アドレスでも一致を確かめる（取り違えたら別人の履歴を書き換えてしまう）
    if (rowEmail !== hit.email) {
      refused.push({ id, reason: REWIRE_REFUSE.EMAIL_MISMATCH }); continue;
    }
    updates.push({ id, fields: { CustomerRecordId: hit.newId } });
  }

  return {
    updates,
    alreadyRewired,
    refused,
    counts: {
      rows: list.length,
      updates: updates.length,
      already: alreadyRewired.length,
      refused: refused.length,
    },
  };
}

/** 実行を許す確認文字列 */
export const REWIRE_CONFIRM = 'REWIRE CAMPAIGN DELIVERIES';
/** 1 回で扱う対応表の件数（**取り違えの被害を構造的に小さくする**）*/
export const REWIRE_MAX_ENTRIES = 100;

export const REWIRE_GATE = Object.freeze({
  NOT_CONFIRMED: 'not_confirmed',
  NO_ENTRIES: 'no_entries',
  TOO_MANY: 'too_many',
});

export function canRewireDeliveries({ confirmed, entries } = {}) {
  const reasons = [];
  if (confirmed !== true) reasons.push(REWIRE_GATE.NOT_CONFIRMED);
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) reasons.push(REWIRE_GATE.NO_ENTRIES);
  if (list.length > REWIRE_MAX_ENTRIES) reasons.push(REWIRE_GATE.TOO_MANY);
  return { allowed: reasons.length === 0, reasons };
}

/**
 * 張り替えが**終わったと言えるか**を判定する（前後の件数で確かめる）。
 *
 * ⚠️ 「更新できた」ではなく「**古い参照が 0 になり、新しい参照が期待どおり在る**」で判定する。
 *
 * @param {{oldRefsAfter:number, newRefsAfter:number, expectedRefs:number}} input
 */
export function verifyRewire({ oldRefsAfter, newRefsAfter, expectedRefs } = {}) {
  const reasons = [];
  const o = Number(oldRefsAfter); const n = Number(newRefsAfter); const e = Number(expectedRefs);
  if (!Number.isFinite(o) || o !== 0) reasons.push('old_refs_remain');
  if (!Number.isFinite(e) || e < 0) reasons.push('expected_unknown');
  if (!Number.isFinite(n) || n !== e) reasons.push('new_refs_mismatch');
  return { ok: reasons.length === 0, reasons, oldRefsAfter: o, newRefsAfter: n, expectedRefs: e };
}
