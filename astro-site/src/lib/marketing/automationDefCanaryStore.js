/**
 * automationDefCanaryStore.js — Definition 保存 canary の**最小ストア**（I/O は注入）
 *
 * ── 何のためのファイルか ──────────────────────────────────────
 * `ak:marketing-automation:def:*` と `index:active` という**本番のキー空間**へ、
 * canary 専用 Definition を 1 件だけ作って一連の操作（get / CAS 更新 / pause /
 * cancel / index 追加・除去 / 削除）を確かめる。管理 UI・scheduler・enqueue・
 * Airtable 処理・メール送信は**持ち込まない**。
 *
 * ⚠️ 中身は自動化本体（PR #237 の `automationStore.js`）から**改変せず抜き出したもの**。
 *    `EXPECTED_CAS_SHA256` が抽出時点の実装と一致することをテストが固定する。
 *
 * ── 触ってよいキーを canary の 1 件へ絞る（重要）──────────────
 * `def:` は本番と同じ名前空間なので、**automationId が `canary-<canaryId>` の
 * ものだけ**を許可する。他の Definition・`run:` / `recipient:` / `lock:` / `fence` /
 * `payemail:` / `customer-import:` / KMA は**構造的に拒否**する。
 *
 * `index:active` は**共有キー**。SADD / SREM は **canary の member 1 つだけ**を
 * 対象にし、実行前後で**他の member が変わっていないこと**を突き合わせる。
 */

import { createHash } from 'node:crypto';

export const AUTO_ROOT = 'ak:marketing-automation:';
export const defKey = (automationId) => `${AUTO_ROOT}def:${automationId}`;
export const ACTIVE_INDEX_KEY = `${AUTO_ROOT}index:active`;
/** canary 専用 Definition の automationId。**この形以外は触らない** */
export const canaryAutomationId = (canaryId) => `canary-${canaryId}`;
/**
 * run 結果の保存先。**`def:` の外**の canary 専用 prefix。
 * HTTP 応答を取り逃しても PASS/FAIL を復元できるようにするためだけに存在する。
 */
export const resultKey = (canaryId) => `${AUTO_ROOT}def-canary:${canaryId}:result`;
export const RESULT_SCHEMA_VERSION = 1;
export const RESULT_TTL_SEC = 86400;

export const DEF_FIELDS = Object.freeze([
  'automationId', 'presetId', 'name', 'status', 'campaignId', 'campaignVersion',
  'schedule', 'timezone', 'quietHours', 'maxRecipients', 'trigger', 'audience',
  'createdAt', 'updatedAt', 'configVersion', 'lastRunAt', 'nextRunAt',
  // 保存時に固定するキャンペーンの版・本文（ACTIVE 化時の drift 検知に使う）
  'shellVersion', 'contentHash', 'snapshotFingerprint',
]);

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

/** 抽出時点の PR #237 実装の sha256 */
export const EXPECTED_CAS_SHA256 = 'e07dc3cf2b1e7c14541b3a6173179d06f88cdd691b191114a365abdd6383cf27';
export const CAS_LUA = `
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
export function luaSha256(t) { return createHash('sha256').update(String(t), 'utf8').digest('hex'); }

export class DefCanaryError extends Error {
  constructor(code, detail) {
    super(`def_canary:${code}`);
    this.name = 'DefCanaryError';
    this.code = code; this.detail = detail || null;
  }
}
export const DEF_FAIL = Object.freeze({
  OUT_OF_NAMESPACE: 'out_of_namespace',
  UNREACHABLE: 'unreachable',
  UNKNOWN_RESULT: 'unknown_result',
  CAS_CONFLICT: 'cas_conflict',
  DATA_CORRUPT: 'data_corrupt',
  PII_DETECTED: 'pii_detected',
  INDEX_CHANGED: 'index_changed',
  RESULT_UNAVAILABLE: 'result_unavailable',
  RESULT_INVALID: 'result_invalid',
  RESULT_SCHEMA_MISMATCH: 'result_schema_mismatch',
});

/**
 * 保存してよい run 結果か。**URL / token / Redis 値 / アドレス / hash 全文 / stack を入れない。**
 * 入っていたら保存を止める（fail-closed）。
 */
export function assertResultSafe(obj) {
  const walk = (v) => {
    if (typeof v === 'string') {
      if (/@[a-z0-9.-]+\.[a-z]{2,}/i.test(v)) return false;      // アドレス
      if (/https?:\/\//i.test(v)) return false;                   // URL
      if (/\bBearer\b/i.test(v)) return false;                    // token
      if (v.includes(AUTO_ROOT) || v.includes('upstash')) return false; // キー・接続先
      if (/^[a-f0-9]{32,}$/i.test(v)) return false;               // hash 全文
      if (/\n\s+at /.test(v)) return false;                       // stack
      return true;
    }
    if (Array.isArray(v)) return v.every(walk);
    if (v && typeof v === 'object') return Object.values(v).every(walk);
    return true;
  };
  return walk(obj);
}

/** 復元した結果が「その run のもの」として使えるか（PASS 扱いにしてよいか） */
export function validateResult(raw, { canaryId } = {}) {
  if (raw === null || raw === undefined) return { ok: false, reason: DEF_FAIL.RESULT_UNAVAILABLE };
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return { ok: false, reason: DEF_FAIL.RESULT_INVALID }; }
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: DEF_FAIL.RESULT_INVALID };
  if (parsed.schemaVersion !== RESULT_SCHEMA_VERSION) {
    return { ok: false, reason: DEF_FAIL.RESULT_SCHEMA_MISMATCH };
  }
  if (!Array.isArray(parsed.checks) || parsed.checks.length === 0
      || typeof parsed.overallOk !== 'boolean') {
    return { ok: false, reason: DEF_FAIL.RESULT_INVALID };
  }
  if (canaryId && parsed.canaryIdSuffix !== String(canaryId).slice(-8)) {
    return { ok: false, reason: DEF_FAIL.RESULT_INVALID };
  }
  if (!assertResultSafe(parsed)) return { ok: false, reason: DEF_FAIL.RESULT_INVALID };
  return { ok: true, result: parsed };
}

/** HTTP 応答・保存結果・ログ行が**同じ run の同じ判定**かを突き合わせる */
export function compareResultPaths(a, b) {
  const norm = (r) => (r && Array.isArray(r.checks))
    ? { overallOk: r.overallOk === true, checks: r.checks.map((c) => `${c.name}=${c.ok === true}`) }
    : null;
  const x = norm(a); const y = norm(b);
  if (!x || !y) return { same: false, reason: 'missing' };
  if (x.checks.length !== y.checks.length) return { same: false, reason: 'count' };
  const diff = x.checks.filter((c, i) => c !== y.checks[i]);
  if (diff.length) return { same: false, reason: 'mismatch', count: diff.length };
  return { same: x.overallOk === y.overallOk, reason: x.overallOk === y.overallOk ? null : 'overall' };
}

const pick = (obj, allow) => {
  const out = {};
  for (const k of allow) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
};

/**
 * canary 用ストア。**触ってよいのは canary の def 1 件と index:active だけ**。
 * @param {{ cmd, canaryId }} deps
 */
export function createDefCanaryStore({ cmd, canaryId } = {}) {
  if (typeof cmd !== 'function') throw new Error('createDefCanaryStore: cmd が必要です');
  if (!/^\d{14}-[a-f0-9]{8}$/.test(String(canaryId ?? ''))) {
    throw new DefCanaryError(DEF_FAIL.OUT_OF_NAMESPACE, 'bad_canary_id');
  }
  const autoId = canaryAutomationId(canaryId);
  const myDefKey = defKey(autoId);
  const myResultKey = resultKey(canaryId);
  const state = { commands: 0, keysTouched: new Set(), latencies: [] };

  /** canary の def キー / index キー / canary 結果キー以外は拒否 */
  const assertKey = (key) => {
    const k = String(key ?? '');
    if (k === myDefKey || k === ACTIVE_INDEX_KEY || k === myResultKey) return k;
    throw new DefCanaryError(DEF_FAIL.OUT_OF_NAMESPACE, k.slice(0, 48));
  };
  /** index の member は canary の 1 つだけ */
  const assertMember = (m) => {
    if (String(m ?? '') !== autoId) throw new DefCanaryError(DEF_FAIL.OUT_OF_NAMESPACE, 'member');
    return m;
  };

  const call = async (args, failCode) => {
    const op = String(args[0] || '').toUpperCase();
    if (['GET', 'SET', 'DEL', 'EXISTS'].includes(op)) assertKey(args[1]);
    if (['SADD', 'SREM'].includes(op)) { assertKey(args[1]); assertMember(args[2]); }
    if (op === 'SMEMBERS') assertKey(args[1]);
    if (op === 'EVAL') {
      const n = Number(args[2]);
      for (const k of args.slice(3, 3 + (Number.isFinite(n) ? n : 0))) assertKey(k);
    }
    if (!['GET', 'SET', 'DEL', 'EXISTS', 'SADD', 'SREM', 'SMEMBERS', 'EVAL'].includes(op)) {
      throw new DefCanaryError(DEF_FAIL.OUT_OF_NAMESPACE, `unsupported_op:${op}`);
    }
    state.keysTouched.add(String(args[1] ?? ''));
    state.commands += 1;
    const t0 = Date.now();
    let res;
    try { res = await cmd(args); }
    catch (e) { throw new DefCanaryError(failCode || DEF_FAIL.UNREACHABLE, e && e.message); }
    state.latencies.push(Date.now() - t0);
    if (res === undefined) throw new DefCanaryError(DEF_FAIL.UNKNOWN_RESULT, op);
    return res;
  };

  return {
    automationId: autoId, defKey: myDefKey, indexKey: ACTIVE_INDEX_KEY,
    resultKey: myResultKey, state, assertKey,

    async load() {
      const raw = await call(['GET', myDefKey], DEF_FAIL.DATA_CORRUPT);
      if (raw === null) return null;
      try { return JSON.parse(raw); }
      catch { throw new DefCanaryError(DEF_FAIL.DATA_CORRUPT, 'definition'); }
    },

    /** version 付き CAS（**PR #237 と同じ Lua**） */
    async save({ definition, expectedVersion }) {
      const d = pick(definition, DEF_FIELDS);
      if (!assertNoPii(d)) throw new DefCanaryError(DEF_FAIL.PII_DETECTED, 'definition');
      const next = { ...d, configVersion: Number(d.configVersion) || 1 };
      const res = await call(['EVAL', CAS_LUA, '1', myDefKey, JSON.stringify(next), String(expectedVersion ?? '')],
        DEF_FAIL.CAS_CONFLICT);
      if (res === 'OK') return { ok: true, definition: next };
      if (res === 'CONFLICT') return { ok: false, reason: 'cas_conflict' };
      if (res === 'MISSING') return { ok: false, reason: 'missing' };
      throw new DefCanaryError(DEF_FAIL.UNKNOWN_RESULT, String(res));
    },

    async del() { await call(['DEL', myDefKey]); },
    async exists() { return Number(await call(['EXISTS', myDefKey])) === 1; },

    /** run 結果を保存（**取り逃し対策の 2 経路目**）。PII・URL・token が混ざれば保存しない */
    async saveResult(summary) {
      if (!assertResultSafe(summary)) throw new DefCanaryError(DEF_FAIL.PII_DETECTED, 'result');
      await call(['SET', myResultKey, JSON.stringify(summary), 'EX', String(RESULT_TTL_SEC)]);
    },
    /** 保存済み結果を復元。無い / 壊れている / schema 違いは **PASS 扱いにしない** */
    async loadResult() {
      const raw = await call(['GET', myResultKey], DEF_FAIL.DATA_CORRUPT);
      return validateResult(raw, { canaryId });
    },
    async delResult() { await call(['DEL', myResultKey]); },
    async resultExists() { return Number(await call(['EXISTS', myResultKey])) === 1; },

    async indexMembers() {
      const raw = await call(['SMEMBERS', ACTIVE_INDEX_KEY]);
      return Array.isArray(raw) ? raw : [];
    },
    async indexAdd() { await call(['SADD', ACTIVE_INDEX_KEY, autoId]); },
    async indexRemove() { await call(['SREM', ACTIVE_INDEX_KEY, autoId]); },

    stats: () => ({
      commands: state.commands, keysTouched: state.keysTouched.size,
      latencyMs: state.latencies.length ? {
        min: Math.min(...state.latencies), max: Math.max(...state.latencies),
        avg: Math.round(state.latencies.reduce((a, b) => a + b, 0) / state.latencies.length),
      } : null,
    }),
  };
}

/**
 * `index:active` の他 member が変わっていないか。
 * canary の member を除いた集合が**実行前と一致**していなければ異常。
 */
export function compareIndexExcludingCanary({ before, after, canaryMember }) {
  const strip = (a) => [...new Set((a || []).filter((m) => m !== canaryMember))].sort();
  const b = strip(before); const c = strip(after);
  return { same: b.join('|') === c.join('|'), beforeCount: b.length, afterCount: c.length };
}

export default createDefCanaryStore;
