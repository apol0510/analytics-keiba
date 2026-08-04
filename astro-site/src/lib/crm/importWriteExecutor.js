/**
 * importWriteExecutor.js — 取り込みの書き込み手順（**I/O は注入・純粋にテスト可能**）
 *
 * ここは「どう書くか」だけを持つ。実際の HTTP は呼び出し側が `deps` で渡す。
 * そうすることで、**1 件も書かずに**全分岐（重複・失敗・再試行・上限）をテストできる。
 *
 * ── 守ること ──────────────────────────────────────────────────
 *   1. 書き込み直前に**既存アドレスを取り直して**再判定する（下見からの時間差で増えた分を弾く）
 *   2. 行ごとの冪等キーで、同じ行を二度作らない
 *   3. 429 / 5xx だけ再試行。**検証エラー（4xx）は再試行しない**
 *   4. 1 件の失敗で全体を曖昧にしない（行ごとに成否を記録して続行する）
 *   5. 計画件数を超えて書かない
 *   6. 監査ログに**アドレス・氏名を残さない**（rowKey のハッシュだけ）
 */

import {
  buildCreateFields, assertOnlyCreateFields, computeCreateRowKey,
  shouldRetryStatus, retryDelayMs, MAX_RETRY_ATTEMPTS, reconcileRun,
} from './importWritePlan.js';
import { buildImportAuditEntry } from './importJobPlan.js';

const str = (v) => String(v ?? '').trim();

/** 1 行の結果 */
export const ROW_RESULT = Object.freeze({
  CREATED: 'created',
  SKIPPED_EXISTING: 'skipped_existing',
  SKIPPED_DONE: 'skipped_done',
  FAILED_RETRYABLE: 'failed_retryable',
  FAILED_TERMINAL: 'failed_terminal',
  BLOCKED_FIELDS: 'blocked_fields',
});

/**
 * 1 バッチを書き込む。
 *
 * @param {{
 *   rows: Array<{ email: string, name?: string }>,   // CREATE 対象だけ
 *   batchId: string,
 *   nowIso: string,
 *   availableFields?: Set<string>|null,
 *   doneRowKeys?: Set<string>,
 *   existingEmails: Set<string>,                     // **書き込み直前に取り直したもの**
 *   maxWrites: number,
 *   deps: {
 *     createRecord: (fields: object) => Promise<{ ok: boolean, status?: number, id?: string }>,
 *     sleep?: (ms: number) => Promise<void>,
 *   },
 * }} input
 */
export async function writeCreateBatch({
  rows, batchId, nowIso, availableFields, doneRowKeys, existingEmails, maxWrites, deps,
} = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const done = doneRowKeys instanceof Set ? doneRowKeys : new Set();
  const existing = existingEmails instanceof Set ? existingEmails : new Set();
  const sleep = (deps && deps.sleep) || (() => Promise.resolve());
  const createRecord = deps && deps.createRecord;
  const limit = Number.isFinite(maxWrites) ? maxWrites : 0;

  const audit = [];
  let created = 0; let skippedExisting = 0; let skippedDone = 0;
  let failedRetryable = 0; let failedTerminal = 0; let blocked = 0;

  if (typeof createRecord !== 'function') {
    return {
      ok: false, reason: 'no_writer',
      created: 0, skippedExisting: 0, skippedDone: 0, failed: 0, audit,
      note: '書き込み経路が渡されていません（設定として無効です）。',
    };
  }

  for (const row of list) {
    const email = str(row && row.email).toLowerCase();
    const rowKey = computeCreateRowKey({ batchId, email });

    if (!email || !rowKey) {
      failedTerminal += 1;
      audit.push(buildImportAuditEntry({ batchKey: batchId, kind: 'create', rowKey: '', result: ROW_RESULT.FAILED_TERMINAL, reason: 'no_email' }));
      continue;
    }
    // 1) もう作った行は作らない（再実行しても増えない）
    if (done.has(rowKey)) {
      skippedDone += 1;
      audit.push(buildImportAuditEntry({ batchKey: batchId, kind: 'create', rowKey, result: ROW_RESULT.SKIPPED_DONE }));
      continue;
    }
    // 2) 書き込み直前の再判定。下見のあとに AK 側へ増えていたら作らない
    if (existing.has(email)) {
      skippedExisting += 1;
      audit.push(buildImportAuditEntry({ batchKey: batchId, kind: 'create', rowKey, result: ROW_RESULT.SKIPPED_EXISTING, reason: 'exists_now' }));
      continue;
    }
    // 3) 計画を超えない
    if (created >= limit) {
      audit.push(buildImportAuditEntry({ batchKey: batchId, kind: 'create', rowKey, result: ROW_RESULT.FAILED_TERMINAL, reason: 'write_limit_reached' }));
      failedTerminal += 1;
      break;
    }

    const fields = buildCreateFields({ email, name: row && row.name, batchId, nowIso, availableFields });
    // 4) 許可された列だけか（1 つでも外れたら**そのバッチを止める**）
    if (!fields || !assertOnlyCreateFields(fields)) {
      blocked += 1;
      audit.push(buildImportAuditEntry({ batchKey: batchId, kind: 'create', rowKey, result: ROW_RESULT.BLOCKED_FIELDS, reason: 'field_allow_list' }));
      break;
    }

    let attempt = 0; let wrote = false; let lastStatus = null;
    while (attempt <= MAX_RETRY_ATTEMPTS) {
      const res = await createRecord(fields);
      if (res && res.ok) { wrote = true; break; }
      lastStatus = res && res.status;
      // 429 / 5xx だけ再試行。検証エラーは何度やっても通らないので即あきらめる
      if (!shouldRetryStatus(lastStatus) || attempt === MAX_RETRY_ATTEMPTS) break;
      await sleep(retryDelayMs(attempt));
      attempt += 1;
    }

    if (wrote) {
      created += 1;
      done.add(rowKey);
      existing.add(email);   // 同一実行内で同じアドレスを二度作らない
      audit.push(buildImportAuditEntry({ batchKey: batchId, kind: 'create', rowKey, result: ROW_RESULT.CREATED }));
    } else if (shouldRetryStatus(lastStatus)) {
      failedRetryable += 1;
      audit.push(buildImportAuditEntry({ batchKey: batchId, kind: 'create', rowKey, result: ROW_RESULT.FAILED_RETRYABLE, reason: `http_${lastStatus}` }));
    } else {
      failedTerminal += 1;
      audit.push(buildImportAuditEntry({ batchKey: batchId, kind: 'create', rowKey, result: ROW_RESULT.FAILED_TERMINAL, reason: `http_${lastStatus}` }));
    }
  }

  const failed = failedRetryable + failedTerminal + blocked;
  const recon = reconcileRun({
    planned: list.length, created, skippedExisting: skippedExisting + skippedDone, failed,
  });

  return {
    ok: blocked === 0,
    reason: blocked > 0 ? 'field_allow_list' : null,
    created, skippedExisting, skippedDone, failedRetryable, failedTerminal, blocked, failed,
    reconciliation: recon,
    audit,
    /** 失敗した行だけ再試行できる（成功行は done に入っているので巻き込まない） */
    retryable: failedRetryable > 0,
  };
}

export default writeCreateBatch;
