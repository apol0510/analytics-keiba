/**
 * prospectStore.js — 見込み客プールの保存（Upstash Redis / I/O は注入）
 *
 * ── ⚠️ この名前空間**だけ**はメールアドレスを保存する ────────────
 * AK の Redis は原則 PII を保存しない（`automationStore.js` の `assertNoPii`）。
 * しかし prospect は **送るために本人のアドレスが要る**。Airtable Customers へは
 * 「反応した人だけ」入れる方針なので、反応前のアドレスの置き場が他に無い。
 *
 * そこで **`ak:prospect:` 配下に限って**アドレスの保存を許し、代わりに:
 *   - キーは `sha256(email)`。**キー名からアドレスは復元できない**
 *   - 値の中にだけ平文アドレスを持つ（送信に必要な最小限）
 *   - **一覧 API・ログ・管理画面の集計にアドレスを出さない**（件数と状態だけ）
 *   - 反応が無いまま上限に達したら `EXHAUSTED` にし、**TTL で自動的に消える**
 * という制約を課す。他の名前空間へアドレスを書くことは従来どおり禁止。
 *
 * ── キー ──────────────────────────────────────────────────────
 *   ak:prospect:p:<sha256(email)>   … prospect 1 件（アドレスを含む）
 *   ak:prospect:index:active        … 送信候補の集合（member は sha256）
 *   ak:prospect:index:engaged       … 反応済み・未昇格の集合（昇格待ち行列）
 *   ak:prospect:stats               … 件数の集計（表示用・アドレスなし）
 *
 * ⚠️ `ak:marketing-automation:` / `payemail:` / `customer-import:` / KMA の
 *    名前空間へは**一切触らない**（`assertKey` が構造的に拒否）。
 */

import { createHash } from 'node:crypto';
import {
  PROSPECT_STATE, normalizeEmail, buildProspect,
  applySend, applyEngagement, applySuppression, applyPromotion,
} from './prospectPolicy.js';

export const PROSPECT_ROOT = 'ak:prospect:';
export const ACTIVE_INDEX = `${PROSPECT_ROOT}index:active`;
export const ENGAGED_INDEX = `${PROSPECT_ROOT}index:engaged`;
export const STATS_KEY = `${PROSPECT_ROOT}stats`;

/** 反応が無いまま終わった prospect を残し続けない（JST 1 年） */
export const EXHAUSTED_TTL_SEC = 365 * 24 * 3600;
/** 除外は再取り込みで復活させないため、長めに残す */
export const SUPPRESSED_TTL_SEC = 3 * 365 * 24 * 3600;

export const emailHash = (email) =>
  createHash('sha256').update(normalizeEmail(email), 'utf8').digest('hex');

export const prospectKey = (hash) => `${PROSPECT_ROOT}p:${hash}`;

/** 保存してよい項目（**これ以外は 1 つも書かない**） */
export const PROSPECT_FIELDS = Object.freeze([
  'email', 'state', 'sends', 'lastSentAt', 'lastRunId',
  'engagedAt', 'engagedKind', 'promotedAt', 'suppressedAt', 'suppressedReason',
  'addedAt', 'batchId', 'source',
]);

export class ProspectStoreError extends Error {
  constructor(code, detail) {
    super(`prospect_store:${code}`);
    this.name = 'ProspectStoreError';
    this.code = code; this.detail = detail || null;
  }
}
export const STORE_FAIL = Object.freeze({
  OUT_OF_NAMESPACE: 'out_of_namespace',
  UNREACHABLE: 'unreachable',
  UNKNOWN_RESULT: 'unknown_result',
  DATA_CORRUPT: 'data_corrupt',
  INDEX_UNAVAILABLE: 'index_unavailable',
});

const pick = (obj, allow) => {
  const out = {};
  for (const k of allow) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
};

/** 状態に応じた TTL（ENGAGED / SENDING は消さない） */
export function ttlForState(state) {
  if (state === PROSPECT_STATE.EXHAUSTED) return EXHAUSTED_TTL_SEC;
  if (state === PROSPECT_STATE.SUPPRESSED) return SUPPRESSED_TTL_SEC;
  return null;
}

/**
 * @param {{ cmd: (args: string[]) => Promise<any> }} deps Upstash REST 相当
 */
export function createProspectStore({ cmd } = {}) {
  if (typeof cmd !== 'function') throw new Error('createProspectStore: cmd が必要です');
  const state = { commands: 0, keysTouched: new Set() };

  /** `ak:prospect:` 配下以外は拒否する */
  const assertKey = (key) => {
    const k = String(key ?? '');
    if (!k.startsWith(PROSPECT_ROOT)) throw new ProspectStoreError(STORE_FAIL.OUT_OF_NAMESPACE, k.slice(0, 48));
    return k;
  };

  const OPS = ['GET', 'SET', 'DEL', 'EXISTS', 'SADD', 'SREM', 'SMEMBERS', 'SCARD', 'MGET', 'EXPIRE'];
  const call = async (args, failCode) => {
    const op = String(args[0] || '').toUpperCase();
    if (!OPS.includes(op)) throw new ProspectStoreError(STORE_FAIL.OUT_OF_NAMESPACE, `unsupported_op:${op}`);
    // MGET は複数キーを取るので全部見る
    if (op === 'MGET') for (const k of args.slice(1)) assertKey(k);
    else assertKey(args[1]);
    state.keysTouched.add(String(args[1] ?? ''));
    state.commands += 1;
    let res;
    try { res = await cmd(args); }
    catch (e) { throw new ProspectStoreError(failCode || STORE_FAIL.UNREACHABLE, e && e.message); }
    if (res === undefined) throw new ProspectStoreError(STORE_FAIL.UNKNOWN_RESULT, op);
    return res;
  };

  const parse = (raw) => {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'object') return raw;
    try { return JSON.parse(raw); }
    catch { throw new ProspectStoreError(STORE_FAIL.DATA_CORRUPT, 'prospect'); }
  };

  /** 索引の張り替え。**状態と索引を必ず揃える**（片方だけ残さない） */
  const syncIndexes = async (hash, next) => {
    const sendable = next.state === PROSPECT_STATE.NEW || next.state === PROSPECT_STATE.SENDING;
    const engaged = next.state === PROSPECT_STATE.ENGAGED;
    if (sendable) await call(['SADD', ACTIVE_INDEX, hash]);
    else await call(['SREM', ACTIVE_INDEX, hash]);
    if (engaged) await call(['SADD', ENGAGED_INDEX, hash]);
    else await call(['SREM', ENGAGED_INDEX, hash]);
  };

  const write = async (hash, next) => {
    const d = pick(next, PROSPECT_FIELDS);
    const ttl = ttlForState(d.state);
    const args = ['SET', prospectKey(hash), JSON.stringify(d)];
    if (ttl) { args.push('EX', String(ttl)); }
    await call(args);
    await syncIndexes(hash, d);
    return d;
  };

  return {
    state, assertKey,

    async load(email) {
      return parse(await call(['GET', prospectKey(emailHash(email))], STORE_FAIL.DATA_CORRUPT));
    },
    async loadByHash(hash) {
      return parse(await call(['GET', prospectKey(hash)], STORE_FAIL.DATA_CORRUPT));
    },
    /** まとめ読み。**1 回の MGET で 500 件まで**（超える分は呼び出し側で分ける） */
    async loadMany(hashes) {
      const list = (hashes || []).slice(0, 500);
      if (list.length === 0) return [];
      const raw = await call(['MGET', ...list.map(prospectKey)], STORE_FAIL.DATA_CORRUPT);
      if (!Array.isArray(raw)) throw new ProspectStoreError(STORE_FAIL.DATA_CORRUPT, 'mget');
      return raw.map((r, i) => {
        const p = parse(r);
        return p ? { ...p, hash: list[i] } : null;
      }).filter(Boolean);
    },

    /** 新規追加。**既にあれば上書きしない**（送信回数・除外を消さないため） */
    async addIfAbsent(prospect) {
      const hash = emailHash(prospect.email);
      const cur = await this.loadByHash(hash);
      if (cur) return { added: false, prospect: cur };
      const saved = await write(hash, prospect);
      return { added: true, prospect: saved };
    },

    async recordSend({ email, nowMs, runId, maxSends }) {
      const hash = emailHash(email);
      const cur = await this.loadByHash(hash);
      if (!cur) return { ok: false, reason: 'not_found' };
      const next = applySend({ prospect: cur, nowMs, runId, maxSends });
      return { ok: true, prospect: await write(hash, next) };
    },

    async recordEngagement({ email, nowMs, kind }) {
      const hash = emailHash(email);
      const cur = await this.loadByHash(hash);
      if (!cur) return { ok: false, reason: 'not_found' };
      const r = applyEngagement({ prospect: cur, nowMs, kind });
      if (!r.changed) return { ok: true, changed: false, prospect: cur };
      return { ok: true, changed: true, prospect: await write(hash, r.prospect) };
    },

    async recordSuppression({ email, nowMs, reason }) {
      const hash = emailHash(email);
      const cur = await this.loadByHash(hash);
      if (!cur) return { ok: false, reason: 'not_found' };
      const r = applySuppression({ prospect: cur, nowMs, reason });
      if (!r.changed) return { ok: true, changed: false, prospect: cur };
      return { ok: true, changed: true, prospect: await write(hash, r.prospect) };
    },

    async recordPromotion({ email, nowMs }) {
      const hash = emailHash(email);
      const cur = await this.loadByHash(hash);
      if (!cur) return { ok: false, reason: 'not_found' };
      const next = applyPromotion({ prospect: cur, nowMs });
      return { ok: true, prospect: await write(hash, next) };
    },

    /** 送信候補の hash 一覧。**応答が配列でなければ fail-closed** */
    async activeHashes() {
      const raw = await call(['SMEMBERS', ACTIVE_INDEX], STORE_FAIL.INDEX_UNAVAILABLE);
      if (!Array.isArray(raw)) throw new ProspectStoreError(STORE_FAIL.INDEX_UNAVAILABLE, 'not_array');
      return raw.map(String);
    },
    async engagedHashes() {
      const raw = await call(['SMEMBERS', ENGAGED_INDEX], STORE_FAIL.INDEX_UNAVAILABLE);
      if (!Array.isArray(raw)) throw new ProspectStoreError(STORE_FAIL.INDEX_UNAVAILABLE, 'not_array');
      return raw.map(String);
    },

    /** 表示用の件数。**アドレスを返さない** */
    async counts() {
      const active = Number(await call(['SCARD', ACTIVE_INDEX], STORE_FAIL.INDEX_UNAVAILABLE));
      const engaged = Number(await call(['SCARD', ENGAGED_INDEX], STORE_FAIL.INDEX_UNAVAILABLE));
      return { 送信候補: Number.isFinite(active) ? active : 0, 反応済み未登録: Number.isFinite(engaged) ? engaged : 0 };
    },

    stats: () => ({ commands: state.commands, keysTouched: state.keysTouched.size }),
  };
}

/** CSV 行から prospect を組み立てる（policy を再エクスポートせず明示的に使う） */
export { buildProspect };

export default createProspectStore;
