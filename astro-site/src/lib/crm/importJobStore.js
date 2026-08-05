/**
 * importJobStore.js — 親ジョブの保存先（**I/O は注入・純粋にテスト可能**）
 *
 * ⚠️ **ここは正本ではない。** Netlify Blobs は同一キー競合が last-write-wins で、
 *    `onlyIfNew` / `onlyIfMatch` も best-effort でしかない
 *    （premium-plus canary #13 で実 lost-update を確認・`docs/PREMIUM_PLUS_STORAGE_DESIGN.md`）。
 *    そのため本モジュールが保証するのは「進捗の記録と再開の目印」までで、
 *    **二重作成を防ぐ責任は持たない**。それは Customers 側のアドレス実在判定が担う。
 *
 * ── 置くもの / 置かないもの ────────────────────────────────────
 *   置く:   jobId / ImportBatchId / Source / 件数 / cursor / 子バッチの結果 / 状態
 *   置かない: **アドレス・氏名・CSV の中身**（PII は 1 バイトも保存しない）
 */

const str = (v) => String(v ?? '').trim();

/** ジョブを入れる store 名 */
export const JOB_STORE_NAME = 'customer-import-jobs';

/** 一覧のインデックスキー（最新ジョブを画面から引くため） */
export const JOB_INDEX_KEY = 'index';

/** Blobs へ入れる前に PII が混ざっていないか確かめる（構造的な最後の砦） */
const PII_KEYS = ['email', 'emails', 'name', 'names', '氏名', 'rows', 'contentBase64', 'csv'];

export function assertNoPii(job) {
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
  return walk(job);
}

/**
 * ジョブ保存の入出力。`deps` に Blobs 相当を渡す。
 *
 * @param {{
 *   getJSON: (key: string) => Promise<any>,
 *   setJSON: (key: string, value: any) => Promise<void>,
 *   setJSONIfNew?: (key: string, value: any) => Promise<{ modified: boolean }>,
 * }} deps
 */
export function createImportJobStore(deps = {}) {
  const getJSON = deps.getJSON;
  const setJSON = deps.setJSON;
  const setJSONIfNew = deps.setJSONIfNew;

  if (typeof getJSON !== 'function' || typeof setJSON !== 'function') {
    throw new Error('importJobStore: getJSON / setJSON が渡されていません');
  }

  return {
    async load(jobId) {
      const key = str(jobId);
      if (!key) return null;
      return (await getJSON(key)) || null;
    },

    /**
     * 新規作成。**すでにあれば作らない**（best-effort。保証ではない）。
     * @returns {{ created: boolean, job: object|null, reason: string|null }}
     */
    async create(job) {
      if (!job || !str(job.jobId)) return { created: false, job: null, reason: 'invalid_job' };
      if (!assertNoPii(job)) return { created: false, job: null, reason: 'pii_detected' };

      const existing = await getJSON(job.jobId);
      if (existing) return { created: false, job: existing, reason: 'job_exists' };

      if (typeof setJSONIfNew === 'function') {
        const res = await setJSONIfNew(job.jobId, job);
        // modified:false = 競合で負けた。**勝者を尊重して上書きしない**
        if (res && res.modified === false) {
          const winner = await getJSON(job.jobId);
          return { created: false, job: winner || null, reason: 'job_exists' };
        }
      } else {
        await setJSON(job.jobId, job);
      }
      await this.addToIndex(job);
      return { created: true, job, reason: null };
    },

    async save(job) {
      if (!job || !str(job.jobId)) return { ok: false, reason: 'invalid_job' };
      // ⚠️ PII が混ざったら保存しない（fail closed）
      if (!assertNoPii(job)) return { ok: false, reason: 'pii_detected' };
      await setJSON(job.jobId, job);
      await this.addToIndex(job);
      return { ok: true, reason: null };
    },

    /** 画面の一覧用。**件数と状態だけ**を持つ軽い索引 */
    async addToIndex(job) {
      const index = (await getJSON(JOB_INDEX_KEY)) || { jobs: [] };
      const rest = (index.jobs || []).filter((j) => j.jobId !== job.jobId);
      rest.unshift({
        jobId: job.jobId,
        batchId: job.batchId,
        source: job.source,
        status: job.status,
        plannedTotal: job.plannedTotal,
        created: job.totals ? job.totals.created : 0,
        updatedAt: job.updatedAt,
      });
      await setJSON(JOB_INDEX_KEY, { jobs: rest.slice(0, 50) });
    },

    async list() {
      const index = (await getJSON(JOB_INDEX_KEY)) || { jobs: [] };
      return index.jobs || [];
    },
  };
}

export default createImportJobStore;
