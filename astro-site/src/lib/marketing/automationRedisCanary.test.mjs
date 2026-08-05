/**
 * automationRedisCanary.test.mjs — 自動化 Redis canary の境界を固定する
 *   node --test src/lib/marketing/automationRedisCanary.test.mjs
 *
 * ⚠️ **Redis 本体へは 1 コマンドも送らない。** fake だけで検証する。
 * ⚠️ Lua 本文はサーバ側でしか実行できないため、fake は識別子で分岐して意味論を再現する。
 *    **Lua 本文の正しさは production canary でしか確認できない。**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CAS_LUA, RELEASE_LUA, VERIFY_LUA, EXPECTED_SHA256, luaSha256, AUTO_ROOT, autoKey, emailHash,
} from './automationCanaryContracts.js';
import {
  createCanaryRunner, runPhase0, runPhase1, cleanupCanary, scanCanaryKeys, finalizeCanary,
  buildCanaryId, isValidCanaryId, canaryPrefix, dataPrefix, markerKey,
  buildRunConfirmation, buildFinalizeConfirmation, dummyEmailHash,
  CanaryGuardError, CANARY_STOP, PROTECTED_PREFIXES,
  CANARY_ROOT, CANARY_MARKER_ROOT, MAX_CANARY_KEYS, MAX_REDIS_COMMANDS, CANARY_TTL_SEC,
} from './automationRedisCanary.js';

const FN = readFileSync(fileURLToPath(
  new URL('../../../netlify/functions/admin-marketing-automation-redis-canary.js', import.meta.url)), 'utf8');
const TOML = readFileSync(fileURLToPath(new URL('../../../netlify.toml', import.meta.url)), 'utf8');
const CONTRACTS = readFileSync(fileURLToPath(new URL('./automationCanaryContracts.js', import.meta.url)), 'utf8');
const CANARY = readFileSync(fileURLToPath(new URL('./automationRedisCanary.js', import.meta.url)), 'utf8');

const ID = '20260806030000-a1b2c3d4';
const D = dataPrefix(ID);
const NOW = Date.parse('2026-08-06T03:00:00.000Z');

function fakeRedis() {
  const store = new Map();
  const state = { fail: null, unknown: false };
  const cmd = async (args) => {
    if (state.fail) throw new Error(state.fail);
    if (state.unknown) return undefined;
    const [op, key] = args;
    if (op === 'PING') return 'PONG';
    if (op === 'DBSIZE') return store.size;
    if (op === 'INCR') { const n = Number(store.get(key) || 0) + 1; store.set(key, String(n)); return n; }
    if (op === 'GET') return store.has(key) ? store.get(key) : null;
    if (op === 'DEL') { store.delete(key); return 1; }
    if (op === 'EXISTS') return store.has(key) ? 1 : 0;
    if (op === 'EXPIRE') return 1;
    if (op === 'SET') { if (args.includes('NX') && store.has(key)) return null; store.set(key, args[2]); return 'OK'; }
    if (op === 'SCAN') {
      const mi = args.indexOf('MATCH');
      const pat = String(args[mi + 1]).replace(/\*$/, '');
      return ['0', [...store.keys()].filter((k) => k.startsWith(pat))];
    }
    if (op === 'EVAL') {
      const script = args[1]; const n = Number(args[2]);
      const keys = args.slice(3, 3 + n); const argv = args.slice(3 + n);
      if (script === 'return 1') return 1;
      if (script === CAS_LUA) {
        const cur = store.get(keys[0]);
        if (!cur) { if (argv[1] === '') { store.set(keys[0], argv[0]); return 'OK'; } return 'MISSING'; }
        const m = /"configVersion":(\d+)/.exec(cur);
        if (!m || m[1] !== argv[1]) return 'CONFLICT';
        store.set(keys[0], argv[0]); return 'OK';
      }
      if (script === RELEASE_LUA) {
        const cur = store.get(keys[0]);
        if (!cur) return 'LOST';
        if (cur !== argv[0]) return 'STOLEN';
        store.delete(keys[0]); return 'OK';
      }
      if (script === VERIFY_LUA) {
        const cur = store.get(keys[0]);
        if (!cur) return 'LOST';
        return cur === argv[0] ? 'OK' : 'STOLEN';
      }
      throw new Error('unknown script');
    }
    throw new Error('unsupported ' + op);
  };
  return { cmd, state, store };
}

// ── PR #237 実装との同一性 ────────────────────────────────────

test('検証対象の Lua は PR #237 実装と byte 一致（sha256 で固定）', () => {
  assert.equal(luaSha256(CAS_LUA), EXPECTED_SHA256.CAS_LUA, 'CAS_LUA が PR #237 と違う');
  assert.equal(luaSha256(RELEASE_LUA), EXPECTED_SHA256.RELEASE_LUA, 'RELEASE_LUA が違う');
  assert.equal(luaSha256(VERIFY_LUA), EXPECTED_SHA256.VERIFY_LUA, 'VERIFY_LUA が違う');
});

test('key 生成が PR #237 実装と同一の形', () => {
  assert.equal(AUTO_ROOT, 'ak:marketing-automation:');
  assert.equal(autoKey.def('a'), 'ak:marketing-automation:def:a');
  assert.equal(autoKey.run('r'), 'ak:marketing-automation:run:r');
  assert.equal(autoKey.lock('a'), 'ak:marketing-automation:lock:a');
  assert.equal(autoKey.recipient('r', 'h'), 'ak:marketing-automation:recipient:r:h');
  assert.equal(autoKey.activeIndex(), 'ak:marketing-automation:index:active');
  assert.equal(autoKey.fence(), 'ak:marketing-automation:fence');
  // 正規化が同じ（大小・空白差を吸収）
  assert.equal(emailHash('User@Example.invalid'), emailHash('  user@example.invalid '));
  assert.match(emailHash('a@example.invalid'), /^[a-f0-9]{64}$/);
});

test('CAS の意味論が一致する（一致更新 OK / 不一致 CONFLICT）', async () => {
  const r = fakeRedis();
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: ID });
  const K = runner.dkey('def');
  const v1 = JSON.stringify({ configVersion: 1 });
  assert.equal((await runner.run(['EVAL', CAS_LUA, '1', K, v1, ''])).result, 'OK');
  assert.equal((await runner.run(['EVAL', CAS_LUA, '1', K, JSON.stringify({ configVersion: 2 }), '1'])).result, 'OK');
  assert.equal((await runner.run(['EVAL', CAS_LUA, '1', K, JSON.stringify({ configVersion: 3 }), '1'])).result, 'CONFLICT');
});

// ── 名前空間 ──────────────────────────────────────────────────

test('canary の名前空間は本番自動化キーと分かれている', () => {
  assert.equal(CANARY_ROOT, 'ak:marketing-automation:canary:');
  assert.equal(CANARY_MARKER_ROOT, 'ak:marketing-automation:canary-run:');
  assert.equal(markerKey(ID).startsWith(canaryPrefix(ID)), false, '墓標がデータ prefix 配下にある');
});

test('本番の自動化キー・他用途キーへ触れない', async () => {
  const r = fakeRedis();
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: ID });
  const banned = [
    'ak:marketing-automation:def:x', 'ak:marketing-automation:run:x',
    'ak:marketing-automation:recipient:r:h', 'ak:marketing-automation:index:active',
    'ak:marketing-automation:lock:x', 'ak:marketing-automation:fence',
    'payemail:dispatch', 'customer-import:lock:global', 'kma:tenant:1',
    'ak:marketing-automation:canary:OTHER:d:x',
  ];
  for (const k of banned) {
    await assert.rejects(() => runner.run(['SET', k, 'v']),
      (e) => e instanceof CanaryGuardError && e.code === CANARY_STOP.OUT_OF_NAMESPACE, `${k} を許可`);
    await assert.rejects(() => runner.run(['DEL', k]), (e) => e instanceof CanaryGuardError);
    await assert.rejects(() => runner.run(['EVAL', CAS_LUA, '1', k, 'v', '']), (e) => e instanceof CanaryGuardError);
  }
  assert.equal(r.store.size, 0, 'guard を抜けて書き込んだ');
  for (const p of PROTECTED_PREFIXES) assert.ok(typeof p === 'string');
});

test('KEYS 禁止 / SCAN は canary prefix のみ', async () => {
  const r = fakeRedis();
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: ID });
  await assert.rejects(() => runner.run(['KEYS', '*']), (e) => e.code === CANARY_STOP.FULL_SCAN_FORBIDDEN);
  await assert.rejects(() => runner.run(['SCAN', '0', 'MATCH', 'ak:marketing-automation:*']),
    (e) => e.code === CANARY_STOP.FULL_SCAN_FORBIDDEN);
  await runner.run(['SCAN', '0', 'MATCH', `${D}*`, 'COUNT', '100']);   // 通る
  for (const op of ['FLUSHALL', 'FLUSHDB', 'SCRIPT', 'CONFIG']) {
    await assert.rejects(() => runner.run([op]), (e) => e instanceof CanaryGuardError);
  }
});

// ── 上限・fail-closed ─────────────────────────────────────────

test('上限は固定値', () => {
  assert.equal(MAX_CANARY_KEYS, 24);
  assert.equal(MAX_REDIS_COMMANDS, 120);
  assert.equal(CANARY_TTL_SEC, 900);
});

test('最大キー数・コマンド数を超えたら停止', async () => {
  const r = fakeRedis();
  const a = createCanaryRunner({ cmd: r.cmd, canaryId: ID, maxKeys: 2, maxCommands: 50 });
  await a.run(['SET', `${D}k1`, 'v']); await a.run(['SET', `${D}k2`, 'v']);
  await assert.rejects(() => a.run(['SET', `${D}k3`, 'v']), (e) => e.code === CANARY_STOP.KEY_LIMIT);
  const b = createCanaryRunner({ cmd: r.cmd, canaryId: ID, maxKeys: 50, maxCommands: 2 });
  await b.run(['PING']); await b.run(['PING']);
  await assert.rejects(() => b.run(['PING']), (e) => e.code === CANARY_STOP.COMMAND_LIMIT);
});

test('Redis timeout / 応答不明を成功扱いにしない', async () => {
  const t = createCanaryRunner({ cmd: async () => { throw new Error('ETIMEDOUT'); }, canaryId: ID });
  await assert.rejects(() => t.run(['PING']), (e) => e.code === CANARY_STOP.UNREACHABLE);
  const u = createCanaryRunner({ cmd: async () => undefined, canaryId: ID });
  await assert.rejects(() => u.run(['PING']), (e) => e.code === CANARY_STOP.UNKNOWN_RESULT);
});

// ── Phase 0 / 1 ───────────────────────────────────────────────

test('Phase 0 は write しない', async () => {
  const r = fakeRedis();
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: ID });
  const p0 = await runPhase0(runner);
  assert.equal(p0.ok, true);
  assert.equal(r.store.size, 0, 'Phase 0 が書き込んだ');
});

test('Phase 1 の全項目が通り、触るキーは canary 配下だけ', async () => {
  const r = fakeRedis();
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: ID });
  const p1 = await runPhase1({ runner, now: NOW });
  assert.equal(p1.ok, true, JSON.stringify(p1.checks.filter((c) => !c.ok)));
  for (const n of ['1.', '2.', '3a.', '3b.', '3c.', '4a.', '4b.', '4c.', '4d.', '5.', '6.']) {
    assert.ok(p1.checks.some((c) => c.name.startsWith(n)), `検証 ${n} が無い`);
  }
  for (const k of runner.state.keysTouched) {
    assert.ok(String(k).startsWith(canaryPrefix(ID)) || k === markerKey(ID), `prefix 外: ${k}`);
  }
});

test('受信者は実アドレスを使わずダミー hash のみ', () => {
  const h = dummyEmailHash(1);
  assert.match(h, /^[a-f0-9]{64}$/);
  assert.equal(h.includes('@'), false);
  assert.equal(CANARY.includes('example.invalid'), true, 'ダミードメインを使っていない');
});

// ── cleanup / finalize ────────────────────────────────────────

test('cleanup はデータだけ消し、墓標を残す', async () => {
  const r = fakeRedis();
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: ID });
  await runner.run(['SET', `${D}a`, '1']);
  await runner.run(['SET', markerKey(ID), 'm']);
  const clean = await cleanupCanary(runner);
  assert.equal(clean.remaining, 0);
  assert.equal(r.store.has(markerKey(ID)), true, 'cleanup が墓標を消した');
});

test('finalize は墓標も消して残存 0 にする', async () => {
  const r = fakeRedis();
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: ID });
  await runner.run(['SET', `${D}a`, '1']);
  await runner.run(['SET', markerKey(ID), 'm']);
  const fin = await finalizeCanary(runner);
  assert.equal(fin.finalized, true);
  assert.equal(fin.markerRemaining, 0);
  assert.equal(fin.rootRemaining, 0);
});

test('cleanup は prefix 外を消さない', async () => {
  const r = fakeRedis();
  r.store.set('ak:marketing-automation:def:evil', 'x');
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: ID });
  // SCAN が prefix 外を返す状況を模擬
  const orig = r.cmd;
  const runner2 = createCanaryRunner({
    cmd: async (a) => (a[0] === 'SCAN' ? ['0', [`${D}a`, 'ak:marketing-automation:def:evil']] : orig(a)),
    canaryId: ID,
  });
  await assert.rejects(() => cleanupCanary(runner2),
    (e) => e instanceof CanaryGuardError && e.code === CANARY_STOP.OUT_OF_NAMESPACE);
  assert.equal(r.store.has('ak:marketing-automation:def:evil'), true, '本番キーを消した');
});

// ── Function のゲート ─────────────────────────────────────────

test('handler: gate 未設定なら preview / run が 403（Redis 接続 0）', async () => {
  const { handler, CANARY_GATE_ENV } = await import(
    '../../../netlify/functions/admin-marketing-automation-redis-canary.js');
  const prevFetch = globalThis.fetch; const prev = { ...process.env };
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: true, json: async () => ({ result: null }) }; };
  process.env.PREMIUM_PLUS_ADMIN_SECRET = 'sec';
  process.env.UPSTASH_REDIS_REST_URL = 'https://x.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  delete process.env[CANARY_GATE_ENV];
  try {
    for (const action of ['preview', 'run']) {
      const res = await handler({
        httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
        body: JSON.stringify({ action, canaryId: ID, confirmation: buildRunConfirmation(ID) }),
      });
      assert.equal(res.statusCode, 403, `${action} が通った`);
      assert.equal(JSON.parse(res.body).code, 'canary_disabled');
    }
    // finalize は無効時に**通る**（確認文字列の検査まで到達 = 409）
    const f = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({ action: 'finalize', canaryId: ID, confirmation: 'WRONG' }),
    });
    assert.equal(f.statusCode, 409, 'finalize が env ゲートで弾かれている');
    assert.equal(calls, 0, 'ゲート閉なのに Redis へ接続した');
  } finally {
    globalThis.fetch = prevFetch;
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

test('handler: gate 有効時は finalize が 403（墓標を先に消させない）', async () => {
  const { handler, CANARY_GATE_ENV } = await import(
    '../../../netlify/functions/admin-marketing-automation-redis-canary.js');
  const prevFetch = globalThis.fetch; const prev = { ...process.env };
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: true, json: async () => ({ result: null }) }; };
  process.env.PREMIUM_PLUS_ADMIN_SECRET = 'sec';
  process.env[CANARY_GATE_ENV] = 'true';
  try {
    const res = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({ action: 'finalize', canaryId: ID, confirmation: buildFinalizeConfirmation(ID) }),
    });
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).code, 'canary_still_enabled');
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = prevFetch;
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

test('handler: 管理シークレット必須 / GET 不可 / preview は Redis 非接触', async () => {
  const { handler, CANARY_GATE_ENV } = await import(
    '../../../netlify/functions/admin-marketing-automation-redis-canary.js');
  const prevFetch = globalThis.fetch; const prev = { ...process.env };
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: true, json: async () => ({ result: null }) }; };
  process.env.PREMIUM_PLUS_ADMIN_SECRET = 'sec';
  process.env[CANARY_GATE_ENV] = 'true';
  try {
    const noSecret = await handler({ httpMethod: 'POST', headers: {}, body: '{}' });
    assert.equal(noSecret.statusCode, 403);
    const get = await handler({ httpMethod: 'GET', headers: { 'x-admin-secret': 'sec' }, body: '{}' });
    assert.equal(get.statusCode, 405);
    const p = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({ action: 'preview' }),
    });
    assert.equal(p.statusCode, 200);
    const body = JSON.parse(p.body);
    assert.match(body.canaryId, /^\d{14}-[a-f0-9]{8}$/);
    assert.equal(body.sideEffects, 'none');
    assert.equal(calls, 0, 'preview が Redis を叩いた');
  } finally {
    globalThis.fetch = prevFetch;
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

// ── 構造 guard ────────────────────────────────────────────────

test('guard: Airtable / メール / Customers への依存が無い', () => {
  // ⚠️ 語の出現ではなく**実依存**で見る（「Customers を参照しない」という注記は依存ではない）
  const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  for (const src of [FN, CANARY, CONTRACTS]) {
    const code = codeOnly(src);
    for (const bad of ['api.airtable.com', 'AIRTABLE_', 'sendgrid', 'mail/send', 'Customers']) {
      assert.equal(code.includes(bad), false, `${bad} に依存している`);
    }
    // import は node 標準と canary 自身のモジュールだけ
    for (const m of [...code.matchAll(/from '([^']+)'/g)].map((x) => x[1])) {
      assert.ok(/^node:|automationCanaryContracts|automationRedisCanary/.test(m), `想定外の import: ${m}`);
    }
  }
});

test('guard: 使う env は Upstash と管理シークレットと canary gate だけ', () => {
  const envs = [...FN.matchAll(/process\.env(?:\.([A-Z_]+)|\[([A-Za-z_]+)\])/g)]
    .map((m) => m[1] || m[2]).filter(Boolean);
  assert.deepEqual([...new Set(envs)].sort(), [
    'CANARY_GATE_ENV', 'MARKETING_ADMIN_SECRET', 'PREMIUM_PLUS_ADMIN_SECRET',
    'UPSTASH_REDIS_REST_TOKEN', 'UPSTASH_REDIS_REST_URL',
  ], '想定外の env を参照している');
  // ADMIN_WRITE ゲートには**触れない**（注記としての言及は許容し、参照コードが無いことを見る）
  const codeOnly = FN.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.equal(codeOnly.includes('MARKETING_AUTOMATION_ADMIN_WRITE_ENABLED'), false,
    'ADMIN_WRITE ゲートを参照している');
});

test('guard: ゲートは Redis client 初期化より前', () => {
  const gateAt = FN.indexOf("if (action === 'preview' || action === 'run')");
  const dispatchAt = FN.indexOf("if (action === 'preview') return handlePreview");
  assert.ok(gateAt > -1 && gateAt < dispatchAt);
  const region = FN.slice(gateAt, dispatchAt);
  for (const bad of ['createCanaryRunner', 'redisCmd', 'await']) {
    assert.equal(region.includes(bad), false, `ゲート内で ${bad} を使っている`);
  }
});

test('guard: secret / Redis 値 / hash 全文をログ・応答へ出さない', () => {
  assert.equal(/console\.(log|error)\([^)]*(url|token|URL|TOKEN)/i.test(FN), false);
  const c = FN.slice(FN.indexOf('} catch (e) {', FN.indexOf('export const handler')));
  assert.equal(/e\.message/.test(c), false);
  assert.match(c, /internal error/);
});

test('guard: netlify.toml に scheduled function を登録していない', () => {
  assert.equal(TOML.includes('marketing-automation'), false, 'scheduler / canary が本番登録されている');
  assert.equal(TOML.includes('cron-marketing-automation'), false);
});

test('guard: 管理 UI / scheduler / enqueue を持ち込んでいない', () => {
  for (const src of [FN, CANARY, CONTRACTS]) {
    for (const bad of ['premium-plus-eligibility', 'cron-marketing-automation',
      'admin-marketing-automation.js', 'ScheduledEmails', 'CampaignDeliveries',
      'automationAdminApi', 'automationScheduler', 'marketingEnqueueContract']) {
      assert.equal(src.includes(bad), false, `${bad} を持ち込んでいる`);
    }
  }
});

// ── run 結果の永続化（取り逃しても復元できる）──────────────────

import {
  RESULT_SCHEMA_VERSION, RESULT_REJECT, resultKey, buildResultSummary,
  assertResultSafe, validateResult, compareResultPaths, buildLogLine,
} from './automationRedisCanary.js';

const okPhase0 = { checks: [{ name: 'PING', ok: true, detail: '12ms' }, { name: 'EVAL return 1', ok: true, detail: '9ms' }] };
const okPhase1 = { checks: [{ name: '1. SET NX', ok: true }, { name: '3c. CONFLICT', ok: true }] };
const mkSummary = (over = {}) => buildResultSummary({
  canaryId: ID, phase0: okPhase0, phase1: okPhase1,
  cleanup: { found: 0, deleted: 0, remaining: 0 },
  stats: { commands: 30, keysTouched: 6 },
  startedAt: '2026-08-06T03:00:00.000Z', finishedAt: '2026-08-06T03:00:05.000Z',
  outOfNamespaceCount: 0, retryCount: 0, runCount: 1, ...over,
});

test('result はデータ prefix 内に置く（cleanup で一緒に消える）', () => {
  assert.equal(resultKey(ID), `${dataPrefix(ID)}result`);
  assert.ok(resultKey(ID).startsWith(canaryPrefix(ID)));
});

test('result schema に必要項目が揃う', () => {
  const r = mkSummary();
  for (const f of ['schemaVersion', 'canaryId', 'completed', 'overallOk', 'startedAt', 'finishedAt',
    'commandCount', 'keyCount', 'phase0', 'phase1', 'cleanup', 'outOfNamespaceCount',
    'retryCount', 'runCount']) {
    assert.ok(f in r, `${f} が無い`);
  }
  assert.equal(r.schemaVersion, RESULT_SCHEMA_VERSION);
  assert.equal(r.overallOk, true);
  assert.equal(r.phase0[0].latencyMs, 12, 'latencyMs を拾えていない');
  assert.equal(r.phase1[0].errorCode, null);
});

test('どれか 1 つでも false なら overallOk=false に集約する', () => {
  assert.equal(mkSummary({ phase1: { checks: [{ name: 'x', ok: false }] } }).overallOk, false);
  assert.equal(mkSummary({ phase0: { checks: [{ name: 'PING', ok: false }] } }).overallOk, false);
  assert.equal(mkSummary({ cleanup: { remaining: 1 } }).overallOk, false);
  assert.equal(mkSummary({ outOfNamespaceCount: 1 }).overallOk, false, 'prefix 外操作を見逃す');
  assert.equal(mkSummary({ retryCount: 1 }).overallOk, false, 'retry を見逃す');
  assert.equal(mkSummary({ runCount: 2 }).overallOk, false, 'run 回数を見逃す');
  // 失敗チェックには errorCode が入る
  assert.equal(mkSummary({ phase1: { checks: [{ name: 'x', ok: false }] } }).phase1[0].errorCode, 'check_failed');
});

test('result に URL / token / アドレス / hash 全文 / stack を入れない', () => {
  assert.equal(assertResultSafe(mkSummary()), true);
  assert.equal(assertResultSafe({ ...mkSummary(), url: 'https://x.invalid' }), false);
  assert.equal(assertResultSafe({ ...mkSummary(), token: 'abc' }), false);
  assert.equal(assertResultSafe({ ...mkSummary(), note: 'a@b.invalid' }), false);
  assert.equal(assertResultSafe({ ...mkSummary(), note: 'a'.repeat(64) }), false, 'hash 全文を見逃す');
  assert.equal(assertResultSafe({ ...mkSummary(), note: 'https://example.invalid/x' }), false);
  assert.equal(assertResultSafe({ ...mkSummary(), note: 'Error\n    at foo' }), false, 'stack を見逃す');
});

test('result が無い / 壊れている / schema 違いは PASS 扱いにしない', () => {
  assert.equal(validateResult(null).code, RESULT_REJECT.UNAVAILABLE);
  assert.equal(validateResult('').code, RESULT_REJECT.UNAVAILABLE);
  assert.equal(validateResult('{not json').code, RESULT_REJECT.INVALID);
  assert.equal(validateResult(JSON.stringify({ ...mkSummary(), schemaVersion: 999 })).code,
    RESULT_REJECT.SCHEMA_MISMATCH);
  const { phase0, ...noPhase } = mkSummary();
  assert.equal(validateResult(JSON.stringify(noPhase)).code, RESULT_REJECT.INVALID);
  assert.equal(validateResult(JSON.stringify(mkSummary())).ok, true);
});

test('3 経路（HTTP / Redis result / ログ）の一致を判定する', () => {
  const http = mkSummary();
  const stored = mkSummary();
  const log = buildLogLine(http);
  assert.equal(compareResultPaths({ http, stored, log }).agree, true);
  // 欠落
  assert.deepEqual(compareResultPaths({ http, stored: null, log }).problems, ['stored_missing']);
  assert.deepEqual(compareResultPaths({ http, stored, log: null }).problems, ['log_missing']);
  // overallOk 不一致
  const bad = { ...stored, overallOk: false };
  assert.ok(compareResultPaths({ http, stored: bad, log }).problems.includes('overallOk_mismatch:http_vs_stored'));
  // チェック件数不一致
  const shortLog = { ...log, checks: log.checks.slice(0, 1) };
  assert.ok(compareResultPaths({ http, stored, log: shortLog }).problems.includes('check_count_mismatch:http_vs_log'));
});

test('Function ログは canaryId 全文・key・値・URL/token を出さない', () => {
  const line = buildLogLine(mkSummary());
  const json = JSON.stringify(line);
  assert.equal(line.event, 'marketing_automation_redis_canary_result');
  assert.equal(line.canaryIdSuffix, ID.slice(-8));
  assert.equal(json.includes(ID), false, 'canaryId 全文が出ている');
  assert.equal(json.includes('ak:marketing-automation'), false, 'Redis key が出ている');
  assert.equal(/https?:\/\//.test(json), false);
  assert.equal(/@[a-z0-9.-]+\.[a-z]{2,}/i.test(json), false);
  assert.equal(/[a-f0-9]{32,}/i.test(json), false, 'hash 全文が出ている');
  assert.equal(line.retryCount, 0);
  assert.equal(line.runCount, 1);
  // 1 行に収まる
  assert.equal(json.includes('\n'), false);
});

test('handler: run は result を保存し、cleanup せず、ログを 1 行出す', async () => {
  const { handler, CANARY_GATE_ENV } = await import(
    '../../../netlify/functions/admin-marketing-automation-redis-canary.js');
  const r = fakeRedis();
  const prevFetch = globalThis.fetch; const prev = { ...process.env };
  const prevLog = console.log;
  const logs = [];
  globalThis.fetch = async (_url, opt) => {
    const args = JSON.parse(opt.body);
    const result = await r.cmd(args);
    return { ok: true, json: async () => ({ result }) };
  };
  console.log = (...a) => { logs.push(a.join(' ')); };
  process.env.PREMIUM_PLUS_ADMIN_SECRET = 'sec';
  process.env[CANARY_GATE_ENV] = 'true';
  process.env.UPSTASH_REDIS_REST_URL = 'https://x.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  try {
    const res = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({ action: 'run', canaryId: ID, confirmation: buildRunConfirmation(ID) }),
    });
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.resultSaved, true, 'result を保存していない');
    assert.equal(body.ok, true, JSON.stringify(body.phase1?.checks?.filter((c) => !c.ok)));
    assert.equal(body.result.schemaVersion, RESULT_SCHEMA_VERSION);
    assert.equal(body.result.runCount, 1);
    assert.equal(body.result.retryCount, 0);
    // ⚠️ run は cleanup しない（3 経路の一致確認まで result を残す）
    assert.equal(r.store.has(resultKey(ID)), true, 'run が result を消した');
    assert.equal(body.cleanup, undefined, 'run が cleanup している');

    // 構造化ログが 1 行 JSON で出ている
    const line = logs.find((l) => l.includes('marketing_automation_redis_canary_result'));
    assert.ok(line, '構造化ログが無い');
    const parsed = JSON.parse(line);
    assert.equal(parsed.overallOk, true);
    assert.equal(parsed.checks.length, body.result.phase0.length + body.result.phase1.length);
    assert.equal(line.includes(ID), false, 'ログに canaryId 全文');

    // status から復元でき、HTTP 応答と一致する
    const st = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({ action: 'status', canaryId: ID }),
    });
    const sb = JSON.parse(st.body);
    assert.equal(sb['result保存済み'], true, 'status が result を復元できない');
    assert.equal(sb.overallOk, true);
    assert.equal(sb.checks.length, parsed.checks.length, 'status と ログでチェック数が違う');
    assert.equal(sb['run実行済み'], true);
    assert.equal(sb.commandCount, body.result.commandCount);
    assert.equal(sb.retryCount, 0);

    // 3 経路の一致
    const cmp = compareResultPaths({ http: body.result, stored: { ...body.result }, log: parsed });
    assert.equal(cmp.agree, true, JSON.stringify(cmp.problems));

    // cleanup で result も消える
    const cl = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({ action: 'cleanup', canaryId: ID }),
    });
    assert.equal(JSON.parse(cl.body).cleanup.remaining, 0);
    assert.equal(r.store.has(resultKey(ID)), false, 'cleanup が result を残した');
    assert.equal(r.store.has(markerKey(ID)), true, 'cleanup が墓標を消した');

    // cleanup 後は status が result を復元できない → PASS 扱いにしない
    const st2 = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({ action: 'status', canaryId: ID }),
    });
    const sb2 = JSON.parse(st2.body);
    assert.equal(sb2['result保存済み'], false);
    assert.equal(sb2.overallOk, false, 'result 無しで PASS になっている');
    assert.equal(sb2.resultProblem, RESULT_REJECT.UNAVAILABLE);
  } finally {
    globalThis.fetch = prevFetch; console.log = prevLog;
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

test('handler: result 保存に失敗したら overall 成功にしない', async () => {
  const { handler, CANARY_GATE_ENV } = await import(
    '../../../netlify/functions/admin-marketing-automation-redis-canary.js');
  const r = fakeRedis();
  const prevFetch = globalThis.fetch; const prev = { ...process.env };
  const prevLog = console.log; console.log = () => {};
  globalThis.fetch = async (_url, opt) => {
    const args = JSON.parse(opt.body);
    // result の保存だけ失敗させる
    if (args[0] === 'SET' && String(args[1]).endsWith('d:result')) return { ok: false, status: 500 };
    const result = await r.cmd(args);
    return { ok: true, json: async () => ({ result }) };
  };
  process.env.PREMIUM_PLUS_ADMIN_SECRET = 'sec';
  process.env[CANARY_GATE_ENV] = 'true';
  process.env.UPSTASH_REDIS_REST_URL = 'https://x.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  try {
    const res = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({ action: 'run', canaryId: ID, confirmation: buildRunConfirmation(ID) }),
    });
    const body = JSON.parse(res.body);
    assert.equal(body.resultSaved, false);
    assert.equal(body.ok, false, 'result 保存失敗なのに成功扱い');
  } finally {
    globalThis.fetch = prevFetch; console.log = prevLog;
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
});
