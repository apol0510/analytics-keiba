/**
 * automationStore.js — 自動化の**永続化**（Redis / I/O は注入）
 *
 * ── AK 専用の名前空間 ─────────────────────────────────────────
 * すべて `ak:marketing-automation:` 配下。**他の用途の鍵空間へ触れない**:
 *   - KMA（別ブランド基盤）
 *   - `payemail:*`（入金確認メール v2）
 *   - `customer-import:*`（顧客取り込み）
 * prefix 外の read/write は `assertKey` が**構造的に拒否**する。
 *
 * ── PII を保存しない ──────────────────────────────────────────
 * アドレス・氏名・CSV の中身は 1 バイトも置かない。受信者は
 * **正規化メールの sha256** だけを鍵に使い、値は状態と件数のみ。
 *
 * ── 正本の範囲（重要）────────────────────────────────────────
 *   Redis が正本 … 自動化の**設定と進行**（Definition / Run / claim / lock）
 *   Airtable が正本 … **送信の事実**（ScheduledEmails / CampaignDeliveries / EmailEvents）
 * 「送ったかどうか」を Redis で判断しない。Redis が消えても
 * **送信済みの事実は Airtable に残る**ので、二重送信の最終防壁は
 * `CampaignDeliveries.DeliveryKey` の冪等 upsert 側にある。
 *
 * ── Redis が信用できないときは fail-closed ────────────────────
 * 到達不能 / 応答不明 / CAS 不一致 / lock 状態不明 は例外にして**必ず伝播**させる。
 * 握りつぶして「新規実行」に倒さない。
 */

import { createHash } from 'node:crypto';

/** AK 専用の名前空間。ここから外れた鍵は触らない */
export const AUTO_ROOT = 'ak:marketing-automation:';

/** 他用途の鍵空間（**絶対に触れない**。guard の説明用） */
export const FOREIGN_PREFIXES = Object.freeze([
  'payemail:', 'customer-import:', 'kma:', 'tenant:',
]);

export const autoKey = Object.freeze({
  def: (automationId) => `${AUTO_ROOT}def:${automationId}`,
  run: (runId) => `${AUTO_ROOT}run:${runId}`,
  lock: (automationId) => `${AUTO_ROOT}lock:${automationId}`,
  recipient: (runId, emailHash) => `${AUTO_ROOT}recipient:${runId}:${emailHash}`,
  activeIndex: () => `${AUTO_ROOT}index:active`,
  fence: () => `${AUTO_ROOT}fence`,
});

/** 正規化メール → sha256（**復元不能**。これ以外を鍵に使わない） */
export function emailHash(email) {
  const e = String(email ?? '').trim().toLowerCase();
  return e ? createHash('sha256').update(e, 'utf8').digest('hex') : '';
}

export class AutomationStoreError extends Error {
  constructor(code, detail) {
    super(`automation_store:${code}`);
    this.name = 'AutomationStoreError';
    this.code = code;
    this.detail = detail || null;
  }
}

export const STORE_FAIL = Object.freeze({
  UNREACHABLE: 'unreachable',
  UNKNOWN_RESULT: 'unknown_result',
  OUT_OF_NAMESPACE: 'out_of_namespace',
  CAS_CONFLICT: 'cas_conflict',
  LOCK_STATE_UNKNOWN: 'lock_state_unknown',
  DATA_CORRUPT: 'data_corrupt',
  PII_DETECTED: 'pii_detected',
});

/** lock の既定 TTL（1 回の scheduler 実行 + 余裕） */
export const LOCK_TTL_SEC = 300;
/** recipient claim の TTL（配信回が終われば不要になる） */
export const CLAIM_TTL_SEC = 7 * 24 * 3600;

/** Definition に保存してよい項目（**PII を持ち込ませない**） */
export const DEF_FIELDS = Object.freeze([
  'automationId', 'presetId', 'name', 'status', 'campaignId', 'campaignVersion',
  'schedule', 'timezone', 'quietHours', 'maxRecipients', 'trigger', 'audience',
  'createdAt', 'updatedAt', 'configVersion', 'lastRunAt', 'nextRunAt',
  // ⚠️ `enabled` は scheduler の `isDue` が見る。**保存しないと ACTIVE でも永久に動かない**
  //    （UI は ACTIVE と表示するのに scheduler は not_active、という食い違いになる）
  'enabled',
  // 保存時に固定するキャンペーンの版・本文（ACTIVE 化時の drift 検知に使う）
  'shellVersion', 'contentHash',
  // ⚠️ dry-run で確定した対象。**指紋と件数は両方保存する**。
  //    件数が無いと `detectDrift` の比較対象が 0 になり、対象が減っても snapshot_grew で常に弾かれる
  'snapshotFingerprint', 'snapshotCount', 'snapshotOccurrenceDate',
]);

/** Run に保存してよい項目 */
export const RUN_FIELDS = Object.freeze([
  'runId', 'automationId', 'operationId', 'status', 'snapshotFingerprint', 'snapshotCount',
  'queued', 'excluded', 'failed', 'startedAt', 'finishedAt', 'configurationVersion',
  'campaignVersion', 'contentHash', 'errorCode', 'reconciliation',
]);

/** PII が混ざっていないか（構造的な最後の砦） */
const PII_KEYS = ['email', 'emails', 'recipients', 'name', '氏名', 'Email', 'address', 'phone', 'Phone'];
export function assertNoPii(obj) {
  const seen = new Set();
  const walk = (v) => {
    if (!v || typeof v !== 'object') return true;
    if (seen.has(v)) return true;
    seen.add(v);
    for (const [k, val] of Object.entries(v)) {
      // `name` は自動化の表示名なので許可するが、`Email` 系は一切許可しない
      if (PII_KEYS.includes(k) && k !== 'name') return false;
      if (typeof val === 'string' && /@[a-z0-9.-]+\.[a-z]{2,}/i.test(val)) return false;
      if (!walk(val)) return false;
    }
    return true;
  };
  return walk(obj);
}

const pick = (obj, allow) => {
  const out = {};
  for (const k of allow) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
};

/**
 * @param {{ cmd: (args: string[]) => Promise<any> }} deps Upstash REST 相当
 */
export function createAutomationStore(deps = {}) {
  const cmd = deps.cmd;
  if (typeof cmd !== 'function') throw new Error('createAutomationStore: cmd が必要です');

  /** AK 専用 prefix の外は触らない */
  const assertKey = (key) => {
    const k = String(key ?? '');
    if (!k.startsWith(AUTO_ROOT)) throw new AutomationStoreError(STORE_FAIL.OUT_OF_NAMESPACE, k.slice(0, 40));
    return k;
  };

  const call = async (args, failCode) => {
    const op = String(args[0] || '').toUpperCase();
    // キーを取るコマンドは必ず prefix 検査を通す
    if (['GET', 'SET', 'DEL', 'INCR', 'EXPIRE', 'EXISTS', 'SADD', 'SREM', 'SMEMBERS'].includes(op)) {
      assertKey(args[1]);
    }
    if (op === 'EVAL') {
      const n = Number(args[2]);
      for (const k of args.slice(3, 3 + (Number.isFinite(n) ? n : 0))) assertKey(k);
    }
    let res;
    try { res = await cmd(args); }
    catch (e) { throw new AutomationStoreError(failCode || STORE_FAIL.UNREACHABLE, e && e.message); }
    if (res === undefined) throw new AutomationStoreError(STORE_FAIL.UNKNOWN_RESULT, op);
    return res;
  };

  /** 自分の値のときだけ書き換える CAS（Lua） */
  const CAS_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then
  if ARGV[2] == '' then redis.call('SET', KEYS[1], ARGV[1]) return 'OK' end
  return 'MISSING'
end
local v = string.match(cur, '"configVersion":(%d+)')
if v ~= ARGV[2] then return 'CONFLICT' end
redis.call('SET', KEYS[1], ARGV[1])
return 'OK'
`;

  /** 自分の token のときだけ解放する */
  const RELEASE_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 'LOST' end
if cur ~= ARGV[1] then return 'STOLEN' end
redis.call('DEL', KEYS[1])
return 'OK'
`;

  const VERIFY_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 'LOST' end
if cur ~= ARGV[1] then return 'STOLEN' end
return 'OK'
`;

  const parse = (raw, what) => {
    if (raw === null) return null;
    try { return JSON.parse(raw); }
    catch { throw new AutomationStoreError(STORE_FAIL.DATA_CORRUPT, what); }
  };

  return {
    assertKey,

    // ── Definition（Redis が正本）──────────────────────────────
    /**
     * ⚠️ `enabled` は **`status` から導出し直す**（正本は `status`）。
     * 保存もしているが、旧レコードや手直しで両者がズレても
     * 「UI は ACTIVE / scheduler は not_active」の食い違いを起こさせない。
     */
    async loadDefinition(automationId) {
      const d = parse(await call(['GET', autoKey.def(automationId)]), 'definition');
      if (!d) return d;
      return { ...d, enabled: d.status === 'ACTIVE' };
    },

    /**
     * version 付き CAS。**取り違えたら書かない**。
     * `expectedVersion` が空文字なら「まだ無いはず」として新規作成する。
     */
    async saveDefinition({ definition, expectedVersion }) {
      const d = pick(definition, DEF_FIELDS);
      if (!assertNoPii(d)) throw new AutomationStoreError(STORE_FAIL.PII_DETECTED, 'definition');
      const next = { ...d, configVersion: Number(d.configVersion) || 1 };
      const res = await call([
        'EVAL', CAS_LUA, '1', autoKey.def(definition.automationId),
        JSON.stringify(next), String(expectedVersion ?? ''),
      ], STORE_FAIL.CAS_CONFLICT);
      if (res === 'OK') return { ok: true, definition: next };
      if (res === 'CONFLICT') throw new AutomationStoreError(STORE_FAIL.CAS_CONFLICT, definition.automationId);
      if (res === 'MISSING') return { ok: false, reason: 'missing' };
      throw new AutomationStoreError(STORE_FAIL.UNKNOWN_RESULT, String(res));
    },

    async listActive() {
      const raw = await call(['SMEMBERS', autoKey.activeIndex()]);
      return Array.isArray(raw) ? raw : [];
    },
    async markActive(automationId) { await call(['SADD', autoKey.activeIndex(), automationId]); },
    async unmarkActive(automationId) { await call(['SREM', autoKey.activeIndex(), automationId]); },

    // ── lock + fencing token（scheduler の claim）──────────────
    async nextFencingToken() {
      const n = await call(['INCR', autoKey.fence()]);
      const v = Number(n);
      if (!Number.isFinite(v) || v <= 0) throw new AutomationStoreError(STORE_FAIL.UNKNOWN_RESULT, 'fence');
      return String(v);
    },

    /** `SET NX EX` で 1 つだけ通す。取れなければ**何もしない** */
    async claim({ automationId, ttlSec }) {
      const token = await this.nextFencingToken();
      const res = await call([
        'SET', autoKey.lock(automationId), token, 'NX', 'EX', String(ttlSec || LOCK_TTL_SEC),
      ], STORE_FAIL.LOCK_STATE_UNKNOWN);
      if (res === 'OK') return { ok: true, token };
      if (res === null) return { ok: false, token: null, reason: 'locked' };
      throw new AutomationStoreError(STORE_FAIL.LOCK_STATE_UNKNOWN, String(res));
    },

    /** enqueue の直前に必ず通す。**失っていたら書かない** */
    async verifyClaim({ automationId, token }) {
      const res = await call(['EVAL', VERIFY_LUA, '1', autoKey.lock(automationId), String(token)],
        STORE_FAIL.LOCK_STATE_UNKNOWN);
      if (res === 'OK') return { ok: true, reason: null };
      if (res === 'LOST' || res === 'STOLEN') return { ok: false, reason: String(res).toLowerCase() };
      throw new AutomationStoreError(STORE_FAIL.LOCK_STATE_UNKNOWN, String(res));
    },

    async releaseClaim({ automationId, token }) {
      const res = await call(['EVAL', RELEASE_LUA, '1', autoKey.lock(automationId), String(token)],
        STORE_FAIL.LOCK_STATE_UNKNOWN);
      return { ok: res === 'OK', reason: res === 'OK' ? null : String(res).toLowerCase() };
    },

    // ── Run（Redis が正本：進行状況）──────────────────────────
    async loadRun(runId) {
      return parse(await call(['GET', autoKey.run(runId)]), 'run');
    },

    /** 同一 runId の**二重開始を atomic に拒否**する */
    async createRun(run) {
      const r = pick(run, RUN_FIELDS);
      if (!assertNoPii(r)) throw new AutomationStoreError(STORE_FAIL.PII_DETECTED, 'run');
      const res = await call(['SET', autoKey.run(run.runId), JSON.stringify(r), 'NX'],
        STORE_FAIL.UNKNOWN_RESULT);
      if (res === 'OK') return { created: true, run: r };
      if (res === null) return { created: false, reason: 'duplicate_run' };
      throw new AutomationStoreError(STORE_FAIL.UNKNOWN_RESULT, String(res));
    },

    async saveRun(run) {
      const r = pick(run, RUN_FIELDS);
      if (!assertNoPii(r)) throw new AutomationStoreError(STORE_FAIL.PII_DETECTED, 'run');
      await call(['SET', autoKey.run(run.runId), JSON.stringify(r)]);
      return { ok: true };
    },

    // ── recipient claim（同一 run で 1 人 1 回）────────────────
    /**
     * `runId + 正規化メールの sha256` で一意。**アドレスは保存しない**。
     * @returns {{ won: string[], taken: string[] }} 返すのは **hash** のみ
     */
    async claimRecipients({ runId, emails, ttlSec }) {
      const won = []; const taken = [];
      for (const e of (emails || [])) {
        const h = emailHash(e);
        if (!h) { taken.push(''); continue; }
        const res = await call([
          'SET', autoKey.recipient(runId, h), '1', 'NX', 'EX', String(ttlSec || CLAIM_TTL_SEC),
        ], STORE_FAIL.UNKNOWN_RESULT);
        if (res === 'OK') won.push(h);
        else if (res === null) taken.push(h);
        else throw new AutomationStoreError(STORE_FAIL.UNKNOWN_RESULT, String(res));
      }
      return { won, taken };
    },

    async isRecipientClaimed({ runId, email }) {
      const h = emailHash(email);
      if (!h) return false;
      return Number(await call(['EXISTS', autoKey.recipient(runId, h)])) === 1;
    },
  };
}

export default createAutomationStore;
