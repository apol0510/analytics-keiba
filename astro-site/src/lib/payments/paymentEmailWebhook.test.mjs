/**
 * paymentEmailWebhook.test.mjs — S9 本体（配信結果の状態反映）のユニットテスト。
 * 実 IO はせず fake deps を渡す。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPaymentEmailEvent,
  applyPaymentEmailEvents,
  isPaymentEmailEvent,
  PAYMENT_EMAIL_PURPOSE,
} from './paymentEmailWebhook.js';
import { decideWebhookTransition, EMAIL_STATUS } from './paymentEmailState.js';

const T0 = Date.parse('2026-07-23T00:00:00.000Z');
const REC = 'recTESTTESTTEST01';
const KEY = 'a'.repeat(32);

/** fake Airtable deps。patch 呼び出しを記録する。 */
function makeDeps(fields, opts = {}) {
  const patches = [];
  return {
    patches,
    getRecord: async (id) => {
      if (opts.notFound) return null;
      if (opts.throwOnGet) throw new Error('boom');
      return { id, fields };
    },
    patchRecord: async (id, f) => {
      if (opts.throwOnPatch) throw new Error('boom');
      patches.push({ id, fields: f });
      return {};
    },
  };
}

const ev = (over = {}) => ({
  event: 'delivered',
  purpose: PAYMENT_EMAIL_PURPOSE,
  record_id: REC,
  idempotency_key: KEY,
  ...over,
});

// ── 対象判定 ────────────────────────────────────────────────
test('purpose 一致のイベントだけを対象にする（メルマガ等は対象外）', () => {
  assert.equal(isPaymentEmailEvent(ev()), true);
  assert.equal(isPaymentEmailEvent({ event: 'bounce', email: 'x@example.test' }), false);
  assert.equal(isPaymentEmailEvent({ event: 'bounce', purpose: 'newsletter' }), false);
  assert.equal(isPaymentEmailEvent(null), false);
  assert.equal(isPaymentEmailEvent('bounce'), false);
});

// ── 状態遷移（純粋関数）────────────────────────────────────
test('accepted からは delivered / bounced / dropped へ遷移する', () => {
  for (const [event, status] of [
    ['delivered', EMAIL_STATUS.DELIVERED],
    ['bounce', EMAIL_STATUS.BOUNCED],
    ['dropped', EMAIL_STATUS.DROPPED],
  ]) {
    const d = decideWebhookTransition({ currentStatus: EMAIL_STATUS.ACCEPTED, event, now: T0 });
    assert.equal(d.apply, true, `${event} が適用されない`);
    assert.equal(d.status, status);
  }
});

test('delivered のときは DeliveredAt を書く', () => {
  const d = decideWebhookTransition({ currentStatus: EMAIL_STATUS.ACCEPTED, event: 'delivered', now: T0 });
  assert.equal(d.fields.PaymentEmailDeliveredAt, new Date(T0).toISOString());
});

test('unknown_after_attempt からも遷移できる（reconciler 未処理でも配信結果は確定できる）', () => {
  const d = decideWebhookTransition({ currentStatus: EMAIL_STATUS.UNKNOWN_AFTER_ATTEMPT, event: 'delivered', now: T0 });
  assert.equal(d.apply, true);
});

test('失敗終端（bounced / dropped）は吸収状態＝それ以上動かさない', () => {
  for (const current of [EMAIL_STATUS.BOUNCED, EMAIL_STATUS.DROPPED]) {
    for (const event of ['delivered', 'bounce', 'dropped']) {
      const d = decideWebhookTransition({ currentStatus: current, event, now: T0 });
      assert.equal(d.apply, false, `${current} が ${event} で動いた`);
      assert.equal(d.reason, 'failure_terminal_locked');
    }
  }
});

test('delivered の重複は no-op / 失敗は delivered を上書きする', () => {
  const dup = decideWebhookTransition({ currentStatus: EMAIL_STATUS.DELIVERED, event: 'delivered', now: T0 });
  assert.equal(dup.apply, false);
  assert.equal(dup.reason, 'already_delivered');

  const over = decideWebhookTransition({ currentStatus: EMAIL_STATUS.DELIVERED, event: 'bounce', now: T0 });
  assert.equal(over.apply, true);
  assert.equal(over.status, EMAIL_STATUS.BOUNCED);
});

test('順序が入れ替わっても最終状態は同じ（delivered と bounce の収束）', () => {
  // 1) delivered → bounce
  let s = EMAIL_STATUS.ACCEPTED;
  for (const e of ['delivered', 'bounce']) {
    const d = decideWebhookTransition({ currentStatus: s, event: e, now: T0 });
    if (d.apply) s = d.status;
  }
  assert.equal(s, EMAIL_STATUS.BOUNCED);

  // 2) bounce → delivered（逆順）
  let t = EMAIL_STATUS.ACCEPTED;
  for (const e of ['bounce', 'delivered']) {
    const d = decideWebhookTransition({ currentStatus: t, event: e, now: T0 });
    if (d.apply) t = d.status;
  }
  assert.equal(t, EMAIL_STATUS.BOUNCED, '順序で最終状態が変わっている');
});

test('送信途中 / 人手案件の状態は webhook から上書きしない（fail closed）', () => {
  for (const current of [
    EMAIL_STATUS.PENDING,
    EMAIL_STATUS.ATTEMPTING_PRE_SEND,
    EMAIL_STATUS.FAILED_RETRYABLE,
    EMAIL_STATUS.FAILED_TERMINAL,
    EMAIL_STATUS.NEEDS_ADMIN,
    '',
    undefined,
  ]) {
    const d = decideWebhookTransition({ currentStatus: current, event: 'delivered', now: T0 });
    assert.equal(d.apply, false, `${current} が上書きされた`);
    assert.ok(d.reason.startsWith('unexpected_state:'), `reason=${d.reason}`);
  }
});

test('対象外イベント（deferred / open / click）は無視する', () => {
  for (const event of ['deferred', 'open', 'click', 'processed', 'spamreport', 'unsubscribe']) {
    const d = decideWebhookTransition({ currentStatus: EMAIL_STATUS.ACCEPTED, event, now: T0 });
    assert.equal(d.apply, false, `${event} が適用された`);
    assert.equal(d.reason, 'event_ignored');
  }
});

// ── IO を伴う適用 ──────────────────────────────────────────
test('accepted のレコードへ delivered を反映する', async () => {
  const deps = makeDeps({ PaymentEmailStatus: EMAIL_STATUS.ACCEPTED, PaymentEmailIdempotencyKey: KEY });
  const r = await applyPaymentEmailEvent({ event: ev(), now: T0, deps });
  assert.equal(r.applied, true);
  assert.equal(deps.patches.length, 1);
  assert.equal(deps.patches[0].id, REC);
  assert.equal(deps.patches[0].fields.PaymentEmailStatus, EMAIL_STATUS.DELIVERED);
});

test('冪等キー不一致は 1 バイトも書かない（再採番後の古いイベントで上書きしない）', async () => {
  const deps = makeDeps({ PaymentEmailStatus: EMAIL_STATUS.ACCEPTED, PaymentEmailIdempotencyKey: 'b'.repeat(32) });
  const r = await applyPaymentEmailEvent({ event: ev(), now: T0, deps });
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'idempotency_key_mismatch');
  assert.equal(deps.patches.length, 0);
});

test('レコード側の冪等キーが空なら書かない（旧世界のレコードを触らない）', async () => {
  const deps = makeDeps({ PaymentEmailStatus: EMAIL_STATUS.ACCEPTED, PaymentEmailIdempotencyKey: '' });
  const r = await applyPaymentEmailEvent({ event: ev(), now: T0, deps });
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'idempotency_key_mismatch');
  assert.equal(deps.patches.length, 0);
});

test('識別子が欠けたイベントは getRecord すら呼ばない', async () => {
  let called = false;
  const deps = { getRecord: async () => { called = true; return null; }, patchRecord: async () => {} };
  for (const bad of [ev({ record_id: '' }), ev({ idempotency_key: '' }), ev({ record_id: 42 })]) {
    const r = await applyPaymentEmailEvent({ event: bad, now: T0, deps });
    assert.equal(r.applied, false);
    assert.equal(r.reason, 'missing_identifiers');
  }
  assert.equal(called, false);
});

test('レコードが見つからない場合は書かない', async () => {
  const deps = makeDeps({}, { notFound: true });
  const r = await applyPaymentEmailEvent({ event: ev(), now: T0, deps });
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'record_not_found');
  assert.equal(deps.patches.length, 0);
});

test('purpose 不一致は Payment Email 経路に入らない', async () => {
  const deps = makeDeps({ PaymentEmailStatus: EMAIL_STATUS.ACCEPTED, PaymentEmailIdempotencyKey: KEY });
  const r = await applyPaymentEmailEvent({ event: ev({ purpose: 'newsletter' }), now: T0, deps });
  assert.equal(r.applied, false);
  assert.equal(r.reason, 'not_payment_email');
  assert.equal(deps.patches.length, 0);
});

// ── バッチ ────────────────────────────────────────────────
test('バッチ: 対象外を混ぜても件数集計が正しく、1 件失敗で残件を止めない', async () => {
  const deps = makeDeps({ PaymentEmailStatus: EMAIL_STATUS.ACCEPTED, PaymentEmailIdempotencyKey: KEY });
  const events = [
    { event: 'bounce', email: 'x@example.test' },              // suppression 側のみ（対象外）
    ev({ event: 'deferred' }),                                  // 対象だが無視される
    ev(),                                                       // 適用される
    ev({ idempotency_key: 'c'.repeat(32) }),                    // 不一致でスキップ
  ];
  const s = await applyPaymentEmailEvents({ events, now: T0, deps });
  assert.equal(s.targeted, 3);
  assert.equal(s.applied, 1);
  assert.equal(s.skipped, 2);
  assert.equal(s.errors, 0);
  assert.equal(s.byReason.event_ignored, 1);
  assert.equal(s.byReason.idempotency_key_mismatch, 1);
});

test('バッチ: 例外は件数に計上して残件を継続する', async () => {
  const deps = makeDeps({ PaymentEmailStatus: EMAIL_STATUS.ACCEPTED, PaymentEmailIdempotencyKey: KEY }, { throwOnPatch: true });
  const s = await applyPaymentEmailEvents({ events: [ev(), ev()], now: T0, deps });
  assert.equal(s.targeted, 2);
  assert.equal(s.applied, 0);
  assert.equal(s.errors, 2);
});

test('バッチ: events が配列でなくても落ちない', async () => {
  const deps = makeDeps({});
  const s = await applyPaymentEmailEvents({ events: null, now: T0, deps });
  assert.equal(s.targeted, 0);
  assert.equal(s.applied, 0);
});

test('集計結果に識別子（recordId / メール / キー）を含めない', async () => {
  const deps = makeDeps({ PaymentEmailStatus: EMAIL_STATUS.ACCEPTED, PaymentEmailIdempotencyKey: KEY });
  const s = await applyPaymentEmailEvents({ events: [ev({ email: 'x@example.test' })], now: T0, deps });
  const dump = JSON.stringify(s);
  assert.ok(!dump.includes(REC), '集計に recordId が含まれている');
  assert.ok(!dump.includes(KEY), '集計に冪等キーが含まれている');
  assert.ok(!dump.includes('example.test'), '集計にメールアドレスが含まれている');
});
