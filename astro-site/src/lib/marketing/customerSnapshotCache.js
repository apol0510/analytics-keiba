/**
 * customerSnapshotCache.js — Customers の**軽い写し**を Redis に置く（I/O は注入）
 *
 * ── なぜ要るか（C-2）─────────────────────────────────────────
 * dry-run と ACTIVE 化は Customers を**全件・逐次**取っていた。本番実測で
 * 1,678 件（17 ページ）で 3.5〜7.6 秒。Netlify の同期 Function は既定 10 秒なので、
 * **約 4,000 件でタイムアウト域**、外部取り込み後の 15,800 件では 30〜70 秒で確実に失敗する。
 * `activate` も同じ経路で再計算するため、**自動化を一切操作できなくなる**。
 *
 * そこで **全件走査を同期 Function から追い出す**:
 *   - 走査は **Background Function**（15 分まで）が行い、結果を Redis へ chunk 保存
 *   - dry-run / ACTIVE 化 / prospect の照合は **Redis から読むだけ**（件数に依らず速い）
 *   - 写しが**無い / 古い**ときは **fail-closed で 503**（古い対象で送らせない）
 *
 * ── 何を保存するか ────────────────────────────────────────────
 * 判定に要る最小限だけ。**アドレスは正規化して保存する**（照合に要るため。
 * `ak:customer-snapshot:` 配下に閉じ、一覧 API には出さない）。
 *
 *   ak:customer-snapshot:meta          … { builtAt, count, chunks, fingerprint, source }
 *   ak:customer-snapshot:emails:<i>    … 正規化アドレスの配列（1 chunk = 最大 CHUNK_SIZE 件）
 *
 * ⚠️ 書き込みは **1 度に全部差し替える**のではなく、
 *    新しい世代を書き終えてから meta を更新する（読み手が半端な写しを見ない）。
 */

import { createHash } from 'node:crypto';

export const SNAPSHOT_ROOT = 'ak:customer-snapshot:';
export const META_KEY = `${SNAPSHOT_ROOT}meta`;
export const chunkKey = (gen, i) => `${SNAPSHOT_ROOT}emails:${gen}:${i}`;

/** 1 chunk あたりの件数。**Upstash の 1 値サイズに収まる範囲** */
export const CHUNK_SIZE = 2000;
/** 写しの寿命。これを過ぎたら「古い」とみなす（既定 6 時間） */
export const SNAPSHOT_MAX_AGE_SEC = 6 * 3600;
/** chunk 自体の TTL（世代が入れ替わっても取り残さない） */
export const CHUNK_TTL_SEC = 48 * 3600;

export const SNAPSHOT_FAIL = Object.freeze({
  MISSING: 'snapshot_missing',
  STALE: 'snapshot_stale',
  CORRUPT: 'snapshot_corrupt',
  OUT_OF_NAMESPACE: 'out_of_namespace',
  UNREACHABLE: 'snapshot_unreachable',
});

export class SnapshotError extends Error {
  constructor(code, detail) {
    super(`customer_snapshot:${code}`);
    this.name = 'SnapshotError';
    this.code = code; this.detail = detail || null;
  }
}

const norm = (v) => String(v ?? '').trim().toLowerCase();

/** 写しの指紋（件数と中身が同じなら同じ） */
export function computeSnapshotFingerprint(emails) {
  const sorted = [...new Set((emails || []).map(norm).filter(Boolean))].sort();
  return createHash('sha256')
    .update(`${sorted.length}::${sorted.join('|')}`, 'utf8').digest('hex');
}

/** アドレス配列を chunk へ割る */
export function buildChunks(emails, size) {
  const n = Number(size) || CHUNK_SIZE;
  const list = [...new Set((emails || []).map(norm).filter(Boolean))].sort();
  const chunks = [];
  for (let i = 0; i < list.length; i += n) chunks.push(list.slice(i, i + n));
  return { chunks, count: list.length };
}

/** 写しが使えるか。**無い / 古い / 壊れている**は使わせない */
export function evaluateSnapshot({ meta, nowMs, maxAgeSec }) {
  if (!meta || typeof meta !== 'object') return { ok: false, reason: SNAPSHOT_FAIL.MISSING };
  const builtAt = Date.parse(meta.builtAt);
  if (!Number.isFinite(builtAt)) return { ok: false, reason: SNAPSHOT_FAIL.CORRUPT };
  if (!Number.isInteger(meta.count) || !Number.isInteger(meta.chunks)) {
    return { ok: false, reason: SNAPSHOT_FAIL.CORRUPT };
  }
  const age = Math.round((Number(nowMs) - builtAt) / 1000);
  const limit = Number(maxAgeSec) || SNAPSHOT_MAX_AGE_SEC;
  if (age > limit) return { ok: false, reason: SNAPSHOT_FAIL.STALE, 経過秒: age, 上限秒: limit };
  return { ok: true, 経過秒: age, 件数: meta.count };
}

/**
 * @param {{ cmd: (args: string[]) => Promise<any> }} deps
 */
export function createSnapshotStore({ cmd } = {}) {
  if (typeof cmd !== 'function') throw new Error('createSnapshotStore: cmd が必要です');

  const assertKey = (key) => {
    const k = String(key ?? '');
    if (!k.startsWith(SNAPSHOT_ROOT)) throw new SnapshotError(SNAPSHOT_FAIL.OUT_OF_NAMESPACE, k.slice(0, 48));
    return k;
  };
  const OPS = ['GET', 'SET', 'DEL', 'MGET', 'EXISTS'];
  const call = async (args) => {
    const op = String(args[0] || '').toUpperCase();
    if (!OPS.includes(op)) throw new SnapshotError(SNAPSHOT_FAIL.OUT_OF_NAMESPACE, `unsupported_op:${op}`);
    if (op === 'MGET') for (const k of args.slice(1)) assertKey(k);
    else assertKey(args[1]);
    let res;
    try { res = await cmd(args); }
    catch (e) { throw new SnapshotError(SNAPSHOT_FAIL.UNREACHABLE, e && e.message); }
    if (res === undefined) throw new SnapshotError(SNAPSHOT_FAIL.UNREACHABLE, op);
    return res;
  };
  const parse = (raw) => {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); } catch { throw new SnapshotError(SNAPSHOT_FAIL.CORRUPT, 'json'); }
  };

  return {
    assertKey,

    async loadMeta() { return parse(await call(['GET', META_KEY])); },

    /**
     * アドレス集合を読む。**meta が古ければ読まない**（古い対象で送らせない）。
     * @returns {Promise<Set<string>>}
     */
    async loadEmailSet({ nowMs, maxAgeSec } = {}) {
      const meta = await this.loadMeta();
      const v = evaluateSnapshot({ meta, nowMs: Number(nowMs) || Date.now(), maxAgeSec });
      if (!v.ok) throw new SnapshotError(v.reason, JSON.stringify(v));
      const keys = [];
      for (let i = 0; i < meta.chunks; i += 1) keys.push(chunkKey(meta.generation, i));
      const set = new Set();
      // MGET は 1 回 50 キーまでに分ける（1 chunk 2,000 件なので 10 万件でも 50 キー）
      for (let i = 0; i < keys.length; i += 50) {
        const raw = await call(['MGET', ...keys.slice(i, i + 50)]);
        if (!Array.isArray(raw)) throw new SnapshotError(SNAPSHOT_FAIL.CORRUPT, 'mget');
        for (const r of raw) {
          const arr = parse(r);
          if (!Array.isArray(arr)) throw new SnapshotError(SNAPSHOT_FAIL.CORRUPT, 'chunk');
          for (const e of arr) set.add(norm(e));
        }
      }
      if (set.size !== meta.count) {
        throw new SnapshotError(SNAPSHOT_FAIL.CORRUPT, `count ${set.size} != ${meta.count}`);
      }
      return set;
    },

    /**
     * 新しい世代を書いてから meta を差し替える。
     * **半端な写しを読ませない**ため、meta の更新は最後。
     */
    async save({ emails, nowMs, generation, source }) {
      const { chunks, count } = buildChunks(emails);
      const gen = String(generation || Number(nowMs) || Date.now());
      for (let i = 0; i < chunks.length; i += 1) {
        await call(['SET', chunkKey(gen, i), JSON.stringify(chunks[i]), 'EX', String(CHUNK_TTL_SEC)]);
      }
      const meta = {
        builtAt: new Date(Number(nowMs) || Date.now()).toISOString(),
        count, chunks: chunks.length, generation: gen,
        fingerprint: computeSnapshotFingerprint(emails),
        source: String(source || 'background'),
      };
      await call(['SET', META_KEY, JSON.stringify(meta)]);
      return meta;
    },
  };
}

export default createSnapshotStore;
