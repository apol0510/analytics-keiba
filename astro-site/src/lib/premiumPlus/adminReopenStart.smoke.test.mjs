/**
 * adminReopenStart.smoke.test.mjs — 「再募集を開始」を **Function 越しに**実際に動かす
 *
 * 合成 Redis（`SET NX` は本物どおり）＋ 合成 Airtable に対して本物の handler を実行する。
 *
 * 固定する安全条件:
 *   - 開始日時は**サーバー時刻**。client が `startsAt` / `now` を送っても採用しない
 *   - 初回だけ保存し、**2 回目・並行要求では上書きしない**
 *   - **Airtable へは 1 バイトも書かない**（Customers / PromotionalOffers / 履歴のいずれも）
 *   - 保存先が使えなければ 503 で「開始した」と言わない（副作用ゼロ）
 *   - admin secret が無ければ実行できない（API 直叩き・URL 直打ちでも同じ）
 *   - 開始後は一覧（`action='list'`）の期限表示とサーバーの実効状態が一致する
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const FN = fileURLToPath(new URL('../../../netlify/functions/premium-plus-eligibility.js', import.meta.url));
const { REOPEN_START_KEY } = await import('./premiumPlusReopenStartStore.js');
const { withReopenStart } = await import('./premiumPlusReopenStart.js');
const { describeCouponExpiry } = await import('./premiumPlusReopenCoupon.js');

const SECRET = 'admin-secret-for-test';
const REC = 'recSYNTH00000001';
const EMAIL = 'synthetic@example.invalid';

let db;
let redis;
let realFetch;
let realEnv;

/** SET NX / GET を本物どおりに実装した合成 Redis */
function makeRedis({ down = false } = {}) {
  const store = new Map();
  const cmd = async (args) => {
    if (down) throw new Error('redis_down');
    const [op, ...rest] = args;
    if (op === 'SET') {
      const [key, value, ...opts] = rest;
      if (opts.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }
    if (op === 'GET') return store.has(rest[0]) ? store.get(rest[0]) : null;
    if (op === 'INCR') {
      const n = Number(store.get(rest[0]) || 0) + 1;
      store.set(rest[0], String(n));
      return n;
    }
    return null;
  };
  return { cmd, store };
}

function makeDb() {
  return {
    customers: {
      [REC]: {
        Email: EMAIL, '氏名': 'テスト太郎',
        'プラン': 'Premium Sanrenpuku', 'Status': 'active', '有効期限': '2099-12-31',
        'SanrenpukuPaidAt': '2020-01-01T00:00:00.000Z',
        'PremiumPlusEligibility': 'eligible',
        PremiumPlusReopenCouponClaimedAt: '2026-08-18T22:07:54.000Z',
        PremiumPlusReopenCouponId: 'premium-plus-reopen-priority@v1',
        PremiumPlusReopenCouponSource: 'pause-notice',
      },
    },
    /** **あらゆる Airtable への書き込み**を記録する（0 件であることを検査する） */
    writes: [],
  };
}

function stubFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    const err = (status) => ({ ok: false, status, json: async () => ({}), text: async () => 'error' });

    if (u.includes('redis.example.invalid')) {
      const args = JSON.parse(init.body || '[]');
      try { return ok({ result: await redis.cmd(args) }); } catch { return err(500); }
    }
    // Airtable: 書き込みは全部記録する（このテストでは 1 件も起きてはいけない）
    if (u.includes('api.airtable.com')) {
      if (method === 'PATCH' || method === 'POST' || method === 'DELETE') {
        if (!u.endsWith('/listRecords')) {
          db.writes.push({ url: u, method, body: init.body });
          return err(403);
        }
      }
      if (u.includes('/Customers/listRecords')) {
        return ok({ records: Object.entries(db.customers).map(([id, fields]) => ({ id, fields })) });
      }
      if (u.includes('/PromotionalOffers')) return ok({ records: [] });
      if (u.includes('/CampaignDeliveries')) return ok({ records: [] });
      if (u.includes('/CouponOperationHistory')) return ok({ records: [] });
      if (u.includes('/Customers/')) {
        const id = u.split('/Customers/')[1];
        return db.customers[id] ? ok({ id, fields: db.customers[id] }) : err(404);
      }
      return ok({ records: [] });
    }
    return err(403);
  };
}

let handlerPromise = null;
function loadHandler() {
  if (!handlerPromise) {
    globalThis.exports = {};
    globalThis.module = { exports: globalThis.exports };
    handlerPromise = import(FN).then(() => globalThis.exports.handler);
  }
  return handlerPromise;
}

async function post(body, { secret = SECRET } = {}) {
  const handler = await loadHandler();
  const res = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json', ...(secret ? { 'x-admin-secret': secret } : {}) },
    body: JSON.stringify(body),
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

const stored = () => {
  const raw = redis.store.get(REOPEN_START_KEY);
  return raw ? JSON.parse(raw) : null;
};

beforeEach(() => {
  realFetch = globalThis.fetch;
  realEnv = { ...process.env };
  process.env.PREMIUM_PLUS_ADMIN_SECRET = SECRET;
  process.env.AIRTABLE_API_KEY = 'key-test';
  process.env.AIRTABLE_BASE_ID = 'app-test';
  process.env.PREMIUM_PLUS_FIELDS_READY = '1';
  process.env.PREMIUM_PLUS_REOPEN_COUPON_READY = '1';
  process.env.COMEBACK_OFFER_TABLE_READY = '1';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token-test';
  redis = makeRedis();
  db = makeDb();
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in realEnv)) delete process.env[k];
  Object.assign(process.env, realEnv);
});

test('secret が無ければ開始できない（API 直叩きでも同じ）', async () => {
  const res = await post({ action: 'reopenStart', actor: 'MK' }, { secret: '' });
  assert.equal(res.statusCode, 403);
  assert.equal(redis.store.size, 0, '1 件も書いていない');

  const wrong = await post({ action: 'reopenStart', actor: 'MK' }, { secret: 'wrong' });
  assert.equal(wrong.statusCode, 403);
  assert.equal(redis.store.size, 0);
});

test('開始前の状態は「未開始」（読み取りだけ・書き込みゼロ）', async () => {
  const res = await post({ action: 'reopenStatus' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reopenStart.state, 'not_started');
  assert.equal(res.body.reopenStart.startable, true);
  assert.equal(res.body.reopenStart.expiryDetermined, false);
  assert.equal(res.body.sideEffects, 'none');
  assert.equal(redis.store.size, 0);
  assert.deepEqual(db.writes, []);
});

test('開始日時は client の申告ではなくサーバー時刻', async () => {
  const before = Date.now();
  const res = await post({
    action: 'reopenStart',
    actor: 'MK',
    // ⚠️ client が時刻を偽装しようとしても採用されないこと
    startsAt: '2020-01-01T00:00:00.000Z',
    reopenStartsAt: '2020-01-01T00:00:00.000Z',
    now: Date.parse('2020-01-01T00:00:00.000Z'),
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const after = Date.now();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.created, true);
  const saved = stored();
  assert.ok(saved, '保存されている');
  assert.ok(!saved.startsAt.startsWith('2020-'), 'client の値を採用していない');
  const savedMs = Date.parse(saved.startsAt);
  assert.ok(savedMs >= before && savedMs <= after, 'サーバー時刻の範囲に入っている');
  assert.equal(res.body.reopenStart.startsAtIso, saved.startsAt);
  // 期限も client の申告ではなく「開始 + 14 日」
  const def = withReopenStart(saved.startsAt);
  assert.equal(res.body.reopenStart.expiresAtIso, def.terms.expiresAt);
  assert.notEqual(res.body.reopenStart.expiresAtIso, '2099-01-01T00:00:00.000Z');
});

test('Airtable には 1 バイトも書かない', async () => {
  await post({ action: 'reopenStart', actor: 'MK' });
  await post({ action: 'reopenStart', actor: 'MK' });
  await post({ action: 'reopenStatus' });
  assert.deepEqual(db.writes, [], 'Customers / PromotionalOffers / 履歴のどれにも書いていない');
  // 触った Redis の鍵も 1 本だけ
  assert.deepEqual([...redis.store.keys()], [REOPEN_START_KEY]);
});

test('2 回目は上書きしない（冪等）', async () => {
  const first = await post({ action: 'reopenStart', actor: 'MK' });
  const saved1 = stored().startsAt;

  const second = await post({ action: 'reopenStart', actor: 'あとから押した人' });
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.created, false, '2 回目は書いていない');
  assert.equal(second.body.alreadyStarted, true);
  assert.equal(second.body.sideEffects, 'none');
  assert.equal(second.body.reopenStart.startsAtIso, first.body.reopenStart.startsAtIso);
  assert.equal(stored().startsAt, saved1, '保存値が変わっていない');
  assert.equal(stored().actor, 'MK', '最初の操作者のまま');
});

test('並行要求でも開始日時は 1 つに確定する', async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => post({ action: 'reopenStart', actor: `A${i}` })),
  );
  assert.ok(results.every((r) => r.statusCode === 200));
  assert.equal(results.filter((r) => r.body.created === true).length, 1);
  const isos = new Set(results.map((r) => r.body.reopenStart.startsAtIso));
  assert.equal(isos.size, 1, '全員が同じ開始日時を返す');
  assert.equal([...isos][0], stored().startsAt);
});

test('保存先が使えないときは 503（開始したと言わない・副作用ゼロ）', async () => {
  redis = makeRedis({ down: true });
  const res = await post({ action: 'reopenStart', actor: 'MK' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.started, false);
  assert.equal(res.body.code, 'reopen_store_unavailable');
  assert.equal(res.body.sideEffects, 'none');
  assert.deepEqual(db.writes, []);

  // 読めないときは「未開始」と言わない
  const st = await post({ action: 'reopenStatus' });
  assert.equal(st.body.reopenStart.state, 'unknown');
  assert.equal(st.body.reopenStart.startable, false);
});

test('開始後は一覧の期限表示とサーバーの実効状態が一致する', async () => {
  const before = await post({ action: 'list' });
  assert.equal(before.body.reopenStart.state, 'not_started');
  assert.equal(before.body.reopenCoupon.expiryDetermined, false);
  const rowBefore = before.body.rows.find((r) => r.recordId === REC);
  assert.ok(rowBefore, '対象会員が一覧に出ている');
  assert.match(rowBefore.reopenCouponExpiryText, /募集再開日から14日間/);

  await post({ action: 'reopenStart', actor: 'MK' });
  const startsAt = stored().startsAt;
  const def = withReopenStart(startsAt);

  const after = await post({ action: 'list' });
  assert.equal(after.body.reopenStart.state, 'started');
  assert.equal(after.body.reopenStart.startsAtIso, startsAt);
  assert.equal(after.body.reopenStart.expiresAtIso, def.terms.expiresAt);
  assert.equal(after.body.reopenStart.startable, false);
  assert.equal(after.body.reopenCoupon.expiryDetermined, true);

  const rowAfter = after.body.rows.find((r) => r.recordId === REC);
  // 会員行の期限表示も**同じ単一源**から作られている
  assert.equal(rowAfter.reopenCouponExpiryText, describeCouponExpiry(def));
  assert.match(rowAfter.reopenCouponExpiryText, /まで$/);

  // 個別検索（lookup）でも同じ値
  const look = await post({ action: 'lookup', query: EMAIL });
  assert.equal(look.body.reopenStart.startsAtIso, startsAt);
  const rowLook = look.body.rows.find((r) => r.recordId === REC);
  assert.equal(rowLook.reopenCouponExpiryText, rowAfter.reopenCouponExpiryText);

  // ここまで Airtable への書き込みは 0 件のまま
  assert.deepEqual(db.writes, []);
});

test('資格・停止・プラン・決済の値は開始で 1 つも変わらない', async () => {
  const snapshot = JSON.stringify(db.customers[REC]);
  await post({ action: 'reopenStart', actor: 'MK' });
  assert.equal(JSON.stringify(db.customers[REC]), snapshot);
});
