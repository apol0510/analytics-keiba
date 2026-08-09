/**
 * importBatchVerify.js — 「今書いた行」を名指しで検証する（全件走査に頼らない）
 *
 * ── なぜ要るか ─────────────────────────────────────────────────
 * reconcile の `created_matches_airtable` / `no_new_duplicates` は Customers の
 * **全件走査**を前提にしていた。15,967 件で約 170 秒かかり Function タイムアウトを
 * 超えるため、毎 step では実行できない（2026-08-09 の 504 の原因）。
 *
 * 代わりに、**その batch で書いたメールだけ**を名指しで引いて検証する。
 * 全体の件数より検知が速く（1 batch 単位）、コストは 1〜2 コールで済む。
 *
 * ── 検知できること ────────────────────────────────────────────
 * - 書いたはずの行が無い（write が落ちた）
 * - 同じメールが 2 件以上ある（**二重 CREATE**）
 * - 自分の Source 以外に書いた / 他の Source を書き換えた
 *
 * ⚠️ 全体の突合（総件数・全体の重複）は**ジョブ完了時に 1 回**行う。
 *    per-batch 検証はそれを置き換えるものではなく、**早期検知の追加**である。
 * ⚠️ 引けなかったときに「OK」にしない（fail closed）。
 */

/** 検証の判定コード */
export const BATCH_VERIFY = Object.freeze({
  OK: 'ok',
  MISSING: 'missing',                 // 書いたはずの行が無い
  DUPLICATE: 'duplicate',             // 同じメールが 2 件以上
  FOREIGN_SOURCE: 'foreign_source',   // 自分の Source 以外の行に当たった
  UNAVAILABLE: 'unavailable',         // 引けなかった（fail closed）
});

const norm = (v) => String(v ?? '').trim().toLowerCase();

/**
 * 名指しで引いたレコードを、書いたはずのメール集合と突き合わせる。
 *
 * @param {{
 *   writtenEmails: string[],   この batch で created と判定したメール
 *   records: Array<{id:string, fields:object}>|null,  名指しクエリの結果（null = 引けなかった）
 *   expectedSource: string,
 * }} input
 * @returns {{ ok:boolean, code:string, found:number, missing:number, duplicates:number, foreign:number }}
 */
export function verifyWrittenBatch({ writtenEmails, records, expectedSource } = {}) {
  const want = new Set((writtenEmails || []).map(norm).filter(Boolean));
  if (records === null || records === undefined) {
    return { ok: false, code: BATCH_VERIFY.UNAVAILABLE, found: 0, missing: want.size, duplicates: 0, foreign: 0 };
  }
  const bySource = new Map();
  let foreign = 0;
  for (const r of records) {
    const f = (r && r.fields) || {};
    const e = norm(f.Email);
    if (!e || !want.has(e)) continue;
    const src = String(f.Source ?? '');
    if (src !== expectedSource) { foreign += 1; continue; }
    bySource.set(e, (bySource.get(e) || 0) + 1);
  }
  const found = bySource.size;
  const duplicates = [...bySource.values()].filter((n) => n > 1).length;
  const missing = want.size - found;

  if (duplicates > 0) return { ok: false, code: BATCH_VERIFY.DUPLICATE, found, missing, duplicates, foreign };
  if (foreign > 0) return { ok: false, code: BATCH_VERIFY.FOREIGN_SOURCE, found, missing, duplicates, foreign };
  if (missing > 0) return { ok: false, code: BATCH_VERIFY.MISSING, found, missing, duplicates, foreign };
  return { ok: true, code: BATCH_VERIFY.OK, found, missing: 0, duplicates: 0, foreign: 0 };
}

/**
 * 全体突合を「いま」行うべきか。
 *
 * ⚠️ **完了時は必ず true**。全体の突合を一度も通さずに COMPLETED にしない
 *    （per-batch 検証は早期検知であって、全体の保証ではない）。
 *
 * @param {{ isFinal: boolean, childIndex: number, cadence?: number }} input
 */
export function shouldRunFullReconcile({ isFinal, childIndex, cadence = 25 } = {}) {
  if (isFinal === true) return true;
  const i = Number(childIndex);
  if (!Number.isFinite(i) || i <= 0) return false;
  return i % Math.max(1, cadence) === 0;
}

export default verifyWrittenBatch;
