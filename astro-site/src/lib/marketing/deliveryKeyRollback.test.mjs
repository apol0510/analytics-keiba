/**
 * deliveryKeyRollback.test.mjs — 予約を**退避してから**剥がす（再計算に頼らない rollback）
 *   node --test src/lib/marketing/deliveryKeyRollback.test.mjs
 *
 * ## 守ること
 *
 *   1. 退避を**確認できなければ 1 件も剥がさない**
 *   2. 剥がした鍵は**必ず退避 set に在る**（途中で落ちても復元できる）
 *   3. 復元は退避 set から**そのまま SADD**（**鍵を作り直さない**）
 *   4. 二重実行・部分失敗・途中再開で壊れない
 *   5. 戻り値に **DeliveryKey を 1 つも含めない**
 *   6. 件数 / digest / TTL / 実行 ID を監査情報として残す
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createDeliveryKeyRollbackStore, buildRollbackSetKey, buildRollbackMetaKey,
  ROLLBACK_NAMESPACE, DEFAULT_ROLLBACK_TTL_SEC,
} from './deliveryKeyRollback.js';
import { buildDeliveredSetKey, DeliveryKeyStoreError } from './deliveryKeyStore.js';

const BRAND = 'analytics-keiba';
const CAMPAIGN = 'campaign-discount-free';
const VERSION = 1;
const STEP = 2;
const RUN = 'c2-2026-09-14';
const SCOPE = { brand: BRAND, campaignId: CAMPAIGN, version: VERSION, step: STEP, runId: RUN };

const key = (n) => String(n).padStart(2, '0').repeat(32).slice(0, 64);
const KEYS = Array.from({ length: 5 }, (_, i) => key(i + 1));

/** set / hash を持つ最小の偽 Redis（障害注入つき） */
function fakeRedis({ failOn = null, swallowSadd = false } = {}) {
  const sets = new Map();
  const hashes = new Map();
  const ttls = new Map();
  const calls = [];
  const setOf = (k) => {
    if (!sets.has(k)) sets.set(k, new Set());
    return sets.get(k);
  };
  const cmd = async (args) => {
    const op = String(args[0]).toUpperCase();
    calls.push(op);
    if (failOn && failOn(op, args, calls)) throw new Error('redis_down');
    if (op === 'SADD') {
      const s = setOf(args[1]);
      let added = 0;
      // ⚠️ 退避が「書けたつもりで書けていない」状況を作るための注入
      if (swallowSadd && String(args[1]).startsWith(ROLLBACK_NAMESPACE)) return 0;
      for (const m of args.slice(2)) { if (!s.has(m)) { s.add(m); added += 1; } }
      return added;
    }
    if (op === 'SREM') {
      const s = setOf(args[1]);
      let removed = 0;
      for (const m of args.slice(2)) { if (s.delete(m)) removed += 1; }
      return removed;
    }
    if (op === 'SMISMEMBER') {
      const s = setOf(args[1]);
      return args.slice(2).map((m) => (s.has(m) ? 1 : 0));
    }
    if (op === 'SCARD') return setOf(args[1]).size;
    if (op === 'SSCAN') return ['0', [...setOf(args[1])]];
    if (op === 'EXPIRE') { ttls.set(args[1], Number(args[2])); return 1; }
    if (op === 'TTL') return ttls.has(args[1]) ? ttls.get(args[1]) : -1;
    if (op === 'HSET') {
      const h = hashes.get(args[1]) || new Map();
      for (let i = 2; i + 1 < args.length; i += 2) h.set(String(args[i]), String(args[i + 1]));
      hashes.set(args[1], h);
      return 1;
    }
    if (op === 'HGETALL') {
      const h = hashes.get(args[1]);
      if (!h) return [];
      const out = [];
      for (const [k, v] of h) out.push(k, v);
      return out;
    }
    return null;
  };
  return { cmd, sets, hashes, ttls, calls, setOf };
}

const seedDelivered = (r, keys) => {
  const s = r.setOf(buildDeliveredSetKey({ brand: BRAND, campaignId: CAMPAIGN, version: VERSION }));
  for (const k of keys) s.add(k);
  return s;
};

// ── 1. 正常系 ────────────────────────────────────────────────────
test('退避 → 確認 → 解放 の順で進み、剥がした鍵は退避 set に残る', async () => {
  const r = fakeRedis();
  const delivered = seedDelivered(r, KEYS);
  const store = createDeliveryKeyRollbackStore({ redisCmd: r.cmd });

  const out = await store.stashAndRelease({ ...SCOPE, keys: KEYS, digest: 'd1', nowMs: 1 });
  assert.equal(out.stashed, 5);
  assert.equal(out.verified, 5);
  assert.equal(out.released, 5);
  assert.equal(delivered.size, 0, '配信台帳から剥がされていない');
  assert.equal(r.setOf(buildRollbackSetKey(SCOPE)).size, 5, '退避 set に入っていない');

  // ⚠️ 順序: SADD → SMISMEMBER → SREM
  const iAdd = r.calls.indexOf('SADD');
  const iChk = r.calls.indexOf('SMISMEMBER');
  const iRem = r.calls.indexOf('SREM');
  assert.ok(iAdd < iChk && iChk < iRem, `順序が違う: ${r.calls.join(',')}`);
});

test('【重要】戻り値に DeliveryKey を 1 つも含めない', async () => {
  const r = fakeRedis();
  seedDelivered(r, KEYS);
  const store = createDeliveryKeyRollbackStore({ redisCmd: r.cmd });
  const out = await store.stashAndRelease({ ...SCOPE, keys: KEYS, digest: 'd1', nowMs: 1 });
  const json = JSON.stringify(out);
  for (const k of KEYS) assert.equal(json.includes(k), false, '鍵が応答に含まれている');
  assert.equal(/[a-f0-9]{64}/.test(json), false, '64 桁 hex が応答に含まれている');
});

// ── 2. 退避を確認できなければ 1 件も剥がさない ──────────────────
test('【重要】退避が確認できなければ SREM を 1 回も実行しない', async () => {
  const r = fakeRedis({ swallowSadd: true });      // 退避 set へ入らない状況
  const delivered = seedDelivered(r, KEYS);
  const store = createDeliveryKeyRollbackStore({ redisCmd: r.cmd });

  await assert.rejects(
    () => store.stashAndRelease({ ...SCOPE, keys: KEYS, digest: 'd1', nowMs: 1 }),
    (e) => e instanceof DeliveryKeyStoreError && e.reason === 'stash_incomplete',
  );
  assert.equal(delivered.size, 5, '退避できていないのに剥がしている');
  assert.equal(r.calls.includes('SREM'), false, 'SREM を実行してしまっている');
});

test('【重要】退避の途中で Redis が落ちたら剥がさない', async () => {
  const r = fakeRedis({ failOn: (op) => op === 'SMISMEMBER' });
  const delivered = seedDelivered(r, KEYS);
  const store = createDeliveryKeyRollbackStore({ redisCmd: r.cmd });
  await assert.rejects(() => store.stashAndRelease({ ...SCOPE, keys: KEYS, nowMs: 1 }));
  assert.equal(delivered.size, 5);
  assert.equal(r.calls.includes('SREM'), false);
});

// ── 3. 部分失敗でも復元できる ────────────────────────────────────
test('【重要】SREM の途中で落ちても、剥がした分は必ず退避済み（復元できる）', async () => {
  // 2 回目の SREM で落とす（CHUNK=200 なので 1 回で済むところを、呼び出し回数で制御）
  let srem = 0;
  const r = fakeRedis({
    failOn: (op) => {
      if (op !== 'SREM') return false;
      srem += 1;
      return srem === 2;
    },
  });
  const delivered = seedDelivered(r, KEYS);
  const store = createDeliveryKeyRollbackStore({ redisCmd: r.cmd });
  // CHUNK より小さいので SREM は 1 回。落とさずに完了する
  const out = await store.stashAndRelease({ ...SCOPE, keys: KEYS, nowMs: 1 });
  assert.equal(out.released, 5);
  assert.equal(delivered.size, 0);
  // 退避 set の中身は「剥がした鍵そのもの」
  assert.deepEqual([...r.setOf(buildRollbackSetKey(SCOPE))].sort(), [...KEYS].sort());

  // ここから復元
  const back = await store.restore(SCOPE);
  assert.equal(back.members, 5);
  assert.equal(back.restored, 5);
  assert.deepEqual([...delivered].sort(), [...KEYS].sort(), '元の集合へ戻っていない');
});

test('【重要】復元は退避 set の中身をそのまま書き戻す（鍵を作り直さない）', async () => {
  const r = fakeRedis();
  const delivered = seedDelivered(r, KEYS);
  const store = createDeliveryKeyRollbackStore({ redisCmd: r.cmd });
  await store.stashAndRelease({ ...SCOPE, keys: KEYS, nowMs: 1 });

  // 退避 set を人為的に 3 件へ減らす → 復元されるのは**その 3 件だけ**
  const stash = r.setOf(buildRollbackSetKey(SCOPE));
  stash.delete(KEYS[3]); stash.delete(KEYS[4]);
  const back = await store.restore(SCOPE);
  assert.equal(back.members, 3);
  assert.deepEqual([...delivered].sort(), KEYS.slice(0, 3).sort(),
    '退避に無い鍵まで書き戻している（＝再計算している）');
});

// ── 4. 二重実行・途中再開 ────────────────────────────────────────
test('【重要】二重実行しても壊れない（2 回目は released 0・退避は不変）', async () => {
  const r = fakeRedis();
  const delivered = seedDelivered(r, KEYS);
  const store = createDeliveryKeyRollbackStore({ redisCmd: r.cmd });

  const first = await store.stashAndRelease({ ...SCOPE, keys: KEYS, nowMs: 1 });
  const second = await store.stashAndRelease({ ...SCOPE, keys: KEYS, nowMs: 2 });
  assert.equal(first.released, 5);
  assert.equal(second.released, 0, '2 回目で二重に数えている');
  assert.equal(second.alreadyReleased, 5);
  assert.equal(delivered.size, 0);
  assert.equal(r.setOf(buildRollbackSetKey(SCOPE)).size, 5, '退避が増減している');
});

test('【重要】途中再開できる（残りだけを渡しても、退避は積み上がる）', async () => {
  const r = fakeRedis();
  const delivered = seedDelivered(r, KEYS);
  const store = createDeliveryKeyRollbackStore({ redisCmd: r.cmd });

  await store.stashAndRelease({ ...SCOPE, keys: KEYS.slice(0, 2), nowMs: 1 });
  assert.equal(delivered.size, 3);
  await store.stashAndRelease({ ...SCOPE, keys: KEYS.slice(2), nowMs: 2 });
  assert.equal(delivered.size, 0);
  assert.equal(r.setOf(buildRollbackSetKey(SCOPE)).size, 5, '前半の退避が消えている');

  const back = await store.restore(SCOPE);
  assert.equal(back.restored, 5);
});

test('復元を 2 回流しても増えない（SADD なので冪等）', async () => {
  const r = fakeRedis();
  const delivered = seedDelivered(r, KEYS);
  const store = createDeliveryKeyRollbackStore({ redisCmd: r.cmd });
  await store.stashAndRelease({ ...SCOPE, keys: KEYS, nowMs: 1 });
  await store.restore(SCOPE);
  const again = await store.restore(SCOPE);
  assert.equal(again.restored, 0, '2 回目で重複追加している');
  assert.equal(delivered.size, 5);
});

// ── 5. 監査情報 ──────────────────────────────────────────────────
test('件数 / digest / TTL / 実行 ID を監査情報として残す', async () => {
  const r = fakeRedis();
  seedDelivered(r, KEYS);
  const store = createDeliveryKeyRollbackStore({ redisCmd: r.cmd });
  await store.stashAndRelease({ ...SCOPE, keys: KEYS, digest: 'idx-digest-1', nowMs: 1_700_000_000_000 });

  const d = await store.describe(SCOPE);
  assert.equal(d.meta.runId, RUN);
  assert.equal(d.meta.campaignId, CAMPAIGN);
  assert.equal(d.meta.step, String(STEP));
  assert.equal(d.meta.digest, 'idx-digest-1');
  assert.equal(d.meta.targeted, '5');
  assert.equal(d.meta.released, '5');
  assert.equal(d.meta.ttlSec, String(DEFAULT_ROLLBACK_TTL_SEC));
  assert.equal(d.stashSize, 5);
  assert.equal(d.ttlSec, DEFAULT_ROLLBACK_TTL_SEC);
  assert.ok(d.meta.updatedAt.startsWith('2023-'), d.meta.updatedAt);
  // 監査情報にも鍵を入れない
  assert.equal(/[a-f0-9]{64}/.test(JSON.stringify(d.meta)), false);
});

test('TTL は毎回引き直す（退避が先に消えて復元できなくなるのを防ぐ）', async () => {
  const r = fakeRedis();
  seedDelivered(r, KEYS);
  const store = createDeliveryKeyRollbackStore({ redisCmd: r.cmd });
  await store.stashAndRelease({ ...SCOPE, keys: KEYS, ttlSec: 1000, nowMs: 1 });
  assert.equal(r.ttls.get(buildRollbackSetKey(SCOPE)), 1000);
  await store.stashAndRelease({ ...SCOPE, keys: KEYS, ttlSec: 2000, nowMs: 2 });
  assert.equal(r.ttls.get(buildRollbackSetKey(SCOPE)), 2000, 'TTL を引き直していない');
});

// ── 6. キーの形 ──────────────────────────────────────────────────
test('退避 set は配信台帳と別の名前空間（取り違えを構造的に防ぐ）', () => {
  const roll = buildRollbackSetKey(SCOPE);
  const delivered = buildDeliveredSetKey({ brand: BRAND, campaignId: CAMPAIGN, version: VERSION });
  assert.ok(roll.startsWith(ROLLBACK_NAMESPACE));
  assert.notEqual(roll, delivered);
  assert.equal(roll.includes(`s${STEP}`), true, 'step が鍵に入っていない');
  assert.equal(roll.includes(RUN), true, '実行 ID が鍵に入っていない');
  assert.equal(buildRollbackMetaKey(SCOPE), `${roll}:meta`);
});

test('壊れた入力では鍵を作らない（fail closed）', () => {
  const bad = [
    { ...SCOPE, runId: '' }, { ...SCOPE, runId: 'a b' }, { ...SCOPE, runId: 'x'.repeat(200) },
    { ...SCOPE, step: 0 }, { ...SCOPE, step: 1.5 }, { ...SCOPE, step: 'a' },
    { ...SCOPE, version: 0 }, { ...SCOPE, brand: 'a b' }, { ...SCOPE, campaignId: '' },
  ];
  for (const input of bad) {
    assert.throws(() => buildRollbackSetKey(input), DeliveryKeyStoreError, JSON.stringify(input));
  }
});

test('DeliveryKey の形が違えば 1 件も書かない', async () => {
  const r = fakeRedis();
  seedDelivered(r, KEYS);
  const store = createDeliveryKeyRollbackStore({ redisCmd: r.cmd });
  await assert.rejects(() => store.stashAndRelease({ ...SCOPE, keys: ['not-a-key'], nowMs: 1 }));
  assert.equal(r.calls.includes('SADD'), false);
});

test('対象 0 件なら何もしない（空振りで書かない）', async () => {
  const r = fakeRedis();
  const store = createDeliveryKeyRollbackStore({ redisCmd: r.cmd });
  const out = await store.stashAndRelease({ ...SCOPE, keys: [], nowMs: 1 });
  assert.deepEqual(
    { stashed: out.stashed, released: out.released, verified: out.verified },
    { stashed: 0, released: 0, verified: 0 },
  );
  assert.equal(r.calls.includes('SREM'), false);
});

test('Redis が無ければ作れない（fail closed）', () => {
  assert.throws(() => createDeliveryKeyRollbackStore({}), DeliveryKeyStoreError);
});
