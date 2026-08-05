/**
 * admin-customer-import-job.js — 大量取り込みの**親ジョブ**（開始 1 回・子バッチは 100 件以下）
 *
 * ⚠️ **既定では 1 件も書かない。** 実行には二重のゲートが要る:
 *      1. `CUSTOMER_IMPORT_WRITE_ENABLED=true`（production では未設定のまま）
 *      2. 開始時の確認文字列 `IMPORT-JOB <batchId> <対象総数>`
 *    どちらか一方でも欠ければ **fail closed**（何も書かずに 403 / 409 を返す）。
 *
 * ── 方針（単発 run と同じ・変更禁止）──────────────────────────
 *   - 作るのは CREATE_CANDIDATE だけ。**UPDATE_CANDIDATE は 1 件も触らない**
 *   - 既存 Customers を上書きしない（**PATCH を組み立てない**）
 *   - EXCLUDED / REVIEW_REQUIRED は書かない
 *   - **子バッチのたびに** Customers を取り直して重複を再判定する
 *   - 課金・特典・決済・配信停止のフィールドには触らない（allow-list で構造的に禁止）
 *   - メールは 1 通も送らない（この Function に送信経路が無い）
 *
 * ── 正本は Airtable（重要）────────────────────────────────────
 *   進捗記録は Netlify Blobs に置くが、**Blobs は正本ではない**（last-write-wins・
 *   onlyIf* は best-effort）。二重作成を防ぐのは Customers 側のアドレス実在判定で、
 *   進捗も `Source = customer-import:<batchId>` の実件数から再構成できる。
 *   詳細は `src/lib/crm/importJobModel.js` の冒頭コメント。
 *
 * 1 呼び出し = **子バッチ 1 つ**。画面が完了まで逐次呼び直す（並行に走らせない）。
 */

import { getStore, connectLambda } from '@netlify/blobs';
import { buildImportRows, hashBytes, MAX_FILE_BYTES, CSV_ERROR_LABEL } from '../../src/lib/crm/csvParse.js';
import { mapColumns, normalizeEmail } from '../../src/lib/crm/customerImport.js';
import { mergeImportFiles } from '../../src/lib/crm/importMergePlan.js';
import { buildAkFacts } from '../../src/lib/crm/importAkFacts.js';
import { fetchProviderSuppression } from '../../src/lib/marketing/providerSuppression.js';
import { fetchEmailBlacklistReadOnly, buildBlacklistEmailSet } from '../../src/lib/newsletter/airtable-fetch.js';
import { parseTestRecipientsEnv } from '../../src/lib/newsletter/test-recipients.js';
import { orderEntriesDeterministically, countCreateCandidates } from '../../src/lib/crm/importEligibility.js';
import {
  createImportJob, canStartImportJob, canStepImportJob, cancelImportJob,
  summarizeJobProgress, reconcileImportJob, describeJobRollback,
  buildJobId, buildJobSource, buildJobConfirmation, countChildBatches,
  JOB_CHILD_MAX_ROWS, JOB_REJECT, JOB_REJECT_LABEL, JOB_STATUS,
} from '../../src/lib/crm/importJobModel.js';
import { createImportJobStore, JOB_STORE_NAME } from '../../src/lib/crm/importJobStore.js';
import { runChildBatch } from '../../src/lib/crm/importJobRunner.js';
import { CREATE_ALLOWED_FIELDS, OPTIONAL_AUDIT_FIELDS } from '../../src/lib/crm/importWritePlan.js';

const CUSTOMERS_TABLE = 'Customers';
const MAX_PAGES = 60;

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-secret',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
    },
    body: JSON.stringify(body),
  };
}

async function fetchAllReadOnly({ KEY, BASE, table }) {
  const out = [];
  let offset; let pages = 0;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
    if (!res.ok) throw new Error(`${table} fetch failed: HTTP ${res.status}`);
    const data = await res.json();
    out.push(...(data.records || []));
    offset = data.offset; pages += 1;
    if (offset && pages >= MAX_PAGES) break;
  } while (offset);
  return out;
}

async function loadBlacklistSets({ KEY, BASE }) {
  try {
    const records = await fetchEmailBlacklistReadOnly(BASE, KEY);
    const hard = buildBlacklistEmailSet(records);
    const soft = new Set();
    for (const r of records) {
      const email = normalizeEmail(r?.fields?.Email);
      const status = String(r?.fields?.Status || '').toUpperCase().trim();
      if (email && !hard.has(email) && status) soft.add(email);
    }
    return { ok: true, hard, soft };
  } catch {
    return { ok: false, hard: new Set(), soft: new Set() };
  }
}

async function loadAvailableFields({ KEY, BASE }) {
  try {
    const res = await fetch(`https://api.airtable.com/v0/meta/bases/${BASE}/tables`, {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    if (!res.ok) return null;
    const j = await res.json();
    const t = (j.tables || []).find((x) => x.name === CUSTOMERS_TABLE);
    if (!t) return null;
    return new Set((t.fields || []).map((f) => f.name));
  } catch {
    return null;   // 読めないときは監査列を書かない（fail closed）
  }
}

/**
 * CSV → 統合 → 決定的な並び + **その時点の** Customers 由来の事実。
 * **子バッチのたびに呼ぶ**（既存アドレスを取り直すため）。
 */
async function buildJobContext({ req, KEY, BASE, now }) {
  const files = Array.isArray(req.files) ? req.files : [];
  if (files.length === 0) return { ok: false, status: 400, error: 'CSV が指定されていません' };

  const parsedFiles = [];
  let totalBytes = 0;
  for (const f of files) {
    const name = String(f && f.name ? f.name : '').slice(0, 80);
    let bytes;
    try { bytes = new Uint8Array(Buffer.from(String((f && f.contentBase64) || ''), 'base64')); }
    catch { return { ok: false, status: 400, error: 'ファイルを読み取れませんでした' }; }
    totalBytes += bytes.length;
    if (totalBytes > MAX_FILE_BYTES) return { ok: false, status: 413, error: CSV_ERROR_LABEL.file_too_large };
    const parsed = buildImportRows({ bytes, mapColumnsFn: mapColumns });
    if (!parsed.ok) {
      return { ok: false, status: 400, error: CSV_ERROR_LABEL[parsed.error] || '必須列が見つかりません' };
    }
    parsedFiles.push({ name, bytes, parsed });
  }

  const fileHashes = parsedFiles.map((p) => hashBytes(p.bytes));
  const fileFingerprint = hashBytes(new TextEncoder().encode(fileHashes.join('|')));

  const merged = mergeImportFiles({
    files: parsedFiles.map((p) => ({
      name: p.name, rows: p.parsed.rows,
      hasStatusColumn: (p.parsed.detectedColumns || []).includes('status'),
    })),
  });

  const [records, blacklist, provider, availableFields] = await Promise.all([
    fetchAllReadOnly({ KEY, BASE, table: CUSTOMERS_TABLE }),
    loadBlacklistSets({ KEY, BASE }),
    fetchProviderSuppression({ apiKey: process.env.SENDGRID_API_KEY, now }).catch(() => ({ ok: false })),
    loadAvailableFields({ KEY, BASE }),
  ]);
  const facts = buildAkFacts({
    records, nowMs: now, blacklistHard: blacklist.hard, blacklistSoft: blacklist.soft,
    testRecipients: parseTestRecipientsEnv(process.env.NEWSLETTER_TEST_RECIPIENTS).recipients,
  });

  const entries = orderEntriesDeterministically(merged.entries);
  const providerOk = !!(provider && provider.ok);
  const providerEmails = providerOk ? provider.emails : new Set();

  return {
    ok: true, entries, facts, providerEmails, providerOk,
    availableFields, fileHashes, fileFingerprint, records,
  };
}

/** Blobs をジョブ store の注入インターフェースへアダプトする */
function blobJobStore() {
  const options = { name: JOB_STORE_NAME };
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_API_TOKEN;
  const s = siteID && token ? getStore({ ...options, siteID, token }) : getStore(options);
  return createImportJobStore({
    getJSON: (key) => s.get(key, { type: 'json' }),
    setJSON: (key, value) => s.setJSON(key, value),
    setJSONIfNew: (key, value) => s.setJSON(key, value, { onlyIfNew: true }),
  });
}

/** Airtable 実測の作成件数（**進捗の正本**） */
function countBySource(records, source) {
  return (records || []).filter((r) => String(r?.fields?.Source || '') === source).length;
}

// ── action: plan（read-only・書き込み 0）────────────────────────
async function handlePlan({ req, KEY, BASE, now }) {
  const ctx = await buildJobContext({ req, KEY, BASE, now });
  if (!ctx.ok) return json(ctx.status, { error: ctx.error });

  const batchId = String(req.batchId || '').trim();
  const total = countCreateCandidates({
    entries: ctx.entries, facts: ctx.facts, providerEmails: ctx.providerEmails,
  });
  const childSize = JOB_CHILD_MAX_ROWS;
  const have = ctx.availableFields || new Set();

  return json(200, {
    mode: 'import-job-plan',
    sideEffects: 'none',
    writeEnabled: process.env.CUSTOMER_IMPORT_WRITE_ENABLED === 'true',
    plan: {
      jobId: buildJobId(batchId),
      ImportBatchId: batchId,
      Source: buildJobSource(batchId),
      対象総数: total,
      子バッチ数: countChildBatches(total, childSize),
      子バッチ上限: childSize,
      'まとめ書き（1リクエスト）': 10,
      対象ファイルhash: ctx.fileHashes,
      ファイル指紋: ctx.fileFingerprint,
      書き込む列: CREATE_ALLOWED_FIELDS.filter((f) => !OPTIONAL_AUDIT_FIELDS.includes(f) || have.has(f)),
      停止リスト取得: ctx.providerOk ? '取得できた' : '取得できない（実行しない）',
    },
    confirmationPhrase: buildJobConfirmation({ batchId, total }),
    rollback: describeJobRollback({ batchId, source: buildJobSource(batchId) }),
    notice: 'これは開始前の確認です。**まだ 1 件も作成していません。**',
  });
}

// ── action: start（ジョブを作るだけ。書き込みは step で行う）────
async function handleStart({ req, KEY, BASE, now, store }) {
  const ctx = await buildJobContext({ req, KEY, BASE, now });
  if (!ctx.ok) return json(ctx.status, { error: ctx.error });

  const batchId = String(req.batchId || '').trim();
  const jobId = buildJobId(batchId);
  const total = countCreateCandidates({
    entries: ctx.entries, facts: ctx.facts, providerEmails: ctx.providerEmails,
  });
  const existing = await store.load(jobId);

  const gate = canStartImportJob({
    env: process.env, confirmation: req.confirmation, batchId,
    plannedTotal: total, existingJob: existing, providerOk: ctx.providerOk,
  });
  if (!gate.allowed) {
    return json(gate.reason === JOB_REJECT.WRITE_DISABLED ? 403 : 409, {
      mode: 'import-job-start', written: 0,
      error: JOB_REJECT_LABEL[gate.reason] || '開始できません', code: gate.reason,
      confirmationPhrase: buildJobConfirmation({ batchId, total }),
      job: existing ? summarizeJobProgress(existing) : null,
    });
  }

  const job = createImportJob({
    batchId, fileFingerprint: ctx.fileFingerprint, plannedTotal: total,
    childSize: JOB_CHILD_MAX_ROWS, nowIso: new Date(now).toISOString(),
    startedBy: 'admin',
  });
  const res = await store.create(job);
  if (!res.created) {
    return json(409, {
      mode: 'import-job-start', written: 0,
      error: JOB_REJECT_LABEL[JOB_REJECT.JOB_EXISTS], code: JOB_REJECT.JOB_EXISTS,
      job: res.job ? summarizeJobProgress(res.job) : null,
    });
  }
  return json(200, {
    mode: 'import-job-start', written: 0,
    job: summarizeJobProgress(job),
    rollback: describeJobRollback(job),
    notice: 'ジョブを開始しました。**まだ 1 件も作成していません。**続けて子バッチを実行してください。',
  });
}

// ── action: step（子バッチをちょうど 1 つ進める）────────────────
async function handleStep({ req, KEY, BASE, now, store }) {
  const jobId = buildJobId(String(req.batchId || '').trim());
  const job = await store.load(jobId);
  if (!job) {
    return json(404, {
      mode: 'import-job-step', written: 0,
      error: JOB_REJECT_LABEL[JOB_REJECT.JOB_NOT_FOUND], code: JOB_REJECT.JOB_NOT_FOUND,
    });
  }

  const ctx = await buildJobContext({ req, KEY, BASE, now });
  if (!ctx.ok) return json(ctx.status, { error: ctx.error });

  const gate = canStepImportJob({
    env: process.env, job, nowMs: now,
    fileFingerprint: ctx.fileFingerprint, providerOk: ctx.providerOk,
  });
  if (!gate.allowed) {
    // ⚠️ ここで止まる＝**書き込みゼロ**
    return json(gate.reason === JOB_REJECT.WRITE_DISABLED ? 403 : 409, {
      mode: 'import-job-step', written: 0,
      error: JOB_REJECT_LABEL[gate.reason] || '進められません', code: gate.reason,
      job: summarizeJobProgress(job),
    });
  }

  const nowIso = new Date(now).toISOString();
  const out = await runChildBatch({
    job, entries: ctx.entries, facts: ctx.facts, providerEmails: ctx.providerEmails,
    availableFields: ctx.availableFields, nowMs: now, nowIso, holder: 'admin-ui',
    deps: {
      // まとめ書き（Airtable は 1 リクエスト 10 件まで）
      createRecords: async (fieldsArray) => {
        const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ records: fieldsArray.map((fields) => ({ fields })) }),
        });
        return { ok: res.ok, status: res.status };
      },
      // まとめ書きが失敗したチャンクを 1 件ずつ切り分けるための経路
      createRecord: async (fields) => {
        const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ records: [{ fields }] }),
        });
        return { ok: res.ok, status: res.status };
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
  });

  await store.save(out.job);

  console.log('✅ [customer-import-job] 子バッチ完了:', {
    jobId: out.job.jobId, status: out.job.status,
    created: out.job.totals.created, failed: out.job.totals.failed,
  });

  return json(200, {
    mode: 'import-job-step',
    job: summarizeJobProgress(out.job),
    child: out.result ? {
      created: out.result.created,
      skippedExisting: out.result.skippedExisting,
      skippedAlreadyDone: out.result.skippedDone,
      failed: out.result.failed,
      bulkRequests: out.result.bulkRequests,
      singleRequests: out.result.singleRequests,
      reconciliation: out.result.reconciliation,
      audit: out.result.audit,   // rowKey のハッシュのみ（PII なし）
    } : null,
    除外内訳: out.skipped || {},
    reconciliation: reconcileImportJob({ job: out.job }),
    note: out.note || null,
    完了: out.job.status === JOB_STATUS.COMPLETED || out.job.status === JOB_STATUS.PARTIAL,
  });
}

// ── action: status（read-only）──────────────────────────────────
async function handleStatus({ req, KEY, BASE, now, store }) {
  const jobId = buildJobId(String(req.batchId || '').trim());
  const job = await store.load(jobId);
  if (!job) return json(404, { mode: 'import-job-status', error: JOB_REJECT_LABEL[JOB_REJECT.JOB_NOT_FOUND], code: JOB_REJECT.JOB_NOT_FOUND });

  // **進捗の正本は Airtable**。ジョブ記録と食い違っていないか毎回突合する
  let createdInAirtable = null;
  try {
    const records = await fetchAllReadOnly({ KEY, BASE, table: CUSTOMERS_TABLE });
    createdInAirtable = countBySource(records, job.source);
  } catch { createdInAirtable = null; }

  return json(200, {
    mode: 'import-job-status',
    sideEffects: 'none',
    writeEnabled: process.env.CUSTOMER_IMPORT_WRITE_ENABLED === 'true',
    job: summarizeJobProgress(job),
    reconciliation: reconcileImportJob({ job, createdInAirtable }),
    rollback: describeJobRollback(job),
  });
}

// ── action: cancel（未処理分だけ止める。作成済みは消さない）─────
async function handleCancel({ req, now, store }) {
  const jobId = buildJobId(String(req.batchId || '').trim());
  const job = await store.load(jobId);
  if (!job) return json(404, { mode: 'import-job-cancel', error: JOB_REJECT_LABEL[JOB_REJECT.JOB_NOT_FOUND], code: JOB_REJECT.JOB_NOT_FOUND });

  const cancelled = cancelImportJob({ job, nowIso: new Date(now).toISOString() });
  await store.save(cancelled);
  return json(200, {
    mode: 'import-job-cancel',
    job: summarizeJobProgress(cancelled),
    note: cancelled.cancelNote || null,
    rollback: describeJobRollback(cancelled),
  });
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  const KEY = process.env.AIRTABLE_API_KEY;
  const BASE = process.env.AIRTABLE_BASE_ID;
  if (!SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）' });
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  if (provided !== SECRET) return json(403, { error: 'Forbidden' });
  if (!KEY || !BASE) return json(500, { error: 'Airtable 認証情報が未設定' });

  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const action = req.action || 'plan';
  const now = Date.now();

  try {
    // plan は Blobs を使わない（read-only の下見なので store 初期化も不要）
    if (action === 'plan') return await handlePlan({ req, KEY, BASE, now });

    // ⚠️【BLOCKED】書き込み経路は設計未完了のため**構造的に封じている**。
    //   現行の Blobs 非正本方式では次の 2 点を満たせないことが確認された:
    //     1. 同時実行を fail-closed で拒否できない（Blobs は last-write-wins・onlyIf* は best-effort）
    //     2. 親 ImportJob が正本になっていない（snapshot / 失敗 / 未処理 / cancel 境界 /
    //        operationId を Airtable の Source 件数だけでは復元できない）
    //   Customers 直前照合だけでは TOCTOU が閉じないため、「運用で閉じる」整理は採らない。
    //   → 正本と排他を Upstash Redis へ移す（行単位 SET NX で at-most-once 作成）。
    //     ADR: docs/decisions.md「2026-08-05 — 大量取り込みの正本と排他に Upstash Redis を採用する」
    //   この kill-switch は ADR 承認と Redis 版 claim の実装が済むまで**外さない**。
    if (action === 'start' || action === 'step') {
      return json(403, {
        mode: `import-job-${action}`,
        written: 0,
        error: '取り込みジョブの書き込みは設計未完了のため停止中です（BLOCKED）。',
        code: 'blocked_by_design',
        blocked: {
          理由: [
            '同時実行を fail-closed で拒否できない（Netlify Blobs は last-write-wins）',
            '親 ImportJob が正本になっていない（snapshot / 失敗 / 未処理 / cancel 境界 / operationId を復元できない）',
          ],
          解決方針: '正本と排他を Upstash Redis へ移し、行単位 SET NX で at-most-once 作成にする',
          ADR: 'docs/decisions.md 2026-08-05（Proposed・未承認）',
        },
      });
    }

    // Blobs は classic Function では event から初期化しないと使えない
    connectLambda(event);
    const store = blobJobStore();

    if (action === 'start') return await handleStart({ req, KEY, BASE, now, store });
    if (action === 'step') return await handleStep({ req, KEY, BASE, now, store });
    if (action === 'status') return await handleStatus({ req, KEY, BASE, now, store });
    if (action === 'cancel') return await handleCancel({ req, now, store });
    return json(400, { error: `未知の action: ${action}` });
  } catch (e) {
    // ⚠️ 例外メッセージに CSV の値が混ざりうるので**そのまま返さない**
    console.error('❌ [customer-import-job] 処理に失敗しました');
    return json(500, { error: 'internal error' });
  }
};

export default handler;
