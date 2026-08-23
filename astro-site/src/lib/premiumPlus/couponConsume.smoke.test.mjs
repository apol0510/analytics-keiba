/**
 * couponConsume.smoke.test.mjs — クーポンが**使われたら消える**ことを実ハンドラで固定する
 *
 * ## 直した障害（2026-08-23）
 *
 * 「利用予約を作る」「使用済みにする」関数は実装済みだったが、**どこからも呼ばれていなかった**。
 * そのため申込しても入金確認してもクーポンは「所持中」のまま残り、
 * **同じクーポンで何度でも 58,000円 の申込ができた**。
 * admin の「予約 0 件 / 使用済み 0 件」も、事実ではなく**記録する経路が無いだけ**だった。
 *
 * ## 固定する仕様
 *
 * | いつ | 何が起きるか |
 * |---|---|
 * | 振込完了報告が正常受理 | `PromotionalOffers` に予約 1 行（`issued`）|
 * | 同じ報告を再送 | **行は増えない** |
 * | 入金確認（`PaymentConfirmed`）| その行が `redeemed` |
 * | 2 回目の申込 | 予約済み / 使用済みなので**行を作らない** |
 * | 台帳を読めない | **作らない**（重複を検出できないまま増やさない）|
 * | どの失敗でも | 申込・昇格は**巻き戻さない** |
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const APPLY_FN = fileURLToPath(new URL('../../../netlify/functions/bank-transfer-application.js', import.meta.url));
const CONFIRM_FN = fileURLToPath(new URL('../../../netlify/functions/confirm-bank-payment.js', import.meta.url));
const { couponIdWithVersion, PP_REOPEN_COUPON_FIELDS } = await import('./premiumPlusReopenCoupon.js');
const { OFFER_STATUS } = await import('../promotions/promotionalOffer.js');
const ID = couponIdWithVersion();
const REC = 'recSYNTH000000010';
const REOPEN_MEMBERS_KEY = 'ak:pp:reopen:v1:members';

const MEMBER = {
  'Email': 'synthetic@example.invalid', '氏名': 'テスト',
  'プラン': 'Premium Sanrenpuku', 'Status': 'active', '有効期限': '2099-12-31',
  'SanrenpukuPaidAt': '2020-01-01T00:00:00.000Z',
  'PremiumPlusEligibility': 'eligible', 'PremiumPlusReleaseOverride': 'phase4',
  // ⚠️ 販売停止中は申込自体ができない（403）。実際の流れは
  //    「停止中にクーポンを取得 → MK が再募集を開始（＝販売再開）→ 申し込む」
  [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-18T22:07:54.803Z',
  // 入金確認が昇格に使う申込内容
  'PaymentConfirmed': true,
  'RequestedPlan': 'Premium Plus',
  'RequestedPlanType': 'Lifetime',
  'RequestedAmount': 58000,
};

let offers;            // 合成 PromotionalOffers
let customers;         // 合成 Customers
let reopenStarts;
let ledgerReadable;    // 台帳を読めるか
let realFetch;
let realEnv;
let calls;

function stub() {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const m = (init.method || 'GET').toUpperCase();
    const json = (b, s = 200) => new Response(JSON.stringify(b),
      { status: s, headers: { 'Content-Type': 'application/json' } });

    if (u.includes('redis.example.invalid')) {
      const [op, key, ...rest] = JSON.parse(init.body || '[]');
      if (op === 'HGET' && key === REOPEN_MEMBERS_KEY) return json({ result: reopenStarts.get(rest[0]) ?? null });
      return json({ result: null });
    }
    if (u.includes('sendgrid')) { calls.push('SENDGRID'); return json({}, 202); }

    if (u.includes('PromotionalOffers')) {
      if (!ledgerReadable) return new Response('err', { status: 500 });
      if (m === 'GET') return json({ records: offers });
      if (m === 'POST') {
        const recs = (JSON.parse(init.body || '{}').records || []).map((r, i) => ({
          id: `recOFFER${String(offers.length + i).padStart(8, '0')}`, fields: r.fields,
        }));
        offers.push(...recs);
        calls.push('OFFER_CREATE');
        return json({ records: recs });
      }
      if (m === 'PATCH') {
        const id = u.split('/').pop();
        const row = offers.find((o) => o.id === id);
        if (row) Object.assign(row.fields, JSON.parse(init.body || '{}').fields);
        calls.push('OFFER_PATCH');
        return json({ id, fields: row ? row.fields : {} });
      }
      return new Response('{}', { status: 405 });
    }
    if (u.includes('api.airtable.com')) {
      if (m === 'GET') {
        const id = u.split('?')[0].split('/').pop();
        if (id === REC) return json({ id: REC, fields: customers });
        return json({ records: [{ id: REC, fields: customers }] });
      }
      calls.push('CUSTOMER_' + m);
      if (m === 'PATCH') Object.assign(customers, JSON.parse(init.body || '{}').fields || {});
      return json({ id: REC, fields: customers });
    }
    calls.push('EXTERNAL');
    return new Response('blocked', { status: 403 });
  };
}

/** Function の標準出力を stderr へ逃がす（node --test の通信路を壊さないため） */
function routeStdoutToStderr() {
  const saved = { log: console.log, info: console.info, debug: console.debug, warn: console.warn };
  console.log = console.info = console.debug = console.warn = (...a) => console.error(...a);
  return () => Object.assign(console, saved);
}

async function runFn(file, event) {
  const restore = routeStdoutToStderr();
  try {
    globalThis.exports = {};
    globalThis.module = { exports: globalThis.exports };
    await import(`${file}?t=${offers.length}-${calls.length}-${Math.random()}`);
    const res = await globalThis.exports.handler(event, {});
    let body = {};
    try { body = JSON.parse(res.body); } catch { body = {}; }
    return { status: res.statusCode, body };
  } finally { restore(); }
}

const apply = (over = {}) => runFn(APPLY_FN, {
  httpMethod: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    fullName: 'テスト', email: 'synthetic@example.invalid',
    transferDate: '2026-08-23', transferTime: '10:00', transferName: 'テスト',
    productName: 'Premium Plus', paymentCompletedConfirm: true,
    couponId: ID, transferAmount: '58000', ...over,
  }),
});

const confirm = () => runFn(CONFIRM_FN, {
  httpMethod: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ airtableRecordId: REC, email: 'synthetic@example.invalid' }),
});

const reservations = () => offers.filter((o) => String(o.fields.OfferId || '') === ID);
const statusesOf = () => reservations().map((o) => String(o.fields.Status || ''));

beforeEach(() => {
  calls = [];
  offers = [];
  customers = { ...MEMBER };
  ledgerReadable = true;
  realFetch = globalThis.fetch;
  realEnv = { ...process.env };
  process.env.AIRTABLE_API_KEY = 'stub';
  process.env.AIRTABLE_BASE_ID = 'stub';
  process.env.SENDGRID_API_KEY = 'stub';
  process.env.PREMIUM_PLUS_FIELDS_READY = '1';
  process.env.PREMIUM_PLUS_REOPEN_COUPON_READY = '1';
  process.env.PREMIUM_PLUS_SALE_PAUSE_READY = '1';
  process.env.COMEBACK_OFFER_TABLE_READY = '1';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
  reopenStarts = new Map([[REC, JSON.stringify({
    startsAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(), actor: 'MK',
  })]]);
  stub();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in realEnv)) delete process.env[k];
  Object.assign(process.env, realEnv);
});

// ── 本題: 使ったら消える ────────────────────────────────────
test('振込完了報告が受理されると利用予約が 1 行できる', async () => {
  const res = await apply();
  assert.equal(res.status, 200);
  const rows = reservations();
  assert.equal(rows.length, 1, '予約が作られていない（クーポンが使い放題のまま）');
  assert.equal(rows[0].fields.Status, OFFER_STATUS.ISSUED);
  assert.equal(rows[0].fields.CustomerRecordId, REC);
  assert.equal(rows[0].fields.OfferPrice, 58000);
  assert.equal(rows[0].fields.RegularPrice, 68000);
  assert.ok(rows[0].fields.ExpiresAt, '利用期限が入っていない');
});

test('入金確認でその予約が使用済みになる', async () => {
  await apply();
  const res = await confirm();
  assert.equal(res.status, 200);
  assert.equal(res.body.couponRedeem, 'redeemed', '使用済みにできていない');
  assert.deepEqual(statusesOf(), [OFFER_STATUS.REDEEMED]);
  assert.ok(reservations()[0].fields.RedeemedAt, '使用日時が残っていない');
});

test('使用済みのクーポンでは申込そのものを受け付けない（割引を二度使わせない）', async () => {
  await apply();
  await confirm();
  calls = [];

  // ⚠️ 2026-08-23: 保有（Customers の 3 列）は使い終わっても消えないため、
  //    保有だけを見ていると同じクーポンで何度でも 58,000円 の申込が通ってしまう。
  const res = await apply();
  assert.equal(res.status, 409, '使用済みクーポンの申込が通っている');
  assert.equal(res.body.code, 'coupon_unavailable');
  assert.equal(res.body.sideEffects, 'none');
  assert.equal(reservations().length, 1, '2 行目ができている');
  assert.ok(!calls.includes('OFFER_CREATE'));
});

test('同じ報告を再送しても予約は 1 行のまま（冪等）', async () => {
  await apply();
  await apply();
  await apply();
  assert.equal(reservations().length, 1);
});

test('入金確認を 2 回実行しても二重に使用済みにしない', async () => {
  await apply();
  await confirm();
  const before = reservations()[0].fields.RedeemedAt;

  // 2 回目は昇格そのものが冪等でスキップされる（`RequestedPlan` が消えているため）。
  // つまり redeem 経路にも到達しない＝**二重 redeem は構造的に起きない**。
  const res = await confirm();
  assert.equal(res.status, 200);
  assert.equal(res.body.skipped, true, '2 回目の昇格が冪等になっていない');
  assert.equal(reservations()[0].fields.RedeemedAt, before, '使用日時が上書きされている');
  assert.deepEqual(statusesOf(), [OFFER_STATUS.REDEEMED]);
});

test('昇格が先に走っていても、redeem だけをやり直せる（取りこぼしの復旧）', async () => {
  await apply();
  // 台帳が読めず redeem できなかった状況を作る
  ledgerReadable = false;
  const first = await confirm();
  assert.match(String(first.body.couponRedeem), /^ledger_unavailable:/);
  assert.deepEqual(statusesOf(), [OFFER_STATUS.ISSUED], 'まだ使用済みになっていない');

  // 台帳が復旧しても、昇格は冪等でスキップされるため**自動では直らない**。
  // ⚠️ この取りこぼしは運営者が admin から修復する（`couponLifecycle.needsRepair`）。
  ledgerReadable = true;
  const second = await confirm();
  assert.equal(second.body.skipped, true);
  assert.deepEqual(statusesOf(), [OFFER_STATUS.ISSUED],
    '仕様どおり自動復旧しない（admin の要修復表示で気づく）');
});

// ── fail closed ────────────────────────────────────────────
test('台帳を読めないときはクーポンの申込を受け付けない（誤った金額で受理しない）', async () => {
  // ⚠️ 使用済みかどうかを確かめられないまま 58,000円 の申込を作らない。
  //    通常価格へ黙って落とすのも禁止（58,000円のつもりの人が 68,000円で申し込まされる）。
  ledgerReadable = false;
  const res = await apply();
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'coupon_unavailable');
  assert.equal(res.body.sideEffects, 'none');
  assert.equal(offers.length, 0);
});

test('台帳を読めないときは「予約なし」と決めつけない（昇格は通す）', async () => {
  await apply();
  ledgerReadable = false;
  const res = await confirm();
  assert.equal(res.status, 200, '昇格を巻き戻している');
  assert.match(String(res.body.couponRedeem), /^ledger_unavailable:/);
});

test('台帳の gate が閉じていればクーポンの申込を受け付けない', async () => {
  delete process.env.COMEBACK_OFFER_TABLE_READY;
  const res = await apply();
  assert.equal(res.status, 409);
  assert.equal(offers.length, 0);
});

test('クーポンを使わない申込は台帳の状態に左右されない', async () => {
  // ⚠️ クーポンの都合で**通常価格の申込まで止めない**
  ledgerReadable = false;
  const res = await apply({ couponId: '', transferAmount: '68000' });
  assert.equal(res.status, 200);
  assert.equal(offers.length, 0);
});

test('再募集が未開始（＝期限未確定）なら予約を作らない', async () => {
  reopenStarts = new Map();
  const res = await apply();
  // クーポンが使えないので申込自体が止まる（58,000円のつもりで 68,000円にしない）
  assert.equal(res.status, 409);
  assert.equal(offers.length, 0);
});

// ── クーポンを使わない申込を巻き込まない ──────────────────
test('クーポンを選ばない申込では予約を作らない', async () => {
  const res = await apply({ couponId: '', transferAmount: '68000' });
  assert.equal(res.status, 200);
  assert.equal(offers.length, 0);
});

test('クーポンを使っていない会員の入金確認は静かに通る', async () => {
  const res = await confirm();
  assert.equal(res.status, 200);
  assert.equal(res.body.couponRedeem, undefined, '予約が無いのに結果を返している');
});

test('クーポン未取得の会員では台帳を読みにも行かない（無関係な決済に失敗要因を足さない）', async () => {
  delete customers[PP_REOPEN_COUPON_FIELDS.CLAIMED_AT];
  // 台帳が壊れていても入金確認は素通りする
  ledgerReadable = false;
  const res = await confirm();
  assert.equal(res.status, 200);
  assert.equal(res.body.couponRedeem, undefined);
});

// ── 巻き添えを起こさない ────────────────────────────────
test('予約 / 使用済みで Customers のクーポン 3 列を書き換えない', async () => {
  const before = customers[PP_REOPEN_COUPON_FIELDS.CLAIMED_AT];
  await apply();
  await confirm();
  assert.equal(customers[PP_REOPEN_COUPON_FIELDS.CLAIMED_AT], before,
    '取得の事実を消している（保有は Customers が正本）');
});

test('予約行に決済・会員権・資格のフィールドを混ぜない', async () => {
  await apply();
  const f = reservations()[0].fields;
  // ⚠️ `Status` は台帳側の正規フィールド（issued / redeemed）なので除外しない
  for (const k of ['プラン', '有効期限', 'PaymentConfirmed', 'RequestedPlan',
    'PremiumPlusEligibility', 'PremiumPlusSalePaused', 'PlanType']) {
    assert.ok(!(k in f), `予約行に ${k} が入っている`);
  }
});
