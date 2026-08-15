/**
 * marketingJobs.js — キャンペーン送信ジョブの**状況表示と取消**（純粋・I/O なし）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * これまで admin から見えるのは「キャンペーン単位の累計」だけで、
 * **いま何が送信待ちか / どれが失敗したか / 取り消せるのか**が分からなかった。
 * 送信は取り返しがつかないので、運用者が「止められる状態」を持っていないと
 * 誤登録に気付いても手が出せない。
 *
 * ── 単一源 ────────────────────────────────────────────────
 * ジョブの正本は `ScheduledEmails`、1 通ごとの正本は `CampaignDeliveries`。
 * ここでは**その 2 つを突き合わせて表示用に整えるだけ**で、新しい状態は作らない。
 *
 * ── 取消の原則 ────────────────────────────────────────────
 * - **PENDING だけ**が取消できる。SENT / FAILED は**送信済みの事実**なので取り消せない
 * - 取消は `ScheduledEmails.Status='CANCELLED'` と、**queued の配信行だけ**を `cancelled` にする。
 *   **`sent` の行には絶対に触れない**（送った事実を消さない）
 * - `operationId` を記録し、同じ取消を 2 回実行しても 2 重に書かない（冪等）
 */

/** ジョブの状態（`ScheduledEmails.Status`） */
export const JOB_STATUS = Object.freeze({
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
});

/** 配信 1 通の状態（`CampaignDeliveries.Status`） */
export const DELIVERY_STATUS = Object.freeze({
  QUEUED: 'queued',
  SENT: 'sent',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

/** 取消できない理由（固定コード） */
export const CANCEL_REJECT = Object.freeze({
  NOT_FOUND: 'job_not_found',
  NOT_MARKETING: 'not_marketing_job',
  ALREADY_SENT: 'already_sent',
  ALREADY_FAILED: 'already_failed',
  ALREADY_CANCELLED: 'already_cancelled',
  UNKNOWN_STATUS: 'unknown_status',
});

/** 取消時に `ScheduledEmails` へ書いてよい列（これ以外は書かない） */
export const JOB_CANCEL_WRITABLE_FIELDS = Object.freeze(['Status', 'CompletedAt', 'Notes']);
/** 取消時に `CampaignDeliveries` へ書いてよい列 */
export const DELIVERY_CANCEL_WRITABLE_FIELDS = Object.freeze(['Status', 'SkippedAt', 'ErrorMessage']);

const str = (v) => String(v ?? '').trim();

/** `campaign:<id>` / `<id>:v<n>` からキャンペーンを取り出す */
export function parseJobCampaign(fields = {}) {
  const target = str(fields.TargetPlan).replace(/^campaign:/, '');
  const notes = str(fields.Notes);
  const m = /marketing campaign\s+([a-z0-9-]+)\s+v([0-9]+)/i.exec(notes);
  // 何を送ったかの照合用。キュー登録時に Notes へ残した内容 hash を読む
  const c = /content:([0-9a-f]{6,32})/i.exec(notes);
  return {
    campaignId: target || (m ? m[1] : ''),
    version: m ? m[2] : '',
    contentHash: c ? c[1] : '',
    contentEdited: /\bedited\b/.test(notes),
  };
}

/**
 * ジョブ 1 件を表示用にまとめる。**カウントは配信行（1 通ごとの正本）から数える**。
 */
export function buildJobRow({ job, deliveries = [] }) {
  const f = (job && job.fields) || {};
  const jobId = str(f.JobId);
  const mine = deliveries.filter((r) => str(r.fields && r.fields.ScheduledEmailJobId) === jobId);

  const counts = { queued: 0, sent: 0, failed: 0, skipped: 0, cancelled: 0 };
  const errorReasons = {};
  let lastAt = '';
  for (const rec of mine) {
    const df = rec.fields || {};
    const s = str(df.Status).toLowerCase();
    if (s === DELIVERY_STATUS.QUEUED) counts.queued += 1;
    else if (s === DELIVERY_STATUS.SENT) counts.sent += 1;
    else if (s === DELIVERY_STATUS.FAILED) counts.failed += 1;
    else if (s === DELIVERY_STATUS.CANCELLED) counts.cancelled += 1;
    else if (s.startsWith('skipped')) counts.skipped += 1;
    // 失敗・スキップの理由は**分類として**数える（アドレスは持たない）
    if (s === DELIVERY_STATUS.FAILED || s.startsWith('skipped')) {
      const reason = str(df.ErrorMessage) || s || 'unknown';
      errorReasons[reason] = (errorReasons[reason] || 0) + 1;
    }
    const at = str(df.SentAt || df.QueuedAt || df.SkippedAt || df.FailedAt);
    if (at && at > lastAt) lastAt = at;
  }

  const cancel = canCancelJob(job);
  const { campaignId, version, contentHash, contentEdited } = parseJobCampaign(f);
  return {
    jobId,
    recordId: str(job && job.id),
    campaignId,
    version,
    // 実際に送った（送る）件名と内容 hash。**後から書き換えない記録**
    subject: str(f.Subject),
    contentHash,
    contentEdited,
    createdBy: str(f.CreatedBy),
    status: str(f.Status) || JOB_STATUS.PENDING,
    scheduledFor: str(f.ScheduledFor) || null,
    completedAt: str(f.CompletedAt) || null,
    recipientCount: Number(f.RecipientCount) || mine.length,
    sentCount: Number(f.SentCount) || 0,
    failedCount: Number(f.FailedCount) || 0,
    counts,
    errorReasons,
    lastAt: lastAt || null,
    cancelable: cancel.ok,
    cancelReason: cancel.ok ? null : cancel.reason,
  };
}

/**
 * ジョブ一覧（新しい順）。**マーケティングジョブだけ**を対象にする。
 *
 * @param {{jobRecords: object[], deliveryRecords: object[], isMarketingJob: Function}} input
 */
export function buildJobView({ jobRecords = [], deliveryRecords = [], isMarketingJob } = {}) {
  const pick = typeof isMarketingJob === 'function' ? isMarketingJob : () => true;
  const rows = [];
  for (const job of jobRecords) {
    const f = (job && job.fields) || {};
    if (!pick(f)) continue;
    rows.push(buildJobRow({ job, deliveries: deliveryRecords }));
  }
  return rows.sort((a, b) => String(b.scheduledFor || b.lastAt || '').localeCompare(String(a.scheduledFor || a.lastAt || '')));
}

/**
 * 取消できるか。**PENDING 以外は取り消せない**（送信済みの事実を消さない）。
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function canCancelJob(job) {
  const f = (job && job.fields) || null;
  if (!f) return { ok: false, reason: CANCEL_REJECT.NOT_FOUND };
  const status = str(f.Status).toUpperCase();
  if (status === JOB_STATUS.PENDING) return { ok: true };
  if (status === JOB_STATUS.SENT) return { ok: false, reason: CANCEL_REJECT.ALREADY_SENT };
  if (status === JOB_STATUS.FAILED) return { ok: false, reason: CANCEL_REJECT.ALREADY_FAILED };
  if (status === JOB_STATUS.CANCELLED) return { ok: false, reason: CANCEL_REJECT.ALREADY_CANCELLED };
  return { ok: false, reason: CANCEL_REJECT.UNKNOWN_STATUS };
}

/**
 * 取消時に `ScheduledEmails` へ書くフィールド。**operationId を Notes に残す**（冪等判定に使う）。
 */
export function buildJobCancelFields({ operationId, nowMs, previousNotes = '' } = {}) {
  const op = str(operationId);
  if (!op) return null; // 操作 ID が無い取消は受け付けない（再実行の判別ができないため）
  const iso = Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : null;
  const note = `cancelled by admin-marketing op=${op}`;
  const prev = str(previousNotes);
  return {
    Status: JOB_STATUS.CANCELLED,
    CompletedAt: iso,
    Notes: prev ? `${prev} / ${note}` : note,
  };
}

/** 取消時に `CampaignDeliveries`（**queued の行だけ**）へ書くフィールド */
export function buildDeliveryCancelFields({ operationId, nowMs } = {}) {
  const op = str(operationId);
  if (!op) return null;
  return {
    Status: DELIVERY_STATUS.CANCELLED,
    SkippedAt: Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : null,
    ErrorMessage: `cancelled_by_admin:${op}`,
  };
}

/** 既にこの operationId で取消済みか（同じ取消を 2 回書かない） */
export function isAlreadyCancelledBy({ job, operationId } = {}) {
  const f = (job && job.fields) || {};
  if (str(f.Status).toUpperCase() !== JOB_STATUS.CANCELLED) return false;
  return str(f.Notes).includes(`op=${str(operationId)}`);
}

/** 取消対象の配信行（**queued のみ**。sent には絶対に触れない） */
export function selectCancelableDeliveries({ jobId, deliveryRecords = [] } = {}) {
  const id = str(jobId);
  if (!id) return [];
  return deliveryRecords.filter((r) => {
    const f = (r && r.fields) || {};
    return str(f.ScheduledEmailJobId) === id
      && str(f.Status).toLowerCase() === DELIVERY_STATUS.QUEUED;
  });
}

/** 書き込み列の逸脱を弾く */
export function assertOnlyCancelFields(fields, allow = JOB_CANCEL_WRITABLE_FIELDS) {
  const keys = Object.keys(fields || {});
  if (keys.length === 0) return false;
  return keys.every((k) => allow.includes(k));
}

/**
 * キャンペーンごとの実施サマリを **送信ジョブから** 作る（純粋）。
 *
 * ── なぜ配信台帳から数えないか（2026-08-15 実測）────────────────
 * 旧実装は `CampaignDeliveries` を全件読んで数えていた。台帳は **14,426 行
 * （145 ページ / 実測 162 秒）** まで育っており、Netlify Function の実行時間
 * （最大 26 秒）では**原理的に読み切れない**。
 * 4,000 行で黙って打ち切っていた頃は「動いているが数が嘘」だった。
 *
 * ジョブ台帳（`ScheduledEmails`）は **1 送信 = 1 行**で、マーケティング分は
 * 152 行しかない。「いつ・どのキャンペーンを・何人へ流したか」はここで完結する。
 *
 * ⚠️ **数の意味が変わる**ので、画面と応答で必ず出所を明示すること:
 *   - `recipients` … ジョブに載せた宛先数（＝送信対象）
 *   - `sent` / `failed` … 送信基盤が報告したジョブ単位の件数
 *   - **`skipped` は出さない**（配信行 1 件ずつの状態なので、ジョブからは分からない）。
 *     推測で 0 を埋めない。
 *
 * @param {Array} jobRows `buildJobView` の戻り（deliveries 無しで組み立ててよい）
 */
export function summarizeCampaignRunsFromJobs(jobRows) {
  const byCampaign = new Map();
  for (const j of Array.isArray(jobRows) ? jobRows : []) {
    const key = j && j.campaignId
      ? `${j.campaignId}${j.version ? `:v${j.version}` : ''}`
      : '(unknown)';
    const cur = byCampaign.get(key) || {
      campaignType: key, jobs: 0, recipients: 0, sent: 0, failed: 0, pending: 0, lastAt: null,
    };
    cur.jobs += 1;
    cur.recipients += Number(j.recipientCount) || 0;
    cur.sent += Number(j.sentCount) || 0;
    cur.failed += Number(j.failedCount) || 0;
    if (str(j.status).toUpperCase() === JOB_STATUS.PENDING) cur.pending += 1;
    const at = str(j.completedAt || j.scheduledFor);
    if (at && (!cur.lastAt || at > cur.lastAt)) cur.lastAt = at;
    byCampaign.set(key, cur);
  }
  return [...byCampaign.values()]
    .sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
}
