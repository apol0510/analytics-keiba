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

/**
 * 一覧に出る候補（ROUTE A）でクーポン取得済みの合成会員。
 * **入金確認まで完了した姿**＝ `Requested*` はクリア済み・`PaymentConfirmed` は痕跡として残る
 * （`docs/BANK_TRANSFER_FLOW.md` の正本どおり）。
 */
const MEMBER = {
  'Email': EMAIL, '氏名': 'テスト',
  'プラン': 'Premium Sanrenpuku', 'Status': 'active', '有効期限': '2099-12-31',
  'SanrenpukuPaidAt': '2020-01-01T00:00:00.000Z',
  [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-18T22:07:54.803Z',
  'RequestedPlan': '', 'PaymentConfirmed': true,
};

/**
 * **申込は出したが入金確認がまだ**の会員（＝ 利用予約の通常状態）。
 * 既に active な三連複会員のまま `Requested*` が残り `PaymentConfirmed=false`。
 * ⚠️ `Status='active'` は申込前から変わらないので、**active だけで確定と判定しない**。
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

/**
 * 長く `issued` のまま残っている予約（＝記録漏れか入金なしの疑い）。
 * ⚠️ Premium Plus は Customers に申込内容を書かないため、入金確認の有無は
 *    Customers から判定できない。**滞留だけが実データで拾える事実**。
 */
const staleReservation = () => reservation('issued', {
  StartsAt: new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString(),
  ExpiresAt: new Date(Date.now() - 16 * 24 * 3600 * 1000).toISOString(),
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
/**
 * ⚠️ `Response`（undici）を返さない。読まれない body のストリームがテスト終了後まで残り、
 *    CI で「A resource generated asynchronous activity after the test ended」で落ちる。
 *    handler が使うのは `ok` / `status` / `json()` だけなので、素の object で足りる。
 */
const reply = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function stub(cfg = {}) {
  const member = cfg.member || MEMBER;
  const offers = cfg.offers || [];
  const mode = cfg.ledger || 'ok';
  const calls = { offers: 0, customers: 0 };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/PromotionalOffers/')) {
      calls.offers += 1;
      if (mode === 'fail') return reply(500, { error: 'boom' });
      // 常に offset を返し続ける = ページ上限に当たる（全件読み切れない）
      if (mode === 'pages') return reply(200, { records: offers, offset: 'more' });
      return reply(200, { records: offers });
    }
    if (u.includes('/Customers/')) {
      calls.customers += 1;
      return reply(200, { records: [{ id: REC, fields: member }] });
    }
    if (u.includes('/CampaignDeliveries/')) return reply(200, { records: [] });
    return reply(403, { error: 'blocked' });
  };
  return calls;
}

/**
 * handler は **1 回だけ** import する。
 * ⚠️ `?t=${Math.random()}` で毎回読み直すと、大きな依存グラフが呼び出し回数だけ
 *    生成されて CI で残留する。env は request 時に読まれるので使い回して問題ない。
 */
let handlerPromise = null;
function loadHandler() {
  if (!handlerPromise) {
    globalThis.exports = {};
    globalThis.module = { exports: globalThis.exports };
    // ESM import + exports.handler の混在（Netlify の bundler と同じ扱い）
    handlerPromise = import(FN).then(() => globalThis.exports.handler);
  }
  return handlerPromise;
}

async function post(body) {
  const handler = await loadHandler();
  const res = await handler({
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

test('長く残った利用予約は要修復として両方の経路で同じに出る', async () => {
  stub({ offers: [staleReservation()], member: MEMBER });
  let v = await bothViews();
  assert.equal(v.listRow.couponLifecycle.state, COUPON_LIFECYCLE.NEEDS_REPAIR);
  assert.equal(v.listRow.couponLifecycle.redeemState, 'needs_redeem');
  assert.ok(v.listRow.couponLifecycle.repair.length > 0, '修復手順が出ていない');
  assert.deepEqual(v.lookupRow.couponLifecycle, v.listRow.couponLifecycle);

  // 使用済みは完了。Customers の姿では変わらない（Plus は Customers から判定できない）
  stub({ offers: [reservation(OFFER_STATUS.REDEEMED)], member: MEMBER_UNSETTLED });
  v = await bothViews();
  assert.equal(v.listRow.couponLifecycle.state, COUPON_LIFECYCLE.REDEEMED);
  assert.equal(v.listRow.couponLifecycle.needsRepair, false);
  assert.deepEqual(v.lookupRow.couponLifecycle, v.listRow.couponLifecycle);
});

test('active だけでは「入金確認済み」と判定しない（admin の表示まで通して確認）', async () => {
  // ① 申込直後: active + RequestedPlan あり + PaymentConfirmed=false → 利用予約（待ち）
  stub({ offers: [reservation(OFFER_STATUS.ISSUED)], member: MEMBER_UNSETTLED });
  let v = await bothViews();
  assert.equal(v.listRow.couponLifecycle.state, COUPON_LIFECYCLE.RESERVED);
  assert.equal(v.listRow.couponLifecycle.redeemState, 'waiting');
  assert.equal(v.listRow.couponLifecycle.needsRepair, false, '入金確認待ちを要修復にしている');
  assert.deepEqual(v.lookupRow.couponLifecycle, v.listRow.couponLifecycle);

  // ② 申込は残っていないが入金確認を経ていない → **確定としない**（fail closed）。
  //    issued はそのまま「利用予約」で、要修復にはしない
  const NOT_CONFIRMED = { ...MEMBER, 'RequestedPlan': '', 'PaymentConfirmed': false };
  stub({ offers: [reservation(OFFER_STATUS.ISSUED)], member: NOT_CONFIRMED });
  v = await bothViews();
  assert.equal(v.listRow.couponLifecycle.state, COUPON_LIFECYCLE.RESERVED);
  assert.equal(v.listRow.couponLifecycle.needsRepair, false);
  assert.deepEqual(v.lookupRow.couponLifecycle, v.listRow.couponLifecycle);

  // ③ ⚠️ 2026-08-23 修正: Customers が「入金確認済み」に見えても、
  //    受理直後の予約を要修復にしない。Premium Plus の申込は Customers を書き換えないため、
  //    既に有料会員の申込者は**申し込む前から確定済みに見える**（＝入金前の誤警告になる）。
  stub({ offers: [reservation(OFFER_STATUS.ISSUED)], member: MEMBER });
  v = await bothViews();
  assert.equal(v.listRow.couponLifecycle.redeemState, 'waiting');
  assert.equal(v.listRow.couponLifecycle.needsRepair, false, '入金前に修復を促している');
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
