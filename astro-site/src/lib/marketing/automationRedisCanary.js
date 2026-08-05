/**
 * automationRedisCanary.js — 自動化 Redis primitive の canary（純粋・I/O は注入）
 *
 * ⚠️ **本番の自動化キーには構造的に触れない。**
 *    書き込み・削除してよいのは `ak:marketing-automation:canary:<canaryId>:` 配下と
 *    墓標 `ak:marketing-automation:canary-run:<canaryId>` だけ。
 *    禁止: `def:` / `run:` / `recipient:` / `index:active` / `lock:` / `fence` /
 *          `payemail:*` / `customer-import:*` / KMA 系。
 *
 * ⚠️ **Airtable に触れない。メールを送らない。Customers を参照しない。**（依存が無い）
 * ⚠️ 実アドレス・氏名・顧客 ID を使わない。`example.invalid` の固定ダミーだけ。
 * ⚠️ URL / token / Redis の値 / hash 全文を返さない。`KEYS` は禁止、`SCAN` は canary prefix のみ。
 */

import { createHash } from 'node:crypto';
import { AUTO_ROOT, CAS_LUA, RELEASE_LUA, VERIFY_LUA } from './automationCanaryContracts.js';

/** canary の名前空間 */
export const CANARY_ROOT = `${AUTO_ROOT}canary:`;
/** 実行済み墓標（**別 prefix**。cleanup では消さず finalize でだけ消す） */
export const CANARY_MARKER_ROOT = `${AUTO_ROOT}canary-run:`;

/** 触れてはいけない本番キー（guard の説明用） */
export const PROTECTED_PREFIXES = Object.freeze([
  `${AUTO_ROOT}def:`, `${AUTO_ROOT}run:`, `${AUTO_ROOT}recipient:`,
  `${AUTO_ROOT}index:active`, `${AUTO_ROOT}lock:`, `${AUTO_ROOT}fence`,
  'payemail:', 'customer-import:', 'kma:', 'tenant:',
]);

/** 上限（固定） */
export const MAX_CANARY_KEYS = 24;
export const MAX_REDIS_COMMANDS = 120;
export const CANARY_TTL_SEC = 900;          // 15 分。cleanup 漏れでも自動消滅
export const MARKER_TTL_SEC = 86400;        // 24 時間

export class CanaryGuardError extends Error {
  constructor(code, detail) {
    super(`mkauto_canary:${code}`);
    this.name = 'CanaryGuardError';
    this.code = code; this.detail = detail || null;
  }
}

export const CANARY_STOP = Object.freeze({
  OUT_OF_NAMESPACE: 'out_of_namespace',
  KEY_LIMIT: 'key_limit',
  COMMAND_LIMIT: 'command_limit',
  FULL_SCAN_FORBIDDEN: 'full_scan_forbidden',
  ALREADY_RUN: 'already_run',
  CONFIRMATION_MISMATCH: 'confirmation_mismatch',
  UNKNOWN_RESULT: 'unknown_result',
  UNREACHABLE: 'unreachable',
});

const MUTATING = new Set(['SET', 'DEL', 'INCR', 'EXPIRE']);
const READ_KEYED = new Set(['GET', 'EXISTS', 'TTL']);
const KEYLESS = new Set(['PING', 'DBSIZE']);

const str = (v) => String(v ?? '').trim();
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

export function buildCanaryId({ nowIso, randomHex }) {
  const stamp = str(nowIso).replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = str(randomHex).replace(/[^a-f0-9]/gi, '').slice(0, 8).toLowerCase();
  return (stamp.length === 14 && rand.length === 8) ? `${stamp}-${rand}` : '';
}
export const isValidCanaryId = (id) => /^\d{14}-[a-f0-9]{8}$/.test(str(id));
export const canaryPrefix = (id) => `${CANARY_ROOT}${str(id)}:`;
export const dataPrefix = (id) => `${canaryPrefix(id)}d:`;
export const markerKey = (id) => `${CANARY_MARKER_ROOT}${str(id)}`;
export const buildRunConfirmation = (id) => `MKAUTO-CANARY ${str(id)}`;
export const buildFinalizeConfirmation = (id) => `MKAUTO-CANARY-FINALIZE ${str(id)}`;

/** ダミーの受信者 hash（**実アドレスを使わない**） */
export const dummyEmailHash = (n) =>
  createHash('sha256').update(`canary-${int(n)}@example.invalid`, 'utf8').digest('hex');

/**
 * 予算つき・名前空間つきの実行器。
 */
export function createCanaryRunner({ cmd, canaryId, maxKeys, maxCommands } = {}) {
  if (typeof cmd !== 'function') throw new Error('createCanaryRunner: cmd が必要です');
  if (!isValidCanaryId(canaryId)) throw new CanaryGuardError(CANARY_STOP.OUT_OF_NAMESPACE, 'bad_canary_id');

  const prefix = canaryPrefix(canaryId);
  const marker = markerKey(canaryId);
  const keyLimit = Number.isFinite(maxKeys) ? maxKeys : MAX_CANARY_KEYS;
  const cmdLimit = Number.isFinite(maxCommands) ? maxCommands : MAX_REDIS_COMMANDS;
  const state = { commands: 0, keysTouched: new Set(), latencies: [] };

  /** canary prefix 配下、または墓標キー**完全一致**のみ許可 */
  const assertKey = (key) => {
    const k = str(key);
    if (k === marker) return k;
    if (!k.startsWith(prefix)) throw new CanaryGuardError(CANARY_STOP.OUT_OF_NAMESPACE, k.slice(0, 48));
    return k;
  };

  const run = async (args) => {
    const op = String(args[0] || '').toUpperCase();
    if (op === 'KEYS') throw new CanaryGuardError(CANARY_STOP.FULL_SCAN_FORBIDDEN, 'KEYS');
    if (['FLUSHALL', 'FLUSHDB', 'SCRIPT', 'CONFIG'].includes(op)) {
      throw new CanaryGuardError(CANARY_STOP.OUT_OF_NAMESPACE, op);
    }
    if (op === 'SCAN') {
      const mi = args.findIndex((a) => String(a).toUpperCase() === 'MATCH');
      const pattern = mi > -1 ? str(args[mi + 1]) : '';
      if (!pattern.startsWith(prefix)) throw new CanaryGuardError(CANARY_STOP.FULL_SCAN_FORBIDDEN, 'scan_pattern');
    } else if (op === 'EVAL') {
      const n = Number(args[2]);
      if (!Number.isFinite(n) || n < 0) throw new CanaryGuardError(CANARY_STOP.UNKNOWN_RESULT, 'eval_numkeys');
      for (const k of args.slice(3, 3 + n)) { assertKey(k); state.keysTouched.add(str(k)); }
    } else if (MUTATING.has(op) || READ_KEYED.has(op)) {
      assertKey(args[1]);
      if (MUTATING.has(op)) state.keysTouched.add(str(args[1]));
    } else if (!KEYLESS.has(op)) {
      throw new CanaryGuardError(CANARY_STOP.OUT_OF_NAMESPACE, `unsupported_op:${op}`);
    }

    if (state.keysTouched.size > keyLimit) throw new CanaryGuardError(CANARY_STOP.KEY_LIMIT, String(state.keysTouched.size));
    state.commands += 1;
    if (state.commands > cmdLimit) throw new CanaryGuardError(CANARY_STOP.COMMAND_LIMIT, String(state.commands));

    const t0 = Date.now();
    let res;
    try { res = await cmd(args); }
    catch (e) { throw new CanaryGuardError(CANARY_STOP.UNREACHABLE, e && e.message); }
    const ms = Date.now() - t0;
    state.latencies.push(ms);
    if (res === undefined) throw new CanaryGuardError(CANARY_STOP.UNKNOWN_RESULT, op);
    return { result: res, ms };
  };

  return {
    prefix, dataPrefix: dataPrefix(canaryId), rootPrefix: prefix, markerKey: marker,
    state, assertKey, run,
    dkey: (name) => `${dataPrefix(canaryId)}${name}`,
    stats: () => ({
      commands: state.commands, keysTouched: state.keysTouched.size,
      maxKeys: keyLimit, maxCommands: cmdLimit,
      latencyMs: state.latencies.length ? {
        min: Math.min(...state.latencies), max: Math.max(...state.latencies),
        avg: Math.round(state.latencies.reduce((a, b) => a + b, 0) / state.latencies.length),
      } : null,
    }),
  };
}

/** Phase 0（read-only。**write しない**） */
export async function runPhase0(runner) {
  const checks = [];
  const add = (n, ok, d) => checks.push({ name: n, ok, detail: d ?? null });
  const ping = await runner.run(['PING']);
  add('PING', ping.result === 'PONG', `${ping.ms}ms`);
  const size = await runner.run(['DBSIZE']);
  add('DBSIZE（参考値のみ）', Number.isFinite(Number(size.result)), `${size.ms}ms`);
  const ev = await runner.run(['EVAL', 'return 1', '0']);
  add('EVAL return 1', Number(ev.result) === 1, `${ev.ms}ms`);
  return { checks, ok: checks.every((c) => c.ok), dbsize: Number(size.result) };
}

/** Phase 1（canary 名前空間だけ） */
export async function runPhase1({ runner, now }) {
  const checks = [];
  const add = (n, ok, d) => checks.push({ name: n, ok, detail: d ?? null });
  const ttl = String(CANARY_TTL_SEC);
  const nowIso = new Date(now).toISOString();

  const LOCK = runner.dkey('lock');
  const FENCE = runner.dkey('fence');
  const DEF = runner.dkey('def');
  const RUN = runner.dkey('run');
  const REC = runner.dkey(`recipient:${dummyEmailHash(1)}`);
  const GONE = runner.dkey('absent');

  // 1. SET NX による排他
  const w1 = await runner.run(['SET', LOCK, 'tokenA', 'NX', 'EX', ttl]);
  const w2 = await runner.run(['SET', LOCK, 'tokenB', 'NX', 'EX', ttl]);
  add('1. SET NX の勝者は 1 つだけ', w1.result === 'OK' && w2.result === null);

  // 2. fencing token 単調増加
  const f1 = await runner.run(['INCR', FENCE]);
  await runner.run(['EXPIRE', FENCE, ttl]);
  const f2 = await runner.run(['INCR', FENCE]);
  add('2. fencing token が単調増加', Number(f2.result) > Number(f1.result));

  // 3. Definition CAS 相当（**PR #237 と同一の Lua**）
  const v1 = JSON.stringify({ automationId: 'canary', configVersion: 1 });
  const c0 = await runner.run(['EVAL', CAS_LUA, '1', DEF, v1, '']);
  add('3a. 未作成キーは新規作成できる', c0.result === 'OK');
  const v2 = JSON.stringify({ automationId: 'canary', configVersion: 2 });
  const c1 = await runner.run(['EVAL', CAS_LUA, '1', DEF, v2, '1']);
  add('3b. version 一致なら更新できる', c1.result === 'OK');
  const c2 = await runner.run(['EVAL', CAS_LUA, '1', DEF, v2, '1']);
  add('3c. version 不一致は CONFLICT で拒否', c2.result === 'CONFLICT');

  // 4. 所有権の再検証（stale owner 拒否）
  const ok1 = await runner.run(['EVAL', VERIFY_LUA, '1', LOCK, 'tokenA']);
  add('4a. 正当な所有者は OK', ok1.result === 'OK');
  const st = await runner.run(['EVAL', VERIFY_LUA, '1', LOCK, 'tokenB']);
  add('4b. 別 token は STOLEN', st.result === 'STOLEN');
  const lost = await runner.run(['EVAL', VERIFY_LUA, '1', GONE, 'tokenA']);
  add('4c. キーが無ければ LOST', lost.result === 'LOST');
  const relNo = await runner.run(['EVAL', RELEASE_LUA, '1', LOCK, 'tokenB']);
  add('4d. 他人の token では解放できない', relNo.result === 'STOLEN');

  // 5. run の二重開始拒否（SET NX）
  const r1 = await runner.run(['SET', RUN, 'planned', 'NX', 'EX', ttl]);
  const r2 = await runner.run(['SET', RUN, 'planned', 'NX', 'EX', ttl]);
  add('5. 同一 runId の二重開始を拒否', r1.result === 'OK' && r2.result === null);

  // 6. recipient claim の二重取得拒否（hash のみ）
  const p1 = await runner.run(['SET', REC, '1', 'NX', 'EX', ttl]);
  const p2 = await runner.run(['SET', REC, '1', 'NX', 'EX', ttl]);
  add('6. 同一 recipient の二重 claim を拒否', p1.result === 'OK' && p2.result === null);
  add('6b. 受信者キーは復元不能な hash', REC.includes('@') === false);

  add('7. 実行時刻は記録用のみ（PII なし）', typeof nowIso === 'string');
  return { checks, ok: checks.every((c) => c.ok) };
}

/** canary データキーを **SCAN で数えるだけ**（削除しない） */
export async function scanCanaryKeys(runner) {
  const found = []; let cursor = '0'; let guard = 0;
  do {
    const res = await runner.run(['SCAN', cursor, 'MATCH', `${runner.rootPrefix}*`, 'COUNT', '100']);
    const [next, keys] = res.result || ['0', []];
    cursor = String(next);
    for (const k of (keys || [])) found.push(k);
    guard += 1;
  } while (cursor !== '0' && guard < 50);
  return found;
}

/** データだけ削除（**墓標は残す**＝再実行は塞がれたまま） */
export async function cleanupCanary(runner) {
  const found = await scanCanaryKeys(runner);
  let deleted = 0;
  for (const k of found) { runner.assertKey(k); await runner.run(['DEL', k]); deleted += 1; }
  const left = await scanCanaryKeys(runner);
  return {
    found: found.length, deleted, remaining: left.length,
    remainingSuffixes: left.map((k) => String(k).slice(runner.rootPrefix.length)).slice(0, 20),
    markerRetained: true,
  };
}

/** 最後の後始末。**墓標も消す**。データが残っていれば消さない */
export async function finalizeCanary(runner) {
  const clean = await cleanupCanary(runner);
  if (clean.remaining > 0) return { finalized: false, reason: 'data_remaining', cleanup: clean };
  runner.assertKey(runner.markerKey);
  await runner.run(['DEL', runner.markerKey]);
  const still = Number((await runner.run(['EXISTS', runner.markerKey])).result) === 1;
  const left = await scanCanaryKeys(runner);
  return {
    finalized: !still && left.length === 0,
    markerRemaining: still ? 1 : 0, rootRemaining: left.length, cleanup: clean,
  };
}

export default createCanaryRunner;
