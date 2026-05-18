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
import { countAudience, BRAND_TO_BASE_NAME, EXCLUSION_POLICY } from '../../src/lib/newsletter/audience-counter.js';
// 2026-05-19: Airtable READ-ONLY 共通モジュールに統合（重複実装を解消、preview と send で同一経路）
import {
  fetchCustomersReadOnly,
  loadBlacklistEmails,
  airtableStatusHint,
  AirtableFetchError,
  BRAND_TO_BASE_ID_ENV,
} from '../../src/lib/newsletter/airtable-fetch.js';

// 既存 export 互換性のため再 export（外部 caller がいる場合への保険）
export { AirtableFetchError };

const MOCK_RECIPIENTS = [
  'preview-user-1@example.com',
  'preview-user-2@example.com',
];

const SUPPORTED_CAMPAIGN_TYPES = new Set([
  'daily-main-race-nankan',
]);

const SUPPORTED_AUDIENCE_MODES = new Set(['mock', 'real-count-only']);

const CUSTOMERS_TABLE = 'Customers';

/**
 * structured_error レスポンスを HTTP 200 で返す（Cloudflare 5xx 書き換え回避）
 *
 * 2026-05-17 改訂: origin が 5xx を返すと Cloudflare 前段が generic 502
 * (text/plain "error code: 502") に書き換える事象が観測されたため、
 * **既知のサーバ側エラーは HTTP 200 + body.success=false + structured_error=true** で
 * 返却し、運用者が admin UI で原因を直接読めるようにする。
 *
 * 4xx クライアントエラー (bad JSON / unknown brand / unsupported audienceMode 等) は
 * Cloudflare が透過するためそのまま 4xx を返す（既存仕様互換）。
 *
 * @param {object} headers - レスポンスヘッダ
 * @param {object} opts
 * @param {number} opts.httpStatusSource - 本来意図していた HTTP status (500/502/503 等、デバッグ用)
 * @param {string} opts.errorClass - エラー分類 slug（missing-env / airtable-customers-fetch / airtable-blacklist-fetch / audience-count / unexpected-handler-error）
 * @param {string} opts.error - 短いメッセージ
 * @param {object} [opts.extra] - 追加フィールド（airtableStatus / errorType / hint / brand / table / 等）
 */
function structuredErrorResponse(headers, { httpStatusSource, errorClass, error, extra = {} }) {
  return new Response(
    JSON.stringify({
      success: false,
      structured_error: true,
      httpStatusSource,
      errorClass,
      error,
      pii: 'none-exposed',
      queriedAt: new Date().toISOString(),
      ...extra,
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

  try {
    return await handleRequest(request, headers);
  } catch (unexpected) {
    // 最終防衛線: 関数本体の未捕捉例外も Cloudflare の generic 502 を回避するため
    // HTTP 200 + structured_error JSON で返す。
    // 例外メッセージは name と message のみ（自分のコードが投げたもの、PII なし）。
    return structuredErrorResponse(headers, {
      httpStatusSource: 500,
      errorClass: 'unexpected-handler-error',
      error: 'unexpected handler error',
      extra: {
        name: unexpected?.name || 'Error',
        message: unexpected?.message || 'unknown error',
      },
    });
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
    // 2026-05-19 Phase 2.5+: renderer に注目馬 / CTA URL を渡せるよう forward
    featuredHorse: requestedFeaturedHorse,
    links: requestedLinks,
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

  // featuredHorse / links を validate（不正値は preview 段階で 400 に倒す。renderer 側にも防御あり）
  // featuredHorse: object かつ name が非空文字列のときのみ採用、それ以外は null
  let featuredHorse = null;
  if (requestedFeaturedHorse != null) {
    if (typeof requestedFeaturedHorse !== 'object' || Array.isArray(requestedFeaturedHorse)) {
      return new Response(
        JSON.stringify({ error: 'featuredHorse must be an object', got: typeof requestedFeaturedHorse }),
        { status: 400, headers }
      );
    }
    const name = typeof requestedFeaturedHorse.name === 'string' ? requestedFeaturedHorse.name.trim() : '';
    if (name) {
      featuredHorse = {
        name,
        // number は number | string どちらでも許容（renderer 側で String() + escape）
        number: requestedFeaturedHorse.number != null ? requestedFeaturedHorse.number : '',
        role: typeof requestedFeaturedHorse.role === 'string' && requestedFeaturedHorse.role.trim() ? requestedFeaturedHorse.role.trim() : '本命',
      };
    }
  }

  // links: { free, premium } を https:// のみ受け入れる（javascript: / data: 等を拒否）
  let links = null;
  if (requestedLinks != null) {
    if (typeof requestedLinks !== 'object' || Array.isArray(requestedLinks)) {
      return new Response(
        JSON.stringify({ error: 'links must be an object', got: typeof requestedLinks }),
        { status: 400, headers }
      );
    }
    const safeHttps = (u) => typeof u === 'string' && /^https:\/\//i.test(u);
    const linkErrors = [];
    if (requestedLinks.free != null && !safeHttps(requestedLinks.free)) linkErrors.push('links.free must be https://');
    if (requestedLinks.premium != null && !safeHttps(requestedLinks.premium)) linkErrors.push('links.premium must be https://');
    if (linkErrors.length > 0) {
      return new Response(
        JSON.stringify({ error: 'invalid links', detail: linkErrors }),
        { status: 400, headers }
      );
    }
    links = {};
    if (safeHttps(requestedLinks.free)) links.free = requestedLinks.free;
    if (safeHttps(requestedLinks.premium)) links.premium = requestedLinks.premium;
  }

  // 本文レンダリング
  let subject;
  let bodyHtml;
  try {
    ({ subject, bodyHtml } = renderDailyMainRace({ campaignDate, targetRace, brand, featuredHorse, links }));
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
      // 旧 503 → 200 + structured_error (Cloudflare 5xx 書き換え回避)
      return structuredErrorResponse(headers, {
        httpStatusSource: 503,
        errorClass: 'missing-env',
        error: 'audienceMode=real-count-only requires Airtable env vars',
        extra: {
          mode: 'real-count-only',
          brand,
          missingEnv,
          hint: 'Use a READ-ONLY scoped Personal Access Token. Falls back to audienceMode=mock if not set.',
        },
      });
    }

    let records;
    try {
      records = await fetchCustomersReadOnly(baseId, apiKey);
    } catch (e) {
      // 旧 502 → 200 + structured_error
      const isAirtableErr = e instanceof AirtableFetchError;
      const airtableStatus = isAirtableErr ? e.airtableStatus : null;
      const airtableErrorType = isAirtableErr ? e.airtableErrorType : 'UNKNOWN';
      return structuredErrorResponse(headers, {
        httpStatusSource: 502,
        errorClass: 'airtable-customers-fetch',
        error: 'airtable fetch failed (READ-ONLY)',
        extra: {
          mode: 'real-count-only',
          brand,
          baseSource: BRAND_TO_BASE_NAME[brand],
          envName: baseIdEnvName,
          table: CUSTOMERS_TABLE,
          airtableStatus,
          airtableErrorType,
          page: isAirtableErr ? e.page : null,
          hint: airtableStatusHint(airtableStatus),
        },
      });
    }

    // EmailBlacklist 取得（brand 別: AK のみ READ、KI は skip）
    // 失敗してもエラー化せず空 Set + status コードで継続（共通 helper を使用）
    const { emails: blacklistEmails, status: blacklistStatus } = await loadBlacklistEmails({
      brand,
      baseId,
      apiKey,
    });

    let counts;
    try {
      const today = new Date().toISOString().slice(0, 10);
      counts = countAudience({
        records,
        brand,
        audienceTypeFilter: audienceType,
        today,
        blacklistEmails,
      });
    } catch (e) {
      // countAudience が予期せぬ例外を投げた場合（不正な record shape など）も
      // 旧 500 → 200 + structured_error で返す
      return structuredErrorResponse(headers, {
        httpStatusSource: 500,
        errorClass: 'audience-count',
        error: 'audience count failed',
        extra: {
          mode: 'real-count-only',
          brand,
          baseSource: BRAND_TO_BASE_NAME[brand],
          recordCount: records.length,
          name: e?.name || 'Error',
          message: e?.message || 'unknown error',
        },
      });
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
      unsubscribeExcluded: counts.unsubscribeExcluded,
      blacklistExcluded: counts.blacklistExcluded,
      blacklistStatus,
      exclusionPolicy: EXCLUSION_POLICY,
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
        // 2026-05-19 Phase 2.5+: admin が renderer に渡された値を確認できるようエコー
        featuredHorse,
        links,
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
