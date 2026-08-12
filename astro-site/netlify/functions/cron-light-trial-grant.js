/**
 * cron-light-trial-grant.js — Light 30日無料体験の**入口**（自動付与 → Step1 登録 / 既定 OFF）
 *
 * ⚠️ **6 つのゲートが全て開くまで、Customers へ 1 バイトも書かない。**
 *      1. `COMEBACK_GRANT_FIELDS_READY=1`       … 既存の付与ゲート（列の実在）
 *      2. `COMEBACK_GRANT_ENABLED=true`         … 既存の付与ゲート（実行許可）
 *      3. `LIGHT_TRIAL_AUTOGRANT_ENABLED=true`  … 自動化の許可
 *      4. `LIGHT_TRIAL_AUTOGRANT_ARMED=<今日の JST 日付>`（翌日には自動的に閉じる）
 *      5. `MARKETING_CAMPAIGN_ENABLED=true`     … Step1 のキュー登録
 *      6. `MARKETING_CAMPAIGN_DISPATCH_ENABLED=true` … 実送信の既存ゲート
 *    1・2 は**手動付与と同じゲート**を再利用する（自動化のための抜け道を作らない）。
 *
 * ── 順序（ここが壊れると「使えないのに案内が届く」）──────────────
 *   ① 対象コホート（CSV 取り込み）を数える → 観測できなければ**中止**
 *   ② 候補を選ぶ（過去付与・有料・期限なし付与・配信不可を除外）
 *   ③ **付与**（`buildComebackPlan` の計画をそのまま PATCH）
 *   ④ **成功した recordId だけ**を Step1 の送信対象にする
 *   ⑤ Step1 をキュー登録（実送信は既存 dispatcher）
 *
 *   付与前・付与失敗の相手には**絶対にキュー登録しない**。
 *
 * ── dry-run（書き込みゼロ）──────────────────────────────────
 *   `{"dryRun": true}` を POST すると、**ゲートが閉じていても**
 *   「CSV 対象総数 / 付与候補 / 除外理由別件数」を返す（read-only）。
 *   手動呼び出しには `x-admin-secret` が必要。
 *
 * ⚠️ この Function は**メールを送らない**。作るのは ScheduledEmails の PENDING 行と
 *    CampaignDeliveries の queued 行だけ。
 */

import {
  readAutoGrantGates, selectAutoGrantCandidates, planAutoGrantRun,
  recipientsAfterGrant, summarizeAutoGrantRun,
  AUTOGRANT_ABORT, AUTOGRANT_SKIP_LABEL, TRIAL_OFFER_ID, MAX_GRANTS_PER_RUN,
} from '../../src/lib/comeback/lightTrialAutoGrant.js';
import { COHORT_SKIP_LABEL } from '../../src/lib/crm/importedCohort.js';
import { buildComebackPlan, chunkTargets } from '../../src/lib/comeback/comebackGrantPlan.js';
import { resolveOffer } from '../../src/lib/promotions/promotionOfferCatalog.js';
import { resolveCustomerMarketing } from '../../src/lib/marketing/customerMarketingAudience.js';
import { getCampaign, renderCampaign } from '../../src/lib/marketing/campaignCatalog.js';
import { resolveSequenceStep } from '../../src/lib/marketing/campaignSequence.js';
import {
  buildCampaignPlan, buildDeliveryRecords, chunkRecipients,
  computeCampaignContentHash, assertOnlyDeliveryFields,
} from '../../src/lib/marketing/campaignSend.js';
import { checkBenefitForSend } from '../../src/lib/marketing/campaignBenefit.js';
import {
  buildScheduledEmailFields, assertOnlyScheduledFields, buildJobId,
} from '../../src/lib/marketing/marketingEnqueueContract.js';
import { fetchProviderSuppression } from '../../src/lib/marketing/providerSuppression.js';
import { loadBlacklistEmails } from '../../src/lib/newsletter/airtable-fetch.js';
import { getBrandConfig } from '../../src/lib/newsletter/brand-config.js';
import { MARKETING_EMAIL_SHELL_VERSION } from '../../src/lib/marketing/marketingEmailShell.js';

const BRAND = 'analytics-keiba';
const CUSTOMERS_TABLE = 'Customers';
const DELIVERIES_TABLE = 'CampaignDeliveries';
const SCHEDULED_TABLE = 'ScheduledEmails';
const CAMPAIGN_ID = 'light-trial-to-premium-sequence';
const MAX_PAGES = 60;

export const TRIAL_LOG_TAG = '[light-trial-grant]';

function log(payload) {
  try { console.log(`${TRIAL_LOG_TAG} ${JSON.stringify(payload)}`); } catch { /* 観測失敗で止めない */ }
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

const auth = (key) => ({ Authorization: `Bearer ${key}` });

/**
 * 取り込みコホートの候補を読む（**read-only**）。
 * `Source` で先に絞るので、Customers 全件を DOM/メモリへ展開しない。
 */
async function fetchCohortCustomers({ KEY, BASE }) {
  const out = [];
  let offset;
  let pages = 0;
  do {
    const body = {
      // 取り込み時に必ず書かれる `Source` の接頭辞で絞る（正本は importWritePlan）
      filterByFormula: "FIND('customer-import:', {Source}) = 1",
      pageSize: 100,
    };
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
    if (offset && pages >= MAX_PAGES) throw new Error('customers_fetch_truncated');
  } while (offset);
  return out;
}

/** 付与を書く（**計画どおりの fields だけ**）。成功した recordId を返す */
async function applyGrants({ KEY, BASE, targets }) {
  const written = new Set();
  let failed = 0;
  for (const group of chunkTargets(targets)) {
    const records = group
      .filter((t) => t && t.recordId && t.grantFields && Object.keys(t.grantFields).length > 0)
      .map((t) => ({ id: t.recordId, fields: t.grantFields }));
    if (records.length === 0) continue;
    const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}`, {
      method: 'PATCH',
      headers: { ...auth(KEY), 'Content-Type': 'application/json' },
      body: JSON.stringify({ records, typecast: false }),
    });
    if (!res.ok) { failed += records.length; continue; }
    const data = await res.json().catch(() => ({}));
    for (const rec of data.records || []) if (rec && rec.id) written.add(rec.id);
  }
  return { written, failed };
}

/**
 * 実処理。**テストからはここを直接呼ぶ**。
 * @param {{env: object, now: number, dryRun?: boolean}} args
 */
export async function runLightTrialGrant({ env = process.env, now = Date.now(), dryRun = false } = {}) {
  const gates = readAutoGrantGates(env, now);
  const KEY = env.AIRTABLE_API_KEY;
  const BASE = env.AIRTABLE_BASE_ID;

  // ゲートが閉じているときは **dry-run（read-only）だけ**通す。実行は即終了。
  if (!gates.allOpen && !dryRun) {
    const body = { ok: false, abort: AUTOGRANT_ABORT.GATES_CLOSED, missing: gates.missing, sideEffects: 'none' };
    log(body);
    return body;
  }
  if (!KEY || !BASE) return { ok: false, abort: 'airtable_not_configured', sideEffects: 'none' };

  const offerRes = resolveOffer(TRIAL_OFFER_ID);
  if (!offerRes.ok) return { ok: false, abort: AUTOGRANT_ABORT.OFFER_UNAVAILABLE, sideEffects: 'none' };
  const offer = offerRes.offer;

  // ① コホートを読む（read-only）
  const records = await fetchCohortCustomers({ KEY, BASE });
  const { emails: blacklistEmails } = await loadBlacklistEmails({ brand: BRAND, baseId: BASE, apiKey: KEY });
  const rows = records.map((rec) => {
    const fields = rec.fields || {};
    return {
      recordId: rec.id,
      fields,
      marketing: resolveCustomerMarketing({ fields, nowMs: now, blacklistEmails }),
    };
  });

  // ② 候補を選ぶ（dry-run と本実行で同じ関数）
  const selection = selectAutoGrantCandidates({ records: rows, nowMs: now, maxGrants: MAX_GRANTS_PER_RUN });

  if (dryRun) {
    const body = {
      ok: true,
      mode: 'dry-run',
      sideEffects: 'none',
      gates: { allOpen: gates.allOpen, missing: gates.missing },
      cohort: {
        総数: selection.cohort.inCohort,
        バッチ別: selection.cohort.byBatch,
        走査件数: selection.counts.scanned,
      },
      付与候補: selection.counts.candidates,
      除外理由: Object.fromEntries(
        Object.entries(selection.counts.byReason)
          .map(([k, v]) => [AUTOGRANT_SKIP_LABEL[k] || COHORT_SKIP_LABEL[k] || k, v]),
      ),
      上限: MAX_GRANTS_PER_RUN,
      notice: 'これは下見です。**1 バイトも書いていません**（付与もキュー登録もしていません）。',
    };
    log({ mode: 'dry-run', cohort: selection.cohort.inCohort, candidates: selection.counts.candidates });
    return body;
  }

  // ③ 付与の計画（形・冪等性・除外は既存 planner が単一源）
  const plan = planAutoGrantRun({ selection, gates, offer, maxGrants: MAX_GRANTS_PER_RUN });
  if (!plan.ok) {
    log(summarizeAutoGrantRun({ plan }));
    return { ok: false, ...plan, sideEffects: 'none' };
  }
  const operationId = `light-trial-${gates.today}`;
  const grantPlan = buildComebackPlan({
    grantOffers: [offer], purchaseOffer: null,
    selected: plan.candidates,
    nowMs: now, operationId, actor: 'cron-light-trial', source: 'light-trial-autogrant',
  });
  if (!grantPlan.ok || grantPlan.targets.length === 0) {
    const body = { ok: false, abort: grantPlan.ok ? AUTOGRANT_ABORT.NO_CANDIDATES : grantPlan.error, sideEffects: 'none' };
    log(body);
    return body;
  }

  // ④ 付与（**ここが唯一 Customers を書く**）
  const { written, failed } = await applyGrants({ KEY, BASE, targets: grantPlan.targets });
  const grantedIds = recipientsAfterGrant({ targets: grantPlan.targets, writtenRecordIds: written });
  if (grantedIds.length === 0) {
    const body = { ok: false, abort: 'grant_failed', failed, sideEffects: 'none' };
    log(body);
    return body;
  }

  // ⑤ Step1 のキュー登録（**付与に成功した人だけ**）
  const base = getCampaign(CAMPAIGN_ID);
  const sending = base ? resolveSequenceStep(base, 1) : null;
  if (!sending) return { ok: false, abort: 'campaign_unavailable', granted: grantedIds.length, sideEffects: 'granted_only' };

  const provider = await fetchProviderSuppression({ apiKey: env.SENDGRID_API_KEY, now });
  if (!provider.ok) {
    // 付与は済んでいる。案内は次回の実行（または管理画面）で送る
    const body = { ok: true, granted: grantedIds.length, queued: 0, note: 'suppression 未確認のため Step1 は登録していません', sideEffects: 'granted_only' };
    log(body);
    return body;
  }

  // 付与後の値で判定する（付与直後は権利が有効になっている）
  const grantedSet = new Set(grantedIds);
  const selected = grantPlan.targets
    .filter((t) => grantedSet.has(t.recordId))
    .map((t) => {
      const src = rows.find((r) => r.recordId === t.recordId);
      const fields = { ...((src && src.fields) || {}), ...(t.grantFields || {}) };
      return { recordId: t.recordId, fields, marketing: resolveCustomerMarketing({ fields, nowMs: now, blacklistEmails }) };
    });

  const built = buildCampaignPlan({
    campaign: sending, selected,
    providerSuppressed: provider.emails,
    brand: BRAND, fromEmail: getBrandConfig(BRAND).defaultFromEmail, nowMs: now,
  });
  if (!built.ok || built.recipients.length === 0) {
    const body = { ok: true, granted: grantedIds.length, queued: 0, note: '送信対象が 0 名でした', sideEffects: 'granted_only' };
    log(body);
    return body;
  }
  const benefit = checkBenefitForSend({ campaign: sending, recipientCount: built.recipients.length });
  if (!benefit.ok) {
    return { ok: true, granted: grantedIds.length, queued: 0, note: `benefit_${benefit.reason}`, sideEffects: 'granted_only' };
  }

  const rendered = renderCampaign({ campaign: sending, name: null });
  if (!rendered) return { ok: true, granted: grantedIds.length, queued: 0, note: 'render_failed', sideEffects: 'granted_only' };

  const contentHash = computeCampaignContentHash(sending);
  const jobIdByEmail = new Map();
  let queued = 0;
  const batches = chunkRecipients(built.recipients);
  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const jobId = buildJobId({
      campaignId: base.campaignId, version: base.version, fingerprint: built.planFingerprint, index: i + 1,
    });
    const fields = buildScheduledEmailFields({
      campaignId: base.campaignId,
      subject: rendered.subject,
      html: rendered.html,
      emails: batch.map((r) => r.email),
      jobId,
      scheduledAtIso: new Date(now).toISOString(),
      notes: `marketing campaign ${base.campaignId} v${base.version} sequence step1 `
        + `grant:${operationId} content:${contentHash} shell:v${MARKETING_EMAIL_SHELL_VERSION}`,
    });
    if (!assertOnlyScheduledFields(fields)) continue;
    const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(SCHEDULED_TABLE)}`, {
      method: 'POST',
      headers: { ...auth(KEY), 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: [{ fields }], typecast: false }),
    });
    if (!res.ok) continue;
    for (const r of batch) jobIdByEmail.set(r.email, jobId);
    queued += batch.length;
  }

  const deliveryRecords = buildDeliveryRecords({
    campaign: sending, recipients: built.recipients, jobIdByEmail, nowMs: now,
  });
  for (const rec of deliveryRecords) {
    if (!assertOnlyDeliveryFields(rec.fields)) return { ok: false, abort: 'delivery_fields_rejected' };
  }
  for (let i = 0; i < deliveryRecords.length; i += 10) {
    await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(DELIVERIES_TABLE)}`, {
      method: 'PATCH',
      headers: { ...auth(KEY), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        performUpsert: { fieldsToMergeOn: ['DeliveryKey'] },
        records: deliveryRecords.slice(i, i + 10),
      }),
    });
  }

  const summary = summarizeAutoGrantRun({ plan, granted: grantedIds.length, failed, queued });
  log(summary);
  return {
    ok: true, operationId, granted: grantedIds.length, failed, queued,
    sideEffects: 'granted_and_queued',
    note: 'キュー登録まで。実送信は既存 dispatcher が行う（この Function はメールを送らない）。',
  };
}

/** Netlify Functions v2 のエントリ */
export default async function handler(req) {
  let body = {};
  try { body = await req.json(); } catch { body = {}; }
  const dryRun = body && body.dryRun === true;

  // 手動呼び出し（dry-run 含む）は管理シークレット必須
  if (dryRun) {
    const SECRET = process.env.COMEBACK_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
    const provided = req.headers.get('x-admin-secret');
    if (!SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）' });
    if (provided !== SECRET) return json(403, { error: 'Forbidden' });
  }

  try {
    const out = await runLightTrialGrant({ env: process.env, now: Date.now(), dryRun });
    return json(200, out);
  } catch (e) {
    log({ ok: false, error: String((e && e.message) || 'unknown') });
    return json(200, { ok: false, error: 'run_failed', sideEffects: 'unknown' });
  }
}

/** JST 10:30 に 1 回。ゲートが閉じていれば即終了（副作用ゼロ） */
export const config = {
  schedule: '30 1 * * *',
};
