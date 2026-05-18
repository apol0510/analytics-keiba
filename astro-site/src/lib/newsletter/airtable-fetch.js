// Airtable READ-ONLY 取得共通モジュール
//
// 役割:
//   preview / send / queue / scheduled の全経路で **同じ取得関数** を使い、
//   Customers と EmailBlacklist の取得・正規化を統一する。
//   preview の matchedCount と実送信の対象件数が構造的にズレないことを保証する。
//
// 設計原則:
//   - 副作用は Airtable への GET のみ（PATCH/POST/DELETE は呼ばない）
//   - API key / Base ID / Authorization ヘッダは絶対にレスポンス / 例外に含めない
//   - 例外は AirtableFetchError（安全フィールドのみ）で統一
//   - blacklist 取得失敗は致命傷扱いしない（呼び出し側で空 Set で続行）
//
// 仕様: docs/NEWSLETTER_BRAND_BACKFILL_SPEC.md §6 / §7
//       newsletter-preview.js から抽出（2026-05-19）

const CUSTOMERS_TABLE = 'Customers';
const BLACKLIST_TABLE = 'EmailBlacklist';

/** 除外対象とする EmailBlacklist.Status（大文字化後で比較） */
export const EXCLUDED_BLACKLIST_STATUSES = new Set(['HARD_BOUNCE', 'COMPLAINT']);

/**
 * brand → EmailBlacklist テーブルを持つかのマップ
 * 2026-05-17 時点: AK のみ存在、KI は将来追加予定
 */
export const BRAND_HAS_BLACKLIST_TABLE = {
  'analytics-keiba': true,
  'keiba-intelligence': false,
};

/**
 * brand → AIRTABLE_BASE_ID env 変数名のマップ（preview と一致）
 */
export const BRAND_TO_BASE_ID_ENV = {
  'analytics-keiba': 'AIRTABLE_BASE_ID_ANALYTICS_KEIBA',
  'keiba-intelligence': 'AIRTABLE_BASE_ID_KEIBA_INTELLIGENCE',
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 構造化された Airtable 取得エラー。安全フィールドのみ持つ。
 * API key / Base ID / Authorization ヘッダ / Airtable 生レスポンスは絶対に含めない。
 */
export class AirtableFetchError extends Error {
  constructor({ airtableStatus, airtableErrorType, page, table, message }) {
    super(message);
    this.name = 'AirtableFetchError';
    this.airtableStatus = airtableStatus;
    this.airtableErrorType = airtableErrorType;
    this.page = page;
    this.table = table;
  }
}

/**
 * Airtable のエラー応答 body から error.type だけを安全に抽出する。
 * - JSON でなければ 'UNKNOWN'
 * - 値の形式は [A-Z0-9_]{1,64} にホワイトリスト（PII / 任意文字列の混入を防ぐ）
 */
async function extractAirtableErrorType(res) {
  let raw = 'UNKNOWN';
  try {
    const body = await res.json();
    if (body && body.error) {
      if (typeof body.error === 'string') raw = body.error;
      else if (typeof body.error.type === 'string') raw = body.error.type;
    }
  } catch {
    // body が JSON でない（HTML / 空 / バイナリ）→ UNKNOWN のまま
  }
  return /^[A-Z0-9_]{1,64}$/.test(raw) ? raw : 'UNKNOWN';
}

async function fetchAirtableTablePages({ baseId, apiKey, table }) {
  const records = [];
  let offset = null;
  let pageCount = 0;

  do {
    pageCount += 1;
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${table}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);

    let res;
    try {
      res = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (networkErr) {
      throw new AirtableFetchError({
        airtableStatus: 0,
        airtableErrorType: 'NETWORK_ERROR',
        page: pageCount,
        table,
        message: `network error reaching airtable: name=${networkErr?.name || 'Error'} page=${pageCount}`,
      });
    }

    if (!res.ok) {
      const airtableErrorType = await extractAirtableErrorType(res);
      throw new AirtableFetchError({
        airtableStatus: res.status,
        airtableErrorType,
        page: pageCount,
        table,
        message: `airtable fetch failed: status=${res.status} type=${airtableErrorType} page=${pageCount}`,
      });
    }

    let data;
    try {
      data = await res.json();
    } catch {
      throw new AirtableFetchError({
        airtableStatus: res.status,
        airtableErrorType: 'INVALID_JSON_BODY',
        page: pageCount,
        table,
        message: `invalid JSON body from airtable: status=${res.status} page=${pageCount}`,
      });
    }
    records.push(...(data.records || []));
    offset = data.offset || null;

    if (offset) await sleep(220); // Airtable 5rps 対策
  } while (offset);

  return records;
}

/**
 * Airtable Customers を GET でページネーション取得（READ-ONLY 明示）
 */
export function fetchCustomersReadOnly(baseId, apiKey) {
  return fetchAirtableTablePages({ baseId, apiKey, table: CUSTOMERS_TABLE });
}

/**
 * EmailBlacklist を GET でページネーション取得（READ-ONLY 明示）
 */
export function fetchEmailBlacklistReadOnly(baseId, apiKey) {
  return fetchAirtableTablePages({ baseId, apiKey, table: BLACKLIST_TABLE });
}

/**
 * EmailBlacklist 取得失敗のエラーを blacklistStatus 値に分類する
 *  - missing: テーブル未存在（404 / NOT_FOUND 系）→ KI で想定内
 *  - permission-error: PAT scope 不足（403）
 *  - network-error: 通信失敗
 *  - read-error: それ以外（5xx / parse 失敗等）
 *  全て matched 集計は継続させる（blacklistEmails 空 Set で続行）
 */
export function classifyBlacklistError(err) {
  if (!(err instanceof AirtableFetchError)) return 'read-error';
  const s = err.airtableStatus;
  const t = err.airtableErrorType;
  if (s === 404 || t === 'NOT_FOUND' || t === 'TABLE_NOT_FOUND' || t === 'MODEL_NOT_FOUND') return 'missing';
  if (s === 403 || t === 'NOT_AUTHORIZED' || t === 'INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND') return 'permission-error';
  if (s === 0 || t === 'NETWORK_ERROR') return 'network-error';
  return 'read-error';
}

/**
 * EmailBlacklist records から HARD_BOUNCE / COMPLAINT の email Set を構築（純粋関数）
 * - Status は String(x).toUpperCase().trim() で正規化
 * - Email は trim + toLowerCase で正規化（resolveEmail と一致）
 * - PII は外部に出さない（内部 Set のみ）
 */
export function buildBlacklistEmailSet(records) {
  const set = new Set();
  for (const r of records || []) {
    const status = r?.fields?.Status;
    const email = r?.fields?.Email;
    if (!status || !email) continue;
    const normStatus = String(status).toUpperCase().trim();
    if (!EXCLUDED_BLACKLIST_STATUSES.has(normStatus)) continue;
    set.add(String(email).trim().toLowerCase());
  }
  return set;
}

/**
 * blacklist 取得を分類込みで実行する高レベルヘルパー。
 *  - brand が BRAND_HAS_BLACKLIST_TABLE で false の場合は { emails: empty, status: 'not-applicable' }
 *  - 失敗時は { emails: empty, status: classifyBlacklistError(err) } を返し、例外は投げない
 *  - 呼び出し側はこの戻り値をそのまま countAudience / resolveAudienceRecipients に渡せる
 */
export async function loadBlacklistEmails({ brand, baseId, apiKey }) {
  if (!BRAND_HAS_BLACKLIST_TABLE[brand]) {
    return { emails: new Set(), status: 'not-applicable' };
  }
  try {
    const records = await fetchEmailBlacklistReadOnly(baseId, apiKey);
    return { emails: buildBlacklistEmailSet(records), status: 'enabled' };
  } catch (err) {
    return { emails: new Set(), status: classifyBlacklistError(err) };
  }
}

/**
 * Airtable HTTP status から、運用者向けの対処ヒントを返す（PII なし、固定文字列のみ）
 */
export function airtableStatusHint(airtableStatus) {
  if (airtableStatus === 401 || airtableStatus === 403) {
    return '401/403 means PAT scope or base access issue. Verify the PAT has data.records:read scope AND the target base is added to its Access list.';
  }
  if (airtableStatus === 404) {
    return '404 means base id or table name issue. Verify the env var value (base id starts with "app...") and the table is literally named "Customers".';
  }
  if (airtableStatus === 429) {
    return '429 means Airtable rate limit (5rps per base). Retry after a few seconds.';
  }
  if (airtableStatus === 0) {
    return 'Network error reaching Airtable. Check function egress or Airtable status page.';
  }
  if (airtableStatus >= 500) {
    return 'Airtable upstream error. Check https://status.airtable.com and retry.';
  }
  return 'Unexpected Airtable status. See https://airtable.com/developers/web/api/errors for details.';
}
