// ステップメール reconcile（Phase 3.3）
//
// 役割: step enqueue 由来の ScheduledEmails ジョブの送信完了状態をもとに、
//       CampaignDeliveries（queued→sent）と StepEnrollments（CurrentStepNumber++）を更新する。
//       execute-scheduled-emails-background は一切変更しない（後段 reconcile 専用）。
//
// 設計: NEWSLETTER_AUTOMATION_AIRTABLE_DESIGN.md P3.4。
//   - 対象: ScheduledEmails.Status='SENT' ∧ FailedCount=0（FailedCount>0 のジョブは保留＝進めない）
//   - CampaignDeliveries: ScheduledEmailJobId で突合し Status='queued' のものだけ → 'sent'（SentAt）
//   - StepEnrollments: RecipientEmail + StepSequenceId で突合し CurrentStepNumber++
//       最終 step を超えたら Status='completed' / CompletedAt
//   - CurrentStepNumber は enqueue 時には進めず、reconcile 成功時のみ進める。
//
// 二重ガード（P3.3）:
//   - dryRun=true（既定）: READ-ONLY。更新計画のみ返す（PATCH/POST/DELETE に到達しない）。
//   - dryRun=false（live）: STEP_EMAIL_AUTOMATION_ENABLED==='true' のときのみ更新。
//       未設定/false は skipped no-op。NEWSLETTER_AUTOMATION_ENABLED は送信エンジン用で reconcile では変更しない。
//
// 多重 reconcile 防止:
//   - CampaignDeliveries.Status='sent' は再処理しない（queued のみ対象）。
//   - StepEnrollments が completed/converted/removed/unsubscribed のものは進めない（active のみ）。
//   - 同じ jobId を再実行しても、既に sent 化済み delivery は対象外なので CurrentStepNumber は二重に進まない。

import { getStep, getMaxStepNumber } from '../../src/lib/newsletter/step-sequences.js';

const DEFAULT_SEQUENCE_ID = 'analytics-keiba:signup-onboarding';

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchAllRecords(baseId, apiKey, table, filterByFormula) {
  const out = [];
  let offset;
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (filterByFormula) params.set('filterByFormula', filterByFormula);
    if (offset) params.set('offset', offset);
    const res = await fetch(`https://api.airtable.com/v0/${baseId}/${table}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`${table} fetch failed: HTTP ${res.status} ${t.slice(0, 120)}`);
    }
    const data = await res.json();
    out.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return out;
}

// === 以下は live(dryRun=false) でのみ呼ばれる WRITE ヘルパー ===
// （STEP_EMAIL_AUTOMATION_ENABLED==='true' ガードを通過した後のみ到達する）

async function patchRecords(baseId, apiKey, table, records) {
  for (const batch of chunk(records, 10)) {
    const res = await fetch(`https://api.airtable.com/v0/${baseId}/${table}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: batch }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`${table} patch failed: HTTP ${res.status} ${t.slice(0, 160)}`);
    }
  }
}

function structuredError(headers, httpStatusSource, errorClass, error, extra = {}) {
  return new Response(
    JSON.stringify({
      success: false, structured_error: true, httpStatusSource, errorClass, error,
      mode: 'reconcile-step-deliveries', sideEffects: 'none', pii: 'none-exposed',
      queriedAt: new Date().toISOString(), ...extra,
    }),
    { status: 200, headers },
  );
}

export default async function handler(request) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (request.method === 'OPTIONS') return new Response('', { status: 200, headers });
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: `Method ${request.method} not allowed` }), { status: 405, headers });
  }

  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const dryRun = body.dryRun !== false; // 既定 true
  const live = !dryRun;
  const jobIdFilter = typeof body.jobId === 'string' && body.jobId ? body.jobId : null;
  const sequenceId = body.sequenceId || DEFAULT_SEQUENCE_ID;
  const limit = Number.isInteger(body.limit) && body.limit > 0 ? body.limit : null;

  // 🛡️ live は STEP_EMAIL_AUTOMATION_ENABLED==='true' のときのみ。未設定/false は no-op。
  if (live && process.env.STEP_EMAIL_AUTOMATION_ENABLED !== 'true') {
    return new Response(
      JSON.stringify({
        success: true, skipped: true, reason: 'step email automation disabled',
        flag: 'STEP_EMAIL_AUTOMATION_ENABLED', flagValue: process.env.STEP_EMAIL_AUTOMATION_ENABLED ?? null,
        mode: 'reconcile-step-deliveries:live', sideEffects: 'none',
        hint: "live reconcile は STEP_EMAIL_AUTOMATION_ENABLED='true' のときのみ。dryRun=true で計画確認可。",
        timestamp: new Date().toISOString(),
      }),
      { status: 200, headers },
    );
  }

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return structuredError(headers, 503, 'missing-env', 'AIRTABLE_API_KEY / AIRTABLE_BASE_ID is not set');
  }

  const nowIso = new Date().toISOString();

  try {
    // 1) reconcile 候補の ScheduledEmails ジョブ: step enqueue 由来・SENT・FailedCount=0
    //    （CreatedBy='step-enqueue'。jobId 指定時はそれに限定）
    let jobFormula = `AND({CreatedBy}='step-enqueue', {Status}='SENT')`;
    if (jobIdFilter) jobFormula = `AND({JobId}='${jobIdFilter}', {CreatedBy}='step-enqueue', {Status}='SENT')`;
    let jobs = await fetchAllRecords(AIRTABLE_BASE_ID, AIRTABLE_API_KEY, 'ScheduledEmails', jobFormula);
    // FailedCount>0 は保留（進めない）
    jobs = jobs.filter((j) => Number(j.fields.FailedCount || 0) === 0);
    if (limit) jobs = jobs.slice(0, limit);

    const jobIds = jobs.map((j) => j.fields.JobId).filter(Boolean);

    // 2) 対象 CampaignDeliveries（queued のみ・該当 JobId）
    const plannedDeliveryUpdates = []; // CampaignDeliveries patch records（live のみ適用）
    const enrollmentAdvanceByEmail = new Map(); // email -> max stepNumber that completed（前進判定用）
    let candidateDeliveries = 0;

    if (jobIds.length > 0) {
      // CampaignDeliveries を JobId 単位で取得（queued のみ）
      for (const jid of jobIds) {
        const dels = await fetchAllRecords(AIRTABLE_BASE_ID, AIRTABLE_API_KEY, 'CampaignDeliveries',
          `AND({ScheduledEmailJobId}='${jid}', {Status}='queued')`);
        for (const d of dels) {
          candidateDeliveries += 1;
          const email = normalizeEmail(d.fields.RecipientEmail);
          const stepNumber = Number(d.fields.StepNumber);
          plannedDeliveryUpdates.push({ id: d.id, fields: { Status: 'sent', SentAt: nowIso } });
          // この email がどの step を完了したか（最大 stepNumber を採用）
          const prev = enrollmentAdvanceByEmail.get(email);
          if (prev === undefined || stepNumber > prev.completedStep) {
            enrollmentAdvanceByEmail.set(email, { completedStep: stepNumber, deliverySeq: d.fields.StepSequenceId || sequenceId });
          }
        }
      }
    }

    // 3) StepEnrollments の前進計画（active かつ CurrentStepNumber==completedStep のものだけ +1）
    const plannedEnrollmentUpdates = [];
    const enrollmentPlanDetail = [];
    if (enrollmentAdvanceByEmail.size > 0) {
      for (const [email, info] of enrollmentAdvanceByEmail.entries()) {
        const seqId = info.deliverySeq || sequenceId;
        const enr = await fetchAllRecords(AIRTABLE_BASE_ID, AIRTABLE_API_KEY, 'StepEnrollments',
          `AND({RecipientEmail}='${email.replace(/'/g, "\\'")}', {StepSequenceId}='${seqId}', {Status}='active')`);
        if (enr.length === 0) continue; // active 無し（completed/converted/removed/unsubscribed 等）は進めない
        const e = enr[0];
        const cur = Number(e.fields.CurrentStepNumber);
        // 二重防止: 完了した step が現在のカーソルと一致するものだけ前進
        if (cur !== info.completedStep) continue;
        const maxStep = getMaxStepNumber(seqId);
        const next = cur + 1;
        const fields = next > maxStep
          ? { CurrentStepNumber: next, Status: 'completed', CompletedAt: nowIso }
          : { CurrentStepNumber: next };
        plannedEnrollmentUpdates.push({ id: e.id, fields });
        enrollmentPlanDetail.push({
          recordId: e.id, fromStep: cur, toStep: next,
          willComplete: next > maxStep, stepSequenceId: seqId,
        });
      }
    }

    // 4) live のときのみ実書込み（順序: CampaignDeliveries → StepEnrollments）
    let applied = { deliveriesUpdated: 0, enrollmentsAdvanced: 0 };
    if (live) {
      if (plannedDeliveryUpdates.length > 0) {
        await patchRecords(AIRTABLE_BASE_ID, AIRTABLE_API_KEY, 'CampaignDeliveries', plannedDeliveryUpdates);
        applied.deliveriesUpdated = plannedDeliveryUpdates.length;
      }
      if (plannedEnrollmentUpdates.length > 0) {
        await patchRecords(AIRTABLE_BASE_ID, AIRTABLE_API_KEY, 'StepEnrollments', plannedEnrollmentUpdates);
        applied.enrollmentsAdvanced = plannedEnrollmentUpdates.length;
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        mode: live ? 'reconcile-step-deliveries:live' : 'reconcile-step-deliveries:dry-run',
        sideEffects: live ? 'airtable-write:CampaignDeliveries+StepEnrollments' : 'airtable-read-only',
        live,
        sequenceId,
        jobIdFilter,
        reconcileCandidateJobs: jobs.length,
        candidateDeliveries, // queued で sent 化する CampaignDeliveries 件数
        plannedDeliveryUpdates: plannedDeliveryUpdates.length,
        plannedEnrollmentUpdates: plannedEnrollmentUpdates.length,
        enrollmentPlanDetail, // PII なし（recordId/step のみ）
        applied: live ? applied : undefined,
        note: live
          ? 'LIVE reconcile. CampaignDeliveries queued→sent ＋ StepEnrollments CurrentStepNumber++ を適用。'
          : 'DRY-RUN only. No Airtable write. 対象ジョブが無ければ全て 0 が正常（現状 enqueue 未実施）。' +
            ' 対象: ScheduledEmails(CreatedBy=step-enqueue ∧ SENT ∧ FailedCount=0) → queued な CampaignDeliveries → active enrollment を +1。',
        pii: 'none-exposed-counts-and-recordids-only',
        queriedAt: new Date().toISOString(),
      }),
      { status: 200, headers },
    );
  } catch (e) {
    return structuredError(headers, 500, 'reconcile-step-deliveries-failed', 'reconcile step deliveries failed', {
      name: e?.name || 'Error', message: e?.message || 'unknown error',
    });
  }
}
