/**
 * admin-customer-import-run.js — 取り込みの**実行**（初回は CREATE のみ・最大 100 件）
 *
 * ⚠️ **既定では 1 件も書かない。** 実行には二重のゲートが要る:
 *      1. `CUSTOMER_IMPORT_WRITE_ENABLED=true`（production では未設定のまま）
 *      2. 実行時の確認文字列 `IMPORT <batchId> <件数>`（バッチと件数に紐づく）
 *    どちらか一方でも欠ければ **fail closed**（何も書かずに 403 / 409 を返す）。
 *
 * ── 初回の方針（変更禁止）────────────────────────────────────
 *   - 作るのは CREATE_CANDIDATE だけ。**UPDATE_CANDIDATE は 1 件も触らない**
 *   - 既存 Customers を上書きしない（PATCH を組み立てない）
 *   - EXCLUDED / REVIEW_REQUIRED は書かない
 *   - 書き込み直前に Customers を**取り直して**重複を再判定する
 *   - 課金・特典・決済・配信停止のフィールドには触らない（allow-list で構造的に禁止）
 *   - メールは 1 通も送らない（この Function に送信経路が無い）
 *
 * 読み取り専用の下見は `admin-customer-import.js`。**責務を分けている**。
 */

import {
  buildImportRows, hashBytes, MAX_FILE_BYTES, CSV_ERROR_LABEL,
} from '../../src/lib/crm/csvParse.js';
import { buildImportPreview, mapColumns, normalizeEmail, buildBatchId, ROW_VERDICT } from '../../src/lib/crm/customerImport.js';
import { mergeImportFiles, toPreviewRows } from '../../src/lib/crm/importMergePlan.js';
import { buildAkFacts } from '../../src/lib/crm/importAkFacts.js';
import { fetchProviderSuppression } from '../../src/lib/marketing/providerSuppression.js';
import { fetchEmailBlacklistReadOnly, buildBlacklistEmailSet } from '../../src/lib/newsletter/airtable-fetch.js';
import { parseTestRecipientsEnv } from '../../src/lib/newsletter/test-recipients.js';
import {
  FIRST_RUN_MAX_ROWS, canRunFirstImport, buildConfirmationPhrase, describeRunPlan,
  OPTIONAL_AUDIT_FIELDS, RUN_REJECT, RUN_REJECT_LABEL,
} from '../../src/lib/crm/importWritePlan.js';
import { writeCreateBatch } from '../../src/lib/crm/importWriteExecutor.js';

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

/** Customers に実在する列（監査列を「無いのに書く」事故を防ぐ） */
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
 * ファイル群 → 統合 → 分類 → CREATE 対象の抽出。
 * **下見と同じ関数**を使うので、下見で見た件数と実行対象がズレない。
 */
async function buildRunContext({ req, KEY, BASE, now }) {
  const files = Array.isArray(req.files) ? req.files : [];
  if (files.length === 0) return { ok: false, status: 400, error: 'CSV が指定されていません' };

  const parsedFiles = [];
  let totalBytes = 0;
  for (const f of files) {
    const name = String(f && f.name ? f.name : '').slice(0, 80);
    let bytes;
    try { bytes = new Uint8Array(Buffer.from(String(f && f.contentBase64 || ''), 'base64')); }
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
  const combinedFileHash = hashBytes(new TextEncoder().encode(fileHashes.join('|')));

  // 下見で見たファイルと同じか（差し替え検知）
  const expected = String(req.expectedFileHash || '');
  if (expected && expected !== combinedFileHash) {
    return { ok: false, status: 409, error: '下見のときと違うファイルです', code: 'file_changed' };
  }

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

  const rows = toPreviewRows(merged.entries);
  const batchId = String(req.batchId || '') || buildBatchId({ dateIso: new Date(now).toISOString(), seq: 1 });
  const preview = buildImportPreview({
    rows,
    existingEmails: facts.existing,
    duplicateInAk: facts.duplicateInAk,
    paidEmails: facts.paid,
    unsubscribedEmails: facts.unsubscribed,
    hardBounceEmails: facts.hardBounce,
    softBounceEmails: facts.softBounce,
    suspendedEmails: facts.suspended,
    testEmails: facts.testAccounts,
    providerSuppressed: provider && provider.ok ? provider.emails : null,
    batchId, nowMs: now,
  });

  // ── CREATE 対象だけを取り出す（分類と同じ順序で再判定する）──
  const createRows = [];
  for (const e of merged.entries) {
    if (e.flags && e.flags.length > 0) continue;                    // 要確認・状態除外は対象外
    const email = e.email;
    if (!email) continue;
    if (facts.unsubscribed.has(email) || facts.hardBounce.has(email) || facts.softBounce.has(email)) continue;
    if (facts.suspended.has(email) || facts.testAccounts.has(email)) continue;
    if (facts.paid.has(email)) continue;                            // 現役有料会員は取り込まない
    if (facts.duplicateInAk.has(email)) continue;                   // AK 側重複は自動統合しない
    if (!(provider && provider.ok)) continue;                       // 停止リスト不明なら書かない
    if (provider.emails.has(email)) continue;
    if (facts.existing.has(email)) continue;                        // 既存は UPDATE 候補 → **初回は触らない**
    createRows.push({ email, name: e.name || '' });
  }

  return {
    ok: true, parsedFiles, fileHashes, combinedFileHash, merged, facts, preview,
    createRows, batchId, availableFields, providerOk: !!(provider && provider.ok),
  };
}

/** 実行前の確認（**書き込みなし**）。画面はこの内容を出してから実行させる */
async function handlePlan({ req, KEY, BASE, now }) {
  const ctx = await buildRunContext({ req, KEY, BASE, now });
  if (!ctx.ok) return json(ctx.status, { error: ctx.error, code: ctx.code || null });

  const runCount = Math.min(FIRST_RUN_MAX_ROWS, ctx.createRows.length);
  return json(200, {
    mode: 'import-run-plan',
    sideEffects: 'none',
    writeEnabled: process.env.CUSTOMER_IMPORT_WRITE_ENABLED === 'true',
    plan: describeRunPlan({
      batchId: ctx.batchId,
      previewId: ctx.preview.previewFingerprint,
      fileHashes: ctx.fileHashes,
      previewHash: ctx.combinedFileHash,
      createTotal: ctx.createRows.length,
      runCount,
      skippedExisting: ctx.preview.既存更新,
      availableFields: ctx.availableFields || new Set(),
    }),
    confirmationPhrase: buildConfirmationPhrase({ batchId: ctx.batchId, count: runCount }),
    counts: {
      母数: ctx.preview.総行数,
      CREATE候補: ctx.preview.新規追加,
      更新しない既存: ctx.preview.既存更新,
      除外: ctx.preview.除外,
      要確認: ctx.preview.要確認,
      今回実行: runCount,
    },
    notice: 'これは実行前の確認です。**まだ 1 件も作成していません。**',
  });
}

/** 実行（二重ゲート通過時のみ） */
async function handleRun({ req, KEY, BASE, now }) {
  const ctx = await buildRunContext({ req, KEY, BASE, now });
  if (!ctx.ok) return json(ctx.status, { error: ctx.error, code: ctx.code || null });

  const requested = Number(req.count);
  const gate = canRunFirstImport({
    env: process.env,
    confirmation: req.confirmation,
    batchId: ctx.batchId,
    requestedCount: requested,
    availableCount: ctx.createRows.length,
    previewOk: ctx.providerOk === true,
  });
  if (!gate.allowed) {
    // ⚠️ ここで止まる＝**書き込みゼロ**
    return json(gate.reason === RUN_REJECT.WRITE_DISABLED ? 403 : 409, {
      mode: 'import-run',
      written: 0,
      error: RUN_REJECT_LABEL[gate.reason] || '実行できません',
      code: gate.reason,
      confirmationPhrase: buildConfirmationPhrase({
        batchId: ctx.batchId, count: Math.min(FIRST_RUN_MAX_ROWS, ctx.createRows.length),
      }),
    });
  }

  const nowIso = new Date(now).toISOString();
  const target = ctx.createRows.slice(0, gate.willCreate);

  const result = await writeCreateBatch({
    rows: target,
    batchId: ctx.batchId,
    nowIso,
    availableFields: ctx.availableFields,
    doneRowKeys: new Set(),
    // 書き込み直前に取り直した既存アドレス（buildRunContext で取得済み）
    existingEmails: new Set(ctx.facts.existing),
    maxWrites: gate.willCreate,
    deps: {
      // まとめ書き（Airtable は 1 リクエスト 10 件まで）。
      // 1 件ずつだと 100 件で約 35 秒かかり、同期 Function の上限を超えて
      // 「作成済みだけ残って結果が返らない」状態になるため、既定はこちら。
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

  console.log('✅ [customer-import] 実行完了:', {
    batchId: ctx.batchId, created: result.created,
    skippedExisting: result.skippedExisting, failed: result.failed,
    bulkRequests: result.bulkRequests, singleRequests: result.singleRequests,
  });

  return json(200, {
    mode: 'import-run',
    batchId: ctx.batchId,
    created: result.created,
    skippedExisting: result.skippedExisting,
    skippedAlreadyDone: result.skippedDone,
    failed: result.failed,
    bulkRequests: result.bulkRequests,
    singleRequests: result.singleRequests,
    reconciliation: result.reconciliation,
    audit: result.audit,   // rowKey のハッシュのみ（PII なし）
    rollbackHint: `Source = "customer-import:${ctx.batchId}" の行が対象です。`,
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
    if (action === 'plan') return await handlePlan({ req, KEY, BASE, now });
    if (action === 'run') return await handleRun({ req, KEY, BASE, now });
    return json(400, { error: `未知の action: ${action}` });
  } catch (e) {
    // ⚠️ 例外メッセージに CSV の値が混ざりうるので**そのまま返さない**
    console.error('❌ [customer-import-run] 処理に失敗しました');
    return json(500, { error: 'internal error' });
  }
};

export default handler;
