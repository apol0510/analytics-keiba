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

/**
 * まとめ書き 1 回の件数。**Airtable の上限が 10 件**なのでこれを超えない。
 *
 * ── なぜ必要か（2026-08-04 実測）────────────────────────────────
 * 1 リクエスト 1 件だと 1 件あたり約 273ms かかり、100 件で約 35 秒。
 * Netlify の同期 Function の上限（Pro で最大 26 秒）を超え、途中で切れると
 * **作成済みレコードだけが残って結果が分からない**という最悪の状態になる。
 * 10 件ずつまとめれば 100 件でもリクエストは 10 回で済む。
 */
export const CREATE_CHUNK_SIZE = 10;

/** 配列を size ごとに切る */
export function chunkList(list, size) {
  const n = Number.isFinite(size) && size > 0 ? Math.min(size, CREATE_CHUNK_SIZE) : CREATE_CHUNK_SIZE;
  const out = [];
  for (let i = 0; i < (list || []).length; i += n) out.push(list.slice(i, i + n));
  return out;
}

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
  const createRecords = deps && deps.createRecords;   // まとめ書き（任意）
  const limit = Number.isFinite(maxWrites) ? maxWrites : 0;

  const audit = [];
  let created = 0; let skippedExisting = 0; let skippedDone = 0;
  let failedRetryable = 0; let failedTerminal = 0; let blocked = 0;
  let bulkRequests = 0; let singleRequests = 0;

  if (typeof createRecord !== 'function' && typeof createRecords !== 'function') {
    return {
      ok: false, reason: 'no_writer',
      created: 0, skippedExisting: 0, skippedDone: 0, failed: 0, audit,
      note: '書き込み経路が渡されていません（設定として無効です）。',
    };
  }

  // ── Phase 1: 適格判定（**まだ 1 件も書かない**）────────────────
  // 冪等キー・直前再判定・上限・許可列を、書き込みの前にすべて通す。
  const accepted = [];
  const plannedEmails = new Set();
  let stopped = false;

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
    // 2) 書き込み直前の再判定。下見のあとに AK 側へ増えていたら作らない。
    //    同一実行内で同じアドレスを二度計画しないため plannedEmails も見る
    if (existing.has(email) || plannedEmails.has(email)) {
      skippedExisting += 1;
      audit.push(buildImportAuditEntry({ batchKey: batchId, kind: 'create', rowKey, result: ROW_RESULT.SKIPPED_EXISTING, reason: 'exists_now' }));
      continue;
    }
    // 3) 計画を超えない
    if (accepted.length >= limit) {
      audit.push(buildImportAuditEntry({ batchKey: batchId, kind: 'create', rowKey, result: ROW_RESULT.FAILED_TERMINAL, reason: 'write_limit_reached' }));
      failedTerminal += 1;
      stopped = true;
      break;
    }

    const fields = buildCreateFields({ email, name: row && row.name, batchId, nowIso, availableFields });
    // 4) 許可された列だけか（1 つでも外れたら**そのバッチを止める**）
    if (!fields || !assertOnlyCreateFields(fields)) {
      blocked += 1;
      audit.push(buildImportAuditEntry({ batchKey: batchId, kind: 'create', rowKey, result: ROW_RESULT.BLOCKED_FIELDS, reason: 'field_allow_list' }));
      stopped = true;
      break;
    }

    plannedEmails.add(email);
    accepted.push({ email, rowKey, fields });
  }

  // 許可列違反があれば**1 件も書かない**（曖昧な部分書き込みを作らない）
  if (blocked > 0) {
    return {
      ok: false, reason: 'field_allow_list',
      created: 0, skippedExisting, skippedDone,
      failedRetryable: 0, failedTerminal, blocked, failed: failedTerminal + blocked,
      bulkRequests: 0, singleRequests: 0,
      reconciliation: reconcileRun({
        planned: list.length, created: 0,
        skippedExisting: skippedExisting + skippedDone, failed: failedTerminal + blocked,
      }),
      audit, retryable: false,
    };
  }

  // ── Phase 2: 書き込み ────────────────────────────────────────
  const markCreated = (item) => {
    created += 1;
    done.add(item.rowKey);
    existing.add(item.email);
    audit.push(buildImportAuditEntry({ batchKey: batchId, kind: 'create', rowKey: item.rowKey, result: ROW_RESULT.CREATED }));
  };
  const markFailed = (item, status) => {
    if (shouldRetryStatus(status)) {
      failedRetryable += 1;
      audit.push(buildImportAuditEntry({ batchKey: batchId, kind: 'create', rowKey: item.rowKey, result: ROW_RESULT.FAILED_RETRYABLE, reason: `http_${status}` }));
    } else {
      failedTerminal += 1;
      audit.push(buildImportAuditEntry({ batchKey: batchId, kind: 'create', rowKey: item.rowKey, result: ROW_RESULT.FAILED_TERMINAL, reason: `http_${status}` }));
    }
  };

  /** 1 件ずつ書く（まとめ書きが無い / まとめ書きが失敗したときの切り分け用） */
  const writeOne = async (item) => {
    if (typeof createRecord !== 'function') { markFailed(item, null); return; }
    let attempt = 0; let lastStatus = null;
    while (attempt <= MAX_RETRY_ATTEMPTS) {
      singleRequests += 1;
      const res = await createRecord(item.fields);
      if (res && res.ok) { markCreated(item); return; }
      lastStatus = res && res.status;
      if (!shouldRetryStatus(lastStatus) || attempt === MAX_RETRY_ATTEMPTS) break;
      await sleep(retryDelayMs(attempt));
      attempt += 1;
    }
    markFailed(item, lastStatus);
  };

  if (typeof createRecords === 'function') {
    // まとめ書き（Airtable は 1 リクエスト 10 件まで）。
    // ⚠️ **失敗したチャンクは 1 件ずつ書き直して原因を切り分ける**。
    //    まとめて失敗扱いにすると「1 件の不備で 10 件が曖昧」になるため。
    for (const chunk of chunkList(accepted, CREATE_CHUNK_SIZE)) {
      let attempt = 0; let ok = false; let lastStatus = null;
      while (attempt <= MAX_RETRY_ATTEMPTS) {
        bulkRequests += 1;
        const res = await createRecords(chunk.map((c) => c.fields));
        if (res && res.ok) { ok = true; lastStatus = res.status; break; }
        lastStatus = res && res.status;
        if (!shouldRetryStatus(lastStatus) || attempt === MAX_RETRY_ATTEMPTS) break;
        await sleep(retryDelayMs(attempt));
        attempt += 1;
      }
      if (ok) { for (const item of chunk) markCreated(item); continue; }
      // まとめ書きが通らなかった → 1 件ずつやり直して、どの行が悪いのかを確定させる
      for (const item of chunk) await writeOne(item);
    }
  } else {
    for (const item of accepted) await writeOne(item);
  }

  const failed = failedRetryable + failedTerminal + blocked;
  const recon = reconcileRun({
    planned: list.length, created, skippedExisting: skippedExisting + skippedDone, failed,
  });

  return {
    ok: blocked === 0,
    reason: blocked > 0 ? 'field_allow_list' : null,
    created, skippedExisting, skippedDone, failedRetryable, failedTerminal, blocked, failed,
    bulkRequests, singleRequests,
    reconciliation: recon,
    audit,
    /** 失敗した行だけ再試行できる（成功行は done に入っているので巻き込まない） */
    retryable: failedRetryable > 0,
    stopped,
  };
}

export default writeCreateBatch;
