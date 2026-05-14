// 完全自動化メルマガ配信システム - dry-run プレビュー API（最小構成）
//
// 仕様（2026-05-14 時点）:
//  - SendGrid を呼ばない
//  - Airtable を読まない / 書かない
//  - ファイルを書き込まない
//  - 副作用ゼロ
//  - mode は 'dry-run' 固定（test / production はまだ実装しない）
//  - 受信者はモック（preview-user-1@example.com / preview-user-2@example.com）
//
// 入力（POST JSON）:
//   {
//     "brand": "analytics-keiba",
//     "serviceType": "analytics-keiba",
//     "campaignType": "daily-main-race-nankan",
//     "campaignDate": "2026-05-14",
//     "audienceType": "free",
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

const MOCK_RECIPIENTS = [
  'preview-user-1@example.com',
  'preview-user-2@example.com',
];

const SUPPORTED_CAMPAIGN_TYPES = new Set([
  'daily-main-race-nankan',
]);

export default async function handler(request) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

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
  } = body || {};

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

  // sample deliveryKey 生成（モック受信者2名分）
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

  return new Response(
    JSON.stringify({
      success: true,
      mode: 'dry-run',
      sideEffects: 'none',
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
      audience: {
        source: 'mock',
        sampleRecipients: MOCK_RECIPIENTS,
        mockRecipientCount: MOCK_RECIPIENTS.length,
        note: 'Airtable READ は未実装。次のステップで実会員リストを参照する',
      },
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
