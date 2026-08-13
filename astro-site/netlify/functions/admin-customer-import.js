/**
 * admin-customer-import.js — 外部保有リスト（約 13,000 件）の**下見だけ**を行う（read-only）
 *
 * ── この Function がすること ──────────────────────────────────
 *   1. 管理者が選んだ CSV を受け取り、文字コードを判別して読む
 *   2. AK の Customers / EmailBlacklist / 配信基盤の停止リストと突合する
 *   3. **件数と理由コードだけ**を返す
 *   4. その下見を、あとから動かせない形（`importPreviewId` + 各種ハッシュ）で固定する
 *
 * ── この Function が絶対にしないこと ─────────────────────────
 *   - Airtable への書き込み（PATCH / POST を組み立てない。**関数内に write の綴りを持たない**）
 *   - メール送信（SendGrid の送信エンドポイントを組み立てない）
 *   - **アドレス・氏名・recordId を応答へ載せない**（ログにも出さない）
 *   - CSV の中身をどこかへ保存する（下見の保存先は実 CSV 受領後に決める）
 *
 * 実際の取り込み（Customers の作成・更新）は **別 Phase**。
 * `CUSTOMER_IMPORT_WRITE_ENABLED` が true でも、この Function には書き込み経路が無い。
 *
 * ── なぜ admin-marketing.js に足さないか ──────────────────────
 * あちらは「送信の入口」で、SendGrid 由来の禁止事項（送信エンドポイントを持たない・
 * 宛先を返さない）が guard で固定されている。取り込みは責務も危険の質も違うので分ける。
 */

import {
  buildImportRows, hashBytes, PARSER_VERSION, MAX_FILE_BYTES, MAX_ROWS, CSV_ERROR_LABEL,
} from '../../src/lib/crm/csvParse.js';
import {
  buildImportPreview, mapColumns, normalizeEmail, buildBatchId,
  KNOWN_COLUMNS, IMPORT_REASON_LABEL, VERDICT_CANONICAL,
} from '../../src/lib/crm/customerImport.js';
import {
  buildPreviewRecord, buildPreviewId, describePreview, PREVIEW_TTL_MS, RULE_VERSION,
} from '../../src/lib/crm/importPreview.js';
import {
  isCustomerImportWriteEnabled, describeImportRollback, DEFAULT_BATCH_SIZE,
} from '../../src/lib/crm/importJobPlan.js';
import { FIRST_RUN_MAX_ROWS } from '../../src/lib/crm/importWritePlan.js';
import { fetchProviderSuppression } from '../../src/lib/marketing/providerSuppression.js';
import { fetchEmailBlacklistReadOnly, buildBlacklistEmailSet } from '../../src/lib/newsletter/airtable-fetch.js';
import { buildAkFacts } from '../../src/lib/crm/importAkFacts.js';
import { mergeImportFiles, toPreviewRows } from '../../src/lib/crm/importMergePlan.js';
import { parseTestRecipientsEnv } from '../../src/lib/newsletter/test-recipients.js';
import { lookupCustomersByEmails } from '../../src/lib/crm/customerEmailLookup.js';

const CUSTOMERS_TABLE = 'Customers';

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

/**
 * CSV のアドレスに一致する Customers を**名指しで**引く（read-only・書き込みヘルパーは置かない）。
 *
 * 🛡️ **Customers の全件走査へ戻さないこと。**
 *    旧実装は無フィルタで先頭 6,000 件だけ読んで打ち切っていた。Customers 15,962 件では
 *    **約 10,000 人が「AK に居ない」と判定**され、取り込むと既存会員のレコードが二重に作られる
 *    （同一アドレス 2 件 → `auth/customerLookup` が CONFLICT で本人のログインを拒否する）。
 *    上限を上げても直らない（160 ページ = Airtable の毎秒 5 リクエスト制限で最短 32 秒）。
 *
 *    知りたいのは「AK の全員」ではなく「**CSV のアドレスが AK に居るか**」だけなので、
 *    コストは顧客数ではなく **CSV の行数**に比例させる。取り落としが起きるくらいなら例外。
 */
async function fetchCustomersForEmails({ KEY, BASE, emails }) {
  const { records } = await lookupCustomersByEmails({
    emails,
    fetchPage: async ({ formula, offset }) => {
      // 式が長いので GET（URL 長制限あり）ではなく listRecords（POST）を使う
      const res = await fetch(
        `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}/listRecords`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageSize: 100, filterByFormula: formula, ...(offset ? { offset } : {}) }),
        },
      );
      if (!res.ok) throw new Error(`${CUSTOMERS_TABLE} lookup failed: HTTP ${res.status}`);
      return res.json();
    },
  });
  return records;
}

/** AK の EmailBlacklist を HARD / SOFT に分ける（`admin-marketing.js` と同じ考え方） */
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

/**
 * 受け入れ仕様を返す（実 CSV を渡す前に「どんな形なら読めるか」を見せる）。
 * **read-only・引数なし**。
 */
function handleSpec() {
  return json(200, {
    mode: 'import-spec',
    sideEffects: 'none',
    encodings: ['UTF-8', 'UTF-8 (BOM 付き)', 'Shift_JIS / CP932'],
    delimiters: ['カンマ区切り'],
    newlines: ['CRLF', 'LF', 'CR'],
    quoting: 'RFC 4180（引用符の中のカンマ・改行・"" に対応）',
    limits: {
      maxBytes: MAX_FILE_BYTES,
      maxRows: MAX_ROWS,
      note: '13,000 行を想定。列の順番は不同でよい。空行は無視する',
    },
    requiredColumns: ['email'],
    optionalColumns: Object.entries(KNOWN_COLUMNS)
      .filter(([k]) => k !== 'email').map(([k, v]) => ({ column: k, meaning: v })),
    unknownColumns: '取り込まない（名前だけ件数と一緒に報告する）',
    parserVersion: PARSER_VERSION,
    ruleVersion: RULE_VERSION,
    previewTtlMinutes: Math.round(PREVIEW_TTL_MS / 60000),
    notice: '列名のゆらぎは別名表で吸収します。実 CSV の列が決まったら別名表を増やしてください。',
  });
}

/**
 * CSV の下見。**書き込みなし・件数だけ返す**。
 *
 * @param {{ req: object, KEY: string, BASE: string, now: number }} input
 */
async function handlePreviewCsv({ req, KEY, BASE, now }) {
  const b64 = String(req.contentBase64 || '');
  if (!b64) return json(400, { error: 'CSV が指定されていません' });

  let bytes;
  try {
    bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  } catch {
    return json(400, { error: 'ファイルを読み取れませんでした' });
  }
  if (bytes.length === 0) return json(400, { error: CSV_ERROR_LABEL.empty_file });
  if (bytes.length > MAX_FILE_BYTES) return json(413, { error: CSV_ERROR_LABEL.file_too_large });

  // ── 1. 読む（MIME も拡張子も信用しない。中身だけを見る）──
  const parsed = buildImportRows({ bytes, mapColumnsFn: mapColumns });
  if (!parsed.ok) {
    return json(400, {
      mode: 'import-preview',
      sideEffects: 'none',
      ok: false,
      error: CSV_ERROR_LABEL[parsed.error] || '必須列（メールアドレス）が見つかりません',
      errorCode: parsed.error || null,
      missingColumns: parsed.missing || [],
      encoding: parsed.encoding || null,
      detectedColumns: parsed.detectedColumns || [],
      ignoredColumns: parsed.ignoredColumns || [],
    });
  }

  // ── 2. AK 側の事実を読む（read-only）──
  // CSV に載っているアドレスの分だけ AK を引く（全件走査しない）
  const [records, blacklist, provider] = await Promise.all([
    fetchCustomersForEmails({ KEY, BASE, emails: parsed.rows.map((r) => r.email) }),
    loadBlacklistSets({ KEY, BASE }),
    fetchProviderSuppression({ apiKey: process.env.SENDGRID_API_KEY, now }).catch(() => ({ ok: false })),
  ]);
  const testRecipients = parseTestRecipientsEnv(process.env.NEWSLETTER_TEST_RECIPIENTS).recipients;
  const facts = buildAkFacts({
    records, nowMs: now,
    blacklistHard: blacklist.hard, blacklistSoft: blacklist.soft, testRecipients,
  });

  // ── 3. 分類する（判定は純粋モジュール。ここでは数えるだけ）──
  const fileHash = hashBytes(bytes);
  const batchId = buildBatchId({ dateIso: new Date(now).toISOString(), seq: 1 });
  const preview = buildImportPreview({
    rows: parsed.rows,
    existingEmails: facts.existing,
    duplicateInAk: facts.duplicateInAk,
    paidEmails: facts.paid,
    unsubscribedEmails: facts.unsubscribed,
    hardBounceEmails: facts.hardBounce,
    softBounceEmails: facts.softBounce,
    suspendedEmails: facts.suspended,
    testEmails: facts.testAccounts,
    // 配信基盤の停止リストを読めなければ null → 全員「要確認」へ倒す（fail closed）
    providerSuppressed: provider && provider.ok ? provider.emails : null,
    batchId,
    nowMs: now,
  });

  // ── 4. 下見を固定する（差し替え・改ざん・期限切れを弾く材料）──
  const record = buildPreviewRecord({
    importPreviewId: buildPreviewId({ fileHash, createdAtMs: now }),
    fileHash,
    normalizedHeaderHash: parsed.headerHash,
    rowCount: preview.総行数,
    classificationCounts: preview.classificationCounts,
    reasonCounts: preview.reasonCounts,
    parserVersion: parsed.parserVersion,
    encoding: parsed.encoding,
    detectedColumns: parsed.detectedColumns,
    ignoredColumns: parsed.ignoredColumns,
    createdAtMs: now,
  });

  // ⚠️ 応答に載せてよいのは**件数・理由コード・ハッシュ・列名だけ**。
  //    アドレス・氏名・recordId・行の中身は 1 つも含めない。
  return json(200, {
    mode: 'import-preview',
    sideEffects: 'none',
    ok: true,
    written: 'なし（まだ取り込まれていません）',
    preview: describePreview(record),
    counts: {
      総行数: preview.総行数,
      新規追加候補: preview.新規追加,
      既存更新候補: preview.既存更新,
      除外: preview.除外,
      要確認: preview.要確認,
      一意アドレス: preview.正規化できた一意アドレス,
      /** 母数 = 全分類の合計。false なら数え方が壊れている */
      balanced: preview.balanced,
    },
    classificationCounts: preview.classificationCounts,
    reasonCounts: preview.reasonCounts,
    reasonLabels: Object.fromEntries(
      Object.keys(preview.reasonCounts || {}).map((k) => [k, IMPORT_REASON_LABEL[k] || k]),
    ),
    verdictLabels: VERDICT_CANONICAL,
    akSnapshot: {
      customers: records.length,
      uniqueEmails: facts.existing.size,
      duplicateEmails: facts.duplicateInAk.size,
      blacklistAvailable: blacklist.ok,
      providerSuppressionAvailable: !!(provider && provider.ok),
      providerNote: provider && provider.ok ? null
        : '配信基盤の停止リストを確認できないため、該当行は「要確認」に倒しています',
    },
    writeEnabled: isCustomerImportWriteEnabled(process.env),
    writeNote: '本番取り込みはこの画面からは実行できません（別承認が必要です）。',
    batchPlanNote: `実行時は ${DEFAULT_BATCH_SIZE} 件単位の子バッチに分割します。`,
    rollback: describeImportRollback(batchId),
  });
}

/**
 * 複数ファイルをまとめて下見する（実運用は 3 ファイル同時）。**書き込みなし**。
 *
 * 1 ファイルずつ見ると「ファイル間の重複」が分からず、同じ人を 2 回作りかねない。
 * ここで**アドレス単位に統合してから**分類する（統合後は 1 アドレス 1 行）。
 */
async function handlePreviewFiles({ req, KEY, BASE, now }) {
  const files = Array.isArray(req.files) ? req.files : [];
  if (files.length === 0) return json(400, { error: 'CSV が指定されていません' });
  if (files.length > 10) return json(400, { error: 'ファイルが多すぎます（10 個まで）' });

  const parsedFiles = [];
  let totalBytes = 0;
  for (const f of files) {
    const name = String(f && f.name ? f.name : '').slice(0, 80);
    let bytes;
    try { bytes = new Uint8Array(Buffer.from(String(f && f.contentBase64 || ''), 'base64')); }
    catch { return json(400, { error: 'ファイルを読み取れませんでした', file: name }); }
    totalBytes += bytes.length;
    if (bytes.length === 0) return json(400, { error: CSV_ERROR_LABEL.empty_file, file: name });
    if (totalBytes > MAX_FILE_BYTES) return json(413, { error: CSV_ERROR_LABEL.file_too_large });

    const parsed = buildImportRows({ bytes, mapColumnsFn: mapColumns });
    if (!parsed.ok) {
      return json(400, {
        mode: 'import-preview-files', sideEffects: 'none', ok: false, file: name,
        error: CSV_ERROR_LABEL[parsed.error] || '必須列（メールアドレス）が見つかりません',
        errorCode: parsed.error || null, missingColumns: parsed.missing || [],
        encoding: parsed.encoding || null,
      });
    }
    parsedFiles.push({ name, bytes, parsed });
  }

  // ── 統合（アドレス単位。氏名は空欄補完のみ・食い違いは要確認）──
  const merged = mergeImportFiles({
    files: parsedFiles.map((p) => ({
      name: p.name,
      rows: p.parsed.rows,
      hasStatusColumn: (p.parsed.detectedColumns || []).includes('status'),
    })),
  });

  // 統合後のアドレスの分だけ AK を引く（全件走査しない）
  const mergedRows = toPreviewRows(merged.entries);
  const [records, blacklist, provider] = await Promise.all([
    fetchCustomersForEmails({ KEY, BASE, emails: mergedRows.map((r) => r.email) }),
    loadBlacklistSets({ KEY, BASE }),
    fetchProviderSuppression({ apiKey: process.env.SENDGRID_API_KEY, now }).catch(() => ({ ok: false })),
  ]);
  const testRecipients = parseTestRecipientsEnv(process.env.NEWSLETTER_TEST_RECIPIENTS).recipients;
  const facts = buildAkFacts({
    records, nowMs: now, blacklistHard: blacklist.hard, blacklistSoft: blacklist.soft, testRecipients,
  });

  const batchId = buildBatchId({ dateIso: new Date(now).toISOString(), seq: 1 });
  const preview = buildImportPreview({
    rows: mergedRows,
    existingEmails: facts.existing,
    duplicateInAk: facts.duplicateInAk,
    paidEmails: facts.paid,
    unsubscribedEmails: facts.unsubscribed,
    hardBounceEmails: facts.hardBounce,
    softBounceEmails: facts.softBounce,
    suspendedEmails: facts.suspended,
    testEmails: facts.testAccounts,
    providerSuppressed: provider && provider.ok ? provider.emails : null,
    batchId,
    nowMs: now,
  });

  const fileHashes = parsedFiles.map((p) => hashBytes(p.bytes));
  const combinedFileHash = hashBytes(new TextEncoder().encode(fileHashes.join('|')));
  const combinedHeaderHash = hashBytes(
    new TextEncoder().encode(parsedFiles.map((p) => p.parsed.headerHash).join('|')),
  ).slice(0, 16);

  const record = buildPreviewRecord({
    importPreviewId: buildPreviewId({ fileHash: combinedFileHash, createdAtMs: now }),
    fileHash: combinedFileHash,
    normalizedHeaderHash: combinedHeaderHash,
    rowCount: preview.総行数,
    classificationCounts: preview.classificationCounts,
    reasonCounts: preview.reasonCounts,
    parserVersion: parsedFiles[0].parsed.parserVersion,
    encoding: [...new Set(parsedFiles.map((p) => p.parsed.encoding))].join(','),
    detectedColumns: [...new Set(parsedFiles.flatMap((p) => p.parsed.detectedColumns))],
    ignoredColumns: [...new Set(parsedFiles.flatMap((p) => p.parsed.ignoredColumns))],
    createdAtMs: now,
  });

  // ⚠️ 応答は**件数・ハッシュ・列名だけ**
  return json(200, {
    mode: 'import-preview-files',
    sideEffects: 'none',
    ok: true,
    written: 'なし（まだ取り込まれていません）',
    files: parsedFiles.map((p, i) => ({
      name: p.name,
      bytes: p.bytes.length,
      rowCount: p.parsed.rowCount,
      encoding: p.parsed.encoding,
      detectedColumns: p.parsed.detectedColumns,
      ignoredColumns: p.parsed.ignoredColumns,
      fileHash: fileHashes[i],
    })),
    mergeStats: merged.stats,
    preview: describePreview(record),
    counts: {
      母数: preview.総行数,
      新規追加候補: preview.新規追加,
      既存更新候補: preview.既存更新,
      除外: preview.除外,
      要確認: preview.要確認,
      balanced: preview.balanced,
    },
    classificationCounts: preview.classificationCounts,
    reasonCounts: preview.reasonCounts,
    reasonLabels: Object.fromEntries(
      Object.keys(preview.reasonCounts || {}).map((k) => [k, IMPORT_REASON_LABEL[k] || k]),
    ),
    verdictLabels: VERDICT_CANONICAL,
    akSnapshot: {
      customers: records.length,
      uniqueEmails: facts.existing.size,
      duplicateEmails: facts.duplicateInAk.size,
      activePaid: facts.paid.size,
      blacklistAvailable: blacklist.ok,
      providerSuppressionAvailable: !!(provider && provider.ok),
    },
    firstRun: {
      作成のみ: true,
      更新しない既存: preview.既存更新,
      上限: FIRST_RUN_MAX_ROWS,
      writeEnabled: isCustomerImportWriteEnabled(process.env),
      note: '初回は CREATE のみ・最大 100 件。既存 Customers は 1 件も更新しません。',
    },
    rollback: describeImportRollback(batchId),
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
  const action = req.action || 'spec';
  const now = Date.now();

  try {
    if (action === 'spec') return handleSpec();
    if (action === 'previewCsv') return await handlePreviewCsv({ req, KEY, BASE, now });
    if (action === 'previewFiles') return await handlePreviewFiles({ req, KEY, BASE, now });
    // 取り込みの実行はこの Function に**存在しない**（別 Phase・別承認）
    if (action === 'run' || action === 'import') {
      return json(501, {
        error: '本番取り込みは未実装です（別 Phase・別承認）',
        writeEnabled: isCustomerImportWriteEnabled(process.env),
      });
    }
    return json(400, { error: `未知の action: ${action}` });
  } catch (e) {
    // ⚠️ 例外メッセージに CSV の中身が混ざる可能性があるので**そのまま出さない**
    console.error('❌ [admin-customer-import] 処理に失敗しました');
    return json(500, { error: 'internal error' });
  }
};

export default handler;
