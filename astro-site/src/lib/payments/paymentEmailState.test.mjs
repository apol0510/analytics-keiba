/**
 * paymentEmailState.test.mjs — v2 状態機械の純粋関数テスト。
 * `npm run test:bank-payment`（check:safety 組込）で実行される。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMAIL_STATUS, FAILURE_STAGE, RESENDABLE_STATUSES, NO_AUTO_RESEND_STATUSES,
  MAX_ATTEMPTS, LEASE_MS, FIRST_QUERY_DELAY_MS, RECONCILE_ZERO_MIN_WAIT_MS,
  ESCALATE_MS, ACTIVITY_HORIZON_MS,
  idempotencyKeyInput, computeIdempotencyKey, buildPendingEmailFields,
  decideLeaseAcquire, buildWriteAheadFields, evaluateMailOutcome, decideAfterProvider,
  classifyActivityResult, decideReconcile, decideWebhookEvent,
  parseBoolEnv, parseGatesFromEnv, validateEmailGates, shouldConfirmUseV2,
} from './paymentEmailState.js';

const T0 = Date.UTC(2026, 6, 16, 0, 0, 0); // 2026-07-16T00:00:00Z（固定・Date.now 不使用）

// ── 冪等キー ─────────────────────────────────────────
test('冪等キーは決定論的（同じ入力 → 同じ 32hex）', () => {
  const a = computeIdempotencyKey('recABC', '2026-07-14T04:00:00.000Z');
  const b = computeIdempotencyKey('recABC', '2026-07-14T04:00:00.000Z');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{32}$/);
});

test('冪等キーは recordId / PaidAt が違えば変わる', () => {
  const base = computeIdempotencyKey('recABC', '2026-07-14T04:00:00.000Z');
  assert.notEqual(base, computeIdempotencyKey('recXYZ', '2026-07-14T04:00:00.000Z'));
  assert.notEqual(base, computeIdempotencyKey('recABC', '2026-07-14T05:00:00.000Z'));
});

test('idempotencyKeyInput は保存前でも再構成できる決定論的文字列', () => {
  assert.equal(idempotencyKeyInput('rec1', '2026-07-14T04:00:00.000Z'), 'rec1|2026-07-14T04:00:00.000Z');
});

// ── buildPendingEmailFields ──────────────────────────
test('confirm(v2) は pending + idempotencyKey + count=0 を同梱し、PaymentEmailSent は書かない', () => {
  const f = buildPendingEmailFields({ recordId: 'recABC', paidAtIso: '2026-07-14T04:00:00.000Z' });
  assert.equal(f.PaymentEmailStatus, EMAIL_STATUS.PENDING);
  assert.match(f.PaymentEmailIdempotencyKey, /^[0-9a-f]{32}$/);
  assert.equal(f.PaymentEmailAttemptCount, 0);
  assert.equal('PaymentEmailSent' in f, false); // legacy と違い立てない
});

test('buildPendingEmailFields は必須欠如で throw（fail closed）', () => {
  assert.throws(() => buildPendingEmailFields({ recordId: '', paidAtIso: 'x' }));
  assert.throws(() => buildPendingEmailFields({ recordId: 'r', paidAtIso: '' }));
});

// ── decideLeaseAcquire ───────────────────────────────
test('lease: pending は取得可（attempting_pre_send + lease + token + count+1）', () => {
  const r = decideLeaseAcquire({ status: EMAIL_STATUS.PENDING, attemptCount: 0, leaseUntilMs: null, now: T0, token: 'tok1' });
  assert.equal(r.granted, true);
  assert.equal(r.fields.PaymentEmailStatus, EMAIL_STATUS.ATTEMPTING_PRE_SEND);
  assert.equal(r.fields.PaymentEmailAttemptCount, 1);
  assert.equal(r.fields.PaymentEmailAttemptToken, 'tok1');
  assert.equal(r.fields.PaymentEmailLeaseUntil, new Date(T0 + LEASE_MS).toISOString());
});

test('lease: failed_retryable も取得可', () => {
  assert.equal(decideLeaseAcquire({ status: EMAIL_STATUS.FAILED_RETRYABLE, now: T0, token: 't' }).granted, true);
});

test('lease: unknown_after_attempt は絶対に取得不可（reconciler 経由のみ）', () => {
  const r = decideLeaseAcquire({ status: EMAIL_STATUS.UNKNOWN_AFTER_ATTEMPT, now: T0, token: 't' });
  assert.equal(r.granted, false);
  assert.match(r.reason, /ineligible_state/);
});

test('lease: 有効な lease を他者が保持中は取得不可', () => {
  const r = decideLeaseAcquire({ status: EMAIL_STATUS.PENDING, leaseUntilMs: T0 + 10_000, now: T0, token: 't' });
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'lease_held');
});

test('lease: attempting_pre_send は lease 失効時のみ再取得可（POST 前に落ちた stale）', () => {
  assert.equal(decideLeaseAcquire({ status: EMAIL_STATUS.ATTEMPTING_PRE_SEND, leaseUntilMs: T0 - 1, now: T0, token: 't' }).granted, true);
  assert.equal(decideLeaseAcquire({ status: EMAIL_STATUS.ATTEMPTING_PRE_SEND, leaseUntilMs: T0 + 1, now: T0, token: 't' }).granted, false);
});

test('lease: attempt 上限で取得不可', () => {
  const r = decideLeaseAcquire({ status: EMAIL_STATUS.PENDING, attemptCount: MAX_ATTEMPTS, now: T0, token: 't' });
  assert.equal(r.granted, false);
  assert.equal(r.reason, 'attempt_exhausted');
});

test('lease: token 欠如 / 不正な now は取得不可', () => {
  assert.equal(decideLeaseAcquire({ status: EMAIL_STATUS.PENDING, now: T0, token: '' }).granted, false);
  assert.equal(decideLeaseAcquire({ status: EMAIL_STATUS.PENDING, now: NaN, token: 't' }).granted, false);
});

test('write-ahead は unknown_after_attempt を書く', () => {
  assert.equal(buildWriteAheadFields().PaymentEmailStatus, EMAIL_STATUS.UNKNOWN_AFTER_ATTEMPT);
});

// ── evaluateMailOutcome（fail closed）─────────────────
test('provider: 2xx の端（200/299）は受理、300/199 は非受理', () => {
  for (const s of [200, 202, 299]) assert.equal(evaluateMailOutcome({ hasApiKey: true, hasEmail: true, providerStatus: s }).providerAccepted, true, `status ${s}`);
  for (const s of [199, 300, 400, 500]) assert.equal(evaluateMailOutcome({ hasApiKey: true, hasEmail: true, providerStatus: s }).providerAccepted, false, `status ${s}`);
});

test('provider: null / 非整数 / 文字列"202" は非受理（fail closed）', () => {
  for (const s of [null, undefined, NaN, '202', 2.5]) {
    assert.equal(evaluateMailOutcome({ hasApiKey: true, hasEmail: true, providerStatus: s }).providerAccepted, false);
  }
});

test('provider: api key / email 欠如は試行せず terminal 段階', () => {
  assert.equal(evaluateMailOutcome({ hasApiKey: false, hasEmail: true }).failureStage, FAILURE_STAGE.NO_API_KEY);
  assert.equal(evaluateMailOutcome({ hasApiKey: true, hasEmail: false }).failureStage, FAILURE_STAGE.NO_EMAIL);
});

test('provider: 429/5xx は retryable、その他 4xx は rejected、例外は exception', () => {
  assert.equal(evaluateMailOutcome({ hasApiKey: true, hasEmail: true, providerStatus: 429 }).failureStage, FAILURE_STAGE.PROVIDER_5XX);
  assert.equal(evaluateMailOutcome({ hasApiKey: true, hasEmail: true, providerStatus: 503 }).failureStage, FAILURE_STAGE.PROVIDER_5XX);
  assert.equal(evaluateMailOutcome({ hasApiKey: true, hasEmail: true, providerStatus: 401 }).failureStage, FAILURE_STAGE.PROVIDER_REJECTED);
  assert.equal(evaluateMailOutcome({ hasApiKey: true, hasEmail: true, threw: true }).failureStage, FAILURE_STAGE.PROVIDER_EXCEPTION);
});

// ── decideAfterProvider ──────────────────────────────
test('after provider 2xx → accepted + PaymentEmailSent=true + msgId', () => {
  const outcome = evaluateMailOutcome({ hasApiKey: true, hasEmail: true, providerStatus: 202 });
  const r = decideAfterProvider({ outcome, now: T0, providerMessageId: 'MID123' });
  assert.equal(r.status, EMAIL_STATUS.ACCEPTED);
  assert.equal(r.fields.PaymentEmailSent, true);
  assert.equal(r.fields.PaymentEmailProviderMessageId, 'MID123');
  assert.equal(r.fields.PaymentEmailAcceptedAt, new Date(T0).toISOString());
});

test('after provider 5xx → failed_retryable（PaymentEmailSent は書かない）', () => {
  const outcome = evaluateMailOutcome({ hasApiKey: true, hasEmail: true, providerStatus: 503 });
  const r = decideAfterProvider({ outcome, now: T0 });
  assert.equal(r.status, EMAIL_STATUS.FAILED_RETRYABLE);
  assert.equal('PaymentEmailSent' in r.fields, false);
});

test('after provider 送信例外 → failed_retryable（一時的エラーは再試行可）', () => {
  const outcome = evaluateMailOutcome({ hasApiKey: true, hasEmail: true, threw: true });
  const r = decideAfterProvider({ outcome, now: T0 });
  assert.equal(r.status, EMAIL_STATUS.FAILED_RETRYABLE);
  assert.equal('PaymentEmailSent' in r.fields, false);
});

test('after provider 4xx / no_key → failed_terminal', () => {
  const t1 = decideAfterProvider({ outcome: evaluateMailOutcome({ hasApiKey: true, hasEmail: true, providerStatus: 403 }), now: T0 });
  assert.equal(t1.status, EMAIL_STATUS.FAILED_TERMINAL);
  const t2 = decideAfterProvider({ outcome: evaluateMailOutcome({ hasApiKey: false, hasEmail: true }), now: T0 });
  assert.equal(t2.status, EMAIL_STATUS.FAILED_TERMINAL);
  assert.equal(t2.fields.PaymentEmailFailureStage, FAILURE_STAGE.NO_API_KEY);
});

// ── classifyActivityResult（0件の定義）────────────────
test('activity: HTTP200 かつ [] だけが zero。非200 は unknown（0件に数えない）', () => {
  assert.equal(classifyActivityResult({ httpStatus: 200, messages: [] }), 'zero');
  assert.equal(classifyActivityResult({ httpStatus: 200, messages: [{}] }), 'hit_one');
  assert.equal(classifyActivityResult({ httpStatus: 200, messages: [{}, {}] }), 'hit_many');
  for (const s of [400, 429, 500, 503]) assert.equal(classifyActivityResult({ httpStatus: s, messages: [] }), 'unknown', `http ${s}`);
  assert.equal(classifyActivityResult({ httpStatus: 200, messages: null }), 'unknown'); // parse err 相当
});

// ── decideReconcile ──────────────────────────────────
test('reconcile: 1件ヒット → accept（受理事実を永続化・不変条件3）', () => {
  const r = decideReconcile({ activity: 'hit_one', attemptedAtMs: T0, attemptCount: 1, now: T0 + FIRST_QUERY_DELAY_MS + 1, providerMessageId: 'MID' });
  assert.equal(r.action, 'accept');
  assert.equal(r.fields.PaymentEmailStatus, EMAIL_STATUS.ACCEPTED);
  assert.equal(r.fields.PaymentEmailSent, true);
  assert.equal(r.fields.PaymentEmailProviderMessageId, 'MID');
});

test('reconcile: 複数件ヒット → 自動再送せず needs_admin', () => {
  const r = decideReconcile({ activity: 'hit_many', attemptedAtMs: T0, attemptCount: 1, now: T0 + 10 * 60_000 });
  assert.equal(r.action, 'escalate');
  assert.equal(r.fields.PaymentEmailStatus, EMAIL_STATUS.NEEDS_ADMIN);
  assert.equal(r.fields.PaymentEmailFailureStage, FAILURE_STAGE.ACTIVITY_AMBIGUOUS);
});

test('reconcile: 0件でも 60秒未満は wait（早すぎ）', () => {
  assert.equal(decideReconcile({ activity: 'zero', attemptedAtMs: T0, attemptCount: 1, now: T0 + 30_000 }).action, 'wait');
});

test('reconcile: 0件が 30分未満は wait（不変条件: 反映遅延で再送しない）', () => {
  const r = decideReconcile({ activity: 'zero', attemptedAtMs: T0, attemptCount: 1, now: T0 + 10 * 60_000 });
  assert.equal(r.action, 'wait');
  assert.equal(r.reason, 'within_min_wait');
});

test('reconcile: 0件が 30分以上継続 && attempt<3 → resend（pending へ）', () => {
  const r = decideReconcile({ activity: 'zero', attemptedAtMs: T0, attemptCount: 1, now: T0 + RECONCILE_ZERO_MIN_WAIT_MS + 1 });
  assert.equal(r.action, 'resend');
  assert.equal(r.fields.PaymentEmailStatus, EMAIL_STATUS.PENDING);
  assert.equal(r.fields.PaymentEmailLeaseUntil, null);
});

test('reconcile: 0件×30分でも attempt 枯渇なら escalate（再送しない）', () => {
  const r = decideReconcile({ activity: 'zero', attemptedAtMs: T0, attemptCount: MAX_ATTEMPTS, now: T0 + RECONCILE_ZERO_MIN_WAIT_MS + 1 });
  assert.equal(r.action, 'escalate');
  assert.equal(r.reason, 'attempt_exhausted');
});

test('reconcile: 24h 超で escalate、72h 超で activity_horizon', () => {
  const a = decideReconcile({ activity: 'zero', attemptedAtMs: T0, attemptCount: 1, now: T0 + ESCALATE_MS + 1 });
  assert.equal(a.action, 'escalate');
  assert.equal(a.reason, 'escalate_timeout');
  const b = decideReconcile({ activity: 'zero', attemptedAtMs: T0, attemptCount: 1, now: T0 + ACTIVITY_HORIZON_MS + 1 });
  assert.equal(b.action, 'escalate');
  assert.equal(b.reason, 'activity_horizon_exceeded');
  assert.equal(b.fields.PaymentEmailFailureStage, FAILURE_STAGE.ACTIVITY_HORIZON);
});

test('reconcile: unknown(API不明) は 0件扱いせず wait。24h 超なら escalate', () => {
  assert.equal(decideReconcile({ activity: 'unknown', attemptedAtMs: T0, attemptCount: 1, now: T0 + 60 * 60_000 }).action, 'wait');
  assert.equal(decideReconcile({ activity: 'unknown', attemptedAtMs: T0, attemptCount: 1, now: T0 + ESCALATE_MS + 1 }).action, 'escalate');
});

// ── Event Webhook ────────────────────────────────────
test('webhook: delivered/bounce/dropped は状態遷移、deferred は無視', () => {
  assert.equal(decideWebhookEvent({ event: 'delivered', now: T0 }).fields.PaymentEmailStatus, EMAIL_STATUS.DELIVERED);
  assert.equal(decideWebhookEvent({ event: 'delivered', now: T0 }).fields.PaymentEmailDeliveredAt, new Date(T0).toISOString());
  assert.equal(decideWebhookEvent({ event: 'bounce', now: T0 }).fields.PaymentEmailStatus, EMAIL_STATUS.BOUNCED);
  assert.equal(decideWebhookEvent({ event: 'dropped', now: T0 }).fields.PaymentEmailStatus, EMAIL_STATUS.DROPPED);
  assert.equal(decideWebhookEvent({ event: 'deferred', now: T0 }).status, null);
  assert.equal(decideWebhookEvent({ event: 'open', now: T0 }).status, null);
});

// ── gate 検証（fail closed）──────────────────────────
test('gate: cutover の各モード（legacy → v2-dry-run → v2-worker → v2-full）', () => {
  assert.equal(validateEmailGates({ flow: 'legacy', workerSend: false, reconcilerWrite: false, globalPause: false }).mode, 'legacy');
  assert.equal(validateEmailGates({ flow: 'v2', workerSend: false, reconcilerWrite: false, globalPause: true, a2DisabledConfirmed: true }).mode, 'paused');
  assert.equal(validateEmailGates({ flow: 'v2', workerSend: false, reconcilerWrite: false, globalPause: false, a2DisabledConfirmed: true }).mode, 'v2-dry-run');
  assert.equal(validateEmailGates({ flow: 'v2', workerSend: true, reconcilerWrite: false, globalPause: false, a2DisabledConfirmed: true }).mode, 'v2-worker'); // S7
  assert.equal(validateEmailGates({ flow: 'v2', workerSend: true, reconcilerWrite: true, globalPause: false, a2DisabledConfirmed: true }).mode, 'v2-full');   // S8
});

test('gate: reconciler だけ ON で worker OFF は禁止（resend が滞留する）', () => {
  const r = validateEmailGates({ flow: 'v2', workerSend: false, reconcilerWrite: true, a2DisabledConfirmed: true });
  assert.equal(r.ok, false);
  assert.equal(r.violations.includes('reconciler_needs_worker'), true);
});

test('shouldConfirmUseV2: worker が送れるモードだけ true（dry-run/legacy/不正は false）', () => {
  const A2 = { a2DisabledConfirmed: true };
  assert.equal(shouldConfirmUseV2({ flow: 'legacy' }), false);
  assert.equal(shouldConfirmUseV2({ flow: 'v2', workerSend: false, ...A2 }), false); // dry-run は inline 送信(legacy)
  assert.equal(shouldConfirmUseV2({ flow: 'v2', workerSend: true, ...A2 }), true);    // v2-worker
  assert.equal(shouldConfirmUseV2({ flow: 'v2', workerSend: true, reconcilerWrite: true, ...A2 }), true); // v2-full
  assert.equal(shouldConfirmUseV2({ flow: 'v2', workerSend: true }), false); // a2 未宣言 → 不正 → fail closed
});

test('gate: 禁止構成はすべて invalid（fail closed）', () => {
  // 二重送信の本体: v2 なのに A2 OFF が宣言されていない
  assert.equal(validateEmailGates({ flow: 'v2', workerSend: true, reconcilerWrite: true, a2DisabledConfirmed: false }).ok, false);
  // legacy で worker が送る
  assert.equal(validateEmailGates({ flow: 'legacy', workerSend: true }).ok, false);
  // worker は v2 必須
  assert.equal(validateEmailGates({ flow: 'legacy', workerSend: true, a2DisabledConfirmed: true }).violations.includes('worker_requires_v2'), true);
  // reconciler は v2 必須
  assert.equal(validateEmailGates({ flow: 'legacy', reconcilerWrite: true }).ok, false);
  // pause なのに worker/reconciler が動く
  assert.equal(validateEmailGates({ flow: 'v2', globalPause: true, workerSend: true, a2DisabledConfirmed: true }).ok, false);
  assert.equal(validateEmailGates({ flow: 'v2', globalPause: true, reconcilerWrite: true, a2DisabledConfirmed: true }).ok, false);
});

test('gate: v2 は a2DisabledConfirmed 必須（dry-run でも）', () => {
  const r = validateEmailGates({ flow: 'v2', workerSend: false, reconcilerWrite: false, a2DisabledConfirmed: false });
  assert.equal(r.ok, false);
  assert.equal(r.violations.includes('v2_requires_a2_disabled'), true);
});

test('env パース: true/1/yes を真、それ以外を偽', () => {
  for (const v of ['true', '1', 'yes', true]) assert.equal(parseBoolEnv(v), true, String(v));
  for (const v of ['false', '0', '', undefined, 'off']) assert.equal(parseBoolEnv(v), false, String(v));
  const g = parseGatesFromEnv({ PAYMENT_EMAIL_FLOW_VERSION: 'v2', PAYMENT_EMAIL_WORKER_SEND_ENABLED: 'true', PAYMENT_EMAIL_A2_DISABLED_CONFIRMED: '1' });
  assert.equal(g.flow, 'v2');
  assert.equal(g.workerSend, true);
  assert.equal(g.a2DisabledConfirmed, true);
  assert.equal(g.reconcilerWrite, false);
});

// ── 状態集合の健全性 ──────────────────────────────────
test('状態集合: resendable と no-auto-resend は交わらない', () => {
  for (const s of RESENDABLE_STATUSES) assert.equal(NO_AUTO_RESEND_STATUSES.includes(s), false, s);
  assert.equal(NO_AUTO_RESEND_STATUSES.includes(EMAIL_STATUS.UNKNOWN_AFTER_ATTEMPT), true);
  assert.equal(NO_AUTO_RESEND_STATUSES.includes(EMAIL_STATUS.ACCEPTED), true);
});
