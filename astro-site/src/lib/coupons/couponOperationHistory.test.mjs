/**
 * couponOperationHistory.test.mjs — append-only 履歴（**設計のみ・本番テーブル未作成**）
 *
 * 固定すること:
 *   - テーブルを作るまで**書き込み計画を立てない**（fail closed）
 *   - **冪等キーに現在時刻を使わない**（同じ論理操作の再送で必ず同じ値）
 *   - 同じ操作を時間を変えて再送 → 履歴 1 件
 *   - response 喪失後の retry → 1 件
 *   - 二重クリック / 並行 2 要求 → 1 件（Redis の墓標で 1 本だけ通す）
 *   - state 成功 / history 失敗 → history-only repair で 1 件へ収束
 *   - repair 再実行 → 1 件のまま
 *   - correct → reissue などの別操作は**別 OperationId**
 *   - 他会員 / 他商品は**別 OperationId**
 *   - 課金・権限の列を持たない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const H = await import('./couponOperationHistory.js');
const P = await import('./couponPlatform.js');
const { COUPON_OPERATION, PRODUCT_KEY } = P;

const ON = { COUPON_HISTORY_TABLE_READY: '1' };
const BASE = {
  productKey: PRODUCT_KEY.PREMIUM_PLUS, couponId: 'premium-plus-reopen-priority', version: 1,
  customerRecordId: 'recA',
};
const opId = (over = {}) => P.computeCouponOperationId({
  ...BASE, operationType: COUPON_OPERATION.GRANT, anchor: 'none', ...over,
});
const rec = (over = {}) => H.buildHistoryRecord({
  ...BASE,
  operationType: COUPON_OPERATION.GRANT, actor: 'MK', reason: 'お電話でのご依頼',
  beforeState: 'none', afterState: 'held', detail: 'admin-grant|by=MK',
  atIso: '2026-08-20T12:00:00.000Z', operationId: opId(), ...over,
});
const row = (id) => ({ id: 'recH1', fields: { OperationId: id, CustomerRecordId: 'recA', OccurredAt: '2026-08-20T12:00:00.000Z' } });

// ── 本番未作成のあいだは積まない ─────────────────────────────
test('本番テーブルが未有効のあいだは何も積まない（fail closed）', () => {
  assert.equal(H.isCouponHistoryEnabled({}), false);
  assert.equal(H.isCouponHistoryEnabled({ COUPON_HISTORY_TABLE_READY: '0' }), false);
  const p = H.planHistoryAppend({ record: rec(), existing: [], env: {} });
  assert.equal(p.append, false);
  assert.equal(p.reason, 'history_disabled');
});

test('本番テーブルへ書く経路をまだ作っていない（設計のみ）', () => {
  const fn = read('../../../netlify/functions/premium-plus-eligibility.js');
  assert.doesNotMatch(fn, /CouponOperationHistory/, '本番テーブル未作成なのに書き込み経路がある');
});

// ── 冪等キーは時計に依存しない ───────────────────────────────
test('冪等キーに現在時刻が入っていない（時刻を変えても同じ値）', () => {
  const a = rec({ atIso: '2026-08-20T12:00:00.000Z' });
  const b = rec({ atIso: '2026-08-21T09:30:00.000Z' });
  assert.equal(a.operationId, b.operationId, '時刻で冪等キーが変わっている');
  // 実装にも現在時刻を混ぜていない
  const src = read('./couponPlatform.js');
  const fn = src.slice(src.indexOf('export function computeCouponOperationId'));
  assert.doesNotMatch(fn.slice(0, fn.indexOf('\n}')), /atIso|Date\.now|new Date/,
    '冪等キーの計算に時刻が入っている');
});

test('同じ操作を時間を変えて再送しても履歴は 1 件', () => {
  const first = rec({ atIso: '2026-08-20T12:00:00.000Z' });
  assert.equal(H.planHistoryAppend({ record: first, existing: [], env: ON }).append, true);
  // 1 件積まれた後の再送（時刻は進んでいる）
  const retry = rec({ atIso: '2026-08-20T12:00:30.000Z' });
  const p = H.planHistoryAppend({ record: retry, existing: [row(first.operationId)], env: ON });
  assert.equal(p.append, false);
  assert.equal(p.reason, 'already_recorded');
});

test('response 喪失後の retry も 1 件（行が既にあれば積まない）', () => {
  const r = rec();
  // 書けたが応答が返らなかった → もう一度同じ操作を投げる
  const p = H.planHistoryAppend({ record: rec(), existing: [row(r.operationId)], env: ON });
  assert.equal(p.append, false);
  assert.equal(p.reason, 'already_recorded');
});

test('二重クリック / 並行 2 要求は 1 本だけが書く（墓標を取れた方）', () => {
  const r = rec();
  // 2 本とも「行が無い」を読む。勝者だけが append する
  const winner = H.planHistoryAppend({ record: r, existing: [], env: ON, lock: 'acquired' });
  const loser = H.planHistoryAppend({ record: r, existing: [], env: ON, lock: 'lost' });
  assert.equal(winner.append, true);
  assert.equal(loser.append, false);
  assert.equal(loser.reason, 'concurrent_writer');
});

test('Redis が使えないときは積まない（fail closed・状態は巻き戻さない）', () => {
  const p = H.planHistoryAppend({ record: rec(), existing: [], env: ON, lock: 'unavailable' });
  assert.equal(p.append, false);
  assert.equal(p.reason, 'lock_unavailable');
});

test('墓標は TTL 付き（落ちた 1 回の履歴が永遠に欠けない）', () => {
  assert.match(H.historyMarkKey('abc'), /^ak:coupon-history:mark:abc$/);
  assert.ok(H.HISTORY_MARK_TTL_SEC >= 60, 'TTL が短すぎる');
  assert.ok(Number.isFinite(H.HISTORY_MARK_TTL_SEC), 'TTL 無し（永久墓標）にしている');
});

// ── 別操作 / 別会員 / 別商品は別キー ─────────────────────────
test('別の操作・別の会員・別の商品は別の OperationId', () => {
  const grant = opId();
  const correct = opId({ operationType: COUPON_OPERATION.CORRECT, anchor: 'claim:2026-08-20T12:00:00.000Z' });
  const reissue = opId({ operationType: COUPON_OPERATION.REISSUE, anchor: 'prev:2026-08-20T12:00:00.000Z' });
  const other = opId({ customerRecordId: 'recB' });
  const otherProduct = opId({ productKey: PRODUCT_KEY.PREMIUM_MONTHLY });
  const otherVersion = opId({ version: 2 });
  const all = [grant, correct, reissue, other, otherProduct, otherVersion];
  assert.equal(new Set(all).size, all.length, '別の操作が同じ冪等キーになっている');
});

test('材料が欠けたら冪等キーを作らない（作れないまま書かせない）', () => {
  assert.equal(opId({ customerRecordId: '' }), null);
  assert.equal(opId({ couponId: '' }), null);
  assert.equal(opId({ operationType: '' }), null);
  assert.equal(rec({ operationId: null }), null);
});

// ── 部分成功の回復（state 成功 / history 失敗）────────────────
test('state 成功 / history 失敗 を op= から検出し、history-only で 1 件へ収束する', () => {
  // 状態変更のときに監査へ残した op=
  const audit = P.parseCouponAudit(P.encodeCouponAudit({
    kind: 'admin-grant', actor: 'MK', atIso: '2026-08-20T12:00:00.000Z',
    reason: 'お電話でのご依頼', operationId: opId(),
  }));
  assert.equal(audit.operationId, opId(), 'op= が監査に残っていない');

  // 履歴は 0 件 → 未記録として検出される
  const targets = H.findHistoryRepairTargets({
    audits: [{ customerRecordId: 'recA', audit }], rows: [],
  });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].operationId, opId());

  // repair の 1 行は**同じ OperationId**・当時の実行者と時刻で作る
  const repaired = H.buildRepairRecord({ ...BASE, audit });
  assert.equal(repaired.operationId, opId());
  assert.equal(repaired.fields.OperationType, 'grant');
  assert.equal(repaired.fields.Actor, 'MK');
  assert.equal(repaired.fields.OccurredAt, '2026-08-20T12:00:00.000Z', '履歴の時刻を今にしている');
  assert.equal(H.planHistoryAppend({ record: repaired, existing: [], env: ON }).append, true);

  // 積んだ後は検出されない = repair 再実行でも 1 件のまま
  const after = [row(repaired.operationId)];
  assert.equal(H.findHistoryRepairTargets({
    audits: [{ customerRecordId: 'recA', audit }], rows: after,
  }).length, 0);
  assert.equal(H.planHistoryAppend({ record: repaired, existing: after, env: ON }).append, false);
});

test('op= が無い古い監査は repair 対象にしない（推測で積まない）', () => {
  const audit = P.parseCouponAudit('pause-notice');
  assert.equal(H.findHistoryRepairTargets({
    audits: [{ customerRecordId: 'recA', audit }], rows: [],
  }).length, 0);
  assert.equal(H.buildRepairRecord({ ...BASE, audit }), null);
});

// ── 形と安全性 ──────────────────────────────────────────────
test('商品・会員・クーポン・操作を識別できる', () => {
  const r = rec();
  assert.equal(r.fields.ProductKey, PRODUCT_KEY.PREMIUM_PLUS);
  assert.equal(r.fields.CustomerRecordId, 'recA');
  assert.equal(r.fields.CouponId, 'premium-plus-reopen-priority');
  assert.equal(r.fields.CouponVersion, 1);
  assert.equal(r.fields.OperationType, COUPON_OPERATION.GRANT);
  assert.equal(r.fields.Actor, 'MK');
  assert.equal(r.fields.BeforeState, 'none');
  assert.equal(r.fields.AfterState, 'held');
  assert.ok(r.fields.OccurredAt);
});

test('アドレス・課金・権限の列を持たない（PII を重複保存しない）', () => {
  const keys = Object.keys(rec().fields);
  assert.equal(H.COUPON_HISTORY_FIELDS.length, 12, '列数が 12 でない');
  assert.ok(!keys.includes('Email'), '履歴にアドレスを保存している');
  assert.ok(H.COUPON_HISTORY_FORBIDDEN_FIELDS.includes('Email'));
  for (const k of keys) assert.ok(H.COUPON_HISTORY_FIELDS.includes(k), k);
  for (const bad of H.COUPON_HISTORY_FORBIDDEN_FIELDS) assert.ok(!keys.includes(bad), bad);
  assert.equal(H.assertOnlyHistoryFields({ プラン: 'Premium' }), false);
  assert.equal(H.assertOnlyHistoryFields({}), false);
});

test('会員 1 人ぶんだけを新しい順に取り出す（他会員は混ざらない）', () => {
  const r = (id, cust, at) => ({ id, fields: { CustomerRecordId: cust, OccurredAt: at } });
  const got = H.listHistoryForCustomer({
    rows: [r('a', 'recA', '2026-08-01T00:00:00Z'), r('x', 'recB', '2026-08-05T00:00:00Z'), r('b', 'recA', '2026-08-10T00:00:00Z')],
    customerRecordId: 'recA',
  });
  assert.deepEqual(got.map((x) => x.id), ['b', 'a']);
});

test('テーブル名は商品に依存しない', () => {
  assert.equal(H.COUPON_HISTORY_TABLE, 'CouponOperationHistory');
  assert.doesNotMatch(H.COUPON_HISTORY_TABLE, /premium|plus/i, '商品名がテーブル名に入っている');
});
