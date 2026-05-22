// ステップメール配信 Phase 2 - 受信者ドライラン（READ-ONLY・送信なし・副作用なし）
//
// 設計方針:
//   - 副作用ゼロ。Airtable は READ-ONLY 参照のみ（Customers / EmailBlacklist）。
//     SendGrid 送信なし・ジョブ作成なし・Airtable 書込みなし。
//   - 「無料登録日(登録日, createdTime)を起点に、当日時点で Day0/1/3/7/14/21 に該当する
//     free 会員が各何人いるか」を 5-tier 除外後に算出して返す。
//   - PII 非露出: email / 氏名 / record id は返さない。件数・経過日ヒストグラムのみ。
//   - 既存の resolveAudienceRecipients / fetchCustomersReadOnly / loadBlacklistEmails を
//     再利用し、free 抽出・5-tier 除外ロジックを二重実装しない（newsletter-preview と同基準）。
//
// 安全フラグについて:
//   - 本関数は READ-ONLY のため NEWSLETTER_AUTOMATION_ENABLED / STEP_EMAIL_AUTOMATION_ENABLED
//     ガードは不要（送信もジョブ作成もしない）。
//   - ただし将来 Phase 3 でステップメールを実際に enqueue / 送信する関数を作る際は、
//     master の NEWSLETTER_AUTOMATION_ENABLED に加えて STEP_EMAIL_AUTOMATION_ENABLED
//     （既定 false）ガードを必ず入れること。本関数はその「送信ゼロの事前検証」用。

import {
  fetchCustomersReadOnly,
  loadBlacklistEmails,
} from '../../src/lib/newsletter/airtable-fetch.js';
import {
  resolveAudienceRecipients,
} from '../../src/lib/newsletter/audience-resolver.js';

const DEFAULT_BRAND = 'analytics-keiba';
// ステップメールのマイルストーン（登録後経過日）。設計§8 と一致。
const STEP_MILESTONES = [0, 1, 3, 7, 14, 21];
const DAY_MS = 24 * 60 * 60 * 1000;

/** email を resolveAudienceRecipients と同じ規則で正規化（lowercase + trim） */
function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/** ISO/日付文字列 → UTC の「その日の0時」ミリ秒（カレンダー日差分用） */
function startOfUtcDayMs(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** 経過日数 → ヒストグラムのバケット名 */
function histogramBucket(days) {
  if (days < 0) return 'future(<0)';
  if (days === 0) return '0';
  if (days === 1) return '1';
  if (days <= 3) return '2-3';
  if (days <= 7) return '4-7';
  if (days <= 14) return '8-14';
  if (days <= 21) return '15-21';
  if (days <= 30) return '22-30';
  return '31+';
}

function structuredErrorResponse(headers, { httpStatusSource, errorClass, error, extra = {} }) {
  return new Response(
    JSON.stringify({
      success: false,
      structured_error: true,
      httpStatusSource,
      errorClass,
      error,
      mode: 'step-email-preview',
      sideEffects: 'none',
      customersAccessed: false,
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

  if (request.method === 'OPTIONS') {
    return new Response('', { status: 200, headers });
  }
  if (request.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: `Method ${request.method} not allowed` }),
      { status: 405, headers },
    );
  }

  // リクエスト body
  let body = {};
  try {
    body = await request.json();
  } catch {
    // body 省略可（既定値で動作）
    body = {};
  }
  const brand = body.brand || DEFAULT_BRAND;
  const asOfDateRaw = body.asOfDate || null;

  // asOfDate 検証（省略時は今日）
  let asOfDate;
  if (asOfDateRaw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDateRaw)) {
      return new Response(
        JSON.stringify({ error: 'asOfDate must be YYYY-MM-DD', got: asOfDateRaw }),
        { status: 400, headers },
      );
    }
    asOfDate = asOfDateRaw;
  } else {
    asOfDate = new Date().toISOString().slice(0, 10);
  }
  const asOfDayMs = Date.UTC(
    Number(asOfDate.slice(0, 4)),
    Number(asOfDate.slice(5, 7)) - 1,
    Number(asOfDate.slice(8, 10)),
  );

  const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return structuredErrorResponse(headers, {
      httpStatusSource: 503,
      errorClass: 'missing-env',
      error: 'AIRTABLE_API_KEY / AIRTABLE_BASE_ID is not set',
      extra: { missingEnv: ['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID'] },
    });
  }

  try {
    // 1) Customers + blacklist を READ-ONLY 取得
    const records = await fetchCustomersReadOnly(AIRTABLE_BASE_ID, AIRTABLE_API_KEY);
    const { emails: blacklistEmails, status: blacklistStatus } = await loadBlacklistEmails({
      brand,
      baseId: AIRTABLE_BASE_ID,
      apiKey: AIRTABLE_API_KEY,
    });

    // 2) free を 5-tier 除外で解決（newsletter-preview / 本送信と同一基準）
    const audience = resolveAudienceRecipients({
      records,
      brand,
      audienceTypeFilter: 'free',
      today: asOfDate,
      blacklistEmails,
    });
    const eligibleFreeEmails = new Set(audience.emails); // 正規化済み email

    // 3) email → 登録日(最も古い) マップを records から構築
    const registeredAtByEmail = new Map();
    for (const r of records) {
      const f = r.fields || {};
      const email = normalizeEmail(f.Email);
      if (!email) continue;
      const regMs = startOfUtcDayMs(f['登録日']); // createdTime フィールド
      if (regMs === null) continue;
      const prev = registeredAtByEmail.get(email);
      if (prev === undefined || regMs < prev) registeredAtByEmail.set(email, regMs);
    }

    // 4) free 対象を経過日でバケット集計
    const milestoneCounts = Object.fromEntries(STEP_MILESTONES.map((d) => [`day${d}`, 0]));
    const histogram = {};
    let missingRegisteredAt = 0;
    let elapsedSum = 0;
    let elapsedN = 0;

    for (const email of eligibleFreeEmails) {
      const regMs = registeredAtByEmail.get(email);
      if (regMs === undefined) {
        missingRegisteredAt += 1;
        continue;
      }
      const daysSince = Math.round((asOfDayMs - regMs) / DAY_MS);
      // マイルストーン完全一致（その日に DayN ステップを送る想定の該当者数）
      if (STEP_MILESTONES.includes(daysSince)) {
        milestoneCounts[`day${daysSince}`] += 1;
      }
      const bucket = histogramBucket(daysSince);
      histogram[bucket] = (histogram[bucket] || 0) + 1;
      if (daysSince >= 0) { elapsedSum += daysSince; elapsedN += 1; }
    }

    return new Response(
      JSON.stringify({
        success: true,
        mode: 'step-email-preview',
        sideEffects: 'airtable-read-only',
        brand,
        asOfDate,
        audienceTypeFilter: 'free',
        // 5-tier 除外内訳（resolveAudienceRecipients と同一）
        exclusion: {
          totalCustomers: audience.counts.totalCustomers,
          freeEligible: audience.counts.matchedCount,
          withdrawnExcluded: audience.counts.withdrawnExcluded,
          unsubscribeExcluded: audience.counts.unsubscribeExcluded,
          blacklistExcluded: audience.counts.blacklistExcluded,
          audienceTypeMismatchSkipped: audience.counts.audienceTypeMismatchSkipped,
          invalidEmailSkipped: audience.counts.invalidEmailSkipped,
          dedupedFromMatched: audience.counts.dedupedFromMatched,
          blacklistStatus,
        },
        // 当日 DayN ステップに該当する free 会員数（完全一致）
        stepMilestoneCounts: milestoneCounts,
        // free 会員の登録後経過日ヒストグラム
        elapsedDayHistogram: histogram,
        elapsedDayAverage: elapsedN > 0 ? Math.round((elapsedSum / elapsedN) * 10) / 10 : null,
        missingRegisteredAt, // 登録日が無い/不正だった free 会員数
        pii: 'none-exposed-counts-only',
        note: 'READ-ONLY dry-run. No email sent, no job created, no Airtable write. Day counts are exact-match on calendar days since 登録日.',
        queriedAt: new Date().toISOString(),
      }),
      { status: 200, headers },
    );
  } catch (e) {
    return structuredErrorResponse(headers, {
      httpStatusSource: 500,
      errorClass: 'step-email-preview-failed',
      error: 'step email preview failed',
      extra: { name: e?.name || 'Error', message: e?.message || 'unknown error' },
    });
  }
}
