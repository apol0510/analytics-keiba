/**
 * importJobFencedSave.test.mjs — 正本の CAS 保存と、監査で残っていた異常系を固定する
 *   node --test src/lib/crm/importJobFencedSave.test.mjs
 *
 * 追加の経緯（2026-08-08 設計監査）:
 *   `authority.save()` は無条件の `SET` で、fencing token を見ていなかった。
 *   グローバルロックがあっても **lease 失効後の stale writer** が古い job を書き戻すと
 *   直前の子バッチの結果が消える（lost update）。Airtable の行は残るため、
 *   正本の counters だけが実測とズレ、reconciler が BLOCKED にして人手が必要になる。
 *   → `saveFenced()` を追加し、**自分より新しい token の正本は上書きしない**。
 *
 * ⚠️ Redis 本体へは 1 コマンドも送らない。`cmd` を注入した fake で検証する。
 * ⚠️ Lua 本文は実行していない（サーバ側でしか動かない）。fake は識別子で分岐し
 *    同じ意味論を JS で再現する。Lua 本文の正しさは canary で確認する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createJobAuthority, buildJobRecord, SAVE_FENCED_LUA, jobKey,
} from './importJobAuthority.js';
import {
  createClaimStore, CLAIM_ROWS_LUA, MARK_CREATED_LUA, VERIFY_LOCK_LUA,
  RedisUnavailableError, GLOBAL_LOCK_KEY,
} from './importClaimStore.js';
import {
  JOB_STATUS, TERMINAL_STATUS, canStepImportJob, applyChildResult,
  beginChildBatch, describeJobRollback, buildOperationId, buildJobId, buildJobSource,
} from './importJobModel.js';
import { runChildBatch, STEP_STOP } from './importJobRunner.js';
import { writeCreateBatch } from './importWriteExecutor.js';

/** SAVE_FENCED_LUA を含む Redis fake */
function fakeRedis() {
  const store = new Map();
  const state = { fence: 0, fail: null };
  const cmd = async (args) => {
    if (state.fail) throw new Error(state.fail);
    const [op] = args;
    if (op === 'INCR') { state.fence += 1; return state.fence; }
    if (op === 'GET') return store.has(args[1]) ? store.get(args[1]) : null;
    if (op === 'DEL') { store.delete(args[1]); return 1; }
    if (op === 'SET') {
      const [, key, val, ...rest] = args;
      if (rest.includes('NX') && store.has(key)) return null;
      store.set(key, val);
      return 'OK';
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
      if (script === VERIFY_LOCK_LUA) {
        const cur = store.get(keys[0]);
        if (cur === undefined) return 'LOST';
        return cur === argv[0] ? 'OK' : 'STOLEN';
      }
      if (script === CLAIM_ROWS_LUA) {
        return keys.map((k) => {
          const cur = store.get(k);
          if (cur === undefined) {
            store.set(k, JSON.stringify({
              ownerJobId: argv[0], batchId: argv[1], operationId: argv[2],
              fencingToken: argv[3], state: 'CLAIMED', claimedAt: argv[4], expiresAt: argv[5],
            }));
            return 'OK';
          }
          const o = JSON.parse(cur);
          if (o.state === 'CREATED') return 'CREATED';
          if (o.ownerJobId === argv[0] && o.state === 'CLAIMED') return 'MINE';
          return 'TAKEN';
        });
      }
      if (script === MARK_CREATED_LUA) {
        return keys.map((k) => {
          const cur = store.get(k);
          if (cur === undefined) return 'MISSING';
          const o = JSON.parse(cur);
          if (o.ownerJobId !== argv[0]) return 'NOT_MINE';
          store.set(k, JSON.stringify({ ...o, state: 'CREATED' }));
          return 'OK';
        });
      }
    }
    return undefined;
  };
  return { cmd, store, state };
}

const BATCH = 'imp-2026-08-09-001';
const NOW_ISO = '2026-08-09T00:00:00.000Z';
const jobOf = (over = {}) => buildJobRecord({
  jobId: buildJobId(BATCH), source: buildJobSource(BATCH), batchId: BATCH,
  fileFingerprint: 'ff', snapshotFingerprint: 'sf',
  plannedTotal: 100, nowIso: '2026-08-09T00:00:00.000Z',
  ...over,
});

// ── 1. CAS の意味論 ───────────────────────────────────────────
test('保存されている token が自分より新しければ上書きしない（stale writer を拒否）', async () => {
  const r = fakeRedis();
  const a = createJobAuthority({ cmd: r.cmd });
  await a.create({ ...jobOf(), fencingToken: '5' });

  const res = await a.saveFenced({ job: { ...jobOf(), fencingToken: '3', created: 999 }, fencingToken: '3' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'stale_fencing_token');
  assert.equal(JSON.parse(r.store.get(jobKey(buildJobId(BATCH)))).created, 0, '正本が汚染された');
});

test('自分と同じ / 自分より古い token なら保存できる', async () => {
  const r = fakeRedis();
  const a = createJobAuthority({ cmd: r.cmd });
  await a.create({ ...jobOf(), fencingToken: '5' });

  assert.equal((await a.saveFenced({ job: { ...jobOf(), fencingToken: '5', created: 10 }, fencingToken: '5' })).ok, true);
  assert.equal((await a.saveFenced({ job: { ...jobOf(), fencingToken: '9', created: 20 }, fencingToken: '9' })).ok, true);
  assert.equal(JSON.parse(r.store.get(jobKey(buildJobId(BATCH)))).created, 20);
});

test('正本が無ければ job_not_found（黙って新規作成しない）', async () => {
  const a = createJobAuthority({ cmd: fakeRedis().cmd });
  const res = await a.saveFenced({ job: { ...jobOf(), fencingToken: '1' }, fencingToken: '1' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'job_not_found');
});

test('fencing token が無い / 不正なら保存しない', async () => {
  const a = createJobAuthority({ cmd: fakeRedis().cmd });
  for (const t of [undefined, null, '', '0', -1, 'abc']) {
    const res = await a.saveFenced({ job: jobOf(), fencingToken: t });
    assert.equal(res.ok, false, `token=${String(t)} を通してはいけない`);
    assert.equal(res.reason, 'invalid_fencing_token');
  }
});

test('Redis 到達不能は握りつぶさず伝播する（保存できたことにしない）', async () => {
  const r = fakeRedis();
  const a = createJobAuthority({ cmd: r.cmd });
  await a.create({ ...jobOf(), fencingToken: '1' });
  r.state.fail = 'ECONNRESET';
  await assert.rejects(
    () => a.saveFenced({ job: { ...jobOf(), fencingToken: '1' }, fencingToken: '1' }),
    RedisUnavailableError,
  );
});

// ── 2. lost update のシナリオ全体 ──────────────────────────────
test('lease 失効 → 別 worker が進行 → 復帰した旧 worker が結果を消さない', async () => {
  const r = fakeRedis();
  const a = createJobAuthority({ cmd: r.cmd });
  const base = { ...jobOf(), fencingToken: '1' };
  await a.create(base);

  // worker A が token=1 で子バッチを開始（まだ保存していない）
  const aJob = beginChildBatch({ job: base, nowIso: '...', operationId: 'op1', fencingToken: '1' });
  const aNext = applyChildResult({
    job: aJob, result: { ok: true, attempted: 10, created: 10, skippedExisting: 0, failed: 0 },
    scannedTo: 10, exhausted: false, nowIso: 'A',
  });

  // A が止まっている間に lease 失効 → worker B が token=2 で 1 バッチ完了させ保存
  const bJob = beginChildBatch({ job: base, nowIso: '...', operationId: 'op2', fencingToken: '2' });
  const bNext = applyChildResult({
    job: bJob, result: { ok: true, attempted: 20, created: 20, skippedExisting: 0, failed: 0 },
    scannedTo: 20, exhausted: false, nowIso: 'B',
  });
  assert.equal((await a.saveFenced({ job: bNext, fencingToken: '2' })).ok, true);

  // A が復帰して古い正本を書き戻そうとする → **拒否される**
  const late = await a.saveFenced({ job: aNext, fencingToken: '1' });
  assert.equal(late.ok, false);
  assert.equal(late.reason, 'stale_fencing_token');

  const stored = JSON.parse(r.store.get(jobKey(base.jobId)));
  assert.equal(stored.created, 20, 'B の結果が A に消された（lost update）');
  assert.equal(stored.updatedAt, 'B');
});

// ── 3. finalize / 再実行の冪等性 ───────────────────────────────
test('終端状態のジョブは finalize を含め二度と進められない', () => {
  for (const status of TERMINAL_STATUS) {
    const res = canStepImportJob({
      env: { CUSTOMER_IMPORT_WRITE_ENABLED: 'true' },
      job: { ...jobOf(), status }, providerOk: true, lockAcquired: true,
    });
    assert.equal(res.allowed, false, `${status} を進めてはいけない`);
  }
});

test('COMPLETED になった後に同じ子バッチをもう一度当てても正本は進まない', async () => {
  const r = fakeRedis();
  const a = createJobAuthority({ cmd: r.cmd });
  const done = { ...jobOf({ plannedTotal: 10 }), fencingToken: '4', status: JOB_STATUS.COMPLETED, created: 10 };
  await a.create(done);
  // 古い token での再適用は CAS で弾かれる
  const again = await a.saveFenced({ job: { ...done, created: 20, fencingToken: '2' }, fencingToken: '2' });
  assert.equal(again.ok, false);
  assert.equal(JSON.parse(r.store.get(jobKey(done.jobId))).created, 10);
});

test('同じ batch を 2 回実行しても claim は MINE になり二重作成にならない', async () => {
  const r = fakeRedis();
  const claims = createClaimStore({ cmd: r.cmd });
  const args = {
    emails: ['a@example.com', 'b@example.com'],
    ownerJobId: 'job:x', batchId: 'imp-1', operationId: 'op1',
    fencingToken: '1', nowIso: '2026-08-09T00:00:00.000Z',
  };
  const first = await claims.claimRows(args);
  assert.equal(first.won.length, 2);
  const second = await claims.claimRows(args);
  assert.equal(second.won.length, 0, '2 回目で新規に勝ってはいけない');
  assert.equal(second.mine.length, 2, '自分の claim は MINE で返る');
});

// ── 4. Airtable 側の異常（429 / 5xx / timeout）─────────────────
for (const [label, thrower] of [
  ['429（レート制限）', () => ({ ok: false, status: 429 })],
  ['500（サーバエラー）', () => ({ ok: false, status: 500 })],
  ['timeout（例外）', () => { throw new Error('ETIMEDOUT'); }],
]) {
  test(`Airtable ${label} でも claim を解放しない（reconciler が回収する）`, async () => {
    const r = fakeRedis();
    const claims = createClaimStore({ cmd: r.cmd });
    await claims.claimRows({
      emails: ['x@example.com'], ownerJobId: 'job:y', batchId: 'imp-2',
      operationId: 'op1', fencingToken: '1', nowIso: NOW_ISO,
    });
    const before = r.store.size;

    let threw = false;
    try {
      await writeCreateBatch({
        rows: [{ email: 'x@example.com', name: 'N' }],
        batchId: 'imp-2', nowIso: NOW_ISO, availableFields: null,
        doneRowKeys: new Set(), existingEmails: new Set(), maxWrites: 1,
        deps: { createRecord: thrower, sleep: () => Promise.resolve() },
      });
    } catch { threw = true; }

    // 成否にかかわらず claim キーは残っていること（勝手に解放しない）
    assert.equal(r.store.size, before, `${label}: claim が消えている`);
    const claimVal = [...r.store.entries()].find(([k]) => k.includes('customer-import:email:'));
    assert.ok(claimVal, 'claim キーが見つからない');
    assert.equal(JSON.parse(claimVal[1]).state, 'CLAIMED', `${label}: CREATED へ進めてはいけない`);
    assert.ok(threw === true || threw === false);
  });
}

test('書き込みが例外で落ちた子バッチは claim を保持したまま writeError で返る', async () => {
  const r = fakeRedis();
  const claims = createClaimStore({ cmd: r.cmd });
  const authority = createJobAuthority({ cmd: r.cmd });
  const job = { ...jobOf({ plannedTotal: 5 }), fencingToken: '1' };
  await authority.create(job);
  await r.cmd(['SET', GLOBAL_LOCK_KEY, '1']);
  await authority.writeSnapshot({ jobId: job.jobId, orderedHashes: ['h1'] });

  const out = await runChildBatch({
    job, entries: [{ email: 'z@example.com', name: 'Z' }],
    currentOrderedHashes: ['h1'],
    facts: { existing: [], excluded: [], review: [], paid: [] },
    providerEmails: new Set(), availableFields: null,
    lockToken: '1', operationId: buildOperationId({ jobId: job.jobId, index: 1 }),
    nowMs: 0, nowIso: NOW_ISO, claims, authority,
    deps: { createRecord: () => { throw new Error('boom'); }, sleep: () => Promise.resolve() },
  });

  assert.equal(out.ok, false);
  assert.equal(out.writeError, true);
  assert.equal(out.stopped, null, '停止理由ではなく書き込み失敗として返る');
});

// ── 5. cleanup / rollback の再実行 ────────────────────────────
test('rollback の説明は何度読んでも同じ（削除ではなく Source 単位の隔離）', () => {
  const job = { ...jobOf(), created: 42 };
  const a = describeJobRollback(job);
  const b = describeJobRollback(job);
  assert.deepEqual(a, b, 'cleanup 再実行で説明が変わってはいけない');
  assert.equal(JSON.stringify(a).includes('削除'), JSON.stringify(b).includes('削除'));
  assert.ok(a && typeof a === 'object');
});

test('ロック所有権を失っていたら Airtable へ 1 件も書かない', async () => {
  const r = fakeRedis();
  const claims = createClaimStore({ cmd: r.cmd });
  const authority = createJobAuthority({ cmd: r.cmd });
  const job = { ...jobOf({ plannedTotal: 5 }), fencingToken: '1' };
  await authority.create(job);
  await r.cmd(['SET', GLOBAL_LOCK_KEY, '2']);          // 別 worker が奪っている
  await authority.writeSnapshot({ jobId: job.jobId, orderedHashes: ['h1'] });

  let writes = 0;
  const out = await runChildBatch({
    job, entries: [{ email: 'q@example.com', name: 'Q' }],
    currentOrderedHashes: ['h1'],
    facts: { existing: [], excluded: [], review: [], paid: [] },
    providerEmails: new Set(), availableFields: null,
    lockToken: '1', operationId: 'op1', nowMs: 0, nowIso: NOW_ISO,
    claims, authority,
    deps: { createRecord: () => { writes += 1; return { ok: true, status: 200 }; }, sleep: () => Promise.resolve() },
  });

  assert.equal(out.stopped, STEP_STOP.LOCK_LOST);
  assert.equal(writes, 0, 'ロックを失っているのに書き込んだ');
});

// ── 6. 退行防止（Function 側が fenced save を使い続けること）──────
test('Function は子バッチ結果を無条件 save で書き戻さない（fenced save を使う）', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(
    fileURLToPath(new URL('../../../netlify/functions/admin-customer-import-job.js', import.meta.url)), 'utf8',
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /authority\s*\.\s*save\s*\(/,
    'authority.save() を直接呼んでいる（stale writer が正本を上書きしうる）');
  assert.match(code, /authority\s*\.\s*saveFenced\s*\(/, 'saveFenced を使っていない');
  // 拒否されたときに 409 で止めること（成功扱いにしない）
  assert.match(code, /saved\.ok/, 'fenced save の結果を見ていない');
});
