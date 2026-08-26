/**
 * cron-campaign-sequence.js — 連続配信を**1 日 1 ステップだけ**自動で進める（既定は常時無効）
 *
 * ⚠️ **4 つのゲートが全て true でなければ、Airtable にも SendGrid にも接続しない。**
 *      1. `MARKETING_SEQUENCE_SCHEDULER_ENABLED=true`
 *      2. `MARKETING_SEQUENCE_ARMED=<今日の JST 日付>`（置きっぱなしでも翌日閉じる）
 *      3. `MARKETING_CAMPAIGN_ENABLED=true`（既存の live enqueue）
 *      4. `MARKETING_CAMPAIGN_DISPATCH_ENABLED=true`（既存の実送信）
 *    どれか 1 つでも欠ければ**接続前に fail-closed で終了**する（副作用ゼロ）。
 *
 * ⚠️ この Function は **メールを送らない**。作るのは
 *      ScheduledEmails の PENDING 行 + CampaignDeliveries の queued 行
 *    だけで、実送信は既存 dispatcher が担う（**送信経路は 1 本のまま**）。
 * ⚠️ **Customers を 1 バイトも書かない**（会員・課金・特典・期限を変更しない）。
 *
 * ── 判断は全部 pure モジュール ────────────────────────────────
 * 「誰がいま何通目か」「送ってよいか」は
 *   `sequenceProgress.js`（進行）/ `sequenceAutomation.js`（計画）/
 *   `campaignSend.js`（除外・DeliveryKey）/ `engagementGuard.js`（反応なし）
 * が決める。ここは **I/O だけ**を行う。管理画面（`admin-marketing`）と
 * 同じモジュールを使うので、画面の人数と自動配信の対象がズレない。
 *
 * ── 対象は「すでにシーケンスに入っている人」だけ ──────────────
 * step1（初回接触）は母集団が最大になるため**自動では撃たない**。
 * よって走査対象は「その campaign で 1 通以上受け取った人」= CampaignDeliveries 由来に限られ、
 * Customers 全件走査（14,000 件超・Function がタイムアウトする）を**構造的に避ける**。
 */

import {
  buildCampaignPlan, buildDeliveryRecords, chunkRecipients,
  computeCampaignContentHash, assertOnlyDeliveryFields,
  MAX_RECIPIENTS_PER_SEND,
} from '../../src/lib/marketing/campaignSend.js';
import { getCampaign, renderCampaign } from '../../src/lib/marketing/campaignCatalog.js';
import {
  isSequenceCampaign, resolveSequenceStep,
} from '../../src/lib/marketing/campaignSequence.js';
import { buildSequenceProgress } from '../../src/lib/marketing/sequenceProgress.js';
import {
  readSequenceGates, planSequenceTick, summarizeSequenceTick,
  MAX_RECIPIENTS_PER_TICK, resolveMaxRecipientsPerTick, TICK_ABORT,
} from '../../src/lib/marketing/sequenceAutomation.js';
import { checkBenefitForSend } from '../../src/lib/marketing/campaignBenefit.js';
import { resolveCustomerMarketing } from '../../src/lib/marketing/customerMarketingAudience.js';
import {
  buildScheduledEmailFields, assertOnlyScheduledFields, buildJobId,
} from '../../src/lib/marketing/marketingEnqueueContract.js';
import { fetchProviderSuppression } from '../../src/lib/marketing/providerSuppression.js';
import { loadBlacklistEmails } from '../../src/lib/newsletter/airtable-fetch.js';
import { getBrandConfig } from '../../src/lib/newsletter/brand-config.js';
import { assertFetchComplete, chunkList } from '../../src/lib/marketing/marketingTargetedLoad.js';
import { MARKETING_EMAIL_SHELL_VERSION } from '../../src/lib/marketing/marketingEmailShell.js';

const BRAND = 'analytics-keiba';
const CUSTOMERS_TABLE = 'Customers';
const DELIVERIES_TABLE = 'CampaignDeliveries';
const SCHEDULED_TABLE = 'ScheduledEmails';
const MAX_PAGES = 40;

/** ログの目印（検索の入口。変えない） */
export const SEQ_LOG_TAG = '[campaign-sequence]';

function log(payload) {
  try { console.log(`${SEQ_LOG_TAG} ${JSON.stringify(payload)}`); } catch { /* 観測失敗で止めない */ }
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

const auth = (key) => ({ Authorization: `Bearer ${key}` });

/** そのキャンペーンの配信履歴だけを引く（**全件走査しない**・打ち切りは例外） */
async function fetchCampaignDeliveries({ KEY, BASE, campaignType }) {
  const out = [];
  let offset;
  let pages = 0;
  do {
    const body = {
      filterByFormula: `AND({EmailType}='campaign',{CampaignType}='${campaignType}')`,
      pageSize: 100,
    };
    if (offset) body.offset = offset;
    const res = await fetch(
      `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(DELIVERIES_TABLE)}/listRecords`,
      { method: 'POST', headers: { ...auth(KEY), 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    if (!res.ok) throw new Error(`deliveries_fetch_${res.status}`);
    const data = await res.json();
    out.push(...(data.records || []));
    offset = data.offset;
    pages += 1;
    // 黙って短い結果を返さない（不完全な履歴で進めると二重送信になる）
    if (offset && pages >= MAX_PAGES) {
      assertFetchComplete({ table: DELIVERIES_TABLE, offset, pages, maxPages: MAX_PAGES });
    }
  } while (offset);
  return out;
}

/** 宛先ぶんだけ Customers を引く（名指し取得） */
async function fetchCustomersByEmails({ KEY, BASE, emails }) {
  const out = [];
  for (const group of chunkList(emails, 20)) {
    const safe = group.filter((e) => e && !e.includes("'"));
    if (safe.length === 0) continue;
    const formula = `OR(${safe.map((e) => `LOWER({Email})='${e}'`).join(',')})`;
    let offset;
    let pages = 0;
    do {
      const body = { filterByFormula: formula, pageSize: 100 };
      if (offset) body.offset = offset;
      const res = await fetch(
        `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}/listRecords`,
        { method: 'POST', headers: { ...auth(KEY), 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      );
      if (!res.ok) throw new Error(`customers_fetch_${res.status}`);
      const data = await res.json();
      out.push(...(data.records || []));
      offset = data.offset;
      pages += 1;
      if (offset && pages >= MAX_PAGES) {
        assertFetchComplete({ table: CUSTOMERS_TABLE, offset, pages, maxPages: MAX_PAGES });
      }
    } while (offset);
  }
  return out;
}

/**
 * 実処理。**テストからはここを直接呼ぶ**（HTTP の器を挟まない）。
 * @param {{env: object, now: number, deps?: object}} args
 */
export async function runSequenceTick({ env = process.env, now = Date.now(), campaignId } = {}) {
  const gates = readSequenceGates(env, now);
  if (!gates.allOpen) {
    // ⚠️ ここから先へ進まない = Airtable にも SendGrid にも接続しない
    const body = { ok: false, abort: TICK_ABORT.GATES_CLOSED, missing: gates.missing, sideEffects: 'none' };
    log(body);
    return body;
  }

  const id = String(campaignId || env.MARKETING_SEQUENCE_CAMPAIGN_ID || '').trim();
  const base = getCampaign(id);
  if (!base || !isSequenceCampaign(base)) {
    const body = { ok: false, abort: TICK_ABORT.NOT_A_SEQUENCE, campaignId: id, sideEffects: 'none' };
    log(body);
    return body;
  }

  const KEY = env.AIRTABLE_API_KEY;
  const BASE = env.AIRTABLE_BASE_ID;
  if (!KEY || !BASE) return { ok: false, abort: 'airtable_not_configured', sideEffects: 'none' };

  const fromEmail = getBrandConfig(BRAND).defaultFromEmail;
  const campaignType = `${base.campaignId}:v${base.version}`;

  // 1) このキャンペーンの配信履歴（= すでにシーケンスに入っている人）
  const deliveries = await fetchCampaignDeliveries({ KEY, BASE, campaignType });
  const emails = [...new Set(
    deliveries.map((r) => String((r.fields || {}).RecipientEmail || '').trim().toLowerCase()).filter(Boolean),
  )];
  if (emails.length === 0) {
    const body = { ok: false, abort: TICK_ABORT.NO_DUE, reason: 'no_one_in_sequence', sideEffects: 'none' };
    log(body);
    return body;
  }

  // 2) その人たちの現在の顧客レコード（購入・退会・プラン変更を反映するため毎回引く）
  const records = await fetchCustomersByEmails({ KEY, BASE, emails });
  const { emails: blacklistEmails } = await loadBlacklistEmails({ brand: BRAND, baseId: BASE, apiKey: KEY });
  const selected = records.map((rec) => {
    const fields = rec.fields || {};
    return {
      recordId: rec.id,
      fields,
      marketing: resolveCustomerMarketing({ fields, nowMs: now, blacklistEmails }),
    };
  });

  // 3) 配信基盤の停止リスト（**確認できなければ何もしない**）
  const provider = await fetchProviderSuppression({ apiKey: env.SENDGRID_API_KEY, now });
  if (!provider.ok) {
    const body = { ok: false, abort: 'provider_suppression_unavailable', sideEffects: 'none' };
    log(body);
    return body;
  }

  // 4) 進行と計画（判断は pure モジュール。ここでは何も決めない）
  //    ⚠️ engagement は admin と同じ判定を使うが、cron では Redis を読まないため
  //       Map を渡さない = **engagement 理由では止めない**（fail closed 側）。
  const progress = buildSequenceProgress({
    campaign: base, selected, deliveries, brand: BRAND, fromEmail, nowMs: now,
    providerSuppressed: provider.emails,
    softBounced: new Set(),
  });
  const plan = planSequenceTick({ progress, gates, maxRecipients: resolveMaxRecipientsPerTick(process.env) });
  if (!plan.ok) {
    const body = { ok: false, ...plan, sideEffects: 'none' };
    log(summarizeSequenceTick({ campaignId: base.campaignId, plan }));
    return body;
  }

  // 5) 送信計画（除外・DeliveryKey は既存の単一源がそのまま担当）
  const sending = resolveSequenceStep(base, plan.step);
  const byId = new Map(selected.map((c) => [c.recordId, c]));
  const targets = plan.recordIds.map((rid) => byId.get(rid)).filter(Boolean);
  const built = buildCampaignPlan({
    campaign: sending, selected: targets,
    providerSuppressed: provider.emails,
    brand: BRAND, fromEmail, nowMs: now,
  });
  if (!built.ok || built.recipients.length === 0) {
    const body = { ok: false, abort: built.ok ? TICK_ABORT.NO_DUE : built.error, sideEffects: 'none' };
    log(body);
    return body;
  }
  if (built.recipients.length > MAX_RECIPIENTS_PER_SEND) {
    return { ok: false, abort: TICK_ABORT.OVER_MAX, sideEffects: 'none' };
  }

  // 6) 得の宣言（大量配信は宣言が無ければ送れない）
  const benefit = checkBenefitForSend({ campaign: sending, recipientCount: built.recipients.length });
  if (!benefit.ok) {
    const body = { ok: false, abort: `benefit_${benefit.reason}`, sideEffects: 'none' };
    log(body);
    return body;
  }

  const rendered = renderCampaign({ campaign: sending, name: null });
  if (!rendered) return { ok: false, abort: 'render_failed', sideEffects: 'none' };

  // 7) キュー登録（ScheduledEmails PENDING + CampaignDeliveries queued）
  const contentHash = computeCampaignContentHash(sending);
  const jobIdByEmail = new Map();
  let enqueued = 0;
  let failed = 0;
  const batches = chunkRecipients(built.recipients);
  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const jobId = buildJobId({
      campaignId: base.campaignId, version: base.version,
      fingerprint: built.planFingerprint, index: i + 1,
    });
    const fields = buildScheduledEmailFields({
      campaignId: base.campaignId,
      subject: rendered.subject,
      html: rendered.html,
      emails: batch.map((r) => r.email),
      jobId,
      scheduledAtIso: new Date(now).toISOString(),
      notes: `marketing campaign ${base.campaignId} v${base.version} sequence step${plan.step} `
        + `content:${contentHash} shell:v${MARKETING_EMAIL_SHELL_VERSION}`,
    });
    if (!assertOnlyScheduledFields(fields)) { failed += batch.length; continue; }
    const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(SCHEDULED_TABLE)}`, {
      method: 'POST',
      headers: { ...auth(KEY), 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ fields }], typecast: false }),
    });
    if (!res.ok) { failed += batch.length; continue; }
    for (const r of batch) jobIdByEmail.set(r.email, jobId);
    enqueued += batch.length;
  }

  // 8) 1 通ごとの正本（DeliveryKey で upsert = 何度実行しても 1 行）
  const deliveryRecords = buildDeliveryRecords({
    campaign: sending, recipients: built.recipients, jobIdByEmail, nowMs: now,
  });
  for (const rec of deliveryRecords) {
    if (!assertOnlyDeliveryFields(rec.fields)) return { ok: false, abort: 'delivery_fields_rejected' };
  }
  for (let i = 0; i < deliveryRecords.length; i += 10) {
    const chunk = deliveryRecords.slice(i, i + 10);
    await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(DELIVERIES_TABLE)}`, {
      method: 'PATCH',
      headers: { ...auth(KEY), 'Content-Type': 'application/json' },
      body: JSON.stringify({ performUpsert: { fieldsToMergeOn: ['DeliveryKey'] }, records: chunk }),
    });
  }

  const summary = summarizeSequenceTick({ campaignId: base.campaignId, plan, enqueued, failed });
  log(summary);
  return {
    ok: true, step: plan.step, enqueued, failed,
    campaignId: base.campaignId, version: base.version,
    sideEffects: 'queued_only',
    note: 'キュー登録のみ。実送信は既存 dispatcher が行う（この Function はメールを送らない）。',
  };
}

/** Netlify Functions **v2** のエントリ（`export const config` が効くのはこの形式だけ） */
export default async function handler() {
  try {
    const out = await runSequenceTick({ env: process.env, now: Date.now() });
    return json(200, out);
  } catch (e) {
    // 値・アドレスはログに出さない（理由コードだけ）
    log({ ok: false, error: String(e && e.message ? e.message : 'unknown') });
    return json(200, { ok: false, error: 'tick_failed', sideEffects: 'unknown' });
  }
}

/**
 * **10 分ごと**。ゲートが閉じていれば即終了（副作用ゼロ）。
 *
 * ⚠️ **2026-08-26 MK 確定で 1 日 1 回から変更**。
 *    1 日 1 回・200 通では 15,000 名に 75 日かかり、実質動かなかった。
 *    10 分間隔 × 1 tick 500 通 = **3,000 通/時**で、同じ日のうちに配り切れる。
 * ⚠️ 送る相手が居なければ 1 件も書かずに終わる（`no_due`）。空振りは無害。
 */
export const config = {
  schedule: '*/10 * * * *',
};
