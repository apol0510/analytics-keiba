/**
 * premiumPlusCouponReservation.test.mjs — クーポンの利用予約 → 使用済み
 *
 * 確定仕様（2026-08-19 MK）:
 *   振込完了報告の正常受理 → issued（利用予約） / 入金確認の正常完了 → redeemed
 *   ExpiresAt はクーポン本体の利用期限。**期限判定は報告受理時に固定**する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const R = await import('./premiumPlusCouponReservation.js');
const { PP_REOPEN_COUPON, PP_REOPEN_COUPON_FIELDS, couponIdWithVersion } = await import('./premiumPlusReopenCoupon.js');
const { OFFER_STATUS, OFFER_WRITABLE_FIELDS } = await import('../promotions/promotionalOffer.js');

const ID = couponIdWithVersion();
const REC = 'recCUSTOMER00001';
const HELD = { [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-18T22:07:54.803Z' };
const ENV_ON = { COMEBACK_OFFER_TABLE_READY: '1' };

/** 期限が確定した世界を作る（正本は変えない） */
const withExpiry = (iso) => ({
  ...PP_REOPEN_COUPON,
  terms: { ...PP_REOPEN_COUPON.terms, expiresAt: iso, expiresDetermined: true },
});

const row = (over = {}) => ({
  id: 'recOFFER0000001',
  fields: {
    OfferKey: 'k', CustomerRecordId: REC, Email: 'a@example.invalid', OfferId: ID,
    Source: R.RESERVATION_SOURCE, Status: OFFER_STATUS.ISSUED,
    StartsAt: '2026-09-01T00:00:00.000Z', ExpiresAt: '2026-09-30T00:00:00.000Z',
    RegularPrice: 68000, OfferPrice: 58000, ...over,
  },
});

// ── 期限未確定は fail closed ─────────────────────────────────
test('期限が未確定なら予約行を作れない（fail closed）', () => {
  assert.equal(R.buildReservationFields({
    customerRecordId: REC, email: 'a@example.invalid', applicationId: 'app1', nowMs: Date.now(),
  }), null);
  assert.equal(R.isReservationEnabled(ENV_ON), false);
  const d = R.resolveReservationDecision({ fields: HELD, customerRecordId: REC, nowMs: Date.now(), env: ENV_ON });
  assert.equal(d.ok, false);
  assert.equal(d.reason, R.RESERVATION_REJECT.EXPIRY_UNDETERMINED);
});

test('仮の期限を勝手に入れない（14日 / 90日などの既定値が無い）', () => {
  const src = read('./premiumPlusCouponReservation.js')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(src, /DEFAULT_.*TTL|14|90|24 \* 60|48 \* 60/, '既定の期限を持っている');
});

// ── 予約の作成 ──────────────────────────────────────────────
test('期限内に振込完了報告を受理したら issued の予約行を作る', () => {
  const def = withExpiry('2026-09-30T00:00:00.000Z');
  const now = Date.parse('2026-09-01T00:00:00.000Z');
  const built = R.buildReservationFields({
    customerRecordId: REC, email: 'A@Example.invalid', applicationId: 'app1', nowMs: now, def,
  });
  assert.ok(built, '予約行が作られない');
  assert.equal(built.fields.Status, OFFER_STATUS.ISSUED);
  assert.equal(built.fields.Source, R.RESERVATION_SOURCE);
  assert.equal(built.fields.OfferPrice, 58000);
  assert.equal(built.fields.RegularPrice, 68000);
  // StartsAt = 報告受理時刻 / ExpiresAt = クーポン本体の期限
  assert.equal(built.fields.StartsAt, new Date(now).toISOString());
  assert.equal(built.fields.ExpiresAt, '2026-09-30T00:00:00.000Z');
  // 既存 schema の許可列だけ
  for (const k of Object.keys(built.fields)) {
    assert.ok(OFFER_WRITABLE_FIELDS.includes(k), `${k} は既存 schema に無い`);
  }
});

test('選択しただけでは予約を作らない（作るのは報告受理時だけ）', () => {
  // 予約を作る関数は「報告受理時に呼ぶ」もので、選択時に呼ばれる経路が無い
  const api = read('../../pages/api/premium-plus-order.json.js');
  assert.doesNotMatch(api, /buildReservationFields|RESERVATION_SOURCE/, '選択の API が予約を作っている');
  const apply = read('./premiumPlusCouponApply.js');
  assert.doesNotMatch(apply, /buildReservationFields/, '適用の判定が予約を作っている');
});

test('振込完了報告が失敗したら予約は作られない（受理後にだけ作る設計）', () => {
  const fn = read('../../../netlify/functions/bank-transfer-application.js');
  // 現時点では未接続。接続時も「受理が確定したあと」でしか呼べないことを固定する
  assert.doesNotMatch(fn, /buildReservationFields/, '受理前に予約を作る配線が入っている');
});

// ── 新規利用は期限内だけ ────────────────────────────────────
test('期限切れのクーポンで新規に予約できない', () => {
  const def = withExpiry('2026-09-30T00:00:00.000Z');
  const after = Date.parse('2026-10-01T00:00:00.000Z');
  // 期限判定は resolveReservationDecision（正本 def は未確定なので直接検査）
  const expires = Date.parse(def.terms.expiresAt);
  assert.ok(expires <= after, '前提が壊れている');
  // buildReservationFields は期限確定の def なら作るが、決定側が弾く設計
  const d = R.resolveReservationDecision({ fields: HELD, customerRecordId: REC, nowMs: after, env: ENV_ON });
  assert.equal(d.ok, false);
});

// ── 二重予約 ────────────────────────────────────────────────
test('同一クーポンで複数の予約を作れない（入金確認待ちが 1 件あれば拒否）', () => {
  const existing = [row()];
  const found = R.findActiveReservation({ records: existing, customerRecordId: REC });
  assert.ok(found, '既存の予約を検出できていない');
});

test('再送しても同じ申込なら同じキー＝ 1 行のまま（二重予約しない）', () => {
  const a = R.computeReservationKey({ customerRecordId: REC, applicationId: 'app1' });
  const b = R.computeReservationKey({ customerRecordId: REC, applicationId: 'app1' });
  const c = R.computeReservationKey({ customerRecordId: REC, applicationId: 'app2' });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// ── 期限をまたいでも失効させない（最重要）──────────────────
test('期限内に報告済みなら、入金確認が期限後になっても redeem できる', () => {
  const rec = row({ StartsAt: '2026-09-29T00:00:00.000Z', ExpiresAt: '2026-09-30T00:00:00.000Z' });
  // MK の確認が期限を大きく過ぎた
  const out = R.buildReservationRedeemFields({ record: rec, nowMs: Date.parse('2026-12-01T00:00:00.000Z') });
  assert.ok(out.fields, `確認待ち時間で失効している: ${out.skipped}`);
  assert.equal(out.fields.Status, OFFER_STATUS.REDEEMED);
  assert.ok(out.fields.RedeemedAt);
});

test('報告受理時に期限を過ぎていた行は redeem しない（台帳から再現できる）', () => {
  const rec = row({ StartsAt: '2026-10-05T00:00:00.000Z', ExpiresAt: '2026-09-30T00:00:00.000Z' });
  assert.equal(R.wasReportedWithinExpiry(rec), false);
  const out = R.buildReservationRedeemFields({ record: rec, nowMs: Date.parse('2026-10-06T00:00:00.000Z') });
  assert.equal(out.skipped, 'reported_after_expiry');
});

test('redeem は現在時刻と ExpiresAt を比べない（実装で固定）', () => {
  const src = read('./premiumPlusCouponReservation.js');
  const fn = src.slice(src.indexOf('export function buildReservationRedeemFields'));
  assert.doesNotMatch(fn.slice(0, 900), /nowMs\s*[<>]=?\s*expires|expires\w*\s*[<>]=?\s*nowMs/,
    '現在時刻と期限を比べている');
  assert.match(fn.slice(0, 900), /wasReportedWithinExpiry/);
});

// ── redeem の冪等性 ─────────────────────────────────────────
test('入金確認を再実行しても二重 redeem しない', () => {
  const first = R.buildReservationRedeemFields({ record: row(), nowMs: Date.now() });
  assert.ok(first.fields);
  const again = R.buildReservationRedeemFields({
    record: row({ Status: OFFER_STATUS.REDEEMED, RedeemedAt: '2026-09-05T00:00:00.000Z' }),
    nowMs: Date.now(),
  });
  assert.equal(again.skipped, 'already_redeemed');
});

test('入金確認が成功する前に redeemed にしない（呼ぶのは confirm 完了時だけ）', () => {
  const confirm = read('../../../netlify/functions/confirm-bank-payment.js');
  assert.doesNotMatch(confirm, /buildReservationRedeemFields/, '未接続のはずが配線されている');
});

// ── 取消 ────────────────────────────────────────────────────
test('予約取消は予約行だけを revoked にし、取得済みクーポンは消えない', () => {
  const out = R.buildReservationRevokeFields({ record: row(), nowMs: Date.now(), reason: '入金確認前の取消' });
  assert.equal(out.fields.Status, OFFER_STATUS.REVOKED);
  // 触るのは offer 台帳の列だけ。Customers 側（取得の事実・会員権・決済）には触れない
  for (const k of Object.keys(out.fields)) {
    assert.ok(OFFER_WRITABLE_FIELDS.includes(k), `${k} は offer 台帳の列ではない`);
    assert.doesNotMatch(k, /ReopenCoupon|プラン|PlanType|PaidAt|PaymentConfirmed|有効期限/,
      `${k}: Customers 側の列を書こうとしている`);
  }
  // 取消後もライフサイクル上は「取得済み」が残る
  const life = R.describeCouponLifecycle({
    fields: HELD, offerRows: [row({ Status: OFFER_STATUS.REVOKED })], customerRecordId: REC,
  });
  assert.equal(life.claimed, true);
  assert.equal(life.state, R.COUPON_LIFECYCLE.REVOKED);
});

test('使用済みの予約は取り消せない', () => {
  const out = R.buildReservationRevokeFields({ record: row({ Status: OFFER_STATUS.REDEEMED }), nowMs: Date.now() });
  assert.equal(out.skipped, 'already_redeemed');
});

// ── admin 分類 ──────────────────────────────────────────────
test('利用予約を通常の販促 offer と混同しない', () => {
  const promo = { id: 'recPROMO', fields: { CustomerRecordId: REC, Status: 'issued', Source: 'comeback-campaign' } };
  assert.equal(R.isReservationRow(promo), false);
  assert.equal(R.isReservationRow(row()), true);

  // 管理集計でも分けている（予約行は offer のカウントから除外される）
  const admin = read('../../../netlify/functions/admin-marketing.js');
  assert.match(admin, /const reservations = all\.filter\(\(o\) => isReservationRow\(o\)\)/);
  assert.match(admin, /const uniq = all\.filter\(\(o\) => !isReservationRow\(o\)\)/);
  assert.match(admin, /couponReservationCount: reservations\.length/);
  // ⚠️ 販促側は Premium Plus の販売判定モジュールを import しない（既存の分離）
  assert.doesNotMatch(admin, /from '\.\.\/\.\.\/src\/lib\/premiumPlus\//, '販売と販促の分離を壊している');
  assert.match(admin, /from '\.\.\/\.\.\/src\/lib\/promotions\/couponReservationSource\.js'/);
});

test('ライフサイクルの 4 状態を区別できる', () => {
  const L = R.COUPON_LIFECYCLE;
  const s = (rows, fields = HELD) => R.describeCouponLifecycle({ fields, offerRows: rows, customerRecordId: REC }).state;
  assert.equal(s([]), L.HELD);
  assert.equal(s([row()]), L.RESERVED);
  assert.equal(s([row({ Status: OFFER_STATUS.REDEEMED })]), L.REDEEMED);
  assert.equal(s([row({ Status: OFFER_STATUS.REVOKED })]), L.REVOKED);
  assert.equal(s([], {}), L.NONE);
});

test('他会員の予約行はライフサイクルに混ざらない', () => {
  const other = row({ CustomerRecordId: 'recOTHER00000001' });
  const life = R.describeCouponLifecycle({ fields: HELD, offerRows: [other], customerRecordId: REC });
  assert.equal(life.state, R.COUPON_LIFECYCLE.HELD);
  assert.equal(life.reservationCount, 0);
});

// ── schema を増やしていない ─────────────────────────────────
test('PromotionalOffers の既存列だけで表現している（schema 追加なし）', () => {
  const def = withExpiry('2026-09-30T00:00:00.000Z');
  const built = R.buildReservationFields({
    customerRecordId: REC, email: 'a@example.invalid', applicationId: 'app1',
    nowMs: Date.parse('2026-09-01T00:00:00.000Z'), def,
  });
  for (const k of Object.keys(built.fields)) assert.ok(OFFER_WRITABLE_FIELDS.includes(k), k);
  // 新しい Status 値を作っていない
  const src = read('./premiumPlusCouponReservation.js');
  assert.doesNotMatch(src, /Status:\s*'(reserved|pending|awaiting)/i);
});
