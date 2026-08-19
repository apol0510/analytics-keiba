/**
 * premiumPlusCouponAdmin.test.mjs — クーポンの管理者操作（付与 / 予約取消 / 誤取得訂正 / 再発行）
 *
 * 固定する安全条件:
 *   - 二重付与 / 二重取消 / 二重再発行を構造的に防ぐ
 *   - **使用済みクーポンを再利用可能にしない**
 *   - 予約台帳を読めなければ**全操作を拒否**（fail closed）
 *   - 書けるのはクーポン 3 列だけ（資格・停止・会員権・決済に触れない）
 *   - 操作者・理由が無ければ実行しない（監査できない操作を通さない）
 *   - 訂正しても履歴を消さない（元の取得日時・取得元が残る）
 *   - 他会員の予約行を判定材料にしない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const A = await import('./premiumPlusCouponAdmin.js');
const {
  PP_REOPEN_COUPON_FIELDS, PP_REOPEN_COUPON_WRITABLE_FIELDS,
  PP_REOPEN_COUPON_FORBIDDEN_FIELDS, couponIdWithVersion, readReopenCoupon,
  normalizeCouponSource,
} = await import('./premiumPlusReopenCoupon.js');
const { OFFER_STATUS } = await import('../promotions/promotionalOffer.js');
const { RESERVATION_SOURCE } = await import('../promotions/couponReservationSource.js');

const REC = 'recCUSTOMER00001';
const NOW = Date.parse('2026-08-19T12:00:00.000Z');
const ENV_ON = { PREMIUM_PLUS_FIELDS_READY: '1', PREMIUM_PLUS_REOPEN_COUPON_READY: '1' };
const ACT = { actor: 'MK', reason: 'お電話でのご依頼' };

const HELD = { [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-18T22:07:54.803Z',
  [PP_REOPEN_COUPON_FIELDS.COUPON_ID]: couponIdWithVersion(),
  [PP_REOPEN_COUPON_FIELDS.SOURCE]: 'pause-notice' };
const NOT_HELD = {};

const resv = (status, over = {}) => ({
  id: 'recOFFER0000001',
  fields: {
    OfferKey: 'k1', CustomerRecordId: REC, Email: 'a@example.invalid',
    OfferId: couponIdWithVersion(), Source: RESERVATION_SOURCE, Status: status,
    StartsAt: '2026-09-01T00:00:00.000Z', ExpiresAt: '2026-09-30T00:00:00.000Z', ...over,
  },
});

const plan = (over = {}) => A.resolveCouponAdminPlanFor({
  fields: NOT_HELD, offerRows: [], ledgerAvailable: true, env: ENV_ON,
  nowMs: NOW, customerRecordId: REC, ...ACT, ...over,
});

// ── 監査（誰が・いつ・なぜ）─────────────────────────────────
test('監査値は往復できる（理由に | や = が入っても壊れない）', () => {
  const enc = A.encodeCouponAudit({
    kind: 'admin-grant', actor: 'MK', atIso: '2026-08-19T12:00:00.000Z',
    reason: 'a|b=c のご依頼',
  });
  const got = A.parseCouponAudit(enc);
  assert.equal(got.kind, 'admin-grant');
  assert.equal(got.byAdmin, true);
  assert.equal(got.actor, 'MK');
  assert.equal(got.atIso, '2026-08-19T12:00:00.000Z');
  assert.equal(got.reason, 'a|b=c のご依頼');
});

test('お客様ご自身の取得（旧来の単純な値）も同じ関数で読める', () => {
  const got = A.parseCouponAudit('pause-notice');
  assert.equal(got.byAdmin, false);
  assert.equal(got.kind, 'pause-notice');
  assert.match(A.describeCouponAudit(got), /お客様ご自身/);
});

test('クライアントは管理者操作を騙れない（顧客側 allow-list に admin-* が無い）', () => {
  for (const v of Object.values(A.PP_COUPON_ADMIN_SOURCE)) {
    assert.notEqual(normalizeCouponSource(v), v, `${v} が顧客経路で保存できてしまう`);
  }
  assert.equal(normalizeCouponSource('admin-grant'), 'pause-notice');
});

test('操作者・理由が無ければ実行しない（監査できない操作を通さない）', () => {
  assert.equal(plan({ action: 'grant', actor: '' }).code, A.PP_COUPON_ADMIN_REJECT.MISSING_ACTOR);
  assert.equal(plan({ action: 'grant', reason: '  ' }).code, A.PP_COUPON_ADMIN_REJECT.MISSING_REASON);
});

// ── 付与 ────────────────────────────────────────────────────
test('付与: 未取得の会員へクーポン 3 列だけを書く', () => {
  const out = plan({ action: 'grant' });
  assert.equal(out.ok, true);
  assert.equal(out.target, 'customer');
  assert.deepEqual(Object.keys(out.fields).sort(), [...PP_REOPEN_COUPON_WRITABLE_FIELDS].sort());
  assert.equal(out.fields[PP_REOPEN_COUPON_FIELDS.CLAIMED_AT], new Date(NOW).toISOString());
  assert.equal(out.fields[PP_REOPEN_COUPON_FIELDS.COUPON_ID], couponIdWithVersion());
  const audit = A.parseCouponAudit(out.fields[PP_REOPEN_COUPON_FIELDS.SOURCE]);
  assert.equal(audit.kind, A.PP_COUPON_ADMIN_SOURCE.grant);
  assert.equal(audit.actor, 'MK');
  // 資格 / 停止 / 会員権 / 決済 を 1 つも書いていない
  for (const k of PP_REOPEN_COUPON_FORBIDDEN_FIELDS) assert.ok(!(k in out.fields), k);
});

test('付与: 取得済みへは二重付与しない', () => {
  const out = plan({ action: 'grant', fields: HELD });
  assert.equal(out.ok, false);
  assert.equal(out.code, A.PP_COUPON_ADMIN_REJECT.ALREADY_CLAIMED);
});

test('付与: 保存先が有効化されていなければ実行しない', () => {
  const out = plan({ action: 'grant', env: {} });
  assert.equal(out.code, A.PP_COUPON_ADMIN_REJECT.STORAGE_DISABLED);
});

// ── 使用済みは触らない（最重要）──────────────────────────────
test('使用済みクーポンを取得状態へ戻さない・再発行しない', () => {
  const rows = [resv(OFFER_STATUS.REDEEMED)];
  for (const action of ['grant', 'reissue', 'correct']) {
    const out = plan({ action, fields: action === 'correct' ? HELD : NOT_HELD, offerRows: rows });
    assert.equal(out.ok, false, action);
    assert.equal(out.code, A.PP_COUPON_ADMIN_REJECT.ALREADY_REDEEMED, action);
  }
});

// ── 台帳が読めない = 全操作を断る ────────────────────────────
test('予約台帳を読めなければ全操作を拒否する（fail closed）', () => {
  for (const action of Object.values(A.PP_COUPON_ADMIN_ACTION)) {
    const out = plan({ action, fields: HELD, offerRows: null, ledgerAvailable: false });
    assert.equal(out.ok, false, action);
    assert.equal(out.code, A.PP_COUPON_ADMIN_REJECT.LEDGER_UNAVAILABLE, action);
  }
  // 画面のボタンも全部落ちる（押せるように見せない）
  const view = A.describeCouponAdminActions({
    fields: HELD, offerRows: null, ledgerAvailable: false, env: ENV_ON, customerRecordId: REC,
  });
  assert.ok(view.actions.every((a) => a.enabled === false), '確認できないのに操作できる');
  assert.equal(view.lifecycleIsUnknown, true);
});

// ── 誤取得訂正 ───────────────────────────────────────────────
test('誤取得訂正: 取得を取り消しても履歴を消さない', () => {
  const out = plan({ action: 'correct', fields: HELD, reason: '誤操作のため訂正' });
  assert.equal(out.ok, true);
  assert.equal(out.fields[PP_REOPEN_COUPON_FIELDS.CLAIMED_AT], null, '取得日時を消していない');
  const audit = A.parseCouponAudit(out.fields[PP_REOPEN_COUPON_FIELDS.SOURCE]);
  assert.equal(audit.kind, A.PP_COUPON_ADMIN_SOURCE.correct);
  // **訂正前に何があったか**が残る（隠蔽しない）
  assert.equal(audit.prevClaimedAtIso, '2026-08-18T22:07:54.803Z');
  assert.equal(audit.prevSource, 'pause-notice');
  assert.equal(audit.reason, '誤操作のため訂正');
  // 取得済み判定は ClaimedAt の有無だけ → 訂正後は未取得になる
  const after = { ...HELD, ...out.fields };
  assert.equal(readReopenCoupon(after).claimed, false);
  // それでも監査は読める
  assert.equal(A.parseCouponAudit(readReopenCoupon(after).source).prevClaimedAtIso,
    '2026-08-18T22:07:54.803Z');
});

test('誤取得訂正: 取得していない会員には実行しない', () => {
  assert.equal(plan({ action: 'correct' }).code, A.PP_COUPON_ADMIN_REJECT.NOT_CLAIMED);
});

test('誤取得訂正: 入金確認待ちの予約が残っていたら先に予約取消させる', () => {
  const out = plan({ action: 'correct', fields: HELD, offerRows: [resv(OFFER_STATUS.ISSUED)] });
  assert.equal(out.code, A.PP_COUPON_ADMIN_REJECT.RESERVATION_ACTIVE);
});

// ── 再発行 ──────────────────────────────────────────────────
test('再発行: 訂正済みの会員へ付与し直し、前の取得日時を引き継ぐ', () => {
  const corrected = plan({ action: 'correct', fields: HELD }).fields;
  const afterCorrect = { ...HELD, ...corrected };
  const out = plan({ action: 'reissue', fields: afterCorrect, reason: '訂正後に再発行' });
  assert.equal(out.ok, true);
  const audit = A.parseCouponAudit(out.fields[PP_REOPEN_COUPON_FIELDS.SOURCE]);
  assert.equal(audit.kind, A.PP_COUPON_ADMIN_SOURCE.reissue);
  assert.equal(audit.prevClaimedAtIso, '2026-08-18T22:07:54.803Z', '元の取得日時を失っている');
  assert.equal(readReopenCoupon({ ...afterCorrect, ...out.fields }).claimed, true);
});

test('再発行: 取得済みのまま二重に再発行しない', () => {
  assert.equal(plan({ action: 'reissue', fields: HELD }).code,
    A.PP_COUPON_ADMIN_REJECT.ALREADY_CLAIMED);
});

// ── 予約取消 ────────────────────────────────────────────────
test('予約取消: 予約行だけを対象にし、Customers は触らない', () => {
  const out = plan({ action: 'revokeReservation', fields: HELD, offerRows: [resv(OFFER_STATUS.ISSUED)] });
  assert.equal(out.ok, true);
  assert.equal(out.target, 'reservation');
  assert.equal(out.reservationRecordId, 'recOFFER0000001');
  assert.equal(out.customerFieldsUnchanged, true);
  assert.equal(out.fields, undefined, 'Customers のフィールドを組み立てている');
  assert.match(out.note, /^admin-revoke-reservation\|by=MK\|/);
});

test('予約取消: 二重取消しない / 使用済みは取り消せない', () => {
  assert.equal(plan({ action: 'revokeReservation', fields: HELD, offerRows: [] }).code,
    A.PP_COUPON_ADMIN_REJECT.NO_RESERVATION);
  assert.equal(plan({ action: 'revokeReservation', fields: HELD, offerRows: [resv(OFFER_STATUS.REVOKED)] }).code,
    A.PP_COUPON_ADMIN_REJECT.RESERVATION_NOT_REVOCABLE);
  assert.equal(plan({ action: 'revokeReservation', fields: HELD, offerRows: [resv(OFFER_STATUS.REDEEMED)] }).code,
    A.PP_COUPON_ADMIN_REJECT.RESERVATION_NOT_REVOCABLE);
});

// ── 他会員に影響しない ───────────────────────────────────────
test('他会員の予約行を判定材料にしない', () => {
  const other = resv(OFFER_STATUS.REDEEMED, { CustomerRecordId: 'recOTHER00000001' });
  // 他人が使用済みでも、この会員の付与は妨げられない
  const out = plan({ action: 'grant', offerRows: [other] });
  assert.equal(out.ok, true);
  // 逆に他人の issued があっても予約取消の対象にならない
  assert.equal(plan({
    action: 'revokeReservation', fields: HELD,
    offerRows: [resv(OFFER_STATUS.ISSUED, { CustomerRecordId: 'recOTHER00000001', id: 'recX' })],
  }).code, A.PP_COUPON_ADMIN_REJECT.NO_RESERVATION);
});

// ── 未知の操作 ──────────────────────────────────────────────
test('未知の操作は実行しない', () => {
  assert.equal(plan({ action: 'delete' }).code, A.PP_COUPON_ADMIN_REJECT.UNKNOWN_ACTION);
  assert.equal(plan({ action: '' }).code, A.PP_COUPON_ADMIN_REJECT.UNKNOWN_ACTION);
});

test('再発行のあと、古い取消は「予約取消」として残り続けない', async () => {
  const { describeCouponLifecycle, COUPON_LIFECYCLE } = await import('./premiumPlusCouponReservation.js');
  // 取消済みの予約（2026-09-01 受理）より**後**に再発行したクーポンを持っている
  const reissued = {
    [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-10-01T00:00:00.000Z',
    [PP_REOPEN_COUPON_FIELDS.SOURCE]: 'admin-reissue|by=MK|at=2026-10-01T00:00:00.000Z|why=再発行',
  };
  const life = describeCouponLifecycle({
    fields: reissued, offerRows: [resv(OFFER_STATUS.REVOKED)],
    ledgerAvailable: true, customerRecordId: REC,
  });
  assert.equal(life.state, COUPON_LIFECYCLE.HELD, '再発行後も「予約取消」と出ている');
  // 取得より後に取り消された予約は、いまの状態として出す
  const older = { ...reissued, [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-01T00:00:00.000Z' };
  assert.equal(describeCouponLifecycle({
    fields: older, offerRows: [resv(OFFER_STATUS.REVOKED)],
    ledgerAvailable: true, customerRecordId: REC,
  }).state, COUPON_LIFECYCLE.REVOKED);
});

// ── 画面のボタン活性（案内であって根拠ではない）────────────────
test('操作できない理由を画面へ出せる', () => {
  const view = A.describeCouponAdminActions({
    fields: HELD, offerRows: [resv(OFFER_STATUS.ISSUED)], ledgerAvailable: true,
    env: ENV_ON, customerRecordId: REC,
  });
  const by = Object.fromEntries(view.actions.map((a) => [a.action, a]));
  assert.equal(by.revokeReservation.enabled, true);
  assert.equal(by.correct.enabled, false);
  assert.match(by.correct.blockedBy, /利用予約/);
  assert.equal(by.grant.enabled, false);
  assert.equal(view.state.lifecycleLabel, 'クーポン利用予約（入金確認待ち）');
});
