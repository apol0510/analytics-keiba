// 完全自動化メルマガ配信システム - dry-run プレビュー API
//
// 仕様（2026-05-16 時点）:
//  - SendGrid を呼ばない（常に）
//  - Airtable WRITE は呼ばない（常に）
//  - ファイルを書き込まない（常に）
//  - mode は 'dry-run' 固定（test / production はまだ実装しない）
//  - audienceMode='mock'（既定）: 受信者はモック2名のみ、Airtable も読まない（副作用ゼロ）
//  - audienceMode='real-count-only': brand 対応の Airtable Base を READ-ONLY で参照し、
//    AudienceType=<指定値> に該当する Customers の **件数のみ** を返す。
//    email / name / AirtableRecordId など PII は一切レスポンスに含めない。
//    deliveryKey サンプルはモック受信者のまま（実 email を露出させない）。
//
// 入力（POST JSON）:
//   {
//     "brand": "analytics-keiba",
//     "serviceType": "analytics-keiba",
//     "campaignType": "daily-main-race-nankan",
//     "campaignDate": "2026-05-14",
//     "audienceType": "free",
//     "audienceMode": "mock" | "real-count-only",  // 任意、既定 "mock"
//     "targetRace": {
//       "raceId": "nankan:2026-05-14:KAW:R11",
//       "venue": "川崎",
//       "raceNumber": 11,
//       "raceName": "メインレース",
//       "postTime": "20:10"
//     }
//   }

import { getBrandConfig, validateBrandFromEmail } from '../../src/lib/newsletter/brand-config.js';
import { computeContentHash } from '../../src/lib/newsletter/content-hash.js';
import { computeDeliveryKey, describeDeliveryKeyTemplate } from '../../src/lib/newsletter/delivery-key.js';
import { renderDailyMainRace } from '../../src/lib/newsletter/render-daily-main-race.js';
import { countAudience, BRAND_TO_BASE_NAME } from '../../src/lib/newsletter/audience-counter.js';

const MOCK_RECIPIENTS = [
  'preview-user-1@example.com',
  'preview-user-2@example.com',
];

const SUPPORTED_CAMPAIGN_TYPES = new Set([
  'daily-main-race-nankan',
]);

const SUPPORTED_AUDIENCE_MODES = new Set(['mock', 'real-count-only']);

const BRAND_TO_BASE_ID_ENV = {
  'analytics-keiba': 'AIRTABLE_BASE_ID_ANALYTICS_KEIBA',
  'keiba-intelligence': 'AIRTABLE_BASE_ID_KEIBA_INTELLIGENCE',
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const CUSTOMERS_TABLE = 'Customers';

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

/**
 * Airtable Customers を GET でページネーション取得（READ-ONLY 明示）
 * 失敗時は AirtableFetchError を throw（安全フィールドのみ）
 */
async function fetchCustomersReadOnly(baseId, apiKey) {
  const records = [];
  let offset = null;
  let pageCount = 0;

  do {
    pageCount += 1;
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${CUSTOMERS_TABLE}`);
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
        table: CUSTOMERS_TABLE,
        message: `network error reaching airtable: name=${networkErr?.name || 'Error'} page=${pageCount}`,
      });
    }

    if (!res.ok) {
      const airtableErrorType = await extractAirtableErrorType(res);
      throw new AirtableFetchError({
        airtableStatus: res.status,
        airtableErrorType,
        page: pageCount,
        table: CUSTOMERS_TABLE,
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
        table: CUSTOMERS_TABLE,
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
 * Airtable HTTP status から、運用者向けの対処ヒントを返す（PII なし、固定文字列のみ）
 */
function airtableStatusHint(airtableStatus) {
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

export default async function handler(request) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  try {
    return await handleRequest(request, headers);
  } catch (unexpected) {
    // 最終防衛線: ここまで来たら関数本体の予期しない例外。
    // Cloudflare/Netlify edge の generic 502 (text/plain) を出さないため、JSON で返す。
    // 例外メッセージは name と message のみ（自分のコードが投げたもの。PII は含まない）。
    return new Response(
      JSON.stringify({
        error: 'unexpected handler error',
        name: unexpected?.name || 'Error',
        message: unexpected?.message || 'unknown error',
      }),
      { status: 500, headers }
    );
  }
}

async function handleRequest(request, headers) {
  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers });
  }

  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: `Method ${request.method} not allowed` }),
      { status: 405, headers }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'invalid JSON body' }),
      { status: 400, headers }
    );
  }

  const {
    brand,
    serviceType,
    campaignType,
    campaignDate,
    audienceType,
    targetRace,
    fromEmail: requestedFromEmail,
    fromName: requestedFromName,
    audienceMode: requestedAudienceMode,
  } = body || {};

  const audienceMode = requestedAudienceMode || 'mock';
  if (!SUPPORTED_AUDIENCE_MODES.has(audienceMode)) {
    return new Response(
      JSON.stringify({
        error: 'unsupported audienceMode',
        supportedAudienceModes: [...SUPPORTED_AUDIENCE_MODES],
        got: audienceMode,
      }),
      { status: 400, headers }
    );
  }

  // 必須項目チェック
  const missing = [];
  if (!brand) missing.push('brand');
  if (!serviceType) missing.push('serviceType');
  if (!campaignType) missing.push('campaignType');
  if (!campaignDate) missing.push('campaignDate');
  if (!audienceType) missing.push('audienceType');
  if (!targetRace) missing.push('targetRace');
  if (missing.length > 0) {
    return new Response(
      JSON.stringify({ error: 'missing required fields', missing }),
      { status: 400, headers }
    );
  }

  // campaignDate 形式チェック
  if (!/^\d{4}-\d{2}-\d{2}$/.test(campaignDate)) {
    return new Response(
      JSON.stringify({ error: 'campaignDate must be YYYY-MM-DD', got: campaignDate }),
      { status: 400, headers }
    );
  }

  // campaignType の対応チェック（最小構成では nankan daily のみ）
  if (!SUPPORTED_CAMPAIGN_TYPES.has(campaignType)) {
    return new Response(
      JSON.stringify({
        error: 'unsupported campaignType (minimal preview supports only daily-main-race-nankan)',
        supportedCampaignTypes: [...SUPPORTED_CAMPAIGN_TYPES],
        got: campaignType,
      }),
      { status: 400, headers }
    );
  }

  // ブランド設定取得
  let brandCfg;
  try {
    brandCfg = getBrandConfig(brand);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 400, headers }
    );
  }

  const fromEmail = requestedFromEmail || brandCfg.defaultFromEmail;
  const fromName = requestedFromName || brandCfg.defaultFromName;

  // brand-fromEmail 整合チェック（dry-run でも必ず通す）
  try {
    validateBrandFromEmail(brand, fromEmail);
  } catch (e) {
    return new Response(
      JSON.stringify({
        error: 'brand-from validation failed',
        detail: e.message,
        brand,
        fromEmail,
        allowedDomains: brandCfg.allowedDomains,
      }),
      { status: 400, headers }
    );
  }

  // 本文レンダリング
  let subject;
  let bodyHtml;
  try {
    ({ subject, bodyHtml } = renderDailyMainRace({ campaignDate, targetRace, brand }));
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'render failed', detail: e.message }),
      { status: 400, headers }
    );
  }

  const contentHash = computeContentHash(subject, bodyHtml);

  // sample deliveryKey 生成（実 email を露出させないため、real-count-only でもモック使用）
  const extraKey = targetRace?.raceId ? `race:${targetRace.raceId}` : '';
  const sampleDeliveryKeys = MOCK_RECIPIENTS.map((recipientEmail) => ({
    recipientEmail,
    deliveryKey: computeDeliveryKey({
      brand,
      serviceType,
      campaignType,
      campaignDate,
      audienceType,
      recipientEmail,
      contentHash,
      fromEmail,
      extraKey,
    }),
  }));

  // audience ブロックを mode 別に組み立て
  let audienceBlock;
  let sideEffects = 'none';

  if (audienceMode === 'real-count-only') {
    const apiKey = process.env.AIRTABLE_API_KEY;
    const baseIdEnvName = BRAND_TO_BASE_ID_ENV[brand];
    const baseId = baseIdEnvName ? process.env[baseIdEnvName] : null;

    const missingEnv = [];
    if (!apiKey) missingEnv.push('AIRTABLE_API_KEY');
    if (!baseId) missingEnv.push(baseIdEnvName || `AIRTABLE_BASE_ID_<${brand}>`);
    if (missingEnv.length > 0) {
      return new Response(
        JSON.stringify({
          error: 'audienceMode=real-count-only requires Airtable env vars',
          missingEnv,
          hint: 'Use a READ-ONLY scoped Personal Access Token. Falls back to audienceMode=mock if not set.',
        }),
        { status: 503, headers }
      );
    }

    let records;
    try {
      records = await fetchCustomersReadOnly(baseId, apiKey);
    } catch (e) {
      const isAirtableErr = e instanceof AirtableFetchError;
      const airtableStatus = isAirtableErr ? e.airtableStatus : null;
      const airtableErrorType = isAirtableErr ? e.airtableErrorType : 'UNKNOWN';
      return new Response(
        JSON.stringify({
          error: 'airtable fetch failed (READ-ONLY)',
          brand,
          baseSource: BRAND_TO_BASE_NAME[brand],
          envName: baseIdEnvName,
          table: CUSTOMERS_TABLE,
          airtableStatus,
          airtableErrorType,
          page: isAirtableErr ? e.page : null,
          hint: airtableStatusHint(airtableStatus),
        }),
        { status: 502, headers }
      );
    }

    let counts;
    try {
      const today = new Date().toISOString().slice(0, 10);
      counts = countAudience({
        records,
        brand,
        audienceTypeFilter: audienceType,
        today,
      });
    } catch (e) {
      // countAudience が予期せぬ例外を投げた場合（不正な record shape など）も JSON で返す
      return new Response(
        JSON.stringify({
          error: 'audience count failed',
          brand,
          baseSource: BRAND_TO_BASE_NAME[brand],
          recordCount: records.length,
          name: e?.name || 'Error',
          message: e?.message || 'unknown error',
        }),
        { status: 500, headers }
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    sideEffects = 'airtable-read-only';
    audienceBlock = {
      source: 'airtable-read-only',
      audienceMode: 'real-count-only',
      brand,
      base: BRAND_TO_BASE_NAME[brand],
      audienceTypeFilter: audienceType,
      today,
      totalCustomers: counts.totalCustomers,
      matchedCount: counts.matchedCount,
      withdrawnExcluded: counts.withdrawnExcluded,
      audienceTypeBreakdown: counts.audienceTypeBreakdown,
      matchedStatusBreakdown: counts.matchedStatusBreakdown,
      pii: 'none-exposed',
      note: 'Emails / names / record ids are not exposed. This is a dry-run count only.',
      queriedAt: new Date().toISOString(),
    };
  } else {
    audienceBlock = {
      source: 'mock',
      audienceMode: 'mock',
      sampleRecipients: MOCK_RECIPIENTS,
      mockRecipientCount: MOCK_RECIPIENTS.length,
      note: 'Send audienceMode="real-count-only" to count real Customers via Airtable READ.',
    };
  }

  return new Response(
    JSON.stringify({
      success: true,
      mode: 'dry-run',
      sideEffects,
      campaign: {
        brand,
        serviceType,
        campaignType,
        campaignDate,
        audienceType,
        fromEmail,
        fromName,
        targetRace,
        subject,
        contentHash,
        contentPreview: bodyHtml.slice(0, 2000),
        contentLength: bodyHtml.length,
      },
      audience: audienceBlock,
      deliveryKey: {
        template: describeDeliveryKeyTemplate(),
        extraKey,
        samples: sampleDeliveryKeys,
      },
      validation: {
        brandFromEmailValid: true,
        sendgridSenderAuthRequired: true,
        sendgridSenderAuthChecked: false,
        warnings: [
          `${fromEmail} が SendGrid Sender Authentication / Domain Authentication 済みかは手動確認が必要`,
        ],
      },
      timestamp: new Date().toISOString(),
    }),
    { status: 200, headers }
  );
}
