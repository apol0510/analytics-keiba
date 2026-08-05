/**
 * importJobModel.js — 親ジョブ + 子バッチの**状態機械**（純粋・I/O なし）
 *
 * ── なぜ「親ジョブ」が要るのか ────────────────────────────────
 * 残り 14,284 件を 1 回 100 件の手動 run で処理すると約 143 回になる。
 * 人が 143 回ゲートを開け閉めするのは現実的でなく、途中で状態を見失う。
 * そこで **管理者は 1 回だけ開始し、内部で 100 件以下の子バッチへ分割**する。
 *
 * ── 正本は Airtable であって、このジョブ記録ではない（重要）──────
 * Netlify Blobs は同一キー競合が last-write-wins で、`onlyIfNew` / `onlyIfMatch` も
 * best-effort でしかない（本 repo の premium-plus canary #13 で実 lost-update を確認済み・
 * `docs/PREMIUM_PLUS_STORAGE_DESIGN.md`）。Airtable 側に CAS は無く、
 * ImportJobs テーブルの新設は schema 変更にあたるため採らない。
 *
 * したがって**安全性をジョブ記録の一貫性に依存させない**設計にする:
 *
 *   1. 二重作成を防ぐのは **Customers 側のアドレス実在判定**（子バッチ直前に取り直す）。
 *      すでに作った行は Customers に居るので、同じ子バッチをもう一度流しても
 *      `skippedExisting` になるだけで**増えない**。
 *   2. 進捗の正本も **Customers**（`Source = customer-import:<batchId>` の件数）。
 *      ジョブ記録が壊れても・消えても、Airtable から再構成できる。
 *   3. `cursor` は**やり直しを速くするためだけ**の目印。ズレても結果は変わらない
 *      （巻き戻れば全件 skip、進みすぎることは無い＝取りこぼしは残件として次回拾う）。
 *   4. 排他ロックは **best-effort の多重防御**。これ単独では同時実行を防げないと明記する。
 *
 * ⚠️ 残る競合: 2 つの実行が**同時に**同じアドレスを「まだ無い」と読んだ場合は
 *    二重作成が起こりうる（TOCTOU）。これは既存の単発 run 経路と同じ露出で、
 *    運用は「同時に 2 つ動かさない」（UI は逐次実行・ロックで拒否）で閉じる。
 */

import { IMPORT_BATCH_STATE } from './importJobPlan.js';
import { FIRST_RUN_MAX_ROWS, IMPORT_SOURCE_PREFIX } from './importWritePlan.js';

/** 子バッチ 1 つの最大件数。**既存の 1 回上限と同じ 100 件を超えない** */
export const JOB_CHILD_MAX_ROWS = FIRST_RUN_MAX_ROWS;

/** 排他リースの既定時間。切れたら他の実行が引き継げる（停電・timeout 対策） */
export const JOB_LEASE_MS = 90 * 1000;

/** 親ジョブの状態 */
export const JOB_STATUS = Object.freeze({
  PLANNED: 'PLANNED',
  RUNNING: 'RUNNING',
  PARTIAL: 'PARTIAL',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

/** これ以上進めない終端状態（再実行を拒否する） */
export const TERMINAL_STATUS = Object.freeze([
  JOB_STATUS.COMPLETED, JOB_STATUS.CANCELLED, JOB_STATUS.FAILED,
]);

/** 開始・続行を断る理由（固定コード） */
export const JOB_REJECT = Object.freeze({
  WRITE_DISABLED: 'write_disabled',
  NO_CONFIRMATION: 'no_confirmation',
  CONFIRMATION_MISMATCH: 'confirmation_mismatch',
  JOB_EXISTS: 'job_exists',
  JOB_NOT_FOUND: 'job_not_found',
  ALREADY_COMPLETED: 'already_completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  LOCKED: 'locked',
  FILE_CHANGED: 'file_changed',
  NOTHING_TO_WRITE: 'nothing_to_write',
  PREVIEW_INVALID: 'preview_invalid',
});

export const JOB_REJECT_LABEL = Object.freeze({
  write_disabled: '取り込みの書き込みが有効化されていません（CUSTOMER_IMPORT_WRITE_ENABLED）。',
  no_confirmation: '開始には確認文字列が必要です。',
  confirmation_mismatch: '確認文字列が一致しません。',
  job_exists: '同じ ImportBatchId のジョブがすでにあります。',
  job_not_found: 'ジョブが見つかりません。',
  already_completed: 'このジョブは完了済みです。再実行はできません。',
  cancelled: 'このジョブは取り消し済みです。',
  failed: 'このジョブは失敗で終了しています。',
  locked: '別の実行が進行中です（同時実行はできません）。',
  file_changed: '開始時と違う CSV です。',
  nothing_to_write: '作成する行がありません。',
  preview_invalid: '停止リストを確認できないため実行しません。',
});

const str = (v) => String(v ?? '').trim();
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

/** ジョブ ID。ImportBatchId と 1 対 1（両方とも一意） */
export function buildJobId(batchId) {
  const b = str(batchId);
  return b ? `job:${b}` : '';
}

/** Source（rollback の隔離キー）。**ジョブ単位で 1 つ** */
export function buildJobSource(batchId) {
  const b = str(batchId);
  return b ? `${IMPORT_SOURCE_PREFIX}:${b}` : '';
}

/** 開始時に打ち込ませる確認文字列。バッチと総件数に紐づくので使い回せない */
export function buildJobConfirmation({ batchId, total }) {
  return `IMPORT-JOB ${str(batchId)} ${int(total)}`;
}

/** 子バッチ 1 つの冪等キー（同じ子バッチを二度実行しないための目印） */
export function buildChildBatchKey({ jobId, index }) {
  return `${str(jobId)}#${String(int(index)).padStart(4, '0')}`;
}

/** 何個の子バッチに分割されるか */
export function countChildBatches(total, childSize) {
  const t = Math.max(0, int(total));
  const s = clampChildSize(childSize);
  return Math.ceil(t / s);
}

export function clampChildSize(size) {
  const n = int(size) || JOB_CHILD_MAX_ROWS;
  return Math.min(JOB_CHILD_MAX_ROWS, Math.max(1, n));
}

/**
 * 親ジョブを作る。**開始時に対象総数と対象ファイルを固定する**（snapshot）。
 *
 * @param {{
 *   batchId: string, fileFingerprint: string, plannedTotal: number,
 *   childSize?: number, nowIso: string, startedBy?: string,
 * }} input
 */
export function createImportJob({
  batchId, fileFingerprint, plannedTotal, childSize, nowIso, startedBy,
} = {}) {
  const b = str(batchId);
  const total = Math.max(0, int(plannedTotal));
  const size = clampChildSize(childSize);
  if (!b || !str(fileFingerprint) || total <= 0) return null;
  return {
    jobId: buildJobId(b),
    batchId: b,
    source: buildJobSource(b),
    /** 開始時に固定した CSV の指紋。以後これと違うファイルでは進めない */
    fileFingerprint: str(fileFingerprint),
    /** 開始時に固定した対象総数（CREATE 候補）。**これを超えて書かない** */
    plannedTotal: total,
    childSize: size,
    childBatches: countChildBatches(total, size),
    status: JOB_STATUS.PLANNED,
    /** 決定的な対象一覧の中で「どこまで見たか」。**正本ではなく目印** */
    cursor: 0,
    children: [],
    totals: { attempted: 0, created: 0, skippedExisting: 0, failed: 0 },
    lease: null,
    lastError: null,
    startedBy: str(startedBy) || null,
    createdAt: str(nowIso),
    updatedAt: str(nowIso),
    finishedAt: null,
  };
}

const no = (reason) => ({ allowed: false, reason, label: JOB_REJECT_LABEL[reason] || null });

/**
 * ジョブを**開始**してよいか。二重ゲート（env + 確認文字列）を通す。
 * 既存ジョブがあれば開始しない（同じ batchId を作り直させない）。
 */
export function canStartImportJob({
  env, confirmation, batchId, plannedTotal, existingJob, providerOk,
} = {}) {
  if (!env || env.CUSTOMER_IMPORT_WRITE_ENABLED !== 'true') return no(JOB_REJECT.WRITE_DISABLED);
  if (!str(confirmation)) return no(JOB_REJECT.NO_CONFIRMATION);
  if (providerOk !== true) return no(JOB_REJECT.PREVIEW_INVALID);
  const total = int(plannedTotal);
  if (total <= 0) return no(JOB_REJECT.NOTHING_TO_WRITE);
  if (existingJob) return no(JOB_REJECT.JOB_EXISTS);
  const expected = buildJobConfirmation({ batchId, total });
  if (str(confirmation) !== expected) return no(JOB_REJECT.CONFIRMATION_MISMATCH);
  return { allowed: true, reason: null, total };
}

/**
 * 子バッチを 1 つ**進めて**よいか。
 * **完了・取消・失敗のジョブは進めない**（再実行拒否）。
 * リース中の他実行があれば fail-closed で断る（best-effort の多重防御）。
 */
export function canStepImportJob({
  env, job, nowMs, fileFingerprint, providerOk, leaseMs,
} = {}) {
  if (!env || env.CUSTOMER_IMPORT_WRITE_ENABLED !== 'true') return no(JOB_REJECT.WRITE_DISABLED);
  if (!job) return no(JOB_REJECT.JOB_NOT_FOUND);
  if (job.status === JOB_STATUS.COMPLETED) return no(JOB_REJECT.ALREADY_COMPLETED);
  if (job.status === JOB_STATUS.CANCELLED) return no(JOB_REJECT.CANCELLED);
  if (job.status === JOB_STATUS.FAILED) return no(JOB_REJECT.FAILED);
  if (providerOk !== true) return no(JOB_REJECT.PREVIEW_INVALID);
  if (str(fileFingerprint) && str(fileFingerprint) !== str(job.fileFingerprint)) {
    return no(JOB_REJECT.FILE_CHANGED);
  }
  if (isLeaseHeld({ job, nowMs, leaseMs })) return no(JOB_REJECT.LOCKED);
  if (int(job.totals?.created) >= int(job.plannedTotal)) return no(JOB_REJECT.NOTHING_TO_WRITE);
  return { allowed: true, reason: null };
}

/** リースが生きているか（切れていれば引き継いでよい） */
export function isLeaseHeld({ job, nowMs, leaseMs } = {}) {
  const lease = job && job.lease;
  if (!lease || !lease.until) return false;
  const until = Date.parse(lease.until);
  if (!Number.isFinite(until)) return false;
  const now = Number.isFinite(nowMs) ? nowMs : 0;
  const span = Number.isFinite(leaseMs) ? leaseMs : JOB_LEASE_MS;
  // until を過ぎていれば失効。span は「取り直してよいか」の目安として残す
  return now < until && span > 0;
}

/** 子バッチの開始を記録する（リースを張る） */
export function beginChildBatch({ job, nowMs, nowIso, holder, leaseMs } = {}) {
  const index = nextChildIndex(job);
  const span = Number.isFinite(leaseMs) ? leaseMs : JOB_LEASE_MS;
  return {
    ...job,
    status: JOB_STATUS.RUNNING,
    lease: {
      holder: str(holder) || 'unknown',
      until: new Date((Number.isFinite(nowMs) ? nowMs : 0) + span).toISOString(),
    },
    updatedAt: str(nowIso),
    currentChild: { index, batchKey: buildChildBatchKey({ jobId: job.jobId, index }), startedAt: str(nowIso) },
  };
}

/** 次に実行する子バッチの番号（1 始まり） */
export function nextChildIndex(job) {
  return (Array.isArray(job?.children) ? job.children.length : 0) + 1;
}

/**
 * 子バッチの結果を反映する。**進捗の解釈はここに集約**する。
 *
 * @param {{
 *   job: object,
 *   result: { created, skippedExisting, failed, attempted, bulkRequests, singleRequests, ok },
 *   scannedTo: number,          決定的な対象一覧の中でどこまで見たか
 *   exhausted?: boolean,        一覧を最後まで見終わったか
 *   nowIso: string,
 * }} input
 */
export function applyChildResult({ job, result, scannedTo, exhausted, nowIso } = {}) {
  const r = result || {};
  const index = job?.currentChild?.index || nextChildIndex(job);
  const child = {
    index,
    batchKey: job?.currentChild?.batchKey || buildChildBatchKey({ jobId: job?.jobId, index }),
    state: r.ok === false ? IMPORT_BATCH_STATE.FAILED : IMPORT_BATCH_STATE.DONE,
    attempted: int(r.attempted),
    created: int(r.created),
    skippedExisting: int(r.skippedExisting) + int(r.skippedDone),
    failed: int(r.failed),
    bulkRequests: int(r.bulkRequests),
    singleRequests: int(r.singleRequests),
    at: str(nowIso),
  };
  const children = [...(job.children || []), child];
  const totals = {
    attempted: int(job.totals?.attempted) + child.attempted,
    created: int(job.totals?.created) + child.created,
    skippedExisting: int(job.totals?.skippedExisting) + child.skippedExisting,
    failed: int(job.totals?.failed) + child.failed,
  };

  let status = JOB_STATUS.RUNNING;
  const done = totals.created >= int(job.plannedTotal) || exhausted === true;
  if (done) status = totals.failed > 0 ? JOB_STATUS.PARTIAL : JOB_STATUS.COMPLETED;

  return {
    ...job,
    status,
    cursor: Math.max(int(job.cursor), int(scannedTo)),
    children,
    totals,
    // リースは必ず外す（次の子バッチが進めるように）
    lease: null,
    currentChild: null,
    lastError: r.ok === false ? str(r.reason) || 'child_failed' : null,
    updatedAt: str(nowIso),
    finishedAt: done ? str(nowIso) : null,
  };
}

/** 子バッチが例外で落ちたとき。**リースを外して PARTIAL で残す**（再開できる） */
export function markChildError({ job, error, nowIso } = {}) {
  return {
    ...job,
    status: JOB_STATUS.PARTIAL,
    lease: null,
    currentChild: null,
    lastError: str(error) || 'child_error',
    updatedAt: str(nowIso),
  };
}

/**
 * 取り消す。**未処理分だけ止める。作成済みレコードは消さない。**
 */
export function cancelImportJob({ job, nowIso } = {}) {
  if (!job) return null;
  if (job.status === JOB_STATUS.COMPLETED) {
    return { ...job, cancelNote: '完了済みのジョブは取り消せません（作成済みの行は消しません）。' };
  }
  return {
    ...job,
    status: JOB_STATUS.CANCELLED,
    lease: null,
    currentChild: null,
    updatedAt: str(nowIso),
    finishedAt: str(nowIso),
    cancelNote: '未処理分だけ止めました。作成済みの行は取り消していません（隔離は Source 単位で行います）。',
  };
}

/** 画面へ出す進捗。**アドレス・氏名は含めない** */
export function summarizeJobProgress(job) {
  if (!job) return null;
  const planned = int(job.plannedTotal);
  const t = job.totals || {};
  const created = int(t.created);
  const remaining = Math.max(0, planned - created);
  const children = Array.isArray(job.children) ? job.children : [];
  return {
    jobId: job.jobId,
    ImportBatchId: job.batchId,
    Source: job.source,
    status: job.status,
    対象総数: planned,
    処理済み: int(t.attempted),
    作成済み: created,
    既存スキップ: int(t.skippedExisting),
    失敗: int(t.failed),
    残件数: remaining,
    進捗率: planned > 0 ? Math.min(100, Math.round((created / planned) * 1000) / 10) : 0,
    子バッチ数: int(job.childBatches),
    完了した子バッチ: children.length,
    現在の子バッチ: job.currentChild ? job.currentChild.index : null,
    最終更新: job.updatedAt || null,
    終了時刻: job.finishedAt || null,
    再実行可能: !TERMINAL_STATUS.includes(job.status),
    lastError: job.lastError || null,
  };
}

/**
 * 突合。**作成数が計画を超えていないか**を毎回検算する。
 * `createdInAirtable` を渡すと、Airtable 実測（正本）との一致も見る。
 */
export function reconcileImportJob({ job, createdInAirtable } = {}) {
  const planned = int(job?.plannedTotal);
  const t = job?.totals || {};
  const created = int(t.created);
  const skipped = int(t.skippedExisting);
  const failed = int(t.failed);
  const attempted = int(t.attempted);
  const actual = Number.isFinite(createdInAirtable) ? int(createdInAirtable) : null;
  return {
    planned,
    attempted,
    created,
    skippedExisting: skipped,
    failed,
    accounted: created + skipped + failed,
    /** 試行した行がすべて説明できているか */
    balanced: created + skipped + failed === attempted,
    /** 計画より多く書いていないか。false なら**即座に止める** */
    withinPlan: created <= planned,
    createdInAirtable: actual,
    /** ジョブ記録と Airtable 実測が一致するか（正本は Airtable） */
    matchesAirtable: actual === null ? null : actual === created,
    note: created + skipped + failed === attempted
      ? '件数は一致しています。'
      : '件数が合いません。次の子バッチへ進まず、監査ログで差分を確認してください。',
  };
}

/** rollback 手順（削除しない・Source 単位の隔離） */
export function describeJobRollback(job) {
  const src = job?.source || buildJobSource(job?.batchId);
  return {
    Source: src,
    既定: '隔離（削除しない）',
    steps: [
      `Airtable で Source = "${src}" を絞り込み、件数が「作成済み」と一致することを確認する。`,
      'プランは Free のまま据え置く（課金・特典フィールドは元々空なので触らない）。',
      `キャンペーンのセグメント条件で Source = "${src}" を除外し、配信対象から外す。`,
      'レコードは消さない（履歴を残す）。削除は別の高リスク操作・別承認。',
    ],
    warning: '取り込みと配信を同じ操作にしない（取り込んだ直後に自動送信しない）。',
  };
}

export default createImportJob;
