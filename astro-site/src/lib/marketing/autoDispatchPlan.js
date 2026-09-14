/**
 * autoDispatchPlan.js — 「積まれたジョブを、人を挟まずに送り切る」ための計画（純粋・I/O なし）
 *
 * ## なぜ要るか（2026-09-14 の本番実測）
 *
 * キュー登録（`cron-campaign-sequence`）と実送信（`marketing-campaign-dispatch`）は
 * 別の部品で、**その 2 つを繋ぐ自動経路が存在しなかった**。
 * 送信を起動していたのは `cron-marketing-rollout` だけで、しかも
 * **自分が積んだジョブ（`pendingJobIds`）しか起動しない**。
 *
 * 結果、割引キャンペーン（`campaign-discount-*`）は
 * **積まれ続けるが 1 通も送られない**状態になった。実測:
 *
 *   PENDING ジョブ 4,307 件 / 宛先スロット 179,250 / 送信 0 通（2026-09-09〜09-14）
 *
 * ここはその欠けていた輪を埋める計画を持つ。**判断だけ**を持ち、I/O はしない。
 *
 * ## 原則
 *
 *   - **古いものから**送る（積んだ順。後から積んだ人に追い越させない）
 *   - 1 tick の起動数に**上限**を置く（Function の実行時間と provider のレートに収める）
 *   - `queue:unverified` の印が付いたジョブは**起動しない**（配信行の確認が済んでいない）
 *   - `PENDING` 以外は対象外（`SENT` / `CANCELLED` / `EXECUTING` を掘り返さない）
 *   - **直近で「送る相手が 0 人」だったジョブは、しばらく飛ばす**
 *     （先頭で詰まると後ろが永久に進まない＝行列の先頭詰まり）
 *
 * ⚠️ ここは除外条件・冪等性を**一切判定しない**。誰に送るかは従来どおり
 *    dispatcher の送信直前再検証（`verifyBeforeSend`）と `DeliveryKey` が決める。
 */

import { isMarketingJob } from './marketingDispatchGate.js';
import { hasUnverifiedMark } from './queueJobPreparation.js';

/** 起動しない理由（固定コード） */
export const AUTO_DISPATCH_SKIP = Object.freeze({
  NOT_MARKETING: 'not_marketing_job',
  NOT_PENDING: 'job_not_pending',
  UNVERIFIED: 'queue_unverified',
  COOLING_DOWN: 'recently_had_nothing_to_send',
  OVER_BUDGET: 'tick_budget_reached',
  NO_JOB_ID: 'job_id_missing',
});

/** 1 tick で起動するジョブ数の既定（Function の実行時間に収まる範囲） */
export const DEFAULT_MAX_JOBS_PER_TICK = 10;

/** 「送る相手 0 人」だったジョブを次に見直すまでの既定（ミリ秒 / 6 時間） */
export const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** env から 1 tick の起動上限を読む（壊れた値は既定へ。0 では止めない） */
export function resolveMaxJobsPerTick(env = {}) {
  const n = Number(env.MARKETING_DISPATCH_MAX_JOBS_PER_TICK);
  return Number.isInteger(n) && n > 0 && n <= 100 ? n : DEFAULT_MAX_JOBS_PER_TICK;
}

const str = (v) => String(v ?? '').trim();

/**
 * この tick で起動するジョブを決める。
 *
 * @param {{
 *   jobs: Array<{id?: string, fields?: object}>,   ScheduledEmails の行
 *   maxJobs?: number,
 *   cooldownUntilByJobId?: Map<string, number>,    「0 人だった」ジョブの再開時刻
 *   nowMs?: number,
 * }} input
 * @returns {{start: Array<{jobId: string, recordId: string|null, sentCount: number}>,
 *            skipped: Array<{jobId: string, reason: string}>,
 *            skippedByReason: Record<string, number>, candidates: number}}
 */
export function planAutoDispatch({
  jobs, maxJobs = DEFAULT_MAX_JOBS_PER_TICK, cooldownUntilByJobId, nowMs = Date.now(),
} = {}) {
  const list = Array.isArray(jobs) ? jobs : [];
  const start = [];
  const skipped = [];
  const skippedByReason = {};
  const deny = (jobId, reason) => {
    skipped.push({ jobId, reason });
    skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
  };

  // 積んだ順（古いものから）。同時刻は JobId で安定化する
  const ordered = list.slice().sort((a, b) => {
    const fa = (a && a.fields) || {};
    const fb = (b && b.fields) || {};
    const c = str(fa.ScheduledFor).localeCompare(str(fb.ScheduledFor));
    return c !== 0 ? c : str(fa.JobId).localeCompare(str(fb.JobId));
  });

  for (const row of ordered) {
    const f = (row && row.fields) || {};
    const jobId = str(f.JobId);
    if (!jobId) { deny('(不明)', AUTO_DISPATCH_SKIP.NO_JOB_ID); continue; }
    if (!isMarketingJob(f)) { deny(jobId, AUTO_DISPATCH_SKIP.NOT_MARKETING); continue; }
    if (str(f.Status).toUpperCase() !== 'PENDING') { deny(jobId, AUTO_DISPATCH_SKIP.NOT_PENDING); continue; }
    // 配信行の確認が済んでいないジョブは**絶対に起動しない**
    if (hasUnverifiedMark(str(f.Notes))) { deny(jobId, AUTO_DISPATCH_SKIP.UNVERIFIED); continue; }
    const until = cooldownUntilByJobId instanceof Map ? Number(cooldownUntilByJobId.get(jobId)) : NaN;
    if (Number.isFinite(until) && until > nowMs) { deny(jobId, AUTO_DISPATCH_SKIP.COOLING_DOWN); continue; }
    if (start.length >= maxJobs) { deny(jobId, AUTO_DISPATCH_SKIP.OVER_BUDGET); continue; }
    start.push({
      jobId,
      recordId: str(row.id) || null,
      sentCount: Number(f.SentCount) || 0,
    });
  }

  return { start, skipped, skippedByReason, candidates: ordered.length };
}

/**
 * dry-run の結果から、そのジョブの**いま送る人数**を取り出す。
 *
 * ⚠️ `RecipientCount`（ジョブ作成時の人数）から推測しない。
 *    作成後に配信停止・バウンス・購入・既送信が起きていれば実際の対象は減っており、
 *    古い数を `expectedWillSend` に使うと**送信直前ガードで 409** になって 1 通も出ない。
 *    分からないときは **null**（起動しない）。
 *
 * ⚠️ **`cron-marketing-rollout` と `cron-marketing-dispatch` の共通の単一源**。
 *    どちらかに写して 2 つの判定を持たせないこと。
 */
export function readWillSend(dryBody, jobId) {
  const results = (dryBody && Array.isArray(dryBody.jobResults)) ? dryBody.jobResults : null;
  if (!results) return { ok: false, reason: 'dry_run_shape_unknown' };
  const row = results.find((r) => r && String(r.jobId) === String(jobId));
  if (!row) return { ok: false, reason: 'job_not_in_dry_run' };
  const n = row.willSend;
  if (typeof n !== 'number' || !Number.isFinite(n)) return { ok: false, reason: 'will_send_unknown' };
  return {
    ok: true,
    willSend: n,
    willSkip: typeof row.willSkip === 'number' ? row.willSkip : null,
    alreadySent: typeof row.alreadySent === 'number' ? row.alreadySent : null,
    skipByReason: row.skipByReason && typeof row.skipByReason === 'object' ? row.skipByReason : {},
  };
}

/**
 * 実行結果の要約（ログ・応答用。**アドレスは含めない**）。
 */
export function summarizeAutoDispatch({ planned, started, skipped, nothingToSend }) {
  return {
    対象: Number(planned) || 0,
    起動: Number(started) || 0,
    見送り: Number(skipped) || 0,
    送る相手なし: Number(nothingToSend) || 0,
  };
}

export default planAutoDispatch;
