/**
 * importJobAuthority.js — 親 ImportJob の**正本**（Redis / I/O は注入）
 *
 * ── 正本はここ。Airtable でも Blobs でもない ──────────────────
 * `Customers` の `Source` 件数だけでは **snapshot / 失敗 / 未処理 / cancel 境界 /
 * operationId** を復元できない。したがってジョブの状態は Redis に永続化し、
 * Airtable は「実際に作られた行」の確認先（突合の 1 点）として使う。
 *
 * ── PII を保存しない ──────────────────────────────────────────
 * メールは **sha256 のみ**。アドレス・氏名・CSV の中身は 1 バイトも置かない。
 *
 * ── snapshot は chunk 分割 ────────────────────────────────────
 * 14,284 件を単一 JSON に詰めない。`snap:<n>` へ 500 件ずつ順序どおりに置き、
 * `snapshotFingerprint`（全 hash の連結 sha256）で**開始後の差し替えを検知**する。
 */

import { createHash } from 'node:crypto';
import { RedisUnavailableError, REDIS_FAIL } from './importClaimStore.js';

/** snapshot 1 chunk の件数 */
export const SNAPSHOT_CHUNK_SIZE = 500;

/** 決定的な並びの版。**並べ方を変えたら上げる**（cursor の意味が変わるため） */
export const ORDERING_VERSION = 'email-asc-1';

/** ジョブ正本の TTL は付けない（消えたら fail-closed で気づく必要がある） */
export const jobKey = (jobId) => `customer-import:job:${jobId}`;
export const snapKey = (jobId, i) => `customer-import:job:${jobId}:snap:${i}`;
export const snapMetaKey = (jobId) => `customer-import:job:${jobId}:snapmeta`;

const str = (v) => String(v ?? '').trim();
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

/** 順序つき hash 列 → snapshot 指紋（差し替え検知） */
export function computeSnapshotFingerprint(orderedHashes) {
  return createHash('sha256').update((orderedHashes || []).join('|'), 'utf8').digest('hex');
}

/** 正本として永続化する項目（**この形を満たさないものは保存しない**） */
export const REQUIRED_JOB_FIELDS = Object.freeze([
  'jobId', 'batchId', 'source', 'fileFingerprint', 'snapshotFingerprint',
  'plannedTotal', 'orderingVersion', 'cursor',
  'attempted', 'created', 'skippedExisting', 'failed',
  'cancelledAt', 'status', 'currentChild', 'fencingToken', 'operationId',
  'childHistory', 'reconciliation', 'createdAt', 'updatedAt',
]);

/** PII が混ざっていないか（構造的な最後の砦） */
const PII_KEYS = ['email', 'emails', 'name', 'names', '氏名', 'rows', 'contentBase64', 'csv', 'address'];
export function assertNoPii(obj) {
  const seen = new Set();
  const walk = (v) => {
    if (!v || typeof v !== 'object') return true;
    if (seen.has(v)) return true;
    seen.add(v);
    for (const [k, val] of Object.entries(v)) {
      if (PII_KEYS.includes(k)) return false;
      if (!walk(val)) return false;
    }
    return true;
  };
  return walk(obj);
}

/** 正本のひな形。**欠けている項目があれば保存を拒否する** */
export function buildJobRecord({
  jobId, batchId, source, fileFingerprint, snapshotFingerprint,
  plannedTotal, fencingToken, operationId, nowIso,
}) {
  return {
    jobId: str(jobId),
    batchId: str(batchId),
    source: str(source),
    fileFingerprint: str(fileFingerprint),
    snapshotFingerprint: str(snapshotFingerprint),
    plannedTotal: int(plannedTotal),
    orderingVersion: ORDERING_VERSION,
    cursor: 0,
    attempted: 0,
    created: 0,
    skippedExisting: 0,
    failed: 0,
    cancelledAt: null,
    status: 'PLANNED',
    currentChild: null,
    fencingToken: str(fencingToken),
    operationId: str(operationId),
    childHistory: [],
    reconciliation: null,
    createdAt: str(nowIso),
    updatedAt: str(nowIso),
  };
}

export function validateJobRecord(job) {
  if (!job || typeof job !== 'object') return { ok: false, missing: ['(record)'] };
  const missing = REQUIRED_JOB_FIELDS.filter((f) => !(f in job));
  if (missing.length) return { ok: false, missing };
  if (!assertNoPii(job)) return { ok: false, missing: ['(pii detected)'] };
  return { ok: true, missing: [] };
}

/**
 * @param {{ cmd: (args: string[]) => Promise<any> }} deps
 */
export function createJobAuthority(deps = {}) {
  const cmd = deps.cmd;
  if (typeof cmd !== 'function') throw new Error('importJobAuthority: cmd が渡されていません');

  const call = async (args, failCode) => {
    let res;
    try { res = await cmd(args); }
    catch (e) { throw new RedisUnavailableError(failCode || REDIS_FAIL.UNREACHABLE, e && e.message); }
    if (res === undefined) throw new RedisUnavailableError(REDIS_FAIL.UNKNOWN_RESULT, args[0]);
    return res;
  };

  return {
    /** 正本を読む。**読めなければ fail-closed**（黙って新規扱いにしない） */
    async load(jobId) {
      const raw = await call(['GET', jobKey(jobId)], REDIS_FAIL.JOB_UNREADABLE);
      if (raw === null) return null;
      let job;
      try { job = JSON.parse(raw); }
      catch { throw new RedisUnavailableError(REDIS_FAIL.JOB_UNREADABLE, 'parse'); }
      const v = validateJobRecord(job);
      if (!v.ok) throw new RedisUnavailableError(REDIS_FAIL.DATA_LOSS_SUSPECTED, v.missing.join(','));
      return job;
    },

    /** 新規作成（NX）。すでにあれば作らない */
    async create(job) {
      const v = validateJobRecord(job);
      if (!v.ok) return { created: false, reason: 'invalid_job', missing: v.missing };
      const res = await call(['SET', jobKey(job.jobId), JSON.stringify(job), 'NX'], REDIS_FAIL.JOB_UNREADABLE);
      if (res === 'OK') return { created: true, reason: null };
      if (res === null) return { created: false, reason: 'job_exists' };
      throw new RedisUnavailableError(REDIS_FAIL.UNKNOWN_RESULT, String(res));
    },

    async save(job) {
      const v = validateJobRecord(job);
      if (!v.ok) return { ok: false, reason: 'invalid_job', missing: v.missing };
      await call(['SET', jobKey(job.jobId), JSON.stringify(job)], REDIS_FAIL.JOB_UNREADABLE);
      return { ok: true, reason: null };
    },

    /**
     * snapshot を chunk 分割して固定する。**開始時に 1 度だけ。**
     * @param {string[]} orderedHashes 決定的に並べた sha256 の列
     */
    async writeSnapshot({ jobId, orderedHashes }) {
      const list = orderedHashes || [];
      const chunks = Math.ceil(list.length / SNAPSHOT_CHUNK_SIZE);
      for (let i = 0; i < chunks; i += 1) {
        const part = list.slice(i * SNAPSHOT_CHUNK_SIZE, (i + 1) * SNAPSHOT_CHUNK_SIZE);
        await call(['SET', snapKey(jobId, i), JSON.stringify(part)], REDIS_FAIL.UNREACHABLE);
      }
      const meta = {
        total: list.length, chunks, chunkSize: SNAPSHOT_CHUNK_SIZE,
        orderingVersion: ORDERING_VERSION,
        snapshotFingerprint: computeSnapshotFingerprint(list),
      };
      await call(['SET', snapMetaKey(jobId), JSON.stringify(meta)], REDIS_FAIL.UNREACHABLE);
      return meta;
    },

    async readSnapshotMeta(jobId) {
      const raw = await call(['GET', snapMetaKey(jobId)], REDIS_FAIL.DATA_LOSS_SUSPECTED);
      if (raw === null) throw new RedisUnavailableError(REDIS_FAIL.DATA_LOSS_SUSPECTED, 'snapmeta_missing');
      try { return JSON.parse(raw); }
      catch { throw new RedisUnavailableError(REDIS_FAIL.DATA_LOSS_SUSPECTED, 'snapmeta_parse'); }
    },

    /** snapshot を全部読んで復元する（欠けていたら fail-closed） */
    async readSnapshot(jobId) {
      const meta = await this.readSnapshotMeta(jobId);
      const out = [];
      for (let i = 0; i < meta.chunks; i += 1) {
        const raw = await call(['GET', snapKey(jobId, i)], REDIS_FAIL.DATA_LOSS_SUSPECTED);
        if (raw === null) throw new RedisUnavailableError(REDIS_FAIL.DATA_LOSS_SUSPECTED, `snap_${i}_missing`);
        let part;
        try { part = JSON.parse(raw); }
        catch { throw new RedisUnavailableError(REDIS_FAIL.DATA_LOSS_SUSPECTED, `snap_${i}_parse`); }
        out.push(...part);
      }
      if (out.length !== meta.total) {
        throw new RedisUnavailableError(REDIS_FAIL.DATA_LOSS_SUSPECTED, 'snapshot_length_mismatch');
      }
      if (computeSnapshotFingerprint(out) !== meta.snapshotFingerprint) {
        throw new RedisUnavailableError(REDIS_FAIL.DATA_LOSS_SUSPECTED, 'snapshot_fingerprint_mismatch');
      }
      return { hashes: out, meta };
    },

    /**
     * 実行中に「開始時の snapshot と今の CSV が一致するか」を検証する。
     * 不一致なら**進めない**（CSV 差し替え・順序変更の検知）。
     */
    async verifySnapshot({ jobId, currentOrderedHashes }) {
      const meta = await this.readSnapshotMeta(jobId);
      const now = computeSnapshotFingerprint(currentOrderedHashes || []);
      if (meta.orderingVersion !== ORDERING_VERSION) {
        return { ok: false, reason: 'ordering_version_changed' };
      }
      if (now !== meta.snapshotFingerprint) return { ok: false, reason: 'snapshot_changed' };
      return { ok: true, reason: null };
    },
  };
}

export default createJobAuthority;
