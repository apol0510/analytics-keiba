/**
 * cron-light-trial-grant.js — Light 30日無料体験の**入口**（自動付与 → Step1 登録 / 既定 OFF）
 *
 * ⚠️ **4 つのゲートが全て開くまで、Customers へ 1 バイトも書かない。**
 *      1. `COMEBACK_GRANT_FIELDS_READY=1`       … 既存の付与ゲート（列の実在）
 *      2. `COMEBACK_GRANT_ENABLED=true`         … 既存の付与ゲート（実行許可）
 *      3. `LIGHT_TRIAL_AUTOGRANT_ENABLED=true`  … 自動化の許可
 *      4. `LIGHT_TRIAL_AUTOGRANT_ARMED=<今日の JST 日付>`（翌日には自動的に閉じる）
 *    1・2 は**手動付与と同じゲート**を再利用する（自動化のための抜け道を作らない）。
 *
 * ⚠️ **配信系ゲート（`MARKETING_CAMPAIGN_ENABLED` /
 *    `MARKETING_CAMPAIGN_DISPATCH_ENABLED`）は要求しない。**
 *    この Function は**権利を付けるだけ**で、メールを 1 通も作らないため。
 *
 * ── やること（付与だけ）──────────────────────────────────────
 *   ① 対象コホート（CSV 取り込み）を数える → 観測できなければ**中止**
 *   ② 候補を選ぶ（過去付与・有料・期限なし付与・付与中・配信不可を除外）
 *   ③ **先頭 N 件だけ付与**（既定 100・`buildComebackPlan` の計画をそのまま PATCH）
 *
 * ── やらないこと ────────────────────────────────────────────
 *   **キュー登録も送信もしない。** Step1 は別工程（管理画面の dry-run → キュー登録）で、
 *   付与に成功して無料期間中になった人だけが対象になる。
 *   付与に失敗した人は権利が無いので Step1 の対象に**入りようがない**。
 *
 * ── 段階実行（14,000 件規模でも全体 abort しない）──────────────
 *   **offset の正本は作らない。** 付与済みは次回の候補判定で外れるので、
 *   再実行すると自然に次の N 件へ進む。失敗した人は候補に残り、次回再評価される。
 *   並びは recordId 昇順で決定的（同じ入力なら毎回同じ 100 件）。
 *
 * ── dry-run（書き込みゼロ）──────────────────────────────────
 *   `{"dryRun": true}` を POST すると、**ゲートが閉じていても**
 *   「CSV 対象総数 / 付与候補 / 除外理由別件数」を返す（read-only）。
 *   手動呼び出しには `x-admin-secret` が必要。
 *
 * ⚠️ この Function が書くのは **Customers の LightGrant\* だけ**。
 *    メールも、キューの行（ScheduledEmails / CampaignDeliveries）も**一切作らない**。
 */

import {
  readAutoGrantGates, buildTrialGrantPlan, summarizeAutoGrantRun,
  AUTOGRANT_ABORT, AUTOGRANT_SKIP_LABEL, HARD_MAX_BATCH_SIZE, TRIAL_SEQUENCE_ID,
} from '../../src/lib/comeback/lightTrialAutoGrant.js';
import { COHORT_SKIP_LABEL } from '../../src/lib/crm/importedCohort.js';
import { chunkTargets } from '../../src/lib/comeback/comebackGrantPlan.js';
import { resolveCustomerMarketing } from '../../src/lib/marketing/customerMarketingAudience.js';
import { loadBlacklistEmails } from '../../src/lib/newsletter/airtable-fetch.js';
import { getCampaign } from '../../src/lib/marketing/campaignCatalog.js';
import { fetchProviderSuppression } from '../../src/lib/marketing/providerSuppression.js';
import { getBrandConfig } from '../../src/lib/newsletter/brand-config.js';

const BRAND = 'analytics-keiba';
const CUSTOMERS_TABLE = 'Customers';
const DELIVERIES_TABLE = 'CampaignDeliveries';
/** 下見（admin-marketing の trialGrant）と同じキャンペーンを見る（単一源） */
const CAMPAIGN_ID = TRIAL_SEQUENCE_ID;
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

/**
 * 関所の材料。**read-only**（この Function は CampaignDeliveries へ 1 行も書かない）。
 * そのキャンペーンの配信履歴だけを名指しで引く（全件走査しない）。
 */
async function fetchSequenceDeliveries({ KEY, BASE, campaignType }) {
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
    if (offset && pages >= MAX_PAGES) throw new Error('deliveries_fetch_truncated');
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

  // ② 関所の材料（**read-only**）: Step1 がどこまで届いているか
  const campaign = getCampaign(CAMPAIGN_ID);
  const deliveries = campaign
    ? await fetchSequenceDeliveries({ KEY, BASE, campaignType: `${campaign.campaignId}:v${campaign.version}` })
    : [];
  const provider = await fetchProviderSuppression({ apiKey: env.SENDGRID_API_KEY, now });

  // ③ 下見と実行が**同じ 1 本**を通る（画面で見た 100 件と実際に付与する 100 件が一致する）
  const planned = buildTrialGrantPlan({
    records: rows, env, nowMs: now, gates,
    sequenceCampaign: campaign, deliveries,
    providerSuppressed: provider.ok ? provider.emails : null,
    brand: BRAND, fromEmail: getBrandConfig(BRAND).defaultFromEmail,
  });

  const view = {
    offerId: planned.offerId,
    operationId: planned.operationId,
    batchSize: planned.batchSize,
    batchSizeSource: planned.batchSizeSource,
    hardMax: HARD_MAX_BATCH_SIZE,
    cohort: {
      総数: planned.cohort ? planned.cohort.inCohort : 0,
      バッチ別: planned.cohort ? planned.cohort.byBatch : {},
      走査件数: planned.counts ? planned.counts.scanned : 0,
    },
    全候補: planned.counts ? planned.counts.candidates : 0,
    今回処理予定: planned.counts ? planned.counts.batchSize : 0,
    残り: planned.counts ? planned.counts.remaining : 0,
    関所: {
      付与済み: planned.barrier ? planned.barrier.granted : 0,
      Step1未処理: planned.barrier ? planned.barrier.outstanding : 0,
      片付いた: planned.barrier ? planned.barrier.resolved : 0,
      次バッチ可: planned.barrier ? planned.barrier.nextBatchAllowed : true,
    },
    planFingerprint: planned.planFingerprint || '',
    除外理由: Object.fromEntries(
      Object.entries((planned.counts && planned.counts.byReason) || {})
        .map(([k, v]) => [AUTOGRANT_SKIP_LABEL[k] || COHORT_SKIP_LABEL[k] || k, v]),
    ),
  };

  if (dryRun) {
    const body = {
      ok: true, mode: 'dry-run', sideEffects: 'none',
      gates: { allOpen: gates.allOpen, missing: gates.missing },
      ...view,
      notice: 'これは下見です。**1 バイトも書いていません**（付与もキュー登録もしていません）。',
    };
    log({ mode: 'dry-run', cohort: view.cohort.総数, candidates: view.全候補, batch: view.今回処理予定 });
    return body;
  }

  if (!planned.ok) {
    const body = { ok: false, ...view, abort: planned.abort, reason: planned.reason, sideEffects: 'none' };
    log(summarizeAutoGrantRun({ plan: planned }));
    return body;
  }

  // ④ 付与（**ここが唯一 Customers を書く**。メールは 1 通も作らない）
  //    ここへ来るのは 関所が開いている（Step1 未処理 0 件）ときだけ
  const { written, failed } = await applyGrants({ KEY, BASE, targets: planned.plan.targets });

  const summary = summarizeAutoGrantRun({ plan: planned, granted: written.size, failed });
  log(summary);
  return {
    ok: true,
    ...view,
    granted: written.size,
    failed,
    sideEffects: 'granted_only',
    note: '付与だけを行いました。**キュー登録も送信もしていません**（Step1 は別工程）。',
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
