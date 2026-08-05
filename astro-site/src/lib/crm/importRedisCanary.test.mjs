/**
 * importRedisCanary.test.mjs — canary の名前空間 guard / 上限 / 二重実行拒否を固定する
 *   node --test src/lib/crm/importRedisCanary.test.mjs
 *
 * ⚠️ **Redis 本体へは 1 コマンドも送らない。** `cmd` を注入した fake で検証する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createCanaryRunner, runPhase0, runPhase1, cleanupCanary, scanCanaryKeys, finalizeCanary,
  buildCanaryId, buildCanaryConfirmation, buildFinalizeConfirmation, isValidCanaryId,
  canaryPrefix, dataPrefix, runMarkerKey, CANARY_MARKER_ROOT,
  CanaryGuardError, CANARY_STOP, PROTECTED_KEYS,
  MAX_CANARY_KEYS, MAX_REDIS_COMMANDS, CANARY_TTL_SEC,
} from './importRedisCanary.js';
import {
  CLAIM_ROWS_LUA, MARK_CREATED_LUA, VERIFY_LOCK_LUA, RELEASE_LOCK_LUA,
  emailClaimKey, emailHash, canReleaseClaim,
} from './importCanaryContracts.js';

const FN = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/admin-customer-import-redis-canary.js', import.meta.url)),
  'utf8',
);
const CANARY_ID = '20260805030000-a1b2c3d4';
const PREFIX = canaryPrefix(CANARY_ID);
const D = dataPrefix(CANARY_ID);

/** 記録するだけの fake */
function recorder(handler) {
  const sent = [];
  const cmd = async (args) => { sent.push(args); return handler ? handler(args) : 'OK'; };
  return { sent, cmd };
}

// ── canaryId ──────────────────────────────────────────────────

test('canaryId はサーバー側生成の形式のみ受け付ける', () => {
  const id = buildCanaryId({ nowIso: '2026-08-05T03:00:00.000Z', randomHex: 'a1b2c3d4' });
  assert.equal(id, '20260805030000-a1b2c3d4');
  assert.equal(isValidCanaryId(id), true);
  for (const bad of ['', 'x', '../../etc', 'customer-import:lock:global', '20260805030000-ZZZZ',
    '20260805030000-a1b2c3d4:extra']) {
    assert.equal(isValidCanaryId(bad), false, `${bad} を受け入れている`);
  }
});

test('確認文字列は canaryId に紐づく', () => {
  assert.equal(buildCanaryConfirmation(CANARY_ID), `REDIS-CANARY ${CANARY_ID}`);
  assert.notEqual(buildCanaryConfirmation(CANARY_ID), buildCanaryConfirmation('20260805030000-ffffffff'));
});

test('不正な canaryId では runner を作れない', () => {
  assert.throws(() => createCanaryRunner({ cmd: async () => 'OK', canaryId: 'bad' }),
    (e) => e instanceof CanaryGuardError);
});

// ── 名前空間 guard ────────────────────────────────────────────

test('prefix 外への write / delete を構造的に拒否する', async () => {
  const r = recorder();
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: CANARY_ID });
  for (const key of [...PROTECTED_KEYS.map((k) => (k.endsWith(':') ? `${k}x` : k)),
    'customer-import:canary:OTHER:d:x', 'unrelated:key', '']) {
    await assert.rejects(() => runner.run(['SET', key, 'v', 'EX', '60']),
      (e) => e instanceof CanaryGuardError && e.code === CANARY_STOP.OUT_OF_NAMESPACE,
      `${key} への書き込みを拒否していない`);
    await assert.rejects(() => runner.run(['DEL', key]),
      (e) => e instanceof CanaryGuardError);
  }
  assert.equal(r.sent.length, 0, 'guard を抜けて Redis へ送っている');
});

test('本番の取り込みキー・入金確認メールキーに触れない', async () => {
  const r = recorder();
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: CANARY_ID });
  for (const key of ['customer-import:lock:global', 'customer-import:fence',
    'customer-import:email:abc', 'customer-import:job:job:imp-1', 'payemail:dispatch', 'payemail:fence']) {
    await assert.rejects(() => runner.run(['SET', key, 'v']), (e) => e instanceof CanaryGuardError);
    await assert.rejects(() => runner.run(['INCR', key]), (e) => e instanceof CanaryGuardError);
    await assert.rejects(() => runner.run(['EVAL', 'return 1', '1', key]), (e) => e instanceof CanaryGuardError);
  }
  assert.equal(r.sent.length, 0);
});

test('EVAL の KEYS も 1 本ずつ検査する', async () => {
  const r = recorder(() => ['OK']);
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: CANARY_ID });
  // 1 本でも prefix 外なら拒否
  await assert.rejects(
    () => runner.run(['EVAL', CLAIM_ROWS_LUA, '2', `${D}ok`, 'customer-import:email:evil', 'a', 'b', 'c', '1', 'i', 'e', '60']),
    (e) => e instanceof CanaryGuardError && e.code === CANARY_STOP.OUT_OF_NAMESPACE);
  assert.equal(r.sent.length, 0);
});

test('全キー列挙（KEYS）と FLUSH を禁止する', async () => {
  const r = recorder();
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: CANARY_ID });
  await assert.rejects(() => runner.run(['KEYS', '*']),
    (e) => e.code === CANARY_STOP.FULL_SCAN_FORBIDDEN);
  await assert.rejects(() => runner.run(['KEYS', `${D}*`]),
    (e) => e.code === CANARY_STOP.FULL_SCAN_FORBIDDEN);
  for (const op of ['FLUSHALL', 'FLUSHDB', 'SCRIPT']) {
    await assert.rejects(() => runner.run([op]), (e) => e instanceof CanaryGuardError);
  }
  assert.equal(r.sent.length, 0);
});

test('SCAN は canary prefix のパターンだけ許す', async () => {
  const r = recorder(() => ['0', []]);
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: CANARY_ID });
  await assert.rejects(() => runner.run(['SCAN', '0', 'MATCH', '*']),
    (e) => e.code === CANARY_STOP.FULL_SCAN_FORBIDDEN);
  await assert.rejects(() => runner.run(['SCAN', '0', 'MATCH', 'customer-import:*']),
    (e) => e.code === CANARY_STOP.FULL_SCAN_FORBIDDEN);
  await runner.run(['SCAN', '0', 'MATCH', `${D}*`, 'COUNT', '100']);   // これは通る
  assert.equal(r.sent.length, 1);
});

test('未知のコマンドは通さない', async () => {
  const r = recorder();
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: CANARY_ID });
  for (const op of ['CONFIG', 'SHUTDOWN', 'CLIENT', 'MIGRATE']) {
    await assert.rejects(() => runner.run([op, 'x']), (e) => e instanceof CanaryGuardError);
  }
  assert.equal(r.sent.length, 0);
});

// ── 上限 ──────────────────────────────────────────────────────

test('最大キー数を超えたら停止する', async () => {
  const r = recorder();
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: CANARY_ID, maxKeys: 3, maxCommands: 100 });
  await runner.run(['SET', `${D}k1`, 'v']);
  await runner.run(['SET', `${D}k2`, 'v']);
  await runner.run(['SET', `${D}k3`, 'v']);
  await assert.rejects(() => runner.run(['SET', `${D}k4`, 'v']),
    (e) => e.code === CANARY_STOP.KEY_LIMIT);
});

test('最大コマンド数を超えたら停止する', async () => {
  const r = recorder();
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: CANARY_ID, maxKeys: 50, maxCommands: 3 });
  await runner.run(['PING']); await runner.run(['PING']); await runner.run(['PING']);
  await assert.rejects(() => runner.run(['PING']), (e) => e.code === CANARY_STOP.COMMAND_LIMIT);
});

test('既定の上限は固定値', () => {
  assert.equal(MAX_CANARY_KEYS, 32);
  assert.equal(MAX_REDIS_COMMANDS, 150);
  assert.equal(CANARY_TTL_SEC, 900);
});

// ── 応答不明 / 到達不能 ───────────────────────────────────────

test('応答が undefined なら成功扱いにしない', async () => {
  const runner = createCanaryRunner({ cmd: async () => undefined, canaryId: CANARY_ID });
  await assert.rejects(() => runner.run(['PING']),
    (e) => e instanceof CanaryGuardError && e.code === CANARY_STOP.UNKNOWN_RESULT);
});

test('到達不能は unreachable として伝播する', async () => {
  const runner = createCanaryRunner({ cmd: async () => { throw new Error('ETIMEDOUT'); }, canaryId: CANARY_ID });
  await assert.rejects(() => runner.run(['PING']),
    (e) => e instanceof CanaryGuardError && e.code === CANARY_STOP.UNREACHABLE);
});

// ── Phase 0 / Phase 1 ─────────────────────────────────────────

test('Phase 0 は Redis write を行わない', async () => {
  const r = recorder((a) => (a[0] === 'PING' ? 'PONG' : a[0] === 'DBSIZE' ? 42 : 2));
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: CANARY_ID });
  const p0 = await runPhase0(runner);
  assert.equal(p0.ok, true);
  assert.equal(p0.dbsize, 42);
  for (const a of r.sent) {
    assert.ok(['PING', 'DBSIZE', 'EVAL'].includes(a[0]), `write を含む: ${a[0]}`);
    if (a[0] === 'EVAL') assert.equal(a[2], '0', 'EVAL がキーを取っている');
  }
});

test('Phase 1 が触るキーは canary prefix 配下だけ', async () => {
  const store = new Map();
  const r = recorder((a) => {
    const [op] = a;
    if (op === 'SET') { if (a.includes('NX') && store.has(a[1])) return null; store.set(a[1], a[2]); return 'OK'; }
    if (op === 'INCR') { const n = Number(store.get(a[1]) || 0) + 1; store.set(a[1], String(n)); return n; }
    if (op === 'EXPIRE') return 1;
    if (op === 'GET') return store.get(a[1]) ?? null;
    if (op === 'DEL') { store.delete(a[1]); return 1; }
    if (op === 'SCAN') { const mi = a.indexOf('MATCH'); const pat = String(a[mi + 1]).replace(/\*$/, ''); return ['0', [...store.keys()].filter((k) => k.startsWith(pat))]; }
    if (op === 'DBSIZE') return store.size;
    if (op === 'EVAL') {
      const script = a[1];
      if (script === 'this is not lua') throw new Error('ERR compile');
      const n = Number(a[2]); const keys = a.slice(3, 3 + n); const argv = a.slice(3 + n);
      if (script === CLAIM_ROWS_LUA) {
        return keys.map((k) => {
          const cur = store.get(k);
          if (!cur) {
            store.set(k, JSON.stringify({
              ownerJobId: argv[0], batchId: argv[1], operationId: argv[2], fencingToken: argv[3],
              state: 'CLAIMED', claimedAt: argv[4], expiresAt: argv[5],
            }));
            return 'OK';
          }
          const c = JSON.parse(cur);
          if (c.state === 'CREATED') return 'CREATED';
          if (c.ownerJobId === argv[0] && c.state === 'CLAIMED') return 'MINE';
          return 'TAKEN';
        });
      }
      if (script === MARK_CREATED_LUA) {
        return keys.map((k) => {
          const cur = store.get(k); if (!cur) return 'MISSING';
          const c = JSON.parse(cur); if (c.ownerJobId !== argv[0]) return 'NOT_MINE';
          c.state = 'CREATED'; store.set(k, JSON.stringify(c)); return 'OK';
        });
      }
      if (script === VERIFY_LOCK_LUA) {
        const cur = store.get(keys[0]); if (!cur) return 'LOST';
        return cur === argv[0] ? 'OK' : 'STOLEN';
      }
      if (script === RELEASE_LOCK_LUA) {
        const cur = store.get(keys[0]); if (!cur) return 'LOST';
        if (cur !== argv[0]) return 'STOLEN';
        store.delete(keys[0]); return 'OK';
      }
      throw new Error('unknown script');
    }
    return 'OK';
  });
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: CANARY_ID });
  const p1 = await runPhase1({
    runner, lua: { CLAIM_ROWS_LUA, MARK_CREATED_LUA, VERIFY_LOCK_LUA, RELEASE_LOCK_LUA },
    now: Date.parse('2026-08-05T03:00:00.000Z'),
    emailClaimKeyFn: emailClaimKey, emailHashFn: emailHash, canReleaseClaimFn: canReleaseClaim,
  });
  assert.equal(p1.ok, true, JSON.stringify(p1.checks.filter((c) => !c.ok)));

  // 触ったキーがすべて canary prefix 配下
  for (const k of runner.state.keysTouched) {
    assert.ok(String(k).startsWith(PREFIX), `prefix 外のキーに触れた: ${k}`);
  }
  // 12 項目相当が揃っている
  for (const n of ['1.', '2.', '3a.', '3b.', '3c.', '3d.', '4.', '5.', '6.', '7a.', '7b.', '7c.',
    '8.', '9.', '10a.', '10b.', '10c.', '10d.', '10e.']) {
    assert.ok(p1.checks.some((c) => c.name.startsWith(n)), `検証 ${n} が無い`);
  }

  // cleanup 後の残存 0
  const clean = await cleanupCanary(runner);
  assert.equal(clean.remaining, 0);
  assert.ok(clean.deleted > 0);
  assert.equal((await scanCanaryKeys(runner)).length, 0);
});

test('cleanup は prefix 外のキーを消さない', async () => {
  const r = recorder((a) => (a[0] === 'SCAN' ? ['0', [`${D}a`, 'customer-import:email:evil']] : 1));   // prefix 外を混ぜる
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: CANARY_ID });
  await assert.rejects(() => cleanupCanary(runner),
    (e) => e instanceof CanaryGuardError && e.code === CANARY_STOP.OUT_OF_NAMESPACE);
  assert.equal(r.sent.some((a) => a[0] === 'DEL' && a[1] === 'customer-import:email:evil'), false,
    'prefix 外を削除しようとした');
});

test('cleanup の残存報告は prefix を除いた末尾だけ（値・PII を出さない）', async () => {
  let calls = 0;
  const r = recorder((a) => {
    if (a[0] === 'SCAN') { calls += 1; return ['0', [`${D}stuck`]]; }
    return 1;
  });
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: CANARY_ID });
  const clean = await cleanupCanary(runner);
  assert.equal(clean.remaining, 1);
  assert.deepEqual(clean.remainingSuffixes, ['d:stuck']);   // ROOT からの相対
  assert.equal(clean.remainingSuffixes[0].includes('customer-import'), false);
});

// ── Function の構造 guard ─────────────────────────────────────

test('guard(fn): POST のみ・GET 不可', () => {
  assert.match(FN, /if \(event\.httpMethod !== 'POST'\) return json\(405/);
});

test('guard(fn): 管理シークレット必須', () => {
  assert.match(FN, /x-admin-secret/);
  assert.match(FN, /provided !== SECRET\) return json\(403/);
});

test('guard(fn): preview / run は enabled=true のときだけ許可', () => {
  assert.match(FN, /const enabled = process\.env\.CUSTOMER_IMPORT_CANARY_ENABLED === 'true';/);
  const i = FN.indexOf("if (action === 'preview' || action === 'run')");
  assert.ok(i > -1, 'preview/run のゲートが無い');
  const body = FN.slice(i, i + 300);
  assert.match(body, /if \(!enabled\)/, 'enabled=false で拒否していない');
  assert.match(body, /canary_disabled/);
});

test('guard(fn): finalize は enabled=false / unset のときだけ許可（true なら 403）', () => {
  const i = FN.indexOf("if (action === 'finalize')");
  assert.ok(i > -1, 'finalize のゲートが無い');
  const body = FN.slice(i, i + 400);
  assert.match(body, /if \(enabled\)/, 'enabled=true で拒否していない');
  assert.match(body, /canary_still_enabled/);
  assert.equal(/if \(!enabled\)/.test(body), false, 'finalize の条件が逆になっている');
});

test('guard(fn): status / cleanup は enabled の値に関係なく使える', () => {
  // 個別ゲートは preview/run と finalize のみ。status/cleanup は素通り
  const gates = [...FN.matchAll(/if \(action === '([a-z|' ]+)'\) \{\n    if \((!?)enabled\)/g)];
  const gated = gates.map((m) => m[1]).join(' ');
  assert.equal(gated.includes('status'), false, 'status に env ゲートが掛かっている');
  assert.equal(gated.includes('cleanup'), false, 'cleanup に env ゲートが掛かっている');
});

test('guard(fn): env ゲートは Redis 初期化より前にある', () => {
  const previewGate = FN.indexOf("if (action === 'preview' || action === 'run')");
  const finalizeGate = FN.indexOf("if (action === 'finalize')");
  const dispatch = FN.indexOf("if (action === 'preview') return handlePreview");
  // ゲートは dispatch より前 = ハンドラ（createCanaryRunner / redisCmd）へ到達しない
  assert.ok(previewGate > -1 && previewGate < dispatch, 'preview/run ゲートが dispatch より後ろ');
  assert.ok(finalizeGate > -1 && finalizeGate < dispatch, 'finalize ゲートが dispatch より後ろ');
  // ゲート本体に Redis 呼び出しが無い
  const gateRegion = FN.slice(previewGate, dispatch);
  for (const bad of ['createCanaryRunner', 'redisCmd', 'await']) {
    assert.equal(gateRegion.includes(bad), false, `ゲート内で ${bad} を使っている`);
  }
});

test('guard(fn): すべての action で管理シークレット必須（status/cleanup/finalize 含む）', () => {
  const secretAt = FN.indexOf('provided !== SECRET');
  const previewGate = FN.indexOf("if (action === 'preview' || action === 'run')");
  const dispatch = FN.indexOf("if (action === 'preview') return handlePreview");
  assert.ok(secretAt > -1 && secretAt < previewGate, '認証が action ゲートより後ろ');
  assert.ok(secretAt < dispatch, '認証が dispatch より後ろ');
});

test('guard(fn): finalize は「env 無効化後にしか通らない」ことが構造で保証される', () => {
  // finalize ハンドラへ到達する経路は、enabled が false のときだけ
  const i = FN.indexOf("if (action === 'finalize')");
  const j = FN.indexOf("if (action === 'finalize') return await handleFinalize");
  assert.ok(i > -1 && j > i, 'finalize の dispatch がゲートより前にある');
  const between = FN.slice(i, j);
  assert.match(between, /canary_still_enabled/, '有効時に finalize を拒否していない');
});

test('guard(fn): action は preview / run / status / cleanup だけ', () => {
  const actions = [...FN.matchAll(/action === '([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(actions)].sort(), ['cleanup', 'finalize', 'preview', 'run', 'status']);
});

test('guard(fn): run には確認文字列と exactly-once マーカーが要る', () => {
  assert.match(FN, /buildCanaryConfirmation\(canaryId\)/);
  assert.match(FN, /runMarkerKey\(canaryId\).*'NX'/s);
  assert.match(FN, /CANARY_STOP\.ALREADY_RUN/);
  // マーカー取得は Phase 実行より前
  const markerAt = FN.indexOf('runMarkerKey(canaryId)');
  const phaseAt = FN.indexOf('await runPhase0(');
  assert.ok(markerAt > -1 && markerAt < phaseAt, 'マーカーより前に Phase を実行している');
});

test('guard(fn): Airtable / メール送信の経路が無い', () => {
  for (const bad of ['api.airtable.com', 'Customers', 'mail/send', '@sendgrid/mail', 'sendgrid.com']) {
    assert.equal(FN.includes(bad), false, `${bad} への依存がある`);
  }
});

test('guard(fn): secret をレスポンス・ログへ出さない', () => {
  // URL / token を返す・ログする箇所が無い
  assert.equal(/console\.(log|error)\([^)]*(url|token|URL_|TOKEN)/i.test(FN), false);
  assert.equal(/json\([0-9]+, \{[^}]*(UPSTASH|token|url)/i.test(FN), false);
  // 例外メッセージをそのまま返さない
  const c = FN.slice(FN.indexOf('} catch (e) {', FN.indexOf('export const handler')));
  assert.equal(/e\.message/.test(c), false);
  assert.match(c, /internal error/);
});

test('guard(fn): import job の kill-switch を触らない', () => {
  assert.equal(FN.includes('CUSTOMER_IMPORT_WRITE_ENABLED'), false);
  assert.equal(FN.includes('CUSTOMER_IMPORT_JOB_ENABLED'), false);
  assert.equal(FN.includes('blocked_by_design'), false);
});

test('guard(fn): status は削除しない', () => {
  const i = FN.indexOf('async function handleStatus');
  const body = FN.slice(i, FN.indexOf('async function handleCleanup'));
  assert.equal(body.includes('cleanupCanary'), false, 'status が cleanup を呼んでいる');
  assert.match(body, /scanCanaryKeys/);
  assert.match(body, /sideEffects: 'none'/);
});


// ── 墓標（別 prefix）と finalize ──────────────────────────────

test('墓標はデータとは別の prefix に置かれる', () => {
  assert.equal(runMarkerKey(CANARY_ID), `${CANARY_MARKER_ROOT}${CANARY_ID}`);
  assert.equal(runMarkerKey(CANARY_ID).startsWith(canaryPrefix(CANARY_ID)), false,
    '墓標がデータ prefix 配下にある（cleanup 残存 0 と再実行拒否を両立できない）');
});

test('runner は墓標キーだけは完全一致で許可し、似た名前は拒否する', async () => {
  const r = recorder(() => 1);
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: CANARY_ID });
  await runner.run(['SET', runMarkerKey(CANARY_ID), 'x', 'NX', 'EX', '60']);   // 通る
  for (const bad of [`${CANARY_MARKER_ROOT}OTHER`, `${CANARY_MARKER_ROOT}${CANARY_ID}:extra`,
    CANARY_MARKER_ROOT, `${CANARY_MARKER_ROOT}${CANARY_ID}x`]) {
    await assert.rejects(() => runner.run(['DEL', bad]),
      (e) => e instanceof CanaryGuardError, `${bad} を許可している`);
  }
});

test('cleanup は墓標を消さない（再実行拒否を維持する）', async () => {
  const store = new Map([[`${D}a`, '1'], [runMarkerKey(CANARY_ID), 'marker']]);
  const r = recorder((a) => {
    if (a[0] === 'SCAN') { const mi = a.indexOf('MATCH'); const pat = String(a[mi + 1]).replace(/\*$/, '');
      return ['0', [...store.keys()].filter((k) => k.startsWith(pat))]; }
    if (a[0] === 'DEL') { store.delete(a[1]); return 1; }
    return 1;
  });
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: CANARY_ID });
  const clean = await cleanupCanary(runner);
  assert.equal(clean.remaining, 0, 'canary prefix 残存 0 になっていない');
  assert.equal(store.has(runMarkerKey(CANARY_ID)), true, 'cleanup が墓標を消した');
  assert.equal(clean.markerRetained, true);
});

test('finalize は墓標も消して残存を完全に 0 にする', async () => {
  const store = new Map([[`${D}a`, '1'], [runMarkerKey(CANARY_ID), 'marker']]);
  const r = recorder((a) => {
    if (a[0] === 'SCAN') { const mi = a.indexOf('MATCH'); const pat = String(a[mi + 1]).replace(/\*$/, '');
      return ['0', [...store.keys()].filter((k) => k.startsWith(pat))]; }
    if (a[0] === 'DEL') { store.delete(a[1]); return 1; }
    if (a[0] === 'EXISTS') return store.has(a[1]) ? 1 : 0;
    return 1;
  });
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: CANARY_ID });
  const fin = await finalizeCanary(runner);
  assert.equal(fin.finalized, true);
  assert.equal(fin.markerRemaining, 0);
  assert.equal(fin.rootRemaining, 0);
  assert.equal(store.size, 0, '最終残存が 0 でない');
});

test('データが残っていたら finalize しない（墓標を先に消さない）', async () => {
  const store = new Map([[`${D}stuck`, '1'], [runMarkerKey(CANARY_ID), 'marker']]);
  const r = recorder((a) => {
    if (a[0] === 'SCAN') { const mi = a.indexOf('MATCH'); const pat = String(a[mi + 1]).replace(/\*$/, '');
      return ['0', [...store.keys()].filter((k) => k.startsWith(pat))]; }
    if (a[0] === 'DEL') return 1;   // 削除に失敗する状況を模擬（消えない）
    if (a[0] === 'EXISTS') return store.has(a[1]) ? 1 : 0;
    return 1;
  });
  const runner = createCanaryRunner({ cmd: r.cmd, canaryId: CANARY_ID });
  const fin = await finalizeCanary(runner);
  assert.equal(fin.finalized, false);
  assert.equal(fin.reason, 'data_remaining');
  assert.equal(store.has(runMarkerKey(CANARY_ID)), true, 'データが残っているのに墓標を消した');
});

test('finalize には専用の確認文字列が要る', () => {
  assert.equal(buildFinalizeConfirmation(CANARY_ID), `REDIS-CANARY-FINALIZE ${CANARY_ID}`);
  assert.notEqual(buildFinalizeConfirmation(CANARY_ID), buildCanaryConfirmation(CANARY_ID));
});

// ── preview の安全性 ──────────────────────────────────────────

test('guard(fn): preview は Redis へ一切接続しない（同期関数で runner を作らない）', () => {
  const i = FN.indexOf('function handlePreview');
  assert.ok(i > -1, 'handlePreview が無い');
  const body = FN.slice(i, FN.indexOf('\n}', i) + 2);
  // async でない = await が無い = Redis 呼び出しが構造的に不可能
  assert.equal(/^async function handlePreview/.test(FN.slice(i - 6)), false, 'preview が async になっている');
  for (const bad of ['createCanaryRunner', 'redisCmd', 'await', 'runner', 'runMarkerKey']) {
    assert.equal(body.includes(bad), false, `preview が ${bad} を使っている`);
  }
  assert.match(body, /sideEffects: 'none'/);
});

test('guard(fn): preview は run marker を作らない', () => {
  const previewAt = FN.indexOf('function handlePreview');
  const runAt = FN.indexOf('async function handleRun');
  const markerAt = FN.indexOf('runMarkerKey(canaryId)');
  assert.ok(markerAt > runAt, 'run marker の生成が run より前にある');
  assert.ok(markerAt > previewAt && markerAt > runAt, 'preview 側で marker を作っている');
});

// ── DBSIZE は参考値 ───────────────────────────────────────────

test('guard(fn): 合否判定に DBSIZE を使わない（参考値扱い）', () => {
  const i = FN.indexOf('out.ok = p0.ok');
  assert.ok(i > -1, '合否判定が見つからない');
  const line = FN.slice(i, FN.indexOf('\n', i));
  assert.equal(/dbsize/i.test(line), false, '合否判定に DBSIZE が入っている');
  assert.match(line, /clean\.remaining === 0/, '残存 0 を合否に使っていない');
  assert.match(FN, /参考値/, 'DBSIZE を参考値と明記していない');
});

// ── canary 専用 branch の最小性 ────────────────────────────────

const CONTRACTS = readFileSync(
  fileURLToPath(new URL('./importCanaryContracts.js', import.meta.url)), 'utf8',
);

test('guard: 検証対象モジュールは取り込みジョブ本体へ依存しない', () => {
  // 取り込みジョブ本体（親ジョブ・排他・正本・管理画面）を本番へ持ち込まない
  for (const bad of ['importClaimStore', 'importJobReconcile', 'importJobModel',
    'importJobAuthority', 'importJobRunner', 'importEligibility', 'importJobStore',
    'importWriteExecutor', 'importWritePlan', 'admin-customer-import-job']) {
    assert.equal(new RegExp(`from '[^']*${bad}`).test(CONTRACTS), false,
      `検証対象が ${bad} を import している`);
    assert.equal(new RegExp(`from '[^']*${bad}`).test(FN), false,
      `canary Function が ${bad} を import している`);
  }
});

test('guard: 検証対象モジュールは Airtable / メール / Customers に依存しない', () => {
  // ⚠️ 語の出現ではなく**実依存**で見る。`absentInCustomers` は呼び出し側が渡す
  //    真偽値であって Airtable 参照ではない（この層は I/O を持たない）。
  const code = CONTRACTS
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  for (const bad of ['api.airtable.com', 'AIRTABLE_', 'sendgrid', 'mail/send', 'fetch(']) {
    assert.equal(code.includes(bad), false, `検証対象が ${bad} に依存している`);
  }
  // import は正規化ユーティリティと node:crypto だけ
  const imports = [...CONTRACTS.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['./customerImport.js', 'node:crypto']);
  // process.env を読まない（gate はすべて Function 側）
  assert.equal(code.includes('process.env'), false);
});

test('guard: canary Function が使う env は UPSTASH と canary gate だけ', () => {
  const envs = [...FN.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(envs)].sort(), [
    'CUSTOMER_IMPORT_CANARY_ENABLED', 'MARKETING_ADMIN_SECRET',
    'PREMIUM_PLUS_ADMIN_SECRET', 'UPSTASH_REDIS_REST_TOKEN', 'UPSTASH_REDIS_REST_URL',
  ], '想定外の env を参照している');
});

// ── handler の実挙動（env ゲートを実際に叩いて確かめる）─────────
// ⚠️ fetch を差し替えて **Redis へ 1 回も出ていないこと**まで確認する。

const { handler } = await import('../../../netlify/functions/admin-customer-import-redis-canary.js');

const SECRET_ENV = 'PREMIUM_PLUS_ADMIN_SECRET';
const SECRET_VAL = 'test-secret-value';

/** handler を叩く。Redis 呼び出し回数も返す */
async function call({ action, enabled, secret = SECRET_VAL, canaryId, confirmation, method = 'POST' }) {
  const prevEnabled = process.env.CUSTOMER_IMPORT_CANARY_ENABLED;
  const prevSecret = process.env[SECRET_ENV];
  const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
  const prevTok = process.env.UPSTASH_REDIS_REST_TOKEN;
  const prevFetch = globalThis.fetch;

  if (enabled === undefined) delete process.env.CUSTOMER_IMPORT_CANARY_ENABLED;
  else process.env.CUSTOMER_IMPORT_CANARY_ENABLED = enabled;
  process.env[SECRET_ENV] = SECRET_VAL;
  process.env.UPSTASH_REDIS_REST_URL = 'https://example.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'x';

  let redisCalls = 0;
  globalThis.fetch = async () => { redisCalls += 1; return { ok: true, json: async () => ({ result: null }) }; };

  try {
    const res = await handler({
      httpMethod: method,
      headers: secret === null ? {} : { 'x-admin-secret': secret },
      body: JSON.stringify({ action, canaryId, confirmation }),
    });
    return { status: res.statusCode, body: JSON.parse(res.body), redisCalls };
  } finally {
    globalThis.fetch = prevFetch;
    if (prevEnabled === undefined) delete process.env.CUSTOMER_IMPORT_CANARY_ENABLED;
    else process.env.CUSTOMER_IMPORT_CANARY_ENABLED = prevEnabled;
    if (prevSecret === undefined) delete process.env[SECRET_ENV]; else process.env[SECRET_ENV] = prevSecret;
    if (prevUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = prevUrl;
    if (prevTok === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = prevTok;
  }
}

const VALID_ID = '20260805030000-a1b2c3d4';

test('handler: enabled=unset なら preview / run は 403（Redis 非接触）', async () => {
  for (const action of ['preview', 'run']) {
    const r = await call({ action, enabled: undefined, canaryId: VALID_ID });
    assert.equal(r.status, 403, `${action} が拒否されていない`);
    assert.equal(r.body.code, 'canary_disabled');
    assert.equal(r.redisCalls, 0, `${action} が Redis を叩いた`);
  }
});

test('handler: enabled=false でも preview / run は 403', async () => {
  for (const action of ['preview', 'run']) {
    const r = await call({ action, enabled: 'false', canaryId: VALID_ID });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'canary_disabled');
    assert.equal(r.redisCalls, 0);
  }
});

test('handler: enabled=true では finalize が 403（墓標を消させない）', async () => {
  const r = await call({
    action: 'finalize', enabled: 'true',
    canaryId: VALID_ID, confirmation: `REDIS-CANARY-FINALIZE ${VALID_ID}`,
  });
  assert.equal(r.status, 403, 'canary 有効中に finalize が通ってしまう');
  assert.equal(r.body.code, 'canary_still_enabled');
  assert.equal(r.redisCalls, 0, 'finalize が Redis を叩いた');
});

test('handler: enabled=unset なら finalize はゲートを通過する（確認文字列の検査まで進む）', async () => {
  // 確認文字列を誤らせる → ゲートは通過し 409 まで到達する＝env ゲートで弾かれていない証拠
  const r = await call({ action: 'finalize', enabled: undefined, canaryId: VALID_ID, confirmation: 'WRONG' });
  assert.equal(r.status, 409, `env 無効時に finalize が 403 のまま（status=${r.status}）`);
  assert.equal(r.body.code, 'confirmation_mismatch');
  assert.equal(r.redisCalls, 0);
});

test('handler: enabled=unset でも status / cleanup は利用できる', async () => {
  for (const action of ['status', 'cleanup']) {
    // canaryId 不正 → 400（＝env ゲートで 403 になっていない）
    const r = await call({ action, enabled: undefined, canaryId: 'bad' });
    assert.equal(r.status, 400, `${action} が env ゲートで弾かれている（status=${r.status}）`);
    assert.equal(r.redisCalls, 0);
  }
});

test('handler: enabled=true でも status / cleanup は利用できる', async () => {
  for (const action of ['status', 'cleanup']) {
    const r = await call({ action, enabled: 'true', canaryId: 'bad' });
    assert.equal(r.status, 400, `${action} が拒否されている`);
  }
});

test('handler: 管理シークレットが無ければ全 action で 403（Redis 非接触）', async () => {
  for (const action of ['preview', 'run', 'status', 'cleanup', 'finalize']) {
    for (const enabled of [undefined, 'true']) {
      const r = await call({ action, enabled, secret: null, canaryId: VALID_ID });
      assert.equal(r.status, 403, `${action}/${enabled} が認証なしで通った`);
      assert.equal(r.body.error, 'Forbidden');
      assert.equal(r.redisCalls, 0);
    }
  }
});

test('handler: 誤ったシークレットも拒否する', async () => {
  const r = await call({ action: 'preview', enabled: 'true', secret: 'wrong' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'Forbidden');
});

test('handler: GET は 405（POST のみ）', async () => {
  const r = await call({ action: 'preview', enabled: 'true', method: 'GET' });
  assert.equal(r.status, 405);
  assert.equal(r.redisCalls, 0);
});

test('handler: preview は Redis へ 1 回も出ない（enabled=true でも）', async () => {
  const r = await call({ action: 'preview', enabled: 'true' });
  assert.equal(r.status, 200);
  assert.equal(r.redisCalls, 0, 'preview が Redis を叩いた');
  assert.match(r.body.canaryId, /^\d{14}-[a-f0-9]{8}$/);
  assert.equal(r.body.sideEffects, 'none');
});

test('handler: canaryId はサーバー側生成で毎回変わる', async () => {
  const a = await call({ action: 'preview', enabled: 'true' });
  const b = await call({ action: 'preview', enabled: 'true' });
  assert.notEqual(a.body.canaryId, b.body.canaryId);
});
