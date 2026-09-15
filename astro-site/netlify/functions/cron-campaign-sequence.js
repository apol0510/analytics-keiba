/**
 * cron-campaign-sequence.js — 連続配信を**1 回の tick で 1 ステップだけ**自動で進める
 *
 * ⚠️ **ゲートが全て true でなければ、Airtable にも SendGrid にも接続しない。**
 *      1. `MARKETING_SEQUENCE_SCHEDULER_ENABLED=true`
 *      2. `MARKETING_SEQUENCE_ARMED` … **未設定＝常時武装**（正本の通常運用）。
 *         値を置いたときだけ「その JST 日付の当日だけ武装」に狭まる。
 *         ⚠️ 旧仕様の「毎日書き換えないと止まる」は**廃止**（2026-08-26 MK 確定）。
 *         人が毎日 env を書き換える運用は続かないため。判定は `readSequenceGates()` が単一源
 *      3. `MARKETING_CAMPAIGN_ENABLED=true`（既存の live enqueue）
 *      4. `MARKETING_CAMPAIGN_DISPATCH_ENABLED=true`（既存の実送信）
 *    どれか 1 つでも欠ければ**接続前に fail-closed で終了**する（副作用ゼロ）。
 *
 * ⚠️ **進めるのは自分が担当する campaign だけ。**
 *    `MARKETING_SEQUENCE_CAMPAIGN_ID` は**未設定が通常運用**で、そのとき
 *    `resolveTickCampaignIds()` が「`sequence.runner` が自分の campaign」を自動で選ぶ。
 *    Light 無料体験の 2 本は `cron-marketing-rollout` の単一担当なので**拾わない**
 *    （拾うと二重 enqueue になる）。
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
 * step1（初回接触）は母集団が最大になるため**この Function の既定では撃たない**
 * （入口を宣言した campaign で `MARKETING_DRM_AUTOSTART_ENABLED` が開いているときだけ撃つ）。
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
  normalizeAudienceFilter, applyAudienceFilter, describeAudiencePreview, sourceOfTarget,
  AUDIENCE_FILTER,
} from '../../src/lib/marketing/sequenceAudienceFilter.js';
// 母集団を「計画より手前」で出所ごとに切る／公平に並べる（2026-09-15 の恒久修正）
import {
  scopeAudiencePool, interleaveBySource,
} from '../../src/lib/marketing/sequenceAudiencePool.js';
// 1 tick の枠を「積める人」で埋める（2026-09-15 の逓減対策）
import { refillSendable } from '../../src/lib/marketing/sequenceTickRefill.js';
// 第 1 期を配り終えた prospect だけを第 2 期の入口へ入れる（後段接続）
import { planPhase2Entry } from '../../src/lib/marketing/prospectPhase2Entry.js';
import { buildProspectDeliveryKeys } from '../../src/lib/marketing/prospectSequenceHydration.js';
// campaign を順番に先頭へ回す（後ろの campaign が永久に進まないのを防ぐ）
import { rotateCampaigns, hasTimeForAnother } from '../../src/lib/marketing/sequenceTickRotation.js';
import {
  isSequenceCampaign, resolveSequenceStep, resolveAutoStart, AUTO_START_KIND,
  resolveAudienceSource, isOwnedByRunner, SEQUENCE_RUNNER,
} from '../../src/lib/marketing/campaignSequence.js';
import {
  readAutoStartGate, planAutoStartEntries, AUTOSTART_SKIP_LABEL,
} from '../../src/lib/drm/drmAutoStart.js';
import { FUNNEL_STAGE } from '../../src/lib/drm/drmFunnel.js';
import { buildSequenceProgress, indexDeliveries } from '../../src/lib/marketing/sequenceProgress.js';
import {
  normalizeAllowlist, applyEntryAllowlist, assertWithinAllowlist, ALLOWLIST_FAIL,
} from '../../src/lib/drm/drmEntryAllowlist.js';
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
async function fetchCampaignDeliveries({ KEY, BASE, campaignType, startOffset = null, maxPagesOverride = null }) {
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
  // ⚠️ 下見は 1 回の呼び出しを短く切るため、窓の大きさを呼び出し側が決められる。
  //    実運用（tick）は従来どおり env の値を使う（渡さなければ何も変わらない）。
  const maxPages = Number.isInteger(maxPagesOverride) && maxPagesOverride > 0
    ? maxPagesOverride : resolvePagesPerTick(process.env);
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
   * **最終 recipient 集合の上限制約**（任意 / 2026-09-14 の事故対応）。
   *
   * `recordId` の配列だけを受け取り、**これ以外へは絶対に送らない**。
   * ⚠️ 候補データ（candidate object）は受け取らない。従来どおり自分で取り直し、
   *    purchase / suppression / blacklist / 既送信 / `DeliveryKey` を**再検証する**。
   * ⚠️ **減らす方向にしか働かない。** 省略時（`undefined` / `null`）は
   *    **共有 tick の挙動を 1 ミリも変えない**。
   */
  entryAllowlist = null,
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
  /**
   * 下見の**窓**（`dryRun` のときだけ効く）。
   *
   *   scope        … 'prospect' | 'customer'（どちらの母数を見るか。既定は両方）
   *   offset/limit … prospect 索引の窓（`prospectSequenceCheck` と同じ刻み方）
   *   digest       … prospect 索引の指紋。**変わっていたら fail closed で中止**
   *   ledgerOffset … 配信台帳の続き位置（Airtable の offset 文字列）
   *   scanPages    … 台帳を 1 回で読むページ数（下見を 30 秒に収めるため）
   *
   * ⚠️ 下見は**保存されたカーソルを読まないし書かない**。
   *    本番 tick の進み位置を 1 バイトも動かさない。
   */
  preview = null,
  /**
   * 出所の絞り込み（`prospect` / `customer`）。**呼び出しの引数でだけ決まる。**
   *
   * ⚠️ **env から読んではいけない。** `cron-drm-autostart` は
   *    `tickEnv = { ...env }` で process env をまるごと引き継ぐので、
   *    env に置くと DRM の入口にも効いて**対象が黙って 0 人になる**
   *    （2026-09-14 に本番で踏んだ。しかも DRM は scheduler を自分で合成するため
   *    `scheduler=false` でも止まらない）。
   */
  sourceFilter = null,
  /**
   * 積む直前の人数の期待値。**違えば 1 件も積まない**（count drift は fail closed）。
   * canary のように「ちょうど N 名」を約束したいときに使う。
   */
  expectedCount = null,
  /** 1 tick の上限を呼び出し側で決める（渡さなければ従来どおり env 由来） */
  maxRecipientsOverride = null,
  /**
   * **下見専用**の step1 再現スイッチ（`drmEntryAllowlistCheck` だけが渡す）。
   *
   * ── なぜ要るか ──────────────────────────────────────────────
   * step1 を自動で撃てるのは「入口の宣言があり、かつ入口ゲートが開いている」ときだけ。
   * production のゲートは**閉じたまま**確認したいので、その状態で下見を回すと
   * 「期限が来ているのは step1 の人だけ」→ `first_step_is_manual` で毎回中止し、
   * **窓を最後まで走査できない**（2026-09-15 に本番実測）。
   *
   * ⚠️ これは **`dryRun === true` のときだけ**効く。`dryRun: false` で渡されたら
   *    **1 件も積まずに中止する**（live のゲート条件を迂回させない）。
   * ⚠️ env は**偽装しない**。実際のゲート状態は応答へそのまま載せる
   *    （`gates` / `autoStart.open` は閉じたまま）。
   * ⚠️ 入口の候補を組み立てるのは**読むだけ**（`planAutoStartEntries` は純粋関数）。
   *    予約・キュー登録・配信行・ジョブ・送信はこの先も一切しない。
   */
  previewAllowFirstStep = false,
} = {}) {
  const isDry = dryRun === true;
  /**
   * ⚠️ **live では絶対に効かせない。** 渡されたら 1 件も積まずに中止する
   *    （「無視して続ける」にすると、呼び出し側の取り違えに気づけない）。
   */
  if (previewAllowFirstStep === true && !isDry) {
    const body = {
      ok: false, abort: TICK_ABORT.FIRST_STEP_OVERRIDE_IN_LIVE, sideEffects: 'none',
      note: 'step1 の下見用スイッチは live では使えません（ゲートを迂回させないため）。',
    };
    log(body);
    return body;
  }
  /** 下見だけで有効な step1 再現（env は偽装しない） */
  const dryFirstStep = isDry && previewAllowFirstStep === true;
  const win = (isDry && preview && typeof preview === 'object') ? preview : null;
  const previewScope = win && (win.scope === 'prospect' || win.scope === 'customer') ? win.scope : null;
  /** 下見で Customers 側（配信台帳）を見るか */
  const wantCustomer = !win || previewScope === null || previewScope === 'customer';
  /** 下見で prospect 側を見るか */
  const wantProspect = !win || previewScope === null || previewScope === 'prospect';
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
  /**
   * ⚠️ **下見は保存カーソルを読まない**。読んで書かないだけでも、
   *    「どこまで進んだか」を本番 tick と共有すると解釈がややこしくなる。
   *    下見は呼び出し側が渡した `ledgerOffset` だけで窓を決める。
   */
  const cursor = isDry ? { offset: (win && win.ledgerOffset) || null, pass: 0 } : await scanStore.read(campaignType);
  /**
   * ⚠️ **保存した offset が失効していても自力で復帰する**（2026-09-08 の障害）。
   *    失効した offset で落ちたまま throw すると、カーソルが更新されないので
   *    次の tick も同じ失効値で落ちる = **その campaign は永久に進まない**。
   *    失効と判断できるときは**カーソルを捨てて先頭から読み直す**。
   *    走査の重複は送信の重複にならない（冪等性は `DeliveryKey` が持つ）。
   */
  let scan;
  let scanRecovered = null;
  const scanPagesOverride = win && Number.isInteger(Number(win.scanPages)) && Number(win.scanPages) > 0
    ? Math.min(10, Number(win.scanPages)) : null;
  try {
    // 下見で Customers 側を見ないときは、台帳を 1 ページも読まない
    scan = wantCustomer
      ? await fetchCampaignDeliveries({
        KEY, BASE, campaignType, startOffset: cursor.offset, maxPagesOverride: scanPagesOverride,
      })
      : { records: [], offset: null, partial: false, pages: 0 };
  } catch (e) {
    const reset = shouldResetCursorOnFailure({ hadOffset: Boolean(cursor.offset), status: e && e.status });
    if (!reset) throw e;
    scanRecovered = `offset_expired_${(e && e.status) || 'unknown'}`;
    console.error(`${SEQ_LOG_TAG} 走査カーソルが失効したため先頭から読み直します: ${scanRecovered}`);
    await scanStore.write(campaignType, cursorAfterFailure({ pass: cursor.pass }));
    scan = await fetchCampaignDeliveries({
      KEY, BASE, campaignType, startOffset: null, maxPagesOverride: scanPagesOverride,
    });
  }
  const deliveries = scan.records;
  const next = nextScanCursor({ offset: scan.offset, pass: cursor.pass });
  // ⚠️ **下見はカーソルを書かない**（本番 tick の進み位置を動かさない）
  if (!isDry) await scanStore.write(campaignType, next);

  // ── 実績の集計（**追加の読み取りはしない**）────────────────────────
  //
  // すでに読んだ窓をそのまま数えるだけ。1 周読み切ったところで「確定」にする。
  // 管理画面はこの集計を見る（queued を送信済みとして混ぜない）。
  // 失敗しても配信は止めない（数字が出ないだけ）。
  try {
    // ⚠️ **下見は集計も書かない**（read-only を名乗る以上、1 バイトも書かない）
    if (isDry) throw new Error('dry_run_skip_metrics');
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
  // 下見で Customers 側だけを見るときは、prospect を 1 件も読まない
  if (!wantProspect) prospectDegraded = 'preview_scope_customer';
  /**
   * ⚠️ **Customers だけを相手にすると宣言した campaign では、prospect を 1 件も読まない。**
   *    後段の絞り込みでも落ちるが、**そもそも母集団に入れない**方が事故を作りにくい
   *    （読まなければ、並べ替え・上限・再検証のどこにも紛れ込みようがない）。
   *    宣言が無い campaign（割引 3 本など）はここを通らない＝**挙動は不変**。
   */
  const customerOnly = resolveAudienceSource(base) === AUDIENCE_FILTER.CUSTOMER;
  if (customerOnly) prospectDegraded = 'campaign_is_customer_only';
  if (wantProspect && !customerOnly && prospectStore && prospectLedger) {
    prospectInputs = await loadProspectSequenceInputs({
      store: prospectStore, deliveryKeyStore: prospectLedger,
      campaign: base, brand: BRAND, fromEmail, nowMs: now,
      blacklistEmails,
      /**
       * ⚠️ 下見は**索引の窓**で切る（`prospectSequenceCheck` と同じ刻み方）。
       *    `digest` を渡しているので、読んでいる最中に索引が変われば
       *    `INDEX_CHANGED` で中止＝**取り直し**になる（fail closed）。
       */
      ...(win ? {
        maxRecipients: Number.isInteger(Number(win.limit)) && Number(win.limit) > 0
          ? Math.min(4000, Number(win.limit)) : 2000,
        offset: Math.max(0, Number(win.offset) || 0),
        expectDigest: String(win.digest || '').trim() || undefined,
      } : {}),
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
  /**
   * ── 後段接続（`prior_sequence_done`）─────────────────────────────
   *
   * 第 2 期は別 campaignId なので進行はまっさらで、最初の 1 通は step1 になる。
   * 共有 cron は既定で step1 を撃たないので、これが無いと**1 通も積まれない**。
   *
   * ⚠️ 入口を開ける条件は **前の campaign を配り終えていること**だけ
   *    （DRM の入口ゲート `MARKETING_DRM_AUTOSTART_ENABLED` とは無関係。
   *     新しい相手へ配り始めるのではなく、既に 3 通受け取った人の続きだから）。
   * ⚠️ 判定は**前 campaign 固有の `DeliveryKey`**。`delivered` の累計では判定しない。
   * ⚠️ 候補は **prospect プールだけ**（Airtable の入口候補は読まない）。
   */
  const priorDecl = autoStartDecl && autoStartDecl.kind === AUTO_START_KIND.PRIOR_SEQUENCE_DONE
    ? autoStartDecl : null;
  let priorEntryEmails = new Set();
  /** 後段接続のときだけ使う入口レポート（従来の入口レポートを置き換える）*/
  let phase2Report = null;
  if (priorDecl && !isDry) {
    const prior = getCampaign(priorDecl.afterCampaignId, { includeDisabled: true });
    if (!prior) {
      phase2Report = {
        declared: true, open: false, missing: [], entered: 0, skipped: {},
        error: `prior_campaign_unknown:${priorDecl.afterCampaignId}`,
      };
      console.error(`${SEQ_LOG_TAG} 後段接続の相手が不明: ${priorDecl.afterCampaignId}`);
    } else if (!prospectInputs || !prospectLedger) {
      // ⚠️ prospect を読めていないなら**1 人も入口へ入れない**（0 件と混同しない）
      phase2Report = {
        declared: true, open: false, missing: [], entered: 0, skipped: {},
        error: `prospect_unavailable:${prospectDegraded || 'no_inputs'}`,
      };
    } else {
      try {
        const people = prospectInputs.prospects || [];
        // 前 campaign の配信済み鍵（**名指しで引く**・鍵の作り方は変えない）
        const priorKeyMap = buildProspectDeliveryKeys({
          prospects: people, campaign: prior, brand: BRAND, fromEmail,
        });
        const priorAll = [];
        for (const [, byStep] of priorKeyMap) for (const [, k] of byStep) priorAll.push(k);
        const priorFound = priorAll.length === 0 ? [] : await prospectLedger.filterDelivered({
          brand: BRAND, campaignId: prior.campaignId, version: prior.version, keys: priorAll,
        });
        const planned = planPhase2Entry({
          prospects: people, priorCampaign: prior, nextCampaign: base,
          priorDeliveredKeys: new Set(priorFound),
          // 第 2 期の既送信は `prospectInputs` が既に持っている（同じ台帳）
          nextDeliveredKeys: new Set(
            (prospectInputs.deliveries || []).map((d) => String((d.fields || {}).DeliveryKey || '')),
          ),
          brand: BRAND, fromEmail, maxPerTick: priorDecl.maxPerTick,
        });
        if (!planned.ok) {
          phase2Report = {
            declared: true, open: false, missing: [], entered: 0, skipped: planned.skipped || {},
            error: planned.reason || 'phase2_entry_unavailable',
          };
        } else {
          priorEntryEmails = new Set(planned.emails);
          phase2Report = {
            declared: true, open: true, missing: [],
            considered: planned.considered, entered: planned.emails.length,
            capped: planned.capped === true, carriedOver: planned.carriedOver || 0,
            skipped: planned.skipped, 後段接続: priorDecl.afterCampaignId,
          };
        }
      } catch (e) {
        phase2Report = {
          declared: true, open: false, missing: [], entered: 0, skipped: {},
          error: String((e && e.message) || 'phase2_entry_failed'),
        };
        console.error(`${SEQ_LOG_TAG} 後段接続の候補を読めません: ${phase2Report.error}`);
      }
    }
  }

  const priorEntryCount = priorEntryEmails.size;
  /**
   * ⚠️ 後段接続の「ゲート」は**前の campaign を配り終えた人が居ること**そのもの。
   *    新しい相手へ配り始めるのではなく、既に 3 通受け取った人の続きなので、
   *    DRM の入口ゲート（`MARKETING_DRM_AUTOSTART_ENABLED`）とは無関係にする。
   */
  const autoStartGate = priorDecl
    ? { open: priorEntryCount > 0, missing: [] }
    : readAutoStartGate(env);
  let autoStartRows = [];
  let autoStartReport = phase2Report || (autoStartDecl
    ? { declared: true, open: autoStartGate.open, missing: autoStartGate.missing, entered: 0, skipped: {} }
    : { declared: false, open: false, missing: [], entered: 0, skipped: {} });
  /**
   * ⚠️ 入口を**実際に開ける**のは従来どおりゲートが開いているときだけ。
   *    下見のスイッチは「R3 live と同じ step1 対象を**組み立てて見る**」ためだけに通す
   *    （読むだけ・応答上のゲートは閉じたまま）。
   */
  // ⚠️ 後段接続は Airtable の入口候補を読まない（候補は prospect プールから作る）
  const buildEntryRows = autoStartDecl !== null && (autoStartGate.open || dryFirstStep)
    && priorDecl === null;
  if (buildEntryRows) {
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
        declared: true,
        /** ⚠️ **実際のゲート状態をそのまま出す**（下見で開いていると誤解させない） */
        open: autoStartGate.open,
        missing: autoStartGate.missing,
        /** 下見のスイッチで組み立てただけ（入口は開いていない） */
        ...(dryFirstStep && !autoStartGate.open ? { previewOnly: true } : {}),
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
        declared: true, open: autoStartGate.open, missing: autoStartGate.missing,
        entered: 0, skipped: {},
        ...(dryFirstStep && !autoStartGate.open ? { previewOnly: true } : {}),
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
  /**
   * ⚠️ 後段接続で選ばれた prospect は**既に `prospectRows` に居る**ので、
   *    行を新しく作らない（作ると同じ人が 2 行になり 2 通になる）。
   *    「step1 を撃ってよい相手」は `priorEntryEmails` が持つ。
   */
  /**
   * ── 母集団を作る（**ここで出所を決める**）────────────────────────
   *
   * ⚠️ **絞り込みは計画より手前で掛ける。** 以前は `planSequenceTick` が
   *    先頭 N 人で打ち切った**後**に絞っていたため、due な Customers が N 人以上
   *    先に並んでいると `prospect` 指定が**構造的に 0 件**になった
   *    （2026-09-15 実測: prospect の step2 due が 11,643 名居たのに選ばれたのは 0 名）。
   * ⚠️ `all` のときは**出所を交互に並べる**。並べないと Customers が常に先頭を占め、
   *    定期配信で prospect が永久に選ばれない（正本 `docs/spec.md`「prospect にも実際に送る」）。
   * ⚠️ どちらも**減らす・並べ替えるだけ**。除外・`DeliveryKey`・予約・再検証は触らない。
   */
  /**
   * ── 母集団の宣言（campaign 側の SSOT）と、呼び出しの引数を突き合わせる ──────
   *
   * ⚠️ **宣言は狭める方向にしか効かない。**
   *    引数が宣言と違う出所を要求したら、広げるのではなく**矛盾として止める**
   *    （`all` を要求されても、宣言が `customer` なら **customer のまま**）。
   * ⚠️ 宣言が無い campaign（割引 3 本・Light 無料体験 2 本）は `all` なので、
   *    **従来どおり引数だけで決まる＝挙動は 1 バイトも変わらない**。
   */
  const declaredSource = resolveAudienceSource(base);
  const askedSource = sourceFilter === null || sourceFilter === undefined
    ? null : normalizeAudienceFilter(sourceFilter);
  if (declaredSource !== AUDIENCE_FILTER.ALL
    && askedSource !== null
    && askedSource !== AUDIENCE_FILTER.ALL
    && askedSource !== declaredSource) {
    const body = {
      ok: false, abort: TICK_ABORT.AUDIENCE_SOURCE_CONFLICT,
      declared: declaredSource, asked: askedSource, sideEffects: 'none',
      note: 'この campaign が宣言している母集団と違う出所を求められたため、1 件も積まずに止めました。',
    };
    log(body);
    return body;
  }
  const audienceFilter = declaredSource !== AUDIENCE_FILTER.ALL
    ? declaredSource
    : normalizeAudienceFilter(sourceFilter);
  const mergedRows = [
    ...customerRows,
    ...entryRows,
    ...prospectRows.filter((r) => !knownEmails.has(emailOf(r))),
  ];
  /**
   * ⚠️ **後段接続のときは、まだ第 2 期を 1 通も受け取っていない人を
   *    「選ばれた相手」だけに絞る。** 絞らないと、第 1 期が途中の人にも
   *    第 2 期の step1 が積まれて並走する（確定仕様は「第 1 期 3 通の後段」）。
   *    既に第 2 期が始まっている人は通常の進行に任せる（ここでは落とさない）。
   */
  const startedPhase2 = new Set(
    (prospectInputs && prospectInputs.deliveries ? prospectInputs.deliveries : [])
      .map((d) => String((d.fields || {}).Email || '').trim().toLowerCase())
      .filter(Boolean),
  );
  const gatedRows = priorDecl === null ? mergedRows : mergedRows.filter((r) => {
    const e = emailOf(r);
    if (!e) return false;
    if (startedPhase2.has(e)) return true;      // 進行中はそのまま
    return priorEntryEmails.has(e);             // 未開始は選ばれた相手だけ
  });
  const scoped = scopeAudiencePool({
    rows: gatedRows, prospectEmails, filter: audienceFilter,
  });
  /**
   * ⚠️ **「読めなかった」を「0 人」と読み替えない。**
   *    prospect を読めていない状態で `prospect` 限定を求められたら、
   *    0 件は事実ではなく**確認できていない**ということ。fail closed で止める。
   */
  if (audienceFilter === AUDIENCE_FILTER.PROSPECT && prospectDegraded) {
    const body = {
      ok: false, abort: 'prospect_source_unavailable',
      reason: prospectDegraded, filter: audienceFilter, sideEffects: 'none',
    };
    log(body);
    return body;
  }
  const selected = audienceFilter === AUDIENCE_FILTER.ALL
    ? interleaveBySource({ rows: scoped.rows, prospectEmails })
    : scoped.rows;

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
  /**
   * ⚠️ **ゲートの扱いは「実送信の経路」と「下見」で違う。**
   *
   *   実送信 … `gates` をそのまま渡す（4 つ揃うまで計画を作らない＝従来どおり）
   *   下見   … 揃っていない前提で**計画だけ**作る（1 バイトも書かないため安全）
   *
   * ここを分けないと、`scheduler=false` の平常時に下見が `gates_closed` で止まり、
   * 「送る前に対象を確かめる」ができない（2026-09-14 に本番で踏んだ）。
   * ⚠️ 下見が安全なのは**書かないから**。下見の分岐に書き込みが混ざれば前提が壊れる
   *    （`sequencePreviewWindow.guard.test.mjs` が書き込み不在を固定している）。
   */
  const planGates = isDry ? { ...gates, allOpen: true } : gates;
  const plan = planSequenceTick({
    progress, gates: planGates,
    // 1 tick の上限。**引数が優先**（canary はここで 50 に絞る）。渡されなければ従来の env 由来
    maxRecipients: Number.isInteger(maxRecipientsOverride) && maxRecipientsOverride > 0
      ? maxRecipientsOverride : resolveMaxRecipientsPerTick(process.env),
    /**
     * ⚠️ step1 を自動で撃てるのは、**入口を宣言していて ゲートも開いている**ときだけ。
     *    `dryFirstStep` は**下見のときしか true にならない**（live では上で中止している）。
     */
    /**
     * ⚠️ step1 を自動で撃てるのは、**入口を宣言していて ゲートも開いている**ときだけ。
     *    後段接続（第 2 期）では「前の campaign を配り終えた人が居ること」が
     *    そのままゲートになる（上の `autoStartGate` を参照）。
     *    `dryFirstStep` は**下見のときしか true にならない**（live では上で中止している）。
     */
    allowFirstStep: autoStartDecl !== null && (autoStartGate.open === true || dryFirstStep),
  });
  if (!plan.ok) {
    const body = {
      ok: false, ...plan, autoStart: autoStartReport, sideEffects: 'none',
      // 下見のときは、実際のゲート状態を必ず添える（開いていると誤解させない）
      ...(isDry ? { dryRun: true, gates: { allOpen: gates.allOpen, missing: gates.missing } } : {}),
    };
    log({ ...summarizeSequenceTick({ campaignId: base.campaignId, plan }), 入口: autoStartReport });
    return body;
  }

  // 5) 送信計画（除外・DeliveryKey は既存の単一源がそのまま担当）
  const sending = resolveSequenceStep(base, plan.step);
  const byId = new Map(selected.map((c) => [c.recordId, c]));
  /**
   * ⚠️ **枠は「積める人」で埋める。**
   *
   * `plan.recordIds` は上限ぶんしか返らないので、そのまま使うと
   * 既登録を外したあとに枠が埋まらない（本番実測: 50 → 20 → 13 → 4 と逓減し、
   * due が 1,800 人以上残っているのに 1 tick で 4 人しか進まなくなった）。
   * `plan.candidateIds` は**上限より多い候補**で、この後の安全条件で削られる前提。
   * 上限は `plan.recipients` が持ち、**絶対に超えない**。
   */
  const candidateIds = Array.isArray(plan.candidateIds) && plan.candidateIds.length > 0
    ? plan.candidateIds : plan.recordIds;
  const allTargets = candidateIds.map((rid) => byId.get(rid)).filter(Boolean);
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
  /**
   * ⚠️ **枠が埋まるまで、塊で見て後ろから補充する**（2026-09-15 の逓減対策）。
   *
   * 以前は候補を上限ぶんしか持たず、そこから既登録を外していたので
   * 枠が空いたまま終わっていた（本番実測: 50 → 20 → 13 → 4）。
   * いまは候補を多めに持ち、**積める人が上限に達するまで**前から順に確かめる。
   *
   * ⚠️ 上限（`plan.recipients`）は**絶対に超えない**（`refillSendable` が保証）。
   * ⚠️ 安全条件は**迂回しない**。塊ごとに
   *    既登録の除外 → 出所フィルタ → 許可リスト を**そのままの順で**通す。
   * ⚠️ 並び順は変えない（公平性は `sequenceAudiencePool` の責任）。
   */
  const allowlist = normalizeAllowlist(entryAllowlist);
  const cap = Number.isInteger(plan.recipients) && plan.recipients > 0 ? plan.recipients : 0;
  let ledgerFailed = false;
  let alreadyQueued = 0;
  let droppedByFilter = 0;
  let droppedByAllowlist = 0;
  const bySource = { prospect: 0, customer: 0, unknown: 0 };
  let lastFilter = audienceFilter;

  const refill = await refillSendable({
    candidates: allTargets,
    maxRecipients: cap,
    isSendable: async (chunk) => {
      if (ledgerFailed) return [];
      let active = null;
      try {
        active = await fetchActiveDeliveryKeys({
          KEY, BASE, keys: chunk.map(keyOfTarget).filter(Boolean),
        });
      } catch {
        active = null;
      }
      // ⚠️ **読めなければ積まない**（未送信と読むと二重登録が再発する）
      if (active === null) { ledgerFailed = true; return []; }
      const due = chunk.filter((t) => !active.has(keyOfTarget(t)));
      alreadyQueued += chunk.length - due.length;
      const f = applyAudienceFilter({ targets: due, prospectEmails, filter: audienceFilter });
      droppedByFilter += f.dropped || 0;
      lastFilter = f.filter;
      for (const k of Object.keys(bySource)) bySource[k] += (f.bySource && f.bySource[k]) || 0;
      const a = applyEntryAllowlist({ targets: f.kept, allowlist });
      droppedByAllowlist += (f.kept.length - a.kept.length);
      return a.kept;
    },
  });
  if (ledgerFailed) {
    const body = { ok: false, abort: 'delivery_ledger_unreadable', sideEffects: 'none' };
    log(body);
    return body;
  }
  const targets = refill.picked;
  const filtered = { kept: targets, dropped: droppedByFilter, bySource, filter: lastFilter };
  const allowed = { kept: targets, dropped: droppedByAllowlist, constrained: allowlist !== null };

  const audienceView = describeAudiencePreview({
    bySource: filtered.bySource, kept: targets, filter: filtered.filter,
    step: plan.step, campaignId: base.campaignId,
  });

  /**
   * ── 下見はここで終わる（**予約より手前**）────────────────────────
   * 予約を取ると「送信済み扱い」になるので、下見では絶対に取らない。
   */
  if (isDry) {
    /**
     * ── 許可リストが**最終集合に効いているか**を下見で確かめられるようにする ──
     *
     * 2026-09-14 の事故は「入口 planner の人数」しか縛れておらず、最終 recipient は
     * 台帳由来 ＋ 入口 ＋ prospect で組み直されていた。直したあと、
     * **実送信 0 のまま**それを本番で確認できないと「直った」と言えない。
     *
     * ⚠️ ここは**数えるだけ**。判定も絞り込みも上で終わっている（新しい安全判定を作らない）。
     * ⚠️ `outside` は 0 のはず。0 でなければ許可リストが効いていない。
     */
    const finalSources = applyAudienceFilter({
      targets, prospectEmails, filter: AUDIENCE_FILTER.ALL,
    }).bySource;
    const dryWithin = assertWithinAllowlist({ targets, allowlist });
    const body = {
      ok: true, dryRun: true, step: plan.step, campaignId: base.campaignId,
      sideEffects: 'none',
      gates: { allOpen: gates.allOpen, missing: gates.missing },
      alreadyQueued,
      ...audienceView,
      /** 許可リストを渡さなかったときは `null`（**共有 tick の応答は不変**） */
      entryAllowlist: allowed.constrained ? {
        許可人数: allowlist.size,
        許可リスト外で除外: allowed.dropped,
        許可リスト外の残り: dryWithin.outside || 0,
      } : null,
      /** 許可リストを掛けた**後**の出所内訳（prospect が 0 であることを目で確かめる） */
      最終対象の出所: {
        prospect: finalSources.prospect,
        Customers: finalSources.customer,
        出所不明: finalSources.unknown,
      },
      /**
       * 窓の続き。**全部 null / 無くなるまで**呼び出し側が合算する。
       *   台帳側: `nextLedgerOffset` が null なら読み切り
       *   prospect 側: `nextOffset` が null なら読み切り（`digest` は全窓で同じであること）
       */
      window: {
        scope: previewScope,
        ledgerPages: scan.pages,
        nextLedgerOffset: wantCustomer ? (scan.offset || null) : null,
        prospect: prospectInputs ? {
          indexSize: prospectInputs.indexSize,
          digest: prospectInputs.digest,
          scanned: prospectInputs.scanned,
          offset: Math.max(0, Number((win && win.offset) || 0)),
          nextOffset: (Math.max(0, Number((win && win.offset) || 0)) + (prospectInputs.scanned || 0))
            < (prospectInputs.indexSize || 0)
            ? Math.max(0, Number((win && win.offset) || 0)) + (prospectInputs.scanned || 0)
            : null,
        } : null,
        prospectSkipped: prospectDegraded || null,
      },
      note: '下見です。予約・キュー登録・送信・カーソル更新・集計更新のいずれも行っていません。',
    };
    log(body);
    return body;
  }

  if (targets.length === 0) {
    const body = {
      ok: false, abort: TICK_ABORT.NO_DUE,
      reason: filtered.dropped > 0 ? 'filtered_out' : 'all_already_queued',
      alreadyQueued, ...audienceView, sideEffects: 'none',
      /** 枠を埋めるために何人まで見たか（見切っていなければ次の tick に続きがある）*/
      補充: { 見た候補: refill.scanned, 候補総数: allTargets.length, 見切った: refill.exhausted },
      /**
       * ⚠️ **「0 人だった」と「確認できていない」を混ぜない。**
       *    prospect を読めていないなら、その事実を必ず添える
       *    （黙って 0 件を返すと「送る相手が居ない」と誤読される）。
       */
      ...(prospectDegraded ? { prospectSkipped: prospectDegraded } : {}),
      /** 母集団を出所で切った結果（切る前に何人居たか）*/
      pool: { 全体: mergedRows.length, 絞り込み後: scoped.rows.length, ...scoped.bySource },
    };
    log(body);
    return body;
  }

  /**
   * ── 積む直前の fail closed（**予約より手前**）─────────────────────
   *
   * ⚠️ ここを予約より後ろへ動かさない。予約（`claimDelivered`）を取った時点で
   *    その人は「送信済み扱い」になるので、あとから止めても対象へ戻らない。
   */
  // ① 出所の混入（`sourceFilter` を指定したのに別の出所が残っていたら積まない）
  if (audienceFilter !== 'all') {
    const mixed = targets.filter(
      (t) => sourceOfTarget(t, prospectEmails) !== audienceFilter,
    ).length;
    if (mixed > 0) {
      const body = {
        ok: false, abort: 'audience_source_mixed',
        filter: audienceFilter, mixed, ...audienceView, sideEffects: 'none',
      };
      log(body);
      return body;
    }
  }
  // ② 人数のズレ（下見と違う母集団になっていたら積まない）
  if (Number.isInteger(expectedCount) && targets.length !== expectedCount) {
    const body = {
      ok: false, abort: 'expected_count_mismatch',
      expected: expectedCount, got: targets.length, ...audienceView, sideEffects: 'none',
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

  /**
   * ── 積む直前の最後の確認（多層防御）────────────────────────────
   * 許可リストがあるのに外の相手が 1 人でも混ざっていたら **1 件も積まない**。
   * 途中の処理が対象を足していないことを、予約・queue の手前で断つ。
   */
  const within = assertWithinAllowlist({ targets, allowlist });
  if (!within.ok) {
    const body = {
      ok: false, abort: ALLOWLIST_FAIL.OUTSIDE_ALLOWLIST,
      outside: within.outside, targets: targets.length, sideEffects: 'none',
      note: '許可リストの外が最終集合に混ざっていたため、1 件も積まずに止めました。',
    };
    log(body);
    return body;
  }

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
  /**
   * ⚠️ **走査が周回できているかを毎回残す**（2026-09-15）。
   *    正本は「周回すれば全員が必ず対象になる」。進んでいないことに気付けるよう、
   *    周回数と「続きがあるか」をログへ出す（値そのものは出さない）。
   */
  summary['台帳走査'] = {
    周回: cursor.pass, 続きあり: Boolean(next.offset), 読んだページ: scan.pages,
    周回完了: next.completedPass === true,
  };
  /** 枠を埋めるために何人まで見たか（**黙って枠を空けない**）*/
  summary['補充'] = {
    候補: allTargets.length, 見た: refill.scanned, 見切った: refill.exhausted, 上限: cap,
  };
  if (prospectBlocked > 0) summary['prospect予約不可'] = prospectBlocked;
  if (prospectClaimFailure) summary['prospect予約失敗'] = prospectClaimFailure;
  if (releaseFailed > 0) summary['予約戻し失敗'] = releaseFailed;
  // 許可リストで落とした人数（**黙って減らさない**）
  if (allowed.constrained) summary['許可リスト外で除外'] = allowed.dropped;
  // #521（prospect 実送信 / delivered 10 通の無反応除外）の観測項目
  if (alreadyQueued > 0) summary['登録済みのため除外'] = alreadyQueued;
  if (prospectNotDispatchable > 0) summary['prospect送信不可'] = prospectNotDispatchable;
  if (descriptorFailed > 0) summary['身分証を置けず未登録'] = descriptorFailed;
  // #522（DRM の入口）: 開けたか / 開けなかった理由（**黙って 0 にしない**）
  if (autoStartReport.declared) summary['入口'] = autoStartReport;
  if (priorDecl) {
    summary['後段接続'] = {
      相手: priorDecl.afterCampaignId,
      入口候補: priorEntryCount,
      進行中: startedPhase2.size,
      母集団: gatedRows.length,
    };
  }
  log(summary);
  return {
    ok: true, step: plan.step, enqueued, failed, autoStart: autoStartReport,
    entryAllowlist: allowed.constrained
      ? { constrained: true, dropped: allowed.dropped, kept: targets.length } : null,
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
  /**
   * ⚠️ **この Function が進めてよいのは、自分が担当する campaign だけ。**
   *
   * 正本は 2 つを同時に求めている:
   *   ① `MARKETING_SEQUENCE_CAMPAIGN_ID` **未設定＝対象の連続配信を自動進行**
   *   ② Light 無料体験の 2 本は **`cron-marketing-rollout` が単一担当**
   *
   * 以前は未設定のとき「有効な連続配信を全部」返していたので、rollout 所有の 2 本まで
   * 拾って**担当が 2 つ**になった（二重 enqueue・二重送信の入口）。
   *
   * ⚠️ 除外リストを**ここへ書かない**。campaign が増えるたびに直し忘れる。
   *    所有者は campaign の宣言（`sequence.runner`）が単一源。
   * ⚠️ **env に名指しされていても、他 runner の campaign は進めない**（fail closed）。
   *    env の書き間違いで二重送信になるより、進まない方がよい。
   */
  const owned = (id) => {
    const c = getCampaign(id, { includeDisabled: true });
    return !!c && isOwnedByRunner(c, SEQUENCE_RUNNER.CAMPAIGN_SEQUENCE);
  };
  const raw = String(env?.MARKETING_SEQUENCE_CAMPAIGN_ID ?? '').trim();
  if (raw) {
    return raw.split(',').map((x) => x.trim()).filter(Boolean).filter(owned);
  }
  return listCampaigns({ includeDisabled: false })
    .filter((c) => c.usable !== false && c.sequence)
    .filter((c) => isOwnedByRunner(c, SEQUENCE_RUNNER.CAMPAIGN_SEQUENCE))
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
    const declared = resolveTickCampaignIds(process.env);
    /**
     * ⚠️ **開始位置を tick ごとにずらす**（2026-09-15 の本番実測）。
     *
     * 1 tick の実行時間には上限がある（実測 60,000 / 60,340 ms で打ち切り）。
     * 「先頭から順に」だと先頭の campaign で時間を使い切り、
     * **後ろの campaign は永久に進まない**（light / premium が 3 tick 連続で 0 回）。
     * 順番に先頭へ回せば、どの campaign にも必ず番が来る。
     */
    const startedAt = Date.now();
    const ids = rotateCampaigns({ ids: declared, nowMs: startedAt });
    const results = [];
    const skippedForTime = [];
    for (const campaignId of ids) {
      /**
       * ⚠️ 残り時間が足りなければ**始めない**。途中で打ち切られると
       *    予約だけ取れて登録されない状態を作りかねない。
       *    始めなかった campaign は**黙って落とさず**名前を残す（次の tick で先頭に来る）。
       */
      if (results.length > 0 && !hasTimeForAnother({ startedAtMs: startedAt, nowMs: Date.now() })) {
        skippedForTime.push(campaignId);
        continue;
      }
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
    if (skippedForTime.length > 0) {
      // 時間切れで始めなかった campaign は必ず残す（次の tick で先頭に来る）
      log({ ok: true, action: 'deferred', campaigns: skippedForTime, sideEffects: 'none' });
    }
    return json(200, {
      ok: results.some((r) => r && r.ok === true),
      campaigns: ids.length,
      /** この tick で実際に進めた campaign の順番（先頭は tick ごとに回る）*/
      order: ids,
      deferred: skippedForTime,
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
