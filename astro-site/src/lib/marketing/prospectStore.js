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
 *   - 抑止・打ち切りの後は **`purge()` で生アドレスごと削除できる**
 *     （復活防止は hash だけの永続台帳が担う）
 * という制約を課す。他の名前空間へアドレスを書くことは従来どおり禁止。
 *
 * ── キー ──────────────────────────────────────────────────────
 *   ak:prospect:p:<sha256(email)>    … prospect 1 件（**配信中だけ**アドレスを持つ）
 *   ak:prospect:index:active         … 送信候補の集合（member は sha256）
 *   ak:prospect:index:engaged        … 反応済み・未昇格の集合（昇格待ち行列）
 *   ak:prospect:blocked:<sha256>     … **永続抑止台帳**（除外・打ち切り。TTL なし・アドレスなし）
 *   ak:prospect:index:blocked        … 抑止済みの hash 集合（取り込み時の照合用）
 *
 * ── ⚠️ 抑止台帳は消さない ─────────────────────────────────────
 * 除外（bounce / 苦情 / 配信停止）と打ち切り（無反応 N 回）は **TTL を付けない**。
 * 消えると **CSV を再取り込みしたときに配信対象として復活してしまう**。
 * 台帳が持つのは `sha256(email)` と理由・日時だけで、**生アドレスは持たない**。
 * 生アドレスを持つのは `ak:prospect:p:` の**配信中のレコードだけ**で、
 * 抑止・打ち切りの後は `purge()` で**削除してよい**（台帳が残るので復活しない）。
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

/** 抑止の種別（台帳に残る理由） */
export const BLOCK_KIND = Object.freeze({ SUPPRESSED: 'suppressed', EXHAUSTED: 'exhausted' });

export const emailHash = (email) =>
  createHash('sha256').update(normalizeEmail(email), 'utf8').digest('hex');

export const prospectKey = (hash) => `${PROSPECT_ROOT}p:${hash}`;
export const blockedKey = (hash) => `${PROSPECT_ROOT}blocked:${hash}`;
/**
 * 昇格の取り合い防止。**`SET NX` で 1 つだけ通す**ので、
 * 自動昇格と管理画面の手動昇格が同時に走っても Customers を二重に作らない。
 */
export const promoLockKey = (hash) => `${PROSPECT_ROOT}promo-lock:${hash}`;
export const PROMO_LOCK_TTL_SEC = 300;
export const BLOCKED_INDEX = `${PROSPECT_ROOT}index:blocked`;

/** 抑止台帳に保存してよい項目。**アドレスを含めない** */
export const BLOCKED_FIELDS = Object.freeze(['hash', 'kind', 'reason', 'at', 'sends', 'source']);

/** 保存してよい項目（**これ以外は 1 つも書かない**） */
export const PROSPECT_FIELDS = Object.freeze([
  'email', 'state', 'sends', 'lastSentAt', 'lastRunId',
  'engagedAt', 'engagedKind', 'promotedAt', 'promotedRecordId', 'suppressedAt', 'suppressedReason',
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

/**
 * ⚠️ **prospect レコードに TTL は付けない。**
 * 以前は EXHAUSTED / SUPPRESSED を TTL で消していたが、消えると
 * **CSV 再取り込みで配信対象として復活する**。抑止は台帳（TTL なし）が担い、
 * レコード側は `purge()` で明示的に消す（そのとき生アドレスも消える）。
 */
export function ttlForState() { return null; }

/** その状態は抑止台帳へ載せるべきか */
export function blockKindForState(state) {
  if (state === PROSPECT_STATE.SUPPRESSED) return BLOCK_KIND.SUPPRESSED;
  if (state === PROSPECT_STATE.EXHAUSTED) return BLOCK_KIND.EXHAUSTED;
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

  const OPS = ['GET', 'SET', 'DEL', 'EXISTS', 'SADD', 'SREM', 'SMEMBERS', 'SCARD', 'MGET', 'SISMEMBER'];
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

  /** 抑止台帳へ載せる（**TTL なし・アドレスなし**・冪等） */
  const block = async (hash, { kind, reason, at, sends }) => {
    const entry = pick({ hash, kind, reason, at, sends, source: 'prospect' }, BLOCKED_FIELDS);
    await call(['SET', blockedKey(hash), JSON.stringify(entry)]);
    await call(['SADD', BLOCKED_INDEX, hash]);
    return entry;
  };

  const write = async (hash, next) => {
    const d = pick(next, PROSPECT_FIELDS);
    // ⚠️ TTL は付けない（消えると再取り込みで復活する）
    await call(['SET', prospectKey(hash), JSON.stringify(d)]);
    await syncIndexes(hash, d);
    // 抑止・打ち切りに入ったら**必ず台帳へ**（レコードを消しても残る）
    const kind = blockKindForState(d.state);
    if (kind) {
      await block(hash, {
        kind,
        reason: d.suppressedReason || (kind === BLOCK_KIND.EXHAUSTED ? 'no_engagement' : 'unknown'),
        at: d.suppressedAt || d.lastSentAt || new Date().toISOString(),
        sends: d.sends,
      });
    }
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

    /**
     * 新規追加。**既にあれば上書きしない**（送信回数・除外を消さないため）。
     * ⚠️ **抑止台帳に載っている相手は復活させない**（CSV 再取り込みでも戻らない）。
     */
    async addIfAbsent(prospect) {
      const hash = emailHash(prospect.email);
      if (await this.isBlocked(hash)) return { added: false, blocked: true, prospect: null };
      const cur = await this.loadByHash(hash);
      if (cur) return { added: false, prospect: cur };
      const saved = await write(hash, prospect);
      return { added: true, prospect: saved };
    },

    /** 抑止台帳に載っているか（hash で照合。アドレスは要らない） */
    async isBlocked(hash) {
      return Number(await call(['EXISTS', blockedKey(hash)])) === 1;
    },
    async loadBlocked(hash) {
      return parse(await call(['GET', blockedKey(hash)], STORE_FAIL.DATA_CORRUPT));
    },
    async blockedHashes() {
      const raw = await call(['SMEMBERS', BLOCKED_INDEX], STORE_FAIL.INDEX_UNAVAILABLE);
      if (!Array.isArray(raw)) throw new ProspectStoreError(STORE_FAIL.INDEX_UNAVAILABLE, 'not_array');
      return raw.map(String);
    },

    /**
     * 抑止・打ち切り済みの prospect レコードを消す（**生アドレスを消す**）。
     * 台帳は残るので、以後の取り込みでも復活しない。
     */
    async purge(hash) {
      if (!(await this.isBlocked(hash))) return { purged: false, reason: 'not_blocked' };
      await call(['DEL', prospectKey(hash)]);
      await call(['SREM', ACTIVE_INDEX, hash]);
      await call(['SREM', ENGAGED_INDEX, hash]);
      return { purged: true };
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

    /**
     * ⚠️ **Airtable への作成が成功した後にだけ**呼ぶ。
     * 失敗したら ENGAGED のままにして次回に持ち越す（作られていないのに
     * PROMOTED にすると、その相手は二度と登録されない）。
     */
    async recordPromotion({ email, nowMs, recordId }) {
      const hash = emailHash(email);
      const cur = await this.loadByHash(hash);
      if (!cur) return { ok: false, reason: 'not_found' };
      const next = applyPromotion({ prospect: cur, nowMs });
      if (recordId) next.promotedRecordId = String(recordId);
      return { ok: true, prospect: await write(hash, next) };
    },

    /** 昇格の権利を 1 つだけ取る（自動と手動の二重登録を防ぐ） */
    async claimPromotion(hash, ttlSec) {
      const res = await call([
        'SET', promoLockKey(hash), '1', 'NX', 'EX', String(ttlSec || PROMO_LOCK_TTL_SEC),
      ]);
      if (res === 'OK') return true;
      if (res === null) return false;
      throw new ProspectStoreError(STORE_FAIL.UNKNOWN_RESULT, 'claim_promotion');
    },
    async releasePromotionClaim(hash) { await call(['DEL', promoLockKey(hash)]); },

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
      const n = async (k) => {
        const v = Number(await call(['SCARD', k], STORE_FAIL.INDEX_UNAVAILABLE));
        return Number.isFinite(v) ? v : 0;
      };
      return {
        送信候補: await n(ACTIVE_INDEX),
        反応済み未登録: await n(ENGAGED_INDEX),
        永久除外: await n(BLOCKED_INDEX),
      };
    },

    stats: () => ({ commands: state.commands, keysTouched: state.keysTouched.size }),
  };
}

/** CSV 行から prospect を組み立てる（policy を再エクスポートせず明示的に使う） */
export { buildProspect };

export default createProspectStore;
