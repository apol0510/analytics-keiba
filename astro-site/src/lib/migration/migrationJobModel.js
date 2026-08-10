/**
 * chunk 実行する移行ジョブの状態（純粋・IO なし）。
 *
 * ── なぜ Function 内で分割実行するのか ────────────────────────
 * Redis / Blobs の認証情報は production env にしか無く、**手元からは到達できない**
 * （`netlify env:get` は secret をマスクする）。値を人に渡してもらう運用は
 * 漏洩面を増やすので採らない。したがって env が揃っている Function 内で動かす。
 *
 * ただし Netlify Function は最大 26 秒しかない。14,415 件を 1 回で処理できないので
 * **1 step あたり数百件**に切り、`step` を繰り返して進める。
 *
 * ── 正しさは「冪等」で担保する（cursor ではない）─────────────
 * 書き込みはすべて冪等:
 *   - Redis は `SADD`（同じ鍵を何度足しても集合は変わらない）
 *   - Blob は**内容ハッシュのキー**（同じバッチは同じキーへ上書き＝等価）
 * したがって「同じ範囲をもう一度処理する」は常に安全。cursor は**速くするため**
 * だけにある。壊れたら最初から読み直せばよい。
 *
 * ⚠️ Airtable の `offset` は短命で、時間が空くと失効する。失効を検知したら
 *    **先頭から読み直す**（黙って途中から再開して取りこぼすより、やり直す方が安全）。
 */

export const JOB_TYPE = Object.freeze({
  DELIVERY_KEYS: 'delivery-keys',
  EMAIL_EVENTS: 'email-events',
});

export const JOB_STATUS = Object.freeze({
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
});

export const MODEL_VERSION = 1;

/** 1 step で処理する件数の既定と上限（Function の 26 秒に収める） */
export const DEFAULT_CHUNK = Object.freeze({
  [JOB_TYPE.DELIVERY_KEYS]: 500,
  [JOB_TYPE.EMAIL_EVENTS]: 500,
});
export const MAX_CHUNK = 1000;
export const MIN_CHUNK = 50;

const VALID_TYPES = new Set(Object.values(JOB_TYPE));

export function isValidJobType(t) {
  return VALID_TYPES.has(String(t || ''));
}

export function clampChunk(requested, jobType) {
  const dflt = DEFAULT_CHUNK[jobType] || 500;
  const n = Number(requested);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, Math.floor(n)));
}

/** Redis のキー。AK 専用名前空間で、KMA / KI とは共有しない。 */
export const JOB_NAMESPACE = 'ak:mkt:migration';
export function jobKey(jobType) {
  if (!isValidJobType(jobType)) throw new Error('migration_job:bad_type');
  return `${JOB_NAMESPACE}:${jobType}`;
}
export function lockKey(jobType) {
  return `${jobKey(jobType)}:lock`;
}

export function createJob({ jobType, chunkSize, nowIso }) {
  if (!isValidJobType(jobType)) throw new Error('migration_job:bad_type');
  return {
    version: MODEL_VERSION,
    jobType,
    status: JOB_STATUS.RUNNING,
    chunkSize: clampChunk(chunkSize, jobType),
    // Airtable の offset。**短命**なので失効したら null へ戻して先頭から読み直す
    cursor: null,
    cursorResets: 0,
    pagesRead: 0,
    recordsRead: 0,
    recordsWritten: 0,
    recordsSkipped: 0,
    batchesWritten: 0,
    // Blob のキー（二重作成の検知用）。件数が増えるので上限を設ける
    recentBatchIds: [],
    steps: 0,
    startedAt: String(nowIso || ''),
    updatedAt: String(nowIso || ''),
    lastError: null,
  };
}

const RECENT_BATCH_LIMIT = 50;

/** step の結果を積む。**カウンタは減らない**。 */
export function applyStep(job, delta = {}, nowIso) {
  if (!job) throw new Error('migration_job:missing');
  const next = { ...job, steps: (job.steps || 0) + 1, updatedAt: String(nowIso || job.updatedAt) };
  for (const k of ['pagesRead', 'recordsRead', 'recordsWritten', 'recordsSkipped', 'batchesWritten']) {
    const d = Number(delta[k] || 0);
    if (!Number.isFinite(d) || d < 0) throw new Error(`migration_job:negative_delta:${k}`);
    next[k] = (Number(job[k]) || 0) + d;
  }
  if ('cursor' in delta) next.cursor = delta.cursor || null;
  if (delta.cursorReset) {
    next.cursorResets = (job.cursorResets || 0) + 1;
    next.cursor = null;
  }
  if (Array.isArray(delta.batchIds) && delta.batchIds.length > 0) {
    const merged = [...(job.recentBatchIds || []), ...delta.batchIds];
    next.recentBatchIds = merged.slice(-RECENT_BATCH_LIMIT);
  }
  next.lastError = null;
  return next;
}

export function completeJob(job, nowIso) {
  return { ...job, status: JOB_STATUS.COMPLETED, cursor: null, updatedAt: String(nowIso || job.updatedAt) };
}

/** 理由コードだけ残す。値・アドレス・鍵は入れない。 */
export function failJob(job, reason, nowIso) {
  return {
    ...job,
    status: JOB_STATUS.FAILED,
    lastError: String(reason || 'unknown').slice(0, 120),
    updatedAt: String(nowIso || job.updatedAt),
  };
}

/**
 * 読んだ件数と（書いた + 飛ばした）件数が合っているか。
 * **合っていなければ COMPLETED にしない**（黙って取りこぼす経路を作らない）。
 */
export function verifyBalance(job) {
  const read = Number(job?.recordsRead) || 0;
  const accounted = (Number(job?.recordsWritten) || 0) + (Number(job?.recordsSkipped) || 0);
  return { balanced: read === accounted, read, accounted, missing: read - accounted };
}

/** 次の step を実行してよいか。**終わっているジョブを動かさない**。 */
export function canStep(job) {
  if (!job) return { ok: false, reason: 'not_started' };
  if (job.version !== MODEL_VERSION) return { ok: false, reason: 'version_mismatch' };
  if (job.status === JOB_STATUS.COMPLETED) return { ok: false, reason: 'already_completed' };
  if (job.status === JOB_STATUS.FAILED) return { ok: false, reason: 'failed_needs_restart' };
  return { ok: true, reason: null };
}

/**
 * Airtable が「その offset はもう使えない」と言ってきたか。
 * 文字列一致で拾い、**分からないものは失効扱いにしない**（本物のエラーを隠さない）。
 */
export function isExpiredCursorError(err) {
  const s = String(err && (err.type || err.message || err) || '');
  return /LIST_RECORDS_ITERATOR_NOT_AVAILABLE|iterator.*not.*available/i.test(s);
}

/** 応答に載せてよい形（**PII・鍵・cursor 実値を出さない**） */
export function toPublicJob(job) {
  if (!job) return null;
  return {
    jobType: job.jobType,
    status: job.status,
    chunkSize: job.chunkSize,
    steps: job.steps,
    pagesRead: job.pagesRead,
    recordsRead: job.recordsRead,
    recordsWritten: job.recordsWritten,
    recordsSkipped: job.recordsSkipped,
    batchesWritten: job.batchesWritten,
    cursorResets: job.cursorResets,
    // cursor そのものは返さない（Airtable の内部トークン）
    hasCursor: Boolean(job.cursor),
    balance: verifyBalance(job),
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    lastError: job.lastError,
  };
}
