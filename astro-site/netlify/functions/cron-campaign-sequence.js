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
import { getCampaign, renderCampaign, listCampaigns } from '../../src/lib/marketing/campaignCatalog.js';
import {
  createSequenceScanStore, nextScanCursor, resolvePagesPerTick,
} from '../../src/lib/marketing/sequenceLedgerScan.js';
import {
  createSequenceMetricsStore, emptyMetrics, accumulateMetrics,
} from '../../src/lib/marketing/sequenceMetrics.js';
import { makeRedisCmd, createDeliveryKeyStore } from '../../src/lib/marketing/deliveryKeyStore.js';
import { createProspectStore } from '../../src/lib/marketing/prospectStore.js';
import {
  loadProspectSequenceInputs, tagRecipientSources,
} from '../../src/lib/marketing/prospectAudienceSource.js';
import {
  partitionRecipientsForLedger, resolveDeliveryStoreMode, RECIPIENT_SOURCE,
} from '../../src/lib/marketing/deliveryKeySource.js';
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

/** Redis が無い環境でも落ちない（カーソルが保存できないだけ） */
function safeRedisCmd() {
  try { return makeRedisCmd(process.env); } catch { return null; }
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

const auth = (key) => ({ Authorization: `Bearer ${key}` });

/** そのキャンペーンの配信履歴だけを引く（**全件走査しない**・打ち切りは例外） */
async function fetchCampaignDeliveries({ KEY, BASE, campaignType, startOffset = null }) {
  const out = [];
  let offset = startOffset || undefined;
  // ── tick をまたいで続きから読む（2026-08-26）────────────────────
  //
  // 1 通目を 15,491 通送ったことで台帳が 4,000 行の上限を超え、以前はここで
  // 例外になり **2 通目が 1 通も送れなかった**。
  //
  // ⚠️ 毎回「先頭 N ページ」だけ読むのは**ダメ**。ページ順は安定しているので
  //    いつも同じ人しか見えず、後ろの人が永久に進まない。
  //    前回の続き（`offset`）を保存して、そこから読む。
  // ⚠️ 読み残しは `partial` で返し、次の tick へ渡す（黙って打ち切らない）。
  const maxPages = resolvePagesPerTick(process.env);
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
  } while (offset && pages < maxPages);
  return { records: out, offset: offset || null, partial: Boolean(offset), pages };
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
  //    台帳が大きいので **前回の続きから**決まったページ数だけ読む。
  //    読み残しは次の tick が続きを読む（周回すれば全員が対象になる）。
  const redisCmd = safeRedisCmd();
  const scanStore = createSequenceScanStore({ redisCmd });
  const cursor = await scanStore.read(campaignType);
  const scan = await fetchCampaignDeliveries({ KEY, BASE, campaignType, startOffset: cursor.offset });
  const deliveries = scan.records;
  const next = nextScanCursor({ offset: scan.offset, pass: cursor.pass });
  await scanStore.write(campaignType, next);

  // ── 実績の集計（**追加の読み取りはしない**）────────────────────────
  //
  // すでに読んだ窓をそのまま数えるだけ。1 周読み切ったところで「確定」にする。
  // 管理画面はこの集計を見る（queued を送信済みとして混ぜない）。
  // 失敗しても配信は止めない（数字が出ないだけ）。
  try {
    const metricsStore = createSequenceMetricsStore({ redisCmd });
    const prev = (!cursor.offset ? null : await metricsStore.read(campaignType)) || null;
    const running = prev && prev.running ? prev.running : emptyMetrics();
    const state = { seenKeys: new Set(prev && Array.isArray(prev.seenKeys) ? prev.seenKeys : []) };
    accumulateMetrics(running, deliveries, state);
    await metricsStore.write(campaignType, {
      running,
      // 1 周読み切ったら確定版として置き換える
      final: next.completedPass ? running : (prev && prev.final) || null,
      finalAtMs: next.completedPass ? Date.now() : (prev && prev.finalAtMs) || null,
      seenKeys: [...state.seenKeys].slice(0, 40000),
      updatedAtMs: Date.now(),
      pass: next.pass,
    });
  } catch { /* 集計に失敗しても配信は続ける */ }
  const emails = [...new Set(
    deliveries.map((r) => String((r.fields || {}).RecipientEmail || '').trim().toLowerCase()).filter(Boolean),
  )];
  const { emails: blacklistEmails } = await loadBlacklistEmails({ brand: BRAND, baseId: BASE, apiKey: KEY });

  // 2-b) prospect プールからも受信対象を作る（2026-08-27 MK 確定）
  //
  // ── なぜ ────────────────────────────────────────────────────
  // CSV 取り込み分を Customers から prospect プールへ移すと、
  // **移した瞬間にこの cron の受信対象が 0 人になり 2 通目が黙って止まる**。
  // そこで移す前に「prospect からも対象を作れる」経路を通しておく。
  //
  // ⚠️ 進行の導出も停止条件も**既存の関数がそのまま**担当する
  //    （prospect を「取り込みが Customers へ書いたのと同じ fields」へ復元して渡す）。
  // ⚠️ プールが空なら何も足さない＝**従来と完全に同じ挙動**。
  // ⚠️ 索引や台帳を**読めなかったら中止する**。0 件と混同すると、
  //    送信漏れ（対象 0）か二重送信（全員未送信）のどちらかになる。
  let prospectInputs = null;
  const prospectStore = (() => {
    try { return createProspectStore({ cmd: makeRedisCmd(env) }); } catch { return null; }
  })();
  const prospectLedger = (() => {
    try { return createDeliveryKeyStore({ redisCmd: makeRedisCmd(env) }); } catch { return null; }
  })();
  if (prospectStore && prospectLedger) {
    prospectInputs = await loadProspectSequenceInputs({
      store: prospectStore, deliveryKeyStore: prospectLedger,
      campaign: base, brand: BRAND, fromEmail, nowMs: now,
      blacklistEmails,
    });
    if (!prospectInputs.ok) {
      const body = { ok: false, abort: prospectInputs.reason, sideEffects: 'none' };
      log(body);
      return body;
    }
  }
  const prospectCount = prospectInputs ? prospectInputs.rows.length : 0;

  // ⚠️ **Airtable 台帳が空でも prospect が居れば続ける。**
  //    移行後は既送信が Redis 側にしか無いので、ここで打ち切ると 2 通目が黙って止まる。
  if (emails.length === 0 && prospectCount === 0) {
    const body = { ok: false, abort: TICK_ABORT.NO_DUE, reason: 'no_one_in_sequence', sideEffects: 'none' };
    log(body);
    return body;
  }

  // 2) その人たちの現在の顧客レコード（購入・退会・プラン変更を反映するため毎回引く）
  const records = emails.length > 0 ? await fetchCustomersByEmails({ KEY, BASE, emails }) : [];
  const customerRows = records.map((rec) => {
    const fields = rec.fields || {};
    return {
      recordId: rec.id,
      fields,
      marketing: resolveCustomerMarketing({ fields, nowMs: now, blacklistEmails }),
    };
  });

  const prospectRows = prospectInputs ? prospectInputs.rows : [];
  const prospectEmails = new Set(prospectRows
    .map((r) => String((r.fields || {}).Email || '').trim().toLowerCase()).filter(Boolean));
  // 同じアドレスが両方に居たら **Customers を優先**（二重送信の防止）
  const selected = [
    ...customerRows,
    ...prospectRows.filter((r) => {
      const e = String((r.fields || {}).Email || '').trim().toLowerCase();
      return !customerRows.some((c) => String((c.fields || {}).Email || '').trim().toLowerCase() === e);
    }),
  ];

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
  //    prospect の既送信は Airtable に無いので、Redis 台帳から復元した行を足す。
  const allDeliveries = prospectInputs
    ? [...deliveries, ...prospectInputs.deliveries] : deliveries;
  //    prospect の停止（bounce / 苦情 / 配信停止）も provider の集合へ合流させる。
  const suppressed = new Set(provider.emails);
  if (prospectInputs) for (const e of prospectInputs.providerSuppressed) suppressed.add(e);
  const progress = buildSequenceProgress({
    campaign: base, selected, deliveries: allDeliveries, brand: BRAND, fromEmail, nowMs: now,
    providerSuppressed: suppressed,
    softBounced: new Set(),
    // prospect の反応は本人のレコードが持っている（Customers 側は従来どおり Map なし）
    engagementByEmail: prospectInputs && prospectInputs.engagementByEmail.size > 0
      ? prospectInputs.engagementByEmail : undefined,
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
    providerSuppressed: suppressed,
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
  //
  // ── prospect は Airtable へ 1 行も書かない（2026-08-27 MK 確定）────────
  //    Airtable はレコード上限を超過中で、CSV 由来へ 1 step 配るだけで受信者数ぶん増える。
  //    prospect の冪等性は Redis の集合が担う（`DeliveryKey` の作り方は変えない）。
  const tagged = tagRecipientSources({ recipients: built.recipients, prospectEmails });
  const ledgerMode = resolveDeliveryStoreMode(env);
  const split = partitionRecipientsForLedger({ mode: ledgerMode, recipients: tagged });
  const airtableRecipients = tagged.filter((r) => r['出所'] !== RECIPIENT_SOURCE.PROSPECT);
  const prospectRecipients = tagged.filter((r) => r['出所'] === RECIPIENT_SOURCE.PROSPECT);

  const deliveryRecords = buildDeliveryRecords({
    campaign: sending, recipients: airtableRecipients, jobIdByEmail, nowMs: now,
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

  // ⚠️ Redis 台帳は **prospect を含む全員**ぶんを記録する。
  //    prospect は Airtable に行が無いので、ここに残らないと次回そのまま二重送信になる。
  //    記録できたことを**読み戻して**確かめ、確かめられなければ失敗として数える。
  let ledgerUnverified = 0;
  if (prospectLedger && split.redisKeys.length > 0) {
    const scope = { brand: BRAND, campaignId: base.campaignId, version: base.version };
    try {
      await prospectLedger.markDelivered({ ...scope, keys: split.redisKeys });
      if (prospectRecipients.length > 0) {
        const want = prospectRecipients.map((r) => r.deliveryKey).filter(Boolean);
        const have = new Set(await prospectLedger.filterDelivered({ ...scope, keys: want }));
        ledgerUnverified = want.filter((k) => !have.has(k)).length;
      }
    } catch {
      ledgerUnverified = prospectRecipients.length;
    }
  } else if (prospectRecipients.length > 0) {
    ledgerUnverified = prospectRecipients.length;
  }
  if (ledgerUnverified > 0) {
    // 送信そのものは既に queue 済みなので止められない。**黙らない**（次の tick で気づける）
    console.error(`${SEQ_LOG_TAG} prospect 台帳を確認できません: ${ledgerUnverified} 件`);
  }

  const summary = summarizeSequenceTick({ campaignId: base.campaignId, plan, enqueued, failed });
  summary['prospect対象'] = prospectRecipients.length;
  summary['Airtable台帳'] = deliveryRecords.length;
  if (ledgerUnverified > 0) summary['台帳未確認'] = ledgerUnverified;
  log(summary);
  return {
    ok: true, step: plan.step, enqueued, failed,
    campaignId: base.campaignId, version: base.version,
    sideEffects: 'queued_only',
    note: 'キュー登録のみ。実送信は既存 dispatcher が行う（この Function はメールを送らない）。',
  };
}

/**
 * この tick で進めるキャンペーン。
 *
 * ⚠️ **2026-08-26 MK 確定で「env で指定した 1 本だけ」から変更**。
 *    以前は `MARKETING_SEQUENCE_CAMPAIGN_ID` に入れた 1 本しか進まず、
 *    キャンペーンが増えるたびに人が env を書き換える必要があった。
 *    3 区分（無料 / Light / Premium）を自動で回すには足りない。
 *
 * いまは **有効な連続配信キャンペーンを全部**、1 tick で順に 1 ステップずつ進める。
 *   - env で指定があればそれだけ（従来運用・障害時の絞り込みに使える）
 *   - 指定が無ければ カタログの有効な連続配信すべて
 *   - 1 本が失敗しても**他は続ける**（1 本の不調で全部止めない）
 */
export function resolveTickCampaignIds(env = process.env) {
  const raw = String(env?.MARKETING_SEQUENCE_CAMPAIGN_ID ?? '').trim();
  if (raw) return raw.split(',').map((x) => x.trim()).filter(Boolean);
  return listCampaigns({ includeDisabled: false })
    .filter((c) => c.usable !== false && c.sequence)
    .map((c) => c.campaignId);
}

/** Netlify Functions **v2** のエントリ（`export const config` が効くのはこの形式だけ） */
export default async function handler() {
  const ids = resolveTickCampaignIds(process.env);
  const results = [];
  for (const campaignId of ids) {
    try {
      results.push(await runSequenceTick({ env: process.env, now: Date.now(), campaignId }));
    } catch (e) {
      // 値・アドレスはログに出さない（理由コードだけ）。1 本落ちても他は続ける
      log({ ok: false, campaignId, error: String(e && e.message ? e.message : 'unknown') });
      results.push({ ok: false, campaignId, error: 'tick_failed', sideEffects: 'unknown' });
    }
  }
  const enqueued = results.reduce((n, r) => n + (Number(r && r.enqueued) || 0), 0);
  return json(200, {
    ok: results.some((r) => r && r.ok === true),
    campaigns: ids.length,
    enqueued,
    results,
  });
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
