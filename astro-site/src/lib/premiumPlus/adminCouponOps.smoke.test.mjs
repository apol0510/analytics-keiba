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
const { OFFER_STATUS } = await import('../promotions/promotionalOffer.js');

const SECRET = 'admin-secret-for-test';
const REC = 'recSYNTH00000001';
const OTHER = 'recOTHER00000002';
const EMAIL = 'synthetic@example.invalid';

/** 合成 Airtable。PATCH を実際に反映し、書かれたフィールドを記録する */
let db;
let realFetch;
let realEnv;

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
    /** 記録: どのテーブルの誰へ何を書いたか */
    writes: [],
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
    if (u.includes('/CampaignDeliveries/')) return ok({ records: [] });
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
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
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
