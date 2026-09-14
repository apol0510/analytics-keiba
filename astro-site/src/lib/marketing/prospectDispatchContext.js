/**
 * prospectDispatchContext.js — 送信直前の再検証に要る prospect の材料を揃える
 *
 * ## なぜ要るか
 *
 * dispatcher は送る直前に **Customers から宛先ぶんを名指しで引き**、
 * 配信停止・停止アカウント・キャンペーン固有条件を再判定する。
 * ところが prospect（CSV 取り込みプール）は **Customers に存在しない**ので、
 * `customer_record_missing` で必ず skip されていた（2026-09-14 実測: 送信 0 通）。
 *
 * ここは「Customers から引けなかったアドレス」だけを prospect プールから引き直し、
 * **Customers 経路と同じ形**（`fields` / `marketing`）へ戻す。
 *
 * ⚠️ **判定を新しく作らない。** 変換は既存の `prospectSequenceAdapter.js`、
 *    送信可否は既存の `resolveCustomerMarketing()` / `verifyBeforeSend()` がそのまま決める。
 * ⚠️ 読めないときは**空ではなく `ok:false`** を返す（0 件と混同すると、
 *    「prospect が居ない」と読んで全員 skip したまま成功扱いになる）。
 * ⚠️ 生アドレスは返り値の `fields.Email` にしか入れない（ログ・集計には出さない）。
 */

import { prospectToCustomerRow, isSendableState } from './prospectSequenceAdapter.js';
import { PROSPECT_STATE } from './prospectPolicy.js';

/** 取り込めなかった理由（固定コード） */
export const PROSPECT_CTX_FAIL = Object.freeze({
  STORE_UNAVAILABLE: 'prospect_store_unavailable',
  READ_FAILED: 'prospect_read_failed',
});

/** 1 回に引く hash の数（`loadMany` の往復を抑える） */
export const LOAD_CHUNK = 200;

const lower = (v) => String(v ?? '').trim().toLowerCase();

/**
 * prospect レコード群 → dispatcher が使う形（純粋）。
 *
 * @param {{prospects: object[], nowMs: number, blacklistEmails?: Set<string>}} input
 * @returns {{rows: Array<{email, recordId, fields, marketing}>,
 *            suppressed: Set<string>, skippedByReason: Record<string, number>}}
 *   `suppressed` … 状態として**もう送ってはいけない** prospect
 *   （SUPPRESSED / EXHAUSTED / PROMOTED / ENGAGED）。送信直前に改めて弾くための集合。
 */
export function buildProspectDispatchRows({ prospects, nowMs, blacklistEmails } = {}) {
  const rows = [];
  const suppressed = new Set();
  const skippedByReason = {};
  const bump = (r) => { skippedByReason[r] = (skippedByReason[r] || 0) + 1; };
  for (const p of Array.isArray(prospects) ? prospects : []) {
    const email = lower(p && p.email);
    if (!email) { bump('no_email'); continue; }
    const state = String((p && p.state) || PROSPECT_STATE.NEW);
    if (!isSendableState(state)) {
      // ⚠️ 打ち切り（EXHAUSTED）・抑止（SUPPRESSED）・昇格済み・反応済みは**送らない**
      suppressed.add(email);
      bump(`state:${state}`);
      continue;
    }
    const row = prospectToCustomerRow({ prospect: p, nowMs, blacklistEmails });
    if (!row) { bump('unconvertible'); continue; }
    rows.push({ email, recordId: row.recordId, fields: row.fields, marketing: row.marketing });
  }
  return { rows, suppressed, skippedByReason };
}

/**
 * prospect プールから材料を読む（I/O）。
 *
 * @param {{store: object|null, emails: string[], nowMs: number,
 *          blacklistEmails?: Set<string>, hashFn: (email: string) => string}} input
 * @returns {Promise<{ok: boolean, reason?: string, rows: Array, suppressed: Set<string>,
 *                    skippedByReason: object, looked: number}>}
 */
export async function loadProspectDispatchContext({
  store, emails, nowMs, blacklistEmails, hashFn,
} = {}) {
  const list = [...new Set((Array.isArray(emails) ? emails : []).map(lower).filter(Boolean))];
  const empty = { rows: [], suppressed: new Set(), skippedByReason: {}, looked: 0 };
  if (list.length === 0) return { ok: true, ...empty };
  if (!store || typeof store.loadMany !== 'function' || typeof hashFn !== 'function') {
    return { ok: false, reason: PROSPECT_CTX_FAIL.STORE_UNAVAILABLE, ...empty };
  }

  const prospects = [];
  for (let i = 0; i < list.length; i += LOAD_CHUNK) {
    const chunk = list.slice(i, i + LOAD_CHUNK).map((e) => hashFn(e));
    let loaded;
    try {
      // eslint-disable-next-line no-await-in-loop -- 200 件ずつの名指し取得
      loaded = await store.loadMany(chunk);
    } catch {
      return { ok: false, reason: PROSPECT_CTX_FAIL.READ_FAILED, ...empty };
    }
    if (!Array.isArray(loaded)) {
      return { ok: false, reason: PROSPECT_CTX_FAIL.READ_FAILED, ...empty };
    }
    for (const p of loaded) if (p) prospects.push(p);
  }

  const built = buildProspectDispatchRows({ prospects, nowMs, blacklistEmails });
  return { ok: true, ...built, looked: list.length };
}

export default loadProspectDispatchContext;
