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
/**
 * run の墓標。**`SET NX` で 1 回しか取れない**ことで run exactly 1 を構造保証する。
 * `cleanup` では消さず、env を閉じた後の `finalize` でだけ消す。
 * → 「墓標が無いのに run できる時間帯」を作らない。
 */
export const runMarkKey = (canaryId) => `${AUTO_ROOT}def-canary:${canaryId}:run`;
export const RUN_MARK_TTL_SEC = 86400;

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
  INDEX_UNAVAILABLE: 'index_unavailable',
  ALREADY_RUN: 'already_run',
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

/**
 * check 配列を正規化する。**`{name, ok}` の配列であること**を要求し、
 * 空・要素の型違い・**重複した check 名**は受理しない（順序は保つ）。
 */
export function normalizeCheckList(list) {
  if (!Array.isArray(list) || list.length === 0) return { ok: false, reason: 'missing_checks' };
  const checks = []; const seen = new Set();
  for (const c of list) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) return { ok: false, reason: 'invalid_check' };
    if (typeof c.name !== 'string' || c.name.trim() === '') return { ok: false, reason: 'invalid_check' };
    if (typeof c.ok !== 'boolean') return { ok: false, reason: 'invalid_check' };
    if (seen.has(c.name)) return { ok: false, reason: 'duplicate_check_name', detail: c.name };
    seen.add(c.name);
    checks.push({ name: c.name, ok: c.ok });
  }
  return { ok: true, checks };
}

/**
 * 3 経路（Redis 保存結果 / HTTP 応答 / Function ログ）の**完全一致**を検証する。
 *
 * ⚠️ **boolean と件数だけの照合は禁止。** 件数・**順序**・`name`・`ok`・`overallOk` の
 *   すべてが一致した場合にのみ `ok:true`。1 つでも違えば不一致として扱う。
 * ⚠️ 欠落（配列でない / 空）・**重複した check 名**も不一致として扱う。
 *
 * @param {{stored, paths: Array<{label, overallOk, checks}>}} args
 */
export function verifyThreePaths({ stored, paths } = {}) {
  const s = normalizeCheckList(stored && stored.checks);
  if (!s.ok) return { ok: false, reason: s.reason, path: 'stored', detail: s.detail || null };
  if (typeof (stored && stored.overallOk) !== 'boolean') {
    return { ok: false, reason: 'invalid_overall_ok', path: 'stored', detail: null };
  }
  if (!Array.isArray(paths) || paths.length === 0) {
    return { ok: false, reason: 'missing_checks', path: 'input', detail: null };
  }

  for (const p of paths) {
    const label = (p && p.label) || 'unknown';
    if (typeof (p && p.overallOk) !== 'boolean') {
      return { ok: false, reason: 'invalid_overall_ok', path: label, detail: null };
    }
    const n = normalizeCheckList(p.checks);
    if (!n.ok) return { ok: false, reason: n.reason, path: label, detail: n.detail || null };

    if (n.checks.length !== s.checks.length) {
      return {
        ok: false, reason: 'check_count_mismatch', path: label,
        detail: `${n.checks.length} != ${s.checks.length}`,
      };
    }
    // 件数が同じでも、**順序 / name / ok** が 1 つでも違えば不一致
    for (let i = 0; i < s.checks.length; i += 1) {
      if (n.checks[i].name !== s.checks[i].name) {
        return { ok: false, reason: 'check_name_mismatch', path: label, detail: `index ${i}` };
      }
      if (n.checks[i].ok !== s.checks[i].ok) {
        return { ok: false, reason: 'check_ok_mismatch', path: label, detail: `index ${i}` };
      }
    }
    if (p.overallOk !== stored.overallOk) {
      return { ok: false, reason: 'overall_ok_mismatch', path: label, detail: null };
    }
  }
  return {
    ok: true, reason: null, path: null, detail: null,
    checkCount: s.checks.length, overallOk: stored.overallOk,
    comparedPaths: paths.map((p) => p.label),
  };
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
  const myRunMarkKey = runMarkKey(canaryId);
  const state = { commands: 0, keysTouched: new Set(), latencies: [] };

  /** canary の def キー / index キー / canary 結果キー / canary 墓標キー以外は拒否 */
  const assertKey = (key) => {
    const k = String(key ?? '');
    if (k === myDefKey || k === ACTIVE_INDEX_KEY || k === myResultKey || k === myRunMarkKey) return k;
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
    resultKey: myResultKey, runMarkKey: myRunMarkKey, state, assertKey,

    /**
     * run の権利を **1 回だけ** 取る（`SET NX`）。
     * 取れなければ `false` = 既に run 済み。**Definition を消しても再 run できない。**
     */
    async claimRun(stamp) {
      const res = await call(['SET', myRunMarkKey, String(stamp ?? '1'), 'NX', 'EX', String(RUN_MARK_TTL_SEC)]);
      if (res === 'OK' || (res && res.result === 'OK')) return true;
      if (res === null) return false;      // NX 失敗 = 既に存在する
      throw new DefCanaryError(DEF_FAIL.UNKNOWN_RESULT, 'claim_run');
    },
    async runMarkExists() { return Number(await call(['EXISTS', myRunMarkKey])) === 1; },
    /** 墓標の削除は **env を閉じた後の finalize でのみ**呼ぶ */
    async delRunMark() { await call(['DEL', myRunMarkKey]); },

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

    /**
     * `index:active` の member 一覧。
     * ⚠️ **配列でない / 文字列以外が混ざる応答は fail-closed**。
     * 空配列（member 0 件）は正常。空を `[]` へ丸めて握りつぶさない。
     */
    async indexMembers() {
      const raw = await call(['SMEMBERS', ACTIVE_INDEX_KEY], DEF_FAIL.INDEX_UNAVAILABLE);
      if (!Array.isArray(raw)) throw new DefCanaryError(DEF_FAIL.INDEX_UNAVAILABLE, 'not_array');
      if (raw.some((m) => typeof m !== 'string')) {
        throw new DefCanaryError(DEF_FAIL.INDEX_UNAVAILABLE, 'non_string_member');
      }
      return raw;
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
 * `index:active` の canary 以外の member が**実行前後で完全一致**しているか。
 *
 * ⚠️ **既存 member が 0 件でも複数件でも同じ厳密さで比較する**（空だから安全、とはしない）。
 *   件数一致ではなく**集合そのものの一致**を見る。1 つでも増減・入替があれば `same=false`。
 * ⚠️ before / after が配列でなければ `same=false`（fail-closed）。
 */
export function compareIndexExcludingCanary({ before, after, canaryMember }) {
  if (!Array.isArray(before) || !Array.isArray(after)) {
    return { same: false, reason: DEF_FAIL.INDEX_UNAVAILABLE, beforeCount: null, afterCount: null,
      addedCount: null, removedCount: null };
  }
  const strip = (a) => new Set(a.filter((m) => m !== canaryMember).map(String));
  const b = strip(before); const c = strip(after);
  const removed = [...b].filter((m) => !c.has(m));
  const added = [...c].filter((m) => !b.has(m));
  const same = removed.length === 0 && added.length === 0;
  return {
    same, reason: same ? null : DEF_FAIL.INDEX_CHANGED,
    beforeCount: b.size, afterCount: c.size,
    removedCount: removed.length, addedCount: added.length,
  };
}

export default createDefCanaryStore;
