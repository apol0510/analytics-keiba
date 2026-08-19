/**
 * adminCouponLedger.smoke.test.mjs — 管理画面の Function を**実際に動かして**
 * 一覧（list）と個別検索（lookup）が **同じ予約台帳・同じ判定**を返すことを固定する。
 *
 * 固定する仕様:
 *   - list と lookup で `couponLifecycle` が **完全一致**する
 *     （lookup が台帳を読まないと「所持中・予約 0 件」に化ける ＝ 過去の不整合）
 *   - 台帳を読めた `[]` は **予約 0 件**として扱える
 *   - gate off / 読み取り失敗 / ページ上限は **「確認できない」**（0 件と混同しない）
 *   - 「確認できない」を「クーポン所持中」「予約 0 件」と**断定表示しない**
 *   - 通常の販促 offer を利用予約と混同しない
 *
 * Airtable は fetch をスタブする。**本番へは一切アクセスしない**（合成レコードのみ）。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const FN = fileURLToPath(new URL('../../../netlify/functions/premium-plus-eligibility.js', import.meta.url));
const { couponIdWithVersion, PP_REOPEN_COUPON_FIELDS } = await import('./premiumPlusReopenCoupon.js');
const { RESERVATION_SOURCE, COUPON_LIFECYCLE, LEDGER_UNAVAILABLE } =
  await import('./premiumPlusCouponReservation.js');
const { OFFER_STATUS } = await import('../promotions/promotionalOffer.js');

const ID = couponIdWithVersion();
const SECRET = 'admin-secret-for-test';
const REC = 'recSYNTH00000001';
const EMAIL = 'synthetic@example.invalid';

/** 一覧に出る候補（ROUTE A）でクーポン取得済みの合成会員 */
const MEMBER = {
  'Email': EMAIL, '氏名': 'テスト',
  'プラン': 'Premium Sanrenpuku', 'Status': 'active', '有効期限': '2099-12-31',
  'SanrenpukuPaidAt': '2020-01-01T00:00:00.000Z',
  [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-18T22:07:54.803Z',
};

/**
 * **申込は出したが入金確認がまだ**の会員（＝ 利用予約の通常状態）。
 * 既に active な三連複会員のまま `Requested*` が残っているのが実際の姿で、
 * `confirm-bank-payment` が承認時にこれをクリアする。
 */
const MEMBER_UNSETTLED = {
  ...MEMBER,
  'RequestedPlan': 'Premium Plus', 'RequestedPlanType': 'Single', 'RequestedAmount': 58000,
  'PaymentConfirmed': false,
};

const reservation = (status, over = {}) => ({
  id: 'recOFFER0000001',
  fields: {
    OfferKey: 'k1', CustomerRecordId: REC, Email: EMAIL, OfferId: ID,
    Source: RESERVATION_SOURCE, Status: status,
    StartsAt: '2026-09-01T00:00:00.000Z', ExpiresAt: '2026-09-30T00:00:00.000Z',
    RegularPrice: 68000, OfferPrice: 58000, ...over,
  },
});

/** 通常の販促 offer（クーポン予約ではない） */
const marketingOffer = {
  id: 'recPROMO0000001',
  fields: {
    OfferKey: 'k2', CustomerRecordId: REC, Email: EMAIL, OfferId: 'comeback-2026',
    Source: 'comeback-campaign', Status: OFFER_STATUS.ISSUED,
  },
};

let realFetch;
let realEnv;

/**
 * @param {{ member?: object, ledger?: 'ok'|'fail'|'pages', offers?: object[] }} cfg
 */
function stub(cfg = {}) {
  const member = cfg.member || MEMBER;
  const offers = cfg.offers || [];
  const mode = cfg.ledger || 'ok';
  const calls = { offers: 0, customers: 0 };
  globalThis.fetch = async (url) => {
    const u = String(url);
    const ok = (body) => new Response(JSON.stringify(body),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/PromotionalOffers/')) {
      calls.offers += 1;
      if (mode === 'fail') return new Response('boom', { status: 500 });
      // 常に offset を返し続ける = ページ上限に当たる（全件読み切れない）
      if (mode === 'pages') return ok({ records: offers, offset: 'more' });
      return ok({ records: offers });
    }
    if (u.includes('/Customers/')) { calls.customers += 1; return ok({ records: [{ id: REC, fields: member }] }); }
    if (u.includes('/CampaignDeliveries/')) return ok({ records: [] });
    return new Response('blocked', { status: 403 });
  };
  return calls;
}

async function post(body) {
  globalThis.exports = {};
  globalThis.module = { exports: globalThis.exports };
  // ESM import + exports.handler の混在（Netlify の bundler と同じ扱い）
  await import(`${FN}?t=${Math.random()}`);
  const res = await globalThis.exports.handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-secret': SECRET },
    body: JSON.stringify(body),
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body) };
}

/** 同じ会員を 一覧 と 個別検索 の両方から取り出す */
async function bothViews() {
  const list = await post({ action: 'list' });
  const lookup = await post({ action: 'lookup', query: EMAIL });
  const pick = (out) => (out.body.rows || []).find((r) => r.recordId === REC) || null;
  return { list, lookup, listRow: pick(list), lookupRow: pick(lookup) };
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  realEnv = { ...process.env };
  process.env.PREMIUM_PLUS_ADMIN_SECRET = SECRET;
  process.env.AIRTABLE_API_KEY = 'key-test';
  process.env.AIRTABLE_BASE_ID = 'app-test';
  process.env.COMEBACK_OFFER_TABLE_READY = '1';
  // 実閲覧（Redis）は使わない。未設定なら fetch しない
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in realEnv)) delete process.env[k];
  Object.assign(process.env, realEnv);
});

// ── 一覧と個別検索の一致（本件の主目的）────────────────────────
test('個別検索も一覧と同じ台帳を読む（利用予約が「所持中」に化けない）', async () => {
  const calls = stub({ offers: [reservation(OFFER_STATUS.ISSUED)], member: MEMBER_UNSETTLED });
  const { listRow, lookupRow } = await bothViews();

  assert.ok(listRow, '一覧に合成会員が出ていない');
  assert.ok(lookupRow, '個別検索で合成会員を引けていない');
  assert.equal(listRow.couponLifecycle.state, COUPON_LIFECYCLE.RESERVED);
  // ⚠️ ここが今回の不整合。lookup が台帳を読まないと held / 0 件へ化ける
  assert.equal(lookupRow.couponLifecycle.state, COUPON_LIFECYCLE.RESERVED);
  assert.deepEqual(lookupRow.couponLifecycle, listRow.couponLifecycle,
    '一覧と個別検索でクーポンの判定がズレている');
  assert.equal(lookupRow.couponLifecycle.reservationCount, 1);
  assert.ok(calls.offers >= 2, '個別検索が予約台帳を読んでいない');
});

test('使用済み・予約取消も一覧と個別検索で一致する', async () => {
  for (const [status, expected] of [
    [OFFER_STATUS.REDEEMED, COUPON_LIFECYCLE.REDEEMED],
    [OFFER_STATUS.REVOKED, COUPON_LIFECYCLE.REVOKED],
  ]) {
    stub({ offers: [reservation(status)] });
    const { listRow, lookupRow } = await bothViews();
    assert.equal(listRow.couponLifecycle.state, expected, `list: ${status}`);
    assert.deepEqual(lookupRow.couponLifecycle, listRow.couponLifecycle, `lookup: ${status}`);
  }
});

test('入金確認と使用済みの食い違い（要修復 / 異常）も両方の経路で同じに出る', async () => {
  // 昇格済み + 予約 issued = 要修復（needs_redeem）
  stub({ offers: [reservation(OFFER_STATUS.ISSUED)], member: MEMBER });
  let v = await bothViews();
  assert.equal(v.listRow.couponLifecycle.state, COUPON_LIFECYCLE.NEEDS_REPAIR);
  assert.equal(v.listRow.couponLifecycle.redeemState, 'needs_redeem');
  assert.ok(v.listRow.couponLifecycle.repair.length > 0, '修復手順が出ていない');
  assert.deepEqual(v.lookupRow.couponLifecycle, v.listRow.couponLifecycle);

  // 未確定 + 予約 redeemed = 異常（anomaly）
  stub({ offers: [reservation(OFFER_STATUS.REDEEMED)], member: MEMBER_UNSETTLED });
  v = await bothViews();
  assert.equal(v.listRow.couponLifecycle.state, COUPON_LIFECYCLE.NEEDS_REPAIR);
  assert.equal(v.listRow.couponLifecycle.redeemState, 'anomaly');
  assert.deepEqual(v.lookupRow.couponLifecycle, v.listRow.couponLifecycle);
});

// ── 「読めた 0 件」と「確認できない」を分ける ──────────────────
test('台帳を読めた結果が空なら「予約 0 件」として扱える', async () => {
  stub({ offers: [] });
  const { list, listRow, lookupRow } = await bothViews();
  assert.equal(list.body.couponLedger.available, true);
  assert.equal(listRow.couponLifecycle.ledgerAvailable, true);
  assert.equal(listRow.couponLifecycle.state, COUPON_LIFECYCLE.HELD);
  assert.equal(listRow.couponLifecycle.reservationCount, 0);
  assert.deepEqual(lookupRow.couponLifecycle, listRow.couponLifecycle);
});

test('gate off は「確認できない」（0 件と断定しない）', async () => {
  delete process.env.COMEBACK_OFFER_TABLE_READY;
  const calls = stub({ offers: [reservation(OFFER_STATUS.ISSUED)] });
  const { list, listRow, lookupRow } = await bothViews();
  assert.equal(calls.offers, 0, 'gate off なのに台帳を読みに行っている');
  assert.equal(list.body.couponLedger.available, false);
  assert.equal(list.body.couponLedger.reason, LEDGER_UNAVAILABLE.GATE_OFF);
  assert.ok(list.body.couponLedger.note.includes('確認できません'));
  assert.equal(listRow.couponLifecycle.state, COUPON_LIFECYCLE.UNKNOWN);
  assert.equal(listRow.couponLifecycle.reservationCount, null, '確認できないのに 0 件を返している');
  assert.deepEqual(lookupRow.couponLifecycle, listRow.couponLifecycle);
});

test('Airtable の読み取り失敗は「確認できない」', async () => {
  stub({ ledger: 'fail', offers: [reservation(OFFER_STATUS.ISSUED)] });
  const { list, listRow, lookupRow } = await bothViews();
  assert.equal(list.body.couponLedger.available, false);
  assert.equal(list.body.couponLedger.reason, LEDGER_UNAVAILABLE.READ_FAILED);
  assert.equal(listRow.couponLifecycle.state, COUPON_LIFECYCLE.UNKNOWN);
  assert.deepEqual(lookupRow.couponLifecycle, listRow.couponLifecycle);
});

test('ページ上限で読み切れなければ「確認できない」（読めた分を全件にしない）', async () => {
  stub({ ledger: 'pages', offers: [reservation(OFFER_STATUS.ISSUED)] });
  const { list, listRow } = await bothViews();
  assert.equal(list.body.couponLedger.available, false);
  assert.equal(list.body.couponLedger.reason, LEDGER_UNAVAILABLE.PAGE_LIMIT);
  assert.equal(listRow.couponLifecycle.state, COUPON_LIFECYCLE.UNKNOWN);
  assert.equal(listRow.couponLifecycle.reservationCount, null);
});

test('確認できないときは「所持中」「予約 0 件」「要修復」と断定しない', async () => {
  delete process.env.COMEBACK_OFFER_TABLE_READY;
  stub({});
  const { list, listRow } = await bothViews();
  const cl = listRow.couponLifecycle;
  assert.notEqual(cl.state, COUPON_LIFECYCLE.HELD);
  assert.notEqual(cl.state, COUPON_LIFECYCLE.NONE);
  assert.equal(cl.needsRepair, false, '確認できないのに要修復と断定している');
  assert.equal(cl.redeemState, 'unknown');
  assert.equal(cl.reservationCountText, '確認できない');
  // Customers 側の「取得した」という事実だけは読めているので残す
  assert.equal(cl.claimed, true);
  assert.equal(listRow.reopenCouponClaimed, true);
  // 件数も「確認できない」を 0 として出さない
  assert.equal(list.body.counts.couponReserved, null);
  assert.equal(list.body.counts.couponRedeemed, null);
  assert.equal(list.body.counts.couponNeedsRepair, null);
});

// ── 通常の販促 offer と混同しない ───────────────────────────
test('通常の販促 offer をクーポンの利用予約と数えない', async () => {
  stub({ offers: [marketingOffer] });
  const { listRow, lookupRow } = await bothViews();
  assert.equal(listRow.couponLifecycle.state, COUPON_LIFECYCLE.HELD);
  assert.equal(listRow.couponLifecycle.reservationCount, 0);
  assert.deepEqual(lookupRow.couponLifecycle, listRow.couponLifecycle);
});

test('他会員の予約行は混ざらない', async () => {
  stub({ offers: [reservation(OFFER_STATUS.ISSUED, { CustomerRecordId: 'recOTHER00000001' })] });
  const { listRow } = await bothViews();
  assert.equal(listRow.couponLifecycle.state, COUPON_LIFECYCLE.HELD);
  assert.equal(listRow.couponLifecycle.reservationCount, 0);
});
