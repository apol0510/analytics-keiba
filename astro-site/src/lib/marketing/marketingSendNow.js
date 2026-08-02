/**
 * marketingSendNow.js — 管理画面の「今すぐ送信」（純粋・I/O なし）
 *
 * ── なぜ厳しくするか ──────────────────────────────────────
 * ここだけが**実際に顧客へメールを出す**操作で、押した瞬間から取り消せない。
 * 「確認した対象」と「これから送る対象」が 1 ミリでもズレていたら押させない。
 *
 * ── 送信に到達できる唯一の順序 ────────────────────────────
 *   dry-run（対象確定） → キュー登録 → dispatcher dryRun:true（送信直前の再検証）
 *   → 最終確認（人数入力） → dispatcher dryRun:false
 *
 * 途中で選択・条件・キャンペーンが変わったり、キューの状態が変わったりしたら、
 * **同じ jobId・同じ内容であることが確認できるまで送らない**。
 */

/** 送れない理由（固定コード） */
export const SEND_BLOCK = Object.freeze({
  BUSY: 'busy',
  GATE_CLOSED: 'gate_closed',
  NO_DRY_RUN: 'no_dry_run',
  DRY_RUN_STALE: 'dry_run_stale',
  NOT_ENQUEUED: 'not_enqueued',
  NO_PREFLIGHT: 'no_preflight',
  NO_RECIPIENTS: 'no_recipients',
  JOB_NOT_UNIQUE: 'job_not_unique',
  JOB_MISMATCH: 'job_mismatch',
  STATE_CHANGED: 'state_changed',
  ALREADY_SENT: 'already_sent',
  TEST_ONLY_TO_CUSTOMERS: 'test_only_to_customers',
  CONFIRM_MISMATCH: 'confirm_mismatch',
});

export const SEND_BLOCK_LABEL = Object.freeze({
  [SEND_BLOCK.BUSY]: '実行中です。完了までお待ちください。',
  [SEND_BLOCK.GATE_CLOSED]: '実配信が無効です（MARKETING_CAMPAIGN_DISPATCH_ENABLED 未設定）。',
  [SEND_BLOCK.NO_DRY_RUN]: '送信対象の確認（dry-run）がまだです。',
  [SEND_BLOCK.DRY_RUN_STALE]: '対象が変わったため確認結果が無効です。もう一度 dry-run してください。',
  [SEND_BLOCK.NOT_ENQUEUED]: 'キュー登録がまだです。',
  [SEND_BLOCK.NO_PREFLIGHT]: '送信直前の確認（配信内容を確認）がまだです。',
  [SEND_BLOCK.NO_RECIPIENTS]: '送信対象が 0 名です。',
  [SEND_BLOCK.JOB_NOT_UNIQUE]: '送信待ちのジョブを 1 件に特定できません（0 件、または 2 件以上）。',
  [SEND_BLOCK.JOB_MISMATCH]: '確認したジョブと送信しようとしているジョブが違います。',
  [SEND_BLOCK.STATE_CHANGED]: '確認後にキューの状態が変わりました。もう一度確認してください。',
  [SEND_BLOCK.ALREADY_SENT]: 'このジョブは送信済みです。再送は version を上げて作り直してください。',
  [SEND_BLOCK.TEST_ONLY_TO_CUSTOMERS]: '運用テスト専用キャンペーンです。一般顧客へは送れません。',
  [SEND_BLOCK.CONFIRM_MISMATCH]: '確認入力が一致しません。送信予定人数を正しく入力してください。',
});

const str = (v) => String(v ?? '').trim();
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * dispatcher の `dryRun:true` 応答から「これから送る 1 件」を取り出す。
 *
 * **1 件に特定できないなら送らせない**（0 件＝送るものが無い、2 件以上＝巻き込み送信になる）。
 * `fingerprint` は「確認した内容」を表し、実送信の直前に同じ値であることを要求する。
 */
export function buildDispatchPreflight(result = {}) {
  const jobs = Array.isArray(result.jobResults) ? result.jobResults : [];
  if (jobs.length !== 1) {
    return { ok: false, reason: SEND_BLOCK.JOB_NOT_UNIQUE, jobCount: jobs.length };
  }
  const j = jobs[0];
  const jobId = str(j.jobId);
  const willSend = num(j.willSend);
  if (!jobId) return { ok: false, reason: SEND_BLOCK.JOB_NOT_UNIQUE, jobCount: 1 };
  if (willSend === 0) return { ok: false, reason: SEND_BLOCK.NO_RECIPIENTS, jobId, willSend: 0 };
  return {
    ok: true,
    jobId,
    willSend,
    willSkip: num(j.willSkip),
    total: num(j.total),
    // 内容が 1 つでも変われば別の値になる（確認と送信のズレを検知する）
    fingerprint: `${jobId}|${willSend}|${num(j.willSkip)}|${num(j.total)}`,
  };
}

/**
 * 「今すぐ送信」を押せるか。**すべての段を通過している場合だけ true**。
 *
 * @param {{busy, dispatchEnabled, dryRun, dryRunStale, enqueued, preflight, sent, campaign}} state
 */
export function canSendNow(state = {}) {
  const no = (reason) => ({ allowed: false, reason });
  if (state.busy) return no(SEND_BLOCK.BUSY);
  if (state.dispatchEnabled !== true) return no(SEND_BLOCK.GATE_CLOSED);
  if (!state.dryRun) return no(SEND_BLOCK.NO_DRY_RUN);
  if (state.dryRunStale === true) return no(SEND_BLOCK.DRY_RUN_STALE);
  if (!state.enqueued) return no(SEND_BLOCK.NOT_ENQUEUED);
  if (state.sent === true) return no(SEND_BLOCK.ALREADY_SENT);
  const pf = state.preflight;
  if (!pf) return no(SEND_BLOCK.NO_PREFLIGHT);
  if (pf.ok !== true) return no(pf.reason || SEND_BLOCK.NO_PREFLIGHT);
  if (num(pf.willSend) === 0) return no(SEND_BLOCK.NO_RECIPIENTS);
  return { allowed: true, reason: null };
}

/**
 * 実送信の直前に、**確認したときと同じジョブ・同じ内容か**を照合する。
 * 変わっていたら送らない（409 相当）。
 */
export function verifySendPrecondition({ preflight, latest, confirmedCount, typedCount, campaign } = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (!preflight || preflight.ok !== true) return no(SEND_BLOCK.NO_PREFLIGHT);

  // 通常配信は人数の入力一致を必須にする（テスト専用は 1 通なので省略できる）
  const isTestOnly = !!(campaign && campaign.testOnly === true);
  if (!isTestOnly) {
    if (str(typedCount) !== str(confirmedCount)) return no(SEND_BLOCK.CONFIRM_MISMATCH);
  }

  if (latest) {
    const now = buildDispatchPreflight(latest);
    if (!now.ok) return no(now.reason);
    if (now.jobId !== preflight.jobId) return no(SEND_BLOCK.JOB_MISMATCH);
    if (now.fingerprint !== preflight.fingerprint) return no(SEND_BLOCK.STATE_CHANGED);
  }
  return { ok: true, reason: null, jobId: preflight.jobId };
}

/** 最終確認モーダルに出す内容（**画面はこの形をそのまま表示する**） */
export function buildSendNowConfirmation({ campaign, dryRun, preflight, dispatchEnabled, sendEnabled, operationId } = {}) {
  const c = campaign || {};
  const d = dryRun || {};
  const pf = preflight || {};
  return {
    campaignName: str(c.name) || str(c.campaignId),
    version: str(c.version),
    kind: c.testOnly === true ? '運用テスト専用' : '通常配信',
    audience: c.testOnly === true ? 'テスト受信者のみ' : '実顧客',
    selected: num(d.selected),
    targeted: num(d.willSend),
    excluded: num(d.excluded),
    willSend: num(pf.willSend),
    operationId: str(operationId),
    jobId: str(pf.jobId),
    gate: { enqueue: sendEnabled === true, dispatch: dispatchEnabled === true },
    duplicateGuard: 'DeliveryKey（campaign×version×宛先）と operationId で、再実行しても 1 通のまま',
    afterSend: '送信後は取り消せません',
    effect: c.testOnly === true
      ? 'テスト受信者へ実際にメールが届きます'
      : '実顧客へ実際にメールが届きます',
    requiresTypedCount: c.testOnly !== true,
  };
}

/** ジョブの表示状態（部分成功を成功と読ませない） */
export function classifySendOutcome({ sent, failed, skipped } = {}) {
  const s = num(sent);
  const f = num(failed);
  if (f > 0 && s > 0) return { key: 'PARTIAL', label: '一部失敗', tone: 'warn' };
  if (f > 0 && s === 0) return { key: 'FAILED', label: '失敗', tone: 'ng' };
  if (s > 0) return { key: 'SENT', label: '送信済み', tone: 'ok' };
  return { key: 'NONE', label: '送信 0 通', tone: 'muted' };
}

/**
 * 送信結果の要約。**成功済みを巻き戻さない**ことと、再送を自動で勧めないことを明示する。
 */
export function summarizeSendResult(result = {}, { completedAt } = {}) {
  const sent = num(result.sent);
  const failed = num(result.failed);
  const skipped = num(result.skipped);
  const outcome = classifySendOutcome({ sent, failed, skipped });
  const reasons = [];
  for (const [reason, count] of Object.entries(result.skippedByReason || {})) {
    if (num(count) > 0) reasons.push({ reason: str(reason), count: num(count) });
  }
  return {
    outcome,
    sent,
    failed,
    skipped,
    /** provider が受理した件数 ＝ sent。実配信（delivered）とは別物 */
    providerAccepted: sent,
    skippedReasons: reasons.sort((a, b) => b.count - a.count),
    completedAt: str(completedAt) || null,
    cancelable: false,
    cancelNote: '送信済みのため取消不可（メールは取り消せません）',
    partialNote: outcome.key === 'PARTIAL'
      ? '成功した分はそのまま残します（巻き戻しません）。失敗分の再送は自動では行いません。'
      : null,
    autoRetry: false,
    deliveredNote: '「送信」は配信基盤が受理した状態です。実際に届いたか（delivered）は台帳で確認します。',
  };
}
