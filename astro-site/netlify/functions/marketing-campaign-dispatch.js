/**
 * マーケティングキャンペーンの実送信 dispatcher（AK 独自 / 既定 OFF）
 *
 * ── なぜ専用 dispatcher なのか ────────────────────────────────────────
 * 共有の `execute-scheduled-emails-background` は `NEWSLETTER_AUTOMATION_ENABLED` に
 * 依存する。これは AK の**全メール自動化のマスタースイッチ**で、実測 16 Function が参照し、
 * ON にするとメルマガ・期限通知・再送・滞留 PENDING まで同時に解禁される。
 * マーケティングのためだけにそれを ON にはできない。
 *
 * そこでキャンペーンだけを送る dispatcher を分け、ゲートも
 * **`MARKETING_CAMPAIGN_DISPATCH_ENABLED` だけ**にした（`NEWSLETTER_AUTOMATION_ENABLED` は見ない）。
 * 逆向きの漏れも塞いである: 共有 executor 側はマーケティングジョブを専用ゲート無しでは処理しない
 * （`marketingDispatchGate.canSharedExecutorSend`）。
 *
 * ── 送信直前の再検証（本 dispatcher の中核）──────────────────────────
 * キュー登録（dry-run 確定）と実送信の間には時間差がある。その間に配信停止・バウンス・退会が
 * 起きても、固定宛先リストのジョブは**そのまま送られてしまう**（共有 executor は explicit な
 * 宛先に対して再チェックをしない）。ここでは 1 通ごとに
 *   provider suppression / EmailBlacklist / 配信停止 / 退会
 * を再判定し、該当したら送らずに `skipped-*` で台帳へ記録する。
 * provider suppression を確認できない場合は **1 通も送らない**（fail closed）。
 *
 * ── 実行方法 ────────────────────────────────────────────────────
 * POST + `x-admin-secret`（admin-marketing と同じ secret）。cron からは呼ばない
 * （承認された時にだけ人が叩く）。`dryRun:true` なら送信せず対象と再検証結果だけ返す。
 *
 * ⚠️ Customers へは一切書かない。書くのは CampaignDeliveries と ScheduledEmails のみ。
 * ⚠️ 決済メール v2 のフィールドには触れない。
 */

import {
  isMarketingDispatchEnabled,
  isMarketingJob,
  verifyBeforeSend,
} from '../../src/lib/marketing/marketingDispatchGate.js';
import {
  fetchProviderSuppression,
  describeProviderSuppression,
} from '../../src/lib/marketing/providerSuppression.js';
import {
  fetchEmailBlacklistReadOnly,
  buildBlacklistEmailSet,
} from '../../src/lib/newsletter/airtable-fetch.js';
import { parseTestRecipientsEnv } from '../../src/lib/newsletter/test-recipients.js';
import { getCampaign } from '../../src/lib/marketing/campaignCatalog.js';
import { evaluateExtraAudience } from '../../src/lib/marketing/campaignAudienceRules.js';
import { getBrandConfig, validateBrandFromEmail } from '../../src/lib/newsletter/brand-config.js';

const BRAND = 'analytics-keiba';
const CUSTOMERS_TABLE = process.env.AIRTABLE_CUSTOMERS_TABLE || 'Customers';
const DELIVERIES_TABLE = 'CampaignDeliveries';
const SCHEDULED_TABLE = 'ScheduledEmails';
/** 1 回の実行で送る上限（暴走防止） */
const MAX_PER_RUN = 200;

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

const authHeaders = (key) => ({ Authorization: `Bearer ${key}` });

async function fetchAll({ KEY, BASE, table, filterByFormula }) {
  const out = [];
  let offset;
  let pages = 0;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`);
    url.searchParams.set('pageSize', '100');
    if (filterByFormula) url.searchParams.set('filterByFormula', filterByFormula);
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers: authHeaders(KEY) });
    if (!res.ok) throw new Error(`${table} fetch failed: HTTP ${res.status}`);
    const data = await res.json();
    out.push(...(data.records || []));
    offset = data.offset;
    pages += 1;
    if (offset && pages >= 40) break;
  } while (offset);
  return out;
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  const KEY = process.env.AIRTABLE_API_KEY;
  const BASE = process.env.AIRTABLE_BASE_ID;
  const SG = process.env.SENDGRID_API_KEY;

  if (!SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）' });
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  if (provided !== SECRET) return json(403, { error: 'Forbidden' });

  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const dryRun = req.dryRun !== false; // 既定 true（明示的に false のときだけ実送信）

  // 🛡️ 実送信はマーケティング専用ゲートが true のときだけ。既定 OFF。
  if (!dryRun && !isMarketingDispatchEnabled(process.env)) {
    return json(503, {
      error: 'キャンペーン送信は無効です（MARKETING_CAMPAIGN_DISPATCH_ENABLED 未設定）',
      flag: 'MARKETING_CAMPAIGN_DISPATCH_ENABLED',
      note: 'このゲートは NEWSLETTER_AUTOMATION_ENABLED とは独立です（既存メール経路を解禁しません）',
      sideEffects: 'none',
    });
  }
  if (!KEY || !BASE) return json(500, { error: 'Airtable 認証情報が未設定' });
  if (!dryRun && !SG) return json(503, { error: 'SENDGRID_API_KEY 未設定', sideEffects: 'none' });

  try {
    return await dispatch({ KEY, BASE, SG, dryRun, jobIdFilter: req.jobId ? String(req.jobId) : null });
  } catch (e) {
    console.error('❌ [marketing-dispatch]', e.message);
    return json(500, { error: 'internal error' });
  }
};

async function dispatch({ KEY, BASE, SG, dryRun, jobIdFilter }) {
  const now = Date.now();
  const fromEmail = getBrandConfig(BRAND).defaultFromEmail;
  const fromName = getBrandConfig(BRAND).defaultFromName;
  validateBrandFromEmail(BRAND, fromEmail);

  // 1) 対象ジョブ = PENDING かつ マーケティングのタグを持つものだけ
  const scheduled = await fetchAll({ KEY, BASE, table: SCHEDULED_TABLE, filterByFormula: `{Status}='PENDING'` });
  const jobs = scheduled
    .filter((r) => isMarketingJob(r.fields))
    .filter((r) => !jobIdFilter || String(r.fields.JobId || '') === jobIdFilter);

  if (jobs.length === 0) {
    return json(200, { mode: dryRun ? 'dry-run' : 'live', jobs: 0, sent: 0, skipped: 0, sideEffects: 'none', notice: '送信待ちのキャンペーンジョブはありません。' });
  }

  // 2) 送信直前の再検証に使う集合をまとめて読む
  const provider = await fetchProviderSuppression({ apiKey: SG, now });
  if (!provider.ok) {
    return json(503, {
      error: 'SendGrid の配信停止リストを確認できないため中止しました（確認できないまま送信しません）',
      detail: describeProviderSuppression(provider),
      sideEffects: 'none',
    });
  }
  const blRecords = await fetchEmailBlacklistReadOnly(BASE, KEY).catch(() => null);
  if (blRecords === null) {
    return json(503, { error: 'EmailBlacklist を読めないため中止しました', sideEffects: 'none' });
  }
  const hardBlocked = buildBlacklistEmailSet(blRecords);
  const blocked = new Set(hardBlocked);
  for (const r of blRecords) {
    const e = String(r?.fields?.Email || '').trim().toLowerCase();
    if (e) blocked.add(e); // 販促メールは SOFT_BOUNCE も送らない
  }

  // キャンペーン横断の最終送信日時（**このジョブ自身の記録は除く**。
  // 自分の queued レコードを見て自分を止めてしまわないようにする）
  const campaignDeliveries = await fetchAll({
    KEY, BASE, table: DELIVERIES_TABLE, filterByFormula: `{EmailType}='campaign'`,
  }).catch(() => []);

  const customers = await fetchAll({ KEY, BASE, table: CUSTOMERS_TABLE });
  const unsubscribed = new Set();
  const withdrawn = new Set();
  /** 送信直前にキャンペーン固有条件を再判定するための email → fields */
  const fieldsByEmail = new Map();
  for (const r of customers) {
    const f = r.fields || {};
    const e = String(f.Email || '').trim().toLowerCase();
    if (!e) continue;
    fieldsByEmail.set(e, f);
    if (f.UnsubscribedAnalyticsKeiba === true) unsubscribed.add(e);
    const status = String(f.Status || '').trim().toLowerCase();
    if (f.WithdrawalRequested === true || status === 'withdrawn' || status === 'cancelled') withdrawn.add(e);
  }

  // env 由来の値（テスト受信者ホワイトリスト）。判定モジュールは純粋なのでここで読む。
  const audienceContext = { testRecipients: new Set(parseTestRecipientsEnv(process.env.NEWSLETTER_TEST_RECIPIENTS).recipients) };

  // 3) ジョブごとに 1 通ずつ再検証 → 送信
  const summary = { jobs: 0, verified: 0, sent: 0, failed: 0, skipped: 0, skippedByReason: {} };
  const jobResults = [];

  for (const job of jobs) {
    const f = job.fields || {};
    const jobId = String(f.JobId || '');
    const recipients = String(f.Recipients || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (recipients.length === 0) continue;
    summary.jobs += 1;

    // このジョブ以外のキャンペーン配信から、受信者ごとの最終送信日時を作る
    const recentContactAtMs = buildRecentContactMap(campaignDeliveries, jobId);

    // ジョブが属するキャンペーン（TargetPlan='campaign:<id>'）。
    // キュー登録後に条件が変わっている可能性があるため、送信直前にも固有条件を再判定する。
    const campaignId = String(f.TargetPlan || '').replace(/^campaign:/, '').trim();
    const jobCampaign = campaignId ? getCampaign(campaignId) : null;

    const toSend = [];
    const toSkip = [];
    for (const email of recipients.slice(0, MAX_PER_RUN)) {
      const v = verifyBeforeSend({
        email, providerSuppressed: provider.emails, blocked, unsubscribed, withdrawn,
        recentContactAtMs, nowMs: now,
      });
      // キャンペーン固有条件（カナリアのテスト受信者・Premium Plus の PHASE 等）の再確認。
      // キャンペーンが使用停止化・env 変更などで条件を失っていたら送らない（fail closed）。
      if (v.send) {
        if (!jobCampaign) {
          toSkip.push({ email, status: 'skipped-duplicate', reason: 'campaign_unavailable' });
          summary.skipped += 1;
          summary.skippedByReason.campaign_unavailable = (summary.skippedByReason.campaign_unavailable || 0) + 1;
          summary.verified += 1;
          continue;
        }
        const extra = evaluateExtraAudience({
          campaign: jobCampaign, fields: fieldsByEmail.get(email) || null, nowMs: now, context: audienceContext,
        });
        if (!extra.ok) {
          toSkip.push({ email, status: 'skipped-duplicate', reason: 'campaign_mismatch' });
          summary.skipped += 1;
          summary.skippedByReason.campaign_mismatch = (summary.skippedByReason.campaign_mismatch || 0) + 1;
          summary.verified += 1;
          continue;
        }
      }
      summary.verified += 1;
      if (v.send) toSend.push(email);
      else {
        toSkip.push({ email, status: v.status, reason: v.reason });
        summary.skipped += 1;
        summary.skippedByReason[v.reason] = (summary.skippedByReason[v.reason] || 0) + 1;
      }
    }

    jobResults.push({ jobId, total: recipients.length, willSend: toSend.length, willSkip: toSkip.length });

    if (dryRun) continue;

    // 3-a) 送らない相手を台帳へ記録（送信前に確定させる）
    if (toSkip.length > 0) {
      await patchDeliveriesByEmail({ KEY, BASE, jobId, entries: toSkip, now });
    }

    // 3-b) 1 通ずつ送る（個別送信。他受信者のアドレスが漏れない）
    for (const email of toSend) {
      const ok = await sendOne({ SG, fromEmail, fromName, to: email, subject: f.Subject, html: f.Content });
      if (ok) summary.sent += 1; else summary.failed += 1;
      await patchDeliveriesByEmail({
        KEY, BASE, jobId, now,
        entries: [{ email, status: ok ? 'sent' : 'failed', reason: ok ? null : 'send_failed' }],
      });
    }

    // 3-c) ジョブを終了状態にする
    await patchRecord({
      KEY, BASE, table: SCHEDULED_TABLE, recordId: job.id,
      fields: {
        Status: summary.failed > 0 ? 'FAILED' : 'SENT',
        SentCount: summary.sent,
        FailedCount: summary.failed,
        CompletedAt: new Date(now).toISOString(),
      },
    });
  }

  console.log('📣 [marketing-dispatch]', {
    mode: dryRun ? 'dry-run' : 'live', jobs: summary.jobs,
    verified: summary.verified, sent: summary.sent, skipped: summary.skipped, failed: summary.failed,
  });

  return json(200, {
    mode: dryRun ? 'dry-run' : 'live',
    sideEffects: dryRun ? 'none' : 'CampaignDeliveries / ScheduledEmails のみ',
    ...summary,
    jobResults,
    providerSuppression: describeProviderSuppression(provider),
    notice: dryRun
      ? '再検証のみ。送信も書き込みもしていません。'
      : '送信直前に配信停止・バウンス・退会を再判定したうえで送信しました。',
  });
}

/**
 * 受信者 → 「このジョブ以外の」キャンペーン最終送信日時。
 * 自ジョブの queued レコードを含めると、自分自身を頻度ガードで止めてしまう。
 */
function buildRecentContactMap(deliveries, excludeJobId) {
  const map = new Map();
  for (const rec of deliveries || []) {
    const f = rec.fields || {};
    // 取引メール（step / race_main）は横断頻度に含めない。
    // 取得クエリでも絞っているが、クエリ変更で崩れないようここでも判定する。
    if (f.EmailType !== 'campaign') continue;
    if (String(f.ScheduledEmailJobId || '') === excludeJobId) continue;
    const status = String(f.Status || '');
    if (status !== 'sent' && status !== 'queued') continue;
    const email = String(f.RecipientEmail || '').trim().toLowerCase();
    if (!email) continue;
    const t = Date.parse(f.SentAt || f.QueuedAt || '');
    if (!Number.isFinite(t)) continue;
    const cur = map.get(email);
    if (cur === undefined || t > cur) map.set(email, t);
  }
  return map;
}

/** SendGrid へ 1 通送る。成功なら true。本文・宛先はログへ出さない。 */
async function sendOne({ SG, fromEmail, fromName, to, subject, html }) {
  // 配信停止リンクは共有 executor と同じ形式で必ず付ける（RFC 8058 ヘッダも）
  const unsubscribeLink = `https://analytics.keiba.link/.netlify/functions/unsubscribe?email=${encodeURIComponent(to)}&brand=analytics-keiba`;
  const body = `${html}<hr style="border:0;border-top:1px solid #e5e7eb;margin:2em 0 1em;" />`
    + `<p style="font-size:12px;text-align:center;">`
    + `<a href="${unsubscribeLink}" style="color:#dc2626;text-decoration:underline;">🚫 配信停止はこちら</a></p>`;
  try {
    const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SG}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: fromEmail, name: fromName },
        subject,
        content: [{ type: 'text/html', value: body }],
        headers: {
          'List-Unsubscribe': `<${unsubscribeLink}>, <mailto:unsubscribe@keiba.link?subject=Unsubscribe>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** CampaignDeliveries を JobId × RecipientEmail で引いて状態だけ更新する（Customers は触らない） */
async function patchDeliveriesByEmail({ KEY, BASE, jobId, entries, now }) {
  const iso = new Date(now).toISOString();
  for (const entry of entries) {
    const formula = `AND({ScheduledEmailJobId}='${jobId}', LOWER({RecipientEmail})='${entry.email}')`;
    let recs = [];
    try {
      recs = await fetchAll({ KEY, BASE, table: DELIVERIES_TABLE, filterByFormula: formula });
    } catch { continue; }
    for (const rec of recs) {
      const fields = { Status: entry.status };
      if (entry.status === 'sent') fields.SentAt = iso;
      else if (entry.status === 'failed') { fields.FailedAt = iso; fields.ErrorMessage = String(entry.reason || 'send_failed'); }
      else { fields.SkippedAt = iso; fields.ErrorMessage = String(entry.reason || 'skipped'); }
      await patchRecord({ KEY, BASE, table: DELIVERIES_TABLE, recordId: rec.id, fields });
    }
  }
}

async function patchRecord({ KEY, BASE, table, recordId, fields }) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}/${recordId}`, {
    method: 'PATCH',
    headers: { ...authHeaders(KEY), 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) console.error(`❌ [marketing-dispatch] ${table} PATCH failed: HTTP ${res.status}`);
  return res.ok;
}
