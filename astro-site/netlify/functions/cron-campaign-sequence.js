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
  computeCampaignContentHash, assertOnlyDeliveryFields, computeCampaignDeliveryKey,
  MAX_RECIPIENTS_PER_SEND,
} from '../../src/lib/marketing/campaignSend.js';
import { getCampaign, renderCampaign, listCampaigns } from '../../src/lib/marketing/campaignCatalog.js';
import {
  createSequenceScanStore, nextScanCursor, resolvePagesPerTick,
  shouldResetCursorOnFailure, cursorAfterFailure,
} from '../../src/lib/marketing/sequenceLedgerScan.js';
import {
  createSequenceMetricsStore, emptyMetrics, accumulateMetrics,
} from '../../src/lib/marketing/sequenceMetrics.js';
import {
  makeRedisCmd, makeRedisPipeline, createDeliveryKeyStore,
} from '../../src/lib/marketing/deliveryKeyStore.js';
import { createProspectStore } from '../../src/lib/marketing/prospectStore.js';
import {
  loadProspectSequenceInputs, tagRecipientSources,
} from '../../src/lib/marketing/prospectAudienceSource.js';
import {
  partitionRecipientsForLedger, resolveDeliveryStoreMode, writesRedis, RECIPIENT_SOURCE,
  resolveRecipientLedgerPolicy,
} from '../../src/lib/marketing/deliveryKeySource.js';
import { canDispatchWithLedger } from '../../src/lib/marketing/dispatchableLedger.js';
import {
  buildDescriptorEntries, createJobDeliveryStore,
} from '../../src/lib/marketing/prospectDeliveryDescriptor.js';
import { emailHash } from '../../src/lib/marketing/prospectStore.js';
import {
  resolveAudienceFilter, applyAudienceFilter, describeAudiencePreview,
} from '../../src/lib/marketing/sequenceAudienceFilter.js';
import {
  isSequenceCampaign, resolveSequenceStep, resolveAutoStart,
} from '../../src/lib/marketing/campaignSequence.js';
import {
  readAutoStartGate, planAutoStartEntries, AUTOSTART_SKIP_LABEL,
} from '../../src/lib/drm/drmAutoStart.js';
import { FUNNEL_STAGE } from '../../src/lib/drm/drmFunnel.js';
import { buildSequenceProgress, indexDeliveries } from '../../src/lib/marketing/sequenceProgress.js';
import { loadResponseByEmail } from '../../src/lib/drm/drmResponseLoader.js';
import { createDeliveryEventIndex } from '../../src/lib/webhooks/deliveryEventIndex.js';
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
import {
  createDispatchLock, TICK_LOCK_ROOT, LOCK_FAIL,
} from '../../src/lib/marketing/dispatchLock.js';

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
    if (!res.ok) {
      // ⚠️ status を持たせる（呼び出し側が「失効した offset か」を判断する材料）
      const err = new Error(`deliveries_fetch_${res.status}`);
      err.status = res.status;
      err.hadOffset = Boolean(startOffset);
      throw err;
    }
    const data = await res.json();
    out.push(...(data.records || []));
    offset = data.offset;
    pages += 1;
  } while (offset && pages < maxPages);
  return { records: out, offset: offset || null, partial: Boolean(offset), pages };
}

/**
 * 指定した `DeliveryKey` のうち、**まだ活きている行**（`queued` / `sent`）の鍵を返す。
 *
 * ⚠️ **名指し取得**（窓読みではない）。窓の位置に関係なく「その人は既に積んである」を
 *    判定できるようにするための経路。
 * ⚠️ 1 件でも取り切れなければ**例外**（呼び出し側は fail closed で積まない）。
 * ⚠️ `cancelled` / `failed` は含めない（巻き戻し済み＝積み直してよい。
 *    `fetchDeliveredKeys` / `activeDeliveryKeys` と同じ判定）。
 */
async function fetchActiveDeliveryKeys({ KEY, BASE, keys }) {
  const list = [...new Set((keys || []).map((k) => String(k || '').trim()).filter(Boolean))];
  const active = new Set();
  for (const group of chunkList(list, 20)) {
    const safe = group.filter((k) => /^[a-f0-9]{64}$/.test(k));
    if (safe.length !== group.length) throw new Error('delivery_key_shape_invalid');
    if (safe.length === 0) continue;
    const formula = `OR(${safe.map((k) => `{DeliveryKey}='${k}'`).join(',')})`;
    let offset;
    let pages = 0;
    do {
      const body = { filterByFormula: formula, pageSize: 100, fields: ['DeliveryKey', 'Status'] };
      if (offset) body.offset = offset;
      // eslint-disable-next-line no-await-in-loop -- 20 件ずつの名指し取得
      const res = await fetch(
        `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(DELIVERIES_TABLE)}/listRecords`,
        { method: 'POST', headers: { ...auth(KEY), 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      );
      if (!res.ok) throw new Error(`delivery_keys_fetch_${res.status}`);
      // eslint-disable-next-line no-await-in-loop
      const data = await res.json();
      for (const rec of data.records || []) {
        const f = rec.fields || {};
        const st = String(f.Status || '').trim().toLowerCase();
        if (st === 'queued' || st === 'sent') active.add(String(f.DeliveryKey || '').trim());
      }
      offset = data.offset;
      pages += 1;
      if (offset && pages >= MAX_PAGES) {
        assertFetchComplete({ table: DELIVERIES_TABLE, offset, pages, maxPages: MAX_PAGES });
      }
    } while (offset);
  }
  return active;
}

/**
 * この tick で作ったジョブを取り消す（配信行を確かめられなかったときの巻き戻し）。
 *
 * ⚠️ **`CANCELLED` にするだけ**。dispatcher は `PENDING` しか拾わないので、
 *    取り消した時点で送られなくなる。Customers は 1 バイトも触らない。
 * ⚠️ 1 件でも取り消せなければ、その事実を返す（成功へ丸めない）。
 */
async function cancelCreatedJobs({ KEY, BASE, jobs, reason }) {
  const list = (jobs || []).filter((j) => j && j.recordId);
  const report = { targeted: list.length, cancelled: 0, failed: 0 };
  for (const j of list) {
    // eslint-disable-next-line no-await-in-loop -- 1 件ずつ名指し
    const res = await fetch(
      `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(SCHEDULED_TABLE)}/${j.recordId}`,
      {
        method: 'PATCH',
        headers: { ...auth(KEY), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: { Status: 'CANCELLED', Notes: `cancelled by cron-campaign-sequence: ${String(reason || '')}` },
          typecast: true,
        }),
      },
    ).catch(() => null);
    if (res && res.ok) report.cancelled += 1; else report.failed += 1;
  }
  if (report.failed > 0) {
    console.error(`${SEQ_LOG_TAG} ジョブを取り消せませんでした: ${report.failed} 件`);
  }
  return report;
}

/** prospect の予約を戻す（戻さないとその人は二度と送られない） */
async function releaseClaimedKeys(ledger, scope, keys) {
  const list = (keys || []).filter(Boolean);
  if (!ledger || list.length === 0) return false;
  try {
    await ledger.releaseClaims({ ...scope, keys: list });
    return true;
  } catch {
    console.error(`${SEQ_LOG_TAG} prospect の予約を戻せませんでした: ${list.length} 件`);
    return false;
  }
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
 * **入口の候補**を読む（`sequence.autoStart` を宣言した campaign だけ）。
 *
 * ⚠️ **全件走査をしない。** Airtable の `CREATED_TIME()` で「登録が新しい人」だけを引く。
 *    新しい列は足していない（`auth-user` は登録日の列を書かない）。
 * ⚠️ 読み切れなければ**例外**。部分集合を母集団として扱わない。
 * ⚠️ ここでは**誰も選ばない**。選ぶのは純粋な `planAutoStartEntries`。
 */
async function fetchAutoStartCandidates({ KEY, BASE, withinDays }) {
  const out = [];
  const formula = `IS_AFTER(CREATED_TIME(), DATEADD(NOW(), -${Number(withinDays)}, 'days'))`;
  let offset;
  let pages = 0;
  do {
    const body = { filterByFormula: formula, pageSize: 100 };
    if (offset) body.offset = offset;
    // eslint-disable-next-line no-await-in-loop -- Airtable は offset 方式
    const res = await fetch(
      `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}/listRecords`,
      { method: 'POST', headers: { ...auth(KEY), 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    if (!res.ok) throw new Error(`autostart_candidates_fetch_${res.status}`);
    // eslint-disable-next-line no-await-in-loop
    const data = await res.json();
    out.push(...(data.records || []));
    offset = data.offset;
    pages += 1;
    if (offset && pages >= MAX_PAGES) {
      assertFetchComplete({ table: CUSTOMERS_TABLE, offset, pages, maxPages: MAX_PAGES });
    }
  } while (offset);
  return out;
}

/**
 * 実処理。**テストからはここを直接呼ぶ**（HTTP の器を挟まない）。
 * @param {{env: object, now: number, deps?: object}} args
 */
export async function runSequenceTick({
  env = process.env, now = Date.now(), campaignId,
  /**
   * **下見**（`true` なら 1 バイトも書かない）。
   *
   * ⚠️ 予約（`claimDelivered`）より**手前で必ず return する**。
   *    予約は「取った時点で送信済み扱い」なので、下見で取ると
   *    送っていない人が二度と対象に戻らなくなる。
   * ⚠️ 下見はゲートが閉じていても実行できる（読むだけ）。
   *    ただし**ゲートの状態を必ず応答へ載せる**（開いていると誤解させない）。
   */
  dryRun = false,
} = {}) {
  const isDry = dryRun === true;
  const gates = readSequenceGates(env, now);
  if (!isDry && !gates.allOpen) {
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
  /**
   * ⚠️ **保存した offset が失効していても自力で復帰する**（2026-09-08 の障害）。
   *    失効した offset で落ちたまま throw すると、カーソルが更新されないので
   *    次の tick も同じ失効値で落ちる = **その campaign は永久に進まない**。
   *    失効と判断できるときは**カーソルを捨てて先頭から読み直す**。
   *    走査の重複は送信の重複にならない（冪等性は `DeliveryKey` が持つ）。
   */
  let scan;
  let scanRecovered = null;
  try {
    scan = await fetchCampaignDeliveries({ KEY, BASE, campaignType, startOffset: cursor.offset });
  } catch (e) {
    const reset = shouldResetCursorOnFailure({ hadOffset: Boolean(cursor.offset), status: e && e.status });
    if (!reset) throw e;
    scanRecovered = `offset_expired_${(e && e.status) || 'unknown'}`;
    console.error(`${SEQ_LOG_TAG} 走査カーソルが失効したため先頭から読み直します: ${scanRecovered}`);
    await scanStore.write(campaignType, cursorAfterFailure({ pass: cursor.pass }));
    scan = await fetchCampaignDeliveries({ KEY, BASE, campaignType, startOffset: null });
  }
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
  /** prospect を対象に含められなかった理由（**0 人と区別する**） */
  let prospectDegraded = null;
  const prospectStore = (() => {
    try { return createProspectStore({ cmd: makeRedisCmd(env) }); } catch { return null; }
  })();
  const prospectLedger = (() => {
    try {
      // pipeline があると鍵ごとの `SADD` を 1 リクエストにまとめられる（予約の要）
      return createDeliveryKeyStore({
        redisCmd: makeRedisCmd(env), redisPipeline: makeRedisPipeline(env),
      });
    } catch { return null; }
  })();
  /** prospect の「配信の身分証」（jobId → emailHash → DeliveryKey）の置き場所 */
  const jobDeliveryStore = createJobDeliveryStore({
    redisCmd: safeRedisCmd(),
    redisPipeline: (() => {
      try { return makeRedisPipeline(env); } catch { return null; }
    })(),
  });
  if (!prospectStore || !prospectLedger) prospectDegraded = 'redis_unavailable';
  if (prospectStore && prospectLedger) {
    prospectInputs = await loadProspectSequenceInputs({
      store: prospectStore, deliveryKeyStore: prospectLedger,
      campaign: base, brand: BRAND, fromEmail, nowMs: now,
      blacklistEmails,
    });
    if (!prospectInputs.ok) {
      // ⚠️ **Customers 由来の配信は止めない**（既存挙動を変えない）。
      //    prospect だけを 1 人も対象にせず、理由を残して続ける。
      //    0 人と混同しないよう、理由コードは必ずログと応答に出す。
      console.error(`${SEQ_LOG_TAG} prospect を読めないため対象に含めません: ${prospectInputs.reason}`);
      prospectDegraded = prospectInputs.reason;
      prospectInputs = null;
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

  // ── 入口の自動開始（`sequence.autoStart` を宣言した campaign だけ）──────
  //
  // ⚠️ 既定では **step1 を自動で撃たない**（母集団が最大になるため）。
  //    宣言があり、かつ専用ゲート（`MARKETING_DRM_AUTOSTART_ENABLED`）が開いている
  //    ときだけ、**登録が新しい無料会員**を上限つきで入口へ入れる。
  // ⚠️ 読めなければ**入口を開けない**（既存の配信は止めない）。
  const autoStartDecl = resolveAutoStart(base);
  const autoStartGate = readAutoStartGate(env);
  let autoStartRows = [];
  let autoStartReport = autoStartDecl
    ? { declared: true, open: autoStartGate.open, missing: autoStartGate.missing, entered: 0, skipped: {} }
    : { declared: false, open: false, missing: [], entered: 0, skipped: {} };
  if (autoStartDecl && autoStartGate.open) {
    try {
      const candidateRecords = await fetchAutoStartCandidates({
        KEY, BASE, withinDays: autoStartDecl.withinDays,
      });
      const candidates = candidateRecords.map((rec) => ({
        recordId: rec.id,
        fields: rec.fields || {},
        createdTimeMs: Date.parse(rec.createdTime || '') || null,
        marketing: resolveCustomerMarketing({
          fields: rec.fields || {}, nowMs: now, blacklistEmails,
        }),
      }));
      // 選ぶのは純粋関数。ここは I/O だけ
      const planned = planAutoStartEntries({
        campaign: base, candidates,
        // ⚠️ **prospect 台帳から復元した送信済みも含めて**「もう受け取っているか」を見る
        //    （#521 で prospect の既送信は Airtable ではなく Redis 由来になったため、
        //      Airtable 側だけを見ると二重に入口へ入れる可能性がある）
        deliveredIndex: indexDeliveries(
          prospectInputs ? [...deliveries, ...prospectInputs.deliveries] : deliveries,
        ),
        brand: BRAND, fromEmail, nowMs: now,
        expectedStage: FUNNEL_STAGE.FREE_TO_PAID,
      });
      const byId = new Map(candidates.map((c) => [c.recordId, c]));
      autoStartRows = planned.recordIds.map((rid) => byId.get(rid)).filter(Boolean);
      autoStartReport = {
        declared: true, open: true, missing: [],
        considered: planned.considered,
        entered: autoStartRows.length,
        capped: planned.capped === true,
        carriedOver: planned.carriedOver || 0,
        skipped: planned.skipped,
        skipLabels: AUTOSTART_SKIP_LABEL,
      };
    } catch (e) {
      // ⚠️ 入口が読めないだけで、**進行中の配信は止めない**
      autoStartRows = [];
      autoStartReport = {
        declared: true, open: true, missing: [], entered: 0, skipped: {},
        error: String((e && e.message) || 'autostart_unavailable'),
      };
      console.error(`${SEQ_LOG_TAG} 入口の候補を読めないため開けません: ${autoStartReport.error}`);
    }
  }

  const prospectRows = prospectInputs ? prospectInputs.rows : [];
  const prospectEmails = new Set(prospectRows
    .map((r) => String((r.fields || {}).Email || '').trim().toLowerCase()).filter(Boolean));
  // 同じアドレスが両方に居たら **Customers を優先**（二重送信の防止）
  const emailOf = (r) => String((r.fields || {}).Email || '').trim().toLowerCase();
  const knownEmails = new Set(customerRows.map(emailOf).filter(Boolean));
  // 入口の候補は **まだ 1 通も受け取っていない人**なので台帳由来の行とは重ならないが、
  // 念のため重複を除く（同じ人を 2 行にすると 2 通になる）
  const entryRows = autoStartRows.filter((r) => {
    const e = emailOf(r);
    if (!e || knownEmails.has(e)) return false;
    knownEmails.add(e);
    return true;
  });
  const selected = [
    ...customerRows,
    ...entryRows,
    ...prospectRows.filter((r) => !knownEmails.has(emailOf(r))),
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
  // ── 反応別 routing（DRM）の入力 ────────────────────────────────
  // ⚠️ `campaign.sequence.responseRoutes` を宣言した campaign でだけ索引を読む。
  //    宣言が無ければ 1 鍵も読まない（既存のコストと挙動をそのまま維持する）。
  // ⚠️ 索引が読めない / 予算を超えた相手は **`unknown` = 線形**（推測で分岐しない）。
  // ⚠️ 管理画面（`admin-marketing` の `action=sequence`）と**同じ関数**で読む。
  //    別々に読むと、画面に出る「次の 1 通」と実際に送る 1 通がズレる。
  const response = await loadResponseByEmail({
    campaign: base, recipients: selected, deliveries: allDeliveries,
    brand: BRAND, fromEmail,
    providerSuppressed: suppressed, softBounced: new Set(),
    makeIndex: () => createDeliveryEventIndex({ cmd: makeRedisCmd(env) }),
  });
  if (!response.ok) {
    // 効かなかったこと自体をログに残す（黙って線形に戻ると「効いている」と誤認する）
    console.log(`${SEQ_LOG_TAG} response routing 不使用: ${response.reason}`);
  }

  const progress = buildSequenceProgress({
    campaign: base, selected, deliveries: allDeliveries, brand: BRAND, fromEmail, nowMs: now,
    providerSuppressed: suppressed,
    softBounced: new Set(),
    // prospect の反応は本人のレコードが持っている（Customers 側は従来どおり Map なし）
    engagementByEmail: prospectInputs && prospectInputs.engagementByEmail.size > 0
      ? prospectInputs.engagementByEmail : undefined,
    responseByEmail: response.ok ? response.byEmail : undefined,
  });
  const plan = planSequenceTick({
    progress, gates, maxRecipients: resolveMaxRecipientsPerTick(process.env),
    // ⚠️ step1 を自動で撃てるのは、**入口を宣言していて ゲートも開いている**ときだけ
    allowFirstStep: autoStartDecl !== null && autoStartGate.open === true,
  });
  if (!plan.ok) {
    const body = { ok: false, ...plan, autoStart: autoStartReport, sideEffects: 'none' };
    log({ ...summarizeSequenceTick({ campaignId: base.campaignId, plan }), 入口: autoStartReport });
    return body;
  }

  // 5) 送信計画（除外・DeliveryKey は既存の単一源がそのまま担当）
  const sending = resolveSequenceStep(base, plan.step);
  const byId = new Map(selected.map((c) => [c.recordId, c]));
  const allTargets = plan.recordIds.map((rid) => byId.get(rid)).filter(Boolean);
  const scope = { brand: BRAND, campaignId: base.campaignId, version: base.version };
  const keyOfTarget = (t) => computeCampaignDeliveryKey({
    campaign: sending,
    recipientEmail: String((t.fields || {}).Email || '').trim().toLowerCase(),
    brand: BRAND, fromEmail,
  });

  /**
   * ── 5-a) **鍵を名指しで**突き合わせてから積む（2026-09-14 恒久修正）────────
   *
   * ## 何が起きていたか（本番実測）
   *
   * 進行（誰が何通目か）は台帳の**窓読み**（`fetchCampaignDeliveries` が
   * `offset` で少しずつ進む）から作る。窓の外に置かれた「その人の step2 の行」は
   * **見えない**ので、既に積んだ人がもう一度 due に見える。
   * その結果、同じ人が 10 分ごとに新しいジョブへ積み直され、
   * 2026-09-09〜09-14 の実測で **3,771 名 × 42〜46 回**（PENDING ジョブ 4,307 件 /
   * 宛先スロット 179,250）まで膨らんだ。
   *
   * ## 直し方
   *
   * これから積む人の `DeliveryKey` を**名指しで**引き、`queued` / `sent` の行が
   * 既にあるなら**その人はこの tick では積まない**。窓の位置に依存しない。
   *
   * ⚠️ **読めなければ積まない**（fail closed）。読めないことを「未送信」と読むと
   *    二重登録が再発する。
   * ⚠️ `cancelled` / `failed` は既送信に数えない（巻き戻し済み＝積み直してよい）。
   *    判定は `活きている行` の単一源 `ACTIVE_DELIVERY_STATUS` に合わせる。
   */
  let activeKeys = null;
  try {
    activeKeys = await fetchActiveDeliveryKeys({
      KEY, BASE, keys: allTargets.map(keyOfTarget).filter(Boolean),
    });
  } catch {
    activeKeys = null;
  }
  if (activeKeys === null) {
    const body = { ok: false, abort: 'delivery_ledger_unreadable', sideEffects: 'none' };
    log(body);
    return body;
  }
  const dueTargets = allTargets.filter((t) => !activeKeys.has(keyOfTarget(t)));
  const alreadyQueued = allTargets.length - dueTargets.length;

  /**
   * ── 5-a-2) **出所で絞る**（既定 `all` ＝ 従来どおり）────────────────
   *
   * 2026-09-14 の初回実配信 150 通は**全員が Customers 由来**で、prospect が
   * 1 人も含まれなかった（`selectNextDueStep` は出所を見ないため）。
   * prospect 経路だけを少数で実証するために、**絞る**手段を用意する。
   *
   * ⚠️ 絞るのは**減らす方向だけ**。除外条件・冪等性・送信直前再検証は一切変えない。
   * ⚠️ `MARKETING_SEQUENCE_SOURCE_FILTER` を置かない限り挙動は変わらない。
   */
  const audienceFilter = resolveAudienceFilter(env);
  const filtered = applyAudienceFilter({
    targets: dueTargets, prospectEmails, filter: audienceFilter,
  });
  const targets = filtered.kept;
  const preview = describeAudiencePreview({
    bySource: filtered.bySource, kept: targets, filter: filtered.filter,
    step: plan.step, campaignId: base.campaignId,
  });

  /**
   * ── 下見はここで終わる（**予約より手前**）────────────────────────
   * 予約を取ると「送信済み扱い」になるので、下見では絶対に取らない。
   */
  if (isDry) {
    const body = {
      ok: true, dryRun: true, step: plan.step, campaignId: base.campaignId,
      sideEffects: 'none',
      gates: { allOpen: gates.allOpen, missing: gates.missing },
      alreadyQueued,
      ...preview,
      note: '下見です。予約・キュー登録・送信はいずれも行っていません。',
    };
    log(body);
    return body;
  }

  if (targets.length === 0) {
    const body = {
      ok: false, abort: TICK_ABORT.NO_DUE,
      reason: filtered.dropped > 0 ? 'filtered_out' : 'all_already_queued',
      alreadyQueued, ...preview, sideEffects: 'none',
    };
    log(body);
    return body;
  }

  // ── 5-b) prospect は **queue の前に予約する**（2026-08-27 恒久修正）────────
  //
  // ⚠️ 以前は queue のあとに Redis へ記録していた。その順序だと
  //      queue 成功 → Redis 記録失敗 → 次の tick で未送信扱い → **二重 queue**
  //    が起きる（Airtable に行が無い prospect は Redis だけが冪等性の根拠なので、
  //    記録が落ちた瞬間に「送っていない人」に戻ってしまう）。
  //
  // そこで `SADD` の戻り値（0/1）で **鍵ごとに 1 回だけ**所有権を渡し、
  // 取れた人だけを queue する。`SADD` は atomic なので、
  // **並行 tick が同じ鍵を取ることは構造的に起きない**。
  //
  // ⚠️ Redis が使えない / 予約が確定できないときは **prospect を 1 人も queue しない**。
  //    Customers 由来はこれまでどおり進む（既存挙動を変えない）。
  // ⚠️ 予約したのに queue できなかった鍵は必ず戻す（戻さないと二度と送られない）。
  const prospectTargetsAll = targets.filter((t) => prospectEmails.has(
    String((t.fields || {}).Email || '').trim().toLowerCase(),
  ));
  const customerTargets = targets.filter((t) => !prospectEmails.has(
    String((t.fields || {}).Email || '').trim().toLowerCase(),
  ));

  /**
   * ── 5-c) **送れない置き場所の受信者は積まない**（2026-09-14 恒久修正）────────
   *
   * prospect は Airtable に配信行を作らない運用（2026-08-27 MK 確定）だが、
   * dispatcher は `custom_args` を **Airtable の配信行からしか**作れない
   * （`campaignCustomArgs.js`）。行が無い相手は必ず `delivery_not_found` で skip される。
   *
   * それでも積むと、**送れないのに Redis の予約だけが焼かれ**、経路を直しても
   * その人には二度と届かない。だから**積む前に止める**（判定は `dispatchableLedger.js`）。
   *
   * ⚠️ これは prospect を諦める変更ではない。送信経路が Redis だけの配信識別に
   *    対応すれば `AIRTABLE_ROW_REQUIRED` を false にするだけで解禁される。
   */
  const prospectPolicy = resolveRecipientLedgerPolicy({
    mode: resolveDeliveryStoreMode(env), source: RECIPIENT_SOURCE.PROSPECT,
  });
  const prospectDispatchable = canDispatchWithLedger(prospectPolicy);
  const prospectTargets = prospectDispatchable.ok ? prospectTargetsAll : [];
  const prospectNotDispatchable = prospectDispatchable.ok ? 0 : prospectTargetsAll.length;
  if (prospectNotDispatchable > 0) {
    console.error(
      `${SEQ_LOG_TAG} prospect は現在の送信経路では送れないため積みません: `
      + `${prospectNotDispatchable} 件 / 理由 ${prospectDispatchable.reason}`,
    );
  }

  let claimedKeys = new Set();
  let prospectBlocked = 0;
  let prospectClaimFailure = null;
  if (prospectTargets.length > 0) {
    if (!prospectLedger) {
      prospectBlocked = prospectTargets.length;
      prospectClaimFailure = 'redis_unavailable';
    } else {
      try {
        const keys = prospectTargets.map(keyOfTarget).filter(Boolean);
        if (keys.length !== prospectTargets.length) throw new Error('key_build_failed');
        const claim = await prospectLedger.claimDelivered({ ...scope, keys });
        claimedKeys = new Set(claim.claimed);
        prospectBlocked = prospectTargets.length - claimedKeys.size;
      } catch {
        // ⚠️ **予約が確定できない = 送らない**（未送信と見なして送ると二重送信になる）
        claimedKeys = new Set();
        prospectBlocked = prospectTargets.length;
        prospectClaimFailure = 'claim_failed';
      }
    }
  }
  if (prospectClaimFailure) {
    console.error(`${SEQ_LOG_TAG} prospect の予約を取れないため送りません: ${prospectClaimFailure} / ${prospectBlocked} 件`);
  }
  const claimedProspectTargets = prospectTargets.filter((t) => claimedKeys.has(keyOfTarget(t)));

  const built = buildCampaignPlan({
    campaign: sending, selected: [...customerTargets, ...claimedProspectTargets],
    providerSuppressed: suppressed,
    brand: BRAND, fromEmail, nowMs: now,
  });

  /**
   * 予約したのに送信計画へ載らなかった鍵を戻す（除外・上限などで落ちた分）。
   * **戻さないとその人は二度と送られない**（集合に残ったままで既送信扱いになる）。
   */
  const releaseUnused = async (usedEmails) => {
    if (claimedKeys.size === 0 || !prospectLedger) return;
    const stale = claimedProspectTargets
      .filter((t) => !usedEmails.has(String((t.fields || {}).Email || '').trim().toLowerCase()))
      .map(keyOfTarget)
      .filter(Boolean);
    if (stale.length === 0) return;
    try {
      await prospectLedger.releaseClaims({ ...scope, keys: stale });
    } catch {
      console.error(`${SEQ_LOG_TAG} prospect の予約を戻せませんでした: ${stale.length} 件`);
    }
  };
  if (!built.ok || built.recipients.length === 0) {
    await releaseUnused(new Set());
    const body = {
      ok: false, abort: built.ok ? TICK_ABORT.NO_DUE : built.error, sideEffects: 'none',
      ...(prospectBlocked > 0 ? { prospectBlocked, prospectClaimFailure } : {}),
    };
    log(body);
    return body;
  }
  if (built.recipients.length > MAX_RECIPIENTS_PER_SEND) {
    await releaseUnused(new Set());
    return { ok: false, abort: TICK_ABORT.OVER_MAX, sideEffects: 'none' };
  }
  // 送信計画に載らなかった予約はここで戻す（除外で落ちた分）
  await releaseUnused(new Set(built.recipients.map((r) => String(r.email || '').toLowerCase())));

  // 6) 得の宣言（大量配信は宣言が無ければ送れない）
  const benefit = checkBenefitForSend({ campaign: sending, recipientCount: built.recipients.length });
  if (!benefit.ok) {
    await releaseUnused(new Set());   // 送らないので予約を戻す
    const body = { ok: false, abort: `benefit_${benefit.reason}`, sideEffects: 'none' };
    log(body);
    return body;
  }

  const rendered = renderCampaign({ campaign: sending, name: null });
  if (!rendered) {
    await releaseUnused(new Set());
    return { ok: false, abort: 'render_failed', sideEffects: 'none' };
  }

  // 7) キュー登録（ScheduledEmails PENDING + CampaignDeliveries queued）
  //
  // ⚠️ **出所（customer / prospect）はここで確定させる。** 以降のバッチ分割・
  //    配信行の書き分け・prospect の身分証づくりは、すべてこの `tagged` を使う。
  const tagged = tagRecipientSources({ recipients: built.recipients, prospectEmails });
  const contentHash = computeCampaignContentHash(sending);
  const jobIdByEmail = new Map();
  /** この tick で作ったジョブ（配信行を確かめられなければ取り消す） */
  const createdJobs = [];
  /** prospect の身分証を保存できなかったバッチ数（**送れないので積まない**） */
  let descriptorFailed = 0;
  let enqueued = 0;
  let failed = 0;
  const batches = chunkRecipients(tagged);
  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const jobId = buildJobId({
      campaignId: base.campaignId, version: base.version,
      fingerprint: built.planFingerprint, index: i + 1,
    });
    /**
     * ── prospect の「配信の身分証」を**ジョブを作る前に**置く ─────────────
     *
     * prospect は Airtable に配信行を作らないので、送信時に `custom_args` の材料
     * （`DeliveryKey`）を読む先が要る。`jobId` は fingerprint 由来で先に決まるので、
     * **ジョブを作る前**に対応表を書ける。
     *
     * ⚠️ 書けなければ**そのバッチは積まない**。積むと「送れないのに予約だけ焼けた人」に戻る。
     * ⚠️ 鍵は enqueue 時のものをそのまま置く（送信側で作り直さない）。
     */
    const { entries, dropped } = buildDescriptorEntries({ recipients: batch, hashFn: emailHash });
    if (dropped > 0 || (entries.length > 0 && !jobDeliveryStore.usable)) {
      descriptorFailed += 1;
      failed += batch.length;
      continue;
    }
    if (entries.length > 0) {
      const saved = await jobDeliveryStore.save({ jobId, entries });
      if (!saved) {
        console.error(`${SEQ_LOG_TAG} prospect の配信識別子を保存できないため積みません: ${entries.length} 件`);
        descriptorFailed += 1;
        failed += batch.length;
        continue;
      }
    }
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
    /**
     * ⚠️ **`{ jobId, recordId }` の形で入れる**（`buildDeliveryRecords` の契約）。
     *    文字列を入れると `ScheduledEmailJobId` の無い配信行が出来て、
     *    dispatcher がその行を引けず **1 通も送れない**（2026-09 の本番障害）。
     */
    let jobRecordId = null;
    try {
      const created = await res.json();
      jobRecordId = String(((created.records || [])[0] || {}).id || '') || null;
    } catch { jobRecordId = null; }
    for (const r of batch) jobIdByEmail.set(r.email, { jobId, recordId: jobRecordId });
    createdJobs.push({ jobId, recordId: jobRecordId, recipientCount: batch.length });
    enqueued += batch.length;
  }

  // 8) 1 通ごとの正本（DeliveryKey で upsert = 何度実行しても 1 行）
  //
  // ── prospect は Airtable へ 1 行も書かない（2026-08-27 MK 確定）────────
  //    Airtable はレコード上限を超過中で、CSV 由来へ 1 step 配るだけで受信者数ぶん増える。
  //    prospect の冪等性は Redis の集合が担う（`DeliveryKey` の作り方は変えない）。
  //    ⚠️ `tagged` は 7) の先頭で作ってある（バッチ分割と身分証づくりが同じ出所を見るため）。
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
  /**
   * ⚠️ **組み立て段の取りこぼしを先に捕まえる。**
   *    `buildDeliveryRecords` は形が合わない行を落とす（`jobIdByEmail` の形違いなど）。
   *    落ちたまま進むと **JobId の無い行**や**行の無い宛先**が残り、dispatcher が
   *    その相手を `delivery_not_found` で skip して **1 通も送れない**。
   */
  if (deliveryRecords.length !== airtableRecipients.length) {
    await cancelCreatedJobs({ KEY, BASE, jobs: createdJobs, reason: 'records_dropped' });
    await releaseClaimedKeys(prospectLedger, scope, [...claimedKeys]);
    const body = {
      ok: false, abort: 'delivery_records_dropped',
      expected: airtableRecipients.length, built: deliveryRecords.length,
      sideEffects: 'jobs_cancelled',
    };
    log(body);
    return body;
  }
  /**
   * ⚠️ **応答を必ず見る。** 2026-09 の本番障害では、ここの `fetch` の戻り値を
   *    まったく確かめていなかったため、台帳が 1 行も書けていないのに tick は成功扱いで終わり、
   *    次の tick が同じ人をまた積む——を 10 分ごとに繰り返していた。
   */
  let upsertFailed = null;
  for (let i = 0; i < deliveryRecords.length; i += 10) {
    const chunk = deliveryRecords.slice(i, i + 10);
    // eslint-disable-next-line no-await-in-loop -- Airtable の upsert は 10 件ずつ
    const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(DELIVERIES_TABLE)}`, {
      method: 'PATCH',
      headers: { ...auth(KEY), 'Content-Type': 'application/json' },
      body: JSON.stringify({ performUpsert: { fieldsToMergeOn: ['DeliveryKey'] }, records: chunk }),
    }).catch(() => null);
    if (!res || !res.ok) { upsertFailed = res ? `http_${res.status}` : 'network'; break; }
  }

  /**
   * ⚠️ **読み戻して確かめてから成功と言う。** 例外が出なかったことは「書けた」の証拠にならない。
   *    揃っていなければ、この tick で作ったジョブを取り消し、prospect の予約も戻す
   *    （戻さないとその人は二度と送られない）。
   */
  let verifiedKeys = null;
  try {
    verifiedKeys = await fetchActiveDeliveryKeys({
      KEY, BASE, keys: deliveryRecords.map((r) => String(r.fields.DeliveryKey || '')),
    });
  } catch { verifiedKeys = null; }
  const missingKeys = verifiedKeys === null
    ? null
    : deliveryRecords.filter((r) => !verifiedKeys.has(String(r.fields.DeliveryKey || ''))).length;
  if (verifiedKeys === null || missingKeys > 0) {
    await cancelCreatedJobs({ KEY, BASE, jobs: createdJobs, reason: 'delivery_rows_unconfirmed' });
    await releaseClaimedKeys(prospectLedger, scope, [...claimedKeys]);
    const body = {
      ok: false,
      abort: 'delivery_rows_unconfirmed',
      upsertFailed,
      expected: deliveryRecords.length,
      missing: missingKeys,
      sideEffects: 'jobs_cancelled',
      note: '配信行を確認できないため、作ったジョブを取り消しました。次の tick が同じ人をやり直します。',
    };
    log(body);
    return body;
  }

  // ── prospect の冪等性は **queue の前に確定済み**（5-b の予約）────────────
  //
  // ここで改めて記録する必要は無い。予約が集合に入った時点で、
  // 次の tick はその鍵を「既送信」として扱う（`filterDelivered` / hydration）。
  //
  // やることは 1 つだけ: **queue できなかった prospect の予約を戻す**。
  // 戻さないと、その人は集合に残ったまま既送信扱いになり **二度と送られない**。
  const queuedEmails = new Set(jobIdByEmail.keys());
  const notQueuedProspectKeys = prospectRecipients
    .filter((r) => !queuedEmails.has(r.email))
    .map((r) => r.deliveryKey)
    .filter(Boolean);
  let releaseFailed = 0;
  if (notQueuedProspectKeys.length > 0 && prospectLedger) {
    try {
      await prospectLedger.releaseClaims({ ...scope, keys: notQueuedProspectKeys });
    } catch {
      releaseFailed = notQueuedProspectKeys.length;
      console.error(`${SEQ_LOG_TAG} prospect の予約を戻せませんでした: ${releaseFailed} 件`);
    }
  }

  // Customers 由来の Redis 記録は**従来どおり**（`MARKETING_DELIVERY_STORE` に従う）。
  // Airtable が正本なので、ここが落ちても致命にしない（差分は reconcile が拾う）。
  const customerRedisKeys = split.redisKeys.filter(
    (k) => !prospectRecipients.some((r) => r.deliveryKey === k),
  );
  if (prospectLedger && writesRedis(ledgerMode) && customerRedisKeys.length > 0) {
    try {
      await prospectLedger.markDelivered({ ...scope, keys: customerRedisKeys });
    } catch {
      console.warn(`${SEQ_LOG_TAG} customer 側の Redis 記録に失敗（Airtable が正本のため継続）`);
    }
  }

  const summary = summarizeSequenceTick({ campaignId: base.campaignId, plan, enqueued, failed });
  summary['prospect対象'] = prospectRecipients.length;
  summary['Airtable台帳'] = deliveryRecords.length;
  if (prospectDegraded) summary['prospect除外'] = prospectDegraded;
  if (scanRecovered) summary['走査カーソル復帰'] = scanRecovered;
  if (prospectBlocked > 0) summary['prospect予約不可'] = prospectBlocked;
  if (prospectClaimFailure) summary['prospect予約失敗'] = prospectClaimFailure;
  if (releaseFailed > 0) summary['予約戻し失敗'] = releaseFailed;
  // #521（prospect 実送信 / delivered 10 通の無反応除外）の観測項目
  if (alreadyQueued > 0) summary['登録済みのため除外'] = alreadyQueued;
  if (prospectNotDispatchable > 0) summary['prospect送信不可'] = prospectNotDispatchable;
  if (descriptorFailed > 0) summary['身分証を置けず未登録'] = descriptorFailed;
  // #522（DRM の入口）: 開けたか / 開けなかった理由（**黙って 0 にしない**）
  if (autoStartReport.declared) summary['入口'] = autoStartReport;
  log(summary);
  return {
    ok: true, step: plan.step, enqueued, failed, autoStart: autoStartReport,
    campaignId: base.campaignId, version: base.version,
    alreadyQueued,
    prospectNotDispatchable,
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

/** 多重起動を防ぐ tick 鍵の名前（`cron-marketing-rollout` と同じ仕組み・別の名前） */
export const SEQUENCE_TICK_LOCK_ID = 'tick:campaign-sequence';
/**
 * tick 鍵の寿命。
 * この Function の実行時間より十分長く、**次の tick（10 分）より短く**する。
 * 長すぎると落ちたときに次の tick まで再開できない。
 */
export const SEQUENCE_TICK_LOCK_TTL_SEC = 240;

/** Netlify Functions **v2** のエントリ（`export const config` が効くのはこの形式だけ） */
export default async function handler() {
  /**
   * ── 同じ tick を重ねて走らせない（2026-09-14 の実測を受けて追加）──────
   *
   * ## 何が起きたか（本番実測）
   *
   * `MARKETING_SEQUENCE_MAX_PER_TICK=50` を置いて再開したところ、
   * **1 つの tick 枠で 3 回起動**し、50×3 = **150 名**が積まれた。
   *
   *   07:10:13 / 07:10:35 / 07:10:52 に別々のジョブ（各 50 名）
   *
   * 上限は**1 起動あたり**に効くので、多重起動すると意図した速度制御が効かない
   * （全開時なら 500×3 = 1,500 名/tick になる）。
   * `cron-marketing-rollout` は同じ理由で既に tick 鍵を持っている。こちらにも入れる。
   *
   * ⚠️ **鍵が取れなければ 1 件も積まない**（副作用ゼロで終わる）。
   *    「取れなかったから代わりに少しだけ積む」のような妥協をしない。
   * ⚠️ Redis へ到達できないときも**積まない**（多重起動を防げない状態で走らせない）。
   *
   * ℹ️ このとき二重送信は起きなかった。積む前に配信行を名指しで突き合わせる
   *    ガード（2026-09-14 追加）が効き、3 回の起動が別々の 50 名を選んだため。
   *    鍵はその**手前**で多重起動そのものを止める。
   */
  let lock = null;
  let token = null;
  try {
    lock = createDispatchLock({ cmd: makeRedisCmd(process.env), root: TICK_LOCK_ROOT });
    const got = await lock.acquire({
      jobId: SEQUENCE_TICK_LOCK_ID, ttlSec: SEQUENCE_TICK_LOCK_TTL_SEC,
    });
    if (!got.ok) {
      const reason = got.reason === LOCK_FAIL.BUSY ? 'tick_busy' : 'tick_lock_unavailable';
      log({ ok: true, action: 'skip', reason, sideEffects: 'none' });
      return json(200, { ok: true, action: 'skip', reason, sideEffects: 'none' });
    }
    token = got.token;
  } catch {
    log({ ok: true, action: 'skip', reason: 'tick_lock_unavailable', sideEffects: 'none' });
    return json(200, { ok: true, action: 'skip', reason: 'tick_lock_unavailable', sideEffects: 'none' });
  }

  try {
    const ids = resolveTickCampaignIds(process.env);
    const results = [];
    for (const campaignId of ids) {
      try {
        // eslint-disable-next-line no-await-in-loop -- campaign ごとに順番に進める
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
  } finally {
    if (lock && token) {
      try { await lock.release({ jobId: SEQUENCE_TICK_LOCK_ID, token }); } catch { /* TTL で切れる */ }
    }
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
