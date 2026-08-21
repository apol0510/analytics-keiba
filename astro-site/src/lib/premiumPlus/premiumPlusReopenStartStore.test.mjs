/**
 * premiumPlusReopenStartStore.test.mjs — 再募集開始日時の**保存**を固定する
 *
 * 合成 Redis は `SET ... NX` の意味を**本物どおり**に実装する（先客がいれば null）。
 *
 * 固定する仕様:
 *   - 開始日時は**呼び出し側（サーバー）が渡した時刻**からしか作られない
 *   - 書けるのは**最初の 1 回だけ**（2 回目以降は上書きせず既存値を返す）
 *   - **並行要求**でも 1 つに確定する
 *   - Redis が使えない / 応答不明なら**書かない・成功と言わない**（fail closed）
 *   - 触る鍵は `ak:pp:reopen:v1:start` **1 本だけ**（他の鍵空間を汚さない）
 *   - 保存値に**メールアドレスを入れない**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createReopenStartStore,
  loadReopenStart,
  REOPEN_START_KEY,
  REOPEN_NAMESPACE,
  sanitizeActor,
  encodeReopenStartRecord,
  decodeReopenStartRecord,
} from './premiumPlusReopenStartStore.js';
import { REOPEN_UNAVAILABLE, withReopenStart } from './premiumPlusReopenStart.js';

const NOW = Date.parse('2026-09-01T03:00:00.000Z');

/** SET NX / GET を本物どおりに実装した合成 Redis */
function makeRedis({ down = false, setUnknown = false } = {}) {
  const store = new Map();
  const calls = [];
  const cmd = async (args) => {
    calls.push(args);
    if (down) throw new Error('redis_down');
    const [op, ...rest] = args;
    if (op === 'SET') {
      const [key, value, ...opts] = rest;
      if (setUnknown) throw new Error('redis_500');
      if (opts.includes('NX') && store.has(key)) return null;   // 先客がいる
      store.set(key, value);
      return 'OK';
    }
    if (op === 'GET') return store.has(rest[0]) ? store.get(rest[0]) : null;
    return null;
  };
  return { cmd, store, calls };
}

test('鍵は Premium Plus 専用の 1 本だけ（他の鍵空間に触れない）', () => {
  assert.equal(REOPEN_NAMESPACE, 'ak:pp:reopen:v1');
  assert.equal(REOPEN_START_KEY, 'ak:pp:reopen:v1:start');
  for (const foreign of ['ak:marketing-', 'ak:coupon-op:', 'ak:pp:funnel', 'ak:prospect:']) {
    assert.ok(!REOPEN_START_KEY.startsWith(foreign));
  }
});

test('初回だけ保存される（サーバー時刻がそのまま開始日時になる）', async () => {
  const redis = makeRedis();
  const store = createReopenStartStore({ redisCmd: redis.cmd });

  const first = await store.start({ nowMs: NOW, actor: 'MK' });
  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(first.alreadyStarted, false);
  assert.equal(first.startsAtIso, '2026-09-01T03:00:00.000Z');
  // 触った鍵は 1 本だけ
  assert.deepEqual([...redis.store.keys()], [REOPEN_START_KEY]);

  // 期限は開始日時から導出される（サーバーの実効状態）
  const def = withReopenStart(first.startsAtIso);
  assert.equal(def.terms.expiresAt, '2026-09-15T03:00:00.000Z');
});

test('2 回目以降は上書きしない（別の時刻で押しても開始日時は不変）', async () => {
  const redis = makeRedis();
  const store = createReopenStartStore({ redisCmd: redis.cmd });

  const first = await store.start({ nowMs: NOW, actor: 'MK' });
  const later = await store.start({ nowMs: NOW + 7 * 24 * 3600 * 1000, actor: '別の人' });

  assert.equal(later.ok, true);
  assert.equal(later.created, false, '2 回目は書いていない');
  assert.equal(later.alreadyStarted, true);
  assert.equal(later.startsAtIso, first.startsAtIso, '開始日時が上書きされていない');
  assert.equal(later.actor, 'MK', '最初に押した人が残る');

  const read = await store.read();
  assert.equal(read.startsAtIso, first.startsAtIso);
});

test('並行要求でも開始日時は 1 つに確定する', async () => {
  const redis = makeRedis();
  const store = createReopenStartStore({ redisCmd: redis.cmd });

  // 10 本同時（それぞれ違う時刻を渡す＝勝者以外の時刻は採用されないこと）
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => store.start({ nowMs: NOW + i * 1000, actor: `A${i}` })),
  );
  const created = results.filter((r) => r.created === true);
  assert.equal(created.length, 1, '書けたのは 1 本だけ');

  const values = new Set(results.map((r) => r.startsAtIso));
  assert.equal(values.size, 1, '全員が同じ開始日時を返す');
  assert.equal([...values][0], created[0].startsAtIso);

  const read = await store.read();
  assert.equal(read.startsAtIso, created[0].startsAtIso);
  assert.equal(redis.store.size, 1);
});

test('二重押下（同じ時刻の連打）でも 1 回しか書かない', async () => {
  const redis = makeRedis();
  const store = createReopenStartStore({ redisCmd: redis.cmd });
  const a = await store.start({ nowMs: NOW, actor: 'MK' });
  const b = await store.start({ nowMs: NOW, actor: 'MK' });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  const sets = redis.calls.filter((c) => c[0] === 'SET');
  assert.equal(sets.length, 2, 'SET は 2 回投げるが…');
  assert.ok(sets.every((c) => c.includes('NX')), '…どちらも NX 付き（上書きにならない）');
});

test('Redis が使えないときは書かない・成功と言わない（fail closed）', async () => {
  const down = createReopenStartStore({ redisCmd: makeRedis({ down: true }).cmd });
  const out = await down.start({ nowMs: NOW, actor: 'MK' });
  assert.equal(out.ok, false);
  assert.equal(out.created, false);
  assert.equal(out.startsAtIso, null);

  const none = createReopenStartStore({ redisCmd: null });
  assert.equal(none.available, false);
  const out2 = await none.start({ nowMs: NOW });
  assert.equal(out2.ok, false);
  assert.equal(out2.reason, REOPEN_UNAVAILABLE.NOT_CONFIGURED);

  // 読めなかったことも「未設定」に丸めない
  const read = await down.read();
  assert.equal(read.available, false);
  assert.equal(read.startsAtIso, null);
  assert.equal(read.reason, REOPEN_UNAVAILABLE.READ_FAILED);
});

test('応答が不明なとき（SET が例外）は開始したと言わない', async () => {
  const store = createReopenStartStore({ redisCmd: makeRedis({ setUnknown: true }).cmd });
  const out = await store.start({ nowMs: NOW, actor: 'MK' });
  assert.equal(out.ok, false);
  assert.equal(out.created, false);
});

test('不正な時刻では書かない', async () => {
  const redis = makeRedis();
  const store = createReopenStartStore({ redisCmd: redis.cmd });
  for (const bad of [undefined, null, NaN, 'いま', Date.parse('1999-01-01T00:00:00Z')]) {
    const out = await store.start({ nowMs: bad, actor: 'MK' });
    assert.equal(out.ok, false, String(bad));
  }
  assert.equal(redis.store.size, 0, '1 件も書いていない');
});

test('読み取りが時間内に返らなければ「確認できない」', async () => {
  const slow = async () => new Promise((r) => { setTimeout(() => r(null), 50); });
  const store = createReopenStartStore({ redisCmd: slow });
  const read = await store.read({ timeoutMs: 5 });
  assert.equal(read.available, false);
  assert.equal(read.reason, REOPEN_UNAVAILABLE.TIMEOUT);
});

test('保存値に個人情報を入れない（メールアドレスは actor に採用しない）', () => {
  assert.equal(sanitizeActor('mk@example.com'), 'admin');
  assert.equal(sanitizeActor('  MK  '), 'MK');
  assert.equal(sanitizeActor(''), 'admin');
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
  // 壊れた JSON は生値のまま返し、上位（resolveReopenStatus）が「確認できない」にする
  assert.equal(decodeReopenStartRecord('{壊れ').startsAtIso, '{壊れ');
});

test('loadReopenStart は例外を投げない（ページ描画を壊さない）', async () => {
  const out = await loadReopenStart({
    redisCmd: async () => { throw new Error('boom'); }, timeoutMs: 20,
  });
  assert.equal(out.available, false);
  assert.equal(out.startsAtIso, null);

  // env が無い（本番未設定）でも落ちない
  const none = await loadReopenStart({ env: {} });
  assert.equal(none.available, false);
  assert.equal(none.reason, REOPEN_UNAVAILABLE.NOT_CONFIGURED);
});

test('上書き・削除の API を公開していない（構造で守る）', () => {
  const store = createReopenStartStore({ redisCmd: makeRedis().cmd });
  assert.deepEqual(Object.keys(store).sort(), ['available', 'read', 'start']);
  for (const forbidden of ['set', 'update', 'clear', 'delete', 'reset']) {
    assert.equal(store[forbidden], undefined, forbidden);
  }
});
