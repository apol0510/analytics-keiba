/**
 * adminReopenStart.smoke.test.mjs — 「この会員の再募集を開始」を **Function 越しに**動かす
 *
 * 合成 Redis（`HSETNX` / lock を本物どおり）＋ 合成 Airtable に対して本物の handler を実行する。
 *
 * 固定する安全条件:
 *   - **未開始 + 販売停止中 → 1 操作**で「販売再開」と「開始日時の確定」を両方行う
 *   - 開始日時は**サーバー時刻**。client が `startsAt` / `now` を送っても採用しない
 *   - 期限は**開始 + 14 日**
 *   - 同じ操作を再送しても開始日時が変わらない／**不要な PATCH をしない**
 *   - 並行 8 要求でも開始は 1 回だけ
 *   - **A を開始しても B は不変**（他会員の Customers を 1 バイトも変えない）
 *   - eligibility / override / phase / route / plan / payment を変更しない
 *   - 開始済み会員を**後から販売一時停止できる**／その後**再開しても開始日時は変わらない**
 *   - **partial success**（Redis は書けたが Airtable が落ちた）→ 途中成功を曖昧にせず、
 *     同じボタンの再送で復旧できる
 *   - Redis 失敗 / Airtable 失敗 / read 不能 → **fail closed**（開始だけ確定させない）
 *   - admin secret 無し・不正 recordId → API 直叩き・URL 直打ちでも止まる
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const FN = fileURLToPath(new URL('../../../netlify/functions/premium-plus-eligibility.js', import.meta.url));
const { REOPEN_MEMBERS_KEY } = await import('./premiumPlusReopenStartStore.js');
const { withReopenStart } = await import('./premiumPlusReopenStart.js');
const { describeCouponExpiry } = await import('./premiumPlusReopenCoupon.js');
const { PP_SALE_PAUSE_FIELDS } = await import('./premiumPlusRelease.js');
const { LAUNCH_STATE } = await import('./premiumPlusReopenLaunch.js');

const SECRET = 'admin-secret-for-test';
/** 開始する会員 */
const A = 'recAAAAAAAAAAAAAA';
/** 開始しない会員（巻き添えを検査する） */
const B = 'recBBBBBBBBBBBBBB';
const A_MAIL = 'a-synthetic@example.invalid';
const B_MAIL = 'b-synthetic@example.invalid';
/** 開始より前の停止時刻（＝途中成功の再現に使う） */
const PAUSED_BEFORE = '2026-08-19T00:00:00.000Z';

let db;
let redis;
let realFetch;
let realEnv;

/** HSETNX / HGET / HMGET / SET NX / EVAL(lock) を本物どおりに実装した合成 Redis */
function makeRedis({ down = false } = {}) {
  const hashes = new Map();
  const plain = new Map();
  const h = (k) => {
    if (!hashes.has(k)) hashes.set(k, new Map());
    return hashes.get(k);
  };
  /** 読み取り用。⚠️ **読んだだけで鍵を作らない** */
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
    if (op === 'INCR') { const n = Number(plain.get(key) || 0) + 1; plain.set(key, String(n)); return n; }
    if (op === 'SET') {
      const [value, ...opts] = rest;
      if (opts.includes('NX') && plain.has(key)) return null;
      plain.set(key, value);
      return 'OK';
    }
    if (op === 'EVAL') {
      const [script, , k, token] = [key, ...rest];   // EVAL <script> <n> <key> <token>
      const lockKey = rest[1];
      const tok = rest[2];
      const cur = plain.get(lockKey);
      if (cur === undefined) return 'LOST';
      if (cur !== tok) return 'STOLEN';
      if (String(script).includes('DEL')) plain.delete(lockKey);
      return 'OK';
    }
    return null;
  };
  return { cmd, hashes, plain, member: (f) => ro(REOPEN_MEMBERS_KEY).get(f) };
}

const member = (over = {}) => ({
  'プラン': 'Premium Sanrenpuku', 'Status': 'active', '有効期限': '2099-12-31',
  'SanrenpukuPaidAt': '2020-01-01T00:00:00.000Z',
  'PremiumPlusEligibility': 'eligible',
  'PremiumPlusReleaseOverride': '',
  PremiumPlusReopenCouponClaimedAt: '2026-08-18T22:07:54.000Z',
  PremiumPlusReopenCouponId: 'premium-plus-reopen-priority@v1',
  PremiumPlusReopenCouponSource: 'pause-notice',
  ...over,
});

function makeDb() {
  return {
    customers: {
      // A: 未開始 + 販売停止中（今回の主シナリオ）
      [A]: {
        Email: A_MAIL,
        '氏名': 'テストA',
        ...member({
          [PP_SALE_PAUSE_FIELDS.PAUSED]: true,
          [PP_SALE_PAUSE_FIELDS.UPDATED_AT]: PAUSED_BEFORE,
          [PP_SALE_PAUSE_FIELDS.UPDATED_BY]: 'MK',
          [PP_SALE_PAUSE_FIELDS.REASON]: '募集停止中',
        }),
      },
      // B: 未開始 + 販売停止中（巻き添えが無いことの検査用）
      [B]: {
        Email: B_MAIL,
        '氏名': 'テストB',
        ...member({
          [PP_SALE_PAUSE_FIELDS.PAUSED]: true,
          [PP_SALE_PAUSE_FIELDS.UPDATED_AT]: PAUSED_BEFORE,
        }),
      },
    },
    /** Customers への PATCH を記録する */
    writes: [],
    /** Customers 以外（予約台帳・履歴）への書き込み */
    otherWrites: [],
    /** Customers の PATCH を落とす（partial success の再現） */
    patchFails: false,
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
      if (u.includes('/Customers/listRecords')) {
        return ok({ records: Object.entries(db.customers).map(([id, fields]) => ({ id, fields })) });
      }
      if (u.includes('/PromotionalOffers') || u.includes('/CouponOperationHistory')) {
        if (method !== 'GET' && !u.endsWith('/listRecords')) {
          db.otherWrites.push({ url: u, method });
          return err(403);
        }
        return ok({ records: [] });
      }
      if (u.includes('/CampaignDeliveries')) return ok({ records: [] });
      if (u.includes('/Customers/')) {
        const id = u.split('/Customers/')[1];
        if (!db.customers[id]) return err(404);
        if (method === 'PATCH') {
          const body = JSON.parse(init.body || '{}');
          db.writes.push({ id, fields: body.fields });
          if (db.patchFails) return err(500);
          Object.assign(db.customers[id], body.fields);
          return ok({ id, fields: db.customers[id] });
        }
        return ok({ id, fields: db.customers[id] });
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

const launch = (id = A, over = {}) => post({
  action: 'reopenStart', recordId: id, email: id === A ? A_MAIL : B_MAIL, actor: 'MK', ...over,
});
const stored = (id) => {
  const raw = redis.member(id);
  return raw ? JSON.parse(raw) : null;
};
const rowOf = (res, id) => (res.body.rows || []).find((r) => r.recordId === id);
const paused = (id) => db.customers[id][PP_SALE_PAUSE_FIELDS.PAUSED] === true;

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

// ── 主シナリオ: 1 操作で両方 ────────────────────────────────
test('未開始 + 販売停止中 → 1 操作で販売再開 + 再募集開始', async () => {
  const before = Date.now();
  const res = await launch();
  const after = Date.now();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.startWritten, true, '開始日時を書いた');
  assert.equal(res.body.saleResumed, true, '販売を再開した');
  assert.equal(res.body.sideEffects, 'reopen_start_and_sale_resume');
  assert.equal(res.body.launch.state, LAUNCH_STATE.LIVE);

  // Redis: サーバー時刻で確定
  const saved = stored(A);
  assert.ok(saved, '保存されている');
  const ms = Date.parse(saved.startsAt);
  assert.ok(ms >= before && ms <= after, 'サーバー時刻の範囲');

  // Airtable: 販売停止だけ解除。資格・会員権・決済は不変
  assert.equal(paused(A), false);
  assert.equal(db.writes.length, 1, 'PATCH は 1 回だけ');
  assert.deepEqual(Object.keys(db.writes[0].fields).sort(), [
    PP_SALE_PAUSE_FIELDS.PAUSED, PP_SALE_PAUSE_FIELDS.REASON,
    PP_SALE_PAUSE_FIELDS.UPDATED_AT, PP_SALE_PAUSE_FIELDS.UPDATED_BY,
  ].sort(), '販売停止の 4 列以外を書いていない');

  // 期限は開始 + 14 日
  const def = withReopenStart(saved.startsAt);
  assert.equal(res.body.reopenStart.expiresAtIso, def.terms.expiresAt);
  assert.equal(Date.parse(def.terms.expiresAt) - ms, 14 * 24 * 3600 * 1000);
});

test('開始日時は client の申告ではなくサーバー時刻', async () => {
  const res = await launch(A, {
    startsAt: '2020-01-01T00:00:00.000Z',
    reopenStartsAt: '2020-01-01T00:00:00.000Z',
    now: Date.parse('2020-01-01T00:00:00.000Z'),
    expiresAt: '2099-01-01T00:00:00.000Z',
  });
  assert.equal(res.body.startWritten, true);
  assert.ok(!stored(A).startsAt.startsWith('2020-'));
  assert.notEqual(res.body.reopenStart.expiresAtIso, '2099-01-01T00:00:00.000Z');
});

test('eligibility / override / plan / payment / クーポン保有は変わらない', async () => {
  const keep = ['PremiumPlusEligibility', 'PremiumPlusReleaseOverride', 'プラン', 'Status',
    '有効期限', 'SanrenpukuPaidAt', 'PremiumPlusReopenCouponClaimedAt'];
  const before = Object.fromEntries(keep.map((k) => [k, db.customers[A][k]]));
  await launch();
  for (const k of keep) assert.deepEqual(db.customers[A][k], before[k], k);
  assert.equal(db.otherWrites.length, 0, '予約台帳・履歴に書いていない');
});

test('A を開始しても B は 1 バイトも変わらない', async () => {
  const bBefore = JSON.stringify(db.customers[B]);
  await launch(A);
  assert.equal(JSON.stringify(db.customers[B]), bBefore);
  assert.equal(redis.member(B), undefined, 'B の開始日時は作られていない');
  assert.ok(db.writes.every((w) => w.id === A), '他会員を PATCH していない');
});

// ── 冪等・並行 ─────────────────────────────────────────────
test('同じ操作を再送しても開始日時は変わらず、不要な PATCH もしない', async () => {
  const first = await launch();
  const saved1 = stored(A).startsAt;
  const writes1 = db.writes.length;

  const second = await launch(A, { actor: 'あとから押した人' });
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.startWritten, false, '2 回目は開始日時を書いていない');
  assert.equal(second.body.saleResumed, false, '既に販売中なので PATCH しない');
  assert.equal(second.body.sideEffects, 'none');
  assert.equal(stored(A).startsAt, saved1);
  assert.equal(stored(A).actor, 'MK', '最初の操作者のまま');
  assert.equal(db.writes.length, writes1, 'PATCH が増えていない');
  assert.equal(second.body.reopenStart.expiresAtIso, first.body.reopenStart.expiresAtIso);
});

test('並行 8 要求でも開始は 1 回だけ（排他が効く）', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => launch()));
  const started = results.filter((r) => r.statusCode === 200 && r.body.startWritten === true);
  assert.equal(started.length, 1, '開始日時を書いたのは 1 本だけ');
  // 競合した実行は「進行中」で断られる（副作用ゼロ）か、冪等な成功のいずれか
  for (const r of results) {
    if (r.statusCode === 200) continue;
    assert.equal(r.statusCode, 503);
    assert.equal(r.body.sideEffects, 'none');
  }
  const isos = new Set(results.filter((r) => r.statusCode === 200)
    .map((r) => r.body.reopenStart.startsAtIso));
  assert.equal(isos.size, 1, '成功した応答はすべて同じ開始日時');
  assert.equal([...isos][0], stored(A).startsAt);
  assert.ok(db.writes.length <= 1, '販売再開の PATCH も 1 回まで');
});

// ── 途中成功と復旧 ──────────────────────────────────────────
test('Airtable が落ちたら途中成功として返し、再送で復旧できる', async () => {
  db.patchFails = true;
  const bad = await launch();

  assert.equal(bad.statusCode, 502);
  assert.equal(bad.body.ok, false, '成功と言わない');
  assert.equal(bad.body.startWritten, true);
  assert.equal(bad.body.saleResumed, false);
  assert.equal(bad.body.sideEffects, 'reopen_start_only', '途中成功を曖昧にしない');
  assert.equal(bad.body.launch.state, LAUNCH_STATE.INCOMPLETE);
  assert.match(bad.body.note, /販売の再開に失敗/);
  assert.equal(paused(A), true, '販売は停止したまま（お金の経路は閉じている）');
  const saved = stored(A).startsAt;

  // 復旧: 同じボタンをもう一度
  db.patchFails = false;
  const fixed = await launch();
  assert.equal(fixed.statusCode, 200);
  assert.equal(fixed.body.startWritten, false, '開始日時は書き直さない');
  assert.equal(fixed.body.saleResumed, true, '販売だけ再開する');
  assert.equal(fixed.body.sideEffects, 'sale_resume_only');
  assert.equal(stored(A).startsAt, saved, '開始日時は不変');
  assert.equal(paused(A), false);
  assert.equal(fixed.body.launch.state, LAUNCH_STATE.LIVE);
});

test('Redis が落ちたら何も書かない（Airtable も触らない）', async () => {
  redis = makeRedis({ down: true });
  const res = await launch();
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.sideEffects, 'none');
  assert.deepEqual(db.writes, [], 'Airtable を触っていない');
  assert.equal(paused(A), true, '販売は停止したまま');
});

test('販売停止フィールドが未有効なら開始日時も書かない（片側状態を作らない）', async () => {
  delete process.env.PREMIUM_PLUS_SALE_PAUSE_READY;
  const res = await launch();
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, 'sale_pause_not_ready');
  assert.equal(res.body.sideEffects, 'none');
  assert.equal(redis.member(A), undefined, '開始日時を書いていない');
  assert.deepEqual(db.writes, []);
});

// ── 開始後の安全スイッチ ────────────────────────────────────
test('開始済み会員を後から販売一時停止でき、再開しても開始日時は変わらない', async () => {
  await launch();
  const saved = stored(A).startsAt;

  // 緊急停止（独立した安全スイッチ）
  const stop = await post({ action: 'setSalePause', recordId: A, paused: true, reason: '緊急', actor: 'MK' });
  assert.equal(stop.statusCode, 200);
  assert.equal(paused(A), true);
  assert.equal(stored(A).startsAt, saved, '停止しても開始日時は変わらない');

  // この状態で「再募集を開始」は**断られる**（緊急停止を勝手に解除しない）
  const denied = await launch();
  assert.equal(denied.statusCode, 409);
  assert.equal(denied.body.code, 'reopen_deliberately_paused');
  assert.equal(denied.body.sideEffects, 'none');
  assert.equal(paused(A), true, '解除されていない');

  // 明示的な「販売を再開する」でだけ戻せる
  const resume = await post({ action: 'setSalePause', recordId: A, paused: false, actor: 'MK' });
  assert.equal(resume.statusCode, 200);
  assert.equal(paused(A), false);
  assert.equal(stored(A).startsAt, saved, '再開しても開始日時は変わらない');
});

// ── 直叩き・入力検証 ────────────────────────────────────────
test('secret 無し / 不正 recordId は止まる（URL 直打ち・API 直呼び）', async () => {
  for (const secret of ['', 'wrong']) {
    const res = await post({ action: 'reopenStart', recordId: A, email: A_MAIL, actor: 'MK' }, { secret });
    assert.equal(res.statusCode, 403, `secret=${JSON.stringify(secret)}`);
  }
  for (const bad of [undefined, '', 'nope', 'recSHORT', 'rec../x']) {
    const res = await post({ action: 'reopenStart', recordId: bad, actor: 'MK' });
    assert.equal(res.statusCode, 400, String(bad));
    assert.equal(res.body.sideEffects, 'none');
  }
  assert.equal(redis.hashes.size, 0, '1 件も書いていない');
  assert.deepEqual(db.writes, []);
});

test('存在しない会員は 404（何も書かない）', async () => {
  const res = await post({ action: 'reopenStart', recordId: 'recZZZZZZZZZZZZZZ', actor: 'MK' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.sideEffects, 'none');
  assert.equal(redis.hashes.size, 0);
});

// ── 一覧・個別検索の表示 ────────────────────────────────────
test('一覧が会員ごとの状態と期限を返す（開始した人だけ確定）', async () => {
  const before = await post({ action: 'list' });
  assert.equal(rowOf(before, A).reopenLaunch.state, LAUNCH_STATE.NOT_STARTED);
  assert.equal(rowOf(before, A).reopenLaunch.action.kind, 'start');
  // 未開始 + 停止中では「販売を再開する」を出さない（主操作と並べない）
  assert.equal(rowOf(before, A).reopenLaunch.action.showResumeSwitch, false);
  assert.match(rowOf(before, A).reopenCouponExpiryText, /募集再開日から14日間/);

  await launch(A);
  const def = withReopenStart(stored(A).startsAt);
  const after = await post({ action: 'list' });

  assert.equal(rowOf(after, A).reopenLaunch.state, LAUNCH_STATE.LIVE);
  assert.equal(rowOf(after, A).reopenLaunch.action.kind, 'none');
  assert.equal(rowOf(after, A).reopenLaunch.action.showPauseSwitch, true, '緊急停止は残す');
  assert.equal(rowOf(after, A).reopenCouponExpiryText, describeCouponExpiry(def));
  assert.equal(rowOf(after, A).salePaused, false);
  // B は未開始・停止中のまま
  assert.equal(rowOf(after, B).reopenLaunch.state, LAUNCH_STATE.NOT_STARTED);
  assert.equal(rowOf(after, B).salePaused, true);
  assert.match(rowOf(after, B).reopenCouponExpiryText, /募集再開日から14日間/);
  assert.equal(after.body.counts.reopenStarted, 1);
  assert.equal(after.body.counts.reopenIncomplete, 0);

  // 個別検索でも同じ
  const look = await post({ action: 'lookup', query: A_MAIL });
  assert.equal(rowOf(look, A).reopenLaunch.state, LAUNCH_STATE.LIVE);
});

test('途中成功の会員は一覧で「販売再開が未完了」として数えられる', async () => {
  db.patchFails = true;
  await launch(A);
  db.patchFails = false;
  const list = await post({ action: 'list' });
  assert.equal(rowOf(list, A).reopenLaunch.state, LAUNCH_STATE.INCOMPLETE);
  assert.equal(rowOf(list, A).reopenLaunch.action.kind, 'repair');
  assert.equal(list.body.counts.reopenIncomplete, 1);
});

test('read 不能時は unknown で、操作を出さない（fail closed）', async () => {
  redis = makeRedis({ down: true });
  const list = await post({ action: 'list' });
  assert.equal(list.body.reopenStarts.available, false);
  assert.equal(list.body.counts.reopenStarted, null, '0 名と言わない');
  assert.equal(list.body.counts.reopenIncomplete, null);
  assert.equal(rowOf(list, A).reopenLaunch.state, LAUNCH_STATE.UNKNOWN);
  assert.equal(rowOf(list, A).reopenLaunch.action.kind, 'none');
  assert.equal(rowOf(list, A).reopenLaunch.action.showResumeSwitch, false);
});
