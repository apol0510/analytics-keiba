/**
 * automationDefCanary.test.mjs — Definition 保存 canary の境界を固定する
 *   node --test src/lib/marketing/automationDefCanary.test.mjs
 *
 * ⚠️ **Redis 本体へは 1 コマンドも送らない。** fake だけで検証する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createDefCanaryStore, compareIndexExcludingCanary, canaryAutomationId,
  defKey, ACTIVE_INDEX_KEY, AUTO_ROOT, DEF_FIELDS, assertNoPii,
  CAS_LUA, EXPECTED_CAS_SHA256, luaSha256, DefCanaryError, DEF_FAIL,
  resultKey, RESULT_SCHEMA_VERSION, assertResultSafe, validateResult, compareResultPaths,
  runMarkKey,
} from './automationDefCanaryStore.js';

const FN = readFileSync(fileURLToPath(
  new URL('../../../netlify/functions/admin-marketing-automation-def-canary.js', import.meta.url)), 'utf8');
const STORE = readFileSync(fileURLToPath(new URL('./automationDefCanaryStore.js', import.meta.url)), 'utf8');
const TOML = readFileSync(fileURLToPath(new URL('../../../netlify.toml', import.meta.url)), 'utf8');

const ID = '20260806030000-a1b2c3d4';
const AUTO_ID = canaryAutomationId(ID);

function fakeRedis(seed = {}) {
  const store = new Map(Object.entries(seed));
  const state = { fail: null, unknown: false };
  const calls = [];
  const cmd = async (args) => {
    calls.push(args);
    if (state.fail) throw new Error(state.fail);
    if (state.unknown) return undefined;
    const [op, key] = args;
    if (op === 'GET') return store.has(key) ? store.get(key) : null;
    if (op === 'SET') {
      if (args.includes('NX') && store.has(key)) return null;   // NX 失敗
      store.set(key, args[2]); return 'OK';
    }
    if (op === 'DEL') { store.delete(key); return 1; }
    if (op === 'EXISTS') return store.has(key) ? 1 : 0;
    if (op === 'SADD') { const s = store.get(key) || new Set(); s.add(args[2]); store.set(key, s); return 1; }
    if (op === 'SREM') { const s = store.get(key); if (s) s.delete(args[2]); return 1; }
    if (op === 'SMEMBERS') { const s = store.get(key); return s ? [...s] : []; }
    if (op === 'EVAL') {
      const n = Number(args[2]);
      const keys = args.slice(3, 3 + n); const argv = args.slice(3 + n);
      const cur = store.get(keys[0]);
      if (!cur) { if (argv[1] === '') { store.set(keys[0], argv[0]); return 'OK'; } return 'MISSING'; }
      const m = /"configVersion":(\d+)/.exec(cur);
      if (!m || m[1] !== argv[1]) return 'CONFLICT';
      store.set(keys[0], argv[0]); return 'OK';
    }
    throw new Error('unsupported ' + op);
  };
  return { cmd, state, store, calls };
}

const def = (over = {}) => ({
  automationId: AUTO_ID, presetId: 'canary-preset', name: 'canary definition',
  status: 'DRAFT', campaignId: 'canary-campaign', campaignVersion: '1',
  schedule: 'never', timezone: 'Asia/Tokyo', quietHours: { start: 21, end: 8 },
  maxRecipients: 1, trigger: { kind: 'manual_condition' }, audience: {},
  createdAt: '2026-08-06T03:00:00.000Z', updatedAt: '2026-08-06T03:00:00.000Z',
  configVersion: 1, lastRunAt: null, nextRunAt: null, ...over,
});

// ── PR #237 との同一性 ────────────────────────────────────────

test('CAS Lua は PR #237 実装と byte 一致', () => {
  assert.equal(luaSha256(CAS_LUA), EXPECTED_CAS_SHA256);
});

test('key 生成と保存項目が PR #237 と同じ', () => {
  assert.equal(AUTO_ROOT, 'ak:marketing-automation:');
  assert.equal(defKey('x'), 'ak:marketing-automation:def:x');
  assert.equal(ACTIVE_INDEX_KEY, 'ak:marketing-automation:index:active');
  for (const f of ['automationId', 'presetId', 'name', 'status', 'campaignId', 'campaignVersion',
    'schedule', 'timezone', 'quietHours', 'maxRecipients', 'trigger', 'audience',
    'createdAt', 'updatedAt', 'configVersion', 'lastRunAt', 'nextRunAt']) {
    assert.ok(DEF_FIELDS.includes(f), `${f} が無い`);
  }
});

// ── 名前空間 ──────────────────────────────────────────────────

test('canary の automationId は canary-<canaryId> 固定', () => {
  assert.equal(AUTO_ID, `canary-${ID}`);
  assert.throws(() => createDefCanaryStore({ cmd: async () => 'OK', canaryId: 'bad' }),
    (e) => e instanceof DefCanaryError);
});

test('canary の def キーと index 以外は触れない', async () => {
  const r = fakeRedis();
  const s = createDefCanaryStore({ cmd: r.cmd, canaryId: ID });
  for (const k of [
    'ak:marketing-automation:def:expiry-d7', 'ak:marketing-automation:def:other',
    'ak:marketing-automation:run:x', 'ak:marketing-automation:recipient:r:h',
    'ak:marketing-automation:lock:x', 'ak:marketing-automation:fence',
    'ak:marketing-automation:canary:x', 'payemail:dispatch', 'customer-import:lock:global', 'kma:t',
    // 別 canaryId の結果キー・墓標も触らない
    resultKey('20260806040000-ffffffff'), runMarkKey('20260806040000-ffffffff'),
  ]) {
    assert.throws(() => s.assertKey(k),
      (e) => e instanceof DefCanaryError && e.code === DEF_FAIL.OUT_OF_NAMESPACE, `${k} を許可`);
  }
  assert.equal(s.assertKey(defKey(AUTO_ID)), defKey(AUTO_ID));
  assert.equal(s.assertKey(ACTIVE_INDEX_KEY), ACTIVE_INDEX_KEY);
  assert.equal(s.assertKey(resultKey(ID)), resultKey(ID));
  assert.equal(s.assertKey(runMarkKey(ID)), runMarkKey(ID));
  assert.equal(r.store.size, 0);
});

// ── run 墓標（run exactly 1 の構造保証）────────────────────────

test('墓標キーは def: の外の canary 専用 prefix', () => {
  assert.equal(runMarkKey(ID), `ak:marketing-automation:def-canary:${ID}:run`);
  assert.equal(runMarkKey(ID).startsWith(`${AUTO_ROOT}def:`), false);
  assert.notEqual(runMarkKey(ID), resultKey(ID));
});

test('claimRun は SET NX で 1 回しか取れない', async () => {
  const r = fakeRedis();
  const s = createDefCanaryStore({ cmd: r.cmd, canaryId: ID });
  assert.equal(await s.claimRun('2026-08-06T03:00:00.000Z'), true);
  assert.equal(await s.claimRun('2026-08-06T03:00:01.000Z'), false, '2 回目が取れた');
  assert.equal(await s.runMarkExists(), true);
  // TTL 付きで書いていること
  const setCall = r.calls.find((c) => c[0] === 'SET' && c[1] === runMarkKey(ID));
  assert.ok(setCall.includes('NX') && setCall.includes('EX'), 'NX / EX が無い');
});

test('墓標は cleanup では消えず、finalize でだけ消える', async () => {
  const r = fakeRedis();
  const s = createDefCanaryStore({ cmd: r.cmd, canaryId: ID });
  await s.claimRun('x');
  await s.del(); await s.delResult();               // cleanup 相当（墓標に触れない）
  assert.equal(await s.runMarkExists(), true, 'cleanup 相当で墓標が消えた');
  assert.equal(await s.claimRun('y'), false, '墓標があるのに再 run できた');
  await s.delRunMark();                             // finalize 相当
  assert.equal(await s.runMarkExists(), false);
});

test('claimRun の応答が不明なら fail-closed', async () => {
  const s = createDefCanaryStore({ cmd: async () => 'WAT', canaryId: ID });
  await assert.rejects(() => s.claimRun('x'),
    (e) => e instanceof DefCanaryError && e.code === DEF_FAIL.UNKNOWN_RESULT);
});

// ── 結果の保存・復元（取り逃し対策）────────────────────────────

test('結果キーは def: の外の canary 専用 prefix', () => {
  assert.equal(resultKey(ID), `ak:marketing-automation:def-canary:${ID}:result`);
  assert.equal(resultKey(ID).startsWith(`${AUTO_ROOT}def:`), false);
});

test('run 結果を保存し復元できる', async () => {
  const r = fakeRedis();
  const s = createDefCanaryStore({ cmd: r.cmd, canaryId: ID });
  const summary = {
    schemaVersion: RESULT_SCHEMA_VERSION, canaryIdSuffix: ID.slice(-8),
    overallOk: true, checks: [{ name: '1. 作成', ok: true }], runCount: 1, retryCount: 0,
  };
  await s.saveResult(summary);
  assert.equal(await s.resultExists(), true);
  const got = await s.loadResult();
  assert.equal(got.ok, true);
  assert.equal(got.result.overallOk, true);
  await s.delResult();
  assert.equal(await s.resultExists(), false);
  assert.equal((await s.loadResult()).reason, DEF_FAIL.RESULT_UNAVAILABLE);
});

test('結果が無い / 壊れている / schema 違い / 別 run は PASS 扱いにしない', () => {
  const base = {
    schemaVersion: RESULT_SCHEMA_VERSION, canaryIdSuffix: ID.slice(-8),
    overallOk: true, checks: [{ name: 'a', ok: true }],
  };
  assert.equal(validateResult(null).reason, DEF_FAIL.RESULT_UNAVAILABLE);
  assert.equal(validateResult('{not json').reason, DEF_FAIL.RESULT_INVALID);
  assert.equal(validateResult({ ...base, schemaVersion: 99 }).reason, DEF_FAIL.RESULT_SCHEMA_MISMATCH);
  assert.equal(validateResult({ ...base, checks: [] }).reason, DEF_FAIL.RESULT_INVALID);
  assert.equal(validateResult({ ...base, overallOk: 'true' }).reason, DEF_FAIL.RESULT_INVALID);
  assert.equal(validateResult(base, { canaryId: '20260806040000-ffffffff' }).reason,
    DEF_FAIL.RESULT_INVALID, '別 run の結果を受理した');
  assert.equal(validateResult(JSON.stringify(base), { canaryId: ID }).ok, true);
});

test('結果に URL / token / アドレス / キー / hash / stack が入るなら保存しない', async () => {
  const r = fakeRedis();
  const s = createDefCanaryStore({ cmd: r.cmd, canaryId: ID });
  assert.equal(assertResultSafe({ overallOk: true, checks: [{ name: 'a', ok: true }] }), true);
  for (const bad of [
    { u: 'https://x.invalid/fn' }, { t: 'Bearer abc' }, { e: 'a@b.invalid' },
    { k: 'ak:marketing-automation:def:x' }, { h: 'a'.repeat(40) },
    { s: 'Error\n    at foo (bar.js:1:1)' }, { nested: [{ deep: { u: 'http://x.invalid' } }] },
  ]) {
    assert.equal(assertResultSafe(bad), false, JSON.stringify(bad));
    await assert.rejects(() => s.saveResult(bad),
      (e) => e instanceof DefCanaryError && e.code === DEF_FAIL.PII_DETECTED);
  }
  assert.equal(r.store.size, 0);
});

test('3 経路の突合は件数・名前・ok・overallOk の差を検知する', () => {
  const a = { overallOk: true, checks: [{ name: 'x', ok: true }, { name: 'y', ok: true }] };
  assert.equal(compareResultPaths(a, structuredClone(a)).same, true);
  assert.equal(compareResultPaths(a, null).same, false);
  assert.equal(compareResultPaths(a, { overallOk: true, checks: [{ name: 'x', ok: true }] }).reason, 'count');
  assert.equal(compareResultPaths(a, {
    overallOk: true, checks: [{ name: 'x', ok: false }, { name: 'y', ok: true }],
  }).reason, 'mismatch');
  assert.equal(compareResultPaths(a, {
    overallOk: false, checks: a.checks,
  }).reason, 'overall');
});

test('index の member は canary の 1 つだけ', async () => {
  const r = fakeRedis();
  const s = createDefCanaryStore({ cmd: r.cmd, canaryId: ID });
  await s.indexAdd();
  assert.deepEqual(await s.indexMembers(), [AUTO_ID]);
  // 他 member を直接足そうとしても store 経由ではできない（API が canary 固定）
  assert.equal(typeof s.indexAdd, 'function');
  assert.equal(JSON.stringify(Object.keys(s)).includes('indexAddMember'), false);
});

// ── Definition のライフサイクル ───────────────────────────────

test('作成 → get → version 一致 update → 不一致 CONFLICT', async () => {
  const r = fakeRedis();
  const s = createDefCanaryStore({ cmd: r.cmd, canaryId: ID });
  assert.equal(await s.exists(), false);

  assert.equal((await s.save({ definition: def(), expectedVersion: '' })).ok, true);
  const got = await s.load();
  assert.equal(got.automationId, AUTO_ID);
  assert.equal(got.configVersion, 1);
  assert.equal(got.campaignId, 'canary-campaign', '実 campaign を使っている');

  assert.equal((await s.save({ definition: def({ configVersion: 2 }), expectedVersion: '1' })).ok, true);
  const conflict = await s.save({ definition: def({ configVersion: 3 }), expectedVersion: '1' });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, 'cas_conflict');
  assert.equal((await s.load()).configVersion, 2, '競合したのに上書きされた');
});

test('pause / cancel の status 遷移が保存される', async () => {
  const r = fakeRedis();
  const s = createDefCanaryStore({ cmd: r.cmd, canaryId: ID });
  await s.save({ definition: def(), expectedVersion: '' });
  await s.save({ definition: def({ status: 'PAUSED', configVersion: 2 }), expectedVersion: '1' });
  assert.equal((await s.load()).status, 'PAUSED');
  await s.save({ definition: def({ status: 'CANCELLED', configVersion: 3 }), expectedVersion: '2' });
  assert.equal((await s.load()).status, 'CANCELLED');
});

test('index 追加・除去と最終削除で残存 0', async () => {
  const r = fakeRedis();
  const s = createDefCanaryStore({ cmd: r.cmd, canaryId: ID });
  await s.save({ definition: def(), expectedVersion: '' });
  await s.indexAdd();
  assert.ok((await s.indexMembers()).includes(AUTO_ID));
  await s.indexRemove();
  assert.equal((await s.indexMembers()).includes(AUTO_ID), false);
  await s.del();
  assert.equal(await s.exists(), false);
  assert.equal(await s.load(), null);
});

test('index の他 member を 0 件でも複数件でも完全一致で突合する', () => {
  const cmp = (before, after) => compareIndexExcludingCanary({ before, after, canaryMember: AUTO_ID });

  // 0 件 → 0 件（空でも「安全だから素通し」にしない）
  assert.equal(cmp([], []).same, true);
  assert.equal(cmp([], [AUTO_ID]).same, true, 'canary だけ増えたのは正常');
  assert.equal(cmp([], ['unexpected']).same, false, '空から増えたのを見逃した');
  assert.equal(cmp(['x'], []).same, false, '空になったのを見逃した');

  // 複数件 → 完全一致のみ true
  const many = ['expiry-d7', 'comeback-d7', 'free-to-light'];
  assert.equal(cmp(many, [...many].reverse()).same, true, '順序差で false になった');
  assert.equal(cmp(many, [...many, AUTO_ID]).same, true);
  assert.equal(cmp(many, ['expiry-d7', 'comeback-d7']).same, false);      // 減少
  assert.equal(cmp(many, [...many, 'unexpected']).same, false);           // 増加
  assert.equal(cmp(many, ['expiry-d7', 'comeback-d7', 'swapped']).same, false); // 入替

  // 増減の内訳を返す
  const swapped = cmp(many, ['expiry-d7', 'comeback-d7', 'swapped']);
  assert.equal(swapped.removedCount, 1);
  assert.equal(swapped.addedCount, 1);
  assert.equal(swapped.reason, DEF_FAIL.INDEX_CHANGED);

  // 配列でない入力は fail-closed
  assert.equal(cmp(null, many).same, false);
  assert.equal(cmp(many, undefined).same, false);
  assert.equal(cmp(many, 'expiry-d7').reason, DEF_FAIL.INDEX_UNAVAILABLE);
});

test('index の取得失敗・不正応答は fail-closed', async () => {
  for (const bad of [null, undefined, 'expiry-d7', 42, { members: [] }, ['ok', 7]]) {
    const s = createDefCanaryStore({
      cmd: async (args) => (args[0] === 'SMEMBERS' ? bad : 'OK'), canaryId: ID,
    });
    await assert.rejects(() => s.indexMembers(),
      (e) => e instanceof DefCanaryError
        && [DEF_FAIL.INDEX_UNAVAILABLE, DEF_FAIL.UNKNOWN_RESULT].includes(e.code),
      `${JSON.stringify(bad)} を受理した`);
  }
  // 通信断も fail-closed
  const down = createDefCanaryStore({
    cmd: async () => { throw new Error('ETIMEDOUT'); }, canaryId: ID,
  });
  await assert.rejects(() => down.indexMembers(),
    (e) => e instanceof DefCanaryError && e.code === DEF_FAIL.INDEX_UNAVAILABLE);
  // 空配列は正常（member 0 件）
  const empty = createDefCanaryStore({ cmd: async () => [], canaryId: ID });
  assert.deepEqual(await empty.indexMembers(), []);
});

test('既存の他 Definition・index member に影響しない', async () => {
  const r = fakeRedis({
    'ak:marketing-automation:def:expiry-d7': JSON.stringify({ automationId: 'expiry-d7', configVersion: 5 }),
    'ak:marketing-automation:index:active': new Set(['expiry-d7']),
  });
  const s = createDefCanaryStore({ cmd: r.cmd, canaryId: ID });
  await s.save({ definition: def(), expectedVersion: '' });
  await s.indexAdd(); await s.indexRemove(); await s.del();
  assert.equal(r.store.get('ak:marketing-automation:def:expiry-d7'),
    JSON.stringify({ automationId: 'expiry-d7', configVersion: 5 }), '他 Definition を壊した');
  assert.deepEqual([...r.store.get('ak:marketing-automation:index:active')], ['expiry-d7'],
    '他 member を壊した');
});

// ── PII / fail-closed ─────────────────────────────────────────

test('PII が混ざった Definition は保存しない', async () => {
  const r = fakeRedis();
  const s = createDefCanaryStore({ cmd: r.cmd, canaryId: ID });
  assert.equal(assertNoPii(def()), true);
  await assert.rejects(() => s.save({ definition: def({ name: '担当 a@b.invalid' }), expectedVersion: '' }),
    (e) => e instanceof DefCanaryError && e.code === DEF_FAIL.PII_DETECTED);
  assert.equal(r.store.size, 0);
});

test('Redis 到達不能 / 応答不明 / 壊れた JSON は fail-closed', async () => {
  const r = fakeRedis(); r.state.fail = 'ETIMEDOUT';
  const s = createDefCanaryStore({ cmd: r.cmd, canaryId: ID });
  await assert.rejects(() => s.load(), (e) => e instanceof DefCanaryError);

  const u = createDefCanaryStore({ cmd: async () => undefined, canaryId: ID });
  await assert.rejects(() => u.load(),
    (e) => e instanceof DefCanaryError && e.code === DEF_FAIL.UNKNOWN_RESULT);

  const bad = fakeRedis({ [defKey(AUTO_ID)]: '{not json' });
  const b = createDefCanaryStore({ cmd: bad.cmd, canaryId: ID });
  await assert.rejects(() => b.load(),
    (e) => e instanceof DefCanaryError && e.code === DEF_FAIL.DATA_CORRUPT);
});

// ── Function ──────────────────────────────────────────────────

test('handler: gate 未設定なら preview / run が 403（Redis 接続 0）', async () => {
  const { handler, DEF_CANARY_GATE_ENV } = await import(
    '../../../netlify/functions/admin-marketing-automation-def-canary.js');
  const prevFetch = globalThis.fetch; const prev = { ...process.env };
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return { ok: true, json: async () => ({ result: null }) }; };
  process.env.PREMIUM_PLUS_ADMIN_SECRET = 'sec';
  process.env.UPSTASH_REDIS_REST_URL = 'https://x.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  delete process.env[DEF_CANARY_GATE_ENV];
  try {
    for (const action of ['preview', 'run']) {
      const res = await handler({
        httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
        body: JSON.stringify({ action, canaryId: ID, confirmation: `DEF-CANARY ${ID}` }),
      });
      assert.equal(res.statusCode, 403, `${action} が通った`);
      assert.equal(JSON.parse(res.body).code, 'def_canary_disabled');
    }
    // finalize は無効時に通る（確認文字列検査まで到達）
    const f = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({ action: 'finalize', canaryId: ID, confirmation: 'WRONG' }),
    });
    assert.equal(f.statusCode, 409);
    assert.equal(calls, 0, 'ゲート閉なのに接続した');
  } finally {
    globalThis.fetch = prevFetch;
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

test('handler: run が全 check を通し、Definition を残したままにする', async () => {
  const { handler, DEF_CANARY_GATE_ENV } = await import(
    '../../../netlify/functions/admin-marketing-automation-def-canary.js');
  const r = fakeRedis({ 'ak:marketing-automation:index:active': new Set(['expiry-d7']) });
  const prevFetch = globalThis.fetch; const prev = { ...process.env };
  const prevLog = console.log; const logs = [];
  globalThis.fetch = async (_u, opt) => {
    const result = await r.cmd(JSON.parse(opt.body));
    return { ok: true, json: async () => ({ result }) };
  };
  console.log = (...a) => logs.push(a.join(' '));
  process.env.PREMIUM_PLUS_ADMIN_SECRET = 'sec';
  process.env[DEF_CANARY_GATE_ENV] = 'true';
  process.env.UPSTASH_REDIS_REST_URL = 'https://x.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  try {
    const res = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({ action: 'run', canaryId: ID, confirmation: `DEF-CANARY ${ID}` }),
    });
    const body = JSON.parse(res.body);
    assert.equal(res.statusCode, 200);
    assert.equal(body.ok, true, JSON.stringify(body.checks?.filter((c) => !c.ok)));
    assert.equal(body.checks.length, 10);
    assert.equal(body.indexOtherMembers.same, true);
    assert.equal(body.resultSaved, true);
    // ⚠️ run は Definition も結果も消さない
    assert.equal(r.store.has(defKey(AUTO_ID)), true, 'run が Definition を消した');
    assert.equal(r.store.has(resultKey(ID)), true, 'run が結果を消した');

    // 経路3: 構造化ログ
    const line = logs.find((l) => l.includes('marketing_automation_def_canary_result'));
    assert.ok(line, 'ログが無い');
    const parsed = JSON.parse(line);
    assert.equal(parsed.overallOk, true);
    assert.equal(parsed.checks.length, body.checks.length);
    assert.equal(line.includes(ID), false, 'canaryId 全文が出ている');
    assert.equal(compareResultPaths(body, parsed).same, true, 'HTTP とログが食い違う');

    // 経路2: status が保存済み結果を復元する
    const st = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({ action: 'status', canaryId: ID }),
    });
    const sb = JSON.parse(st.body);
    assert.equal(sb['Definition残存'], true);
    assert.equal(sb.status, 'CANCELLED');
    assert.equal(sb['index:active に含まれる'], false);
    assert.equal(sb.index他member数, 1);
    assert.equal(sb['結果復元'], true, sb['結果復元不能理由']);
    assert.equal(sb['墓標残存'], true);
    assert.equal(compareResultPaths(body, sb.result).same, true, 'HTTP と保存結果が食い違う');

    // ⚠️ 3 経路一致を渡さない cleanup は拒否される（削除も起きない）
    const noProof = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({ action: 'cleanup', canaryId: ID }),
    });
    assert.equal(noProof.statusCode, 409);
    assert.equal(JSON.parse(noProof.body).code, 'paths_not_verified');
    assert.equal(r.store.has(defKey(AUTO_ID)), true, '未検証なのに削除された');

    // 食い違う値を渡しても拒否される
    const wrong = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({
        action: 'cleanup', canaryId: ID,
        httpOverallOk: true, logOverallOk: false, checkCount: body.checks.length,
      }),
    });
    assert.equal(wrong.statusCode, 409);
    assert.equal(r.store.has(defKey(AUTO_ID)), true);

    // 3 経路一致を渡した cleanup で canary 残存 0（**墓標は残る**）
    const cl = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({
        action: 'cleanup', canaryId: ID,
        httpOverallOk: body.overallOk, logOverallOk: parsed.overallOk,
        checkCount: body.checks.length,
      }),
    });
    const cb = JSON.parse(cl.body);
    assert.equal(cb.pathsVerified, true);
    assert.equal(cb['canary残存0'], true);
    assert.equal(cb['結果残存'], false);
    assert.equal(cb['墓標維持'], true, 'cleanup が墓標を消した');
    assert.equal(cb.index他member.same, true);
    assert.equal(r.store.has(defKey(AUTO_ID)), false);
    assert.equal(r.store.has(resultKey(ID)), false);
    assert.equal(r.store.has(runMarkKey(ID)), true, 'cleanup が墓標を消した');
    assert.deepEqual([...r.store.get('ak:marketing-automation:index:active')], ['expiry-d7'],
      '他 member を壊した');

    // cleanup 後でも墓標があるので再 run できない
    const reRun = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({ action: 'run', canaryId: ID, confirmation: `DEF-CANARY ${ID}` }),
    });
    assert.equal(reRun.statusCode, 409);
    assert.equal(JSON.parse(reRun.body).code, DEF_FAIL.ALREADY_RUN);
    assert.equal(r.store.has(defKey(AUTO_ID)), false, '再 run が Definition を作った');

    // finalize は canary 無効時のみ。墓標まで消えて最終残存 0
    delete process.env[DEF_CANARY_GATE_ENV];
    const fin = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({ action: 'finalize', canaryId: ID, confirmation: `DEF-CANARY-FINALIZE ${ID}` }),
    });
    const fb = JSON.parse(fin.body);
    assert.equal(fb.finalized, true);
    assert.equal(fb['墓標残存'], false);
    assert.equal(fb.index他member.same, true);
    assert.equal(r.store.has(runMarkKey(ID)), false);
    assert.deepEqual([...r.store.get('ak:marketing-automation:index:active')], ['expiry-d7']);
  } finally {
    globalThis.fetch = prevFetch; console.log = prevLog;
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

test('handler: 結果を復元できないとき cleanup は拒否し、finalize で回収できる', async () => {
  const { handler, DEF_CANARY_GATE_ENV } = await import(
    '../../../netlify/functions/admin-marketing-automation-def-canary.js');
  // 結果キーだけ失われ、Definition と墓標が残った状態
  const r = fakeRedis({
    [defKey(AUTO_ID)]: JSON.stringify(def()),
    [runMarkKey(ID)]: '2026-08-06T03:00:00.000Z',
    'ak:marketing-automation:index:active': new Set(['expiry-d7', AUTO_ID]),
  });
  const prevFetch = globalThis.fetch; const prev = { ...process.env };
  globalThis.fetch = async (_u, opt) => {
    const result = await r.cmd(JSON.parse(opt.body));
    return { ok: true, json: async () => ({ result }) };
  };
  process.env.PREMIUM_PLUS_ADMIN_SECRET = 'sec';
  process.env.UPSTASH_REDIS_REST_URL = 'https://x.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  delete process.env[DEF_CANARY_GATE_ENV];
  try {
    const cl = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({
        action: 'cleanup', canaryId: ID, httpOverallOk: true, logOverallOk: true, checkCount: 10,
      }),
    });
    assert.equal(cl.statusCode, 409);
    assert.equal(JSON.parse(cl.body).code, DEF_FAIL.RESULT_UNAVAILABLE);
    assert.equal(r.store.has(defKey(AUTO_ID)), true, '復元不能なのに削除された');

    // env 閉鎖後の finalize なら回収できる
    const fin = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({ action: 'finalize', canaryId: ID, confirmation: `DEF-CANARY-FINALIZE ${ID}` }),
    });
    const fb = JSON.parse(fin.body);
    assert.equal(fb.finalized, true);
    assert.equal(r.store.has(defKey(AUTO_ID)), false);
    assert.equal(r.store.has(runMarkKey(ID)), false);
    assert.deepEqual([...r.store.get('ak:marketing-automation:index:active')], ['expiry-d7']);
  } finally {
    globalThis.fetch = prevFetch;
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

test('handler: 既存 member が 0 件でも run は成立する（空前提を置かない）', async () => {
  const { handler, DEF_CANARY_GATE_ENV } = await import(
    '../../../netlify/functions/admin-marketing-automation-def-canary.js');
  const r = fakeRedis();   // index:active が存在しない = member 0 件
  const prevFetch = globalThis.fetch; const prev = { ...process.env };
  const prevLog = console.log; console.log = () => {};
  globalThis.fetch = async (_u, opt) => {
    const result = await r.cmd(JSON.parse(opt.body));
    return { ok: true, json: async () => ({ result }) };
  };
  process.env.PREMIUM_PLUS_ADMIN_SECRET = 'sec';
  process.env[DEF_CANARY_GATE_ENV] = 'true';
  process.env.UPSTASH_REDIS_REST_URL = 'https://x.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  try {
    const res = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({ action: 'run', canaryId: ID, confirmation: `DEF-CANARY ${ID}` }),
    });
    const body = JSON.parse(res.body);
    assert.equal(body.overallOk, true, JSON.stringify(body.checks?.filter((c) => !c.ok)));
    assert.equal(body.indexOtherMembers.before, 0);
    assert.equal(body.indexOtherMembers.after, 0);
    assert.equal(body.indexOtherMembers.same, true);
  } finally {
    globalThis.fetch = prevFetch; console.log = prevLog;
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

test('handler: 同一 canaryId の run は二重実行できない', async () => {
  const { handler, DEF_CANARY_GATE_ENV } = await import(
    '../../../netlify/functions/admin-marketing-automation-def-canary.js');
  const r = fakeRedis({ [defKey(AUTO_ID)]: JSON.stringify(def()) });
  const prevFetch = globalThis.fetch; const prev = { ...process.env };
  globalThis.fetch = async (_u, opt) => {
    const result = await r.cmd(JSON.parse(opt.body));
    return { ok: true, json: async () => ({ result }) };
  };
  process.env.PREMIUM_PLUS_ADMIN_SECRET = 'sec';
  process.env[DEF_CANARY_GATE_ENV] = 'true';
  process.env.UPSTASH_REDIS_REST_URL = 'https://x.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 't';
  try {
    const res = await handler({
      httpMethod: 'POST', headers: { 'x-admin-secret': 'sec' },
      body: JSON.stringify({ action: 'run', canaryId: ID, confirmation: `DEF-CANARY ${ID}` }),
    });
    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).code, 'already_exists');
  } finally {
    globalThis.fetch = prevFetch;
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

// ── 構造 guard ────────────────────────────────────────────────

test('guard: Airtable / メール / Customers への依存が無い', () => {
  const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  for (const src of [FN, STORE]) {
    const code = codeOnly(src);
    for (const bad of ['api.airtable.com', 'AIRTABLE_', 'sendgrid', 'mail/send', 'Customers',
      'ScheduledEmails', 'CampaignDeliveries']) {
      assert.equal(code.includes(bad), false, `${bad} に依存している`);
    }
    for (const m of [...code.matchAll(/from '([^']+)'/g)].map((x) => x[1])) {
      assert.ok(/^node:|automationDefCanaryStore/.test(m), `想定外の import: ${m}`);
    }
  }
});

test('guard: 管理 UI / scheduler / enqueue / PR #237 全体を持ち込んでいない', () => {
  for (const src of [FN, STORE]) {
    for (const bad of ['premium-plus-eligibility', 'cron-marketing-automation',
      'automationAdminApi', 'automationScheduler', 'marketingEnqueueContract',
      'automationCatalog', 'campaignCatalog']) {
      assert.equal(src.includes(bad), false, `${bad} を持ち込んでいる`);
    }
  }
});

test('guard: 使う env は Upstash / 管理シークレット / def canary gate だけ', () => {
  const envs = [...FN.matchAll(/process\.env(?:\.([A-Z_]+)|\[([A-Za-z_]+)\])/g)]
    .map((m) => m[1] || m[2]).filter(Boolean);
  assert.deepEqual([...new Set(envs)].sort(), [
    'DEF_CANARY_GATE_ENV', 'MARKETING_ADMIN_SECRET', 'PREMIUM_PLUS_ADMIN_SECRET',
    'UPSTASH_REDIS_REST_TOKEN', 'UPSTASH_REDIS_REST_URL',
  ]);
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
  for (const bad of ['createDefCanaryStore', 'redisCmd', 'await']) {
    assert.equal(region.includes(bad), false, `ゲート内で ${bad} を使っている`);
  }
});

test('guard: 実 campaign を使わない固定ダミー', () => {
  assert.match(FN, /CANARY_CAMPAIGN_ID = 'canary-campaign'/);
});

test('guard: netlify.toml に scheduled function を登録していない', () => {
  assert.equal(TOML.includes('marketing-automation'), false);
});

test('guard: 例外の中身を応答へ返さない', () => {
  const c = FN.slice(FN.indexOf('} catch (e) {', FN.indexOf('export const handler')));
  assert.equal(/e\.message/.test(c), false);
  assert.match(c, /internal error/);
});
