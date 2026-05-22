// ステップメール 配信予定ドライラン（READ-ONLY・送信なし・Airtable書込みなし）
//
// 役割: StepEnrollments を read-only で読み、「指定日(asOfDate)時点で送信対象になる
//       ステップが各何件あるか」を集計する。送信もenqueueもしない。
//
// 設計: NEWSLETTER_AUTOMATION_AIRTABLE_DESIGN.md 確定.5/.7、step-sequences.js（コード定数）。
//   - 該当条件: Status=active AND CurrentStepNumber==step.stepNumber
//               AND EnrolledAt + step.delayDays(カレンダー日) <= asOfDate
//   - 既送信除外: CampaignDeliveries に (StepSequenceId,StepNumber,RecipientEmail) が
//                 status sent/queued で存在 → 送信済み/送信中扱いで除外
//   - free 適格性: 既存 resolveAudienceRecipients(5-tier除外) と突合し、free 以外 /
//                  unsubscribe / blacklist / withdrawn を除外（converted は送らない）
//   - PII 非露出: email / 氏名 / record id は返さず件数のみ
//
// 安全フラグ:
//   - 本関数は READ-ONLY のため STEP_EMAIL_AUTOMATION_ENABLED / NEWSLETTER_AUTOMATION_ENABLED
//     ガードは不要（送信もenqueueもしない）。
//   - 将来 Phase 3 で「実際に enqueue / 送信する」関数を作る際は、master の
//     NEWSLETTER_AUTOMATION_ENABLED に加えて STEP_EMAIL_AUTOMATION_ENABLED（既定false）
//     ガードを必ず入れること（両 true のときだけ送信）。本関数はその送信ゼロの事前検証用。
//
// 注意: enroll がまだ無い段階（Phase 2.2）では全件 0 が正常。

import {
  fetchCustomersReadOnly,
  loadBlacklistEmails,
} from '../../src/lib/newsletter/airtable-fetch.js';
import { resolveAudienceRecipients } from '../../src/lib/newsletter/audience-resolver.js';
import { listSteps, getSequence } from '../../src/lib/newsletter/step-sequences.js';

const DEFAULT_BRAND = 'analytics-keiba';
const DEFAULT_SEQUENCE_ID = 'analytics-keiba:signup-onboarding';
const DAY_MS = 24 * 60 * 60 * 1000;

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/** UTC のその日の0時ミリ秒（カレンダー日差分用） */
function startOfUtcDayMs(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Airtable テーブル全件 read-only 取得（ページネーション対応） */
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
      mode: 'step-due-preview', sideEffects: 'none', pii: 'none-exposed',
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
  const asOfDateRaw = body.asOfDate || null;

  if (asOfDateRaw && !/^\d{4}-\d{2}-\d{2}$/.test(asOfDateRaw)) {
    return new Response(JSON.stringify({ error: 'asOfDate must be YYYY-MM-DD', got: asOfDateRaw }), { status: 400, headers });
  }
  const asOfDate = asOfDateRaw || new Date().toISOString().slice(0, 10);
  const asOfDayMs = Date.UTC(Number(asOfDate.slice(0, 4)), Number(asOfDate.slice(5, 7)) - 1, Number(asOfDate.slice(8, 10)));

  const seq = getSequence(sequenceId);
  if (!seq) {
    return new Response(JSON.stringify({ error: 'unknown sequenceId', got: sequenceId }), { status: 400, headers });
  }
  const steps = listSteps(sequenceId);

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return structuredError(headers, 503, 'missing-env', 'AIRTABLE_API_KEY / AIRTABLE_BASE_ID is not set');
  }

  try {
    // 1) active な StepEnrollments（対象シーケンス）を read-only 取得
    const enrollFormula = `AND({StepSequenceId}='${sequenceId}', {Status}='active')`;
    const enrollments = await fetchAllRecords(AIRTABLE_BASE_ID, AIRTABLE_API_KEY, 'StepEnrollments', enrollFormula);

    // 2) 当該シーケンスの CampaignDeliveries（既送信/送信中の突合用）
    const delivFormula = `AND({StepSequenceId}='${sequenceId}', OR({Status}='sent', {Status}='queued'))`;
    const deliveries = await fetchAllRecords(AIRTABLE_BASE_ID, AIRTABLE_API_KEY, 'CampaignDeliveries', delivFormula);
    const deliveredSet = new Set(
      deliveries.map((r) => `${normalizeEmail(r.fields.RecipientEmail)}::${r.fields.StepNumber}`),
    );

    // 3) free 適格集合（5-tier 除外）を取得し突合
    const customers = await fetchCustomersReadOnly(AIRTABLE_BASE_ID, AIRTABLE_API_KEY);
    const { emails: blacklistEmails, status: blacklistStatus } = await loadBlacklistEmails({
      brand, baseId: AIRTABLE_BASE_ID, apiKey: AIRTABLE_API_KEY,
    });
    const audience = resolveAudienceRecipients({
      records: customers, brand, audienceTypeFilter: 'free', today: asOfDate, blacklistEmails,
    });
    const freeEligible = new Set(audience.emails);

    // 4) ステップ別に集計
    const stepStats = {};
    for (const s of steps) stepStats[`step${s.stepNumber}_day${s.delayDays}`] = { due: 0, alreadyDelivered: 0, notFreeEligible: 0, toSend: 0 };

    let activeEnrollments = 0;
    let dueTotal = 0;
    let toSendTotal = 0;

    for (const e of enrollments) {
      activeEnrollments += 1;
      const email = normalizeEmail(e.fields.RecipientEmail);
      const cur = Number(e.fields.CurrentStepNumber);
      const step = steps.find((s) => s.stepNumber === cur);
      if (!step) continue; // 全消化済み等
      const enrolledMs = startOfUtcDayMs(e.fields.EnrolledAt);
      if (enrolledMs === null) continue;
      const dueMs = enrolledMs + step.delayDays * DAY_MS;
      if (dueMs > asOfDayMs) continue; // まだ送信日に達していない

      const key = `step${step.stepNumber}_day${step.delayDays}`;
      stepStats[key].due += 1;
      dueTotal += 1;

      if (deliveredSet.has(`${email}::${step.stepNumber}`)) { stepStats[key].alreadyDelivered += 1; continue; }
      if (!freeEligible.has(email)) { stepStats[key].notFreeEligible += 1; continue; }
      stepStats[key].toSend += 1;
      toSendTotal += 1;
    }

    return new Response(
      JSON.stringify({
        success: true,
        mode: 'step-due-preview',
        sideEffects: 'airtable-read-only',
        brand,
        sequenceId,
        asOfDate,
        sequence: { name: seq.sequenceName, triggerType: seq.triggerType, stepCount: steps.length },
        activeEnrollments,
        dueTotal,
        toSendTotal,
        stepStats,
        freeEligibleTotal: audience.counts.matchedCount,
        blacklistStatus,
        note:
          'READ-ONLY dry-run. No email sent, no enqueue, no Airtable write. ' +
          'enroll がまだ無い段階では全件 0 が正常（Phase 2.2）。' +
          'toSend = due かつ free適格(5-tier除外通過) かつ 未送信(CampaignDeliveries突合)。',
        pii: 'none-exposed-counts-only',
        queriedAt: new Date().toISOString(),
      }),
      { status: 200, headers },
    );
  } catch (e) {
    return structuredError(headers, 500, 'step-due-preview-failed', 'step due preview failed', {
      name: e?.name || 'Error', message: e?.message || 'unknown error',
    });
  }
}
