// ステップメール enqueue（Phase 3.1: dryRun 専用・READ-ONLY）
//
// 役割: 指定 step（または全 step）について「もし live 送信したら作成される ScheduledEmails
//       ジョブの計画（件数・cohortサイズ・件名）」を算出して返す。送信もenqueueもしない。
//
// 設計: NEWSLETTER_AUTOMATION_AIRTABLE_DESIGN.md「★Phase 3 設計確定」P3.1〜P3.10。
//   - cohort = due（CurrentStepNumber==step ∧ EnrolledAt+delayDays<=asOfDate）
//             ∧ 5-tier適格（free・unsubscribe/blacklist/withdrawn除外）
//             ∧ 未送信（CampaignDeliveries の sent/queued を突合除外）
//   - step DeliveryKey は contentHash 非依存（extraKey='step:{seqId}:{stepNumber}'、
//     contentHash スロットには step 固定トークン=campaignType を入れる）。
//   - step 本文は per-recipient placeholder を使わない（1ジョブ1本文＝汎用挨拶に解決）。
//
// ⚠️ live パス（CampaignDeliveries 書込み・ScheduledEmails 作成・送信）は Phase 3.2 で、
//    STEP_EMAIL_AUTOMATION_ENABLED ＋ NEWSLETTER_AUTOMATION_ENABLED の両ガード下のみ実装する。
//    本ファイル（Phase 3.1）は dryRun=true 専用で、dryRun=false は早期 return（送信パス未到達）。

import {
  fetchCustomersReadOnly,
  loadBlacklistEmails,
} from '../../src/lib/newsletter/airtable-fetch.js';
import { resolveAudienceRecipients } from '../../src/lib/newsletter/audience-resolver.js';
import { listSteps, getSequence } from '../../src/lib/newsletter/step-sequences.js';
import { computeDeliveryKey } from '../../src/lib/newsletter/delivery-key.js';
import { getBrandConfig } from '../../src/lib/newsletter/brand-config.js';

const DEFAULT_BRAND = 'analytics-keiba';
const DEFAULT_SEQUENCE_ID = 'analytics-keiba:signup-onboarding';
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function startOfUtcDayMs(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** step 本文の per-recipient placeholder を汎用挨拶へ解決（1ジョブ1本文のため） */
function renderGeneric(template) {
  return String(template || '')
    .replace(/\{\{\s*firstName\s*\}\}\s*様/g, '皆様')
    .replace(/\{\{\s*firstName\s*\}\}/g, '皆様');
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
      const text = await res.text().catch(() => '');
      throw new Error(`${table} fetch failed: HTTP ${res.status} ${text.slice(0, 120)}`);
    }
    const data = await res.json();
    out.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return out;
}

function structuredError(headers, httpStatusSource, errorClass, error, extra = {}) {
  return new Response(
    JSON.stringify({
      success: false, structured_error: true, httpStatusSource, errorClass, error,
      mode: 'enqueue-step-emails:dry-run', sideEffects: 'none', pii: 'none-exposed',
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
  const brand = body.brand || DEFAULT_BRAND;
  const sequenceId = body.sequenceId || DEFAULT_SEQUENCE_ID;
  const stepNumberFilter = body.stepNumber != null ? Number(body.stepNumber) : null;
  const asOfDateRaw = body.asOfDate || null;
  const dryRun = body.dryRun !== false; // 既定 true

  // 🛡️ Phase 3.1: live パスは未実装。dryRun=false は送信パスに到達させず早期 return。
  if (!dryRun) {
    return structuredError(headers, 501, 'live-not-implemented',
      'live enqueue is not implemented in Phase 3.1 (dry-run only)', {
        hint: 'live パスは Phase 3.2 で STEP_EMAIL_AUTOMATION_ENABLED + NEWSLETTER_AUTOMATION_ENABLED 両ガード下のみ実装予定。',
      });
  }

  if (asOfDateRaw && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDateRaw)) {
    return new Response(JSON.stringify({ error: 'asOfDate must be YYYY-MM-DD', got: asOfDateRaw }), { status: 400, headers });
  }
  const asOfDate = asOfDateRaw || new Date().toISOString().slice(0, 10);
  const asOfDayMs = Date.UTC(Number(asOfDate.slice(0, 4)), Number(asOfDate.slice(5, 7)) - 1, Number(asOfDate.slice(8, 10)));

  const seq = getSequence(sequenceId);
  if (!seq) return new Response(JSON.stringify({ error: 'unknown sequenceId', got: sequenceId }), { status: 400, headers });
  let steps = listSteps(sequenceId);
  if (stepNumberFilter != null) steps = steps.filter((s) => s.stepNumber === stepNumberFilter);

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return structuredError(headers, 503, 'missing-env', 'AIRTABLE_API_KEY / AIRTABLE_BASE_ID is not set');
  }

  let fromEmail = 'noreply@keiba.link';
  try { fromEmail = getBrandConfig(brand).defaultFromEmail || fromEmail; } catch { /* default */ }

  try {
    // active enrollments（対象シーケンス）
    const enrollments = await fetchAllRecords(AIRTABLE_BASE_ID, AIRTABLE_API_KEY, 'StepEnrollments',
      `AND({StepSequenceId}='${sequenceId}', {Status}='active')`);

    // 既送信/送信中の CampaignDeliveries（突合用）
    const deliveries = await fetchAllRecords(AIRTABLE_BASE_ID, AIRTABLE_API_KEY, 'CampaignDeliveries',
      `AND({StepSequenceId}='${sequenceId}', OR({Status}='sent', {Status}='queued'))`);
    const deliveredSet = new Set(deliveries.map((r) => `${normalizeEmail(r.fields.RecipientEmail)}::${r.fields.StepNumber}`));

    // free 適格集合（5-tier）
    const customers = await fetchCustomersReadOnly(AIRTABLE_BASE_ID, AIRTABLE_API_KEY);
    const { emails: blacklistEmails } = await loadBlacklistEmails({ brand, baseId: AIRTABLE_BASE_ID, apiKey: AIRTABLE_API_KEY });
    const audience = resolveAudienceRecipients({ records: customers, brand, audienceTypeFilter: 'free', today: asOfDate, blacklistEmails });
    const freeEligible = new Set(audience.emails);

    // step ごとに「live なら作る ScheduledEmails ジョブ」の計画を算出
    const plannedJobs = [];
    let totalCohort = 0;
    let allKeysCollisionFree = true;

    for (const step of steps) {
      const cohort = [];
      for (const e of enrollments) {
        if (Number(e.fields.CurrentStepNumber) !== step.stepNumber) continue;
        const enrolledMs = startOfUtcDayMs(e.fields.EnrolledAt);
        if (enrolledMs === null) continue;
        if (enrolledMs + step.delayDays * DAY_MS > asOfDayMs) continue; // 未到達
        const email = normalizeEmail(e.fields.RecipientEmail);
        if (deliveredSet.has(`${email}::${step.stepNumber}`)) continue; // 既送信
        if (!freeEligible.has(email)) continue; // 5-tier 非適格
        cohort.push(email);
      }

      // DeliveryKey（content非依存: contentHash スロット = campaignType 固定トークン）の衝突確認
      const extraKey = `step:${sequenceId}:${step.stepNumber}`;
      const keys = cohort.map((email) => computeDeliveryKey({
        brand, serviceType: brand, campaignType: step.campaignType, campaignDate: asOfDate,
        audienceType: 'free', recipientEmail: email, contentHash: step.campaignType, fromEmail, extraKey,
      }));
      const collisionFree = new Set(keys).size === keys.length;
      if (!collisionFree) allKeysCollisionFree = false;

      const subject = renderGeneric(step.subjectTemplate);
      const bodyPreviewLen = renderGeneric(step.bodyTemplate).length;
      totalCohort += cohort.length;
      plannedJobs.push({
        stepNumber: step.stepNumber,
        delayDays: step.delayDays,
        campaignType: step.campaignType,
        subject,
        bodyLength: bodyPreviewLen,
        cohortSize: cohort.length,
        wouldCreateJob: cohort.length > 0, // cohort 0 ならジョブ作成しない
        deliveryKeyExtraKey: extraKey,
        deliveryKeyCollisionFree: collisionFree,
        deliveryKeyContentIndependent: true,
      });
    }

    return new Response(
      JSON.stringify({
        success: true,
        mode: 'enqueue-step-emails:dry-run',
        sideEffects: 'airtable-read-only',
        live: false,
        brand, sequenceId, asOfDate,
        fromEmail,
        activeEnrollments: enrollments.length,
        plannedJobCount: plannedJobs.filter((j) => j.wouldCreateJob).length,
        totalCohort,
        allDeliveryKeysCollisionFree: allKeysCollisionFree,
        plannedJobs,
        freeEligibleTotal: audience.counts.matchedCount,
        note:
          'DRY-RUN only. No email sent, no enqueue, no Airtable write (CampaignDeliveries/ScheduledEmails 未作成). ' +
          'enroll がまだ無い段階では plannedJobCount=0 / totalCohort=0 が正常。' +
          'step 本文は per-recipient placeholder 不使用（汎用挨拶に解決）。' +
          'live パスは Phase 3.2（STEP_EMAIL_AUTOMATION_ENABLED + NEWSLETTER_AUTOMATION_ENABLED 両ガード）。',
        pii: 'none-exposed-counts-and-subjects-only',
        queriedAt: new Date().toISOString(),
      }),
      { status: 200, headers },
    );
  } catch (e) {
    return structuredError(headers, 500, 'enqueue-step-emails-dryrun-failed', 'enqueue step emails dry-run failed', {
      name: e?.name || 'Error', message: e?.message || 'unknown error',
    });
  }
}
