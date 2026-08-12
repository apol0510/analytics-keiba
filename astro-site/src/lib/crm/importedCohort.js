/**
 * importedCohort.js — 「CSV で取り込んだ会員か」の判定（純粋・I/O なし）
 *
 * ── なぜ要るか ──────────────────────────────────────────────
 * 施策の対象を「外部リストから取り込んだ人だけ」に限定したい場面がある。
 * AK で以前から登録していた無料会員へ同じ案内を送ると、前提の違う文面になる。
 *
 * ── 正本は取り込み時に書いた `Source`（推測で新しい旗を作らない）──────
 * `crm/importWritePlan.js` の `buildCreateFields()` は **CREATE 時に必ず**
 * `Source: "customer-import:<batchId>"` を書く。監査列（`ImportBatchId` /
 * `ImportedAt` / `CreatedBy`）は **Customers に実在するときだけ**書かれるため、
 * どの環境でも確実に読めるのは `Source` である。
 *
 * したがって判定は次の順で行い、**どれも読めなければコホート外**（fail closed）:
 *   1. `Source` が `customer-import:` で始まる            ← 最も確実
 *   2. `ImportBatchId` に値がある                          ← 列がある環境のみ
 *   3. `CreatedBy` が `customer-import`                    ← 列がある環境のみ
 *
 * ⚠️ **更新（UPDATE）で取り込んだ既存会員には `Source` が付かない。**
 *    取り込み時に新規作成された人だけがコホートとして識別できる。
 *    「既存会員だが CSV にも載っていた人」は**判別できない**ので、
 *    この判定では**コホート外**として扱う（誤って施策対象へ入れない）。
 *
 * ⚠️ 取り込みが 1 件も無い Base では、この判定は**全員 false** を返す。
 *    呼び出し側は「0 件」を「確認できない」として扱い、
 *    **誰にも自動付与しない**こと（`assertCohortObservable`）。
 */

import { IMPORT_SOURCE_PREFIX } from './importWritePlan.js';

const str = (v) => String(v ?? '').trim();

/** `Source` に入る接頭辞（正本は importWritePlan。ここでは再定義しない） */
export const COHORT_SOURCE_PREFIX = `${IMPORT_SOURCE_PREFIX}:`;

/** コホート外の理由（画面・dry-run にそのまま出す） */
export const COHORT_SKIP = Object.freeze({
  NOT_IMPORTED: 'not_imported_cohort',
  OTHER_BATCH: 'other_import_batch',
});

export const COHORT_SKIP_LABEL = Object.freeze({
  not_imported_cohort: 'CSV 取り込みの会員ではない（従来からの登録）',
  other_import_batch: '別の取り込みバッチの会員',
});

/** 取り込みバッチ ID を取り出す（分からなければ空文字） */
export function resolveImportBatchId(fields) {
  const f = fields || {};
  const src = str(f.Source);
  if (src.startsWith(COHORT_SOURCE_PREFIX)) {
    const id = src.slice(COHORT_SOURCE_PREFIX.length).trim();
    if (id) return id;
  }
  const explicit = str(f.ImportBatchId);
  if (explicit) return explicit;
  return '';
}

/**
 * CSV 取り込みで**新規作成された**会員か。
 * 判別できない場合は false（コホート外）へ倒す。
 */
export function isImportedCustomer(fields) {
  const f = fields || {};
  if (str(f.Source).startsWith(COHORT_SOURCE_PREFIX)) return true;
  if (str(f.ImportBatchId)) return true;
  if (str(f.CreatedBy) === IMPORT_SOURCE_PREFIX) return true;
  return false;
}

/**
 * コホート条件に一致するか。
 *
 * @param {object} fields Customers の fields
 * @param {{ batchIds?: string[]|null }} [options] バッチを絞る場合（空 = 取り込み全体）
 * @returns {{ ok: boolean, reason: string|null, batchId: string }}
 */
export function matchesImportCohort(fields, { batchIds } = {}) {
  const batchId = resolveImportBatchId(fields);
  if (!isImportedCustomer(fields)) {
    return { ok: false, reason: COHORT_SKIP.NOT_IMPORTED, batchId: '' };
  }
  const wanted = Array.isArray(batchIds) ? batchIds.map(str).filter(Boolean) : [];
  if (wanted.length > 0 && !wanted.includes(batchId)) {
    return { ok: false, reason: COHORT_SKIP.OTHER_BATCH, batchId };
  }
  return { ok: true, reason: null, batchId };
}

/** バッチ別の件数（dry-run の内訳表示用） */
export function summarizeCohort(records, { batchIds } = {}) {
  const out = { total: 0, inCohort: 0, byBatch: {}, byReason: {} };
  for (const rec of Array.isArray(records) ? records : []) {
    const fields = (rec && rec.fields) || rec || {};
    out.total += 1;
    const m = matchesImportCohort(fields, { batchIds });
    if (m.ok) {
      out.inCohort += 1;
      const key = m.batchId || '(batch 不明)';
      out.byBatch[key] = (out.byBatch[key] || 0) + 1;
    } else {
      out.byReason[m.reason] = (out.byReason[m.reason] || 0) + 1;
    }
  }
  return out;
}

/**
 * **コホートを観測できているか**（できていなければ誰にも施策を当てない）。
 *
 * 取り込みの痕跡が 1 件も無い場合、それは
 *   ・本当に取り込みがまだ行われていない
 *   ・`Source` 列が読めていない（権限・列名の変更）
 * のどちらかで、**区別できない**。どちらにせよ対象を確定できないので中止する。
 *
 * @returns {{ ok: boolean, reason: string|null, observed: number }}
 */
export function assertCohortObservable(summary) {
  const observed = Number(summary && summary.inCohort) || 0;
  if (observed <= 0) {
    return { ok: false, reason: 'cohort_unverifiable', observed: 0 };
  }
  return { ok: true, reason: null, observed };
}
