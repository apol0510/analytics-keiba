/**
 * importCohort.js — 会員を「CSV 取り込み由来」と「もとからの Airtable 顧客」に分ける
 * （純粋・I/O なし）
 *
 * ## なぜ区別するのか（2026-08-26 MK 確定）
 *
 * 外部リストから取り込んだ約 15,000 名と、もとから AK にいた顧客は**性質が違う**。
 * 取り込み分は購入も接点も無いところから始まるので、送り続けても反応が無い相手が
 * まとまって残る。その相手に送り続けると迷惑メール報告とドメイン評価の悪化を招き、
 * **届けたい相手にも届かなくなる**。
 *
 * よって **「累計 10 通以上 delivered で開封が一度も無い」相手を自動除外**する運用は、
 * まず取り込みコホートに対して確実に効かせる。もとからの顧客は購入・ログイン等の
 * 別のシグナルを持つため、**同じ数字でも意味が違う**。人数も除外理由も**分けて数える**。
 *
 * ⚠️ ここは**分類だけ**を返す。除外するかどうかは `engagementPolicy.js` /
 *    `engagementGuard.js` が決める（閾値も状態もあちらが単一源）。
 * ⚠️ 取引メール（決済確認 / 認証 / サポート / 期限通知）には**一切関係しない**。
 *    この分類はマーケティング配信の集計と表示のためだけに使う。
 *
 * ## 判定材料は `Source` だけ
 *
 * 取り込みは `Source = 'customer-import:<batchId>'` を書く（`docs/spec.md` §外部リストの取り込み）。
 * 専用の列を増やさないので、**過去に取り込んだ分もそのまま判別できる**。
 */

/** 取り込みが書く `Source` の接頭辞（取り込み側と同じ値。変えるときは両方） */
export const IMPORT_SOURCE_PREFIX = 'customer-import:';

export const COHORT = Object.freeze({
  /** CSV 取り込み由来 */
  IMPORTED: 'imported',
  /** もとからの Airtable 顧客 */
  EXISTING: 'existing',
});

export const COHORT_LABEL = Object.freeze({
  imported: '取り込み（外部リスト）',
  existing: '既存顧客（Airtable）',
});

const str = (v) => String(v ?? '').trim();

/**
 * その `Source` が取り込み由来か。
 * ⚠️ 前方一致だけで判定する（batchId は増え続けるため列挙しない）。
 */
export function isImportSource(source) {
  return str(source).startsWith(IMPORT_SOURCE_PREFIX);
}

/** 取り込みのバッチ ID（取り込み由来でなければ null） */
export function importBatchId(source) {
  const s = str(source);
  return isImportSource(s) ? s.slice(IMPORT_SOURCE_PREFIX.length) || null : null;
}

/**
 * Airtable の fields から所属コホートを決める。
 * **判断材料が無ければ `existing`**（取り込み扱いにしない ＝ 自動除外の対象を広げない）。
 *
 * @param {object|null} fields
 * @returns {'imported'|'existing'}
 */
export function resolveCohort(fields) {
  const f = fields && typeof fields === 'object' ? fields : null;
  if (!f) return COHORT.EXISTING;
  return isImportSource(f.Source) ? COHORT.IMPORTED : COHORT.EXISTING;
}

/**
 * コホート別に人数を数える（画面・ログ用。キーを固定して 0 も必ず出す）。
 *
 * @param {Array<{fields?: object}>} list
 * @param {(item: object) => boolean} [predicate] 数える条件（既定は全件）
 */
export function countByCohort(list, predicate) {
  const out = { imported: 0, existing: 0, total: 0 };
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof predicate === 'function' && !predicate(item)) continue;
    const c = resolveCohort(item && (item.fields || item));
    out[c] += 1;
    out.total += 1;
  }
  return out;
}

/**
 * 除外内訳をコホート別に分けて返す（管理画面用）。
 *
 * @param {{ list: Array<object>, blockedEmails: Set<string>|null }} input
 * @returns {{ blocked: {imported:number, existing:number, total:number},
 *             audience: {imported:number, existing:number, total:number} }}
 */
export function summarizeCohortExclusion({ list, blockedEmails } = {}) {
  const emailOf = (x) => String((x && (x.email ?? (x.fields && x.fields.Email))) ?? '').trim().toLowerCase();
  const blocked = blockedEmails instanceof Set ? blockedEmails : new Set();
  return {
    audience: countByCohort(list),
    blocked: countByCohort(list, (x) => blocked.has(emailOf(x))),
  };
}
