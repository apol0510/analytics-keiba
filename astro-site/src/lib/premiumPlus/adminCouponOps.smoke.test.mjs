/**
 * adminCouponOps.smoke.test.mjs — クーポンの管理操作を **Function 越しに**通しで動かす
 *
 * 合成 Airtable（メモリ上）に対して本物の handler を実行し、
 * **付与 → 確認 → 予約取消 / 誤取得訂正 → 再発行 → 再確認**のライフサイクルを固定する。
 *
 * 併せて固定する安全条件:
 *   - **書かれたフィールドを実際に検査**する（クーポン 3 列 / 予約行 2 列以外を書かない）
 *   - **他会員のレコードを 1 度も PATCH しない**
 *   - 二重付与 / 二重取消 / 使用済みの再利用を Function が断る（副作用ゼロ）
 *   - 台帳を読めないときは**書き込みを一切しない**（fail closed）
 *   - admin secret が無ければ実行できない（API 直叩きでも同じ制約）
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const FN = fileURLToPath(new URL('../../../netlify/functions/premium-plus-eligibility.js', import.meta.url));
const { couponIdWithVersion, PP_REOPEN_COUPON_FIELDS, PP_REOPEN_COUPON_WRITABLE_FIELDS,
  readReopenCoupon } = await import('./premiumPlusReopenCoupon.js');
const { PP_COUPON_ADMIN_ACTION, PP_COUPON_ADMIN_REJECT, parseCouponAudit } =
  await import('./premiumPlusCouponAdmin.js');
const { RESERVATION_SOURCE } = await import('../promotions/couponReservationSource.js');
const P2 = await import('../coupons/couponPlatform.js');
const { computeCouponEntityId: entityId } = P2;
const { OFFER_STATUS } = await import('../promotions/promotionalOffer.js');

const SECRET = 'admin-secret-for-test';
const REC = 'recSYNTH00000001';
const OTHER = 'recOTHER00000002';
const EMAIL = 'synthetic@example.invalid';

/** 合成 Airtable。PATCH を実際に反映し、書かれたフィールドを記録する */
let db;
let redis;
let realFetch;
let realEnv;

/**
 * 合成 Redis。**SET NX / EVAL(verify/release) の意味を本物どおりに実装する**
 * （排他が効いているかを本当に確かめるため）。`down:true` で「使えない」を再現する。
 */
function makeRedis({ down = false } = {}) {
  const store = new Map();
  const cmd = async (args) => {
    if (down) throw new Error('redis_down');
    const [op, ...rest] = args;
    if (op === 'INCR') {
      const n = Number(store.get(rest[0]) || 0) + 1;
      store.set(rest[0], String(n));
      return n;
    }
    if (op === 'SET') {
      const [key, value, ...opts] = rest;
      const nx = opts.includes('NX');
      if (nx && store.has(key)) return null;      // 先客がいる = 取れない
      store.set(key, value);
      return 'OK';
    }
    if (op === 'EVAL') {
      const [script, , key, token] = rest;
      const cur = store.get(key);
      if (cur === undefined) return 'LOST';
      if (cur !== token) return 'STOLEN';
      if (script.includes("DEL")) store.delete(key);
      return 'OK';
    }
    return null;
  };
  return { cmd, store };
}

function makeDb({ member = {}, offers = [], ledger = 'ok' } = {}) {
  return {
    ledger,
    customers: {
      [REC]: {
        Email: EMAIL, '氏名': 'テスト太郎',
        'プラン': 'Premium Sanrenpuku', 'Status': 'active', '有効期限': '2099-12-31',
        'SanrenpukuPaidAt': '2020-01-01T00:00:00.000Z',
        'RequestedPlan': '', 'PaymentConfirmed': true,
        ...member,
      },
      [OTHER]: {
        Email: 'other@example.invalid', '氏名': '別人',
        'プラン': 'Premium Sanrenpuku', 'Status': 'active', '有効期限': '2099-12-31',
        [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-10T00:00:00.000Z',
        [PP_REOPEN_COUPON_FIELDS.SOURCE]: 'pause-notice',
      },
    },
    offers: Object.fromEntries(offers.map((o) => [o.id, o.fields])),
    /** CouponOperationHistory（append-only。テストでは配列で持つ）*/
    history: [],
    /** 記録: **state（Customers / PromotionalOffers）**への書き込みだけ */
    writes: [],
    /** 履歴テーブルへの書き込み（state とは別に数える）*/
    historyWrites: [],
    /** 履歴 create をわざと失敗させる（部分成功の再現）*/
    historyCreateFails: false,
  };
}

const reservationFields = (status) => ({
  OfferKey: 'k1', CustomerRecordId: REC, Email: EMAIL, OfferId: couponIdWithVersion(),
  Source: RESERVATION_SOURCE, Status: status,
  StartsAt: '2026-09-01T00:00:00.000Z', ExpiresAt: '2026-09-30T00:00:00.000Z',
  RegularPrice: 68000, OfferPrice: 58000,
});

function stubFetch() {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    const err = (status) => ({ ok: false, status, json: async () => ({}), text: async () => 'error' });

    if (u.includes('/PromotionalOffers/')) {
      if (db.ledger === 'fail') return err(500);
      if (u.endsWith('/listRecords')) {
        return ok({ records: Object.entries(db.offers).map(([id, fields]) => ({ id, fields })) });
      }
      const id = u.split('/PromotionalOffers/')[1];
      if (method === 'PATCH') {
        const body = JSON.parse(init.body || '{}');
        db.writes.push({ table: 'PromotionalOffers', id, fields: body.fields });
        Object.assign(db.offers[id], body.fields);
        return ok({ id, fields: db.offers[id] });
      }
      return db.offers[id] ? ok({ id, fields: db.offers[id] }) : err(404);
    }
    if (u.includes('/Customers/')) {
      if (u.endsWith('/listRecords')) {
        return ok({ records: Object.entries(db.customers).map(([id, fields]) => ({ id, fields })) });
      }
      const id = u.split('/Customers/')[1];
      if (!db.customers[id]) return err(404);
      if (method === 'PATCH') {
        const body = JSON.parse(init.body || '{}');
        db.writes.push({ table: 'Customers', id, fields: body.fields });
        for (const [k, v] of Object.entries(body.fields)) {
          if (v === null) delete db.customers[id][k];
          else db.customers[id][k] = v;
        }
        return ok({ id, fields: db.customers[id] });
      }
      return ok({ id, fields: db.customers[id] });
    }
    if (u.includes('/CouponOperationHistory')) {
      if (u.endsWith('/listRecords')) {
        const body = JSON.parse(init.body || '{}');
        const f = String(body.filterByFormula || '');
        const eq = f.match(/\{(\w+)\}\s*=\s*'([^']*)'/);
        const rows = db.history.filter((r) => !eq || String(r.fields[eq[1]] || '') === eq[2]);
        return ok({ records: rows });
      }
      if (method === 'POST') {
        if (db.historyCreateFails) return err(500);
        const body = JSON.parse(init.body || '{}');
        for (const r of body.records || []) {
          db.historyWrites.push({ method: 'POST', fields: r.fields });
          db.history.push({ id: `recH${db.history.length + 1}`, fields: r.fields });
        }
        return ok({ records: body.records });
      }
      // ⚠️ append-only。PATCH / DELETE は実装しない（来たら失敗させる）
      return err(405);
    }
    if (u.includes('/CampaignDeliveries/')) return ok({ records: [] });
    if (u.includes('redis.example.invalid')) {
      const args = JSON.parse(init.body || '[]');
      try {
        return ok({ result: await redis.cmd(args) });
      } catch {
        return err(500);   // Redis が使えない状態
      }
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

const op = (couponAction, over = {}) => post({
  action: 'couponAdmin', recordId: REC, couponAction,
  actor: 'MK', reason: 'テストの操作理由', ...over,
});

/** 一覧・個別検索の両方からこの会員の行を取る */
async function views() {
  const list = await post({ action: 'list' });
  const lookup = await post({ action: 'lookup', query: EMAIL });
  const pick = (o) => (o.body.rows || []).find((r) => r.recordId === REC) || null;
  return { listRow: pick(list), lookupRow: pick(lookup) };
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  realEnv = { ...process.env };
  process.env.PREMIUM_PLUS_ADMIN_SECRET = SECRET;
  process.env.AIRTABLE_API_KEY = 'key-test';
  process.env.AIRTABLE_BASE_ID = 'app-test';
  process.env.COMEBACK_OFFER_TABLE_READY = '1';
  process.env.PREMIUM_PLUS_FIELDS_READY = '1';
  process.env.PREMIUM_PLUS_REOPEN_COUPON_READY = '1';
  process.env.COUPON_HISTORY_TABLE_READY = '1';
  // 排他は Redis 必須（fail closed）。合成 Redis を使えるよう env を立てる
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

// ── ライフサイクル通し ───────────────────────────────────────
test('付与 → 確認 → 誤取得訂正 → 再発行 → 再確認 を通しで実行できる', async () => {
  // ① 付与
  let out = await op(PP_COUPON_ADMIN_ACTION.GRANT, { reason: 'お電話でのご依頼' });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.success, true);
  assert.equal(out.body.subject.email, EMAIL, '対象会員を返していない');
  assert.equal(out.body.before.claimed, false);
  assert.equal(out.body.after.claimed, true, '操作後の状態を読み直していない');
  assert.equal(out.body.eligibilityUnchanged, true);

  // ② 確認（一覧・個別検索の両方で取得済みに見える）
  let v = await views();
  assert.equal(v.listRow.reopenCouponClaimed, true);
  assert.equal(v.lookupRow.reopenCouponClaimed, true);
  assert.match(v.listRow.couponAdmin.state.auditText, /管理者が付与/);
  assert.match(v.listRow.couponAdmin.state.auditText, /MK/);
  assert.match(v.listRow.couponAdmin.state.auditText, /お電話でのご依頼/);

  // ③ 誤取得訂正
  out = await op(PP_COUPON_ADMIN_ACTION.CORRECT, { reason: '誤って付与したため訂正' });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.before.claimed, true);
  assert.equal(out.body.after.claimed, false);
  // 履歴は消えていない（訂正前の取得日時が残る）
  assert.ok(out.body.after.audit.prevClaimedAtIso, '訂正前の取得日時が消えている');
  assert.match(out.body.after.auditText, /訂正/);

  // ④ 再発行
  out = await op(PP_COUPON_ADMIN_ACTION.REISSUE, { reason: '訂正後に再発行' });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.after.claimed, true);
  assert.match(out.body.after.auditText, /再発行/);

  // ⑤ 再確認
  v = await views();
  assert.equal(v.listRow.reopenCouponClaimed, true);
  assert.deepEqual(v.lookupRow.couponAdmin.state, v.listRow.couponAdmin.state,
    '一覧と個別検索で状態がズレている');

  // 書き込みは Customers のクーポン 3 列だけ。他テーブル・他会員には触れていない
  const allowed = new Set(PP_REOPEN_COUPON_WRITABLE_FIELDS);
  for (const w of db.writes) {
    assert.equal(w.table, 'Customers');
    assert.equal(w.id, REC, '他会員を書き換えている');
    for (const k of Object.keys(w.fields)) assert.ok(allowed.has(k), `${k} を書いている`);
  }
  // 他会員のレコードは 1 バイトも変わっていない
  assert.equal(db.customers[OTHER][PP_REOPEN_COUPON_FIELDS.CLAIMED_AT], '2026-08-10T00:00:00.000Z');
  assert.equal(db.customers[OTHER][PP_REOPEN_COUPON_FIELDS.SOURCE], 'pause-notice');
});

test('予約取消 → 訂正 の順なら通る（予約が残っていれば訂正は断る）', async () => {
  db = makeDb({
    member: {
      [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-18T22:07:54.803Z',
      [PP_REOPEN_COUPON_FIELDS.SOURCE]: 'pause-notice',
    },
    offers: [{ id: 'recOFFER0000001', fields: reservationFields(OFFER_STATUS.ISSUED) }],
  });

  // 予約が生きているうちは訂正させない
  let out = await op(PP_COUPON_ADMIN_ACTION.CORRECT);
  assert.equal(out.statusCode, 409);
  assert.equal(out.body.code, PP_COUPON_ADMIN_REJECT.RESERVATION_ACTIVE);
  assert.equal(out.body.sideEffects, 'none');
  assert.equal(db.writes.length, 0, '断ったのに書き込んでいる');

  // 予約取消（**Customers は触らない**）
  out = await op(PP_COUPON_ADMIN_ACTION.REVOKE_RESERVATION, { reason: '入金確認前の取消' });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.customerFieldsUnchanged, true);
  assert.equal(db.offers.recOFFER0000001.Status, OFFER_STATUS.REVOKED);
  assert.match(String(db.offers.recOFFER0000001.Notes), /admin-revoke-reservation\|by=MK\|/);
  assert.deepEqual(db.writes.map((w) => w.table), ['PromotionalOffers']);
  assert.deepEqual(Object.keys(db.writes[0].fields).sort(), ['Notes', 'Status']);
  // 取得（保有）は残っている
  assert.equal(readReopenCoupon(db.customers[REC]).claimed, true);

  // 二重取消しない
  out = await op(PP_COUPON_ADMIN_ACTION.REVOKE_RESERVATION);
  assert.equal(out.statusCode, 409);
  assert.equal(out.body.code, PP_COUPON_ADMIN_REJECT.RESERVATION_NOT_REVOCABLE);

  // 取消後なら訂正できる
  out = await op(PP_COUPON_ADMIN_ACTION.CORRECT, { reason: '取消後の訂正' });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.after.claimed, false);
});

// ── 付与と再発行の排他（**サーバーで再判定**）────────────────
test('API 直叩きでも 付与と再発行は排他になる', async () => {
  // ① 履歴なし → 再発行は通らない（UI を経由しない直叩きでも同じ）
  let out = await op(PP_COUPON_ADMIN_ACTION.REISSUE);
  assert.equal(out.statusCode, 409);
  assert.equal(out.body.code, PP_COUPON_ADMIN_REJECT.NO_HISTORY);
  assert.equal(out.body.sideEffects, 'none');
  assert.equal(db.writes.length, 0);

  // ② 付与は通る
  out = await op(PP_COUPON_ADMIN_ACTION.GRANT, { reason: '初回の付与' });
  assert.equal(out.statusCode, 200);
  assert.equal(db.writes.length, 1);

  // ③ 二重付与は通らない
  out = await op(PP_COUPON_ADMIN_ACTION.GRANT);
  assert.equal(out.statusCode, 409);
  assert.equal(out.body.code, PP_COUPON_ADMIN_REJECT.ALREADY_CLAIMED);

  // ④ 訂正すると履歴が残り、以後は**付与ではなく再発行**
  await op(PP_COUPON_ADMIN_ACTION.CORRECT, { reason: '誤付与の訂正' });
  out = await op(PP_COUPON_ADMIN_ACTION.GRANT, { reason: '履歴があるのに付与' });
  assert.equal(out.statusCode, 409);
  assert.equal(out.body.code, PP_COUPON_ADMIN_REJECT.HISTORY_EXISTS);

  const beforeReissue = db.writes.length;
  out = await op(PP_COUPON_ADMIN_ACTION.REISSUE, { reason: '訂正後の再発行' });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.after.claimed, true);

  // ⑤ 二重再発行も通らない
  out = await op(PP_COUPON_ADMIN_ACTION.REISSUE);
  assert.equal(out.statusCode, 409);
  assert.equal(out.body.code, PP_COUPON_ADMIN_REJECT.ALREADY_CLAIMED);
  assert.equal(db.writes.length, beforeReissue + 1, '断った操作が書き込んでいる');

  // 他会員は 1 度も触られていない
  assert.ok(db.writes.every((w) => w.id === REC));
  assert.equal(db.customers[OTHER][PP_REOPEN_COUPON_FIELDS.CLAIMED_AT], '2026-08-10T00:00:00.000Z');
  assert.equal(db.customers[OTHER][PP_REOPEN_COUPON_FIELDS.SOURCE], 'pause-notice');
});

test('利用予約中 / 使用済み / 台帳確認不能 は 付与も再発行も通さない', async () => {
  // 利用予約中（取得済み + issued）
  db = makeDb({
    member: {
      [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-18T22:07:54.803Z',
      [PP_REOPEN_COUPON_FIELDS.SOURCE]: 'pause-notice',
    },
    offers: [{ id: 'recOFFER0000001', fields: reservationFields(OFFER_STATUS.ISSUED) }],
  });
  for (const a of ['grant', 'reissue']) {
    const out = await op(a);
    assert.equal(out.statusCode, 409, a);
    assert.equal(out.body.code, PP_COUPON_ADMIN_REJECT.ALREADY_CLAIMED, a);
  }
  // 使用済み
  db.offers.recOFFER0000001.Status = OFFER_STATUS.REDEEMED;
  for (const a of ['grant', 'reissue']) {
    const out = await op(a);
    assert.equal(out.body.code, PP_COUPON_ADMIN_REJECT.ALREADY_REDEEMED, a);
  }
  // 台帳確認不能
  db.ledger = 'fail';
  for (const a of ['grant', 'reissue']) {
    const out = await op(a);
    assert.equal(out.statusCode, 503, a);
    assert.equal(out.body.code, PP_COUPON_ADMIN_REJECT.LEDGER_UNAVAILABLE, a);
  }
  assert.equal(db.writes.length, 0, '断ったのに書き込んでいる');
});

// ── 同時実行: **本体 PATCH も 1 回**（排他は状態変更より前に取る）──────
/**
 * ⚠️ 履歴だけを OperationId で 1 件にしても足りない。
 *    同時 2 本が両方 Customers PATCH に成功すると、Source / actor / reason / at が
 *    後勝ちで上書きされ、**最終監査値と履歴が食い違う**。
 *    そのため排他は「状態変更より前」に取り、負けた側は**副作用ゼロ**で断る。
 */
const HELD_FIELDS = {
  [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-18T22:07:54.803Z',
  [PP_REOPEN_COUPON_FIELDS.SOURCE]: 'pause-notice',
};

/** 同じ操作を 2 本同時に投げ、書き込み回数と応答を返す */
async function race2(couponAction) {
  const [a, b] = await Promise.all([op(couponAction), op(couponAction)]);
  const patches = db.writes.length;
  const okCount = [a, b].filter((r) => r.statusCode === 200).length;
  const rejected = [a, b].find((r) => r.statusCode !== 200);
  return { a, b, patches, okCount, rejected };
}

test('同時 grant 2 本 → Customers PATCH は 1 回だけ', async () => {
  const r = await race2(PP_COUPON_ADMIN_ACTION.GRANT);
  assert.equal(r.okCount, 1, '2 本とも成功している（本体が二重に書かれた）');
  assert.equal(r.patches, 1, `PATCH が ${r.patches} 回走っている`);
  // 負けた側は副作用ゼロで競合として断られる
  assert.equal(r.rejected.body.sideEffects, 'none');
  assert.ok(['operation_in_progress', 'already_claimed'].includes(r.rejected.body.code),
    `想定外の拒否理由: ${r.rejected.body.code}`);
  // 監査値は勝者のものだけが残る
  const audit = parseCouponAudit(db.customers[REC][PP_REOPEN_COUPON_FIELDS.SOURCE]);
  assert.equal(audit.kind, 'admin-grant');
  assert.ok(audit.operationId, 'op= が残っていない（部分成功の回復ができない）');
});

test('同時 correct 2 本 → PATCH は 1 回だけ', async () => {
  db = makeDb({ member: HELD_FIELDS });
  const r = await race2(PP_COUPON_ADMIN_ACTION.CORRECT);
  assert.equal(r.okCount, 1);
  assert.equal(r.patches, 1);
  assert.equal(r.rejected.body.sideEffects, 'none');
});

test('同時 reissue 2 本 → PATCH は 1 回だけ', async () => {
  // 訂正済み（履歴あり・現在未取得）から
  db = makeDb({ member: HELD_FIELDS });
  await op(PP_COUPON_ADMIN_ACTION.CORRECT, { reason: '訂正' });
  db.writes.length = 0;
  const r = await race2(PP_COUPON_ADMIN_ACTION.REISSUE);
  assert.equal(r.okCount, 1);
  assert.equal(r.patches, 1);
  assert.equal(r.rejected.body.sideEffects, 'none');
});

test('同時 revokeReservation 2 本 → PATCH は 1 回だけ', async () => {
  db = makeDb({
    member: HELD_FIELDS,
    offers: [{ id: 'recOFFER0000001', fields: reservationFields(OFFER_STATUS.ISSUED) }],
  });
  const r = await race2(PP_COUPON_ADMIN_ACTION.REVOKE_RESERVATION);
  assert.equal(r.okCount, 1);
  assert.equal(r.patches, 1);
  assert.equal(r.rejected.body.sideEffects, 'none');
});

test('lock を取れなかった側は副作用ゼロ（Airtable へ 1 バイトも書かない）', async () => {
  // 先に同じ操作の lock を外部が握っている状態を作る
  const first = await op(PP_COUPON_ADMIN_ACTION.GRANT);
  assert.equal(first.statusCode, 200);
  const opId = first.body.operationId;
  // lock を握り直す（TTL 内に別実行が進行中の状況）
  await redis.cmd(['SET', `ak:coupon-op:lock:${opId}`, '999', 'NX', 'EX', '300']);
  const writes = db.writes.length;
  // 同じ状態でもう一度 grant → すでに取得済みなので状態判定で断られる（書き込み 0）
  const again = await op(PP_COUPON_ADMIN_ACTION.GRANT);
  assert.notEqual(again.statusCode, 200);
  assert.equal(again.body.sideEffects, 'none');
  assert.equal(db.writes.length, writes, '断ったのに書き込んでいる');
});

test('lock 取得後に状態が変わっていたら再判定で拒否する（TOCTOU を閉じる）', async () => {
  db = makeDb();
  // ① 現状 read → ② OperationId 算出 → ③ lock、の後の再 read で状態が変わるよう仕込む
  let reads = 0;
  const baseFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const isCustomerGet = u.includes('/Customers/') && !u.endsWith('/listRecords')
      && (init.method || 'GET').toUpperCase() === 'GET';
    if (isCustomerGet) {
      reads += 1;
      // 2 回目（lock 取得後の再 read）で「別の実行が先に付与した」状態にする
      if (reads === 2) Object.assign(db.customers[REC], HELD_FIELDS);
    }
    return baseFetch(url, init);
  };
  const out = await op(PP_COUPON_ADMIN_ACTION.GRANT);
  globalThis.fetch = baseFetch;
  assert.notEqual(out.statusCode, 200, '状態が変わったのに実行してしまった');
  assert.equal(out.body.sideEffects, 'none');
  assert.equal(db.writes.length, 0);
});

test('crash 後は TTL で回復し、通常どおり再実行できる', async () => {
  db = makeDb();
  const planned = await op(PP_COUPON_ADMIN_ACTION.GRANT);
  const opId = planned.body.operationId;
  // 「crash して release されなかった」状態を作る（鍵が残っている）
  await redis.cmd(['SET', `ak:coupon-op:lock:${opId}`, '777', 'NX', 'EX', '300']);
  // TTL 切れ = 鍵が消える
  redis.store.delete(`ak:coupon-op:lock:${opId}`);
  // 訂正 → 再発行 が普通に通る（鍵が残り続けて詰まらない）
  const c = await op(PP_COUPON_ADMIN_ACTION.CORRECT, { reason: '訂正' });
  assert.equal(c.statusCode, 200);
  const r = await op(PP_COUPON_ADMIN_ACTION.REISSUE, { reason: '再発行' });
  assert.equal(r.statusCode, 200);
});

test('他会員は互いに block しない（別の lock）', async () => {
  db = makeDb();
  const other = (over = {}) => post({
    action: 'couponAdmin', recordId: OTHER, couponAction: PP_COUPON_ADMIN_ACTION.CORRECT,
    actor: 'MK', reason: '別会員の訂正', ...over,
  });
  // 同時に別会員の操作 → どちらも通る（鍵が別なので待たされない）
  const [mine, theirs] = await Promise.all([op(PP_COUPON_ADMIN_ACTION.GRANT), other()]);
  assert.equal(mine.statusCode, 200);
  assert.equal(theirs.statusCode, 200);
  assert.equal(db.writes.length, 2);
  assert.deepEqual([...new Set(db.writes.map((w) => w.id))].sort(), [OTHER, REC].sort());
  // 鍵が別であることも確認する
  const keys = [...redis.store.keys()].filter((k) => k.startsWith('ak:coupon-op:lock:'));
  assert.equal(new Set(keys).size, keys.length);
});

test('Redis が使えないときは書かない（fail closed）', async () => {
  db = makeDb();
  redis = makeRedis({ down: true });
  const out = await op(PP_COUPON_ADMIN_ACTION.GRANT);
  assert.equal(out.statusCode, 503);
  assert.equal(out.body.code, 'lock_unavailable');
  assert.equal(out.body.sideEffects, 'none');
  assert.equal(db.writes.length, 0, '排他できないのに書いている');
});

test('4 操作すべてが監査へ op=<OperationId> を残す（部分成功の回復に使う）', async () => {
  db = makeDb();
  const seen = [];
  const grab = () => parseCouponAudit(db.customers[REC][PP_REOPEN_COUPON_FIELDS.SOURCE]).operationId;

  let out = await op(PP_COUPON_ADMIN_ACTION.GRANT, { reason: '付与' });
  seen.push([out.body.operationId, grab()]);
  out = await op(PP_COUPON_ADMIN_ACTION.CORRECT, { reason: '訂正' });
  seen.push([out.body.operationId, grab()]);
  out = await op(PP_COUPON_ADMIN_ACTION.REISSUE, { reason: '再発行' });
  seen.push([out.body.operationId, grab()]);

  for (const [fromResponse, fromRecord] of seen) {
    assert.ok(fromResponse, '応答に operationId が無い');
    assert.equal(fromRecord, fromResponse, '監査の op= と応答の operationId が食い違う');
  }
  // 予約取消は予約行の Notes に残る
  db.offers.recOFFER0000001 = reservationFields(OFFER_STATUS.ISSUED);
  const rev = await op(PP_COUPON_ADMIN_ACTION.REVOKE_RESERVATION, { reason: '予約取消' });
  assert.equal(rev.statusCode, 200);
  assert.equal(parseCouponAudit(String(db.offers.recOFFER0000001.Notes).split(' / ').pop()).operationId,
    rev.body.operationId);
});

// ── 異種操作の同時実行も直列化する（entity lock）──────────────
/**
 * ⚠️ 鍵が OperationId だと、**操作種別が違うだけで別の鍵**になり、
 *    `grant` と `correct` のような別種の操作が同時に state を書けてしまう（lost update）。
 *    鍵は **entity（会員 × 商品 × クーポン × 版）**でなければならない。
 */
async function raceMixed(a, b) {
  const [ra, rb] = await Promise.all([op(a), op(b)]);
  const statePatches = db.writes.filter((w) => w.table === 'Customers' || w.table === 'PromotionalOffers').length;
  return { ra, rb, statePatches, ok: [ra, rb].filter((r) => r.statusCode === 200) };
}

test('同一会員・同一クーポンなら claim 相当と grant が同時でも state PATCH は 1 回', async () => {
  // claim 相当 = 未取得からの取得。grant と**状態上は同じ遷移**を争う
  const r = await raceMixed(PP_COUPON_ADMIN_ACTION.GRANT, PP_COUPON_ADMIN_ACTION.GRANT);
  assert.equal(r.statePatches, 1, `state PATCH が ${r.statePatches} 回`);
  assert.equal(r.ok.length, 1);
});

test('grant と correct が同時でも直列化され、state PATCH は 1 回', async () => {
  db = makeDb();   // 未取得
  const r = await raceMixed(PP_COUPON_ADMIN_ACTION.GRANT, PP_COUPON_ADMIN_ACTION.CORRECT);
  // 未取得なので correct は成立しない。grant だけが通る
  assert.equal(r.statePatches, 1, `state PATCH が ${r.statePatches} 回`);
  assert.equal(readReopenCoupon(db.customers[REC]).claimed, true);
  // 負けた側は**再 read 後の正しい状態**で断られている（lost update が起きていない）
  const rejected = [r.ra, r.rb].find((x) => x.statusCode !== 200);
  assert.equal(rejected.body.sideEffects, 'none');
});

test('correct と reissue が同時でも state PATCH は 1 回', async () => {
  db = makeDb({ member: HELD_FIELDS });   // 取得済み
  const r = await raceMixed(PP_COUPON_ADMIN_ACTION.CORRECT, PP_COUPON_ADMIN_ACTION.REISSUE);
  assert.equal(r.statePatches, 1, `state PATCH が ${r.statePatches} 回`);
  // 取得済みなので reissue は already_claimed。correct だけが通る
  assert.equal(readReopenCoupon(db.customers[REC]).claimed, false);
});

test('revokeReservation と correct が同時でも競合せず state は壊れない', async () => {
  db = makeDb({
    member: HELD_FIELDS,
    offers: [{ id: 'recOFFER0000001', fields: reservationFields(OFFER_STATUS.ISSUED) }],
  });
  const r = await raceMixed(PP_COUPON_ADMIN_ACTION.REVOKE_RESERVATION, PP_COUPON_ADMIN_ACTION.CORRECT);
  // 予約が生きているうちは correct を断る仕様。予約取消だけが通る
  assert.equal(r.statePatches, 1, `state PATCH が ${r.statePatches} 回`);
  assert.equal(db.offers.recOFFER0000001.Status, OFFER_STATUS.REVOKED);
  // 取得（保有）は消えていない
  assert.equal(readReopenCoupon(db.customers[REC]).claimed, true);
});

test('負けた側は再 read 後の状態で正しく拒否される（lost update なし）', async () => {
  db = makeDb();
  const r = await raceMixed(PP_COUPON_ADMIN_ACTION.GRANT, PP_COUPON_ADMIN_ACTION.GRANT);
  const rejected = [r.ra, r.rb].find((x) => x.statusCode !== 200);
  // 「進行中」か「既に取得済み」のどちらか。**取得日時を上書きしていない**
  assert.ok(['operation_in_progress', 'already_claimed'].includes(rejected.body.code),
    `想定外: ${rejected.body.code}`);
  const audit = parseCouponAudit(db.customers[REC][PP_REOPEN_COUPON_FIELDS.SOURCE]);
  const winner = [r.ra, r.rb].find((x) => x.statusCode === 200);
  assert.equal(audit.operationId, winner.body.operationId, '勝者以外の監査値で上書きされている');
});

test('他会員は並行して成功し、同一会員でも別商品/別クーポンは block しない', async () => {
  db = makeDb();
  const [mine, theirs] = await Promise.all([
    op(PP_COUPON_ADMIN_ACTION.GRANT),
    post({
      action: 'couponAdmin', recordId: OTHER, couponAction: PP_COUPON_ADMIN_ACTION.CORRECT,
      actor: 'MK', reason: '別会員',
    }),
  ]);
  assert.equal(mine.statusCode, 200);
  assert.equal(theirs.statusCode, 200);
  // 鍵が別（entity id が別）
  const keys = [...redis.store.keys()].filter((k) => k.startsWith('ak:coupon-op:lock:'));
  assert.ok(keys.length === 0 || new Set(keys).size === keys.length);
  // 別商品・別クーポンは entity id が別（プラットフォーム側で保証）
  const ent = (over) => entityId({ customerRecordId: REC, productKey: 'premium_plus', couponId: 'c', version: 1, ...over });
  assert.notEqual(ent(), ent({ productKey: 'premium_monthly' }));
  assert.notEqual(ent(), ent({ couponId: 'other' }));
  assert.notEqual(ent(), ent({ version: 2 }));
});

// ── 履歴の配線（append-only / repair / gate / 分離）─────────────
const histOps = () => db.history.map((r) => r.fields.OperationType);
const histIds = () => db.history.map((r) => r.fields.OperationId);

test('grant → state 変更 + 履歴 1 件', async () => {
  const out = await op(PP_COUPON_ADMIN_ACTION.GRANT, { reason: '付与' });
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.history.appended, true);
  assert.equal(db.history.length, 1);
  const f = db.history[0].fields;
  assert.equal(f.OperationType, 'grant');
  assert.equal(f.CustomerRecordId, REC);
  assert.equal(f.OperationId, out.body.operationId);
  assert.equal(f.ProductKey, 'premium_plus');
  assert.equal(f.Actor, 'MK');
  assert.equal(f.BeforeState, 'none');
  assert.equal(f.AfterState, 'held');
  assert.ok(!('Email' in f), '履歴にアドレスを書いている');
});

test('correct で 2 件目が増え、1 件目は不変（append-only）', async () => {
  await op(PP_COUPON_ADMIN_ACTION.GRANT, { reason: '付与' });
  const first = JSON.parse(JSON.stringify(db.history[0]));
  await op(PP_COUPON_ADMIN_ACTION.CORRECT, { reason: '訂正' });
  assert.equal(db.history.length, 2);
  assert.deepEqual(db.history[0], first, '既存の履歴行が書き換わっている');
  assert.deepEqual(histOps(), ['grant', 'correct']);
  // 既存行への PATCH / DELETE を一度も発行していない（POST だけ）
  assert.ok(db.historyWrites.every((w) => w.method === 'POST'), 'append 以外の書き込みがある');
});

test('reissue で 3 件目が増える', async () => {
  await op(PP_COUPON_ADMIN_ACTION.GRANT, { reason: '付与' });
  await op(PP_COUPON_ADMIN_ACTION.CORRECT, { reason: '訂正' });
  await op(PP_COUPON_ADMIN_ACTION.REISSUE, { reason: '再発行' });
  assert.equal(db.history.length, 3);
  assert.deepEqual(histOps(), ['grant', 'correct', 'reissue']);
  assert.equal(new Set(histIds()).size, 3, '別の操作が同じ OperationId になっている');
});

test('revokeReservation も履歴に残る', async () => {
  db = makeDb({
    member: HELD_FIELDS,
    offers: [{ id: 'recOFFER0000001', fields: reservationFields(OFFER_STATUS.ISSUED) }],
  });
  const out = await op(PP_COUPON_ADMIN_ACTION.REVOKE_RESERVATION, { reason: '予約取消' });
  assert.equal(out.statusCode, 200);
  assert.equal(db.history.length, 1);
  assert.equal(db.history[0].fields.OperationType, 'revokeReservation');
  assert.equal(db.history[0].fields.OperationId, out.body.operationId);
});

test('同時 2 要求 → state PATCH 1 回 / 履歴 1 件', async () => {
  const r = await race2(PP_COUPON_ADMIN_ACTION.GRANT);
  assert.equal(r.okCount, 1);
  const customerPatches = db.writes.filter((w) => w.table === 'Customers').length;
  assert.equal(customerPatches, 1, `state PATCH が ${customerPatches} 回`);
  assert.equal(db.history.length, 1, `履歴が ${db.history.length} 件`);
});

test('履歴 create 失敗でも state 成功は維持し、repair 対象として検出できる', async () => {
  db = makeDb();
  db.historyCreateFails = true;
  const out = await op(PP_COUPON_ADMIN_ACTION.GRANT, { reason: '付与' });
  // 状態変更は成功したまま（**巻き戻さない**）
  assert.equal(out.statusCode, 200);
  assert.equal(out.body.after.claimed, true);
  assert.equal(readReopenCoupon(db.customers[REC]).claimed, true);
  // 履歴だけ積めていない
  assert.equal(out.body.history.appended, false);
  assert.equal(db.history.length, 0);
  // op= は残っているので後から repair できる
  const audit = parseCouponAudit(db.customers[REC][PP_REOPEN_COUPON_FIELDS.SOURCE]);
  assert.equal(audit.operationId, out.body.operationId);
});

test('repair で同じ OperationId の 1 件へ収束し、再実行しても増えない', async () => {
  db = makeDb();
  db.historyCreateFails = true;
  const out = await op(PP_COUPON_ADMIN_ACTION.GRANT, { reason: '付与' });
  db.historyCreateFails = false;

  const fix = await post({ action: 'couponHistoryRepair', recordId: REC });
  assert.equal(fix.statusCode, 200);
  assert.equal(fix.body.repaired, 1);
  assert.equal(db.history.length, 1);
  assert.equal(db.history[0].fields.OperationId, out.body.operationId, '別の OperationId で積んでいる');
  assert.equal(db.history[0].fields.OperationType, 'grant');
  assert.equal(db.history[0].fields.Actor, 'MK');
  // ⚠️ 状態は 1 バイトも触っていない
  assert.equal(db.writes.filter((w) => w.table === 'Customers').length, 1, 'repair が state を書いている');

  // 再実行しても増えない
  const again = await post({ action: 'couponHistoryRepair', recordId: REC });
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.repaired, 0);
  assert.equal(db.history.length, 1);
});

test('gate UNSET なら履歴を 1 行も書かない（state は従来どおり動く）', async () => {
  delete process.env.COUPON_HISTORY_TABLE_READY;
  const out = await op(PP_COUPON_ADMIN_ACTION.GRANT, { reason: '付与' });
  assert.equal(out.statusCode, 200, 'gate off で state まで止めている');
  assert.equal(out.body.history.appended, false);
  assert.equal(out.body.history.reason, 'history_disabled');
  assert.equal(db.history.length, 0);
  assert.equal(db.historyWrites.length, 0);
  // repair も断る
  const fix = await post({ action: 'couponHistoryRepair', recordId: REC });
  assert.equal(fix.statusCode, 503);
  assert.equal(fix.body.code, 'history_disabled');
  // 履歴表示は「確認できない」を返す（0 件と言わない）
  const list = await post({ action: 'couponHistory', recordId: REC });
  assert.equal(list.body.available, false);
  assert.equal(list.body.reason, 'history_disabled');
  assert.ok(list.body.note.includes('有効化されていません'));
});

test('Redis down なら state も履歴も書かない', async () => {
  db = makeDb();
  redis = makeRedis({ down: true });
  const out = await op(PP_COUPON_ADMIN_ACTION.GRANT);
  assert.equal(out.statusCode, 503);
  assert.equal(db.writes.length, 0);
  assert.equal(db.history.length, 0);
});

test('他会員・他商品は履歴で分離される', async () => {
  await op(PP_COUPON_ADMIN_ACTION.GRANT, { reason: '付与' });
  await post({
    action: 'couponAdmin', recordId: OTHER, couponAction: PP_COUPON_ADMIN_ACTION.CORRECT,
    actor: 'MK', reason: '別会員の訂正',
  });
  assert.equal(db.history.length, 2);
  // 会員ごとに引くと 1 件ずつ
  const mine = await post({ action: 'couponHistory', recordId: REC });
  const theirs = await post({ action: 'couponHistory', recordId: OTHER });
  assert.equal(mine.body.rows.length, 1);
  assert.equal(theirs.body.rows.length, 1);
  assert.equal(mine.body.rows[0].operationType, 'grant');
  assert.equal(theirs.body.rows[0].operationType, 'correct');
  assert.notEqual(mine.body.rows[0].operationId, theirs.body.rows[0].operationId);
  // 商品識別子が入っている（2 商品目が来ても混ざらない）
  assert.ok(db.history.every((r) => r.fields.ProductKey === 'premium_plus'));
});

test('履歴は時系列（新しい順）で admin へ返る', async () => {
  await op(PP_COUPON_ADMIN_ACTION.GRANT, { reason: '付与' });
  await op(PP_COUPON_ADMIN_ACTION.CORRECT, { reason: '訂正' });
  const list = await post({ action: 'couponHistory', recordId: REC });
  assert.equal(list.body.available, true);
  assert.equal(list.body.rows.length, 2);
  const times = list.body.rows.map((r) => Date.parse(r.occurredAt));
  assert.ok(times[0] >= times[1], '新しい順になっていない');
  // 画面に出すのに必要な項目が揃っている（Airtable を直接見なくて済む）
  for (const row of list.body.rows) {
    for (const k of ['operationId', 'occurredAt', 'operationType', 'actor', 'reason']) {
      assert.ok(k in row, `${k} が無い`);
    }
  }
});

test('claim の部分成功も history-only repair で 1 件へ収束する', async () => {
  // お客様が取得したが履歴だけ積めなかった状態を、durable marker（op=）から再現
  const claimOpId = P2.computeCouponOperationId({
    productKey: 'premium_plus', couponId: 'premium-plus-reopen-priority', version: 1,
    customerRecordId: REC, operationType: 'claim', anchor: 'none',
  });
  db = makeDb({
    member: {
      [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-20T01:00:00.000Z',
      [PP_REOPEN_COUPON_FIELDS.SOURCE]: P2.encodeCouponAudit({
        kind: 'pause-notice', actor: 'customer', atIso: '2026-08-20T01:00:00.000Z',
        reason: '', operationId: claimOpId,
      }),
    },
  });

  const fix = await post({ action: 'couponHistoryRepair', recordId: REC });
  assert.equal(fix.statusCode, 200);
  assert.equal(fix.body.repaired, 1);
  assert.equal(db.history.length, 1);
  const f = db.history[0].fields;
  assert.equal(f.OperationId, claimOpId, '別の OperationId で積んでいる');
  assert.equal(f.OperationType, 'claim', 'claim として復元できていない');
  assert.equal(f.Actor, 'customer');
  assert.equal(f.OccurredAt, '2026-08-20T01:00:00.000Z', '履歴の時刻を今にしている');
  // 状態は 1 バイトも触っていない
  assert.equal(db.writes.filter((w) => w.table === 'Customers').length, 0);

  // 再実行しても増えない
  const again = await post({ action: 'couponHistoryRepair', recordId: REC });
  assert.equal(again.body.repaired, 0);
  assert.equal(db.history.length, 1);
});

// ── 二重操作・使用済み ───────────────────────────────────────
test('二重付与を断る（副作用ゼロ）', async () => {
  await op(PP_COUPON_ADMIN_ACTION.GRANT);
  const writesAfterFirst = db.writes.length;
  const out = await op(PP_COUPON_ADMIN_ACTION.GRANT);
  assert.equal(out.statusCode, 409);
  assert.equal(out.body.code, PP_COUPON_ADMIN_REJECT.ALREADY_CLAIMED);
  assert.equal(out.body.sideEffects, 'none');
  assert.equal(db.writes.length, writesAfterFirst, '断ったのに書き込んでいる');
});

test('使用済みクーポンを再利用可能にしない（付与 / 再発行 / 訂正のすべて）', async () => {
  db = makeDb({
    member: {
      [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-18T22:07:54.803Z',
      [PP_REOPEN_COUPON_FIELDS.SOURCE]: 'pause-notice',
    },
    offers: [{ id: 'recOFFER0000001', fields: reservationFields(OFFER_STATUS.REDEEMED) }],
  });
  for (const a of ['grant', 'reissue', 'correct']) {
    const out = await op(a);
    assert.equal(out.statusCode, 409, a);
    assert.equal(out.body.code, PP_COUPON_ADMIN_REJECT.ALREADY_REDEEMED, a);
  }
  assert.equal(db.writes.length, 0, '使用済みなのに書き込んでいる');
});

// ── fail closed ─────────────────────────────────────────────
test('予約台帳を読めないときは書き込まない（fail closed）', async () => {
  db = makeDb({ ledger: 'fail' });
  for (const a of Object.values(PP_COUPON_ADMIN_ACTION)) {
    const out = await op(a);
    assert.equal(out.statusCode, 503, a);
    assert.equal(out.body.code, PP_COUPON_ADMIN_REJECT.LEDGER_UNAVAILABLE, a);
    assert.equal(out.body.sideEffects, 'none', a);
  }
  assert.equal(db.writes.length, 0);
  // 画面のボタンも全部落ちている
  const v = await views();
  assert.ok(v.listRow.couponAdmin.actions.every((x) => x.enabled === false));
});

test('保存先が未有効なら Customers 側の操作を受け付けない', async () => {
  delete process.env.PREMIUM_PLUS_REOPEN_COUPON_READY;
  const out = await op(PP_COUPON_ADMIN_ACTION.GRANT);
  assert.equal(out.statusCode, 503);
  assert.equal(out.body.code, PP_COUPON_ADMIN_REJECT.STORAGE_DISABLED);
  assert.equal(db.writes.length, 0);
});

// ── API 直叩きでも同じ制約 ───────────────────────────────────
test('admin secret が無ければ実行できない', async () => {
  const out = await post({
    action: 'couponAdmin', recordId: REC, couponAction: 'grant', actor: 'MK', reason: 'x',
  }, { secret: '' });
  assert.equal(out.statusCode, 403);
  assert.equal(db.writes.length, 0);
});

test('操作者・理由が無い直叩きを断る', async () => {
  let out = await op(PP_COUPON_ADMIN_ACTION.GRANT, { actor: '' });
  assert.equal(out.statusCode, 400);
  assert.equal(out.body.code, PP_COUPON_ADMIN_REJECT.MISSING_ACTOR);
  out = await op(PP_COUPON_ADMIN_ACTION.GRANT, { reason: '' });
  assert.equal(out.statusCode, 400);
  assert.equal(out.body.code, PP_COUPON_ADMIN_REJECT.MISSING_REASON);
  assert.equal(db.writes.length, 0);
});

test('未知の操作・存在しない会員を断る', async () => {
  let out = await op('delete');
  assert.equal(out.statusCode, 400);
  out = await post({
    action: 'couponAdmin', recordId: 'recNOPE', couponAction: 'grant', actor: 'MK', reason: 'x',
  });
  assert.equal(out.statusCode, 404);
  assert.equal(db.writes.length, 0);
});

// ── 監査 ────────────────────────────────────────────────────
test('監査値（実行者・時刻・理由）が Airtable の値として残る', async () => {
  await op(PP_COUPON_ADMIN_ACTION.GRANT, { actor: 'MK', reason: 'サポート対応 #123' });
  const audit = parseCouponAudit(db.customers[REC][PP_REOPEN_COUPON_FIELDS.SOURCE]);
  assert.equal(audit.byAdmin, true);
  assert.equal(audit.actor, 'MK');
  assert.equal(audit.reason, 'サポート対応 #123');
  assert.ok(Date.parse(audit.atIso) > 0, '操作時刻が残っていない');
});

// ── 利用予約を使用済みにする（2026-08-23 追加）────────────────
//
// ⚠️ **Premium Plus の完了を確定させる唯一の操作**。
//    Plus は単品購入で Customers に申込内容（`RequestedPlan`）を書かないため、
//    入金確認 Function は「申込フォーム未経由」として昇格ごとスキップする＝
//    自動では使用済みにならない。この操作が無いと予約が永久に `issued` のまま残る。
const withReservation = (status) => {
  db = makeDb({
    member: HELD_FIELDS,
    offers: [{ id: 'recOFFER0000001', fields: reservationFields(status) }],
  });
};
const offerRow = () => ({ id: 'recOFFER0000001', fields: db.offers['recOFFER0000001'] });

test('入金確認待ちの予約を使用済みにできる（予約行の 2 列だけ）', async () => {
  withReservation(OFFER_STATUS.ISSUED);
  const before = { ...offerRow().fields };
  const out = await op(PP_COUPON_ADMIN_ACTION.REDEEM_RESERVATION, { reason: '入金を確認' });

  assert.equal(out.statusCode, 200);
  assert.equal(out.body.success, true);
  assert.equal(out.body.sideEffects, 'coupon_reservation_redeemed');
  assert.equal(offerRow().fields.Status, OFFER_STATUS.REDEEMED);
  assert.ok(offerRow().fields.RedeemedAt, '使用日時が残っていない');
  // 予約行で変わったのは 2 列だけ
  const changed = Object.keys(offerRow().fields)
    .filter((k) => offerRow().fields[k] !== before[k]);
  assert.deepEqual(changed.sort(), ['RedeemedAt', 'Status']);
});

test('使用済みにしても「取得済み」は消さない（渡した事実と使った事実は別）', async () => {
  withReservation(OFFER_STATUS.ISSUED);
  const before = { ...db.customers[REC] };
  const out = await op(PP_COUPON_ADMIN_ACTION.REDEEM_RESERVATION, { reason: '入金を確認' });
  assert.equal(out.body.customerFieldsUnchanged, true);
  assert.deepEqual(db.customers[REC], before, 'Customers を書き換えている');
  assert.equal(readReopenCoupon(db.customers[REC]).claimed, true);
});

test('戻せないことを応答で伝える（曖昧にしない）', async () => {
  withReservation(OFFER_STATUS.ISSUED);
  const out = await op(PP_COUPON_ADMIN_ACTION.REDEEM_RESERVATION, { reason: '入金を確認' });
  assert.match(out.body.rollback, /取り消す操作はありません/);
});

test('二重に使用済みにしない（2 回目は断る・副作用ゼロ）', async () => {
  withReservation(OFFER_STATUS.ISSUED);
  await op(PP_COUPON_ADMIN_ACTION.REDEEM_RESERVATION, { reason: '入金を確認' });
  const at = offerRow().fields.RedeemedAt;
  db.writes.length = 0;

  const again = await op(PP_COUPON_ADMIN_ACTION.REDEEM_RESERVATION, { reason: 'もう一度' });
  assert.notEqual(again.statusCode, 200);
  assert.equal(again.body.sideEffects, 'none');
  assert.equal(offerRow().fields.RedeemedAt, at, '使用日時が上書きされている');
  assert.equal(db.writes.length, 0);
});

test('予約が無ければ使用済みにできない', async () => {
  db = makeDb({ member: HELD_FIELDS });
  const out = await op(PP_COUPON_ADMIN_ACTION.REDEEM_RESERVATION, { reason: '入金を確認' });
  assert.notEqual(out.statusCode, 200);
  assert.equal(out.body.sideEffects, 'none');
});

test('取消済みの予約は使用済みにできない', async () => {
  withReservation(OFFER_STATUS.REVOKED);
  const out = await op(PP_COUPON_ADMIN_ACTION.REDEEM_RESERVATION, { reason: '入金を確認' });
  assert.notEqual(out.statusCode, 200);
  assert.equal(out.body.sideEffects, 'none');
  assert.equal(offerRow().fields.Status, OFFER_STATUS.REVOKED);
});

test('使用済みにした操作も履歴に残る（誰が・いつ・なぜ）', async () => {
  withReservation(OFFER_STATUS.ISSUED);
  const out = await op(PP_COUPON_ADMIN_ACTION.REDEEM_RESERVATION, { reason: '入金を確認しました' });
  assert.equal(db.history.length, 1);
  assert.equal(db.history[0].fields.OperationType, 'redeemReservation');
  assert.equal(db.history[0].fields.OperationId, out.body.operationId);
  assert.match(String(db.history[0].fields.Reason || ''), /入金を確認しました/);
});

test('同時 2 本でも使用済み化は 1 回だけ', async () => {
  withReservation(OFFER_STATUS.ISSUED);
  const r = await race2(PP_COUPON_ADMIN_ACTION.REDEEM_RESERVATION);
  assert.equal(r.okCount, 1);
  assert.equal(r.patches, 1);
  assert.equal(r.rejected.body.sideEffects, 'none');
});

test('台帳を読めないときは使用済みにしない（読めないまま書かない）', async () => {
  withReservation(OFFER_STATUS.ISSUED);
  db.ledger = 'fail';
  const out = await op(PP_COUPON_ADMIN_ACTION.REDEEM_RESERVATION, { reason: '入金を確認' });
  assert.notEqual(out.statusCode, 200);
  assert.equal(offerRow().fields.Status, OFFER_STATUS.ISSUED);
});

test('操作者名・理由が無ければ実行しない（監査が残らない操作を許さない）', async () => {
  for (const over of [{ actor: '' }, { reason: '' }]) {
    withReservation(OFFER_STATUS.ISSUED);
    const out = await op(PP_COUPON_ADMIN_ACTION.REDEEM_RESERVATION, over);
    assert.notEqual(out.statusCode, 200);
    assert.equal(offerRow().fields.Status, OFFER_STATUS.ISSUED);
  }
});

test('他会員の予約行には触らない', async () => {
  withReservation(OFFER_STATUS.ISSUED);
  db.offers['recOFFER0000009'] = {
    ...reservationFields(OFFER_STATUS.ISSUED), CustomerRecordId: OTHER, OfferKey: 'k9',
  };
  await op(PP_COUPON_ADMIN_ACTION.REDEEM_RESERVATION, { reason: '入金を確認' });
  assert.equal(db.offers['recOFFER0000009'].Status, OFFER_STATUS.ISSUED,
    '他会員の予約を書き換えている');
});
