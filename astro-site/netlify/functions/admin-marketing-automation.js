/**
 * admin-marketing-automation.js — AK 専用メルマガ自動化の**管理 API（Phase A: dry-run まで）**
 *
 * ── この Function は絶対にメールを送らない ────────────────────
 * SendGrid の**送信 API を呼ぶコードを持たない**（guard テストで固定）。
 * 自動化は**新しい配信基盤を作らない**。実際の enqueue / 送信は既存 AK の
 *   `admin-marketing.js`（ScheduledEmails / CampaignDeliveries へ登録）
 *   → 既存 dispatcher（`MARKETING_CAMPAIGN_DISPATCH_ENABLED` でゲート）
 * にそのまま乗る。**送信経路は 1 つだけ**。
 *
 * ── Phase A の範囲 ────────────────────────────────────────────
 *   `list`    … プリセットと現在の設定（read-only）
 *   `preview` … **dry-run**。対象件数と除外理由だけを返す（**1 通も送らない・1 行も書かない**）
 *   `status`  … 実行履歴の表示（read-only）
 * `enable` / `run` / `cancel` は **Phase B**。本 Phase では 501 を返す
 * （設定の永続化と実行は、承認後に別途配線する）。
 *
 * ── Customers を変えない ──────────────────────────────────────
 * 会員昇格・PaymentConfirmed・Status・PlanType・有効期限・特典を**書く経路が無い**。
 * Airtable へは **GET しか出さない**（guard テストで固定）。
 *
 * ── KMA を持ち込まない ────────────────────────────────────────
 * tenant / 顧客 / キャンペーン / 送信元 / 配信停止 / 台帳 / env / Redis / Airtable /
 * 料金 / UI は**すべて AK 内が正本**。KMA の名前空間・env・送信元は参照しない。
 */

import {
  listAutomationPresets, getAutomationPreset, DEFERRED_TRIGGERS, validateAutomationPresets,
} from '../../src/lib/marketing/automationCatalog.js';
import {
  buildAutomationDefinition, buildAutomationRunId, buildRecipientKey, buildRun,
  summarizeAutomation, canStartRun, jstDateString, isQuietHours,
} from '../../src/lib/marketing/automationModel.js';
import {
  buildAudience, computeAudienceFingerprint,
} from '../../src/lib/marketing/automationEligibility.js';
import { fetchEmailBlacklistReadOnly, buildBlacklistEmailSet } from '../../src/lib/newsletter/airtable-fetch.js';

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

/** Airtable は **GET のみ**（この Function に書き込み経路は無い） */
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

// ── list（read-only）────────────────────────────────────────────
function handleList({ now }) {
  const v = validateAutomationPresets();
  return json(200, {
    mode: 'automation-list',
    sideEffects: 'none',
    presets: listAutomationPresets(),
    /** 現行 schema で安全に判定できないもの（実装せず設計候補として分離） */
    設計候補: DEFERRED_TRIGGERS,
    定義の健全性: v,
    送信ゲート: {
      'live enqueue（MARKETING_CAMPAIGN_ENABLED）': process.env.MARKETING_CAMPAIGN_ENABLED === 'true',
      '実送信（MARKETING_CAMPAIGN_DISPATCH_ENABLED）': process.env.MARKETING_CAMPAIGN_DISPATCH_ENABLED === 'true',
    },
    今日: jstDateString(now),
    notice: 'Phase A は dry-run までです。プリセットはすべて初期 OFF で、有効化・実行は配線していません。',
  });
}

// ── preview（dry-run。1 通も送らない・1 行も書かない）───────────
async function handlePreview({ req, KEY, BASE, now }) {
  const preset = getAutomationPreset(req.automationId);
  if (!preset) return json(400, { error: '未知の automationId です。' });

  const definition = {
    ...buildAutomationDefinition({ preset, overrides: req.overrides || {}, nowIso: new Date(now).toISOString() }),
    // dry-run の判定に使うだけ。**永続化しない**
    status: 'DRAFT',
  };

  const occurrenceDate = jstDateString(now);
  const automationRunId = buildAutomationRunId({ automationId: definition.automationId, occurrenceDate });

  const [records, blacklistRecords] = await Promise.all([
    fetchAllReadOnly({ KEY, BASE, table: CUSTOMERS_TABLE }),
    fetchEmailBlacklistReadOnly(BASE, KEY).catch(() => []),
  ]);
  const blacklistEmails = buildBlacklistEmailSet(blacklistRecords || []);

  const audience = buildAudience({
    records, definition, nowMs: now, blacklistEmails,
    buildKey: (email) => buildRecipientKey({ automationRunId, email }),
  });

  const fingerprint = computeAudienceFingerprint({
    automationId: definition.automationId,
    occurrenceDate,
    campaignId: definition.campaignId,
    emails: audience.recipients.map((r) => r.email),
  });

  const run = buildRun({
    automationId: definition.automationId, occurrenceDate,
    snapshot: fingerprint, plannedCount: audience.recipients.length,
    dryRun: true, nowIso: new Date(now).toISOString(),
  });

  // 本実行するならどう判定されるか（**実行はしない**）
  const wouldRun = canStartRun({
    env: process.env, definition: { ...definition, status: 'ACTIVE', enabled: true },
    nowMs: now, dryRun: false,
    dryRunSnapshot: fingerprint, currentSnapshot: fingerprint,
    plannedCount: audience.recipients.length,
  });

  return json(200, {
    mode: 'automation-preview',
    sideEffects: 'none',
    dryRun: true,
    automationId: definition.automationId,
    automationRunId,
    occurrenceDate,
    campaignId: definition.campaignId,
    snapshotFingerprint: fingerprint,
    件数: audience.counts,
    除外理由: audience.skipped,
    上限: definition.maxSendsPerRun,
    quietHours: definition.quietHours,
    静音時間帯か: isQuietHours({ nowMs: now, quietHours: definition.quietHours }),
    本実行の可否: { allowed: wouldRun.allowed, reason: wouldRun.reason, label: wouldRun.label },
    run,
    notice: '**1 通も送っていません。1 行も書いていません。** これは対象の下見です。',
  });
}

// ── status（read-only）──────────────────────────────────────────
function handleStatus({ req, now }) {
  const preset = getAutomationPreset(req.automationId);
  if (!preset) return json(400, { error: '未知の automationId です。' });
  const definition = buildAutomationDefinition({ preset, overrides: {}, nowIso: new Date(now).toISOString() });
  return json(200, {
    mode: 'automation-status',
    sideEffects: 'none',
    automation: summarizeAutomation({ definition, lastRun: null, plannedCount: 0, nextRunAt: null }),
    実行履歴: [],
    notice: 'Phase A では実行履歴を永続化していません（設定の保存と実行は Phase B）。',
  });
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  if (!SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）' });
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  if (provided !== SECRET) return json(403, { error: 'Forbidden' });

  const KEY = process.env.AIRTABLE_API_KEY;
  const BASE = process.env.AIRTABLE_BASE_ID;
  if (!KEY || !BASE) return json(500, { error: 'Airtable 認証情報が未設定' });

  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const action = req.action || 'list';
  const now = Date.now();

  try {
    if (action === 'list') return handleList({ now });
    if (action === 'preview') return await handlePreview({ req, KEY, BASE, now });
    if (action === 'status') return handleStatus({ req, now });

    // ⚠️ Phase A では有効化・実行・取消を配線しない（設定の永続化が未承認のため）
    if (action === 'enable' || action === 'run' || action === 'cancel' || action === 'pause') {
      return json(501, {
        mode: `automation-${action}`,
        error: 'Phase A では未配線です（dry-run まで）。',
        code: 'not_wired_phase_a',
        次に必要な承認: '自動化設定の永続化先（AK 専用 Redis prefix）と、実行の配線',
      });
    }
    return json(400, { error: `未知の action: ${action}` });
  } catch (e) {
    // ⚠️ 例外の中身をそのまま返さない（顧客データが混ざりうる）
    console.error('❌ [marketing-automation] 処理に失敗しました');
    return json(500, { error: 'internal error' });
  }
};

export default handler;
