/**
 * adminReopenStart.smoke.test.mjs — 「この会員の再募集を開始」を **Function 越しに**動かす
 *
 * 合成 Redis（`HSETNX` は本物どおり）＋ 合成 Airtable に対して本物の handler を実行する。
 *
 * 固定する安全条件:
 *   - 開始日時は**サーバー時刻**。client が `startsAt` / `now` を送っても採用しない
 *   - **その会員だけ**開始される（A を開始しても B は未開始）
 *   - 同一会員の 2 回目・並行 8 要求では**上書きしない**（created は 1 回）
 *   - **Airtable へは 1 バイトも書かない**（Customers / PromotionalOffers / 履歴のいずれも）
 *   - **他会員の Customers / 予約 / 履歴を変更しない**
 *   - 保存先が使えなければ 503 で「開始した」と言わない（副作用ゼロ）
 *   - admin secret が無ければ実行できない（API 直叩き・URL 直打ちでも同じ）
 *   - 会員指定が不正なら 400（任意文字列で鍵空間を汚さない）
 *   - 一覧・個別検索の期限表示が**会員ごとに**サーバー実効状態と一致する
 *   - `salePaused` は再募集開始で 1 バイトも変わらない（購入可否は既存判定のまま）
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const FN = fileURLToPath(new URL('../../../netlify/functions/premium-plus-eligibility.js', import.meta.url));
const { REOPEN_MEMBERS_KEY } = await import('./premiumPlusReopenStartStore.js');
const { withReopenStart } = await import('./premiumPlusReopenStart.js');
const { describeCouponExpiry } = await import('./premiumPlusReopenCoupon.js');

const SECRET = 'admin-secret-for-test';
/** 開始する会員 */
const A = 'recAAAAAAAAAAAAAA';
/** 開始しない会員（巻き添えを検査する） */
const B = 'recBBBBBBBBBBBBBB';
const A_MAIL = 'a-synthetic@example.invalid';
const B_MAIL = 'b-synthetic@example.invalid';

let db;
let redis;
let realFetch;
let realEnv;

/** HSETNX / HGET / HMGET を本物どおりに実装した合成 Redis */
function makeRedis({ down = false } = {}) {
  const hashes = new Map();
  /** 書き込み用（無ければ作る）*/
  const h = (k) => {
    if (!hashes.has(k)) hashes.set(k, new Map());
    return hashes.get(k);
  };
  /** 読み取り用。⚠️ **読んだだけで鍵を作らない**（本物と同じ挙動にする）*/
  const ro = (k) => hashes.get(k) || new Map();
  const cmd = async (args) => {
    if (down) throw new Error('redis_down');
    const [op, key, ...rest] = args;
    if (op === 'HSETNX') {
      const [field, value] = rest;
      if (h(key).has(field)) return 0;
      h(key).set(field, value);
      return 1;
    }
    if (op === 'HGET') return ro(key).has(rest[0]) ? ro(key).get(rest[0]) : null;
    if (op === 'HMGET') return rest.map((f) => (ro(key).has(f) ? ro(key).get(f) : null));
    if (op === 'INCR') { const n = Number(h('n').get(key) || 0) + 1; h('n').set(key, String(n)); return n; }
    return null;
  };
  return { cmd, hashes, member: (f) => ro(REOPEN_MEMBERS_KEY).get(f) };
}

const member = (over = {}) => ({
  'プラン': 'Premium Sanrenpuku', 'Status': 'active', '有効期限': '2099-12-31',
  'SanrenpukuPaidAt': '2020-01-01T00:00:00.000Z',
  'PremiumPlusEligibility': 'eligible',
  PremiumPlusReopenCouponClaimedAt: '2026-08-18T22:07:54.000Z',
  PremiumPlusReopenCouponId: 'premium-plus-reopen-priority@v1',
  PremiumPlusReopenCouponSource: 'pause-notice',
  ...over,
});

function makeDb() {
  return {
    customers: {
      [A]: { Email: A_MAIL, '氏名': 'テストA', ...member() },
      // B は販売一時停止中（開始しても停止は解除されないことを検査する）
      [B]: { Email: B_MAIL, '氏名': 'テストB', ...member({ PremiumPlusSalePaused: true }) },
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
    if (u.includes('api.airtable.com')) {
      if ((method === 'PATCH' || method === 'POST' || method === 'DELETE') && !u.endsWith('/listRecords')) {
        db.writes.push({ url: u, method, body: init.body });
        return err(403);
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

const stored = (id) => {
  const raw = redis.member(id);
  return raw ? JSON.parse(raw) : null;
};
const rowOf = (res, id) => (res.body.rows || []).find((r) => r.recordId === id);

beforeEach(() => {
  realFetch = globalThis.fetch;
  realEnv = { ...process.env };
  process.env.PREMIUM_PLUS_ADMIN_SECRET = SECRET;
  process.env.AIRTABLE_API_KEY = 'key-test';
  process.env.AIRTABLE_BASE_ID = 'app-test';
  process.env.PREMIUM_PLUS_FIELDS_READY = '1';
  process.env.PREMIUM_PLUS_REOPEN_COUPON_READY = '1';
  process.env.PREMIUM_PLUS_SALE_PAUSE_READY = '1';
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

test('secret が無ければ開始できない（API 直叩き・URL 直打ちでも同じ）', async () => {
  for (const secret of ['', 'wrong']) {
    const res = await post({ action: 'reopenStart', recordId: A, actor: 'MK' }, { secret });
    assert.equal(res.statusCode, 403);
  }
  assert.equal(redis.hashes.size, 0, '1 件も書いていない');
  assert.deepEqual(db.writes, []);
});

test('会員の指定が不正なら 400（鍵空間を汚さない）', async () => {
  for (const bad of [undefined, '', 'nope', 'recSHORT', 'rec../x']) {
    const res = await post({ action: 'reopenStart', recordId: bad, actor: 'MK' });
    assert.equal(res.statusCode, 400, String(bad));
    assert.equal(res.body.sideEffects, 'none');
  }
  const st = await post({ action: 'reopenStatus', recordId: 'nope' });
  assert.equal(st.statusCode, 400);
  assert.equal(redis.hashes.size, 0);
});

test('開始前は「未開始」（読み取りだけ・書き込みゼロ）', async () => {
  const res = await post({ action: 'reopenStatus', recordId: A, email: A_MAIL });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reopenStart.state, 'not_started');
  assert.equal(res.body.reopenStart.startable, true);
  assert.equal(res.body.reopenStart.expiryDetermined, false);
  assert.equal(res.body.sideEffects, 'none');
  assert.equal(redis.hashes.size, 0);
  assert.deepEqual(db.writes, []);
  // 確認文言に対象会員が入っている（取り違え防止）
  assert.match(res.body.reopenStart.confirmText, /a-synthetic@example\.invalid/);
});

test('開始日時は client の申告ではなくサーバー時刻', async () => {
  const before = Date.now();
  const res = await post({
    action: 'reopenStart', recordId: A, email: A_MAIL, actor: 'MK',
    // ⚠️ client が時刻を偽装しようとしても採用されないこと
    startsAt: '2020-01-01T00:00:00.000Z',
    reopenStartsAt: '2020-01-01T00:00:00.000Z',
    now: Date.parse('2020-01-01T00:00:00.000Z'),
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const after = Date.now();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.created, true);
  const saved = stored(A);
  assert.ok(saved && !saved.startsAt.startsWith('2020-'), 'client の値を採用していない');
  const ms = Date.parse(saved.startsAt);
  assert.ok(ms >= before && ms <= after, 'サーバー時刻の範囲に入っている');
  // 期限も client の申告ではなく「開始 + 14 日」
  assert.equal(res.body.reopenStart.expiresAtIso, withReopenStart(saved.startsAt).terms.expiresAt);
  assert.notEqual(res.body.reopenStart.expiresAtIso, '2099-01-01T00:00:00.000Z');
});

test('A を開始しても B は未開始（他会員へ影響しない）', async () => {
  await post({ action: 'reopenStart', recordId: A, email: A_MAIL, actor: 'MK' });

  const stB = await post({ action: 'reopenStatus', recordId: B, email: B_MAIL });
  assert.equal(stB.body.reopenStart.state, 'not_started');
  assert.equal(stB.body.reopenStart.startable, true);
  assert.equal(redis.member(B), undefined, 'B のフィールドは作られていない');

  const list = await post({ action: 'list' });
  assert.equal(rowOf(list, A).reopenStart.state, 'started');
  assert.equal(rowOf(list, B).reopenStart.state, 'not_started');
  assert.equal(list.body.counts.reopenStarted, 1);
});

test('Airtable には 1 バイトも書かない（他会員のレコードも変更しない）', async () => {
  const snapshot = JSON.stringify(db.customers);
  await post({ action: 'reopenStart', recordId: A, email: A_MAIL, actor: 'MK' });
  await post({ action: 'reopenStart', recordId: A, email: A_MAIL, actor: 'MK' });
  await post({ action: 'reopenStatus', recordId: B });
  assert.deepEqual(db.writes, [], 'Customers / PromotionalOffers / 履歴のどれにも書いていない');
  assert.equal(JSON.stringify(db.customers), snapshot, '会員レコードが 1 文字も変わっていない');
  // 触った Redis の鍵も 1 本だけ
  assert.deepEqual([...redis.hashes.keys()], [REOPEN_MEMBERS_KEY]);
});

test('同一会員の 2 回目は上書きしない（冪等）', async () => {
  const first = await post({ action: 'reopenStart', recordId: A, email: A_MAIL, actor: 'MK' });
  const saved1 = stored(A).startsAt;

  const second = await post({ action: 'reopenStart', recordId: A, email: A_MAIL, actor: 'あとから押した人' });
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.created, false, '2 回目は書いていない');
  assert.equal(second.body.alreadyStarted, true);
  assert.equal(second.body.sideEffects, 'none');
  assert.equal(second.body.reopenStart.startsAtIso, first.body.reopenStart.startsAtIso);
  assert.equal(stored(A).startsAt, saved1);
  assert.equal(stored(A).actor, 'MK', '最初の操作者のまま');
});

test('同一会員への並行 8 要求でも created は 1 回', async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => post({ action: 'reopenStart', recordId: A, actor: `A${i}` })),
  );
  assert.ok(results.every((r) => r.statusCode === 200));
  assert.equal(results.filter((r) => r.body.created === true).length, 1);
  const isos = new Set(results.map((r) => r.body.reopenStart.startsAtIso));
  assert.equal(isos.size, 1);
  assert.equal([...isos][0], stored(A).startsAt);
});

test('保存先が使えないときは 503（開始したと言わない・副作用ゼロ）', async () => {
  redis = makeRedis({ down: true });
  const res = await post({ action: 'reopenStart', recordId: A, actor: 'MK' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.started, false);
  assert.equal(res.body.code, 'reopen_store_unavailable');
  assert.equal(res.body.sideEffects, 'none');
  assert.deepEqual(db.writes, []);

  // 読めないときは「未開始」と言わない
  const st = await post({ action: 'reopenStatus', recordId: A });
  assert.equal(st.body.reopenStart.state, 'unknown');
  assert.equal(st.body.reopenStart.startable, false);

  // 一覧でも「全員未開始」に丸めない（件数も出さない）
  const list = await post({ action: 'list' });
  assert.equal(list.body.reopenStarts.available, false);
  assert.equal(list.body.counts.reopenStarted, null);
  assert.equal(rowOf(list, A).reopenStart.state, 'unknown');
});

test('一覧・個別検索の期限表示が会員ごとにサーバー実効状態と一致する', async () => {
  const before = await post({ action: 'list' });
  assert.match(rowOf(before, A).reopenCouponExpiryText, /募集再開日から14日間/);
  assert.match(rowOf(before, B).reopenCouponExpiryText, /募集再開日から14日間/);

  await post({ action: 'reopenStart', recordId: A, email: A_MAIL, actor: 'MK' });
  const defA = withReopenStart(stored(A).startsAt);

  const after = await post({ action: 'list' });
  assert.equal(rowOf(after, A).reopenCouponExpiryText, describeCouponExpiry(defA));
  assert.match(rowOf(after, A).reopenCouponExpiryText, /まで$/);
  // B は未開始のまま＝未確定表示（A の期限が漏れない）
  assert.match(rowOf(after, B).reopenCouponExpiryText, /募集再開日から14日間/);
  assert.equal(rowOf(after, A).reopenStart.expiresAtIso, defA.terms.expiresAt);

  // 個別検索でも同じ値
  const look = await post({ action: 'lookup', query: A_MAIL });
  assert.equal(rowOf(look, A).reopenCouponExpiryText, rowOf(after, A).reopenCouponExpiryText);
  assert.equal(look.body.reopenStarts.available, true);

  assert.deepEqual(db.writes, []);
});

test('再募集を開始しても販売の一時停止・資格・プラン・決済は変わらない', async () => {
  // B は停止中。開始しても停止は解除されない（購入可否は既存判定のまま）
  const snapshot = JSON.stringify(db.customers[B]);
  await post({ action: 'reopenStart', recordId: B, email: B_MAIL, actor: 'MK' });
  assert.equal(JSON.stringify(db.customers[B]), snapshot);

  const list = await post({ action: 'list' });
  const b = rowOf(list, B);
  assert.equal(b.reopenStart.state, 'started', '開始はされている');
  assert.equal(b.salePaused, true, 'それでも一時停止中のまま');
  assert.equal(b.eligibility, 'eligible', '資格も変わらない');
  assert.deepEqual(db.writes, []);
});
