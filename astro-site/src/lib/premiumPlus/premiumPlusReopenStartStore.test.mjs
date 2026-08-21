/**
 * premiumPlusReopenStartStore.test.mjs — **会員ごとの**再募集開始日時の保存を固定する
 *
 * 合成 Redis は `HSETNX` / `HGET` / `HMGET` の意味を**本物どおり**に実装する
 * （既存フィールドがあれば HSETNX は 0 を返す）。
 *
 * 固定する仕様:
 *   - 開始日時は**呼び出し側（サーバー）が渡した時刻**からしか作られない
 *   - **その会員について最初の 1 回だけ**書ける（2 回目以降は上書きせず既存値を返す）
 *   - **並行 8 要求**でも created は 1 回だけ
 *   - **他会員のフィールドを変更しない**（A の開始で B は未設定のまま）
 *   - Redis が使えない / 応答不明なら**書かない・成功と言わない**（fail closed）
 *   - 触る鍵は `ak:pp:reopen:v1:members` **1 本だけ**（他の鍵空間を汚さない）
 *   - **旧グローバル鍵 `ak:pp:reopen:v1:start` を読まない・書かない**
 *   - 保存値に**メールアドレスを入れない**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createReopenStartStore,
  loadReopenStart,
  REOPEN_MEMBERS_KEY,
  REOPEN_NAMESPACE,
  sanitizeActor,
  encodeReopenStartRecord,
  decodeReopenStartRecord,
} from './premiumPlusReopenStartStore.js';
import { REOPEN_UNAVAILABLE, withReopenStart } from './premiumPlusReopenStart.js';

const NOW = Date.parse('2026-09-01T03:00:00.000Z');
const A = 'recAAAAAAAAAAAAAA';
const B = 'recBBBBBBBBBBBBBB';

/** HSETNX / HGET / HMGET を本物どおりに実装した合成 Redis */
function makeRedis({ down = false, writeUnknown = false } = {}) {
  const hashes = new Map();
  const calls = [];
  /** 書き込み用（無ければ作る）*/
  const h = (k) => {
    if (!hashes.has(k)) hashes.set(k, new Map());
    return hashes.get(k);
  };
  /** 読み取り用。⚠️ **読んだだけで鍵を作らない**（本物と同じ挙動にする）*/
  const ro = (k) => hashes.get(k) || new Map();
  const cmd = async (args) => {
    calls.push(args);
    if (down) throw new Error('redis_down');
    const [op, key, ...rest] = args;
    if (op === 'HSETNX') {
      if (writeUnknown) throw new Error('redis_500');
      const [field, value] = rest;
      if (h(key).has(field)) return 0;         // 先客がいる = 書かない
      h(key).set(field, value);
      return 1;
    }
    if (op === 'HGET') return ro(key).has(rest[0]) ? ro(key).get(rest[0]) : null;
    if (op === 'HMGET') return rest.map((f) => (ro(key).has(f) ? ro(key).get(f) : null));
    return null;
  };
  return { cmd, hashes, calls, field: (f) => ro(REOPEN_MEMBERS_KEY).get(f) };
}

const parsed = (redis, id) => {
  const raw = redis.field(id);
  return raw ? JSON.parse(raw) : null;
};

test('鍵は Premium Plus 専用の 1 本だけ（他の鍵空間に触れない）', () => {
  assert.equal(REOPEN_NAMESPACE, 'ak:pp:reopen:v1');
  assert.equal(REOPEN_MEMBERS_KEY, 'ak:pp:reopen:v1:members');
  for (const foreign of ['ak:marketing-', 'ak:coupon-op:', 'ak:pp:funnel', 'ak:prospect:']) {
    assert.ok(!REOPEN_MEMBERS_KEY.startsWith(foreign));
  }
});

test('旧グローバル鍵（全体で 1 個）はコードに存在しない', () => {
  const src = readFileSync(fileURLToPath(new URL('./premiumPlusReopenStartStore.js', import.meta.url)), 'utf8');
  // 鍵名としての `:start` を定数化していない（説明文中の言及は許す）
  assert.ok(!/REOPEN_START_KEY\s*=/.test(src), '全体 1 個の鍵定数が残っている');
  assert.ok(!/`\$\{REOPEN_NAMESPACE\}:start`/.test(src), '全体 1 個の鍵を組み立てている');
});

test('初回だけ保存される（サーバー時刻がその会員の開始日時になる）', async () => {
  const redis = makeRedis();
  const store = createReopenStartStore({ redisCmd: redis.cmd });

  const first = await store.start({ recordId: A, nowMs: NOW, actor: 'MK' });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(first.startsAtIso, '2026-09-01T03:00:00.000Z');
  assert.deepEqual([...redis.hashes.keys()], [REOPEN_MEMBERS_KEY]);
  assert.equal(parsed(redis, A).startsAt, first.startsAtIso);

  // 期限はその会員の開始日時から導出される
  assert.equal(withReopenStart(first.startsAtIso).terms.expiresAt, '2026-09-15T03:00:00.000Z');
});

test('A を開始しても B は未開始のまま（他会員へ影響しない）', async () => {
  const redis = makeRedis();
  const store = createReopenStartStore({ redisCmd: redis.cmd });

  await store.start({ recordId: A, nowMs: NOW, actor: 'MK' });

  const readB = await store.read({ recordId: B });
  assert.equal(readB.available, true);
  assert.equal(readB.startsAtIso, null, 'B は未開始');
  assert.equal(redis.field(B), undefined, 'B のフィールドは作られていない');

  // 一括読み取りでも A だけが開始済み
  const many = await store.readMany({ recordIds: [A, B] });
  assert.equal(many.available, true);
  assert.ok(many.rows.get(A).startsAtIso);
  assert.equal(many.rows.get(B).startsAtIso, null);
});

test('B を後日開始しても A の開始日時は変わらない', async () => {
  const redis = makeRedis();
  const store = createReopenStartStore({ redisCmd: redis.cmd });
  const later = NOW + 19 * 24 * 3600 * 1000;

  const a = await store.start({ recordId: A, nowMs: NOW, actor: 'MK' });
  const b = await store.start({ recordId: B, nowMs: later, actor: 'MK' });

  assert.equal(b.created, true);
  assert.notEqual(a.startsAtIso, b.startsAtIso);
  assert.equal(parsed(redis, A).startsAt, a.startsAtIso, 'A は不変');
  // B の期限は B の開始から 14 日
  assert.equal(withReopenStart(b.startsAtIso).terms.expiresAt,
    new Date(later + 14 * 24 * 3600 * 1000).toISOString());
});

test('同一会員の 2 回目は上書きしない（別の時刻で押しても不変）', async () => {
  const redis = makeRedis();
  const store = createReopenStartStore({ redisCmd: redis.cmd });

  const first = await store.start({ recordId: A, nowMs: NOW, actor: 'MK' });
  const later = await store.start({ recordId: A, nowMs: NOW + 7 * 24 * 3600 * 1000, actor: '別の人' });

  assert.equal(later.ok, true);
  assert.equal(later.created, false, '2 回目は書いていない');
  assert.equal(later.alreadyStarted, true);
  assert.equal(later.startsAtIso, first.startsAtIso);
  assert.equal(later.actor, 'MK', '最初に押した人が残る');
  assert.equal(parsed(redis, A).startsAt, first.startsAtIso);
});

test('同一会員への並行 8 要求でも created は 1 回だけ', async () => {
  const redis = makeRedis();
  const store = createReopenStartStore({ redisCmd: redis.cmd });

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => store.start({ recordId: A, nowMs: NOW + i * 1000, actor: `A${i}` })),
  );
  assert.equal(results.filter((r) => r.created === true).length, 1, '書けたのは 1 本だけ');
  const isos = new Set(results.map((r) => r.startsAtIso));
  assert.equal(isos.size, 1, '全員が同じ開始日時を返す');
  assert.equal([...isos][0], parsed(redis, A).startsAt);
  // 書き込みコマンドはすべて HSETNX（上書きになる書き方をしていない）
  const writes = redis.calls.filter((c) => c[0] !== 'HGET' && c[0] !== 'HMGET');
  assert.ok(writes.every((c) => c[0] === 'HSETNX'), '上書き系コマンドを使っている');
});

test('別会員への並行要求は互いに干渉しない', async () => {
  const redis = makeRedis();
  const store = createReopenStartStore({ redisCmd: redis.cmd });
  const [a, b] = await Promise.all([
    store.start({ recordId: A, nowMs: NOW, actor: 'MK' }),
    store.start({ recordId: B, nowMs: NOW + 5000, actor: 'MK' }),
  ]);
  assert.equal(a.created, true);
  assert.equal(b.created, true);
  assert.notEqual(a.startsAtIso, b.startsAtIso);
});

test('Redis が使えないときは書かない・成功と言わない（fail closed）', async () => {
  const down = createReopenStartStore({ redisCmd: makeRedis({ down: true }).cmd });
  const out = await down.start({ recordId: A, nowMs: NOW, actor: 'MK' });
  assert.equal(out.ok, false);
  assert.equal(out.created, false);

  const none = createReopenStartStore({ redisCmd: null });
  assert.equal(none.available, false);
  assert.equal((await none.start({ recordId: A, nowMs: NOW })).reason, REOPEN_UNAVAILABLE.NOT_CONFIGURED);

  // 読めなかったことも「未設定」に丸めない
  const read = await down.read({ recordId: A });
  assert.equal(read.available, false);
  assert.equal(read.startsAtIso, null);
  assert.equal(read.reason, REOPEN_UNAVAILABLE.READ_FAILED);

  // 一括読み取りも「全員未開始」に丸めない
  const many = await down.readMany({ recordIds: [A, B] });
  assert.equal(many.available, false);
  assert.equal(many.rows.size, 0);
});

test('応答が不明なとき（書き込みが例外）は開始したと言わない', async () => {
  const store = createReopenStartStore({ redisCmd: makeRedis({ writeUnknown: true }).cmd });
  const out = await store.start({ recordId: A, nowMs: NOW, actor: 'MK' });
  assert.equal(out.ok, false);
  assert.equal(out.created, false);
});

test('会員の指定が不正なら書かない・読まない', async () => {
  const redis = makeRedis();
  const store = createReopenStartStore({ redisCmd: redis.cmd });
  for (const bad of [undefined, null, '', 'nope', 'recSHORT', 'rec../x']) {
    const out = await store.start({ recordId: bad, nowMs: NOW, actor: 'MK' });
    assert.equal(out.ok, false, String(bad));
    assert.equal(out.reason, REOPEN_UNAVAILABLE.INVALID_MEMBER, String(bad));
    const read = await store.read({ recordId: bad });
    assert.equal(read.available, false);
  }
  assert.equal(redis.hashes.size, 0, '1 件も書いていない');
});

test('不正な時刻では書かない', async () => {
  const redis = makeRedis();
  const store = createReopenStartStore({ redisCmd: redis.cmd });
  for (const bad of [undefined, null, NaN, 'いま', Date.parse('1999-01-01T00:00:00Z')]) {
    assert.equal((await store.start({ recordId: A, nowMs: bad, actor: 'MK' })).ok, false, String(bad));
  }
  assert.equal(redis.hashes.size, 0);
});

test('読み取りが時間内に返らなければ「確認できない」', async () => {
  const slow = async () => new Promise((r) => { setTimeout(() => r(null), 50); });
  const store = createReopenStartStore({ redisCmd: slow });
  const read = await store.read({ recordId: A, timeoutMs: 5 });
  assert.equal(read.available, false);
  assert.equal(read.reason, REOPEN_UNAVAILABLE.TIMEOUT);
  const many = await store.readMany({ recordIds: [A], timeoutMs: 5 });
  assert.equal(many.available, false);
  assert.equal(many.reason, REOPEN_UNAVAILABLE.TIMEOUT);
});

test('保存値に個人情報を入れない（メールアドレスは actor に採用しない）', () => {
  assert.equal(sanitizeActor('mk@example.com'), 'admin');
  assert.equal(sanitizeActor('  MK  '), 'MK');
  assert.equal(sanitizeActor('x'.repeat(80)).length, 32);
  const rec = encodeReopenStartRecord({ startsAtIso: '2026-09-01T03:00:00.000Z', actor: 'mk@example.com' });
  assert.ok(!rec.includes('@'));
  assert.deepEqual(decodeReopenStartRecord(rec), {
    startsAtIso: '2026-09-01T03:00:00.000Z', actor: 'admin',
  });
});

test('素の ISO 文字列で保存されていても読める（後方互換）', () => {
  assert.deepEqual(decodeReopenStartRecord('2026-09-01T03:00:00.000Z'), {
    startsAtIso: '2026-09-01T03:00:00.000Z', actor: '',
  });
  assert.deepEqual(decodeReopenStartRecord(null), { startsAtIso: null, actor: '' });
  assert.equal(decodeReopenStartRecord('{壊れ').startsAtIso, '{壊れ');
});

test('loadReopenStart は例外を投げない（ページ描画を壊さない）', async () => {
  const out = await loadReopenStart({
    recordId: A, redisCmd: async () => { throw new Error('boom'); }, timeoutMs: 20,
  });
  assert.equal(out.available, false);
  assert.equal(out.startsAtIso, null);

  const none = await loadReopenStart({ recordId: A, env: {} });
  assert.equal(none.available, false);
  assert.equal(none.reason, REOPEN_UNAVAILABLE.NOT_CONFIGURED);

  // recordId が無い呼び出し（配線漏れ）も落ちない・開始済みにしない
  const missing = await loadReopenStart({ env: {} });
  assert.equal(missing.available, false);
  assert.equal(missing.startsAtIso, null);
});

test('上書き・削除の API を公開していない（構造で守る）', () => {
  const store = createReopenStartStore({ redisCmd: makeRedis().cmd });
  assert.deepEqual(Object.keys(store).sort(), ['available', 'read', 'readMany', 'start']);
  for (const forbidden of ['set', 'update', 'clear', 'delete', 'reset', 'startAll']) {
    assert.equal(store[forbidden], undefined, forbidden);
  }
});
