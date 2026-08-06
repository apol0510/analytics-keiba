/**
 * automationModel.js — 自動化の**状態機械と実行単位**（純粋・I/O なし）
 *
 * ── 実行単位 ──────────────────────────────────────────────────
 *   AutomationDefinition … 何を・誰に・いつ（プリセット + 管理者の設定）
 *   AutomationRun        … 1 回の配信回。**snapshot を固定**して進む
 *   ScheduledEmail       … 既存 AK のジョブ正本（**新規に作らない**）
 *   EmailEvent           … 既存 AK の配信結果（**読むだけ**）
 *
 * ── 送信の事実は巻き戻さない ──────────────────────────────────
 * `SENT` は取消も再送もしない。取消できるのは**未送信だけ**。
 * provider 受理（accepted）と実配信（delivered）は別概念として扱い、混同しない。
 *
 * ── timezone は Asia/Tokyo 固定 ───────────────────────────────
 * quiet hours・実行日・期限日数の判定はすべて **JST の暦日**で行う。
 * `toISOString()` の UTC 基準は使わない（JST 深夜 0〜9 時に 1 日ズレるため）。
 */

// ⚠️ JST 暦日の差は **既存の単一源** を使う（ここで再実装しない）。
//    AK には既に `customerMarketingAudience.jstDayDiff` があり、
//    契約状態・期限日数の判定はすべてそこを通っている。
import { jstDayDiff } from './customerMarketingAudience.js';

export { jstDayDiff };

/** 自動化定義の状態 */
export const AUTOMATION_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

/** これ以上自動実行しない終端状態 */
export const TERMINAL_STATUS = Object.freeze([
  AUTOMATION_STATUS.COMPLETED, AUTOMATION_STATUS.FAILED, AUTOMATION_STATUS.CANCELLED,
]);

/** 実行を断る理由（固定コード） */
export const RUN_REJECT = Object.freeze({
  SEND_GATE_CLOSED: 'send_gate_closed',
  NOT_ACTIVE: 'not_active',
  PAUSED: 'paused',
  CANCELLED: 'cancelled',
  TERMINAL: 'terminal',
  ALREADY_RUNNING: 'already_running',
  QUIET_HOURS: 'quiet_hours',
  NO_DRY_RUN: 'no_dry_run',
  SNAPSHOT_MISMATCH: 'snapshot_mismatch',
  AUDIENCE_GREW: 'audience_grew',
  MAX_SENDS_EXCEEDED: 'max_sends_exceeded',
  NOTHING_TO_SEND: 'nothing_to_send',
  DUPLICATE_RUN: 'duplicate_run',
});

export const RUN_REJECT_LABEL = Object.freeze({
  send_gate_closed: '本番メール送信ゲートが閉じています（MARKETING_CAMPAIGN_DISPATCH_ENABLED）。',
  not_active: 'この自動化は有効ではありません。',
  paused: 'この自動化は一時停止中です。',
  cancelled: 'この自動化は取消済みです。',
  terminal: 'この自動化は終了しています。',
  already_running: 'すでに実行中です（同時実行はできません）。',
  quiet_hours: '静音時間帯のため実行しません。',
  no_dry_run: '先に dry-run を実行してください。',
  snapshot_mismatch: 'dry-run のときと対象が変わっています。',
  audience_grew: 'dry-run より対象が増えています。再承認が必要です。',
  max_sends_exceeded: '1 回の上限を超えています。',
  nothing_to_send: '送信対象がありません。',
  duplicate_run: 'この配信回はすでに登録済みです。',
});

/** 実行の状態 */
export const RUN_STATE = Object.freeze({
  PLANNED: 'PLANNED',
  ENQUEUEING: 'ENQUEUEING',
  ENQUEUED: 'ENQUEUED',
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

const str = (v) => String(v ?? '').trim();
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

// ── JST の暦日ユーティリティ ─────────────────────────────────

/** JST の {年,月,日,時} を取り出す（UTC 基準の toISOString は使わない） */
export function jstParts(dateOrMs) {
  const d = dateOrMs instanceof Date ? dateOrMs : new Date(Number(dateOrMs));
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return {
    year: jst.getUTCFullYear(),
    month: jst.getUTCMonth() + 1,
    day: jst.getUTCDate(),
    hour: jst.getUTCHours(),
    minute: jst.getUTCMinutes(),
  };
}

/** JST の暦日 `YYYY-MM-DD` */
export function jstDateString(dateOrMs) {
  const p = jstParts(dateOrMs);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * 静音時間帯か（JST）。`start > end` は日をまたぐ帯として扱う（例 21→8）。
 */
export function isQuietHours({ nowMs, quietHours }) {
  const q = quietHours || {};
  const start = int(q.start);
  const end = int(q.end);
  if (start === end) return false;                 // 帯なし
  const h = jstParts(nowMs).hour;
  return start > end ? (h >= start || h < end) : (h >= start && h < end);
}

// ── 冪等キー ─────────────────────────────────────────────────

/** 配信回の ID。**同じ自動化・同じ暦日は同じ ID**（二重登録を防ぐ） */
export function buildAutomationRunId({ automationId, occurrenceDate }) {
  const a = str(automationId);
  const d = str(occurrenceDate);
  return a && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `auto:${a}:${d}` : '';
}

/** 操作 ID（監査・冪等）。run 内の 1 回の enqueue を指す */
export function buildOperationId({ automationRunId, attempt }) {
  const r = str(automationRunId);
  return r ? `${r}#${String(int(attempt) || 1).padStart(3, '0')}` : '';
}

/**
 * 受信者キー。**同一 automation / 同一対象 / 同一配信回**の二重登録を防ぐ。
 * 既存 `computeDeliveryKey` の `extraKey` へ渡す前提（新しい鍵体系を作らない）。
 */
export function buildRecipientKey({ automationRunId, email }) {
  const r = str(automationRunId);
  const e = str(email).toLowerCase();
  return r && e ? `${r}|${e}` : '';
}

// ── 状態遷移 ─────────────────────────────────────────────────

/** 定義のひな形（プリセット + 管理者設定） */
export function buildAutomationDefinition({ preset, overrides, nowIso }) {
  if (!preset) return null;
  const o = overrides || {};
  return {
    automationId: preset.automationId,
    name: preset.name,
    campaignId: o.campaignId ?? preset.campaignId,
    trigger: o.trigger ?? preset.trigger,
    audienceRule: o.audienceRule ?? preset.audienceRule,
    status: AUTOMATION_STATUS.DRAFT,
    enabled: false,                                  // ⚠️ 常に OFF から始まる
    maxSendsPerRun: int(o.maxSendsPerRun) || preset.maxSendsPerRun,
    requireDryRun: o.requireDryRun ?? preset.requireDryRun,
    quietHours: o.quietHours ?? preset.quietHours,
    minResendIntervalDays: int(o.minResendIntervalDays ?? preset.minResendIntervalDays),
    lastRun: null,
    nextRunAt: null,
    createdAt: str(nowIso),
    updatedAt: str(nowIso),
  };
}

/** 許可される遷移だけを通す */
const ALLOWED = Object.freeze({
  DRAFT: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['PAUSED', 'RUNNING', 'CANCELLED', 'COMPLETED'],
  PAUSED: ['ACTIVE', 'CANCELLED'],
  RUNNING: ['ACTIVE', 'PARTIAL', 'FAILED', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: ['ACTIVE'],          // 原因を直して再開できる
  CANCELLED: [],
});

export function canTransition(from, to) {
  const list = ALLOWED[str(from)] || [];
  return list.includes(str(to));
}

export function transition({ definition, to, nowIso }) {
  if (!definition) return { ok: false, reason: 'no_definition' };
  if (!canTransition(definition.status, to)) {
    return { ok: false, reason: `invalid_transition:${definition.status}->${to}` };
  }
  return {
    ok: true,
    definition: {
      ...definition,
      status: to,
      enabled: to === AUTOMATION_STATUS.ACTIVE,
      updatedAt: str(nowIso),
    },
  };
}

const no = (reason) => ({ allowed: false, reason, label: RUN_REJECT_LABEL[reason] || null });

/**
 * 実行してよいか。**fail-closed**。
 *
 * @param {{
 *   env, definition, nowMs, runningRunId, dryRun,
 *   dryRunSnapshot, currentSnapshot, plannedCount,
 * }} input
 */
export function canStartRun({
  env, definition, nowMs, runningRunId, dryRun, dryRunSnapshot, currentSnapshot, plannedCount,
} = {}) {
  if (!definition) return no(RUN_REJECT.NOT_ACTIVE);

  // dry-run は送信ゲートに依存しない（1 通も送らないため）
  if (!dryRun) {
    // ⚠️ 本番送信ゲートが閉じていれば実行しない
    if (!env || env.MARKETING_CAMPAIGN_DISPATCH_ENABLED !== 'true') return no(RUN_REJECT.SEND_GATE_CLOSED);
  }

  if (definition.status === AUTOMATION_STATUS.CANCELLED) return no(RUN_REJECT.CANCELLED);
  if (definition.status === AUTOMATION_STATUS.PAUSED) return no(RUN_REJECT.PAUSED);
  if (TERMINAL_STATUS.includes(definition.status)) return no(RUN_REJECT.TERMINAL);
  if (!dryRun && definition.status !== AUTOMATION_STATUS.ACTIVE) return no(RUN_REJECT.NOT_ACTIVE);
  if (!dryRun && definition.enabled !== true) return no(RUN_REJECT.NOT_ACTIVE);
  if (runningRunId) return no(RUN_REJECT.ALREADY_RUNNING);

  if (!dryRun) {
    if (isQuietHours({ nowMs, quietHours: definition.quietHours })) return no(RUN_REJECT.QUIET_HOURS);
    if (definition.requireDryRun && !str(dryRunSnapshot)) return no(RUN_REJECT.NO_DRY_RUN);
    if (str(dryRunSnapshot) && str(currentSnapshot) && str(dryRunSnapshot) !== str(currentSnapshot)) {
      return no(RUN_REJECT.SNAPSHOT_MISMATCH);
    }
    const n = int(plannedCount);
    if (n <= 0) return no(RUN_REJECT.NOTHING_TO_SEND);
    if (n > int(definition.maxSendsPerRun)) return no(RUN_REJECT.MAX_SENDS_EXCEEDED);
  }
  return { allowed: true, reason: null };
}

/** 実行記録のひな形 */
export function buildRun({ automationId, occurrenceDate, snapshot, plannedCount, dryRun, nowIso }) {
  const runId = buildAutomationRunId({ automationId, occurrenceDate });
  if (!runId) return null;
  return {
    automationRunId: runId,
    automationId: str(automationId),
    occurrenceDate: str(occurrenceDate),
    operationId: buildOperationId({ automationRunId: runId, attempt: 1 }),
    state: RUN_STATE.PLANNED,
    dryRun: dryRun === true,
    snapshotFingerprint: str(snapshot),
    planned: int(plannedCount),
    attempted: 0,
    enqueued: 0,
    skipped: 0,
    failed: 0,
    /** 除外理由の内訳（件数のみ・PII なし） */
    skipReasons: {},
    startedAt: str(nowIso),
    finishedAt: null,
    lastError: null,
  };
}

/** 登録結果を反映する。**送信済みを巻き戻さない** */
export function applyEnqueueResult({ run, result, nowIso }) {
  const r = result || {};
  const enqueued = int(run.enqueued) + int(r.enqueued);
  const failed = int(run.failed) + int(r.failed);
  const skipped = int(run.skipped) + int(r.skipped);
  const attempted = int(run.attempted) + int(r.attempted);
  let state = RUN_STATE.ENQUEUED;
  if (failed > 0 && enqueued > 0) state = RUN_STATE.PARTIAL;
  else if (failed > 0 && enqueued === 0) state = RUN_STATE.FAILED;
  return {
    ...run,
    state,
    attempted, enqueued, skipped, failed,
    skipReasons: { ...(run.skipReasons || {}), ...(r.skipReasons || {}) },
    finishedAt: str(nowIso),
    lastError: r.error ? str(r.error) : null,
  };
}

/**
 * 取消。**未送信だけ**を止める。SENT は触らない。
 */
export function cancelRun({ run, nowIso }) {
  if (!run) return null;
  if (run.state === RUN_STATE.ENQUEUED && int(run.enqueued) > 0) {
    return {
      ...run,
      state: RUN_STATE.CANCELLED,
      finishedAt: str(nowIso),
      cancelNote: '未送信のキューだけ取り消します。送信済み（SENT）は取り消せません。',
    };
  }
  return { ...run, state: RUN_STATE.CANCELLED, finishedAt: str(nowIso) };
}

/** 画面用のまとめ（PII を含めない） */
export function summarizeAutomation({ definition, lastRun, plannedCount, nextRunAt }) {
  if (!definition) return null;
  return {
    automationId: definition.automationId,
    name: definition.name,
    status: definition.status,
    有効: definition.enabled === true,
    campaignId: definition.campaignId,
    trigger: definition.trigger,
    次回実行日時: nextRunAt ?? definition.nextRunAt ?? null,
    対象予定人数: int(plannedCount),
    前回実行: lastRun ? {
      runId: lastRun.automationRunId,
      state: lastRun.state,
      dryRun: lastRun.dryRun === true,
      対象: int(lastRun.planned),
      送信済み: int(lastRun.enqueued),
      除外: int(lastRun.skipped),
      失敗: int(lastRun.failed),
      除外理由: lastRun.skipReasons || {},
      実行時刻: lastRun.startedAt || null,
      終了時刻: lastRun.finishedAt || null,
    } : null,
    quietHours: definition.quietHours,
    最大送信件数: int(definition.maxSendsPerRun),
    'dry-run必須': definition.requireDryRun === true,
    再実行可能: !TERMINAL_STATUS.includes(definition.status),
  };
}

export default AUTOMATION_STATUS;
