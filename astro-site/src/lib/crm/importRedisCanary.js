/**
 * importRedisCanary.js — 取り込みジョブ Redis 版の canary（純粋・I/O は注入）
 *
 * ⚠️ **本番キーには構造的に触れない。** 書き込み・削除してよいのは
 *    `customer-import:canary:<canaryId>:` 配下だけ。それ以外は例外で止める。
 *    触れてはいけない代表: `customer-import:lock:global` / `customer-import:fence` /
 *    `customer-import:email:*` / `customer-import:job:*` / `payemail:*`
 *
 * ⚠️ **Airtable に触れない。メールを送らない。** この経路には両方の依存が存在しない。
 * ⚠️ URL / token / Redis の値 / メール / hash 全文を**返さない・記録しない**。
 *
 * ── 事故防止 ──────────────────────────────────────────────────
 *   - canaryId は**サーバー側生成**（利用者が任意の値を指定できない）
 *   - 実行には確認文字列 `REDIS-CANARY <canaryId>` が要る
 *   - **1 つの canaryId につき run はちょうど 1 回**（実行済みマーカーを `SET NX`）
 *   - 最大キー数・最大コマンド数を固定。超えたら即停止
 *   - すべての canary キーに **TTL** を付ける（cleanup 漏れでも自動消滅する）
 *   - 全キー列挙（`KEYS *`）は禁止。走査は `SCAN MATCH <prefix>*` のみ
 */

/** canary の名前空間。ここから外れたら書かない */
export const CANARY_ROOT = 'customer-import:canary:';

/**
 * 実行済み墓標の名前空間。**データとは別の prefix** に置く。
 *
 * ── なぜ分けるか ──────────────────────────────────────────────
 * 「cleanup 後に prefix 残存 0」と「同一 canaryId を再実行させない」を**両立**させるため。
 * 墓標をデータと同じ prefix に置くと、残存 0 にするには墓標も消すことになり、
 * **同じ canaryId を再実行できてしまう**。逆に残すと残存 0 にならない。
 * そこで墓標は別 prefix に置き、
 *   - `cleanup`  … データを消す。**ROOT 残存 0**（墓標は残るので再実行は塞がれたまま）
 *   - `finalize` … 墓標を消す。**最終的に両方 0**（Function 無効化の直前に 1 度だけ）
 * とする。
 */
export const CANARY_MARKER_ROOT = 'customer-import:canary-run:';

/** 1 回の canary で作ってよいキーの上限 */
export const MAX_CANARY_KEYS = 32;

/** 1 回の canary で送ってよい Redis コマンドの上限 */
export const MAX_REDIS_COMMANDS = 150;

/** canary キーの TTL（cleanup 漏れの保険。15 分で自動消滅） */
export const CANARY_TTL_SEC = 900;

/** 実行済みマーカーの TTL（同一 canaryId の再実行を塞ぐ。24 時間） */
export const RUN_MARKER_TTL_SEC = 86400;

/** 触れてはいけない本番キー（guard の説明用。判定は prefix 一致で行う） */
export const PROTECTED_KEYS = Object.freeze([
  'customer-import:lock:global',
  'customer-import:fence',
  'customer-import:email:',
  'customer-import:job:',
  'payemail:',
]);

/** キーを書き換える / 消すコマンド（prefix 検査の対象） */
const MUTATING = new Set([
  'SET', 'SETEX', 'SETNX', 'GETSET', 'GETDEL', 'DEL', 'UNLINK', 'INCR', 'INCRBY',
  'DECR', 'EXPIRE', 'PEXPIRE', 'PERSIST', 'HSET', 'HDEL', 'LPUSH', 'RPUSH', 'SADD', 'SREM',
]);
/** キーを 1 つ取るだけの読み取り */
const READ_KEYED = new Set(['GET', 'TTL', 'PTTL', 'EXISTS', 'TYPE']);
/** キーを取らない読み取り */
const KEYLESS = new Set(['PING', 'DBSIZE']);

export class CanaryGuardError extends Error {
  constructor(code, detail) {
    super(`canary_guard:${code}`);
    this.name = 'CanaryGuardError';
    this.code = code;
    this.detail = detail || null;
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

const str = (v) => String(v ?? '').trim();

/** canaryId を作る（日時 + ランダム）。**サーバー側でのみ呼ぶ** */
export function buildCanaryId({ nowIso, randomHex }) {
  const stamp = str(nowIso).replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = str(randomHex).replace(/[^a-f0-9]/gi, '').slice(0, 8).toLowerCase();
  if (stamp.length !== 14 || rand.length !== 8) return '';
  return `${stamp}-${rand}`;
}

export const canaryPrefix = (canaryId) => `${CANARY_ROOT}${str(canaryId)}:`;
/** 検証データ用（cleanup で消す） */
export const dataPrefix = (canaryId) => `${canaryPrefix(canaryId)}d:`;
/** 実行済み墓標（**別 prefix**。cleanup では消さず、finalize でだけ消す） */
export const runMarkerKey = (canaryId) => `${CANARY_MARKER_ROOT}${str(canaryId)}`;
/** finalize に必要な確認文字列（cleanup とは別の合言葉） */
export const buildFinalizeConfirmation = (canaryId) => `REDIS-CANARY-FINALIZE ${str(canaryId)}`;

/** 実行に必要な確認文字列 */
export const buildCanaryConfirmation = (canaryId) => `REDIS-CANARY ${str(canaryId)}`;

/** canaryId の形が正しいか（利用者が任意文字列を送り込めないようにする） */
export function isValidCanaryId(canaryId) {
  return /^\d{14}-[a-f0-9]{8}$/.test(str(canaryId));
}

/**
 * 予算つき・名前空間つきの Redis 実行器。
 *
 * @param {{ cmd, canaryId, maxKeys?, maxCommands? }} input
 */
export function createCanaryRunner({ cmd, canaryId, maxKeys, maxCommands } = {}) {
  if (typeof cmd !== 'function') throw new Error('createCanaryRunner: cmd が必要です');
  if (!isValidCanaryId(canaryId)) throw new CanaryGuardError(CANARY_STOP.OUT_OF_NAMESPACE, 'bad_canary_id');

  const prefix = canaryPrefix(canaryId);
  const marker = runMarkerKey(canaryId);
  const keyLimit = Number.isFinite(maxKeys) ? maxKeys : MAX_CANARY_KEYS;
  const cmdLimit = Number.isFinite(maxCommands) ? maxCommands : MAX_REDIS_COMMANDS;

  const state = { commands: 0, keysTouched: new Set(), latencies: [] };

  /**
   * このキーを触ってよいか。**この 2 つ以外なら必ず例外**:
   *   - `customer-import:canary:<canaryId>:` 配下
   *   - `customer-import:canary-run:<canaryId>`（墓標。**完全一致のみ**）
   */
  const assertKey = (key) => {
    const k = str(key);
    if (k === marker) return k;
    if (!k.startsWith(prefix)) throw new CanaryGuardError(CANARY_STOP.OUT_OF_NAMESPACE, k.slice(0, 48));
    return k;
  };

  const run = async (args) => {
    const op = String(args[0] || '').toUpperCase();

    // 全キー列挙は禁止
    if (op === 'KEYS') throw new CanaryGuardError(CANARY_STOP.FULL_SCAN_FORBIDDEN, 'KEYS');
    if (op === 'FLUSHALL' || op === 'FLUSHDB' || op === 'SCRIPT') {
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
    prefix,
    dataPrefix: dataPrefix(canaryId),
    /** cleanup / 残存確認の走査対象（ROOT 全体。d: 以外の取りこぼしも拾う） */
    rootPrefix: prefix,
    markerKey: marker,
    state,
    assertKey,
    run,
    /** データキーを作る（TTL 必須） */
    dkey: (name) => `${dataPrefix(canaryId)}${name}`,
    stats: () => ({
      commands: state.commands,
      keysTouched: state.keysTouched.size,
      maxKeys: keyLimit,
      maxCommands: cmdLimit,
      latencyMs: state.latencies.length ? {
        min: Math.min(...state.latencies),
        max: Math.max(...state.latencies),
        avg: Math.round(state.latencies.reduce((a, b) => a + b, 0) / state.latencies.length),
      } : null,
    }),
  };
}

/** Phase 0（read-only。**Redis write を行わない**） */
export async function runPhase0(runner) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail: detail ?? null });

  const ping = await runner.run(['PING']);
  add('PING', ping.result === 'PONG', `${ping.ms}ms`);

  const size = await runner.run(['DBSIZE']);
  const dbsize = Number(size.result);
  // ⚠️ 件数だけ。キー内容は返さない
  add('DBSIZE', Number.isFinite(dbsize), `${size.ms}ms`);

  const ev = await runner.run(['EVAL', 'return 1+1', '0']);
  add('EVAL return 1+1', Number(ev.result) === 2, `${ev.ms}ms`);

  return { checks, dbsize, ok: checks.every((c) => c.ok) };
}

/**
 * Phase 1（canary 名前空間への限定書込み）。
 * @param {{ runner, lua, now, emailClaimKeyFn, emailHashFn, canReleaseClaimFn }} input
 */
export async function runPhase1({ runner, lua, now, emailClaimKeyFn, emailHashFn, canReleaseClaimFn }) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail: detail ?? null });
  const nowIso = new Date(now).toISOString();
  const ttl = String(CANARY_TTL_SEC);

  const LOCK = runner.dkey('lock');
  const FENCE = runner.dkey('fence');
  const kA = runner.dkey('email:a');
  const kExp = runner.dkey('email:expired');
  const kRel = runner.dkey('email:release');
  const kGone = runner.dkey('lock-absent');

  // 1. SET NX の勝者は 1 件だけ
  const w1 = await runner.run(['SET', LOCK, 'tokenA', 'NX', 'EX', ttl]);
  const w2 = await runner.run(['SET', LOCK, 'tokenB', 'NX', 'EX', ttl]);
  add('1. SET NX の勝者は 1 件だけ', w1.result === 'OK' && w2.result === null);

  // 2. fencing token が単調増加（**canary 専用 fence**。本番 fence は触らない）
  const f1 = await runner.run(['INCR', FENCE]);
  await runner.run(['EXPIRE', FENCE, ttl]);
  const f2 = await runner.run(['INCR', FENCE]);
  const f3 = await runner.run(['INCR', FENCE]);
  add('2. fencing token が単調増加', Number(f2.result) > Number(f1.result) && Number(f3.result) > Number(f2.result));

  const claimArgs = (keys, owner, batch, op, fence, claimedAt, expiresAt) => ([
    'EVAL', lua.CLAIM_ROWS_LUA, String(keys.length), ...keys,
    owner, batch, op, String(fence), claimedAt || nowIso,
    expiresAt || new Date(now + 600_000).toISOString(), ttl,
  ]);

  // 3. CLAIM_ROWS_LUA の 4 応答
  const r1 = await runner.run(claimArgs([kA], 'jobA', 'batch-1', 'op-1', 10));
  add('3a. 未設定キーは OK', Array.isArray(r1.result) && r1.result[0] === 'OK');
  const r2 = await runner.run(claimArgs([kA], 'jobA', 'batch-1', 'op-2', 11));
  add('3b. 自分の CLAIMED は MINE', r2.result[0] === 'MINE');
  const r3 = await runner.run(claimArgs([kA], 'jobB', 'batch-2', 'op-3', 12));
  add('3c. 他 job は TAKEN', r3.result[0] === 'TAKEN');
  // 5. 異なる batchId でも同一キーは片方しか取れない（3c と同じ判定を batchId 差で確認）
  add('5. 異なる batchId でも同一メールは片方だけ', r3.result[0] === 'TAKEN');

  await runner.run(['EVAL', lua.MARK_CREATED_LUA, '1', kA, 'jobA', nowIso]);
  const r4 = await runner.run(claimArgs([kA], 'jobB', 'batch-2', 'op-4', 13));
  add('3d. CREATED は取り直せない', r4.result[0] === 'CREATED');
  add('10a. CLAIMED → CREATED へ遷移する', r4.result[0] === 'CREATED');

  // 4. 正規化（**ローカル計算のみ。Redis へ送らない**）
  const base = emailClaimKeyFn('user@example.invalid');
  const variants = ['USER@EXAMPLE.INVALID', '  user@example.invalid  ', 'User@Example.Invalid',
    'mailto:user@example.invalid', '<user@example.invalid>'];
  add('4. 大文字小文字・空白差が同一 claim キーへ収束',
    variants.every((v) => emailClaimKeyFn(v) === base)
    && emailHashFn('A@B.invalid') === emailHashFn('a@b.invalid'));

  // 6. 期限切れ claim を通常 worker が奪わない
  await runner.run(claimArgs([kExp], 'jobA', 'batch-1', 'op-x', 20,
    new Date(now - 600_000).toISOString(), new Date(now - 300_000).toISOString()));
  const rExp = await runner.run(claimArgs([kExp], 'jobB', 'batch-2', 'op-y', 21));
  add('6. 期限切れ claim を通常 worker が奪わない', rExp.result[0] === 'TAKEN');

  // 7. VERIFY_LOCK_LUA
  const v1 = await runner.run(['EVAL', lua.VERIFY_LOCK_LUA, '1', LOCK, 'tokenA']);
  add('7a. 正当な所有者は OK', v1.result === 'OK');
  const v2 = await runner.run(['EVAL', lua.VERIFY_LOCK_LUA, '1', LOCK, 'tokenB']);
  add('7b. 別 token は STOLEN', v2.result === 'STOLEN');
  const v3 = await runner.run(['EVAL', lua.VERIFY_LOCK_LUA, '1', kGone, 'tokenA']);
  add('7c. キーが無ければ LOST', v3.result === 'LOST');

  // 8. 所有権喪失時は write 不許可
  const rel = await runner.run(['EVAL', lua.RELEASE_LOCK_LUA, '1', LOCK, 'tokenB']);
  add('8. 所有権喪失は write 不許可（解放もできない）',
    v2.result !== 'OK' && v3.result !== 'OK' && rel.result === 'STOLEN');

  // 9. Lua 異常を成功扱いにしない
  let luaThrew = false;
  try { await runner.run(['EVAL', 'this is not lua', '0']); } catch { luaThrew = true; }
  add('9. 不正な Lua は成功扱いにしない', luaThrew);

  // 10. reconciler 専用の解放条件（**ローカル判定**）
  await runner.run(claimArgs([kRel], 'jobA', 'batch-1', 'op-r', 30,
    new Date(now - 600_000).toISOString(), new Date(now - 300_000).toISOString()));
  const raw = await runner.run(['GET', kRel]);
  let claim = null;
  try { claim = JSON.parse(raw.result); } catch { claim = null; }
  add('10b. CLAIMED が保存される', !!claim && claim.state === 'CLAIMED');
  if (claim) {
    add('10c. Customers に存在するなら解放しない',
      canReleaseClaimFn({ claim, absentInCustomers: false, absentForSource: true, nowMs: now, currentFencingToken: 999 }).ok === false);
    add('10d. fencing token が現行なら解放しない',
      canReleaseClaimFn({ claim, absentInCustomers: true, absentForSource: true, nowMs: now, currentFencingToken: 30 }).ok === false);
    add('10e. 4 条件すべて満たせば解放可',
      canReleaseClaimFn({ claim, absentInCustomers: true, absentForSource: true, nowMs: now, currentFencingToken: 999 }).ok === true);
  }

  return { checks, ok: checks.every((c) => c.ok) };
}

/**
 * canary キーを **SCAN で数えるだけ**（削除しない）。
 * 走査対象は **ROOT 全体**（`d:` 以外に取りこぼしがあっても拾う）。**墓標は別 prefix なので含まない。**
 */
/**
 * Phase 2（`SAVE_FENCED_LUA` の実 Redis 検証）。
 *
 * fake では「識別子で分岐して意味論を JS で再現」しているだけなので、
 * **Lua 本文が Upstash の Redis で本当に同じ判定をするか**はここでしか分からない。
 *
 * ⚠️ 使うキーは canary 専用 prefix の `job:*` のみ。**本番の正本キー
 *    (`customer-import:job:<jobId>`) には触れない**（`runner.assertKey` が構造的に拒否）。
 * ⚠️ jobId / operationId も canary 専用。実 batchId は 1 つも使わない。
 *
 * @param {{ runner, lua: { SAVE_FENCED_LUA: string }, now: number }} input
 */
export async function runPhase2({ runner, lua, now }) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail: detail ?? null });
  const ttl = String(CANARY_TTL_SEC);
  const nowIso = new Date(now).toISOString();

  // canary 専用の正本キー（本番 jobId とは prefix ごと別物）
  const K = runner.dkey('job:fenced');
  const KMissing = runner.dkey('job:absent');

  /** 正本 JSON（PII は入れない。canary 専用 jobId / operationId のみ） */
  const rec = (token, created, tag) => JSON.stringify({
    jobId: `canary:${runner.canaryId}`,
    batchId: `canary-${runner.canaryId}`,
    operationId: `canary:${runner.canaryId}#${tag}`,
    fencingToken: String(token),
    created, status: 'RUNNING', updatedAt: tag,
  });

  const save = async (key, token, created, tag) => {
    const r = await runner.run(['EVAL', lua.SAVE_FENCED_LUA, '1', key, rec(token, created, tag), String(token)]);
    return r.result;
  };
  const read = async (key) => {
    const r = await runner.run(['GET', key]);
    try { return JSON.parse(r.result); } catch { return null; }
  };

  // ── 1. 正本が無ければ MISSING（黙って新規作成しない）──
  const miss = await save(KMissing, 5, 0, 'miss');
  add('1. 正本が無ければ MISSING', miss === 'MISSING');
  const missExists = Number((await runner.run(['EXISTS', KMissing])).result);
  add('1b. MISSING のとき何も書かない', missExists === 0);

  // 初期正本を置く（token=5）
  await runner.run(['SET', K, rec(5, 0, 'init'), 'EX', ttl]);

  // ── 2. 同じ token → 保存できる ──
  const same = await save(K, 5, 10, 'same');
  const afterSame = await read(K);
  add('2. 同じ token は保存できる', same === 'OK' && afterSame && afterSame.created === 10);

  // ── 3. より新しい token → 保存できる ──
  const newer = await save(K, 9, 20, 'newer');
  const afterNewer = await read(K);
  add('3. より新しい token は保存できる', newer === 'OK' && afterNewer && afterNewer.created === 20);

  // ── 4. 古い token → STALE で拒否され、正本が汚れない ──
  const older = await save(K, 3, 999, 'older');
  const afterOlder = await read(K);
  add('4. 古い token は STALE で拒否', older === 'STALE');
  add('4b. 拒否時に正本が書き換わらない', afterOlder && afterOlder.created === 20 && afterOlder.updatedAt === 'newer');

  // ── 5. lost update シナリオ（実 Redis 上）──
  //     A(token=1) が保存前に止まる → lease 失効 → B(token=2) が保存 → A が復帰
  const KL = runner.dkey('job:lostupdate');
  await runner.run(['SET', KL, rec(1, 0, 'base'), 'EX', ttl]);
  const bSave = await save(KL, 2, 20, 'B');        // worker B が先に保存
  const aLate = await save(KL, 1, 10, 'A');        // worker A が復帰して古い token で保存
  const finalRec = await read(KL);
  add('5a. B(token=2) の保存は成功する', bSave === 'OK');
  add('5b. A(token=1) の遅れた保存は拒否される', aLate === 'STALE');
  add('5c. B の正本が保持される（lost update が起きない）',
    finalRec && finalRec.created === 20 && finalRec.updatedAt === 'B');

  // ── 6. fencingToken を持たない正本は上書きできる（後方互換）──
  //     旧形式が残っていても保存を止めない（stored が読めなければ CAS しない）
  const KNo = runner.dkey('job:notoken');
  await runner.run(['SET', KNo, JSON.stringify({ jobId: 'canary', created: 0 }), 'EX', ttl]);
  const noTok = await save(KNo, 1, 7, 'compat');
  add('6. fencingToken を持たない正本は上書きできる（後方互換）', noTok === 'OK');

  return { checks, ok: checks.every((c) => c.ok), at: nowIso };
}

export async function scanCanaryKeys(runner) {
  const found = [];
  let cursor = '0';
  let guard = 0;
  do {
    const res = await runner.run(['SCAN', cursor, 'MATCH', `${runner.rootPrefix}*`, 'COUNT', '100']);
    const [next, keys] = res.result || ['0', []];
    cursor = String(next);
    for (const k of (keys || [])) found.push(k);
    guard += 1;
  } while (cursor !== '0' && guard < 50);
  return found;
}

/** canary データキーを SCAN で集めて消す（**prefix 限定**） */
export async function cleanupCanary(runner) {
  const found = await scanCanaryKeys(runner);

  let deleted = 0;
  for (const k of found) {
    runner.assertKey(k);            // ⚠️ prefix 外なら例外
    await runner.run(['DEL', k]);
    deleted += 1;
  }

  // 残存確認（再 SCAN）
  const left = await scanCanaryKeys(runner);

  return {
    found: found.length,
    deleted,
    remaining: left.length,
    // ⚠️ キー名は prefix を除いた末尾だけ（値・PII は出さない）
    remainingSuffixes: left.map((k) => String(k).slice(runner.rootPrefix.length)).slice(0, 20),
    markerRetained: true,
    note: 'データキーのみ削除しました。実行済み墓標は別 prefix に残っているため、同じ canaryId は再実行できません。',
  };
}

/**
 * **最後の 1 回だけ**呼ぶ後始末。墓標も消して残存を完全に 0 にする。
 *
 * ⚠️ 墓標を消すと同じ canaryId が再実行可能になる。したがって finalize は
 *    **Function を無効化する直前**に実行すること（手順で担保する）。
 *    再実行しても canary 名前空間しか触らないため本番への影響は無いが、
 *    exactly-once の保証は finalize 時点で終了する。
 */
export async function finalizeCanary(runner) {
  // 1) データ残りが無いことを先に確認（あれば消す）
  const clean = await cleanupCanary(runner);
  if (clean.remaining > 0) {
    return { finalized: false, reason: 'data_remaining', cleanup: clean };
  }
  // 2) 墓標を削除
  runner.assertKey(runner.markerKey);
  await runner.run(['DEL', runner.markerKey]);
  const stillThere = Number((await runner.run(['EXISTS', runner.markerKey])).result) === 1;
  const rootLeft = await scanCanaryKeys(runner);
  return {
    finalized: !stillThere && rootLeft.length === 0,
    markerRemaining: stillThere ? 1 : 0,
    rootRemaining: rootLeft.length,
    cleanup: clean,
    note: '墓標も削除しました。以後この canaryId の再実行を Redis では拒否できません。直ちに Function を無効化してください。',
  };
}

export default createCanaryRunner;
