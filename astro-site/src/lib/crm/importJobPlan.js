/**
 * importJobPlan.js — 取り込みの実行モデル（純粋・I/O なし・**書き込みは未配線**）
 *
 * ── 立場 ──────────────────────────────────────────────────────
 * 実 CSV は未受領・本番 write は未実施。だが「実行するときに何が起きるか」は
 * **先に決めて固定できる**。ここは決め事だけを持ち、Airtable も SendGrid も触らない。
 * 実際に書く層（Function）は `isCustomerImportWriteEnabled` が true のときだけ配線する。
 *
 * ── 取り返しのつかない事故を構造的に防ぐ ────────────────────────
 *   1. 二重作成 … 行ごとの冪等キー（`computeRowKey`）で「もう作った行」を再作成しない
 *   2. 二重実行 … 送信済みバッチは二度と実行しない。同時に 2 バッチを走らせない
 *   3. 取りこぼし … 失敗した行**だけ**を再試行する（成功行を巻き込まない）
 *   4. 暴走 … 1 バッチの上限を決め、親ジョブは下見の件数を**超えて書けない**
 *   5. 統合事故 … 既存の重複レコードは**自動統合しない**（REVIEW のまま触らない）
 *   6. 戻せない … `ImportBatchId` を全行に刻み、バッチ単位で戻せるようにする
 */

/** 子バッチ 1 つの既定件数と上限（大きすぎると失敗時の巻き戻しが重い） */
export const DEFAULT_BATCH_SIZE = 200;
export const MIN_BATCH_SIZE = 100;
export const MAX_BATCH_SIZE = 500;

/** 親ジョブの状態 */
export const IMPORT_JOB_STATE = Object.freeze({
  PLANNED: 'planned',
  RUNNING: 'running',
  PAUSED: 'paused',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

/** 子バッチの状態 */
export const IMPORT_BATCH_STATE = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

/** 書き込みの種類。**作成と更新は別処理**（更新で既存の値を壊さない） */
export const WRITE_KIND = Object.freeze({
  CREATE: 'create',
  UPDATE: 'update',
});

/** 取り込みで書く監査用フィールド（**これ以外は書かない**） */
export const IMPORT_AUDIT_FIELDS = Object.freeze(['CreatedBy', 'ImportBatchId', 'ImportedAt']);

/** 取り込み経路の目印（他の作成経路と区別する） */
export const IMPORT_CREATED_BY = 'customer-import';

const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);
const str = (v) => String(v ?? '').trim();

/**
 * 環境変数ゲート。**既定 OFF**。
 * ここが true でない限り、書き込み経路は 1 バイトも書かない。
 */
export function isCustomerImportWriteEnabled(env) {
  return !!env && env.CUSTOMER_IMPORT_WRITE_ENABLED === 'true';
}

/**
 * 親ジョブ + 子バッチの計画を作る。
 *
 * ⚠️ **下見の件数を超える計画は作らない。** 作成候補 + 更新候補の合計が上限で、
 *    それ以外（除外・要確認）は 1 行も書き込み対象にしない。
 *
 * @param {{
 *   importPreviewId: string,
 *   batchId: string,
 *   createCount: number,
 *   updateCount: number,
 *   batchSize?: number,
 * }} input
 */
export function planImportJob(input = {}) {
  const previewId = str(input.importPreviewId);
  const batchId = str(input.batchId);
  const create = Math.max(0, int(input.createCount));
  const update = Math.max(0, int(input.updateCount));
  const size = clampBatchSize(input.batchSize);

  if (!previewId || !batchId) {
    return { ok: false, error: 'missing_preview_or_batch_id', batches: [] };
  }
  const total = create + update;
  if (total <= 0) return { ok: false, error: 'nothing_to_write', batches: [] };

  // 作成と更新は**別のバッチ**にする（失敗時の戻し方が違うため混ぜない）
  const batches = [
    ...splitBatches({ kind: WRITE_KIND.CREATE, count: create, size, batchId }),
    ...splitBatches({ kind: WRITE_KIND.UPDATE, count: update, size, batchId }),
  ];

  return {
    ok: true,
    error: null,
    importPreviewId: previewId,
    batchId,
    state: IMPORT_JOB_STATE.PLANNED,
    batchSize: size,
    totalRows: total,
    createCount: create,
    updateCount: update,
    batches,
    /** 実行してよい上限。**計画より多く書けない** */
    maxWrites: total,
    writesDone: 0,
  };
}

function clampBatchSize(v) {
  const n = int(v) || DEFAULT_BATCH_SIZE;
  return Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, n));
}

function splitBatches({ kind, count, size, batchId }) {
  const out = [];
  for (let offset = 0, i = 1; offset < count; offset += size, i += 1) {
    out.push({
      batchKey: `${batchId}-${kind}-${String(i).padStart(3, '0')}`,
      kind,
      offset,
      size: Math.min(size, count - offset),
      state: IMPORT_BATCH_STATE.PENDING,
      attempts: 0,
      written: 0,
      failed: 0,
    });
  }
  return out;
}

/**
 * 次に実行してよい子バッチ。**同時に 2 つは返さない**（再開時の二重書き込み防止）。
 * @returns {{ ok: boolean, batch: object|null, reason: string|null }}
 */
export function nextImportBatch(job = {}) {
  const batches = Array.isArray(job.batches) ? job.batches : [];
  if (job.state === IMPORT_JOB_STATE.PAUSED) return { ok: false, batch: null, reason: 'paused' };
  if (job.state === IMPORT_JOB_STATE.CANCELLED) return { ok: false, batch: null, reason: 'cancelled' };
  if (batches.some((b) => b.state === IMPORT_BATCH_STATE.RUNNING)) {
    return { ok: false, batch: null, reason: 'batch_already_running' };
  }
  const next = batches.find((b) => b.state === IMPORT_BATCH_STATE.PENDING);
  if (!next) return { ok: false, batch: null, reason: 'no_pending_batch' };
  return { ok: true, batch: next, reason: null };
}

/**
 * 1 行を書いてよいか。**冪等キーで「もう書いた行」を弾く**。
 *
 * @param {{ rowKey: string, doneRowKeys?: Set<string>, job?: object }} input
 */
export function canWriteRow({ rowKey, doneRowKeys, job } = {}) {
  const key = str(rowKey);
  if (!key) return { ok: false, reason: 'no_row_key' };
  const done = doneRowKeys instanceof Set ? doneRowKeys : new Set();
  if (done.has(key)) return { ok: false, reason: 'already_written' };
  if (job && int(job.writesDone) >= int(job.maxWrites)) return { ok: false, reason: 'write_limit_reached' };
  return { ok: true, reason: null };
}

/** 一時停止。**実行中のバッチは止めない**（中途半端に切らず、完了後に止まる） */
export function pauseImportJob(job = {}) {
  if (job.state === IMPORT_JOB_STATE.DONE || job.state === IMPORT_JOB_STATE.CANCELLED) {
    return { ...job, pauseNote: 'already_finished' };
  }
  return { ...job, state: IMPORT_JOB_STATE.PAUSED, pauseNote: '実行中のバッチが終わってから止まります' };
}

export function resumeImportJob(job = {}) {
  if (job.state !== IMPORT_JOB_STATE.PAUSED) return job;
  return { ...job, state: IMPORT_JOB_STATE.RUNNING, pauseNote: null };
}

/**
 * 未実行のバッチだけ取り消す。**書き込み済みは取り消せない**
 *（作った顧客は消さない。戻すのは rollback の手順で行う）。
 */
export function cancelPendingImportBatches(job = {}) {
  const batches = (job.batches || []).map((b) => (
    b.state === IMPORT_BATCH_STATE.PENDING
      ? { ...b, state: IMPORT_BATCH_STATE.CANCELLED }
      : b
  ));
  const anyDone = batches.some((b) => b.state === IMPORT_BATCH_STATE.DONE);
  return {
    ...job,
    batches,
    state: anyDone ? IMPORT_JOB_STATE.CANCELLED : IMPORT_JOB_STATE.CANCELLED,
    cancelNote: '未実行のバッチだけ取り消しました。書き込み済みの行は取り消せません。',
  };
}

/**
 * 失敗した行だけを再試行する計画。**成功した行は巻き込まない**。
 */
export function planRetryFailed(job = {}) {
  const failed = (job.batches || []).filter((b) => b.state === IMPORT_BATCH_STATE.FAILED);
  if (failed.length === 0) return { ok: false, reason: 'no_failed_batch', batches: [] };
  return {
    ok: true,
    reason: null,
    batches: failed.map((b) => ({ ...b, state: IMPORT_BATCH_STATE.PENDING, attempts: int(b.attempts) })),
    note: '失敗したバッチだけを再実行します（成功済みの行は再作成しません）。',
  };
}

/** 進捗のまとめ。**書いた数が計画を超えていないか**を毎回検算する */
export function summarizeImportJob(job = {}) {
  const batches = Array.isArray(job.batches) ? job.batches : [];
  const by = (s) => batches.filter((b) => b.state === s).length;
  const written = batches.reduce((n, b) => n + int(b.written), 0);
  const failed = batches.reduce((n, b) => n + int(b.failed), 0);
  return {
    state: job.state || IMPORT_JOB_STATE.PLANNED,
    batches: batches.length,
    pending: by(IMPORT_BATCH_STATE.PENDING),
    running: by(IMPORT_BATCH_STATE.RUNNING),
    done: by(IMPORT_BATCH_STATE.DONE),
    failedBatches: by(IMPORT_BATCH_STATE.FAILED),
    cancelled: by(IMPORT_BATCH_STATE.CANCELLED),
    written,
    failedRows: failed,
    planned: int(job.totalRows),
    /** 計画より多く書いていないこと。false なら**即座に止める** */
    withinPlan: written <= int(job.maxWrites),
    /** 突合: 書いた + 失敗 + 未実行 が計画と合うか */
    reconciled: written + failed <= int(job.totalRows),
  };
}

/**
 * 取り込みで顧客レコードに刻む監査値。**これ以外の列は書かない**。
 * @param {{ batchId: string, nowIso: string }} input
 */
export function buildImportAuditFields({ batchId, nowIso } = {}) {
  return {
    CreatedBy: IMPORT_CREATED_BY,
    ImportBatchId: str(batchId),
    ImportedAt: str(nowIso),
  };
}

/**
 * 監査ログ 1 行。**アドレス・氏名は入れない**（rowKey は復元不能なハッシュ）。
 */
export function buildImportAuditEntry({ batchKey, kind, rowKey, result, reason, atMs } = {}) {
  return {
    batchKey: str(batchKey),
    kind: str(kind),
    rowKey: str(rowKey).slice(0, 32),
    result: str(result),
    reason: reason ? str(reason) : null,
    at: Number.isFinite(atMs) ? new Date(atMs).toISOString() : null,
  };
}

/**
 * このバッチを戻す手順（**実行前に必ず画面へ出す**）。
 * 取り込みは「消す」より「印を外す」で戻す。
 */
export function describeImportRollback(batchId) {
  const b = str(batchId);
  return {
    batchId: b,
    steps: [
      `この取り込みで作った顧客には ImportBatchId=${b || '(未採番)'} と CreatedBy=${IMPORT_CREATED_BY} が入ります。`,
      '取り消しは「そのバッチで新規作成した行だけ」を対象にします（既存顧客は対象外）。',
      '既存顧客の更新は、更新前の値を同じバッチ記録に残してから書きます。',
      '削除ではなく印を外す方向で戻します（履歴を消さない）。',
      '既存の重複レコードは自動統合しません。要確認のまま人が判断します。',
    ],
    warning: '取り込みと配信を同じ操作にしない（取り込んだ直後に自動送信しない）。',
  };
}

export default planImportJob;
