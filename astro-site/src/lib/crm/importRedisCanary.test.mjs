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
  emailClaimKey, emailHash,
} from './importClaimStore.js';
import { canReleaseClaim } from './importJobReconcile.js';

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

test('guard(fn): 既定は無効（env が無ければ常時 403）', () => {
  assert.match(FN, /CUSTOMER_IMPORT_CANARY_ENABLED !== 'true'/);
  const gateAt = FN.indexOf("CUSTOMER_IMPORT_CANARY_ENABLED !== 'true'");
  const secretAt = FN.indexOf('const SECRET =');
  assert.ok(gateAt > -1 && gateAt < secretAt, 'kill-switch が認証より後ろにある');
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
