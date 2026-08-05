/**
 * marketingEnqueueContract.js — キュー登録の**共通契約**（純粋・I/O なし）
 *
 * ── なぜ共通化するか ──────────────────────────────────────────
 * 管理画面からの手動送信と自動配信が**別々に ScheduledEmails を組み立てる**と、
 * 片方だけ形が変わって dispatcher の扱いがズレる。そこで
 * **「どんな行を作るか」をこの 1 関数に集約**し、両方が同じものを使う。
 *
 * ⚠️ 以下は**やってはいけない**（guard テストで固定）:
 *   - 自動化から admin-marketing の API を内部 HTTP で呼ぶ
 *   - ScheduledEmails を別形式で作る
 *   - dispatcher を直接起動する / メール送信 API を直接呼ぶ
 *   - 既存キューと違う deliveryKey を作る
 *
 * ── 送信経路は 1 本のまま ─────────────────────────────────────
 * この契約が作るのは **ScheduledEmails の PENDING 行**だけ。
 * 実際の送信は既存 dispatcher（`MARKETING_CAMPAIGN_DISPATCH_ENABLED`）が担う。
 */

/** マーケティングジョブの目印（既存 `marketingDispatchGate` と同じ値を使う） */
export const ENQUEUE_CREATED_BY = 'admin-marketing';
export const ENQUEUE_JOB_ID_PREFIX = 'mkt-';
export const ENQUEUE_TARGET_PLAN_PREFIX = 'campaign:';

/** ScheduledEmails へ書いてよい列（**これ以外は 1 つも書かない**） */
export const SCHEDULED_ALLOWED_FIELDS = Object.freeze([
  'Subject', 'Content', 'Recipients', 'ScheduledFor', 'Status',
  'CreatedBy', 'JobId', 'RecipientCount', 'TargetPlan', 'Notes',
]);

const str = (v) => String(v ?? '').trim();
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

/**
 * JobId。**既存の `mkt-` 接頭辞を保つ**（既存 dispatcher の判定に乗るため）。
 * 自動化のときは runId を混ぜて、どの配信回のジョブか後から辿れるようにする。
 */
export function buildJobId({ campaignId, version, fingerprint, index, automationRunId }) {
  const base = `${ENQUEUE_JOB_ID_PREFIX}${str(campaignId)}-v${int(version)}`;
  const fp = str(fingerprint).slice(0, 8);
  const n = int(index) || 1;
  if (str(automationRunId)) {
    // `auto:<id>:<date>` の `:` は JobId で扱いにくいので `-` にする
    const safe = str(automationRunId).replace(/[:|]/g, '-');
    return `${base}-${safe}-${n}`;
  }
  return `${base}-${fp}-${n}`;
}

/**
 * ScheduledEmails 1 ジョブ分の Notes。
 * **何を送ったか**を後から照合できるようにする（アドレスは入れない）。
 */
export function buildJobNotes({
  campaignId, campaignVersion, shellVersionNote, contentHash, edited,
  handoffNote, automationId, automationRunId, operationId, snapshotFingerprint,
}) {
  const parts = [
    `marketing campaign ${str(campaignId)} v${int(campaignVersion)}`,
    str(shellVersionNote),
    `content:${str(contentHash).slice(0, 12)}${edited ? ' edited' : ''}`,
  ];
  if (str(handoffNote)) parts.push(str(handoffNote));
  // 自動化由来なら、どの自動化・どの配信回・どの操作かを刻む（監査・突合用）
  if (str(automationId)) {
    parts.push(`auto:${str(automationId)}`);
    if (str(automationRunId)) parts.push(`run:${str(automationRunId)}`);
    if (str(operationId)) parts.push(`op:${str(operationId)}`);
    if (str(snapshotFingerprint)) parts.push(`snap:${str(snapshotFingerprint).slice(0, 12)}`);
  }
  return parts.filter(Boolean).join(' ');
}

/**
 * ScheduledEmails 1 ジョブ分の fields。**手動送信と自動配信で同一**。
 *
 * @param {{
 *   subject, html, emails: string[], scheduledAtIso, jobId,
 *   campaignId, campaignVersion, notes,
 * }} input
 */
export function buildScheduledEmailFields({
  subject, html, emails, scheduledAtIso, jobId, campaignId, notes,
}) {
  const list = Array.isArray(emails) ? emails : [];
  return {
    Subject: str(subject),
    Content: String(html ?? ''),
    Recipients: list.join(', '),
    ScheduledFor: str(scheduledAtIso),
    Status: 'PENDING',
    CreatedBy: ENQUEUE_CREATED_BY,
    JobId: str(jobId),
    RecipientCount: list.length,
    TargetPlan: `${ENQUEUE_TARGET_PLAN_PREFIX}${str(campaignId)}`,
    Notes: str(notes),
  };
}

/** 許可列だけか。**1 つでも外れたら書かない** */
export function assertOnlyScheduledFields(fields) {
  const keys = Object.keys(fields || {});
  if (keys.length === 0) return false;
  return keys.every((k) => SCHEDULED_ALLOWED_FIELDS.includes(k));
}

/**
 * 自動化が enqueue するときに**必ず固定する値**。
 * ここに欠けがあれば enqueue しない（後から追跡できない配信を作らない）。
 */
export const REQUIRED_AUTOMATION_CONTEXT = Object.freeze([
  'automationId', 'automationRunId', 'operationId', 'recipientKey',
  'campaignId', 'campaignVersion', 'shellVersion', 'contentHash',
  'scheduledAt', 'eligibilityEvaluatedAt', 'snapshotFingerprint',
]);

export function validateAutomationContext(ctx) {
  const missing = REQUIRED_AUTOMATION_CONTEXT.filter((k) => {
    const v = ctx ? ctx[k] : undefined;
    return v === undefined || v === null || String(v).trim() === '';
  });
  return { ok: missing.length === 0, missing };
}

export default buildScheduledEmailFields;
