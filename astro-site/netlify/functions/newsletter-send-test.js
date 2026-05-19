// メルマガ test-send 関数 (運営者宛のみ実 SendGrid 送信)
//
// 設計方針:
//   - 副作用は SendGrid 呼び出しのみ。Airtable / Customers READ は一切しない (構造的不在)
//   - 宛先は ONLY `NEWSLETTER_TEST_RECIPIENTS` env から取得 (Customers 経路なし)
//   - 多層安全装置:
//       1. NEWSLETTER_TEST_SEND_ENABLED === 'true'
//       2. NEWSLETTER_TEST_RECIPIENTS が 1 件以上
//       3. audienceMode === 'test-send'
//       4. brand × fromEmail 整合 (既存 validateBrandFromEmail)
//       5. SENDGRID_API_KEY 必須
//   - 既存 NEWSLETTER_AUTOMATION_ENABLED は touch しない (本番送信系の安全装置を温存)
//   - email 全文は console.log にも response にも出さない (emailTraceId / domain のみ)
//   - 5xx 既知エラーは HTTP 200 + structured_error (Cloudflare 5xx 書換回避)
//   - subject 接頭辞 [TEST] + 本文先頭にテスト識別バナー
//   - deliveryKey は namespace='test-send' で本番と衝突防止

import { createHash } from 'node:crypto';
import { getBrandConfig, validateBrandFromEmail } from '../../src/lib/newsletter/brand-config.js';
import { computeContentHash } from '../../src/lib/newsletter/content-hash.js';
import { computeDeliveryKey, describeDeliveryKeyTemplate } from '../../src/lib/newsletter/delivery-key.js';
import { renderDailyMainRace } from '../../src/lib/newsletter/render-daily-main-race.js';
import { normalizeRenderOptions } from '../../src/lib/newsletter/render-options-validator.js';
import { parseTestRecipientsEnv, emailTraceId as emailTraceIdRaw } from '../../src/lib/newsletter/test-recipients.js';

const TEST_FROM_EMAIL = 'noreply@keiba.link';
const TEST_FROM_NAME = 'KEIBA Analytics [TEST]';
const SENDGRID_ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';
const SUPPORTED_CAMPAIGN_TYPES = new Set(['daily-main-race-nankan']);
const SUPPORTED_AUDIENCE_MODES = new Set(['test-send']);

// 純粋関数化のため emailTraceId は crypto を bind した closure として使う
function emailTraceId(email) {
  return emailTraceIdRaw(email, { createHash });
}

/** structured_error response (HTTP 200 + body.success=false), Cloudflare 5xx 書換回避 */
function structuredErrorResponse(headers, { httpStatusSource, errorClass, error, extra = {} }) {
  return new Response(
    JSON.stringify({
      success: false,
      structured_error: true,
      httpStatusSource,
      errorClass,
      error,
      mode: 'test-send',
      customersAccessed: false,
      airtableAccessed: false,
      pii: 'none-exposed',
      queriedAt: new Date().toISOString(),
      ...extra,
    }),
    { status: 200, headers },
  );
}

/** SendGrid からのエラーを errorClass に分類 (PII 含まない固定値) */
function classifySendgridError(status) {
  if (status === 0) return 'sendgrid-network-error';
  if (status === 401) return 'sendgrid-auth';
  if (status === 403) return 'sendgrid-forbidden';
  if (status === 400) return 'sendgrid-bad-request';
  if (status === 429) return 'sendgrid-rate-limit';
  if (status >= 500) return 'sendgrid-upstream';
  return 'sendgrid-other';
}

/**
 * 単一宛先に SendGrid /v3/mail/send で POST する。
 * 戻り値はサニタイズ済（email 含まない）。
 *
 * 2026-05-19 Phase 3 修正: 本文末尾の配信停止 footer と RFC 8058 List-Unsubscribe ヘッダーを
 * recipient 単位で付与（send-newsletter.js D4 統一と同パターン）。テスト配信でも本番と同等の
 * unsubscribe 体験を確保し、Gmail / Outlook の登録解除ボタンが正しく表示されるようにする。
 */
async function sendOneViaSendGrid({ apiKey, recipient, subject, htmlBody }) {
  const trace = emailTraceId(recipient);
  const domain = recipient.split('@')[1] || 'unknown';

  // 配信停止 URL（brand 別 unsubscribe フィールドに書き込む）
  const unsubscribeUrl = `https://analytics.keiba.link/.netlify/functions/unsubscribe?email=${encodeURIComponent(recipient)}&brand=analytics-keiba`;

  // 本文末尾に配信停止 footer を append（recipient 固有 URL を含むため per-recipient で構築）
  const htmlBodyWithUnsubscribe = `${htmlBody}
    <hr style="margin: 30px 0; border: none; border-top: 1px solid #e5e7eb;">
    <div style="text-align: center; padding: 20px; background-color: #f9fafb; font-size: 12px; color: #6b7280; font-family: Arial, sans-serif;">
      <p style="margin: 0 0 10px 0;">このメールは KEIBA Analytics [TEST] からお送りしています</p>
      <p style="margin: 10px 0;">
        <a href="${unsubscribeUrl}" style="color: #dc2626; text-decoration: underline;">
          🚫 配信停止はこちら
        </a>
      </p>
    </div>`;

  const emailData = {
    personalizations: [{ to: [{ email: recipient }], subject }],
    from: { name: TEST_FROM_NAME, email: TEST_FROM_EMAIL },
    reply_to: { name: TEST_FROM_NAME, email: TEST_FROM_EMAIL },
    content: [{ type: 'text/html', value: htmlBodyWithUnsubscribe }],
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false, substitution_tag: null },
      subscription_tracking: { enable: false },
      ganalytics: { enable: false },
    },
    mail_settings: {
      bypass_list_management: { enable: false },
      footer: { enable: false },
      sandbox_mode: { enable: false },
    },
    // RFC 8058 準拠の List-Unsubscribe ヘッダー（Gmail 等が要求）
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>, <mailto:unsubscribe@keiba.link?subject=Unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };

  let status = 0;
  let errBodyExcerpt = '';
  try {
    const res = await fetch(SENDGRID_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(emailData),
    });
    status = res.status;
    if (!res.ok) {
      // body の先頭 200 字だけ抜き出してエラー詳細に。API key は含まれない (SendGrid 側はリクエストヘッダの値を反射しない)
      const text = await res.text().catch(() => '');
      errBodyExcerpt = String(text).slice(0, 200);
    }
  } catch {
    status = 0;
  }

  if (status >= 200 && status < 300) {
    console.log(`✅ test-send ok: trace=${trace} domain=${domain} status=${status}`);
    return { trace, domain, sendStatus: 'ok', sendgridStatus: status };
  }
  const errorClass = classifySendgridError(status);
  console.log(`❌ test-send failed: trace=${trace} domain=${domain} sendgridStatus=${status} errorClass=${errorClass}`);
  return { trace, domain, sendStatus: 'failed', sendgridStatus: status, errorClass, errorExcerpt: errBodyExcerpt };
}

/** 本文先頭にテスト識別バナーを差し込む（誤って届いても気付ける） */
function wrapWithTestBanner(htmlBody, { brand, campaignDate, traceCount }) {
  const banner = `<div style="background:#fef2f2;border:2px solid #dc2626;color:#7f1d1d;padding:12px 16px;margin:0 0 16px 0;border-radius:6px;font-family:system-ui,sans-serif;font-size:14px;">
<strong>⚠️ これはテスト配信です</strong><br>
brand=${brand} / date=${campaignDate} / recipient batch size=${traceCount}<br>
本番会員には送信されていません。NEWSLETTER_TEST_RECIPIENTS 宛のみ。
</div>`;
  // 元 HTML が <!doctype>/<html>/<body> を含む場合、body 直後に差し込む。なければ先頭に追加。
  const bodyOpenMatch = htmlBody.match(/<body[^>]*>/i);
  if (bodyOpenMatch) {
    const idx = bodyOpenMatch.index + bodyOpenMatch[0].length;
    return htmlBody.slice(0, idx) + banner + htmlBody.slice(idx);
  }
  return banner + htmlBody;
}

// ===== Handler =====

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
    return structuredErrorResponse(headers, {
      httpStatusSource: 500,
      errorClass: 'unexpected-handler-error',
      error: 'unexpected handler error',
      extra: { name: unexpected?.name || 'Error', message: unexpected?.message || 'unknown error' },
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
      { status: 405, headers },
    );
  }

  // === 安全装置 1: NEWSLETTER_TEST_SEND_ENABLED ===
  if (process.env.NEWSLETTER_TEST_SEND_ENABLED !== 'true') {
    return structuredErrorResponse(headers, {
      httpStatusSource: 503,
      errorClass: 'test-send-disabled',
      error: "NEWSLETTER_TEST_SEND_ENABLED is not 'true'",
      extra: { hint: "Set NEWSLETTER_TEST_SEND_ENABLED='true' in Netlify env to enable test sends." },
    });
  }

  // === 安全装置 2: 宛先 env ===
  const envRaw = process.env.NEWSLETTER_TEST_RECIPIENTS;
  const parsed = parseTestRecipientsEnv(envRaw);
  if (parsed.recipients.length === 0) {
    return structuredErrorResponse(headers, {
      httpStatusSource: 503,
      errorClass: 'test-recipients-not-set',
      error: 'NEWSLETTER_TEST_RECIPIENTS is empty or invalid',
      extra: { skipped: parsed.skipped, hint: 'Set NEWSLETTER_TEST_RECIPIENTS to comma-separated valid emails.' },
    });
  }
  const ENV_WHITELIST = new Set(parsed.recipients); // double-check used below

  // === 安全装置 5: SENDGRID_API_KEY ===
  const sendgridKey = process.env.SENDGRID_API_KEY;
  if (!sendgridKey) {
    return structuredErrorResponse(headers, {
      httpStatusSource: 503,
      errorClass: 'missing-env',
      error: 'SENDGRID_API_KEY is not set',
      extra: { missingEnv: ['SENDGRID_API_KEY'] },
    });
  }

  // === リクエスト body 解析 ===
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'invalid JSON body' }), { status: 400, headers });
  }
  const {
    brand, serviceType, campaignType, campaignDate, audienceType, targetRace, audienceMode,
    // 2026-05-19 Phase 2.5+ C': preview と同じく renderer に注目馬 / CTA URL を渡せるよう forward
    featuredHorse: requestedFeaturedHorse,
    links: requestedLinks,
  } = body || {};

  // === 安全装置 3: audienceMode === 'test-send' ===
  if (!audienceMode || audienceMode !== 'test-send' || !SUPPORTED_AUDIENCE_MODES.has(audienceMode)) {
    return new Response(
      JSON.stringify({
        error: "audienceMode must be 'test-send'",
        supportedAudienceModes: [...SUPPORTED_AUDIENCE_MODES],
        got: audienceMode ?? null,
      }),
      { status: 400, headers },
    );
  }

  // 必須フィールド
  const missing = [];
  if (!brand) missing.push('brand');
  if (!serviceType) missing.push('serviceType');
  if (!campaignType) missing.push('campaignType');
  if (!campaignDate) missing.push('campaignDate');
  if (!audienceType) missing.push('audienceType');
  if (!targetRace) missing.push('targetRace');
  if (missing.length > 0) {
    return new Response(JSON.stringify({ error: 'missing required fields', missing }), { status: 400, headers });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(campaignDate)) {
    return new Response(
      JSON.stringify({ error: 'campaignDate must be YYYY-MM-DD', got: campaignDate }),
      { status: 400, headers },
    );
  }
  if (!SUPPORTED_CAMPAIGN_TYPES.has(campaignType)) {
    return new Response(
      JSON.stringify({
        error: 'unsupported campaignType',
        supportedCampaignTypes: [...SUPPORTED_CAMPAIGN_TYPES],
        got: campaignType,
      }),
      { status: 400, headers },
    );
  }

  // brand validation
  try {
    getBrandConfig(brand);
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 400, headers });
  }

  // === 安全装置 4: brand × fromEmail 整合 ===
  // test-send は from=noreply@keiba.link 固定。brand の許可ドメインに keiba.link が含まれるか確認。
  try {
    validateBrandFromEmail(brand, TEST_FROM_EMAIL);
  } catch (e) {
    // KI の場合 keiba.link は許可ドメイン外。test-send は AK 専用と理解。
    return new Response(
      JSON.stringify({
        error: 'brand-from validation failed for test-send',
        detail: e.message,
        brand,
        testFromEmail: TEST_FROM_EMAIL,
        hint: "test-send は from='noreply@keiba.link' 固定。brand='analytics-keiba' のみ対応。",
      }),
      { status: 400, headers },
    );
  }

  // === featuredHorse / links を共通 helper で validate（preview と完全同一ルール） ===
  const optsResult = normalizeRenderOptions({
    featuredHorse: requestedFeaturedHorse,
    links: requestedLinks,
  });
  if (optsResult.error) {
    return new Response(JSON.stringify(optsResult.error), { status: 400, headers });
  }
  const featuredHorse = optsResult.featuredHorse;
  const links = optsResult.links;

  // === 本文 render ===
  let subject;
  let bodyHtml;
  try {
    ({ subject, bodyHtml } = renderDailyMainRace({ campaignDate, targetRace, brand, featuredHorse, links }));
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'render failed', detail: e.message }),
      { status: 400, headers },
    );
  }

  // テスト識別マーカー
  const testSubject = `[TEST] ${subject}`;
  const testBodyHtml = wrapWithTestBanner(bodyHtml, {
    brand,
    campaignDate,
    traceCount: parsed.recipients.length,
  });
  const contentHash = computeContentHash(testSubject, testBodyHtml);

  // deliveryKey は test-send 専用 namespace
  const extraKey = `test-send:${targetRace?.raceId || 'no-race-id'}`;
  const sampleDeliveryKeys = parsed.recipients.map((r) => ({
    trace: emailTraceId(r),
    deliveryKey: computeDeliveryKey({
      brand,
      serviceType,
      campaignType,
      campaignDate,
      audienceType,
      recipientEmail: r,
      contentHash,
      fromEmail: TEST_FROM_EMAIL,
      extraKey,
    }),
  }));

  // === 実 SendGrid 送信 (env-whitelist の宛先のみ) ===
  console.log(`📧 test-send invoked: brand=${brand} recipients=${parsed.recipients.length} domains=${Object.keys(parsed.domainBreakdown).join(',')}`);

  const traces = [];
  let sentCount = 0;
  let failedCount = 0;
  const failureByClass = {};

  for (const recipient of parsed.recipients) {
    // ダブルチェック: env-whitelist 以外には絶対送らない
    if (!ENV_WHITELIST.has(recipient)) {
      console.log(`🚨 CRITICAL: recipient not in whitelist (this should never happen) trace=${emailTraceId(recipient)}`);
      continue;
    }
    const r = await sendOneViaSendGrid({
      apiKey: sendgridKey,
      recipient,
      subject: testSubject,
      htmlBody: testBodyHtml,
    });
    traces.push(r);
    if (r.sendStatus === 'ok') {
      sentCount += 1;
    } else {
      failedCount += 1;
      failureByClass[r.errorClass] = (failureByClass[r.errorClass] || 0) + 1;
    }
  }

  // 全件失敗時は structured_error で返す (HTTP 200 + success:false)
  if (sentCount === 0 && failedCount > 0) {
    const dominantClass = Object.entries(failureByClass).sort((a, b) => b[1] - a[1])[0]?.[0] || 'sendgrid-other';
    return structuredErrorResponse(headers, {
      httpStatusSource: 502,
      errorClass: dominantClass,
      error: 'all test-send recipients failed',
      extra: {
        brand,
        recipientCount: parsed.recipients.length,
        sentCount,
        failedCount,
        failureByClass,
        traces, // PII なし、trace + domain + status
      },
    });
  }

  return new Response(
    JSON.stringify({
      success: true,
      mode: 'test-send',
      sideEffects: 'sendgrid-test-send-only',
      campaign: {
        brand,
        serviceType,
        campaignType,
        campaignDate,
        audienceType,
        fromEmail: TEST_FROM_EMAIL,
        fromName: TEST_FROM_NAME,
        targetRace,
        // 2026-05-19 Phase 2.5+ C': admin が renderer 入力を確認できるよう echo
        featuredHorse,
        links,
        subject: testSubject,
        subjectPrefixed: true,
        contentHash,
        contentLength: testBodyHtml.length,
      },
      testRecipients: {
        source: 'env:NEWSLETTER_TEST_RECIPIENTS',
        count: parsed.recipients.length,
        skipped: parsed.skipped,
        domainBreakdown: parsed.domainBreakdown,
        traces, // [{ trace, domain, sendStatus, sendgridStatus, errorClass? }]
      },
      result: {
        sentCount,
        failedCount,
        failureByClass: failedCount > 0 ? failureByClass : undefined,
      },
      deliveryKey: {
        namespace: 'test-send',
        template: describeDeliveryKeyTemplate(),
        extraKey,
        samples: sampleDeliveryKeys,
      },
      customersAccessed: false,
      airtableAccessed: false,
      pii: 'none-exposed-recipient-emails-redacted-to-trace-only',
      queriedAt: new Date().toISOString(),
    }),
    { status: 200, headers },
  );
}
