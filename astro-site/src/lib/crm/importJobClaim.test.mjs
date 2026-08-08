/**
 * importJobClaim.test.mjs — グローバルロック / 行 claim / fail-closed を固定する
 *   node --test src/lib/crm/importJobClaim.test.mjs
 *
 * ⚠️ **Redis 本体へは 1 コマンドも送らない。** `cmd` を注入した fake で検証する。
 *
 * ⚠️ 限界の明示: Lua スクリプトの**本文は実行していない**（サーバ側でしか動かないため）。
 *    fake は `CLAIM_ROWS_LUA` などの**識別子で分岐し、同じ意味論を JS で再現**している。
 *    Lua 本文そのものの正しさは Redis canary（本番前の少量実行）で確認する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createClaimStore, emailClaimKey, emailHash,
  CLAIM_ROWS_LUA, MARK_CREATED_LUA, VERIFY_LOCK_LUA, RENEW_LOCK_LUA, RELEASE_LOCK_LUA,
  GLOBAL_LOCK_KEY, FENCE_KEY, EMAIL_CLAIM_PREFIX, CLAIM_STATE,
  RedisUnavailableError, REDIS_FAIL,
} from './importClaimStore.js';
import { createJobAuthority, buildJobRecord, computeSnapshotFingerprint, ORDERING_VERSION } from './importJobAuthority.js';
import { canReleaseClaim, reconcileImportJob, RECONCILE_VERDICT } from './importJobReconcile.js';

/** 手動クロック付きの Redis fake（EVAL は意味論を JS で再現）*/
function fakeRedis({ now = 0 } = {}) {
  const store = new Map();   // key -> { v, exp|null }
  const state = { now, fence: 0, fail: null, unknown: false };
  const alive = (k) => {
    const e = store.get(k);
    if (!e) return null;
    if (e.exp !== null && e.exp <= state.now) { store.delete(k); return null; }
    return e;
  };
  const cmd = async (args) => {
    if (state.fail) throw new Error(state.fail);
    if (state.unknown) return undefined;
    const [op] = args;
    if (op === 'INCR') { state.fence += 1; return state.fence; }
    if (op === 'GET') { const e = alive(args[1]); return e ? e.v : null; }
    if (op === 'DEL') { store.delete(args[1]); return 1; }
    if (op === 'SET') {
      const [, key, val, ...rest] = args;
      const nx = rest.includes('NX');
      const exIdx = rest.indexOf('EX');
      const exp = exIdx > -1 ? state.now + Number(rest[exIdx + 1]) * 1000 : null;
      if (nx && alive(key)) return null;
      store.set(key, { v: val, exp });
      return 'OK';
    }
    if (op === 'EVAL') {
      const [, script, nKeysRaw, ...tail] = args;
      const nKeys = Number(nKeysRaw);
      const keys = tail.slice(0, nKeys);
      const argv = tail.slice(nKeys);
      if (script === VERIFY_LOCK_LUA) {
        const e = alive(keys[0]);
        if (!e) return 'LOST';
        return e.v === argv[0] ? 'OK' : 'STOLEN';
      }
      if (script === RENEW_LOCK_LUA) {
        const e = alive(keys[0]);
        if (!e) return 'LOST';
        if (e.v !== argv[0]) return 'STOLEN';
        e.exp = state.now + Number(argv[1]);
        return 'OK';
      }
      if (script === RELEASE_LOCK_LUA) {
        const e = alive(keys[0]);
        if (!e) return 'LOST';
        if (e.v !== argv[0]) return 'STOLEN';
        store.delete(keys[0]);
        return 'OK';
      }
      if (script === CLAIM_ROWS_LUA) {
        const [owner, batch, op2, fence, nowIso, expires, ttl] = argv;
        return keys.map((k) => {
          const e = alive(k);
          if (!e) {
            store.set(k, {
              v: JSON.stringify({
                ownerJobId: owner, batchId: batch, operationId: op2, fencingToken: fence,
                state: 'CLAIMED', claimedAt: nowIso, expiresAt: expires,
              }),
              exp: state.now + Number(ttl) * 1000,
            });
            return 'OK';
          }
          const cur = JSON.parse(e.v);
          if (cur.state === 'CREATED') return 'CREATED';
          if (cur.ownerJobId === owner && cur.state === 'CLAIMED') return 'MINE';
          return 'TAKEN';
        });
      }
      if (script === MARK_CREATED_LUA) {
        const [owner] = argv;
        return keys.map((k) => {
          const e = alive(k);
          if (!e) return 'MISSING';
          const cur = JSON.parse(e.v);
          if (cur.ownerJobId !== owner) return 'NOT_MINE';
          cur.state = 'CREATED';
          e.v = JSON.stringify(cur);
          return 'OK';
        });
      }
      throw new Error('unknown script');
    }
    throw new Error('unsupported op ' + op);
  };
  return { cmd, state, store, advance: (ms) => { state.now += ms; } };
}

const NOW_ISO = '2026-08-05T03:00:00.000Z';
const JOB_A = 'job:imp-2026-08-05-004';
const JOB_B = 'job:imp-2026-08-05-005';

// ── 行 claim: グローバル一意（batchId で区切らない）──────────────

test('claim キーは batchId を含まない（正規化メールに対してグローバル）', () => {
  const k = emailClaimKey('User@Example.invalid');
  assert.ok(k.startsWith(EMAIL_CLAIM_PREFIX));
  assert.equal(k.includes('imp-2026'), false, 'batchId が混ざっている');
  // batchId が違っても同じキーになる = 別 batch から同時に取れない
  assert.equal(emailClaimKey('user@example.invalid'), k);
});

test('大文字小文字・前後空白・全角の差は同じ claim キーになる', () => {
  const base = emailClaimKey('user@example.invalid');
  for (const v of ['USER@EXAMPLE.INVALID', '  user@example.invalid  ', 'User@Example.Invalid',
    'mailto:user@example.invalid', '<user@example.invalid>']) {
    assert.equal(emailClaimKey(v), base, `${v} が別キーになっている`);
  }
  assert.equal(emailHash('USER@EXAMPLE.INVALID'), emailHash('user@example.invalid'));
});

test('異なる batchId が同じメールを同時 claim できない', async () => {
  const r = fakeRedis();
  const claims = createClaimStore({ cmd: r.cmd });
  const emails = ['dup@example.invalid'];

  const a = await claims.claimRows({
    emails, ownerJobId: JOB_A, batchId: 'imp-004', operationId: 'op-a',
    fencingToken: '1', nowIso: NOW_ISO,
  });
  assert.deepEqual(a.won, ['dup@example.invalid']);

  // 別ジョブ・**別 batchId** が同じメールを取りに行く
  const b = await claims.claimRows({
    emails, ownerJobId: JOB_B, batchId: 'imp-005', operationId: 'op-b',
    fencingToken: '2', nowIso: NOW_ISO,
  });
  assert.deepEqual(b.won, [], '別 batchId が奪えてしまった（二重作成の穴）');
  assert.deepEqual(b.taken, ['dup@example.invalid']);
});

test('異なる CSV に同じメールがあっても claim は 1 回だけ勝つ', async () => {
  const r = fakeRedis();
  const claims = createClaimStore({ cmd: r.cmd });
  const first = await claims.claimRows({
    emails: ['same@example.invalid'], ownerJobId: JOB_A, batchId: 'b1',
    operationId: 'o1', fencingToken: '1', nowIso: NOW_ISO,
  });
  const second = await claims.claimRows({
    emails: ['  SAME@example.invalid '], ownerJobId: JOB_B, batchId: 'b2',
    operationId: 'o2', fencingToken: '2', nowIso: NOW_ISO,
  });
  assert.equal(first.won.length, 1);
  assert.equal(second.won.length, 0);
  assert.equal(second.taken.length, 1);
});

test('自分の claim は MINE として再取得できる（再送・再開で二重作成しない）', async () => {
  const r = fakeRedis();
  const claims = createClaimStore({ cmd: r.cmd });
  const emails = ['a@example.invalid'];
  await claims.claimRows({ emails, ownerJobId: JOB_A, batchId: 'b', operationId: 'o1', fencingToken: '1', nowIso: NOW_ISO });
  const again = await claims.claimRows({ emails, ownerJobId: JOB_A, batchId: 'b', operationId: 'o2', fencingToken: '2', nowIso: NOW_ISO });
  assert.deepEqual(again.mine, emails);
  assert.deepEqual(again.won, []);
});

test('CREATED の claim は誰も取り直せない', async () => {
  const r = fakeRedis();
  const claims = createClaimStore({ cmd: r.cmd });
  const emails = ['done@example.invalid'];
  await claims.claimRows({ emails, ownerJobId: JOB_A, batchId: 'b', operationId: 'o', fencingToken: '1', nowIso: NOW_ISO });
  await claims.markRowsCreated({ emails, ownerJobId: JOB_A, nowIso: NOW_ISO });
  const other = await claims.claimRows({ emails, ownerJobId: JOB_B, batchId: 'b2', operationId: 'o2', fencingToken: '2', nowIso: NOW_ISO });
  assert.deepEqual(other.created, emails);
  assert.deepEqual(other.won, []);
  const c = await claims.readClaim('done@example.invalid');
  assert.equal(c.state, CLAIM_STATE.CREATED);
});

// ── グローバルロック ──────────────────────────────────────────

test('グローバルロックは 1 つしか取れない（異なる batchId 同士も拒否）', async () => {
  const r = fakeRedis();
  const a = createClaimStore({ cmd: r.cmd });
  const b = createClaimStore({ cmd: r.cmd });
  const l1 = await a.acquireGlobalLock({ ttlMs: 60_000 });
  assert.equal(l1.ok, true);
  const l2 = await b.acquireGlobalLock({ ttlMs: 60_000 });
  assert.equal(l2.ok, false, '2 つ目のジョブがロックを取れてしまった');
  assert.equal(l2.reason, 'locked');
});

test('fencing token は単調増加する', async () => {
  const r = fakeRedis();
  const claims = createClaimStore({ cmd: r.cmd });
  const t1 = await claims.nextFencingToken();
  const t2 = await claims.nextFencingToken();
  assert.ok(Number(t2) > Number(t1));
});

test('lease 失効の直前は保持・直後は他者が取れる', async () => {
  const r = fakeRedis();
  const a = createClaimStore({ cmd: r.cmd });
  const b = createClaimStore({ cmd: r.cmd });
  const l = await a.acquireGlobalLock({ ttlMs: 60_000 });

  r.advance(59_000);   // 失効直前
  assert.equal((await a.verifyLockOwnership(l.token)).ok, true);
  assert.equal((await b.acquireGlobalLock({ ttlMs: 60_000 })).ok, false);

  r.advance(2_000);    // 失効直後
  assert.equal((await a.verifyLockOwnership(l.token)).ok, false, '失効後も所有権が残っている');
  const l2 = await b.acquireGlobalLock({ ttlMs: 60_000 });
  assert.equal(l2.ok, true, '失効後に引き継げない');
});

test('stale writer は所有権の再検証で弾かれる', async () => {
  const r = fakeRedis();
  const a = createClaimStore({ cmd: r.cmd });
  const b = createClaimStore({ cmd: r.cmd });
  const old = await a.acquireGlobalLock({ ttlMs: 10_000 });
  r.advance(11_000);
  const fresh = await b.acquireGlobalLock({ ttlMs: 60_000 });
  assert.equal(fresh.ok, true);

  // 古い writer が書き込み直前に再検証すると STOLEN
  const v = await a.verifyLockOwnership(old.token);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'stolen');
  // 古い token では解放もできない
  assert.equal((await a.releaseGlobalLock(old.token)).ok, false);
});

test('lease 更新に失敗したら OK を返さない（次の子バッチへ進ませない）', async () => {
  const r = fakeRedis();
  const a = createClaimStore({ cmd: r.cmd });
  const l = await a.acquireGlobalLock({ ttlMs: 5_000 });
  r.advance(6_000);
  const renew = await a.renewLease(l.token, 60_000);
  assert.equal(renew.ok, false);
  assert.equal(renew.reason, 'lost');
});

// ── fail-closed（Redis 異常）──────────────────────────────────

test('Redis 到達不能は RedisUnavailableError で伝播する', async () => {
  const r = fakeRedis();
  r.state.fail = 'ECONNRESET';
  const claims = createClaimStore({ cmd: r.cmd });
  await assert.rejects(() => claims.acquireGlobalLock({}), (e) => {
    assert.ok(e instanceof RedisUnavailableError);
    return true;
  });
});

test('Lua の応答が不明なら fail-closed（claim したか分からないまま進めない）', async () => {
  const r = fakeRedis();
  const claims = createClaimStore({ cmd: r.cmd });
  r.state.unknown = true;   // undefined を返す
  await assert.rejects(() => claims.claimRows({
    emails: ['x@example.invalid'], ownerJobId: JOB_A, batchId: 'b',
    operationId: 'o', fencingToken: '1', nowIso: NOW_ISO,
  }), (e) => e instanceof RedisUnavailableError);
});

test('claim 結果の件数が合わなければ fail-closed', async () => {
  const cmd = async (args) => (args[0] === 'EVAL' ? ['OK'] : 1);   // 2 件頼んで 1 件返る
  const claims = createClaimStore({ cmd });
  await assert.rejects(() => claims.claimRows({
    emails: ['a@example.invalid', 'b@example.invalid'], ownerJobId: JOB_A,
    batchId: 'b', operationId: 'o', fencingToken: '1', nowIso: NOW_ISO,
  }), (e) => e instanceof RedisUnavailableError && e.code === REDIS_FAIL.UNKNOWN_RESULT);
});

test('ロック状態が解釈できなければ fail-closed', async () => {
  const cmd = async (args) => (args[0] === 'SET' ? 'WEIRD' : 1);
  const claims = createClaimStore({ cmd });
  await assert.rejects(() => claims.acquireGlobalLock({}),
    (e) => e instanceof RedisUnavailableError && e.code === REDIS_FAIL.LOCK_STATE_UNKNOWN);
});

// ── ジョブ正本（Redis）──────────────────────────────────────────

const sampleJob = (over = {}) => ({
  ...buildJobRecord({
    jobId: JOB_A, batchId: 'imp-2026-08-05-004', source: 'customer-import:imp-2026-08-05-004',
    fileFingerprint: 'ff', snapshotFingerprint: 'sf', plannedTotal: 14284,
    fencingToken: '1', operationId: 'op-0', nowIso: NOW_ISO,
  }),
  ...over,
});

test('正本には必須項目がすべて入る（PII は入れない）', async () => {
  const r = fakeRedis();
  const auth = createJobAuthority({ cmd: r.cmd });
  const job = sampleJob();
  for (const f of ['jobId', 'batchId', 'source', 'fileFingerprint', 'snapshotFingerprint',
    'plannedTotal', 'orderingVersion', 'cursor', 'attempted', 'created', 'skippedExisting',
    'failed', 'cancelledAt', 'status', 'currentChild', 'fencingToken', 'operationId',
    'childHistory', 'reconciliation', 'createdAt', 'updatedAt']) {
    assert.ok(f in job, `${f} が正本に無い`);
  }
  assert.equal((await auth.create(job)).created, true);
  assert.equal((await auth.create(job)).created, false, '二重作成できてしまった');
});

test('正本に PII が混ざったら保存を拒否する', async () => {
  const r = fakeRedis();
  const auth = createJobAuthority({ cmd: r.cmd });
  const bad = { ...sampleJob(), email: 'a@example.invalid' };
  const res = await auth.save(bad);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'invalid_job');
});

test('正本が壊れていたら data_loss_suspected で fail-closed', async () => {
  const r = fakeRedis();
  const auth = createJobAuthority({ cmd: r.cmd });
  await r.cmd(['SET', `customer-import:job:${JOB_A}`, JSON.stringify({ jobId: JOB_A })]);
  await assert.rejects(() => auth.load(JOB_A),
    (e) => e instanceof RedisUnavailableError && e.code === REDIS_FAIL.DATA_LOSS_SUSPECTED);
});

// ── snapshot ──────────────────────────────────────────────────

test('snapshot は chunk 分割して固定され、指紋で差し替えを検知する', async () => {
  const r = fakeRedis();
  const auth = createJobAuthority({ cmd: r.cmd });
  const hashes = Array.from({ length: 1201 }, (_, i) => emailHash(`u${i}@example.invalid`));
  const meta = await auth.writeSnapshot({ jobId: JOB_A, orderedHashes: hashes });
  assert.equal(meta.total, 1201);
  assert.equal(meta.chunks, 3, '単一 JSON に詰め込んでいる');
  assert.equal(meta.orderingVersion, ORDERING_VERSION);

  const back = await auth.readSnapshot(JOB_A);
  assert.deepEqual(back.hashes, hashes, '順序が保たれていない');

  assert.equal((await auth.verifySnapshot({ jobId: JOB_A, currentOrderedHashes: hashes })).ok, true);
  // 1 件でも違えば不一致
  const changed = [...hashes]; changed[500] = emailHash('other@example.invalid');
  const v = await auth.verifySnapshot({ jobId: JOB_A, currentOrderedHashes: changed });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'snapshot_changed');
  // 並び順が変わっても不一致
  assert.equal((await auth.verifySnapshot({ jobId: JOB_A, currentOrderedHashes: [...hashes].reverse() })).ok, false);
});

test('snapshot の chunk が欠けたら data_loss_suspected', async () => {
  const r = fakeRedis();
  const auth = createJobAuthority({ cmd: r.cmd });
  const hashes = Array.from({ length: 600 }, (_, i) => emailHash(`u${i}@example.invalid`));
  await auth.writeSnapshot({ jobId: JOB_A, orderedHashes: hashes });
  await r.cmd(['DEL', `customer-import:job:${JOB_A}:snap:1`]);
  await assert.rejects(() => auth.readSnapshot(JOB_A),
    (e) => e instanceof RedisUnavailableError && e.code === REDIS_FAIL.DATA_LOSS_SUSPECTED);
});

test('snapshot メタが消えていたら fail-closed（黙って新規扱いにしない）', async () => {
  const r = fakeRedis();
  const auth = createJobAuthority({ cmd: r.cmd });
  await assert.rejects(() => auth.verifySnapshot({ jobId: JOB_A, currentOrderedHashes: [] }),
    (e) => e instanceof RedisUnavailableError);
});

test('snapshot 指紋は順序に依存する', () => {
  assert.notEqual(computeSnapshotFingerprint(['a', 'b']), computeSnapshotFingerprint(['b', 'a']));
});

// ── claim 取得後・create 前のクラッシュ / 応答消失 ───────────────

test('claim 取得後に create しなかった行は CLAIMED のまま残る（勝手に解放しない）', async () => {
  const r = fakeRedis();
  const claims = createClaimStore({ cmd: r.cmd });
  await claims.claimRows({
    emails: ['crash@example.invalid'], ownerJobId: JOB_A, batchId: 'b',
    operationId: 'o', fencingToken: '1', nowIso: NOW_ISO,
  });
  // create せずに落ちた → claim は残る
  const c = await claims.readClaim('crash@example.invalid');
  assert.equal(c.state, CLAIM_STATE.CLAIMED);
  // 他ジョブは取れない（＝二重作成しない）
  const other = await claims.claimRows({
    emails: ['crash@example.invalid'], ownerJobId: JOB_B, batchId: 'b2',
    operationId: 'o2', fencingToken: '2', nowIso: NOW_ISO,
  });
  assert.deepEqual(other.won, []);
});

test('create は成功したが応答が消えた場合、claim は CLAIMED のままで再作成されない', async () => {
  const r = fakeRedis();
  const claims = createClaimStore({ cmd: r.cmd });
  const emails = ['lost-response@example.invalid'];
  await claims.claimRows({ emails, ownerJobId: JOB_A, batchId: 'b', operationId: 'o', fencingToken: '1', nowIso: NOW_ISO });
  // markRowsCreated が届かなかった状況。再実行しても他者は取れない
  const retry = await claims.claimRows({ emails, ownerJobId: JOB_B, batchId: 'b2', operationId: 'o2', fencingToken: '2', nowIso: NOW_ISO });
  assert.deepEqual(retry.won, []);
  // 自分の再実行では MINE になるが、Customers 実在判定（第二防御）が作成済みを弾く
  const mine = await claims.claimRows({ emails, ownerJobId: JOB_A, batchId: 'b', operationId: 'o3', fencingToken: '3', nowIso: NOW_ISO });
  assert.deepEqual(mine.mine, emails);
});

// ── reconciler による安全な解放 ────────────────────────────────

const expiredClaim = (over = {}) => ({
  ownerJobId: JOB_A, batchId: 'b', operationId: 'o', fencingToken: '1',
  state: 'CLAIMED', claimedAt: NOW_ISO, expiresAt: '2026-08-05T03:10:00.000Z', ...over,
});
const LATER = Date.parse('2026-08-05T04:00:00.000Z');

test('reconciler は 4 条件すべてを満たすときだけ解放する', () => {
  const base = { claim: expiredClaim(), absentInCustomers: true, absentForSource: true, nowMs: LATER, currentFencingToken: '9' };
  assert.equal(canReleaseClaim(base).ok, true);

  assert.equal(canReleaseClaim({ ...base, absentInCustomers: false }).reason, 'present_in_customers');
  assert.equal(canReleaseClaim({ ...base, absentForSource: false }).reason, 'present_for_source');
  assert.equal(canReleaseClaim({ ...base, nowMs: Date.parse('2026-08-05T03:05:00.000Z') }).reason, 'not_expired');
  assert.equal(canReleaseClaim({ ...base, currentFencingToken: '1' }).reason, 'fencing_token_still_current');
  assert.equal(canReleaseClaim({ ...base, claim: expiredClaim({ state: 'CREATED' }) }).reason, 'already_created');
});

test('store 側も未検証の解放要求を拒否する（最終ガード）', async () => {
  const r = fakeRedis({ now: LATER });
  const claims = createClaimStore({ cmd: r.cmd });
  await claims.claimRows({
    emails: ['rel@example.invalid'], ownerJobId: JOB_A, batchId: 'b',
    operationId: 'o', fencingToken: '1', nowIso: NOW_ISO,
  });
  const bad = await claims.releaseClaimByReconciler({
    rawEmail: 'rel@example.invalid', expectedOwnerJobId: JOB_A,
    currentFencingToken: '9', nowMs: LATER, checks: { absentInCustomers: false, absentForSource: true },
  });
  assert.equal(bad.released, false);
  assert.equal(bad.reason, 'customers_present_or_unchecked');

  // checks 未指定でも解放しない
  const none = await claims.releaseClaimByReconciler({
    rawEmail: 'rel@example.invalid', currentFencingToken: '9', nowMs: LATER,
  });
  assert.equal(none.released, false);
});

// ── 4 点突合 ──────────────────────────────────────────────────

const reconJob = (over = {}) => ({
  plannedTotal: 14284, attempted: 100, created: 100, skippedExisting: 0, failed: 0, ...over,
});

test('4 点が一致すれば OK・続行可', () => {
  const r = reconcileImportJob({
    job: reconJob(),
    claimCounts: { CLAIMED: 0, CREATED: 100, RELEASE_PENDING: 0 },
    airtableSourceCount: 100, duplicateEmailPairs: 10, duplicateEmailPairsBaseline: 10,
  });
  assert.equal(r.verdict, RECONCILE_VERDICT.OK);
  assert.equal(r.canContinue, true);
});

test('重複が増えたら BLOCKED（自動続行しない）', () => {
  const r = reconcileImportJob({
    job: reconJob(),
    claimCounts: { CLAIMED: 0, CREATED: 100, RELEASE_PENDING: 0 },
    airtableSourceCount: 100, duplicateEmailPairs: 11, duplicateEmailPairsBaseline: 10,
  });
  assert.equal(r.verdict, RECONCILE_VERDICT.BLOCKED);
  assert.equal(r.canContinue, false);
  assert.ok(r.failedChecks.includes('no_new_duplicates'));
});

test('Airtable 実測とジョブ counters が食い違えば BLOCKED', () => {
  const r = reconcileImportJob({
    job: reconJob(),
    claimCounts: { CLAIMED: 0, CREATED: 100, RELEASE_PENDING: 0 },
    airtableSourceCount: 97, duplicateEmailPairs: 10, duplicateEmailPairsBaseline: 10,
  });
  assert.equal(r.verdict, RECONCILE_VERDICT.BLOCKED);
  assert.ok(r.failedChecks.includes('created_matches_airtable'));
});

test('claim 済み・未作成が残れば PARTIAL（続行しない）', () => {
  const r = reconcileImportJob({
    job: reconJob({ attempted: 100, created: 98, failed: 2 }),
    claimCounts: { CLAIMED: 2, CREATED: 98, RELEASE_PENDING: 0 },
    airtableSourceCount: 98, duplicateEmailPairs: 10, duplicateEmailPairsBaseline: 10,
  });
  assert.equal(r.verdict, RECONCILE_VERDICT.PARTIAL);
  assert.equal(r.canContinue, false);
  assert.equal(r.claimedNotCreated, 2);
});

test('counters の内訳が試行数と合わなければ BLOCKED', () => {
  const r = reconcileImportJob({
    job: reconJob({ attempted: 100, created: 50, skippedExisting: 0, failed: 0 }),
    claimCounts: { CLAIMED: 0, CREATED: 50, RELEASE_PENDING: 0 },
    airtableSourceCount: 50, duplicateEmailPairs: 10, duplicateEmailPairsBaseline: 10,
  });
  assert.equal(r.verdict, RECONCILE_VERDICT.BLOCKED);
  assert.ok(r.failedChecks.includes('counters_balanced'));
});
