/**
 * paymentEmailState.js — 入金確認メール v2 の状態機械（純粋関数・単一源）。
 *
 * ランタイム非依存。fetch / Airtable / Date.now に依存しない。
 * 時刻は必ず引数 `now`（ms epoch）で受け取り、IO はしない。
 * 各 decide* は「次に何を書くか / 何をするか」を返すだけで、副作用を持たない。
 *
 * 設計の全体像は docs/PAYMENT_EMAIL_V2.md を参照。核心:
 * - attempting_pre_send（POST 前）と unknown_after_attempt（POST 済みかも）を分離する。
 * - unknown_after_attempt からの無条件自動再送は禁止（reconciler の Activity 照合が先）。
 * - Activity は HTTP 200 かつ messages:[] のときだけ「0 件」。4xx/5xx/timeout/parse err は「不明」。
 * - exactly-once は保証しない（SendGrid に provider 側冪等性が無い）。
 */

import { createHash } from 'node:crypto';

/** メール送信の状態。Airtable `PaymentEmailStatus`（Single select）の選択肢と一致させる。 */
export const EMAIL_STATUS = Object.freeze({
  PENDING: 'pending',
  ATTEMPTING_PRE_SEND: 'attempting_pre_send',
  UNKNOWN_AFTER_ATTEMPT: 'unknown_after_attempt',
  ACCEPTED: 'accepted',
  DELIVERED: 'delivered',
  BOUNCED: 'bounced',
  DROPPED: 'dropped',
  FAILED_RETRYABLE: 'failed_retryable',
  FAILED_TERMINAL: 'failed_terminal',
  NEEDS_ADMIN: 'needs_admin',
});

/** worker が自動的に送信対象として拾ってよい状態。 */
export const RESENDABLE_STATUSES = Object.freeze([
  EMAIL_STATUS.PENDING,
  EMAIL_STATUS.FAILED_RETRYABLE,
]);

/**
 * 自動再送してはいけない状態（終端・要人手）。
 * accepted / delivered は「送信済み」の終端。unknown_after_attempt は「送ったかも」で
 * reconciler の Activity 照合を経ないと再送できないため、ここに含める。
 */
export const NO_AUTO_RESEND_STATUSES = Object.freeze([
  EMAIL_STATUS.UNKNOWN_AFTER_ATTEMPT,
  EMAIL_STATUS.ACCEPTED,
  EMAIL_STATUS.DELIVERED,
  EMAIL_STATUS.BOUNCED,
  EMAIL_STATUS.DROPPED,
  EMAIL_STATUS.FAILED_TERMINAL,
  EMAIL_STATUS.NEEDS_ADMIN,
]);

/** 失敗段階。診断とエスカレーション判断に使う。 */
export const FAILURE_STAGE = Object.freeze({
  NO_API_KEY: 'no_api_key',
  NO_EMAIL: 'no_email',
  PROVIDER_REJECTED: 'provider_rejected', // 4xx（429 を除く）
  PROVIDER_5XX: 'provider_5xx',           // 5xx / 429（再試行可）
  PROVIDER_EXCEPTION: 'provider_exception',
  STATE_WRITE_FAILED: 'state_write_failed',
  ACTIVITY_AMBIGUOUS: 'activity_ambiguous', // 複数件ヒット等
  ACTIVITY_HORIZON: 'activity_horizon',     // 保持期限超過で照合不能
});

// ── チューニング定数（1 回の実測値で短縮しない。docs 参照）──────────────
export const MAX_ATTEMPTS = 3;
export const LEASE_MS = 90_000;                       // 送信処理の最大所要 × 余裕
export const FIRST_QUERY_DELAY_MS = 60_000;           // POST から初回照合まで（実測 52.5s で 0件）
export const RECONCILE_ZERO_MIN_WAIT_MS = 30 * 60_000; // 0 件を再送根拠にできる最短経過
export const ESCALATE_MS = 24 * 60 * 60_000;          // needs_admin へ上げる
export const FINAL_MS = 48 * 60 * 60_000;             // 人手での最終確定期限（運用 SLA）
export const ACTIVITY_HORIZON_MS = 72 * 60 * 60_000;  // これ以降 Activity 照合に依存しない

// ── 冪等キー ────────────────────────────────────────────────────
/**
 * 冪等キーの決定論的な入力文字列。保存前にプロセスが落ちても再構成できることが要件。
 * 本番は recordId と、昇格 PATCH で確定する PaidAt を使う。
 */
export function idempotencyKeyInput(recordId, paidAtIso) {
  return `${recordId}|${paidAtIso}`;
}

/** 冪等キー（sha256 hex 先頭 32）。custom_args / Activity 照合 / 監査で使う主キー。 */
export function computeIdempotencyKey(recordId, paidAtIso) {
  return createHash('sha256')
    .update(idempotencyKeyInput(recordId, paidAtIso))
    .digest('hex')
    .slice(0, 32);
}

// ── confirm(v2) が昇格 PATCH に同梱するメール状態フィールド ────────────
/**
 * v2 の confirm-bank-payment が「昇格 PATCH と同一 PATCH」に載せるフィールド。
 * 昇格成功と送信対象(pending)生成を原子化する（job を別ストアに作らない）。
 * legacy と違い PaymentEmailSent は書かない（worker が accepted 時に書く）。
 * @returns {Record<string, unknown>}
 */
export function buildPendingEmailFields({ recordId, paidAtIso }) {
  if (!recordId || !paidAtIso) {
    throw new Error('buildPendingEmailFields: recordId と paidAtIso は必須');
  }
  return {
    PaymentEmailStatus: EMAIL_STATUS.PENDING,
    PaymentEmailIdempotencyKey: computeIdempotencyKey(recordId, paidAtIso),
    PaymentEmailAttemptCount: 0,
  };
}

// ── worker: lease 取得可否（CAS + fencing token）────────────────────
/**
 * worker が送信ロックを取ってよいか判定する。
 * 対象は pending / failed_retryable / (lease 失効した attempting_pre_send)。
 * unknown_after_attempt はここでは絶対に拾わない（reconciler 経由のみ）。
 *
 * 注意: Airtable に CAS が無いため、これは「取ってよい条件」を返すだけ。実際の排他は
 * Upstash の SET NX + fencing token（呼び出し側）で担保し、それでも exactly-once ではない。
 *
 * @param {object} p
 * @param {string} p.status 現在の PaymentEmailStatus
 * @param {number} p.attemptCount 現在の試行回数
 * @param {number|null} p.leaseUntilMs 現在の lease 期限（ms epoch / null）
 * @param {number} p.now 現在時刻（ms epoch）
 * @param {string} p.token 発行した fencing token（呼び出し側が Redis INCR 等で採番）
 * @returns {{granted: boolean, reason: string, fields?: Record<string, unknown>}}
 */
export function decideLeaseAcquire({ status, attemptCount = 0, leaseUntilMs = null, now, token }) {
  if (!Number.isFinite(now)) return { granted: false, reason: 'invalid_now' };
  if (!token) return { granted: false, reason: 'missing_token' };

  const leaseActive = Number.isFinite(leaseUntilMs) && leaseUntilMs > now;

  const eligibleState =
    status === EMAIL_STATUS.PENDING ||
    status === EMAIL_STATUS.FAILED_RETRYABLE ||
    (status === EMAIL_STATUS.ATTEMPTING_PRE_SEND && !leaseActive); // POST 前に落ちた stale のみ

  if (!eligibleState) return { granted: false, reason: `ineligible_state:${status}` };
  if (attemptCount >= MAX_ATTEMPTS) return { granted: false, reason: 'attempt_exhausted' };
  if (leaseActive) return { granted: false, reason: 'lease_held' };

  return {
    granted: true,
    reason: 'ok',
    fields: {
      PaymentEmailStatus: EMAIL_STATUS.ATTEMPTING_PRE_SEND,
      PaymentEmailAttemptedAt: new Date(now).toISOString(),
      PaymentEmailLeaseUntil: new Date(now + LEASE_MS).toISOString(),
      PaymentEmailAttemptCount: attemptCount + 1,
      PaymentEmailAttemptToken: token,
    },
  };
}

/**
 * write-ahead: POST の直前に書く。以後 status は「送信したかもしれない」を意味する。
 * 呼び出し側はこの PATCH 成功を read-back で確認してから POST する。
 */
export function buildWriteAheadFields() {
  return { PaymentEmailStatus: EMAIL_STATUS.UNKNOWN_AFTER_ATTEMPT };
}

// ── provider 応答の評価（fail closed）────────────────────────────
/**
 * SendGrid Mail Send の結果を provider 非依存に評価する。
 * providerAccepted は「整数 200〜299」のときだけ true（null / 非整数 / '202'文字列は false）。
 * @returns {{providerAttempted: boolean, providerAccepted: boolean, failureStage: string|null}}
 */
export function evaluateMailOutcome({ hasApiKey, hasEmail, providerStatus, threw = false }) {
  if (!hasApiKey) return { providerAttempted: false, providerAccepted: false, failureStage: FAILURE_STAGE.NO_API_KEY };
  if (!hasEmail) return { providerAttempted: false, providerAccepted: false, failureStage: FAILURE_STAGE.NO_EMAIL };
  if (threw) return { providerAttempted: true, providerAccepted: false, failureStage: FAILURE_STAGE.PROVIDER_EXCEPTION };

  const s = providerStatus;
  const is2xx = Number.isInteger(s) && s >= 200 && s <= 299;
  if (is2xx) return { providerAttempted: true, providerAccepted: true, failureStage: null };

  const retryable = s === 429 || (Number.isInteger(s) && s >= 500 && s <= 599);
  return {
    providerAttempted: true,
    providerAccepted: false,
    failureStage: retryable ? FAILURE_STAGE.PROVIDER_5XX : FAILURE_STAGE.PROVIDER_REJECTED,
  };
}

/**
 * provider 応答 → unknown_after_attempt からの次状態と書き込みフィールド。
 * accepted のときだけ PaymentEmailSent=true（互換出力）と ProviderMessageId を書く。
 * @param {object} p
 * @param {ReturnType<typeof evaluateMailOutcome>} p.outcome
 * @param {number} p.now
 * @param {string|null} [p.providerMessageId] 2xx 時の X-Message-Id
 * @param {string|null} [p.lastError] 診断（本文・キーは含めない）
 * @returns {{status: string, fields: Record<string, unknown>}}
 */
export function decideAfterProvider({ outcome, now, providerMessageId = null, lastError = null }) {
  if (outcome.providerAccepted) {
    return {
      status: EMAIL_STATUS.ACCEPTED,
      fields: {
        PaymentEmailStatus: EMAIL_STATUS.ACCEPTED,
        PaymentEmailAcceptedAt: new Date(now).toISOString(),
        PaymentEmailProviderMessageId: providerMessageId || '',
        PaymentEmailFailureStage: '',
        PaymentEmailSent: true, // 互換出力（新ロジックは読まない）
      },
    };
  }

  // 5xx/429 と送信例外（ネットワーク/timeout）は一時的 → 再試行可。
  // 4xx / api key・email 欠如は恒久 → terminal。
  const retryable =
    outcome.failureStage === FAILURE_STAGE.PROVIDER_5XX ||
    outcome.failureStage === FAILURE_STAGE.PROVIDER_EXCEPTION;
  const next = retryable ? EMAIL_STATUS.FAILED_RETRYABLE : EMAIL_STATUS.FAILED_TERMINAL;
  return {
    status: next,
    fields: {
      PaymentEmailStatus: next,
      PaymentEmailFailureStage: outcome.failureStage || '',
      PaymentEmailLastError: lastError || '',
    },
  };
}

// ── reconciler: unknown_after_attempt の Activity 照合 ───────────────
/**
 * Activity 検索の生結果を分類する。**HTTP 200 かつ messages:[] のときだけ 'zero'**。
 * それ以外の HTTP / エラーは 'unknown'（0 件に数えない）。
 * @returns {'hit_one'|'hit_many'|'zero'|'unknown'}
 */
export function classifyActivityResult({ httpStatus, messages }) {
  if (httpStatus !== 200) return 'unknown';
  if (!Array.isArray(messages)) return 'unknown';
  if (messages.length === 0) return 'zero';
  if (messages.length === 1) return 'hit_one';
  return 'hit_many';
}

/**
 * unknown_after_attempt のレコードに対する reconciler の判断。
 * action: 'accept' | 'resend' | 'escalate' | 'wait'
 * - accept  : Activity で 1 件確認 → accepted（受理事実を永続化）
 * - resend  : HTTP200 で 0 件が 30 分以上継続 && attempt<3 → pending へ戻す
 * - escalate: 複数件 / 24h 超 / 72h 超 / attempt 枯渇 → needs_admin
 * - wait    : 早すぎ / API 不明 → 何もしない
 *
 * @param {object} p
 * @param {ReturnType<typeof classifyActivityResult>} p.activity
 * @param {number} p.attemptedAtMs 直近 POST 試行時刻（ms epoch）
 * @param {number} p.attemptCount
 * @param {number} p.now
 * @param {string|null} [p.providerMessageId] hit 時に拾えた msg_id
 * @returns {{action: string, reason: string, fields?: Record<string, unknown>}}
 */
export function decideReconcile({ activity, attemptedAtMs, attemptCount = 0, now, providerMessageId = null }) {
  if (!Number.isFinite(now) || !Number.isFinite(attemptedAtMs)) {
    return { action: 'wait', reason: 'invalid_time' };
  }
  const elapsed = now - attemptedAtMs;

  if (activity === 'hit_one') {
    return {
      action: 'accept',
      reason: 'activity_hit',
      fields: {
        PaymentEmailStatus: EMAIL_STATUS.ACCEPTED,
        PaymentEmailAcceptedAt: new Date(now).toISOString(),
        PaymentEmailProviderMessageId: providerMessageId || '',
        PaymentEmailSent: true,
      },
    };
  }

  if (activity === 'hit_many') {
    // 二重送信の証拠。自動再送せず accepted に確定させたうえで人手へ上げる。
    return {
      action: 'escalate',
      reason: 'activity_ambiguous',
      fields: {
        PaymentEmailStatus: EMAIL_STATUS.NEEDS_ADMIN,
        PaymentEmailFailureStage: FAILURE_STAGE.ACTIVITY_AMBIGUOUS,
      },
    };
  }

  // 'unknown'（API エラー等）: 0 件として扱わない。時間切れなら人手へ。
  if (activity === 'unknown') {
    if (elapsed >= ESCALATE_MS) {
      return {
        action: 'escalate',
        reason: 'activity_unavailable_timeout',
        fields: { PaymentEmailStatus: EMAIL_STATUS.NEEDS_ADMIN, PaymentEmailFailureStage: FAILURE_STAGE.ACTIVITY_HORIZON },
      };
    }
    return { action: 'wait', reason: 'activity_unavailable' };
  }

  // 'zero'（HTTP200 かつ 0 件）
  if (elapsed < FIRST_QUERY_DELAY_MS) return { action: 'wait', reason: 'too_early' };

  if (elapsed >= ACTIVITY_HORIZON_MS) {
    return {
      action: 'escalate',
      reason: 'activity_horizon_exceeded',
      fields: { PaymentEmailStatus: EMAIL_STATUS.NEEDS_ADMIN, PaymentEmailFailureStage: FAILURE_STAGE.ACTIVITY_HORIZON },
    };
  }
  if (elapsed >= ESCALATE_MS) {
    return {
      action: 'escalate',
      reason: 'escalate_timeout',
      fields: { PaymentEmailStatus: EMAIL_STATUS.NEEDS_ADMIN },
    };
  }
  if (elapsed >= RECONCILE_ZERO_MIN_WAIT_MS) {
    if (attemptCount >= MAX_ATTEMPTS) {
      return {
        action: 'escalate',
        reason: 'attempt_exhausted',
        fields: { PaymentEmailStatus: EMAIL_STATUS.NEEDS_ADMIN },
      };
    }
    return {
      action: 'resend',
      reason: 'zero_confirmed',
      fields: { PaymentEmailStatus: EMAIL_STATUS.PENDING, PaymentEmailLeaseUntil: null },
    };
  }
  return { action: 'wait', reason: 'within_min_wait' };
}

// ── Event Webhook: accepted からの配信結果 ─────────────────────────
/**
 * SendGrid Event Webhook のイベント種別 → accepted からの次状態。
 * deferred は一時的なので状態を変えない（監視のみ）。
 * @returns {{status: string|null, fields?: Record<string, unknown>}}
 */
export function decideWebhookEvent({ event, now }) {
  const map = {
    delivered: EMAIL_STATUS.DELIVERED,
    bounce: EMAIL_STATUS.BOUNCED,
    dropped: EMAIL_STATUS.DROPPED,
  };
  const next = map[event];
  if (!next) return { status: null }; // deferred / open / click 等は無視
  const fields = { PaymentEmailStatus: next };
  if (next === EMAIL_STATUS.DELIVERED) fields.PaymentEmailDeliveredAt = new Date(now).toISOString();
  return { status: next, fields };
}

// ── gate 構成の検証（fail closed）──────────────────────────────
/** env 文字列 → boolean（'true'/'1'/'yes' を真とする）。 */
export function parseBoolEnv(v) {
  return v === true || v === 'true' || v === '1' || v === 'yes';
}

/**
 * env から gate 構成を組み立てる（純粋。env オブジェクトを渡す）。
 */
export function parseGatesFromEnv(env = {}) {
  return {
    flow: env.PAYMENT_EMAIL_FLOW_VERSION === 'v2' ? 'v2' : 'legacy',
    workerSend: parseBoolEnv(env.PAYMENT_EMAIL_WORKER_SEND_ENABLED),
    reconcilerWrite: parseBoolEnv(env.PAYMENT_EMAIL_RECONCILER_WRITE_ENABLED),
    globalPause: parseBoolEnv(env.PAYMENT_EMAIL_GLOBAL_PAUSE),
    a2DisabledConfirmed: parseBoolEnv(env.PAYMENT_EMAIL_A2_DISABLED_CONFIRMED),
  };
}

/**
 * gate 構成の妥当性検証。**不正構成は fail closed（呼び出し側は送信しない）**。
 * @returns {{ok: boolean, mode: string, violations: string[]}}
 */
export function validateEmailGates(gates) {
  const g = gates || {};
  const violations = [];

  if (g.flow === 'v2' && !g.a2DisabledConfirmed) violations.push('v2_requires_a2_disabled');
  if (g.workerSend && g.flow !== 'v2') violations.push('worker_requires_v2');
  if (g.reconcilerWrite && g.flow !== 'v2') violations.push('reconciler_requires_v2');
  if (g.globalPause && g.workerSend) violations.push('pause_with_worker');
  if (g.globalPause && g.reconcilerWrite) violations.push('pause_with_reconciler');
  // reconciler は resend で pending を作るが、worker が無ければ送られず滞留する。
  if (g.reconcilerWrite && !g.workerSend) violations.push('reconciler_needs_worker');

  // モード（cutover 順序に対応）:
  //   legacy → v2-dry-run(S6) → v2-worker(S7: worker ON / reconciler dry-run) → v2-full(S8)
  let mode = 'invalid';
  if (violations.length === 0) {
    if (g.globalPause) mode = 'paused';
    else if (g.flow === 'legacy') mode = 'legacy';
    else if (g.flow === 'v2' && g.workerSend && g.reconcilerWrite) mode = 'v2-full';
    else if (g.flow === 'v2' && g.workerSend) mode = 'v2-worker';
    else if (g.flow === 'v2') mode = 'v2-dry-run';
  }

  return { ok: violations.length === 0, mode, violations };
}

/**
 * confirm が v2（pending を書き、送信は worker に委譲）で振る舞ってよいか。
 * worker が送信できるモードのときだけ true（v2-dry-run では legacy 挙動 = confirm が inline 送信）。
 * これで「送信されない pending」が滞留しない。gate 不正時は fail closed で false（=legacy）。
 */
export function shouldConfirmUseV2(gates) {
  const v = validateEmailGates(gates);
  return v.ok && (v.mode === 'v2-worker' || v.mode === 'v2-full');
}
