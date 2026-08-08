/**
 * importRedisCanaryFenced.test.mjs — canary Phase 2（SAVE_FENCED_LUA の実 Redis 検証）を固定する
 *   node --test src/lib/crm/importRedisCanaryFenced.test.mjs
 *
 * ⚠️ ここでも Redis 本体へは 1 コマンドも送らない。`cmd` の fake で検証する。
 *    Phase 2 の目的は「**実 Redis で Lua 本文を動かす**」ことなので、
 *    このテストが証明できるのは**手順・名前空間・cleanup の正しさ**まで。
 *    Lua 本文の正しさは canary を実行して初めて分かる（そこが Phase 2 の存在理由）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createCanaryRunner, runPhase2, cleanupCanary, scanCanaryKeys,
  buildCanaryId, canaryPrefix, runMarkerKey,
  CanaryGuardError, CANARY_ROOT, MAX_CANARY_KEYS,
} from './importRedisCanary.js';
import { SAVE_FENCED_LUA } from './importJobAuthority.js';

const CANARY_ID = buildCanaryId({ nowIso: '2026-08-09T00:00:00.000Z', randomHex: 'abcdef12' });
const NOW = Date.parse('2026-08-09T00:00:00.000Z');

/** SAVE_FENCED_LUA の意味論を JS で再現する fake（他コマンドは素の KV） */
function fakeRedis({ seed = {} } = {}) {
  const store = new Map(Object.entries(seed));
  const seen = [];
  const cmd = async (args) => {
    seen.push(args);
    const [op] = args;
    if (op === 'GET') return store.has(args[1]) ? store.get(args[1]) : null;
    if (op === 'SET') { store.set(args[1], args[2]); return 'OK'; }
    if (op === 'DEL') { store.delete(args[1]); return 1; }
    if (op === 'EXISTS') return store.has(args[1]) ? 1 : 0;
    if (op === 'SCAN') {
      const m = String(args[3] || '').replace(/\*$/, '');
      return ['0', [...store.keys()].filter((k) => k.startsWith(m))];
    }
    if (op === 'EVAL') {
      const [, script, nRaw, ...tail] = args;
      const n = Number(nRaw);
      const keys = tail.slice(0, n); const argv = tail.slice(n);
      if (script === SAVE_FENCED_LUA) {
        const cur = store.get(keys[0]);
        if (cur === undefined) return 'MISSING';
        const m = /"fencingToken":"(\d+)"/.exec(cur);
        const mine = Number(argv[1]);
        if (m && Number.isFinite(mine) && Number(m[1]) > mine) return 'STALE';
        store.set(keys[0], argv[0]);
        return 'OK';
      }
    }
    return null;
  };
  return { cmd, store, seen };
}

const runnerOf = (r) => createCanaryRunner({ cmd: r.cmd, canaryId: CANARY_ID });

test('Phase 2 の 4 判定（同値 / 新しい / 古い / 不存在）がすべて通る', async () => {
  const r = fakeRedis();
  const out = await runPhase2({ runner: runnerOf(r), lua: { SAVE_FENCED_LUA }, now: NOW });
  const by = Object.fromEntries(out.checks.map((c) => [c.name, c.ok]));

  assert.equal(by['1. 正本が無ければ MISSING'], true);
  assert.equal(by['1b. MISSING のとき何も書かない'], true);
  assert.equal(by['2. 同じ token は保存できる'], true);
  assert.equal(by['3. より新しい token は保存できる'], true);
  assert.equal(by['4. 古い token は STALE で拒否'], true);
  assert.equal(by['4b. 拒否時に正本が書き換わらない'], true);
  assert.equal(out.ok, true, JSON.stringify(out.checks.filter((c) => !c.ok)));
});

test('Phase 2 は lost update シナリオを実 Redis 手順で検証する', async () => {
  const r = fakeRedis();
  const out = await runPhase2({ runner: runnerOf(r), lua: { SAVE_FENCED_LUA }, now: NOW });
  const by = Object.fromEntries(out.checks.map((c) => [c.name, c.ok]));
  assert.equal(by['5a. B(token=2) の保存は成功する'], true);
  assert.equal(by['5b. A(token=1) の遅れた保存は拒否される'], true);
  assert.equal(by['5c. B の正本が保持される（lost update が起きない）'], true);
});

test('Phase 2 が触るキーは canary prefix の外に 1 つも出ない', async () => {
  const r = fakeRedis();
  await runPhase2({ runner: runnerOf(r), lua: { SAVE_FENCED_LUA }, now: NOW });

  const prefix = canaryPrefix(CANARY_ID);
  const touched = [...r.store.keys()];
  assert.ok(touched.length > 0, 'キーが 1 つも作られていない');
  for (const k of touched) {
    assert.ok(k.startsWith(prefix), `canary 名前空間の外へ書いた: ${k}`);
  }
  // 本番の正本キー（customer-import:job:*）に触れていないこと
  for (const args of r.seen) {
    for (const a of args) {
      const s = String(a);
      assert.ok(!/^customer-import:job:/.test(s), `本番の正本キーに触れた: ${s}`);
      assert.ok(!/^customer-import:email:/.test(s), `本番の claim キーに触れた: ${s}`);
      assert.ok(!/^customer-import:lock:/.test(s), `本番のロックキーに触れた: ${s}`);
    }
  }
});

test('本番の正本キーを渡そうとしたら構造的に拒否される', async () => {
  const r = fakeRedis();
  const runner = runnerOf(r);
  assert.throws(() => runner.assertKey('customer-import:job:job:imp-2026-08-09-001'), CanaryGuardError);
  assert.throws(() => runner.assertKey('customer-import:lock:global'), CanaryGuardError);
  await assert.rejects(
    () => runner.run(['EVAL', SAVE_FENCED_LUA, '1', 'customer-import:job:real', '{}', '1']),
    CanaryGuardError,
  );
});

test('Phase 2 のキー数は上限に収まる（Phase 1 と合算しても余裕がある）', async () => {
  const r = fakeRedis();
  const runner = runnerOf(r);
  await runPhase2({ runner, lua: { SAVE_FENCED_LUA }, now: NOW });
  const st = runner.stats();
  assert.ok(st.keysTouched <= MAX_CANARY_KEYS, `keysTouched=${st.keysTouched} > ${MAX_CANARY_KEYS}`);
  assert.ok(st.keysTouched <= 8, `Phase 2 だけで ${st.keysTouched} キーは多すぎる`);
});

test('cleanup 後に canary prefix の残存が 0 になる', async () => {
  const r = fakeRedis();
  const runner = runnerOf(r);
  await runPhase2({ runner, lua: { SAVE_FENCED_LUA }, now: NOW });
  assert.ok(r.store.size > 0, 'Phase 2 でキーが作られていない');

  const clean = await cleanupCanary(runner);
  assert.equal(clean.remaining, 0, `残存 ${clean.remaining} 件: ${clean.remainingSuffixes.join(',')}`);
  assert.equal((await scanCanaryKeys(runner)).length, 0);
});

test('cleanup は canary prefix の外を 1 件も消さない', async () => {
  const r = fakeRedis({
    seed: {
      'customer-import:job:job:real-batch': '{"fencingToken":"9"}',
      'customer-import:email:deadbeef': '{"state":"CREATED"}',
      'payment-email:state:rec123': '{}',
      [runMarkerKey(CANARY_ID)]: '1',
    },
  });
  const runner = runnerOf(r);
  await runPhase2({ runner, lua: { SAVE_FENCED_LUA }, now: NOW });
  await cleanupCanary(runner);

  assert.ok(r.store.has('customer-import:job:job:real-batch'), '本番の正本を消した');
  assert.ok(r.store.has('customer-import:email:deadbeef'), '本番の claim を消した');
  assert.ok(r.store.has('payment-email:state:rec123'), '入金確認メールのキーを消した');
  assert.ok(r.store.has(runMarkerKey(CANARY_ID)), '墓標を消した（cleanup では残す）');
  for (const k of r.store.keys()) {
    assert.ok(!k.startsWith(`${CANARY_ROOT}${CANARY_ID}:`), `canary データが残っている: ${k}`);
  }
});

test('canary の jobId / operationId は実 batchId を含まない', async () => {
  const r = fakeRedis();
  await runPhase2({ runner: runnerOf(r), lua: { SAVE_FENCED_LUA }, now: NOW });
  for (const v of r.store.values()) {
    const s = String(v);
    assert.ok(!/imp-\d{4}-\d{2}-\d{2}-\d{3}/.test(s), `実 ImportBatchId 形式が混ざっている: ${s}`);
    assert.ok(!/@/.test(s), `メールアドレスらしき文字列が混ざっている: ${s}`);
  }
});
