/**
 * importJobModel.js — 親ジョブ + 子バッチの**状態機械**（純粋・I/O なし）
 *
 * ── なぜ「親ジョブ」が要るのか ────────────────────────────────
 * 残り 14,284 件を 1 回 100 件の手動 run で処理すると約 143 回になる。
 * 人が 143 回ゲートを開け閉めするのは現実的でなく、途中で状態を見失う。
 * そこで **管理者は 1 回だけ開始し、内部で 100 件以下の子バッチへ分割**する。
 *
 * ── 正本は Redis（`importJobAuthority.js`）────────────────────
 * Airtable の `Source` 件数だけでは **snapshot / 失敗 / 未処理 / cancel 境界 /
 * operationId** を復元できない。Netlify Blobs は last-write-wins で排他にならない。
 * したがってジョブの正本は Redis に置き、本モジュールは**その記録に対する遷移規則**だけを持つ。
 *
 * ── 排他は Redis（`importClaimStore.js`）──────────────────────
 *   - AK 全体で同時に走れる write ジョブを 1 つに限定する**グローバルロック**
 *   - 行 claim は **正規化メール単位でグローバル**（batchId で区切らない）
 *   - Customers の実在判定は**第二防御**であって、排他の代替ではない
 *
 * ⚠️ Redis に到達できない / 結果が不明 / 正本が読めない / claim 不整合 /
 *    データ欠損が疑われる場合は、**新規 Airtable 書き込みを全面停止**する（fail-closed）。
 */

import { FIRST_RUN_MAX_ROWS, IMPORT_SOURCE_PREFIX } from './importWritePlan.js';

/** 子バッチ 1 つの最大件数。**既存の 1 回上限と同じ 100 件を超えない** */
export const JOB_CHILD_MAX_ROWS = FIRST_RUN_MAX_ROWS;

/** 親ジョブの状態 */
export const JOB_STATUS = Object.freeze({
  PLANNED: 'PLANNED',
  RUNNING: 'RUNNING',
  PARTIAL: 'PARTIAL',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  /** 突合が説明できない不一致を出した。**人が見るまで進めない** */
  BLOCKED: 'BLOCKED',
});

/** これ以上進めない終端状態（再実行を拒否する） */
export const TERMINAL_STATUS = Object.freeze([
  JOB_STATUS.COMPLETED, JOB_STATUS.CANCELLED, JOB_STATUS.FAILED, JOB_STATUS.BLOCKED,
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
  BLOCKED: 'blocked',
  LOCKED: 'locked',
  FILE_CHANGED: 'file_changed',
  SNAPSHOT_CHANGED: 'snapshot_changed',
  NOTHING_TO_WRITE: 'nothing_to_write',
  PREVIEW_INVALID: 'preview_invalid',
  REDIS_UNAVAILABLE: 'redis_unavailable',
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
  blocked: '突合が一致しないため停止しています。人が確認するまで進めません。',
  locked: '別の取り込みが進行中です（AK 全体で同時に 1 つだけ）。',
  file_changed: '開始時と違う CSV です。',
  snapshot_changed: '開始時に固定した対象一覧と一致しません。',
  nothing_to_write: '作成する行がありません。',
  preview_invalid: '停止リストを確認できないため実行しません。',
  redis_unavailable: 'Redis を確認できないため、新規書き込みを停止しました（fail-closed）。',
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

/** 子バッチの操作 ID（冪等キー）。**ジョブ内で一意** */
export function buildOperationId({ jobId, index }) {
  return `${str(jobId)}#${String(int(index)).padStart(4, '0')}`;
}

/** 何個の子バッチに分割されるか */
export function countChildBatches(total, childSize) {
  const t = Math.max(0, int(total));
  return Math.ceil(t / clampChildSize(childSize));
}

export function clampChildSize(size) {
  const n = int(size) || JOB_CHILD_MAX_ROWS;
  return Math.min(JOB_CHILD_MAX_ROWS, Math.max(1, n));
}

/** 次に実行する子バッチの番号（1 始まり） */
export function nextChildIndex(job) {
  return (Array.isArray(job?.childHistory) ? job.childHistory.length : 0) + 1;
}

const no = (reason) => ({ allowed: false, reason, label: JOB_REJECT_LABEL[reason] || null });

/**
 * ジョブを**開始**してよいか。二重ゲート（env + 確認文字列）を通す。
 * ⚠️ グローバルロックの取得は呼び出し側の責務（`claims.acquireGlobalLock`）。
 *    **取れていなければ Airtable を一切読まない・書かない。**
 */
export function canStartImportJob({
  env, confirmation, batchId, plannedTotal, existingJob, providerOk, lockAcquired,
} = {}) {
  if (!env || env.CUSTOMER_IMPORT_WRITE_ENABLED !== 'true') return no(JOB_REJECT.WRITE_DISABLED);
  if (lockAcquired !== true) return no(JOB_REJECT.LOCKED);
  if (!str(confirmation)) return no(JOB_REJECT.NO_CONFIRMATION);
  if (providerOk !== true) return no(JOB_REJECT.PREVIEW_INVALID);
  const total = int(plannedTotal);
  if (total <= 0) return no(JOB_REJECT.NOTHING_TO_WRITE);
  if (existingJob) return no(JOB_REJECT.JOB_EXISTS);
  if (str(confirmation) !== buildJobConfirmation({ batchId, total })) {
    return no(JOB_REJECT.CONFIRMATION_MISMATCH);
  }
  return { allowed: true, reason: null, total };
}

/**
 * 子バッチを 1 つ**進めて**よいか。
 * **終端状態のジョブは進めない**（再実行拒否）。
 * ⚠️ 排他は Redis のグローバルロック。`lockAcquired` が true でなければ進めない。
 */
export function canStepImportJob({
  env, job, fileFingerprint, snapshotOk, providerOk, lockAcquired,
} = {}) {
  if (!env || env.CUSTOMER_IMPORT_WRITE_ENABLED !== 'true') return no(JOB_REJECT.WRITE_DISABLED);
  if (!job) return no(JOB_REJECT.JOB_NOT_FOUND);
  if (job.status === JOB_STATUS.COMPLETED) return no(JOB_REJECT.ALREADY_COMPLETED);
  if (job.status === JOB_STATUS.CANCELLED) return no(JOB_REJECT.CANCELLED);
  if (job.status === JOB_STATUS.FAILED) return no(JOB_REJECT.FAILED);
  if (job.status === JOB_STATUS.BLOCKED) return no(JOB_REJECT.BLOCKED);
  if (lockAcquired !== true) return no(JOB_REJECT.LOCKED);
  if (providerOk !== true) return no(JOB_REJECT.PREVIEW_INVALID);
  if (str(fileFingerprint) && str(fileFingerprint) !== str(job.fileFingerprint)) {
    return no(JOB_REJECT.FILE_CHANGED);
  }
  if (snapshotOk === false) return no(JOB_REJECT.SNAPSHOT_CHANGED);
  if (int(job.created) >= int(job.plannedTotal)) return no(JOB_REJECT.NOTHING_TO_WRITE);
  return { allowed: true, reason: null };
}

/** 子バッチの開始を記録する（正本へ書き戻す前の形を作る） */
export function beginChildBatch({ job, nowIso, operationId, fencingToken }) {
  const index = nextChildIndex(job);
  return {
    ...job,
    status: JOB_STATUS.RUNNING,
    currentChild: {
      index,
      operationId: str(operationId) || buildOperationId({ jobId: job.jobId, index }),
      fencingToken: str(fencingToken),
      startedAt: str(nowIso),
    },
    fencingToken: str(fencingToken),
    operationId: str(operationId) || buildOperationId({ jobId: job.jobId, index }),
    updatedAt: str(nowIso),
  };
}

/**
 * 子バッチの結果を正本へ反映する。
 *
 * @param {{
 *   job, result, scannedTo, exhausted, nowIso,
 *   claimedNotCreated?: number,
 * }} input
 */
export function applyChildResult({
  job, result, scannedTo, exhausted, nowIso, claimedNotCreated,
} = {}) {
  const r = result || {};
  const index = job?.currentChild?.index || nextChildIndex(job);
  const child = {
    index,
    operationId: job?.currentChild?.operationId || buildOperationId({ jobId: job?.jobId, index }),
    fencingToken: job?.currentChild?.fencingToken || null,
    state: r.ok === false ? 'FAILED' : 'DONE',
    attempted: int(r.attempted),
    created: int(r.created),
    skippedExisting: int(r.skippedExisting) + int(r.skippedDone),
    failed: int(r.failed),
    bulkRequests: int(r.bulkRequests),
    singleRequests: int(r.singleRequests),
    claimedNotCreated: int(claimedNotCreated),
    at: str(nowIso),
  };
  const childHistory = [...(job.childHistory || []), child];
  const created = int(job.created) + child.created;
  const done = created >= int(job.plannedTotal) || exhausted === true;

  let status = JOB_STATUS.RUNNING;
  if (done) status = (int(job.failed) + child.failed) > 0 ? JOB_STATUS.PARTIAL : JOB_STATUS.COMPLETED;

  return {
    ...job,
    status,
    cursor: Math.max(int(job.cursor), int(scannedTo)),
    attempted: int(job.attempted) + child.attempted,
    created,
    skippedExisting: int(job.skippedExisting) + child.skippedExisting,
    failed: int(job.failed) + child.failed,
    childHistory,
    currentChild: null,
    updatedAt: str(nowIso),
  };
}

/** 突合が説明できない不一致を出した。**人が見るまで進めない** */
/**
 * 正本の counters を Airtable 実測へ追いつかせる（**再開時の 1 回だけ**）。
 *
 * ⚠️ 2026-08-09 の障害: 子バッチが Airtable へ 100 件 CREATE した直後に
 *    正本の保存だけが失敗し、`created=0` のまま 100 件が存在する状態になった。
 *    そのまま再開すると reconciler の `created_matches_airtable` が必ず落ちて
 *    BLOCKED になり、永久に進めない。
 *
 * ⚠️ **無条件には追いつかせない。** 適用するのは
 *    「まだ 1 つも子バッチを完了記録していない（childHistory が空）」ときだけ。
 *    実行中のドリフトを黙って飲み込まないための制限。
 * ⚠️ **増やす方向にしか動かさない**（削除・巻き戻しの兆候を隠さない）。
 * ⚠️ plannedTotal を超えて増やさない。
 *
 * @param {{ job: object, airtableSourceCount: number, nowIso: string }} input
 * @returns {{ job: object, adopted: number, reason: string|null }}
 */
export function adoptMeasuredCreated({ job, airtableSourceCount, nowIso } = {}) {
  if (!job) return { job, adopted: 0, reason: 'no_job' };
  if ((Array.isArray(job.childHistory) ? job.childHistory.length : 0) > 0) {
    return { job, adopted: 0, reason: 'not_first_step' };
  }
  const measured = int(airtableSourceCount);
  const recorded = int(job.created);
  if (measured <= recorded) return { job, adopted: 0, reason: 'no_gap' };
  const capped = Math.min(measured, int(job.plannedTotal));
  if (capped <= recorded) return { job, adopted: 0, reason: 'capped' };
  const gained = capped - recorded;
  // ⚠️ `created` だけ上げると `counters_balanced`（created+skipped+failed == attempted）が
  //    崩れて reconciler が落ちる。取り残された行は**試行もされている**ので
  //    `attempted` も同じだけ上げる。
  const attempted = Math.max(int(job.attempted) + gained, capped);
  return {
    job: {
      ...job,
      created: capped,
      attempted,
      /** 監査用。件数だけ（アドレスは持たない） */
      countersAdopted: { from: recorded, to: capped, attemptedTo: attempted, at: str(nowIso) },
      updatedAt: str(nowIso),
    },
    adopted: gained,
    reason: null,
  };
}

/**
 * counters の**算術的な不変条件**を回復する。
 *
 *   attempted >= created + skippedExisting + failed
 *
 * 「作成した数が試行した数を超える」ことは定義上ありえない。超えていれば
 * `attempted` の記録漏れなので、**attempted を増やす方向にだけ**直す。
 * created / skippedExisting / failed は**一切触らない**（実測由来なので推測しない）。
 *
 * ⚠️ 2026-08-09 の障害: Function が runner の `attempted` を渡しておらず、
 *    正本が `created=200 / attempted=100` で保存された。以後 counters_balanced が
 *    永久に落ち、BLOCKED から出られなくなった（unblock も reconcile OK を要求するため）。
 *    コード修正は将来の step にしか効かないので、**既存の正本を直す経路**が要る。
 *
 * @param {{ job: object, nowIso: string }} input
 * @returns {{ job: object, repaired: number, reason: string|null }}
 */
export function repairCounterInvariants({ job, nowIso } = {}) {
  if (!job) return { job, repaired: 0, reason: 'no_job' };
  const created = int(job.created);
  const skipped = int(job.skippedExisting);
  const failed = int(job.failed);
  const attempted = int(job.attempted);
  const need = created + skipped + failed;
  if (attempted >= need) return { job, repaired: 0, reason: 'already_consistent' };
  return {
    job: {
      ...job,
      attempted: need,
      /** 監査用。件数だけ */
      countersRepaired: { attemptedFrom: attempted, attemptedTo: need, at: str(nowIso) },
      updatedAt: str(nowIso),
    },
    repaired: need - attempted,
    reason: null,
  };
}

/** BLOCKED 解除の確認文字列（batchId に紐づくので使い回せない） */
export function buildUnblockConfirmation(batchId) {
  return `UNBLOCK ${str(batchId)}`;
}

/**
 * BLOCKED を解除して再開可能にする。**突合が今 OK のときだけ。**
 *
 * ⚠️ 「人が確認した」を機械的に代替しない。解除の条件は
 *    **その場で取り直した実測で reconcile が OK になること**。
 *    OK にならないなら解除しない（BLOCKED の意味を保つ）。
 * ⚠️ 解除しても counters は書き換えない（追いつきは adoptMeasuredCreated の役割）。
 *
 * @param {{ job: object, reconciliation: object, confirmation: string, nowIso: string }} input
 */
export function unblockImportJob({ job, reconciliation, confirmation, nowIso } = {}) {
  if (!job) return { ok: false, reason: JOB_REJECT.JOB_NOT_FOUND, job: null };
  if (job.status !== JOB_STATUS.BLOCKED) return { ok: false, reason: 'not_blocked', job };
  if (str(confirmation) !== buildUnblockConfirmation(job.batchId)) {
    return { ok: false, reason: JOB_REJECT.CONFIRMATION_MISMATCH, job };
  }
  const v = reconciliation && reconciliation.verdict;
  if (v !== 'OK') {
    return { ok: false, reason: 'still_inconsistent', job, failedChecks: (reconciliation || {}).failedChecks || [] };
  }
  return {
    ok: true,
    reason: null,
    job: {
      ...job,
      status: JOB_STATUS.RUNNING,
      currentChild: null,
      reconciliation,
      unblockedAt: str(nowIso),
      updatedAt: str(nowIso),
    },
  };
}

export function markJobBlocked({ job, reconciliation, nowIso }) {
  return {
    ...job,
    status: JOB_STATUS.BLOCKED,
    currentChild: null,
    reconciliation: reconciliation || null,
    updatedAt: str(nowIso),
  };
}

/** Redis が信用できない。**新規書き込みを止めた**ことを正本に残す */
export function markJobRedisUnavailable({ job, code, nowIso }) {
  return {
    ...job,
    status: JOB_STATUS.BLOCKED,
    currentChild: null,
    reconciliation: { verdict: 'BLOCKED', reason: `redis_unavailable:${str(code)}` },
    updatedAt: str(nowIso),
  };
}

/**
 * 取り消す。**未処理分だけ止める。作成済みレコードは消さない。**
 *
 * cancel 境界:
 *   - `CANCELLED` へ遷移した**後は新しい子バッチ claim を取らない**
 *   - すでに Airtable create を開始した子バッチの**結果は確定させる**
 *     （途中で切らない。`applyChildResult` は cancel 後でも反映してよい）
 *   - **claim 済み・未開始**の行は解放しない。reconciler が 4 条件を確認して回収する
 */
export function cancelImportJob({ job, nowIso } = {}) {
  if (!job) return null;
  if (job.status === JOB_STATUS.COMPLETED) {
    return { ...job, cancelNote: '完了済みのジョブは取り消せません（作成済みの行は消しません）。' };
  }
  return {
    ...job,
    status: JOB_STATUS.CANCELLED,
    currentChild: null,
    cancelledAt: str(nowIso),
    updatedAt: str(nowIso),
    cancelNote: [
      '未処理分だけ止めました。作成済みの行は取り消していません。',
      '実行中だった子バッチの結果は確定させます（途中で切りません）。',
      'claim 済み・未作成の行は reconciler が 4 条件を確認してから回収します。',
    ].join(' '),
  };
}

/** 画面へ出す進捗。**アドレス・氏名は含めない** */
export function summarizeJobProgress(job) {
  if (!job) return null;
  const planned = int(job.plannedTotal);
  const created = int(job.created);
  const history = Array.isArray(job.childHistory) ? job.childHistory : [];
  return {
    jobId: job.jobId,
    ImportBatchId: job.batchId,
    Source: job.source,
    status: job.status,
    対象総数: planned,
    処理済み: int(job.attempted),
    作成済み: created,
    既存スキップ: int(job.skippedExisting),
    失敗: int(job.failed),
    残件数: Math.max(0, planned - created),
    進捗率: planned > 0 ? Math.min(100, Math.round((created / planned) * 1000) / 10) : 0,
    子バッチ数: countChildBatches(planned, job.childSize),
    完了した子バッチ: history.length,
    現在の子バッチ: job.currentChild ? job.currentChild.index : null,
    最終更新: job.updatedAt || null,
    取消時刻: job.cancelledAt || null,
    fencingToken: job.fencingToken || null,
    operationId: job.operationId || null,
    snapshotFingerprint: job.snapshotFingerprint || null,
    orderingVersion: job.orderingVersion || null,
    再実行可能: !TERMINAL_STATUS.includes(job.status),
    reconciliation: job.reconciliation || null,
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

export default canStartImportJob;
