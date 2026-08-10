/**
 * 移行スクリプトの checkpoint（純粋・IO なし）。
 *
 * ── 何のために ──────────────────────────────────────────────
 * 14,416 件 / 18,793 件の読み取りは数分かかる。途中で落ちたときに
 * **最初からやり直しても壊れない**ことと、**やり直さずに済む**ことの両方が要る。
 *
 * ── 前提（これが崩れると checkpoint は使えない）──────────────
 *  - 書き込みは**すべて冪等**（Redis は SADD、Blob は内容ハッシュのキー）。
 *    したがって「途中まで進んだ状態でもう一度全部流す」が常に安全。
 *  - checkpoint は**高速化のためだけ**にある。壊れていたら捨てて最初から流せばよい。
 *  - Airtable の `offset` は短命なので **checkpoint に保存しない**。
 *    再開は「読み直して、既に入れた分は冪等で素通りする」で行う。
 *    ここに offset を持たせると、期限切れの offset で再開して**取りこぼす**。
 */

export const CHECKPOINT_VERSION = 1;

/** 進行中の移行 1 本ぶんの状態 */
export function createCheckpoint({ job, totalHint = null, startedAt } = {}) {
  const j = String(job || '').trim();
  if (!/^[a-z][a-z0-9-]{2,60}$/.test(j)) throw new Error('checkpoint:bad_job');
  return {
    version: CHECKPOINT_VERSION,
    job: j,
    startedAt: String(startedAt || ''),
    updatedAt: String(startedAt || ''),
    // 「どこまで読んだか」ではなく「何を成し遂げたか」を持つ。
    // offset を持たない理由は先頭コメント参照。
    pagesRead: 0,
    recordsRead: 0,
    recordsWritten: 0,
    recordsSkipped: 0,
    batchesWritten: 0,
    // 書き終えたバッチの識別子（Blob の content hash 等）。二重作成の検知に使う
    writtenBatchIds: [],
    lastError: null,
    done: false,
  };
}

/** 保存されていた JSON が今のスクリプトで使える形か。**怪しければ使わない**。 */
export function isResumable(cp, { job } = {}) {
  if (!cp || typeof cp !== 'object') return { ok: false, reason: 'missing' };
  if (cp.version !== CHECKPOINT_VERSION) return { ok: false, reason: 'version_mismatch' };
  if (cp.job !== job) return { ok: false, reason: 'job_mismatch' };
  if (cp.done === true) return { ok: false, reason: 'already_done' };
  for (const k of ['pagesRead', 'recordsRead', 'recordsWritten']) {
    if (!Number.isInteger(cp[k]) || cp[k] < 0) return { ok: false, reason: 'counter_invalid' };
  }
  if (!Array.isArray(cp.writtenBatchIds)) return { ok: false, reason: 'batches_invalid' };
  return { ok: true, reason: null };
}

/** 進捗を足す。**減らない**（減っていたら壊れているので例外）。 */
export function advanceCheckpoint(cp, delta = {}, nowIso) {
  const next = { ...cp, updatedAt: String(nowIso || cp.updatedAt) };
  for (const k of ['pagesRead', 'recordsRead', 'recordsWritten', 'recordsSkipped', 'batchesWritten']) {
    const d = Number(delta[k] || 0);
    if (!Number.isFinite(d) || d < 0) throw new Error(`checkpoint:negative_delta:${k}`);
    next[k] = (Number(cp[k]) || 0) + d;
  }
  if (delta.batchId) {
    if (next.writtenBatchIds.includes(delta.batchId)) {
      // 同じバッチを 2 回書いた＝冪等が効いている（Blob は同一キー）。数だけ戻す
      next.batchesWritten = cp.batchesWritten;
      next.duplicateBatchSkipped = (cp.duplicateBatchSkipped || 0) + 1;
    } else {
      next.writtenBatchIds = [...cp.writtenBatchIds, delta.batchId];
    }
  }
  return next;
}

export function finishCheckpoint(cp, nowIso) {
  return { ...cp, done: true, updatedAt: String(nowIso || cp.updatedAt), lastError: null };
}

export function failCheckpoint(cp, reason, nowIso) {
  // 理由コードだけ。値・アドレス・鍵は入れない
  return { ...cp, lastError: String(reason || 'unknown').slice(0, 120), updatedAt: String(nowIso || cp.updatedAt) };
}

/**
 * 「読んだ件数」と「書いた + 飛ばした件数」が合っているか。
 * **合っていないのに done にしない**（黙って取りこぼす経路を作らない）。
 */
export function verifyCheckpointBalance(cp) {
  const read = Number(cp.recordsRead) || 0;
  const accounted = (Number(cp.recordsWritten) || 0) + (Number(cp.recordsSkipped) || 0);
  return {
    balanced: read === accounted,
    read,
    accounted,
    missing: read - accounted,
  };
}
