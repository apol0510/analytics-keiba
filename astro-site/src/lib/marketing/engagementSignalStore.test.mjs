/**
 * engagementSignalStore.test.mjs — 反応（open / click）の集計の読み書き
 *   node --test src/lib/marketing/engagementSignalStore.test.mjs
 *
 * 重点:
 *   - `EmailHash` の作り方が恒久台帳（emailEventLedger）と**同じ**（違うと突合できない）
 *   - 書き込み失敗で webhook を落とさない（例外を投げない）
 *   - 読み取り失敗を「0 件」と混同しない（available:false）
 *   - Redis へ生アドレスを渡さない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  hashEmailForSignal, buildSignalBumps, toHsetArgs, parseHashReply, toTimestampMap,
  createEngagementSignalStore, emptySignals, EngagementSignalError,
  SIGNAL_KEY, META_FIELD, EMAIL_HASH_RE,
} from './engagementSignalStore.js';

const NOW = Date.UTC(2026, 7, 10, 3, 0);
const hashOf = (e) => createHash('sha256').update(e, 'utf8').digest('hex').slice(0, 32);

// ── 台帳との整合 ────────────────────────────────────────────
test('EmailHash は恒久台帳と同じ作り方（sha256(lower(email)) の先頭 32 桁）', () => {
  // emailEventLedger.js: hashFn(lower(raw.email)).slice(0, 32)
  assert.equal(hashEmailForSignal('A@Example.COM '), hashOf('a@example.com'));
  assert.match(hashEmailForSignal('a@example.com'), EMAIL_HASH_RE);
  assert.equal(hashEmailForSignal(''), '');
  assert.equal(hashEmailForSignal(null), '');
});

// ── 畳み込み ────────────────────────────────────────────────
test('open / click だけを畳み、最後の時刻を残す', () => {
  const b = buildSignalBumps([
    { eventType: 'open', emailHash: hashOf('a@example.com'), eventAtMs: 100 },
    { eventType: 'open', emailHash: hashOf('a@example.com'), eventAtMs: 300 },
    { eventType: 'click', emailHash: hashOf('b@example.com'), eventAtMs: 200 },
    { eventType: 'delivered', emailHash: hashOf('c@example.com'), eventAtMs: 400 },
  ]);
  assert.equal(b.open[hashOf('a@example.com')], 300, '最後の open が残る');
  assert.equal(b.click[hashOf('b@example.com')], 200);
  assert.equal(Object.keys(b.open).length, 1);
  assert.equal(b.firstOpenAtMs, 100);
  assert.equal(b.lastEventAtMs, 400, 'delivered も「最後に受信した時刻」には数える');
});

test('hash が無い・壊れているイベントは数えない（推測で紐付けない）', () => {
  const b = buildSignalBumps([
    { eventType: 'open', emailHash: '', eventAtMs: 100 },
    { eventType: 'open', emailHash: 'notahash', eventAtMs: 100 },
    { eventType: 'open', emailHash: hashOf('a@example.com'), eventAtMs: 0 },
  ]);
  assert.equal(Object.keys(b.open).length, 0);
  assert.equal(b.skipped, 3);
  assert.equal(b.firstOpenAtMs, null);
});

test('空入力でも壊れない', () => {
  const b = buildSignalBumps(null);
  assert.deepEqual(b.open, {});
  assert.equal(b.lastEventAtMs, null);
});

test('HSET の引数は chunk される（1 コマンドを肥大させない）', () => {
  const map = {};
  for (let i = 0; i < 901; i += 1) map[hashOf(`u${i}@example.com`)] = 1000 + i;
  const args = toHsetArgs(map, 400);
  assert.equal(args.length, 3);
  assert.equal(args[0].length, 800, 'field/value の対で 400 件');
  assert.equal(args[2].length, 202);
});

test('hash 応答は配列形式・オブジェクト形式のどちらでも読める', () => {
  const a = parseHashReply(['f1', '10', 'f2', '20']);
  const o = parseHashReply({ f1: '10', f2: '20' });
  assert.deepEqual([...a], [...o]);
  assert.equal(parseHashReply(null).size, 0);
  const ts = toTimestampMap(parseHashReply(['f1', '10', 'f2', 'bad']));
  assert.equal(ts.get('f1'), 10);
  assert.equal(ts.has('f2'), false, '数値でない値は捨てる');
});

// ── 書き込み ────────────────────────────────────────────────
function fakeRedis() {
  const calls = [];
  const cmd = async (args) => { calls.push(args); return 'OK'; };
  return { calls, cmd };
}

test('1 バッチで送るコマンドはごく少数（webhook を遅くしない）', async () => {
  const r = fakeRedis();
  const store = createEngagementSignalStore({ redisCmd: r.cmd });
  const events = [];
  for (let i = 0; i < 50; i += 1) {
    events.push({ eventType: 'open', emailHash: hashOf(`u${i}@example.com`), eventAtMs: NOW });
  }
  const out = await store.record({ events, receivedAtMs: NOW });
  assert.equal(out.ok, true);
  assert.equal(out.open, 50);
  assert.ok(r.calls.length <= 5, `コマンド数が多すぎる: ${r.calls.length}`);
  assert.equal(r.calls[0][0], 'HSET');
  assert.equal(r.calls[0][1], SIGNAL_KEY.OPEN);
});

test('記録開始時刻と最初の開封は HSETNX（後から書き換えない）', async () => {
  const r = fakeRedis();
  const store = createEngagementSignalStore({ redisCmd: r.cmd });
  await store.record({
    events: [{ eventType: 'open', emailHash: hashOf('a@example.com'), eventAtMs: NOW }],
    receivedAtMs: NOW,
  });
  const nx = r.calls.filter((c) => c[0] === 'HSETNX').map((c) => c[2]);
  assert.ok(nx.includes(META_FIELD.STARTED_AT));
  assert.ok(nx.includes(META_FIELD.FIRST_OPEN_AT));
  const set = r.calls.filter((c) => c[0] === 'HSET' && c[1] === SIGNAL_KEY.META).map((c) => c[2]);
  assert.ok(set.includes(META_FIELD.LAST_EVENT_AT));
});

test('Redis へ生アドレスを渡さない', async () => {
  const r = fakeRedis();
  const store = createEngagementSignalStore({ redisCmd: r.cmd });
  await store.record({
    events: [{ eventType: 'open', emailHash: hashOf('himitsu@example.com'), eventAtMs: NOW }],
    receivedAtMs: NOW,
  });
  const flat = JSON.stringify(r.calls);
  assert.equal(/[^\s@"]+@[^\s@"]+\.[^\s@"]+/.test(flat), false, 'アドレスらしき文字列が混ざっている');
});

test('書き込みが落ちても例外を投げない（webhook を落とさない）', async () => {
  const store = createEngagementSignalStore({
    redisCmd: async () => { throw new Error('upstash 500'); },
  });
  const out = await store.record({
    events: [{ eventType: 'open', emailHash: hashOf('a@example.com'), eventAtMs: NOW }],
    receivedAtMs: NOW,
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'write_failed');
});

test('反応イベントが 1 件も無ければ hash へは書かない', async () => {
  const r = fakeRedis();
  const store = createEngagementSignalStore({ redisCmd: r.cmd });
  await store.record({
    events: [{ eventType: 'delivered', emailHash: hashOf('a@example.com'), eventAtMs: NOW }],
    receivedAtMs: NOW,
  });
  assert.equal(r.calls.some((c) => c[1] === SIGNAL_KEY.OPEN), false);
  assert.equal(r.calls.some((c) => c[1] === SIGNAL_KEY.CLICK), false);
});

// ── 読み取り ────────────────────────────────────────────────
test('読み取りは Map と meta を返す', async () => {
  const h = hashOf('a@example.com');
  const store = createEngagementSignalStore({
    redisCmd: async (args) => {
      if (args[1] === SIGNAL_KEY.OPEN) return [h, String(NOW)];
      if (args[1] === SIGNAL_KEY.CLICK) return [];
      return {
        [META_FIELD.STARTED_AT]: String(NOW - 1000),
        [META_FIELD.FIRST_OPEN_AT]: String(NOW - 500),
        [META_FIELD.LAST_EVENT_AT]: String(NOW),
      };
    },
  });
  const s = await store.read();
  assert.equal(s.available, true);
  assert.equal(s.openByHash.get(h), NOW);
  assert.equal(s.clickByHash.size, 0);
  assert.equal(s.meta.startedAtMs, NOW - 1000);
  assert.equal(s.meta.lastEventAtMs, NOW);
});

test('【重要】読めないことを「0 件」と混同しない', async () => {
  const store = createEngagementSignalStore({
    redisCmd: async () => { throw new Error('down'); },
  });
  const s = await store.read();
  assert.equal(s.available, false);
  assert.equal(s.reason, 'read_failed');
  assert.equal(s.openByHash.size, 0);
  assert.equal(emptySignals().available, false);
});

test('Redis 未設定なら store を作れない（黙って動く形を作らない）', () => {
  assert.throws(() => createEngagementSignalStore({}), (e) => e instanceof EngagementSignalError);
});
