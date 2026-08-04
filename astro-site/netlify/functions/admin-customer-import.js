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
import { fetchProviderSuppression } from '../../src/lib/marketing/providerSuppression.js';
import { fetchEmailBlacklistReadOnly, buildBlacklistEmailSet } from '../../src/lib/newsletter/airtable-fetch.js';
import { resolveCustomerMarketing, MK_PLAN } from '../../src/lib/marketing/customerMarketingAudience.js';
import { checkSelectable } from '../../src/lib/comeback/comebackGrantPlan.js';
import { parseTestRecipientsEnv } from '../../src/lib/newsletter/test-recipients.js';

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

/** Airtable は**読むだけ**。この Function に書き込みヘルパーを置かない */
async function fetchAllReadOnly({ KEY, BASE, table }) {
  const out = [];
  let offset;
  let pages = 0;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` } });
    if (!res.ok) throw new Error(`${table} fetch failed: HTTP ${res.status}`);
    const data = await res.json();
    out.push(...(data.records || []));
    offset = data.offset;
    pages += 1;
    if (offset && pages >= MAX_PAGES) break;
  } while (offset);
  return out;
}

/**
 * AK 側の事実を「アドレスの集合」に落とす。**呼び出し元へ集合は返さない**
 *（この関数の外へ出るのは件数だけ）。
 */
function buildAkFacts({ records, nowMs, blacklistHard, blacklistSoft, testRecipients }) {
  const existing = new Set();
  const seen = new Map();          // email -> 出現回数（AK 側の重複検出）
  const duplicateInAk = new Set();
  const paid = new Set();
  const unsubscribed = new Set();
  const suspended = new Set();
  const testAccounts = new Set();

  for (const rec of records) {
    const f = (rec && rec.fields) || {};
    const email = normalizeEmail(f.Email);
    if (!email) continue;
    existing.add(email);
    seen.set(email, (seen.get(email) || 0) + 1);
    if (seen.get(email) > 1) duplicateInAk.add(email);

    const mk = resolveCustomerMarketing({ fields: f, nowMs, blacklistEmails: blacklistHard });
    // 現役の有料会員を「無料リスト」として取り込まない
    if (mk.planGroup && mk.planGroup !== MK_PLAN.FREE && mk.contract === 'active') paid.add(email);
    if (mk.suppressionReasons && mk.suppressionReasons.includes('unsubscribed')) unsubscribed.add(email);

    // 停止・テストは既存の単一源で判定する（施策側と基準をそろえる）
    const sel = checkSelectable(f, { duplicateEmail: false });
    if (!sel.ok && sel.reason === 'account_suspended') {
      const status = String(f.Status ?? '').trim().toLowerCase();
      const plan = String(f['プラン'] ?? f.Plan ?? '').trim().toLowerCase();
      if (status === 'test' || plan === 'test') testAccounts.add(email);
      else suspended.add(email);
    }
  }
  for (const t of testRecipients || []) {
    const e = normalizeEmail(t);
    if (e) testAccounts.add(e);
  }
  return {
    existing, duplicateInAk, paid, unsubscribed, suspended, testAccounts,
    hardBounce: blacklistHard, softBounce: blacklistSoft,
  };
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
  const [records, blacklist, provider] = await Promise.all([
    fetchAllReadOnly({ KEY, BASE, table: CUSTOMERS_TABLE }),
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
