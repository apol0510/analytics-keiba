/**
 * couponOperationLock.test.mjs — クーポン操作の排他
 *
 * 固定すること:
 *   - **排他は状態変更より前**に取る（実装の順序を構造で検査する）
 *   - 取れなかった要求は副作用ゼロで断る
 *   - Redis が使えないときは書かない（fail closed）
 *   - **token が一致しないと release しない**（他プロセスの鍵を消さない）
 *   - 他会員・他商品・別操作は別の鍵
 *   - 鍵に PII を載せない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const L = await import('./couponOperationLock.js');
const P = await import('./couponPlatform.js');

/** SET NX / EVAL の意味を本物どおりに実装した合成 Redis */
function fakeRedis({ down = false } = {}) {
  const store = new Map();
  return {
    store,
    cmd: async (args) => {
      if (down) throw new Error('redis_down');
      const [op, ...rest] = args;
      if (op === 'INCR') {
        const n = Number(store.get(rest[0]) || 0) + 1;
        store.set(rest[0], String(n));
        return n;
      }
      if (op === 'SET') {
        const [key, value, ...opts] = rest;
        if (opts.includes('NX') && store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }
      if (op === 'EVAL') {
        const [script, , key, token] = rest;
        const cur = store.get(key);
        if (cur === undefined) return 'LOST';
        if (cur !== token) return 'STOLEN';
        if (script.includes('DEL')) store.delete(key);
        return 'OK';
      }
      return null;
    },
  };
}

const ENT = 'a'.repeat(32);
const ENT2 = 'b'.repeat(32);

test('排他は「状態変更より前」に取る（順序を実装で固定）', () => {
  const fn = read('../../../netlify/functions/premium-plus-eligibility.js');
  const body = fn.slice(fn.indexOf('async function handleCouponAdmin'),
    fn.indexOf('async function reloadCouponState'));
  const at = (needle) => body.indexOf(needle);
  const acquire = at('lock.acquire(');
  const patch = at("method: 'PATCH'");
  const verify = at('lock.verify(');
  const reread = body.indexOf('readState()', body.indexOf('lock.acquire('));
  assert.ok(acquire > 0 && patch > 0, '排他か PATCH が見つからない');
  assert.ok(acquire < patch, '状態変更より後に排他を取っている（本体 PATCH の race が残る）');
  assert.ok(reread > acquire && reread < patch, 'lock 取得後に読み直していない（TOCTOU）');
  assert.ok(verify > reread && verify < patch, '書く直前に lock を検証していない');
  // 解放は finally で（crash 時は TTL 回復）
  assert.match(body, /finally\s*\{[\s\S]*lock\.release\(/, 'finally で解放していない');
});

test('取れた 1 本だけが通る（2 本目は lost・副作用ゼロ）', async () => {
  const r = fakeRedis();
  const lock = L.createCouponOperationLock({ redisCmd: r.cmd });
  const a = await lock.acquire({ entityId: ENT });
  const b = await lock.acquire({ entityId: ENT });
  assert.equal(a.status, L.LOCK_RESULT.ACQUIRED);
  assert.equal(b.status, L.LOCK_RESULT.LOST);
  assert.equal(b.token, null);
});

test('鍵は entity（会員×商品×クーポン×版）。**操作種別は鍵に入らない**', () => {
  const ent = (over) => P.computeCouponEntityId({
    customerRecordId: 'recA', productKey: 'premium_plus', couponId: 'c', version: 1, ...over,
  });
  // 同じ実体 → 同じ鍵（操作種別が違っても直列化される）
  assert.equal(ent(), ent());
  // 他会員・他商品・別クーポン・別版 → 別の鍵（互いに待たない）
  const keys = [ent(), ent({ customerRecordId: 'recB' }), ent({ productKey: 'premium_monthly' }),
    ent({ couponId: 'other' }), ent({ version: 2 })];
  assert.equal(new Set(keys).size, 5);
  // 材料が欠けたら作らない
  assert.equal(ent({ customerRecordId: '' }), null);
  // ⚠️ OperationId は操作種別で変わる = **鍵にしてはいけない**
  const opId = (t) => P.computeCouponOperationId({
    productKey: 'premium_plus', couponId: 'c', version: 1,
    customerRecordId: 'recA', operationType: t, anchor: 'none',
  });
  assert.notEqual(opId('claim'), opId('grant'), '前提が崩れている');
});

test('別の実体どうしは互いに block しない', async () => {
  const r = fakeRedis();
  const lock = L.createCouponOperationLock({ redisCmd: r.cmd });
  assert.equal((await lock.acquire({ entityId: ENT })).status, L.LOCK_RESULT.ACQUIRED);
  assert.equal((await lock.acquire({ entityId: ENT2 })).status, L.LOCK_RESULT.ACQUIRED);
});

test('実装は entity id を鍵にしている（OperationId を鍵に戻さない）', () => {
  const fn = read('../../../netlify/functions/premium-plus-eligibility.js');
  assert.match(fn, /lock\.acquire\(\{ entityId \}\)/, 'entity で lock を取っていない');
  assert.doesNotMatch(fn, /acquire\(\{\s*operationId/, 'OperationId を鍵にしている');
  const claim = read('../../pages/api/premium-plus-coupon.json.js');
  assert.match(claim, /lock\.acquire\(\{ entityId \}\)/, 'claim が entity lock を取っていない');
  assert.doesNotMatch(claim, /acquire\(\{\s*operationId/);
});

test('Redis が使えないときは取れたことにしない（fail closed）', async () => {
  const lock = L.createCouponOperationLock({ redisCmd: fakeRedis({ down: true }).cmd });
  const got = await lock.acquire({ entityId: ENT });
  assert.equal(got.status, L.LOCK_RESULT.UNAVAILABLE);
  // 未設定（redisCmd が無い）でも同じ
  const none = L.createCouponOperationLock({ redisCmd: null });
  assert.equal(none.available, false);
  assert.equal((await none.acquire({ entityId: ENT })).status, L.LOCK_RESULT.UNAVAILABLE);
});

test('token が一致しないと release しない（他プロセスの鍵を消さない）', async () => {
  const r = fakeRedis();
  const lock = L.createCouponOperationLock({ redisCmd: r.cmd });
  const got = await lock.acquire({ entityId: ENT });
  const wrong = await lock.release({ entityId: ENT, token: 'not-mine' });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.reason, 'stolen');
  assert.ok(r.store.has(L.couponLockKey.lock(ENT)), '他人の鍵を消している');
  // 正しい token なら消える
  assert.equal((await lock.release({ entityId: ENT, token: got.token })).ok, true);
  assert.equal(r.store.has(L.couponLockKey.lock(ENT)), false);
});

test('奪われていたら書かない（verify が STOLEN / LOST を返す）', async () => {
  const r = fakeRedis();
  const lock = L.createCouponOperationLock({ redisCmd: r.cmd });
  const got = await lock.acquire({ entityId: ENT });
  assert.equal((await lock.verify({ entityId: ENT, token: got.token })).ok, true);
  // 別実行に奪われた
  r.store.set(L.couponLockKey.lock(ENT), 'someone-else');
  const v = await lock.verify({ entityId: ENT, token: got.token });
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'stolen');
  // TTL 切れで消えた
  r.store.delete(L.couponLockKey.lock(ENT));
  assert.equal((await lock.verify({ entityId: ENT, token: got.token })).reason, 'lost');
});

test('鍵に載せるのは entity id だけ（PII を載せない）', async () => {
  assert.equal(L.isSafeLockId(ENT), true);
  for (const bad of ['a@example.invalid', '田中太郎', '', 'short', 'a'.repeat(65), null]) {
    assert.equal(L.isSafeLockId(bad), false, String(bad));
  }
  const lock = L.createCouponOperationLock({ redisCmd: fakeRedis().cmd });
  // 危険な値では取りにいかない
  assert.equal((await lock.acquire({ operationId: 'a@example.invalid' })).status,
    L.LOCK_RESULT.UNAVAILABLE);
  assert.match(L.couponLockKey.lock(ENT), /^ak:coupon-op:lock:[0-9a-f]+$/);
});

test('TTL は Function の実行時間より十分長い（途中で切れない）', () => {
  assert.ok(L.COUPON_LOCK_TTL_SEC >= 26 * 10, 'TTL が短すぎる（実行中に切れる）');
  assert.ok(Number.isFinite(L.COUPON_LOCK_TTL_SEC), 'TTL 無し（crash で永久に詰まる）');
});

test('既存の primitive を再利用している（新しい排他を作っていない）', () => {
  const src = read('./couponOperationLock.js');
  assert.match(src, /from '\.\.\/marketing\/automationStore\.js'/,
    '既存の Lua を再利用していない');
  assert.doesNotMatch(src, /UPSTASH_REDIS_REST_URL/,
    'このモジュールが env を直接読んでいる（redisCmd を注入すること）');
});
