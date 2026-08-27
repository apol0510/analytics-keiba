/**
 * AK 顧客マーケティング管理（管理画面専用 / AK 独自機能）
 *
 * `/admin/premium-plus-eligibility` の「顧客マーケティング」タブから呼ぶ。
 *   action='customers' … セグメント条件に一致する顧客一覧＋全体のセグメント件数
 *   action='customerDetail' … 1 顧客のカルテ（ログイン可否・到達性・特典/オファー・契約）
 *   action='campaigns' … キャンペーン定義（カタログ）と送信有効/無効の状態
 *   action='preview'   … 1 キャンペーンの件名・本文を描画して返す（送信しない）
 *   action='dryRun'    … 選択顧客に対する送信対象・除外理由・件数を確定する（書き込みなし）
 *   action='send'      … dry-run で確定した対象を **送信キューへ積むだけ**（自分では送らない）
 *   action='history'   … キャンペーン別の実行履歴サマリ
 *
 * ── keiba-marketing-automation（KMA）とは統合しない ──────────────────
 * KMA の schema / env / 顧客 / 送信ロジックを AK へ持ち込まない。
 * 同一 Base にある `CampaignDeliveries_MarketingAutomation` は **KMA 側のテーブル**であり、
 * 本 Function は読みも書きもしない。AK は AK 自身の `CampaignDeliveries`
 * （EmailType='campaign'）だけを使う。
 *
 * ── このファイルは絶対にメールを送らない ─────────────────────────
 * SendGrid の**送信 API を呼ぶコードを持たない**（guard テストで固定）。send は
 * ScheduledEmails に PENDING ジョブを作るだけで、実際の送信は別の dispatcher が行う。
 * SendGrid へ触れるのは suppression の **GET のみ**（誤送信を防ぐための読み取り）。
 *
 * ── 三重ガード ────────────────────────────────────────────────
 *   1. 認可: x-admin-secret（MARKETING_ADMIN_SECRET があれば優先／無ければ PREMIUM_PLUS_ADMIN_SECRET）
 *   2. live enqueue: MARKETING_CAMPAIGN_ENABLED === 'true' でなければ 503（既定は無効）
 *   3. 実送信: MARKETING_CAMPAIGN_DISPATCH_ENABLED === 'true' でなければ dispatcher が no-op
 *      （**NEWSLETTER_AUTOMATION_ENABLED には依存しない**。マーケティングのために
 *        既存メール経路のマスタースイッチを ON にしないための分離）
 *   さらに send は dry-run が返した planFingerprint 必須（母集団が変われば 409）。
 *
 * ── suppression は毎回 provider に問い合わせる ────────────────────
 * AK の `EmailBlacklist` は Event Webhook 稼働以降のイベントしか持たない。実測（2026-07-30）で
 * SendGrid suppression 61 件に対し AK の実効除外は 4 件、**42 名の乖離**があった。
 * dry-run / send のたびに SendGrid の suppression を GET し、確認できなければ **中止**する。
 *
 * ── Customers へは一切書かない ───────────────────────────────────
 * 契約・権限・決済・Premium Plus 販売資格はこの Function の責務ではない。
 * 書き込むのは CampaignDeliveries と ScheduledEmails のみ（それも live gate 通過時だけ）。
 *
 * ── 送信対象の指定は 2 通り（2026-08-03）──────────────────────────
 *   1) `recordIds`         … 画面で選んだ相手（従来）
 *   2) `grantOperationId`  … カムバック無料付与の**成功者**を引き継ぐ
 *
 * (2) では**クライアントが送ってきた recordId を 1 つも使わない**。Customers を読み直し、
 * その操作 ID が `LightGrantOp` / `PremiumGrantOp` に刻まれている行だけを対象にする
 * （`comebackEmailHandoff.js` が単一源）。これにより
 *   - 任意の recordId を注入しても対象にならない
 *   - 付与に失敗・skip した顧客は構造的に混ざらない
 *   - 取り消し済みの付与は対象から外れる
 *   - 付与時刻から一定時間を過ぎた引き継ぎは失効する（fail closed）
 * 除外判定（suppression / 配信停止 / バウンス / 既送信 / キャンペーン固有条件）は
 * **従来と完全に同じ経路**を通る。引き継ぎは「誰を候補にするか」を決めるだけで、
 * 送ってよいかどうかの判定は 1 ミリも緩めない。
 */

import {
  buildJobId, buildJobNotes, buildScheduledEmailFields, assertOnlyScheduledFields,
} from '../../src/lib/marketing/marketingEnqueueContract.js';
import {
  resolveCustomerMarketing,
  matchesMarketingFilter,
  summarizeSegments,
  MK_SUPPRESSION_LABEL,
  MK_CONTRACT,
  MK_PLAN,
  MK_SEND,
} from '../../src/lib/marketing/customerMarketingAudience.js';
import {
  listCampaigns,
  getCampaign,
  renderCampaign,
} from '../../src/lib/marketing/campaignCatalog.js';
import {
  validateDraft,
  applyDraft,
  defaultDraft,
  isDraftEdited,
  PREVIEW_NAME,
  SUBJECT_MAX,
  BODY_MAX,
  DRAFT_PLACEHOLDERS,
} from '../../src/lib/marketing/campaignContentDraft.js';
import { requiresOfferUrl, isLiveOffer } from '../../src/lib/promotions/offerCampaignLink.js';
// クーポン利用予約は**販促 offer とは別物**。同じ分類へ混ぜない。
// ⚠️ 判定は promotions 側のモジュールから取る（販促は Premium Plus の販売判定を import しない）
import { isReservationRow } from '../../src/lib/promotions/couponReservationSource.js';
import {
  PREVIEW_UNSUBSCRIBE_URL, describeGrantExpiry, plainTextFromMarketingHtml,
  MARKETING_EMAIL_SHELL_VERSION, SHELL_VERSION_NOTE_PREFIX,
} from '../../src/lib/marketing/marketingEmailShell.js';
import { OFFERS_TABLE, getOfferSecret } from '../../src/lib/promotions/promotionalOffer.js';
import {
  buildCampaignPlan,
  buildDeliveryRecords,
  chunkRecipients,
  computeCampaignDeliveryKey,
  summarizeHistory,
  computePlanFingerprint,
  computeCampaignContentHash,
  assertOnlyDeliveryFields,
  MK_EXCLUSION,
  MK_EXCLUSION_LABEL,
  MAX_RECIPIENTS_PER_SEND,
  MARKETING_MIN_INTERVAL_MS,
} from '../../src/lib/marketing/campaignSend.js';
import {
  fetchProviderSuppression,
  describeProviderSuppression,
} from '../../src/lib/marketing/providerSuppression.js';
import { fetchDeliveryActivity } from '../../src/lib/marketing/deliveryActivity.js';
import {
  isMarketingEnqueueEnabled,
  isMarketingDispatchEnabled,
  isMarketingClickTrackingEnabled,
  isMarketingJob,
} from '../../src/lib/marketing/marketingDispatchGate.js';
import {
  fetchEmailBlacklistReadOnly,
  buildBlacklistEmailSet,
  loadBlacklistEmails,
} from '../../src/lib/newsletter/airtable-fetch.js';
import { resolveEntitlements, fromAirtableFields } from '../../src/lib/entitlements/resolveEntitlements.js';
import { parseTestRecipientsEnv } from '../../src/lib/newsletter/test-recipients.js';
import {
  SEGMENT_IDS, SEGMENTS, SEGMENT_CATALOG_VERSION, evaluateSegment, SEG_EXCLUDE_LABEL,
} from '../../src/lib/crm/audienceSegments.js';
import { buildLastContactMap, readMeasurementSettings } from '../../src/lib/crm/segmentInputs.js';
import { measuredCount } from '../../src/lib/crm/deliveryMeasurement.js';
import { getBrandConfig, validateBrandFromEmail } from '../../src/lib/newsletter/brand-config.js';
import {
  planProspectIntakeFromCustomers, canIntake,
} from '../../src/lib/marketing/prospectIntakePlan.js';
import { createProspectStore, emailHash } from '../../src/lib/marketing/prospectStore.js';
import { hashEmailForSignal } from '../../src/lib/marketing/engagementSignalStore.js';
import { buildProspectSequenceRows } from '../../src/lib/marketing/prospectSequenceAdapter.js';
import {
  loadProspectSequenceInputs, AUDIENCE_FAIL,
} from '../../src/lib/marketing/prospectAudienceSource.js';
import { hydrateProspectSequenceInputs } from '../../src/lib/marketing/prospectSequenceHydration.js';
import {
  auditProspectIndex, normalizeHashes, safeRecordView,
} from '../../src/lib/marketing/prospectIndexAudit.js';
import {
  planCustomerDeletion, canDeleteCustomers, reconcileDeletionTargets,
  DELETE_CONFIRM, DELETE_MAX_PER_CALL,
} from '../../src/lib/marketing/customerDeletionPlan.js';
import {
  classifyFields, buildRestoreFields, validateRestorePayload,
} from '../../src/lib/marketing/airtableWritableFields.js';
import { compareSequenceParity } from '../../src/lib/marketing/sequenceParity.js';
import { makeRedisPipeline } from '../../src/lib/marketing/deliveryKeyStore.js';
import { IMPORT_SOURCE_PREFIX } from '../../src/lib/marketing/importCohort.js';
import { EMAIL_EVENTS_TABLE as EMAIL_EVENTS_TABLE_NAME } from '../../src/lib/webhooks/emailEventLedger.js';
import { validateSelection } from '../../src/lib/marketing/adminMultiFilter.js';
import {
  buildCustomerListFormula, buildSegmentFormula, describeScanLimit, describeNotNarrowable,
  escapeFormulaValue, SCAN_FAIL, SCAN_MAX_PAGES,
} from '../../src/lib/marketing/customerScanBounds.js';
import {
  buildEngagementView, engagementCountsView,
} from '../../src/lib/marketing/engagementGuard.js';
import {
  createEngagementSignalStore, emptySignals,
} from '../../src/lib/marketing/engagementSignalStore.js';
// 送信直前の再判定で使う一覧。判定は engagementGuard が単一源で、ここは結果の受け渡しだけ。
import { createEngagementBlocklistStore } from '../../src/lib/marketing/engagementBlocklistStore.js';
import {
  createSequenceMetricsStore, describeMetrics, emptyMetrics,
} from '../../src/lib/marketing/sequenceMetrics.js';
import { summarizeCohortExclusion } from '../../src/lib/marketing/importCohort.js';
import {
  isSequenceCampaign, resolveSequenceStep, describeSequence, resolveMaxSends, getSequenceSteps,} from '../../src/lib/marketing/campaignSequence.js';
import {
  buildSequenceProgress, selectNextDueStep, SEQ_STOP_LABEL,
} from '../../src/lib/marketing/sequenceProgress.js';
import { readSequenceAutoState } from '../../src/lib/marketing/sequenceAutomation.js';
import {
  AUTOGRANT_SKIP_LABEL, HARD_MAX_BATCH_SIZE,
} from '../../src/lib/comeback/lightTrialAutoGrant.js';
import { loadAndPlanLightTrial } from '../../src/lib/comeback/lightTrialPlanLoader.js';
import {
  buildCampaignAudienceFormula, buildGrantOperationFormula,
} from '../../src/lib/marketing/campaignAudienceFormula.js';
import { BARRIER_RESOLVED_LABEL } from '../../src/lib/comeback/lightTrialBarrier.js';
import {
  planRolloutTick, ROLLOUT_STAGE, ROLLOUT_BLOCK,
} from '../../src/lib/marketing/rolloutPlan.js';
import {
  createRolloutStore, isRolloutEnabled, RolloutStoreError,
} from '../../src/lib/marketing/rolloutStore.js';
import { buildFunnel, buildStepView, buildRolloutView } from '../../src/lib/marketing/rolloutView.js';
import { createRolloutMetrics, estimateDashboardIo } from '../../src/lib/marketing/rolloutMetrics.js';
import { readStageGates, describeBlocked } from '../../src/lib/marketing/rolloutGates.js';
import { describeJourney, JOURNEY_PHASES } from '../../src/lib/marketing/journeyModel.js';
import { buildHistoryByRecipient, summarizeByTouch } from '../../src/lib/marketing/touchMeasurement.js';
import { createDeliveryEventIndex, MAX_READ_KEYS } from '../../src/lib/webhooks/deliveryEventIndex.js';
import {
  resolveScanPageSize, scanAllTouchPages, buildInlineMeasurementResult,
  MEASUREMENT_INLINE_MAX_PAGES,
} from '../../src/lib/marketing/touchMeasurementScan.js';
import {
  planBackfill, describeBackfillPlan, parseNdjson, blobDatePrefix, MAX_BLOBS_PER_RUN,
} from '../../src/lib/webhooks/deliveryEventBackfill.js';
import { JOURNEY_STATE_LABEL } from '../../src/lib/marketing/journeyTotals.js';
import {
  planRolloutStart, planRolloutPause, planRolloutResume, describeControlResult,
  ROLLOUT_OP, CONTROL_REJECT_LABEL,
} from '../../src/lib/marketing/rolloutControl.js';
import { buildDrmFunnel } from '../../src/lib/drm/drmMetrics.js';
import { summarizeSegments as summarizeDrmSegments, routeNextTouch } from '../../src/lib/drm/drmRouting.js';
import { resolveResponseState } from '../../src/lib/drm/drmResponseState.js';
import { RESPONSE, RESPONSE_LABEL } from '../../src/lib/drm/drmResponseState.js';
import { MEASURE } from '../../src/lib/crm/deliveryMeasurement.js';
import {
  classifyQueueOutcome, collectDeliveryKeys, summarizeRollback, QUEUE_FAIL,
} from '../../src/lib/marketing/queueDeliveryOutcome.js';
import {
  markUnverified, clearUnverified, hasUnverifiedMark,
  decideJobRowAction, JOB_ROW_ACTION,
} from '../../src/lib/marketing/queueJobPreparation.js';
import { describePolicy, normalizePolicy } from '../../src/lib/marketing/sequencePolicy.js';
import { assertCohortObservable, COHORT_SKIP_LABEL } from '../../src/lib/crm/importedCohort.js';
import {
  chunkList, buildRecordIdFormula, buildDeliveryKeyFormula, assertFetchComplete,
  summarizeTargetedFetch, TARGETED_CHUNK, TARGETED_MAX_PAGES,
  buildJobIdFormula, MARKETING_JOB_FORMULA,
} from '../../src/lib/marketing/marketingTargetedLoad.js';
import {
  resolveDeliveryStoreMode, resolveDeliveredKeys, recordDelivered,
  resolveRecipientLedgerPolicy, partitionRecipientsForLedger, RECIPIENT_SOURCE,
} from '../../src/lib/marketing/deliveryKeySource.js';
import { createDeliveryKeyStore, makeRedisCmd } from '../../src/lib/marketing/deliveryKeyStore.js';
import {
  createDispatchLock, QUEUE_LOCK_ROOT, DISPATCH_LOCK_TTL_SEC, LOCK_FAIL, isSafeJobId,
} from '../../src/lib/marketing/dispatchLock.js';
// カムバック無料付与の成功者を引き継ぐ判定（対象の導出・期限・監査印の単一源）
import {
  HANDOFF_BLOCK, HANDOFF_BLOCK_LABEL,
  collectGrantedRecipients, validateHandoffResolution, handoffNote,
} from '../../src/lib/comeback/comebackEmailHandoff.js';
import {
  resolveOfferState, matchesOfferState, matchesOfferWindow, formatOfferCell,
} from '../../src/lib/marketing/offerFilterModel.js';

/** 顧客一覧の絞り込みで受け付ける値（**ここに無い値は 400**）*/
const MK_FILTER_ALLOW = Object.freeze({
  contract: ['active', 'expiring_soon', 'expired', 'unknown', 'none'],
  plan: ['premium_sanrenpuku', 'premium', 'light', 'free', 'unknown'],
  marketing: ['sendable', 'suppressed'],
  premiumPlus: ['eligible', 'review', 'blocked', 'unset'],
  history: ['never', 'recent', 'sent'],
  lastLogin: ['login:30d', 'login:90d', 'login:365d', 'login:over365', 'login:never'],
  // オファーは「状態（排他）」と「残り期間（追加条件）」の 2 軸。
  // 旧 'expiring7' は互換のため受け付け、内部で offerWindow=within7 へ読み替える。
  offerState: ['live', 'redeemed', 'revoked', 'expired', 'none', 'unknown', 'expiring7'],
  offerWindow: ['within7', 'over7', 'no_expiry'],
  promoState: ['active', 'ending7', 'none'],
  frequency: ['sendable-now', 'blocked'],
});
import {
  buildJobView,
  canCancelJob,
  buildJobCancelFields,
  buildDeliveryCancelFields,
  isAlreadyCancelledBy,
  selectCancelableDeliveries,
  assertOnlyCancelFields,
  JOB_CANCEL_WRITABLE_FIELDS,
  DELIVERY_CANCEL_WRITABLE_FIELDS,
  CANCEL_REJECT,
  summarizeCampaignRunsFromJobs,
  parseJobCampaign,
} from '../../src/lib/marketing/marketingJobs.js';
import {
  buildCustomerDossier,
  summarizeMagicLinkLogins,
  resolveLastLogin,
  daysSinceLogin,
  loginSegment,
} from '../../src/lib/marketing/customerDossier.js';

const BRAND = 'analytics-keiba';
const CUSTOMERS_TABLE = process.env.AIRTABLE_CUSTOMERS_TABLE || 'Customers';
/** マジックリンクの使用履歴（＝有料会員の実ログイン）。読み取りのみ。 */
const AUTH_TOKENS_TABLE = 'AuthTokens';
/** AK 自身のキャンペーン配信台帳。KMA の *_MarketingAutomation は使わない。 */
const DELIVERIES_TABLE = 'CampaignDeliveries';

/** 文字列として読む（null / undefined を 'null' にしない） */
const str = (v) => String(v ?? '').trim();
const SCHEDULED_TABLE = 'ScheduledEmails';
/** 恒久台帳。テーブル名は受信側 `emailEventLedger.js` が単一源 */
const EMAIL_EVENTS_TABLE = EMAIL_EVENTS_TABLE_NAME;
/** 一覧で返す最大件数（PII をむやみに大量送出しない） */
const MAX_ROWS = 400;
const MAX_PAGES = 40;

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

/** live enqueue（CampaignDeliveries / ScheduledEmails への書き込み）が有効か。既定は無効。 */
export function isMarketingSendEnabled(env) {
  return isMarketingEnqueueEnabled(env);
}

/**
 * キャンペーンの**実送信**が有効か。
 * マーケティング専用ゲート（`MARKETING_CAMPAIGN_DISPATCH_ENABLED`）だけを見る。
 * ⚠️ `NEWSLETTER_AUTOMATION_ENABLED`（全メール自動化のマスタースイッチ）には**依存しない**。
 *    マーケティングのために既存メール経路まで解禁しないための分離。
 */
export function isDispatchEnabled(env) {
  return isMarketingDispatchEnabled(env);
}

/**
 * env 由来の値をまとめて、キャンペーン固有条件の評価コンテキストを作る。
 * 判定モジュール（campaignAudienceRules.js）は純粋なので、env はここでだけ読む。
 *
 * `NEWSLETTER_TEST_RECIPIENTS` は運用テスト専用カナリアの宛先ホワイトリスト（正本）。
 * 未設定なら空 Set になり、カナリアは**誰にも送れない**（fail closed）。
 */
function buildAudienceContext(env) {
  const parsed = parseTestRecipientsEnv(env && env.NEWSLETTER_TEST_RECIPIENTS);
  return { testRecipients: new Set(parsed.recipients) };
}

/** AK の EmailBlacklist を HARD / SOFT に分けて読む（販促は SOFT も送らない側へ倒す） */
async function loadBlacklistSets({ KEY, BASE }) {
  try {
    const records = await fetchEmailBlacklistReadOnly(BASE, KEY);
    const hard = buildBlacklistEmailSet(records); // HARD_BOUNCE / COMPLAINT
    const soft = new Set();
    for (const r of records) {
      const email = String(r?.fields?.Email || '').trim().toLowerCase();
      const status = String(r?.fields?.Status || '').toUpperCase().trim();
      if (email && !hard.has(email) && status) soft.add(email);
    }
    return { ok: true, hard, soft };
  } catch {
    return { ok: false, hard: new Set(), soft: new Set() };
  }
}

/**
 * ⚠️ **`MAX_PAGES`（4,000 行）で黙って打ち切る。** 打ち切っても例外にならないので、
 *    呼び出し側は「短い結果」を全体だと誤認する。
 *    `CampaignDeliveries` / `ScheduledEmails` の状態表示には**使わないこと**
 *    （`fetchAllStrict` か名指し取得を使う。guard テストが検知する）。
 */
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
    if (offset && pages >= MAX_PAGES) break;
  } while (offset);
  return out;
}

/**
 * `fetchAll` と同じだが、**取り切れなければ例外**（fail closed）。
 *
 * ── なぜ要るか（2026-08-15 の実測）────────────────────────────
 * `CampaignDeliveries` が 4,000 行を超えた時点で、`{EmailType}='campaign'` の
 * 全件取得は 4,000 行で打ち切られていた。その結果、Step1 を 10 名ぶん
 * キュー登録した直後に管理画面が **「送信済み 1 名 / 残り 9 名」** と表示した
 * （実際は 10 名とも queued）。運用者が「まだ 9 名残っている」と誤読する。
 *
 * 状態表示は**部分集合を全体として出してはいけない**。数えられないなら
 * 数を出さずに落とす。
 */
async function fetchAllStrict({ KEY, BASE, table, filterByFormula, maxPages = MAX_PAGES, fields }) {
  const out = [];
  let offset;
  let pages = 0;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`);
    url.searchParams.set('pageSize', '100');
    if (filterByFormula) url.searchParams.set('filterByFormula', filterByFormula);
    // 必要な列だけ受け取る（台帳は行数が多いので、列を絞るだけで所要時間が大きく縮む）
    for (const f of Array.isArray(fields) ? fields : []) url.searchParams.append('fields[]', f);
    if (offset) url.searchParams.set('offset', offset);
    // eslint-disable-next-line no-await-in-loop -- Airtable は offset 方式
    const res = await fetch(url, { headers: authHeaders(KEY) });
    if (!res.ok) throw new Error(`${table} fetch failed: HTTP ${res.status}`);
    // eslint-disable-next-line no-await-in-loop
    const data = await res.json();
    out.push(...(data.records || []));
    offset = data.offset;
    pages += 1;
    // 打ち切りは**例外**。黙って短い結果を返さない
    if (offset && pages >= maxPages) assertFetchComplete({ table, offset, pages, maxPages });
  } while (offset);
  return out;
}

/**
 * 1 リクエストで名指しするジョブ数と、そのぶんのページ上限。
 *
 * 1 ジョブが持つ配信行は最大 `RECIPIENTS_PER_JOB`（100）= 1 ページぶん。
 * よって N ジョブなら N ページで足りる。**倍の余裕**を取ったうえで、
 * それでも溢れたら fail closed で気付けるようにする
 * （既定の `TARGETED_CHUNK=50` × `TARGETED_MAX_PAGES=20` だと
 *  50 ジョブ = 最大 5,000 行 > 2,000 行で必ず溢れる。2026-08-15 に本番で踏んだ）。
 */
const JOB_ID_CHUNK = 15;
const JOB_ID_MAX_PAGES = JOB_ID_CHUNK * 2;

/** ジョブ一覧に載せる件数（新しい順）。**落とした分は件数で明示する** */
const JOBS_VIEW_LIMIT = 30;

/** 配信行のうち、ジョブ表示に要る列だけ */
const JOB_DELIVERY_FIELDS = [
  'ScheduledEmailJobId', 'Status', 'QueuedAt', 'SentAt', 'FailedAt', 'SkippedAt', 'ErrorMessage',
];

/**
 * 指定ジョブに紐づく配信行だけを引く（**名指し・fail closed**）。
 * 読む量はジョブ数に比例し、台帳全体が何行あっても影響を受けない。
 */
async function fetchDeliveriesByJobIds({ KEY, BASE, jobIds }) {
  const out = [];
  for (const group of chunkList(jobIds, JOB_ID_CHUNK)) {
    const formula = buildJobIdFormula(group);
    if (!formula) continue;
    // eslint-disable-next-line no-await-in-loop -- チャンクごとに順に読む
    const rows = await fetchAllStrict({
      KEY, BASE, table: DELIVERIES_TABLE, filterByFormula: formula,
      maxPages: JOB_ID_MAX_PAGES, fields: JOB_DELIVERY_FIELDS,
    });
    out.push(...rows);
  }
  return out;
}

/**
 * **キャンペーンの受信対象だけ**を読む（全件走査しない）。
 *
 * 絞り込みはキャンペーンの宣言（`requiresActiveGrant` / `requiresImportCohort`）から
 * `campaignAudienceFormula.js` が作る。判定そのものは `sequenceProgress` が単一源のまま。
 *
 * 上限に達したら **fail closed**（少ない人数のまま続行しない）。
 * `formula` が作れないキャンペーンも fail closed にする（黙って全件走査へ落とさない）。
 *
 * @returns {{ok: true, list: object[], pagesFetched: number}
 *          | {ok: false, code: string, pagesFetched?: number}}
 */
async function loadCampaignAudience({ KEY, BASE, now, campaign, formula: forced }) {
  const built = forced ? { formula: forced } : buildCampaignAudienceFormula(campaign);
  if (!built || !built.formula) {
    return { ok: false, code: 'audience_not_narrowable' };
  }
  const records = [];
  let offset;
  let pages = 0;
  do {
    // 読み取りは **GET のまま**にする（この経路が非 GET を出さないことを smoke test が守っている）。
    // formula は短い（宣言 2 つぶん）ので URL 長に収まる。長くなる変更を入れるときは
    // 下の長さガードが fail closed で止める。
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}`);
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('filterByFormula', built.formula);
    // 既定ビュー順に結果が左右されないよう固定する
    url.searchParams.set('sort[0][field]', 'Email');
    url.searchParams.set('sort[0][direction]', 'asc');
    if (offset) url.searchParams.set('offset', offset);
    if (url.toString().length > 15000) {
      return { ok: false, code: 'audience_formula_too_long' };
    }
    // eslint-disable-next-line no-await-in-loop -- Airtable は offset 方式
    const res = await fetch(url, { headers: authHeaders(KEY) });
    if (!res.ok) return { ok: false, code: `audience_fetch_${res.status}` };
    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset;
    pages += 1;
    // **黙って打ち切らない**。少ない人数で集計も queue も進めない
    if (offset && pages >= MAX_PAGES) {
      return { ok: false, code: 'audience_scan_limit', pagesFetched: pages };
    }
  } while (offset);

  return { ok: true, records, pagesFetched: pages };
}

/**
 * Customers を **formula で絞ってから**読む。上限に達したら **fail closed**。
 *
 * 🛡️ 無フィルタ全件走査へ戻さないこと。Customers 15,962 件は 160 ページ =
 *    Airtable の毎秒 5 リクエスト制限で**最短 32 秒**かかり、同期 Function に入らない。
 *    先頭だけ読んで打ち切ると、後ろの顧客が黙って消える（販売一覧・連続配信で実際に起きた）。
 *
 * @returns {Promise<{ok:true, records:object[], pagesFetched:number}
 *                  | {ok:false, body:object}>}
 */
async function fetchCustomersBounded({ KEY, BASE, formula, what }) {
  if (!formula) {
    return { ok: false, body: describeNotNarrowable({ what }) };
  }
  const records = [];
  let offset;
  let pages = 0;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}`);
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('filterByFormula', formula);
    // 既定ビュー順に結果が左右されないよう固定する
    url.searchParams.set('sort[0][field]', 'Email');
    url.searchParams.set('sort[0][direction]', 'asc');
    if (offset) url.searchParams.set('offset', offset);
    if (url.toString().length > 15000) {
      return { ok: false, body: describeNotNarrowable({ what, hint: '絞り込み条件が長すぎます。選択を減らしてください。' }) };
    }
    // eslint-disable-next-line no-await-in-loop -- Airtable は offset 方式
    const res = await fetch(url, { headers: authHeaders(KEY) });
    if (!res.ok) throw new Error(`${CUSTOMERS_TABLE} fetch failed: HTTP ${res.status}`);
    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset;
    pages += 1;
    // **黙って打ち切らない**。少ない件数を正しい件数として見せない
    if (offset && pages >= SCAN_MAX_PAGES) {
      return { ok: false, body: describeScanLimit({ what, pagesFetched: pages }) };
    }
  } while (offset);
  return { ok: true, records, pagesFetched: pages };
}

/**
 * Customers + EmailBlacklist + 自分のキャンペーン履歴を読み、顧客ごとの判定を作る（read-only）。
 *
 * ⚠️ `customers` は**呼び出し側が絞って渡す**（この関数は全件走査しない）。
 */
async function loadCustomerMarketing({ KEY, BASE, now, withLogins = false, customers, emailScope }) {
  // カルテ（1 人）のときは配信履歴・ログイン記録も**その人の分だけ**引く。
  // 台帳は顧客数に比例して育つので、1 人のために全件読むと同じ打ち切り事故を起こす。
  const scoped = String(emailScope || '').trim().toLowerCase();
  const scopeClause = scoped ? `LOWER(TRIM({Email})) = '${escapeFormulaValue(scoped)}'` : null;
  // 配信履歴は **いま表示する顧客の宛先だけ**を名指しで引く。
  //
  // ⚠️ 旧実装は emailScope が無いとき（＝一覧）に `{EmailType}='campaign'` の
  //    全件取得へ落ちていた。台帳が 4,000 行を超えると `fetchAll` が黙って打ち切り、
  //    履歴の無い人が「最近接触していない」に見える（頻度ガードが緩む）。
  //    履歴の用途は全部 1 人単位なので、母数を顧客数に比例させる。
  const scopeEmails = scoped
    ? [scoped]
    : (Array.isArray(customers) ? customers : [])
      .map((rec) => String(((rec && rec.fields) || {}).Email || '').trim().toLowerCase())
      .filter(Boolean);
  const [deliveries, tokens] = await Promise.all([
    // 履歴は判定に効くので、取り切れなければ **例外**（握り潰して「履歴なし」にしない）
    fetchDeliveriesByEmails({ KEY, BASE, emails: scopeEmails }),
    // ログイン列は補助情報。読めなくても一覧・送信判定は成立させる
    withLogins
      ? fetchAll({ KEY, BASE, table: AUTH_TOKENS_TABLE, filterByFormula: scopeClause }).catch(() => [])
      : Promise.resolve([]),
  ]);
  const magicLogins = summarizeMagicLinkLogins(tokens);
  const { emails: blacklistEmails, status: blacklistStatus } =
    await loadBlacklistEmails({ brand: BRAND, baseId: BASE, apiKey: KEY });
  const history = summarizeHistory(deliveries);

  const list = customers.map((rec) => {
    const fields = rec.fields || {};
    const email = String(fields.Email || '').trim().toLowerCase();
    const marketing = resolveCustomerMarketing({
      fields, nowMs: now, blacklistEmails, history: history.get(email),
    });
    const lastLogin = resolveLastLogin({ fields, magicLinkAtMs: magicLogins.get(email) ?? null });
    return {
      recordId: rec.id, record: rec, fields, marketing,
      lastLogin, daysSinceLogin: daysSinceLogin(lastLogin, now),
    };
  });

  return {
    list, deliveries, tokens, magicLogins, blacklistStatus, blacklistSize: blacklistEmails.size,
    blacklistEmails,
  };
}

/**
 * 選ばれた recordId **だけ**を Airtable から引く（全件走査しない）。
 *
 * `fetchAll` は `MAX_PAGES=40`（4,000 件）で黙って打ち切るため、Customers が
 * それを超えて増えると、後ろの顧客が送信計画で `unknown_customer` として
 * 静かに落ちる。全件走査は Function の実行時間にも収まらない。
 * 対象件数に比例するコストへ置き換える（`imp-2026-08-09-001` の 504 と同じ対処）。
 *
 * formula が長くなるので GET ではなく `listRecords`（POST）を使う。
 */
async function fetchByRecordIds({ KEY, BASE, table, recordIds }) {
  const out = [];
  for (const group of chunkList(recordIds, TARGETED_CHUNK)) {
    const formula = buildRecordIdFormula(group);
    if (!formula) continue;
    let offset;
    let pages = 0;
    do {
      const body = { filterByFormula: formula, pageSize: 100 };
      if (offset) body.offset = offset;
      const res = await fetch(
        `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}/listRecords`,
        {
          method: 'POST',
          headers: { ...authHeaders(KEY), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw new Error(`${table} targeted fetch failed: HTTP ${res.status}`);
      const data = await res.json();
      out.push(...(data.records || []));
      offset = data.offset;
      pages += 1;
      if (offset && pages >= TARGETED_MAX_PAGES) {
        assertFetchComplete({ table, offset, pages, maxPages: TARGETED_MAX_PAGES });
      }
    } while (offset);
  }
  return out;
}

/**
 * 既送信突合を **今回の宛先ぶんだけ**引く。
 *
 * `CampaignDeliveries` を campaign 単位で全件読む実装は、配信実績が
 * `MAX_PAGES` を超えた時点で `deliveredKeys` が不完全になり、
 * `already_delivered` を見落として **二重送信**を許す。
 * 判定に要るのは「いま送ろうとしている鍵が既にあるか」だけなので、
 * 鍵を名指しで問い合わせる。
 */
async function fetchDeliveredKeys({ KEY, BASE, campaignType, keys }) {
  const found = new Set();
  for (const group of chunkList(keys, TARGETED_CHUNK)) {
    const formula = buildDeliveryKeyFormula({ campaignType, keys: group });
    if (!formula) continue;
    let offset;
    let pages = 0;
    do {
      const body = { filterByFormula: formula, pageSize: 100 };
      if (offset) body.offset = offset;
      const res = await fetch(
        `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(DELIVERIES_TABLE)}/listRecords`,
        {
          method: 'POST',
          headers: { ...authHeaders(KEY), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw new Error(`${DELIVERIES_TABLE} targeted fetch failed: HTTP ${res.status}`);
      const data = await res.json();
      for (const r of data.records || []) {
        const status = String(r.fields?.Status || '');
        if (status !== 'sent' && status !== 'queued') continue;
        const k = String(r.fields?.DeliveryKey || '');
        if (k) found.add(k);
      }
      offset = data.offset;
      pages += 1;
      if (offset && pages >= TARGETED_MAX_PAGES) {
        assertFetchComplete({ table: DELIVERIES_TABLE, offset, pages, maxPages: TARGETED_MAX_PAGES });
      }
    } while (offset);
  }
  return found;
}

/** 名指しで引いた顧客に、送信判定（marketing）を付ける。全件走査版と同じ単一源を使う。 */
async function loadMarketingForRecordIds({ KEY, BASE, now, recordIds }) {
  const records = await fetchByRecordIds({ KEY, BASE, table: CUSTOMERS_TABLE, recordIds });
  const emails = records
    .map((rec) => String(rec.fields?.Email || '').trim().toLowerCase())
    .filter(Boolean);

  // 24 時間の頻度ガードに要る「直近いつ送ったか」も、今回の宛先ぶんだけ引く。
  const deliveries = await fetchDeliveriesByEmails({ KEY, BASE, emails }).catch(() => []);
  const history = summarizeHistory(deliveries);
  const { emails: blacklistEmails } =
    await loadBlacklistEmails({ brand: BRAND, baseId: BASE, apiKey: KEY });

  const list = records.map((rec) => {
    const fields = rec.fields || {};
    const email = String(fields.Email || '').trim().toLowerCase();
    return {
      recordId: rec.id,
      record: rec,
      fields,
      marketing: resolveCustomerMarketing({
        fields, nowMs: now, blacklistEmails, history: history.get(email),
      }),
    };
  });
  // ⚠️ `deliveries` も返す。engagement 判定は「この宛先へ何通届いたか」を要するため、
  //    ここで引いた履歴をそのまま使う（別経路で数え直すと下見と実送信でズレる）。
  return { list, records, deliveries };
}

/**
 * 反応の集計（Redis）を読む。**読めなければ available:false**（0 と混同させない）。
 * Redis 未設定でも管理画面は動く（engagement 除外が適用されないだけ）。
 */
async function loadEngagementSignals() {
  try {
    const store = createEngagementSignalStore({ redisCmd: makeRedisCmd(process.env) });
    return await store.read();
  } catch {
    return emptySignals('redis_not_configured');
  }
}

/**
 * 「反応が無い相手を除外してよいか」を **下見（segments / dry-run）と実 enqueue で
 * 同じ材料・同じ判定**から作る。判定そのものは `engagementGuard.js`（単一源）。
 *
 * 材料が 1 つでも欠ければ `applied:false` になり、`engagementByEmail` は null =
 * 送信計画は誰も除外しない（fail closed）。
 */
async function resolveEngagementView({ list, deliveries, now }) {
  const [signals, measurement] = await Promise.all([
    loadEngagementSignals(),
    readMeasurementSettings({ apiKey: process.env.SENDGRID_API_KEY }),
  ]);
  const view = buildEngagementView({
    list, deliveries, signals, measurement, nowMs: now, env: process.env,
  });
  // ── 送信直前の再判定のために結果を残す（2026-08-26 MK 確定）──────────
  //
  // 「累計 10 通 delivered で開封 0」の判定には配信台帳の全履歴が要る。
  // それは実送信の Function では読み切れないので、**計算できたここで書き**、
  // dispatcher が読む（`engagementBlocklistStore.js`）。
  //
  // ⚠️ **`applied:false`（材料が欠けている）のときは書かない**。
  //    観測できていない状態の結果を保存すると、あとで誰かを誤って切る。
  // ⚠️ 書き込みに失敗しても下見・送信は止めない（除外が効かないだけで、送る側は安全側）。
  if (view.applied === true) {
    try {
      await createEngagementBlocklistStore({ redisCmd: makeRedisCmd(process.env) })
        .write({ emails: view.blockedEmails, computedAtMs: now });
    } catch { /* 一覧を残せなくても判定と送信は続ける */ }
  }
  return { view, measurement, signals };
}

/** 画面へ返す形（アドレスも recordId も出さない。件数と状態だけ） */
function engagementResponse(view, list) {
  // 取り込み由来と既存顧客は**分けて数える**（2026-08-26 MK 確定）。
  // 同じ「開封 0」でも意味が違うので、1 つの数字にまとめない。
  const cohort = summarizeCohortExclusion({ list, blockedEmails: view.blockedEmails });
  return {
    applied: view.applied,
    reason: view.reason,
    reasonLabel: view.reasonLabel,
    thresholds: view.thresholds,
    coverage: view.coverage,
    counts: engagementCountsView(view.counts),
    blocked: view.blockedEmails.size,
    /** 対象母集団と除外人数のコホート別内訳（管理画面の表示用） */
    cohort: {
      audience: cohort.audience,
      blocked: cohort.blocked,
      note: '取り込み（外部リスト）と既存顧客（Airtable）を分けて数えています。',
    },
    note: view.applied
      ? '反応が無いまま閾値を超えた相手を除外します（購入・ログイン・開封があれば次回は対象へ戻ります）。'
      : '除外は適用していません。全員が engagement 以外の条件だけで判定されています。',
  };
}

/**
 * 頻度ガード・進行判定用に、**指定アドレスの配信履歴だけ**を引く。
 *
 * ⚠️ formula へ直挿しできないアドレス（`'` を含む）は**黙って飛ばさない**。
 *    飛ばすとその人の履歴が「無い」ことになり、進行が 1 通ぶん巻き戻って見える
 *    （＝同じ Step をもう一度送ろうとする）。数えられないなら中止する。
 */
async function fetchDeliveriesByEmails({ KEY, BASE, emails }) {
  const out = [];
  for (const group of chunkList(emails, TARGETED_CHUNK)) {
    const safe = group.filter((e) => !e.includes("'"));
    if (safe.length !== group.length) {
      throw new Error(
        `${DELIVERIES_TABLE}: formula へ載せられない宛先が ${group.length - safe.length} 件あります`
        + '（履歴を取り切れないため中止します）',
      );
    }
    if (safe.length === 0) continue;
    const formula = `AND({EmailType}='campaign',OR(${safe
      .map((e) => `LOWER({RecipientEmail})='${e}'`).join(',')}))`;
    let offset;
    let pages = 0;
    do {
      const body = { filterByFormula: formula, pageSize: 100 };
      if (offset) body.offset = offset;
      const res = await fetch(
        `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(DELIVERIES_TABLE)}/listRecords`,
        {
          method: 'POST',
          headers: { ...authHeaders(KEY), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) throw new Error(`${DELIVERIES_TABLE} history fetch failed: HTTP ${res.status}`);
      const data = await res.json();
      out.push(...(data.records || []));
      offset = data.offset;
      pages += 1;
      if (offset && pages >= TARGETED_MAX_PAGES) {
        assertFetchComplete({ table: DELIVERIES_TABLE, offset, pages, maxPages: TARGETED_MAX_PAGES });
      }
    } while (offset);
  }
  return out;
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  // 認可: マーケ専用 secret があれば優先。無ければ既存の管理画面 secret を使う（env 追加不要）。
  const SECRET = process.env.MARKETING_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
  const KEY = process.env.AIRTABLE_API_KEY;
  const BASE = process.env.AIRTABLE_BASE_ID;
  if (!SECRET) return json(503, { error: '管理用 secret 未設定（機能無効）' });
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  if (provided !== SECRET) return json(403, { error: 'Forbidden' });
  if (!KEY || !BASE) return json(500, { error: 'Airtable 認証情報が未設定' });

  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const action = req.action || 'customers';
  const now = Date.now();

  try {
    if (action === 'campaigns') return handleCampaigns();
    if (action === 'preview') return handlePreview({ req });
    if (action === 'customers') return await handleCustomers({ KEY, BASE, now, req });
    if (action === 'customerDetail') return await handleCustomerDetail({ KEY, BASE, now, req });
    if (action === 'dryRun') return await handleQueuedPlan({ KEY, BASE, now, req, live: false });
    if (action === 'send') return await handleQueuedPlan({ KEY, BASE, now, req, live: true });
    if (action === 'segmentCatalog') return handleSegmentCatalog();
    if (action === 'segments') return await handleSegments({ KEY, BASE, now, req });
    if (action === 'sequence') return await handleSequence({ KEY, BASE, now, req });
    if (action === 'sequenceMetrics') return await handleSeqMetrics({ req });
    if (action === 'engagementDigest') return await handleEngagementDigest({ now });
    if (action === 'prospectIntake') return await handleProspectIntake({ KEY, BASE, now, req });
    if (action === 'prospectSequenceCheck') return await handleProspectSequenceCheck({ now, req });
    if (action === 'prospectIndexAudit') return await handleProspectIndexAudit({ req });
    if (action === 'prospectIndexRepair') return await handleProspectIndexRepair({ req });
    if (action === 'customerDeletionPlan') return await handleCustomerDeletionPlan({ KEY, BASE, req });
    if (action === 'customerDeletionApply') return await handleCustomerDeletionApply({ KEY, BASE, req });
    if (action === 'customerDeletionRestore') return await handleCustomerDeletionRestore({ KEY, BASE, req });
    if (action === 'trialGrant') return await handleTrialGrantPreview({ now, req });
    if (action === 'duplicateCheck') return await handleDuplicateCheck({ KEY, BASE, req });
    if (action === 'rollout') return await handleRollout({ KEY, BASE, now, req });
    if (action === 'drm') return await handleDrm({ KEY, BASE, now, req });
    if (action === 'drmCohort') return await handleDrmCohort({ KEY, BASE, now, req });
    // ⚠️ ここから 4 つは **read-only ではない**（Redis の展開状態だけを書き換える）。
    //    Customers・配信台帳・送信には触れない。受け付ける値は `rolloutControl.js` が絞る。
    if (action === 'rolloutStart') return await handleRolloutControl({ op: ROLLOUT_OP.START, now, req });
    if (action === 'rolloutKill') return await handleRolloutControl({ op: ROLLOUT_OP.KILL, now, req });
    if (action === 'rolloutPause') return await handleRolloutControl({ op: ROLLOUT_OP.PAUSE, now, req });
    if (action === 'rolloutResume') return await handleRolloutControl({ op: ROLLOUT_OP.RESUME, now, req });
    if (action === 'touchMeasurement') return await handleTouchMeasurement({ KEY, BASE, now, req });
    if (action === 'touchMeasurementPage') return await handleTouchMeasurementPage({ KEY, BASE, now, req });
    if (action === 'eventBackfillDryRun') return await handleEventBackfill({ KEY, BASE, req, event, live: false });
    if (action === 'eventBackfillRun') return await handleEventBackfill({ KEY, BASE, req, event, live: true });
    if (action === 'history') return await handleHistory({ KEY, BASE });
    if (action === 'jobs') return await handleJobs({ KEY, BASE });
    if (action === 'cancelJob') return await handleCancelJob({ KEY, BASE, now, req });
    return json(400, { error: `未知の action: ${action}` });
  } catch (e) {
    console.error('❌ [admin-marketing]', e.message);
    return json(500, { error: 'internal error' });
  }
};

function handleCampaigns() {
  // 使用停止中のものも理由付きで返す（管理者が「なぜ使えないか」を画面で分かるように）
  return json(200, {
    campaigns: listCampaigns({ includeDisabled: true }),
    sendEnabled: isMarketingSendEnabled(process.env),
    dispatchEnabled: isDispatchEnabled(process.env),
    maxRecipients: MAX_RECIPIENTS_PER_SEND,
    shellVersion: MARKETING_EMAIL_SHELL_VERSION,
    labels: { exclusion: MK_EXCLUSION_LABEL, suppression: MK_SUPPRESSION_LABEL },
    filters: {
      contract: Object.values(MK_CONTRACT),
      plan: Object.values(MK_PLAN),
      marketing: Object.values(MK_SEND),
    },
  });
}

/** 本文プレビュー（Airtable も SendGrid も触らない完全ローカル処理） */
/**
 * 「今回送る文面」を確定する（下書きが無ければテンプレートそのまま）。
 *
 * ⚠️ カタログ（コード）は**書き換えない**。返すのは重ねた新しいオブジェクトだけ。
 * 検証に落ちたら計画自体を作らない（空文字へ黙って置換しない）。
 */
function resolveDraft({ campaign, req }) {
  const hasDraft = typeof req.subject === 'string' || typeof req.body === 'string';
  if (!hasDraft) {
    return { ok: true, campaign, edited: false, errors: [], warnings: [], draft: defaultDraft(campaign) };
  }
  const v = validateDraft({ campaign, draft: { subject: req.subject, body: req.body } });
  if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings, edited: v.edited };
  return {
    ok: true,
    campaign: applyDraft(campaign, v.draft),
    edited: v.edited,
    errors: [],
    warnings: v.warnings,
    draft: v.draft,
  };
}

/**
 * 完成形プレビュー。**送信と同じ `renderCampaign` を使う**（プレビュー専用の描画を持たない）。
 * 配信停止リンクは dispatcher が全通に付けるので、ここでは「付く」という事実だけを返す。
 */
function buildPreview({ campaign, fromEmail }) {
  // プレビューは**サンプル値**で完成形まで組み立てる。
  // 実顧客の配信停止 URL も実際の期限も使わない（PII / 本番トークンを出さない）。
  const rendered = renderCampaign({
    campaign,
    name: PREVIEW_NAME,
    unsubscribeUrl: PREVIEW_UNSUBSCRIBE_URL,
    expiryNote: campaign.showGrantExpiry === true
      ? describeGrantExpiry({ durationDays: campaign.grantDurationDays })
      : '',
  });
  if (!rendered) return null;
  const brandCfg = getBrandConfig(BRAND);
  return {
    from: `${brandCfg.defaultFromName || 'KEIBA Analytics'} <${fromEmail || brandCfg.defaultFromEmail}>`,
    subject: rendered.subject,
    preheader: campaign.preheader || '',
    salutation: `${PREVIEW_NAME} 様（氏名が無い会員は「お客様」）`,
    html: rendered.html,
    text: rendered.text,
    ctaLabel: campaign.ctaLabel || '',
    ctaKind: requiresOfferUrl(campaign)
      ? 'お客様ごとの専用 URL（送信直前に 1 通ずつ差し替え）'
      : (campaign.ctaUrl ? '固定 URL（テンプレートで設定・文面編集では変更できません）' : 'CTA なし'),
    footer: 'KEIBA Analytics / https://analytics.keiba.link',
    unsubscribeNote: '配信停止リンクはメールのフッターに必ず入ります（送信時に受信者ごとの URL へ差し替え）。',
    unsubscribePreviewUrl: PREVIEW_UNSUBSCRIBE_URL,
    sampleName: PREVIEW_NAME,
  };
}

function handlePreview({ req }) {
  // 停止中でも中身は確認できるようにする（送信経路ではないため）
  const base = getCampaign(req.campaignId, { includeDisabled: true });
  if (!base) return json(400, { error: '未知のキャンペーンです' });
  // 連続配信は **ステップ単位**で確認する（既定は step1）。実際に届く HTML をそのまま返す。
  const campaign = resolveStepCampaign({ campaign: base, step: req.step });
  if (!campaign) return json(400, { error: '未知のステップです', sideEffects: 'none' });
  const check = resolveDraft({ campaign, req });
  if (!check.ok) {
    return json(400, { error: check.errors.join(' / '), errors: check.errors, sideEffects: 'none' });
  }
  const sending = check.campaign;
  const preview = buildPreview({ campaign: sending, fromEmail: getBrandConfig(BRAND).defaultFromEmail });
  if (!preview) return json(500, { error: 'テンプレート描画に失敗しました' });
  return json(200, {
    campaignId: campaign.campaignId,
    version: campaign.version,
    campaignName: campaign.name,
    /** 連続配信のときだけ入る（何通目の文面か） */
    step: campaign.sequenceStep || null,
    stepName: campaign.sequenceStepName || null,
    sequence: describeSequence(base),
    subject: preview.subject,
    html: preview.html,
    text: preview.text,
    preview,
    contentHash: computeCampaignContentHash(sending),
    contentEdited: check.edited,
    contentWarnings: check.warnings,
    defaults: defaultDraft(campaign),
    limits: { subjectMax: SUBJECT_MAX, bodyMax: BODY_MAX },
    placeholders: DRAFT_PLACEHOLDERS,
    notice: 'プレビューのみ / 送信しません。配信停止リンクは送信時に自動付与されます。',
  });
}

async function handleCustomers({ KEY, BASE, now, req }) {
  // 複数選択は配列で受ける（旧形式の単一文字列も通す）。
  // **許可値以外は 400**。想定外の条件で顧客を抽出させない。
  // 検証は**読み込みより先**に行う（不正な条件で Airtable を読まない）。
  const picked = {};
  for (const [key, allowed] of Object.entries(MK_FILTER_ALLOW)) {
    const v = validateSelection(req[key], allowed, { key });
    if (!v.ok) return json(400, { error: v.error });
    picked[key] = v.values;
  }
  // 🛡️ **Airtable 側で候補を絞ってから読む**（無フィルタ全件走査へ戻さない）。
  //    表せるのは Airtable の列で決まる条件だけ（プラン / 契約 / Plus 販売資格）。
  //    残りの条件（送信可否・履歴・最終ログイン・オファー・頻度）は読み込んだあとで絞る。
  //    1 つも表せないなら **fail closed**（先頭 4,000 件だけを一覧として見せない）。
  const listFormula = buildCustomerListFormula(picked);
  const loaded = await fetchCustomersBounded({
    KEY, BASE, formula: listFormula, what: '顧客一覧',
  });
  if (!loaded.ok) {
    return json(loaded.body.code === SCAN_FAIL.NOT_NARROWABLE ? 400 : 500, {
      ...loaded.body,
      hint: 'プラン / 契約状態 / Premium Plus 販売資格 のいずれかを 1 つ以上選んでください（これらだけが Airtable 側で絞り込めます）。',
    });
  }
  const { list, blacklistStatus, blacklistSize } = await loadCustomerMarketing({
    KEY, BASE, now, withLogins: true, customers: loaded.records,
  });
  // 一覧のマーケ列に使う（読み取りのみ）。失敗しても一覧は出す
  const offersAll = await fetchAll({ KEY, BASE, table: OFFERS_TABLE }).catch(() => []);
  const offersByCustomer = new Map();
  for (const o of offersAll) {
    const rid = String(o.fields?.CustomerRecordId || '');
    const mail = String(o.fields?.Email || '').trim().toLowerCase();
    for (const k of [rid, mail].filter(Boolean)) {
      offersByCustomer.set(k, [...(offersByCustomer.get(k) || []), o]);
    }
  }

  const filter = {
    contract: picked.contract, plan: picked.plan, marketing: picked.marketing,
    premiumPlus: picked.premiumPlus, history: picked.history,
  };
  // 最終ログイン・マーケ状態の絞り込みは既存フィルタと直交させる（判定モジュールを汚さない）。
  // **同じ項目内は OR / 項目間は AND**。条件は画面に件数とともに出す。
  const wantLogin = picked.lastLogin;
  // 旧 'expiring7' は「使えるオファーあり × 残り 7 日以内」の意味だったので読み替える
  const legacyExpiring = picked.offerState.includes('expiring7');
  const wantOffer = picked.offerState.filter((v) => v !== 'expiring7');
  if (legacyExpiring && !wantOffer.includes('live')) wantOffer.push('live');
  const wantWindow = legacyExpiring && picked.offerWindow.length === 0
    ? ['within7'] : picked.offerWindow;
  const wantPromo = picked.promoState;
  const wantFreq = picked.frequency;
  // 状態は排他。判定は offerFilterModel（純粋）へ委ね、画面と同じ答えにする
  const offerViewOf = (col) => resolveOfferState({
    live: col.liveOfferCount,
    redeemed: col.offerRedeemedCount || 0,
    revoked: col.offerRevokedCount || 0,
    expired: col.offerExpiredCount || 0,
    total: col.offerTotalCount || 0,
    available: col.offerLedgerAvailable !== false,
    soonestExpiresAtMs: col.offerExpiresAt ? Date.parse(col.offerExpiresAt) : null,
    nowMs: now,
  });
  const promoHit = (want, col) => {
    if (want === 'active') return col.promoActive;
    if (want === 'ending7') {
      if (!col.promoActive || !col.promoUntil) return false;
      const d = (Date.parse(col.promoUntil) - now) / (24 * 60 * 60 * 1000);
      return d >= 0 && d <= 7;
    }
    if (want === 'none') return !col.promoActive;
    return false;
  };
  const freqHit = (want, c, col) => {
    // 'sendable-now' = 送信可能 かつ 24h 制限にかかっていない
    if (want === 'sendable-now') return c.marketing.sendable === true && !col.nextSendableAt;
    if (want === 'blocked') return !!col.nextSendableAt;
    return false;
  };
  const matched = list
    .filter((c) => matchesMarketingFilter(c.marketing, filter))
    .filter((c) => wantLogin.length === 0 || wantLogin.includes(loginSegment(c.daysSinceLogin)))
    .filter((c) => wantOffer.length === 0
      || matchesOfferState(offerViewOf(marketingColumns({ c, offersByCustomer, now })).state, wantOffer))
    .filter((c) => wantWindow.length === 0
      || matchesOfferWindow(offerViewOf(marketingColumns({ c, offersByCustomer, now })), wantWindow))
    .filter((c) => wantPromo.length === 0
      || wantPromo.some((w) => promoHit(w, marketingColumns({ c, offersByCustomer, now }))))
    .filter((c) => wantFreq.length === 0
      || wantFreq.some((w) => freqHit(w, c, marketingColumns({ c, offersByCustomer, now }))));

  const rows = matched.slice(0, MAX_ROWS).map((c) => ({
    recordId: c.recordId,
    email: c.marketing.email,
    name: c.fields['氏名'] || '',
    plan: c.fields['プラン'] || '',
    planType: c.fields.PlanType || '',
    status: c.fields.Status || '',
    contract: c.marketing.contract,
    planGroup: c.marketing.plan,
    daysToExpiry: c.marketing.daysToExpiry,
    hasSanrenpuku: c.marketing.hasSanrenpuku,
    // 契約上の退会（課金停止）。**送信可否とは別軸**なので sendable とは独立して返す
    withdrawn: c.marketing.withdrawn,
    sendable: c.marketing.sendable,
    suppressionReasons: c.marketing.suppressionReasons,
    premiumPlusEligibility: c.fields.PremiumPlusEligibility || '',
    lastSentAt: c.marketing.history.lastSentAtMs
      ? new Date(c.marketing.history.lastSentAtMs).toISOString() : '',
    lastCampaign: c.marketing.history.lastCampaignId || '',
    sentCount: c.marketing.history.sentCount,
    // 最終ログイン（出所つき。どの記録由来かを画面で必ず併記する）
    lastLoginAt: c.lastLogin.at || '',
    lastLoginSource: c.lastLogin.source,
    lastLoginSourceLabel: c.lastLogin.sourceLabel,
    daysSinceLogin: c.daysSinceLogin,
    loginSegment: loginSegment(c.daysSinceLogin),
    // ── マーケ運用列（すべて既存台帳の読み取り）──
    ...(() => {
      const col = marketingColumns({ c, offersByCustomer, now });
      const view = resolveOfferState({
        live: col.liveOfferCount, redeemed: col.offerRedeemedCount, revoked: col.offerRevokedCount,
        expired: col.offerExpiredCount, total: col.offerTotalCount,
        available: col.offerLedgerAvailable !== false,
        soonestExpiresAtMs: col.offerExpiresAt ? Date.parse(col.offerExpiresAt) : null, nowMs: now,
      });
      // 画面はこの 1 つの答えを出す（状態と残り期間を別々に読み解かせない）
      return { ...col, offerState: view.state, offerWindow: view.window, offerText: formatOfferCell(view) };
    })(),
  }));

  return json(200, {
    rows,
    // 画面に「どの条件で何件か」を出すための控え（AND で適用）
    // 未指定は "all"（＝条件なし）。指定があれば選ばれた値の配列をそのまま返す
    appliedFilters: Object.fromEntries(
      Object.entries(picked).map(([k, v]) => [k, v.length ? v : 'all'])
    ),
    matchedCount: matched.length,
    truncated: matched.length > rows.length,
    // ⚠️ 集計の母数は**絞り込んだ候補集合**であって全顧客ではない。
    //    「全顧客のうち何名」と読ませないため、母数の意味を明示して返す。
    segments: summarizeSegments(list.map((c) => c.marketing)),
    candidateCount: list.length,
    candidateBasis: '選択した プラン / 契約状態 / Premium Plus 販売資格 に一致する候補のみ（全顧客ではありません）',
    /** @deprecated 名前が「全顧客」に読めるため candidateCount を使うこと */
    totalCustomers: list.length,
    blacklist: { status: blacklistStatus, size: blacklistSize },
    sendEnabled: isMarketingSendEnabled(process.env),
    dispatchEnabled: isDispatchEnabled(process.env),
  });
}

/**
 * 一覧のマーケ列（read-only）。判定は既存の単一源が出した結果を読むだけ。
 * 反応（開封・クリック）は一覧では取得しない（配信基盤への問い合わせが顧客数ぶん必要になるため）。
 * 画面には『カルテで確認』と出し、**0 件と誤読させない**。
 */
function marketingColumns({ c, offersByCustomer, now }) {
  const email = String(c.fields.Email || '').trim().toLowerCase();
  const mine = [
    ...(offersByCustomer.get(c.recordId) || []),
    ...(email ? (offersByCustomer.get(email) || []) : []),
  ];
  const all = [...new Map(mine.map((o) => [o.id, o])).values()];
  // ⚠️ クーポンの**利用予約**行を「現在申込みに使えるオファーあり」に混ぜない。
  //    予約は「58,000円で申し込んで入金確認を待っている」状態で、
  //    管理者が発行した割引オファーとは意味がまったく違う。
  //    区別は `Source`（既存列）だけで行い、schema は増やさない。
  const reservations = all.filter((o) => isReservationRow(o));
  const uniq = all.filter((o) => !isReservationRow(o));
  const live = uniq.filter((o) => isLiveOffer({ record: o, nowMs: now }));
  // 状態の内訳（排他区分の材料）。Status は issued / redeemed / expired / revoked
  const statusOf = (o) => String(o.fields?.Status || '').trim().toLowerCase();
  const redeemed = uniq.filter((o) => statusOf(o) === 'redeemed').length;
  const revoked = uniq.filter((o) => statusOf(o) === 'revoked').length;
  const expiredCount = uniq.filter((o) => {
    if (statusOf(o) === 'expired') return true;
    const e = Date.parse(String(o.fields?.ExpiresAt || ''));
    return statusOf(o) === 'issued' && Number.isFinite(e) && e <= now;
  }).length;
  const soonest = live
    .map((o) => Date.parse(String(o.fields?.ExpiresAt || '')))
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b)[0] ?? null;
  const ent = resolveEntitlements(fromAirtableFields(c.fields), now);
  const promo = ent.promo || {};
  const grantUntil = [promo.lightUntilMs, promo.premiumUntilMs].filter((x) => Number.isFinite(x)).sort((a, b) => a - b)[0] ?? null;
  const lastSentAtMs = c.marketing.history && c.marketing.history.lastSentAtMs;
  const nextSendableAtMs = Number.isFinite(lastSentAtMs) ? lastSentAtMs + MARKETING_MIN_INTERVAL_MS : null;
  return {
    /** いま閲覧できる範囲（契約 + 無料特典の合算結果） */
    access: {
      free: ent.canViewFree === true, light: ent.canViewLight === true,
      premium: ent.canViewPremium === true, sanrenpuku: ent.canViewSanrenpuku === true,
    },
    promoActive: (promo.lightActive === true) || (promo.premiumActive === true),
    promoLifetime: (promo.lightLifetime === true) || (promo.premiumLifetime === true),
    promoUntil: Number.isFinite(grantUntil) ? new Date(grantUntil).toISOString() : null,
    liveOfferCount: live.length,
    offerRedeemedCount: redeemed,
    offerRevokedCount: revoked,
    offerExpiredCount: expiredCount,
    offerTotalCount: uniq.length,
    offerLedgerAvailable: true,
    // クーポン利用予約の件数だけ（**offer 系カウントとは別軸**）。
    // 状態そのもの（所持中 / 予約 / 使用済み / 取消）は Premium Plus 管理画面が出す。
    couponReservationCount: reservations.length,
    offerExpiresAt: Number.isFinite(soonest) ? new Date(soonest).toISOString() : null,
    nextSendableAt: Number.isFinite(nextSendableAtMs) && nextSendableAtMs > now
      ? new Date(nextSendableAtMs).toISOString() : null,
  };
}

/**
 * 恒久台帳 `EmailEvents` から**この顧客に確定した行だけ**を read-only で引く。
 *
 * - `ResolutionStatus='resolved'` かつ `CustomerRecordId` 完全一致のみ。
 *   `unresolved` / `conflict` は誰のものか確定していないので**顧客カルテに出さない**
 * - 取得できなければ `available:false`（画面では「0 件」ではなく**「取得不能」**として扱う）
 * - **1 バイトも書かない**（GET のみ）
 */
/**
 * 台帳の**未確定**イベント件数（read-only・顧客に紐づかないもの）。
 *
 * 顧客カルテでは resolved だけを本人の反応として数える。だが「未確定が何件あるか」を
 * どこにも出さないと、**取りこぼしが起きていること自体**に気付けない。
 * 顧客には結び付けず、参考値として件数だけ返す。
 */
async function fetchLedgerUnattributed({ KEY, BASE }) {
  try {
    const [unresolved, conflict] = await Promise.all([
      fetchAll({ KEY, BASE, table: EMAIL_EVENTS_TABLE, filterByFormula: `{ResolutionStatus}='unresolved'` }),
      fetchAll({ KEY, BASE, table: EMAIL_EVENTS_TABLE, filterByFormula: `{ResolutionStatus}='conflict'` }),
    ]);
    return { available: true, unresolved: unresolved.length, conflict: conflict.length };
  } catch {
    return { available: false, unresolved: null, conflict: null };
  }
}

async function fetchCustomerLedgerEvents({ KEY, BASE, customerRecordId }) {
  const id = String(customerRecordId || '').trim();
  // recordId 以外は formula へ入れない（injection 遮断）
  if (!/^rec[A-Za-z0-9]{14}$/.test(id)) return { rows: [], available: false };
  const formula = `AND({CustomerRecordId}='${id}', {ResolutionStatus}='resolved')`;
  try {
    const rows = await fetchAll({ KEY, BASE, table: EMAIL_EVENTS_TABLE, filterByFormula: formula });
    return { rows, available: true };
  } catch {
    // テーブル未作成・権限不足・一時障害。**0 件と混同させない**
    return { rows: [], available: false };
  }
}

/**
 * 1 顧客のカルテ（read-only）。
 *
 * 「なぜこの人はログインできないのか / なぜ送信対象外なのか / 何を持っているのか」を
 * 1 リクエストで返す。判定は `customerDossier.js` へ委譲し、ここでは取得だけ行う。
 * provider suppression は失敗しても **カルテ自体は返す**（`null`＝不明として表示させる）。
 */
async function handleCustomerDetail({ KEY, BASE, now, req }) {
  const recordId = String(req.recordId || '').trim();
  if (!recordId) return json(400, { error: 'recordId が必要です' });

  // 🛡️ **1 件しか要らないのに全件走査しない**。recordId で名指しに引く
  //    （全件走査だと 15,962 件の先頭 4,000 件に居ない顧客のカルテが 404 に化ける）。
  const found = await fetchByRecordIds({ KEY, BASE, table: CUSTOMERS_TABLE, recordIds: [recordId] });
  if (!found.length) return json(404, { error: '該当する顧客が見つかりません' });

  const email = String((found[0].fields || {}).Email || '').trim().toLowerCase();
  const { list, deliveries, tokens, magicLogins, blacklistEmails } =
    await loadCustomerMarketing({
      KEY, BASE, now, withLogins: true, customers: found, emailScope: email,
    });
  const hit = list[0];

  // ソフトバウンスは販促では除外対象。HARD/COMPLAINT とは別枠で持つ（既存ヘルパーを再利用）
  const blacklist = await loadBlacklistSets({ KEY, BASE });

  const [offers, provider, activity, ledger, ledgerUnattributed, measurement] = await Promise.all([
    fetchAll({ KEY, BASE, table: OFFERS_TABLE }).catch(() => []),
    fetchProviderSuppression({ apiKey: process.env.SENDGRID_API_KEY, now }).catch(() => ({ ok: false })),
    fetchDeliveryActivity({ email, apiKey: process.env.SENDGRID_API_KEY }),
    // 恒久台帳（EmailEvents）。**read-only**・この顧客に確定した行だけを引く。
    // 取得できなければ available:false（画面では「0 件」ではなく「取得不能」）。
    fetchCustomerLedgerEvents({ KEY, BASE, customerRecordId: recordId }),
    fetchLedgerUnattributed({ KEY, BASE }),
    // 計測状態。**開封・クリックの「0」を数値として出してよいか**をここで決める。
    // これを渡さないと、Webhook が open を送っていないだけなのに
    // カルテが「開封 0 回」と断定してしまう（2026-08-04 に実際そうなっていた）。
    readMeasurementSettings({ apiKey: process.env.SENDGRID_API_KEY }),
  ]);

  const dossier = buildCustomerDossier({
    record: hit.record,
    nowMs: now,
    magicLinkAtMs: magicLogins.get(email) ?? null,
    tokenRecords: tokens,
    activityEvents: activity.events,
    activityAvailable: activity.available,
    offerRecords: offers,
    deliveryRecords: deliveries,
    blacklistEmails: blacklist.hard.size ? blacklist.hard : blacklistEmails,
    softBounceEmails: blacklist.soft,
    providerSuppressed: provider && provider.ok ? provider.emails : null,
    history: hit.marketing.history,
    ledgerRows: ledger.rows,
    ledgerAvailable: ledger.available,
  });

  return json(200, {
    dossier,
    // 反応をどこまで取得できたか（画面で「不明」と「0 件」を区別させる）
    engagementSource: {
      available: activity.available,
      coveredMessages: activity.coveredMessages || 0,
      totalMessages: activity.totalMessages || 0,
      // ⚠️ キー名は deliveryActivity.js の戻り値に合わせる（`note`）。
      //    別名を読むと **取得できているのに「取得できませんでした」と表示**され、
      //    「不明」と「反応なし」を区別するというこの機能の目的が壊れる。
      note: activity.note || '取得できませんでした（反応が無かったという意味ではありません）',
    },
    // 恒久台帳（EmailEvents）をどこまで引けたか。**「0 件」と「取得不能」を必ず区別させる**
    ledgerSource: {
      available: ledger.available,
      rows: ledger.rows.length,
      unresolvedTotal: ledgerUnattributed.unresolved,
      conflictTotal: ledgerUnattributed.conflict,
      unattributedAvailable: ledgerUnattributed.available,
      note: ledger.available
        ? '恒久台帳（EmailEvents）から集計。台帳の運用開始前のメールは記録がありません'
        : '恒久台帳を取得できませんでした（反応が無かったという意味ではありません）',
    },
    providerSuppression: describeProviderSuppression(provider),
    // 計測状態（セグメント下見と同じ単一源）。カルテの開封・クリックは
    // **これが enabled のときだけ数値**。無効・不明なら「—（計測していません）」。
    measurement,
    // 開封・クリックの**表示文字列そのもの**を単一源（`measuredCount`）で決める。
    // 画面側で `?? 0` と書くと未計測が 0 に化けるため、判断を画面へ持ち出さない。
    ledgerDisplay: {
      opens: measuredCount(measurement.open, (dossier.ledgerEngagement || {}).opens, '回'),
      clicks: measuredCount(measurement.click, (dossier.ledgerEngagement || {}).clicks, '回'),
    },
    sendEnabled: isMarketingSendEnabled(process.env),
    dispatchEnabled: isDispatchEnabled(process.env),
  });
}

/**
 * dry-run（live=false）と 実行（live=true）の共通経路。
 * **同じ関数で対象を確定する**ことで、確認した件数と実際に積む件数がズレない。
 */
/**
 * 連続配信のステップを解決する。**シーケンスでなければそのまま返す**（既存経路を変えない）。
 *
 * 返るのは「キャンペーンと同じ形」なので、以降の描画・contentHash・DeliveryKey・
 * 送信計画はすべて**既存の関数がそのまま**扱える（ステップ専用経路を作らない）。
 */
function resolveStepCampaign({ campaign, step }) {
  if (!isSequenceCampaign(campaign)) {
    // シーケンスでないのに step を指定されたら無視せず拒否（取り違え防止）
    const n = Number(step);
    if (Number.isFinite(n) && n !== 1) return null;
    return campaign;
  }
  const n = Number(step);
  return resolveSequenceStep(campaign, Number.isFinite(n) && n > 0 ? n : 1);
}

/**
 * 無料体験の入口（自動付与）の**下見**（read-only・**1 バイトも書かない**）。
 *
 * 「CSV 取り込みの対象総数 / 付与候補 / 除外理由別の人数」を、**自動付与と同じ判定**
 * （`lightTrialAutoGrant.js`）で数えて返す。cron を起動せずに管理画面から確認できる。
 *
 * ⚠️ ここは**付与しない**。付与できるのは既存の `admin-comeback-grants`（operationId 冪等）
 *    と、ゲートが全部開いたときの `cron-light-trial-grant` だけ。
 */
/**
 * 大規模展開の**運用画面**（read-only・1 バイトも書かない）。
 *
 * 運用者が知りたいのは 6 つだけ:
 *   母集団 / 未開始・進行中・購入・停止・完了 / Step 別 / 次回予定 /
 *   バッチ進行 / kill switch の状態
 *
 * ⚠️ **母集団を読み切れなければ「部分」と明示する。** 割合を捏造しない。
 * ⚠️ 返すのは件数だけ（アドレス・recordId は 1 つも返さない）。
 * ⚠️ 展開状態（段階・件数・停止）は Redis が正本。**env の開閉・redeploy は要らない**。
 *    ただし機能そのものの許可は env（`MARKETING_ROLLOUT_ENABLED`・既定 OFF）。
 */
/**
 * DRM（Direct Response Marketing）の read-only ビュー。
 *
 * ── 何を返すか ────────────────────────────────────────────────
 *   funnel   … sent / delivered / open / click / purchase / CVR / touch 別 conversion / unattributed
 *   segments … 反応層ごとの人数と、**その層に次へ出す訴求**
 *
 * ⚠️ **1 件も書かない。** 送信もしない。
 * ⚠️ 数字は既存の増分集計（Redis）から作る。**正本の全件走査はしない**
 *    （`handleRollout` と同じ理由: コホート 14,489 件で約 156 秒かかり同期 Function では開かない）。
 * ⚠️ **未計測を 0 にしない。** open / click の計測状態を一緒に返し、
 *    `deliveryMeasurement` が `disabled` / `unknown` なら件数は `null` になる。
 * ⚠️ 反応層の内訳は「1 人が必ず 1 か所」に入る既存 funnel を土台にする。
 *    ここで新しい母数を作らない。
 */
/**
 * 名指しした宛先だけの DRM 実データ（read-only・**bounded**）。
 *
 * ── なぜ名指しなのか ──────────────────────────────────────────
 * 1 人 1 state の排他的な反応層も、購入の 1 通への帰属も、**顧客単位のデータ**が要る。
 * ところがコホート全件（14,000 超）を同期 Function で引くのは既存方針で禁じられている
 * （`handleRollout` の注記: 全件走査は約 156 秒で開かない）。
 * そこで **`recordIds` を受け取り、その人たちだけ**を名指しで読む。
 *
 * ⚠️ **1 件も書かない。送信もしない。**
 * ⚠️ 返すのは件数と識別子だけ（アドレスは返さない）。
 * ⚠️ 測れないものは `null` / `unattributed`。**推測で埋めない。**
 */
async function handleDrmCohort({ KEY, BASE, now, req }) {
  const base = getCampaign(req.campaignId, { includeDisabled: true });
  if (!base) return json(400, { error: '未知のキャンペーンです', sideEffects: 'none' });
  if (!isSequenceCampaign(base)) {
    return json(400, { error: 'このキャンペーンは連続配信ではありません', sideEffects: 'none' });
  }
  const recordIds = Array.isArray(req.recordIds) ? req.recordIds.map(String).filter(Boolean) : [];
  if (recordIds.length === 0) return json(400, { error: '対象が選択されていません', sideEffects: 'none' });
  if (recordIds.length > DUPLICATE_CHECK_MAX) {
    return json(400, {
      error: `選択が多すぎます（上限 ${DUPLICATE_CHECK_MAX} 件）`,
      limit: DUPLICATE_CHECK_MAX, given: recordIds.length, sideEffects: 'none',
    });
  }

  const fromEmail = getBrandConfig(BRAND).defaultFromEmail;
  const campaignType = `${base.campaignId}:v${base.version}`;
  const steps = getSequenceSteps(base);

  // ── ① 宛先を名指しで読む ────────────────────────────────────
  let customers;
  try {
    customers = await fetchByRecordIds({ KEY, BASE, table: CUSTOMERS_TABLE, recordIds });
  } catch {
    return json(200, {
      mode: 'drm-cohort', sideEffects: 'none', ok: false,
      reason: 'customers_unreadable', segmentCounts: null, attribution: null,
      notice: '対象を読めませんでした。**数字は出しません**（0 とも書きません）。',
    });
  }

  // ── ② その人たちの DeliveryKey → 配信行（名指し）────────────
  const keyToStep = new Map();
  const keysByRecord = new Map();
  for (const c of customers) {
    const email = String(((c && c.fields) || {}).Email || '').trim().toLowerCase();
    if (!email) continue;
    const list = [];
    for (const st of steps) {
      const eff = resolveSequenceStep(base, st.stepNumber);
      if (!eff) continue;
      const k = computeCampaignDeliveryKey({ campaign: eff, recipientEmail: email, brand: BRAND, fromEmail });
      if (!k) continue;
      keyToStep.set(k, st.stepNumber);
      list.push(k);
    }
    keysByRecord.set(c.id, list);
  }
  const allKeys = [...keyToStep.keys()];
  let deliveryByKey = new Map();
  if (allKeys.length > 0) {
    try {
      for (let i = 0; i < allKeys.length; i += 40) {
        const group = allKeys.slice(i, i + 40);
        const formula = buildDeliveryKeyFormula({ campaignType, keys: group });
        if (!formula) continue;
        // eslint-disable-next-line no-await-in-loop -- 40 件ずつ名指し
        const rows = await fetchAllStrict({
          KEY, BASE, table: DELIVERIES_TABLE, filterByFormula: formula,
          maxPages: TARGETED_MAX_PAGES, fields: ['DeliveryKey', 'Status', 'SentAt', 'QueuedAt'],
        });
        for (const r of rows || []) {
          const f = (r && r.fields) || {};
          const k = String(f.DeliveryKey || '').trim();
          if (k) deliveryByKey.set(k, f);
        }
      }
    } catch {
      deliveryByKey = null;               // 読めない = 数えない
    }
  }

  // ── ③ 1 通単位の開封（**索引が読めたときだけ**）──────────────
  let eventByKey = null;
  try {
    const cmd = makeRedisCmd(process.env);
    const idx = createDeliveryEventIndex({ redisCmd: cmd });
    const read = await idx.read(allKeys.slice(0, 500));
    if (read && read.ok === true) eventByKey = read.byKey || new Map();
  } catch { eventByKey = null; }

  const measurement = {
    open: eventByKey ? MEASURE.ENABLED : MEASURE.UNKNOWN,
    click: MEASURE.DISABLED,             // provider 側 tracking が OFF
    delivered: eventByKey ? MEASURE.ENABLED : MEASURE.UNKNOWN,
  };

  // ── ④ 1 人 1 state の反応層 ＋ 購入の帰属 ─────────────────────
  const states = [];
  for (const c of customers) {
    const fields = (c && c.fields) || {};
    const marketing = resolveCustomerMarketing({ fields, nowMs: now });
    const keys = keysByRecord.get(c.id) || [];
    const touches = keys.map((k) => {
      const d = deliveryByKey ? deliveryByKey.get(k) : null;
      const ev = eventByKey ? eventByKey.get(k) : null;
      const sentAtMs = d && (d.SentAt || d.QueuedAt) ? Date.parse(d.SentAt || d.QueuedAt) : null;
      return {
        step: keyToStep.get(k) ?? null,
        deliveryKey: d ? k : '',                       // 配信行が無ければ「送っていない」
        campaignId: base.campaignId,
        version: base.version,
        sentAtMs,
        openedAtMs: ev && Number.isFinite(ev.firstOpenAtMs) ? ev.firstOpenAtMs : null,
        delivered: eventByKey ? !!(ev && Number.isFinite(ev.deliveredAtMs)) : null,
        opened: eventByKey ? !!(ev && Number.isFinite(ev.firstOpenAtMs)) : null,
        clicked: null,                                  // **未計測**（false ではない）
        offerKey: null,
      };
    });
    const state = resolveResponseState({
      marketing, touches, measured: { open: !!eventByKey, click: false },
    });
    states.push(state);

  }

  return json(200, {
    mode: 'drm-cohort',
    sideEffects: 'none',
    ok: true,
    campaignId: base.campaignId,
    version: base.version,
    requested: recordIds.length,
    observed: customers.length,
    /** ⚠️ **1 人 1 state**（累積指標ではない） */
    segmentCounts: summarizeDrmSegments(states),
    /**
     * ⚠️ **購入の帰属はここでは返さない。**
     *    有料化確定時刻（`bankPaymentFlow` が書く正本）を読むには決済フィールドが要り、
     *    送信経路（この Function）は既存 guard でそこへ触れない契約になっている。
     *    帰属は分析専用の **`admin-drm-attribution`** が単一源。
     */
    attributionEndpoint: 'admin-drm-attribution',
    measurement,
    deliveriesReadable: deliveryByKey !== null,
    notice: 'この人たちだけを名指しで読みました（全件走査なし）。**何も書き込んでいません。**'
      + ' 購入の帰属は分析専用の admin-drm-attribution が返します'
      + '（送信経路は決済フィールドに触れない契約のため）。',
  });
}

async function handleDrm({ KEY, BASE, now, req }) {
  const base = getCampaign(req.campaignId, { includeDisabled: true });
  if (!base) return json(400, { error: '未知のキャンペーンです', sideEffects: 'none' });
  if (!isSequenceCampaign(base)) {
    return json(400, { error: 'このキャンペーンは連続配信ではありません', sideEffects: 'none' });
  }

  /**
   * ── 計測状態（**測っていないものを 0 にしないため**）───────────────
   *
   * ⚠️ **`sent` を `delivered` の代わりにしない。** provider が受理した（accepted / sent）ことと
   *    受信サーバーが受け取った（delivered）ことは別概念で、`crm/deliveryMeasurement.js` が
   *    そもそも 3 状態で区別している。増分集計（Redis）が持っているのは**送信側の数**だけなので、
   *    ここから delivered を名乗ってはいけない。
   * ⚠️ 1 通単位の delivered は `webhooks/deliveryEventIndex.js` にあるが、
   *    全員ぶんを引くと bounded でなくなる（同期 Function では開かない）。
   *    したがってこの面では **delivered = null / measurement = unknown** に倒す。
   *    実数が要るときは `action:'drmCohort'`（宛先を名指しする bounded 経路）を使う。
   * ⚠️ click は provider 側 tracking が OFF（`deliveryEventIndex.js` の注記）。**常に disabled**。
   */
  const measurement = {
    open: String(process.env.MARKETING_OPEN_TRACKING || '').trim() === 'true'
      ? MEASURE.ENABLED : MEASURE.UNKNOWN,
    click: MEASURE.DISABLED,
    /** この面では 1 通単位の到達を引けないので **unknown**（`sent` で代用しない） */
    delivered: MEASURE.UNKNOWN,
  };

  let metrics = { partial: true, reason: 'unavailable', totals: null, steps: null };
  let stateExists = false;
  try {
    const cmd = makeRedisCmd(process.env);
    metrics = await createRolloutMetrics({ cmd }).read(base.campaignId);
    const loaded = await createRolloutStore({ cmd }).load(base.campaignId);
    stateExists = loaded.exists === true;
  } catch {
    metrics = { partial: true, reason: 'unavailable', totals: null, steps: null };
  }

  const t = metrics.totals;
  const sm = (metrics.steps && metrics.steps.steps) || {};
  const journey = describeJourney();
  const stepNumbers = Array.from({ length: journey.maxTouches }, (_, i) => i + 1);
  const byTouch = {};
  for (const step of stepNumbers) {
    const row = sm[String(step)] || sm[step] || null;
    if (!row) continue;
    byTouch[step] = {
      sent: Number(row.sent) || 0,
      // ⚠️ delivered は測れていない。**sent を写さない**
      delivered: null,
      opened: Number(row.opened) || 0,
      clicked: Number(row.clicked) || 0,
      purchased: Number(row.purchased) || 0,
    };
  }

  const funnel = t ? buildDrmFunnel({
    sent: Number(t.sent) || 0,
    delivered: null,
    opened: Number(t.opened) || 0,
    clicked: Number(t.clicked) || 0,
    purchased: Number(t.purchased) || 0,
    openState: measurement.open,
    clickState: measurement.click,
    deliveredState: measurement.delivered,
    byTouch,
    unattributed: Number(t.purchased) || 0,   // 1 通へ結べていない間は**全件 unattributed**
  }) : null;

  /**
   * ⚠️ **累積指標を「排他的な反応層の人数」と呼ばない。**
   *    増分集計の `sent` / `opened` / `purchased` / `stopped` は**同じ人が複数に入る**ので、
   *    1 人 1 state の segment ではない。ここで人数を出すと重複した数を層として見せてしまう。
   *    顧客単位で排他的に数えるには宛先を名指しする必要があるので、
   *    この面では **count を null**（`action:'drmCohort'` で bounded に数える）。
   */
  const routes = Array.isArray(base.sequence && base.sequence.responseRoutes)
    ? base.sequence.responseRoutes : [];
  const maxSends = resolveMaxSends(base);
  const segments = Object.values(RESPONSE).map((state) => {
    const decided = routeNextTouch({ routes, state: { state, sentCount: 0 }, maxSends });
    return {
      state,
      label: RESPONSE_LABEL[state] || state,
      /** ⚠️ 排他的に数えられないので null（0 ではない） */
      count: null,
      nextStep: decided.step,
      variant: decided.variant,
      angle: decided.angle,
      routeId: decided.routeId,
      reason: decided.reason,
    };
  });

  return json(200, {
    mode: 'drm',
    sideEffects: 'none',
    campaignId: base.campaignId,
    version: base.version,
    stateExists,
    funnel,
    segments,
    /** ⚠️ 排他的な人数はこの面では出せない（重複する累積指標を層として見せない） */
    segmentCounts: null,
    segmentCountsReason: 'per_customer_unavailable',
    routesDeclared: routes.length > 0,
    measurement,
    /** 数字を作れなかったときの理由（**推測で埋めない**） */
    partial: !t,
    partialReason: t ? null : (metrics.reason || 'metrics_unavailable'),
    notice: '増分集計だけを読んでいます（正本は Customers / CampaignDeliveries）。'
      + '**何も書き込んでいません。** 計測していない指標は 0 ではなく「—」です。',
  });
}

async function handleRollout({ KEY, BASE, now, req }) {
  const base = getCampaign(req.campaignId, { includeDisabled: true });
  if (!base) return json(400, { error: '未知のキャンペーンです', sideEffects: 'none' });
  if (!isSequenceCampaign(base)) {
    return json(400, { error: 'このキャンペーンは連続配信ではありません', sideEffects: 'none' });
  }

  // ⚠️ **正本（Customers / CampaignDeliveries）をここで読まない。**
  //    2026-08-15 実測で、コホート 14,489 件の取得だけで **約 156 秒**。
  //    同期 Function の上限 26 秒では原理的に開かない。24 Step まで伸ばせば
  //    配信行は約 35 万行になり、さらに悪化する。
  //    ダッシュボードは**増分集計（Redis）だけ**を読む（GET 2 回）。
  //    集計が無い / 壊れている / 版違いなら **partial** として数字を出さない。
  let state = null;
  let stateError = null;
  /** 展開状態の版（`rolloutStart` の `expectedVersion` に渡す値）。無ければ null = 新規作成 */
  let stateVersion = null;
  let stateExists = false;
  let metrics = { partial: true, reason: 'unavailable', totals: null, steps: null };
  try {
    const cmd = makeRedisCmd(process.env);
    const loadedState = await createRolloutStore({ cmd }).load(base.campaignId);
    state = loadedState.state;
    stateExists = loadedState.exists === true;
    stateVersion = stateExists ? loadedState.state.version : null;
    metrics = await createRolloutMetrics({ cmd }).read(base.campaignId);
  } catch (e) {
    stateError = (e instanceof RolloutStoreError && e.code) || 'unavailable';
  }

  const policy = normalizePolicy(base.sequencePolicy);
  const maxSends = Math.max(resolveMaxSends(base), policy.maxSends);
  /**
   * ⚠️ 画面が数えるのは**通し番号（1〜24）**。
   *    体験中 6 通 + 終了後 18 通に分かれていても、運用者が見たいのは
   *    「この人はいま何通目か」なので、`journeyModel.js` の変換で 1 本にまとめる。
   */
  const journey = describeJourney();
  const stepNumbers = Array.from({ length: journey.maxTouches }, (_, i) => i + 1);

  // 集計から画面の形へ（**件数だけ**。率は 0 通の Step で作らない）
  const t = metrics.totals;
  /**
   * ⚠️ **2 フェーズを 1 本として見せる。**
   *    体験中 / 体験終了・フォロー中 / 購入 / 停止 / 24 通完了 の 5 分類で、
   *    1 人が必ず 1 か所に入る（`journeyTotals.js` が二重計上を防いでいる）。
   *    集計が無ければ数字を出さない（**0 と書かない**）。
   */
  const funnel = t
    ? {
      observed: t.granted,
      cohortTotal: t.granted,
      partial: false,
      counts: {
        // 運用者の言葉（`JOURNEY_STATE_LABEL` と対応）
        in_trial: t.inTrial,
        in_follow_up: t.inFollowUp,
        purchased: t.purchased,
        stopped: t.stopped,
        completed: t.completed,
        // 互換のため残す（旧画面が読んでいる）
        not_started: t.notStarted,
        in_progress: t.inProgress,
      },
      labels: JOURNEY_STATE_LABEL,
      byStopReason: t.byStopReason || {},
      notStarted: t.notStarted,
      balanced: t.granted === (t.notStarted + t.inTrial + t.inFollowUp + t.purchased + t.stopped + t.completed),
    }
    : {
      observed: null, cohortTotal: null, partial: true, counts: null,
      labels: JOURNEY_STATE_LABEL, byStopReason: {}, notStarted: null, balanced: null,
    };

  const sm = (metrics.steps && metrics.steps.steps) || {};
  const stepView = stepNumbers.map((step) => {
    const m = sm[String(step)] || null;
    const sent = m ? Number(m.sent) || 0 : null;
    return {
      step,
      sent,
      queued: m ? Number(m.queued) || 0 : null,
      failed: m ? Number(m.failed) || 0 : null,
      opened: m ? Number(m.opened) || 0 : null,
      clicked: m ? Number(m.clicked) || 0 : null,
      // ⚠️ 0 通の Step で率を作らない
      openRate: sent ? (Number(m.opened) || 0) / sent : null,
      clickRate: sent ? (Number(m.clicked) || 0) / sent : null,
    };
  });

  const plan = state
    ? planRolloutTick({
      state, nowMs: now,
      // 残り候補は展開状態が持つ（正本の全件走査はしない）
      remainingCandidates: Number.isFinite(Number(req.remainingCandidates))
        ? Number(req.remainingCandidates) : null,
      previousOutstanding: 0,
      envEnabled: isRolloutEnabled(process.env),
    })
    : { ok: false, reason: ROLLOUT_BLOCK.STATE_UNREADABLE, allowance: 0, stage: ROLLOUT_STAGE.PAUSED, dailyLimit: 0, day: null };

  const view = buildRolloutView({
    state: state || {}, envEnabled: isRolloutEnabled(process.env), plan,
    funnel, stepView,
    remainingCandidates: plan.ok ? plan.allowance : null,
    nextScheduledAtMs: null,
  });

  return json(200, {
    mode: 'rollout-status',
    sideEffects: 'none',
    campaignId: base.campaignId,
    version: base.version,
    ...view,
    policy: describePolicy(base.sequencePolicy),
    maxSends,
    stepCount: stepNumbers.length,
    /** 2 キャンペーンを 1 本の道のりとして見せる（体験中 / 体験終了・フォロー中） */
    journey,
    /**
     * 通し番号ごとの実績（1〜24）。**いま何通目まで出ているか**が分かる。
     * ⚠️ 集計が無い Step は `null`（0 と書かない）。
     */
    currentTouch: (() => {
      const sent = stepView.filter((x) => Number(x.sent) > 0).map((x) => x.step);
      return sent.length ? Math.max(...sent) : null;
    })(),
    /**
     * 展開状態の版と存在。**`rolloutStart` の `expectedVersion` にそのまま渡す**
     * （新規作成なら `null`）。これが読めないと CAS で開始できない。
     */
    stateVersion,
    stateExists,
    stateUpdatedAt: state && state.updatedAtMs ? new Date(state.updatedAtMs).toISOString() : null,
    /** 集計が読めなかったときの理由（**推測で数字を作らない**） */
    metricsPartial: metrics.partial === true,
    metricsReason: metrics.reason || null,
    metricsUpdatedAt: t && t.updatedAtMs ? new Date(t.updatedAtMs).toISOString() : null,
    stateError,
    /** この画面が使う I/O（母集団に依存しないことを示す） */
    io: estimateDashboardIo({ cohortSize: t ? t.granted : 0, stepCount: stepNumbers.length }),
    /**
     * ⚠️ **どの env が閉じていて、何が止まっているか。**
     *    工程ごとに必要な env は違う（付与 / キュー登録 / 実送信）。
     *    「動かない」だけでは運用者が開けるべき env を判断できないので、
     *    名前と結果をそのまま出す（値は出さない）。
     */
    gates: readStageGates(process.env),
    blocked: describeBlocked(process.env),
    notice: '増分集計を読んでいます（正本は Customers / CampaignDeliveries）。'
      + '**付与もキュー登録も送信もしていません。**',
  });
}

/**
 * **いまから送ろうとしている宛先だけ**の重複確認（read-only・1 バイトも書かない）。
 *
 * ── なぜ campaign 単位で見てはいけないか ───────────────────────
 * 「この campaign のジョブが 1 つでもあれば止める」という判定は、
 * **1 回でも Step1 を流したら二度と通らない**。コホートは何度も来るので、
 * それでは 2 回目以降の Step1 が永久に承認できない。
 *
 * 見るべきは「**この campaign を過去に流したか**」ではなく
 * 「**いま選んでいる相手に、その通が既に出ているか**」。
 * 判定単位は不変キーの `DeliveryKey`（campaign × version × step × 受信者）で、
 * **送信経路（`handlePlan`）が `already_delivered` に使う鍵と同一**。
 *
 * ⚠️ 返すのは件数と状態の内訳だけ。**アドレス・recordId・DeliveryKey は返さない。**
 */
/**
 * 展開状態の書き換え（**唯一の書き込み口**）。
 *
 * ⚠️ **これだけが read-only ではない。** 書くのは Redis の展開状態のみで、
 *    Customers・`ScheduledEmails`・`CampaignDeliveries`・SendGrid には一切触れない。
 *
 * ── なぜ必要か ────────────────────────────────────────────────
 * 2026-08-15 の activation で、状態を書く経路が本番に無く**開始できなかった**。
 * さらに runbook が約束している「異常時は `killed: true` で全停止」も、
 * 立てる手段が無いままだった（rollback が絵に描いた餅になっていた）。
 *
 * ── 安全策 ────────────────────────────────────────────────────
 * - 管理 secret 必須（この Function の入口で検証済み）
 * - 受け付ける値は `rolloutControl.js` が allow-list で絞る
 *   （段階は 5 値・1 日上限と 1 バッチ人数は必須の整数・武装日は当日〜7 日先）
 * - `start` は **CAS 必須**（`expectedVersion`。競合したら書かない）
 * - `kill` は競合しても 1 度やり直す（**止める操作は通したい**）
 * - 応答に PII・secret を入れない
 */
async function handleRolloutControl({ op, now, req }) {
  const campaignId = String((req && req.campaignId) || '').trim();
  const base = getCampaign(campaignId, { includeDisabled: true });
  if (!base) return json(400, { error: '未知のキャンペーンです', sideEffects: 'none' });
  if (!isSequenceCampaign(base)) {
    return json(400, { error: 'このキャンペーンは連続配信ではありません', sideEffects: 'none' });
  }
  // 機能そのものの許可（既定 OFF）。**env が閉じているうちは状態も触らせない**
  if (!isRolloutEnabled(process.env)) {
    return json(503, {
      error: '自動運転が無効です（MARKETING_ROLLOUT_ENABLED 未設定）',
      flag: 'MARKETING_ROLLOUT_ENABLED',
      sideEffects: 'none',
    });
  }

  let store;
  try {
    store = createRolloutStore({ cmd: makeRedisCmd(process.env) });
  } catch {
    return json(503, { error: '展開状態の保存先へ接続できません', sideEffects: 'none' });
  }

  try {
    // ── 緊急停止だけは読み直して 1 度やり直す（止める操作は通す）──────
    if (op === ROLLOUT_OP.KILL) {
      const killed = await store.kill({ campaignId, nowMs: now, note: String((req && req.note) || '') });
      console.log('🛑 [admin-marketing] rollout kill', { campaignId, stage: killed.state.stage });
      return json(200, {
        mode: 'rollout-control',
        sideEffects: '展開状態（Redis）のみ',
        ...describeControlResult({ op, state: killed.state }),
        notice: '緊急停止しました。**次の cron tick から自動処理を全部止めます**'
          + '（既に起動済みの送信は走り切ることがあります。'
          + '送信経路自体を閉じるには MARKETING_CAMPAIGN_DISPATCH_ENABLED を外して redeploy してください）。',
      });
    }

    const cur = await store.load(campaignId);

    let planned;
    if (op === ROLLOUT_OP.START) {
      planned = planRolloutStart({ current: cur.state, exists: cur.exists, req, nowMs: now });
    } else if (op === ROLLOUT_OP.PAUSE) {
      planned = planRolloutPause({ current: cur.state, nowMs: now });
    } else if (op === ROLLOUT_OP.RESUME) {
      planned = planRolloutResume({ current: cur.state, nowMs: now });
    } else {
      return json(400, { error: '知らない操作です', sideEffects: 'none' });
    }
    if (!planned.ok) {
      return json(400, {
        error: CONTROL_REJECT_LABEL[planned.reason] || '指定を受け付けられません',
        reason: planned.reason,
        sideEffects: 'none',
      });
    }

    const expectedVersion = op === ROLLOUT_OP.START
      ? planned.expectedVersion
      : (cur.exists ? cur.state.version : null);
    const saved = await store.save({ campaignId, state: planned.state, expectedVersion });
    console.log('🚚 [admin-marketing] rollout control', {
      campaignId, op, stage: saved.state.stage, dailyLimit: saved.state.dailyLimit,
    });
    return json(200, {
      mode: 'rollout-control',
      sideEffects: '展開状態（Redis）のみ',
      ...describeControlResult({ op, state: saved.state }),
      notice: op === ROLLOUT_OP.START
        ? '展開状態を設定しました。**まだ 1 件も付与していません**（次の cron tick から動きます）。'
        : '展開状態を更新しました。付与・キュー登録・送信は行っていません。',
    });
  } catch (e) {
    const code = (e instanceof RolloutStoreError && e.code) || 'unavailable';
    // 競合は「誰かが同時に触った」なので、**書かずに** 409 で返す
    const status = code === 'cas_conflict' ? 409 : 503;
    return json(status, {
      error: code === 'cas_conflict'
        ? '他の操作と競合しました。もう一度読み直してからやり直してください。'
        : '展開状態を更新できませんでした。',
      code,
      sideEffects: 'none',
    });
  }
}

/**
 * 配信台帳を **1 ページだけ** 読む（cursor = Airtable の offset）。
 *
 * ⚠️ 全件取得（`fetchAllStrict`）と違い、**ここでは打ち切りを異常としない**。
 *    「続きがある」ことを `offset` で返し、呼び出し側が次を取る前提だから。
 *    黙って短い結果を全体として見せないよう、応答側で `partial` / `cursor` を必ず出す。
 * ⚠️ `RecipientEmail` は DeliveryKey の突き合わせに要るが、**応答にもログにも出さない**。
 */
async function fetchDeliveryPage({ KEY, BASE, campaignType, pageSize, cursor }) {
  const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(DELIVERIES_TABLE)}`);
  // Airtable の 1 リクエスト上限は 100 件。要求ページはそれを跨いで満たす
  url.searchParams.set('pageSize', '100');
  url.searchParams.set('filterByFormula', `{CampaignType}='${campaignType}'`);
  for (const f of ['DeliveryKey', 'CampaignType', 'Status', 'SentAt', 'QueuedAt', 'RecipientEmail']) {
    url.searchParams.append('fields[]', f);
  }
  const records = [];
  let offset = cursor || undefined;
  while (records.length < pageSize) {
    if (offset) url.searchParams.set('offset', offset); else url.searchParams.delete('offset');
    // eslint-disable-next-line no-await-in-loop -- Airtable は offset 方式
    const res = await fetch(url, { headers: authHeaders(KEY) });
    if (!res.ok) throw new Error(`${DELIVERIES_TABLE} page fetch failed: HTTP ${res.status}`);
    // eslint-disable-next-line no-await-in-loop
    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset;
    if (!offset) break;
  }
  return { records, offset: offset || null };
}

/**
 * touch 別の配信実績 **1 ページぶん**（`action=touchMeasurementPage`・read-only・PII なし）。
 *
 * 「送った」だけでなく「**届いた・開かれた**」を touch ごとに出す。
 * 数え方は `touchMeasurement.js` が単一源で、結合は **DeliveryKey 完全一致**。
 *
 * ⚠️ **これは 1 ページの数**。応答は必ず `partial` と `scan.cursor` を持つ。
 *    全体は `action=touchMeasurement`（小さい campaign 用）か
 *    `npm run scan:touch-measurement`（cursor を辿って合算）で得る。
 * ⚠️ **Blob の全件走査はしない。** Redis の索引は bounded read（1 ページ ≤ 500 鍵）。
 * ⚠️ 索引が読めないときは **`measurementAvailable: false`**（0 件と書かない）。
 */
async function handleTouchMeasurementPage({ KEY, BASE, now, req }) {
  const base = getCampaign(req.campaignId, { includeDisabled: true });
  if (!base) return json(400, { error: '未知のキャンペーンです', sideEffects: 'none' });
  if (!isSequenceCampaign(base)) {
    return json(400, { error: 'このキャンペーンは連続配信ではありません', sideEffects: 'none' });
  }

  // ── 対象の配信行を **1 ページだけ**引く（cursor = Airtable の offset）─────
  //    ⚠️ 全件一括で読まない。2026-08-17 に 610 行で 504（Inactivity Timeout）になった。
  //       最終的に 14,000 名規模になるので、**1 リクエスト 1 ページ**に固定し、
  //       呼び出し側が cursor を辿って合算する（`touchMeasurementScan.js`）。
  const version = String(base.version);
  const campaignType = `${base.campaignId}:v${version}`;
  const pageSize = resolveScanPageSize(req.pageSize);
  const cursorIn = str(req.cursor) || null;
  const pageIndex = Number.isInteger(Number(req.pageIndex)) && Number(req.pageIndex) >= 0
    ? Number(req.pageIndex) : 0;
  let deliveries;
  let nextCursor = null;
  try {
    const page = await fetchDeliveryPage({
      KEY, BASE, campaignType, pageSize, cursor: cursorIn,
    });
    deliveries = page.records;
    nextCursor = page.offset || null;
  } catch (e) {
    return json(500, {
      error: '配信台帳を読めなかったため、実績を返しません（数えられない数は出しません）。',
      code: 'deliveries_fetch_incomplete',
      sideEffects: 'none',
    });
  }

  // ── DeliveryKey → step の対応表を作る（**推測しない**）───────────
  //    受信者ごとに、その campaign の各 step の鍵を計算して突き合わせる。
  const fromEmail = getBrandConfig(BRAND).defaultFromEmail;
  const emails = [...new Set(deliveries
    .map((r) => str((r.fields || {}).RecipientEmail).toLowerCase())
    .filter(Boolean))];
  const stepByDeliveryKey = new Map();
  for (const s of getSequenceSteps(base)) {
    const stepCampaign = resolveSequenceStep(base, s.stepNumber);
    if (!stepCampaign) continue;
    for (const email of emails) {
      const k = computeCampaignDeliveryKey({
        campaign: stepCampaign, recipientEmail: email, brand: BRAND, fromEmail,
      });
      if (k) stepByDeliveryKey.set(k, s.stepNumber);
    }
  }

  // ── イベント索引を bounded read ─────────────────────────────────
  const keys = deliveries
    .map((r) => str((r.fields || {}).DeliveryKey))
    .filter((k) => stepByDeliveryKey.has(k));
  let index = { ok: false, byKey: new Map() };
  if (keys.length > 0) {
    try {
      const idx = createDeliveryEventIndex({ cmd: makeRedisCmd(process.env) });
      index = await idx.read(keys.slice(0, MAX_READ_KEYS));
    } catch {
      index = { ok: false, byKey: new Map() };   // 読めない = 未計測（0 件にしない）
    }
  }

  const summary = summarizeByTouch({ deliveries, stepByDeliveryKey, index });
  const done = !nextCursor;
  return json(200, {
    mode: 'touch-measurement',
    sideEffects: 'none',
    campaignId: base.campaignId,
    version: base.version,
    ...summary,
    /**
     * このページだけの数であることを**必ず明示する**（黙って一部を全体として出さない）。
     * `done: false` の間は `cursor` を渡して次を取り、`touchMeasurementScan.js` の
     * `mergeTouchPage` で足す（同じ `pageIndex` は二重に数えない）。
     */
    scan: {
      pageIndex,
      pageSize,
      rows: deliveries.length,
      cursor: nextCursor,
      done,
    },
    partial: !done,
    io: {
      /** Blob は読んでいない（全件走査ゼロ） */
      blobReads: 0,
      redisKeys: Math.min(keys.length, MAX_READ_KEYS),
      airtableRows: deliveries.length,
      cappedAt: MAX_READ_KEYS,
      /** 1 ページは索引の bounded read 上限以下なので、ページ内で切れることはない */
      truncated: keys.length > MAX_READ_KEYS,
    },
    notice: [
      summary.measurementAvailable
        ? '配信イベントの索引から数えています（open は届いた通が分母）。'
        : '**イベント索引を読めませんでした。** 未計測として扱っています（0 件ではありません）。',
      done
        ? null
        : '**これは 1 ページぶんの数です。** `cursor` を渡して続きを取り、合算してください'
          + '（`npm run scan:touch-measurement`）。',
    ].filter(Boolean).join(' '),
  });
}

/**
 * 索引ができる前に届いたイベントを、生ログから入れ直す**下見**（read-only）。
 *
 * ⚠️ **1 バイトも書かない。** 実行（Redis への書き込み）は別の承認境界。
 * ⚠️ Blob は**日付で絞って**読む（全件走査しない）。
 */
/**
 * touch 別の配信実績 **全体**（`action=touchMeasurement`・read-only・PII なし）。
 *
 * ── 契約（**ここが肝**）────────────────────────────────────────
 * この action は**昔から「全体の集計」**を返す約束で、runbook の curl もそう読む。
 * 配信行が増えた今、1 リクエストで全部は数え切れない。そこで:
 *
 *   数え切れた   → `complete: true` ＋ 従来どおりの `touches` / `totals`
 *   数え切れない → **`touches` も `totals` も返さない**（`complete: false` +
 *                  `code: 'measurement_requires_scan'`）
 *
 * ⚠️ **部分集計を全体の形で返さない。** 一部を全体と誤読させるくらいなら
 *    数を出さない方が安全（2026-08-17 の 504 と同じ「黙って足りない」を作らない）。
 * ⚠️ 歩くページ数は `MEASUREMENT_INLINE_MAX_PAGES` で頭打ち。
 *    **ここを増やして全件走査に戻さない。** 大きい campaign は
 *    `action=touchMeasurementPage` / `npm run scan:touch-measurement` を使う。
 */
async function handleTouchMeasurement({ KEY, BASE, now, req }) {
  const base = getCampaign(req.campaignId, { includeDisabled: true });
  if (!base) return json(400, { error: '未知のキャンペーンです', sideEffects: 'none' });
  if (!isSequenceCampaign(base)) {
    return json(400, { error: 'このキャンペーンは連続配信ではありません', sideEffects: 'none' });
  }

  let pageIndex = 0;
  let failed = null;
  const scan = await scanAllTouchPages({
    maxPages: MEASUREMENT_INLINE_MAX_PAGES,
    fetchPage: async (cursor) => {
      const res = await handleTouchMeasurementPage({
        KEY, BASE, now, req: { ...req, cursor: cursor || undefined, pageIndex },
      });
      let body = {};
      try { body = JSON.parse(res.body || '{}'); } catch { body = {}; }
      if (res.statusCode !== 200) { failed = body; return null; }
      pageIndex += 1;
      return body;
    },
  });
  if (failed) return json(500, { ...failed, sideEffects: 'none' });

  const built = buildInlineMeasurementResult({ scan, budgetPages: MEASUREMENT_INLINE_MAX_PAGES });
  return json(built.ok ? 200 : 413, {
    mode: 'touch-measurement',
    /** 契約が変わったことを読み手が判別できるようにする */
    schemaVersion: 2,
    sideEffects: 'none',
    campaignId: base.campaignId,
    version: base.version,
    ...built.body,
    notice: built.ok
      ? '配信イベントの索引から数えています（open は届いた通が分母）。**全ページを数え切っています**。'
      : '**数え切れなかったので数字は返していません**（部分を全体として扱わないため）。'
        + '`action=touchMeasurementPage` で cursor を辿るか、`npm run scan:touch-measurement` を使ってください。',
  });
}

async function handleEventBackfill({ KEY, BASE, req, event, live = false }) {
  const base = getCampaign(req.campaignId, { includeDisabled: true });
  if (!base) return json(400, { error: '未知のキャンペーンです', sideEffects: 'none' });
  const date = str(req.date);
  const prefix = blobDatePrefix(date);
  if (!prefix) {
    return json(400, { error: '走査する日付（date: YYYY-MM-DD）を指定してください', sideEffects: 'none' });
  }
  const step = Number(req.step);
  if (!Number.isInteger(step) || step < 1) {
    return json(400, { error: '対象の step を指定してください', sideEffects: 'none' });
  }
  const stepCampaign = resolveSequenceStep(base, step);
  if (!stepCampaign) return json(400, { error: '未知のステップです', sideEffects: 'none' });

  // 対象の DeliveryKey（この campaign × version × step の受信者ぶん）
  const campaignType = `${base.campaignId}:v${base.version}`;
  let deliveries;
  try {
    deliveries = await fetchAllStrict({
      KEY, BASE, table: DELIVERIES_TABLE,
      filterByFormula: `{CampaignType}='${campaignType}'`,
      fields: ['DeliveryKey', 'Status', 'RecipientEmail'],
    });
  } catch {
    return json(500, { error: '配信台帳を取り切れませんでした', sideEffects: 'none' });
  }
  const fromEmail = getBrandConfig(BRAND).defaultFromEmail;
  const targetKeys = new Set();
  for (const r of deliveries) {
    const f = r.fields || {};
    if (str(f.Status) !== 'sent') continue;
    const email = str(f.RecipientEmail).toLowerCase();
    if (!email) continue;
    const k = computeCampaignDeliveryKey({
      campaign: stepCampaign, recipientEmail: email, brand: BRAND, fromEmail,
    });
    if (k && str(f.DeliveryKey) === k) targetKeys.add(k);
  }

  // 生ログ（Blob）を**その日だけ**読む
  let records = [];
  let blobsScanned = 0;
  try {
    const { getStore, connectLambda } = await import('@netlify/blobs');
    // ⚠️ v1 形式（`handler(event)`）の Function から Blobs を使うには **接続が要る**。
    //    これを忘れると MissingBlobsEnvironmentError になる（Premium Plus 実績画像で踏んだ罠）。
    if (event) connectLambda(event);
    const store = getStore('ak-email-events');
    const listed = await store.list({ prefix });
    const blobs = (listed && listed.blobs) || [];
    for (const b of blobs.slice(0, MAX_BLOBS_PER_RUN)) {
      // eslint-disable-next-line no-await-in-loop
      const text = await store.get(b.key);
      if (!text) continue;
      blobsScanned += 1;
      records = records.concat(parseNdjson(text));
    }
  } catch (e) {
    return json(503, {
      error: '生ログ（Blob）を読めませんでした。下見を確定できません。',
      code: 'blob_unreadable',
      sideEffects: 'none',
    });
  }

  const { plan, stats } = planBackfill({ records, targetKeys });
  const view = describeBackfillPlan({ plan, stats, targetKeys, blobsScanned });

  if (!live) {
    return json(200, {
      mode: 'event-backfill-dry-run',
      sideEffects: 'none',
      campaignId: base.campaignId,
      version: base.version,
      step,
      date,
      ...view,
      notice: 'これは下見です。**Redis へ 1 バイトも書いていません**（実行は別承認）。',
    });
  }

  // ── 実行（**索引だけ**を書く）────────────────────────────────
  //   ⚠️ 下見と同じ計画であることを件数で突き合わせる（TOCTOU 防止）。
  //      Blob は追記され続けるので、確認した数と違えば**書かずに止める**。
  if (req.confirm !== true) {
    return json(400, { error: '実行するには confirm: true が必要です', sideEffects: 'none' });
  }
  const expected = Number(req.expectedWriteKeys);
  if (!Number.isInteger(expected)) {
    return json(400, {
      error: '下見で確認した willWriteKeys（expectedWriteKeys）が必要です', sideEffects: 'none',
    });
  }
  if (expected !== view.willWriteKeys) {
    return json(409, {
      error: '下見のときと対象が変わりました。もう一度下見からやり直してください。',
      expected, got: view.willWriteKeys, sideEffects: 'none',
    });
  }
  if (view.conflicts > 0) {
    return json(409, {
      error: '同じ鍵に別キャンペーンのイベントが混ざっています。書き込みを中止しました。',
      conflicts: view.conflicts, sideEffects: 'none',
    });
  }

  let result = { keys: 0, written: 0, failed: 0 };
  try {
    const idx = createDeliveryEventIndex({ cmd: makeRedisCmd(process.env) });
    // 索引の畳み込みは webhook と**同じ関数**を通す（別経路を作らない）
    const events = [];
    for (const [key, u] of plan) {
      if (u.deliveredAtMs !== null) {
        events.push({ type: 'delivered', atMs: u.deliveredAtMs, deliveryKey: key });
      }
      if (u.firstOpenAtMs !== null) {
        const ids = u.openEventIds.length > 0 ? u.openEventIds : [''];
        for (const id of ids) {
          events.push({
            type: 'open',
            atMs: u.firstOpenAtMs,
            deliveryKey: key,
            providerEventId: id,
          });
        }
        if (u.lastOpenAtMs !== null && u.lastOpenAtMs !== u.firstOpenAtMs) {
          events.push({ type: 'open', atMs: u.lastOpenAtMs, deliveryKey: key, providerEventId: '' });
        }
      }
    }
    result = await idx.fold({ events, nowMs: Date.now() });
  } catch {
    return json(503, { error: '索引へ書き込めませんでした', sideEffects: 'unknown' });
  }

  console.log('🔑 [admin-marketing] event backfill:', {
    campaignId: base.campaignId, step, date,
    keys: result.keys, written: result.written, failed: result.failed,
  });
  return json(200, {
    mode: 'event-backfill-run',
    sideEffects: '配信イベント索引（Redis）のみ',
    campaignId: base.campaignId,
    version: base.version,
    step,
    date,
    ...view,
    written: result.written,
    failed: result.failed,
    notice: '索引へ書き込みました。**Customers・配信台帳・送信には触れていません**'
      + '（同じ内容を再実行しても結果は変わりません）。',
  });
}

async function handleDuplicateCheck({ KEY, BASE, req }) {
  const base = getCampaign(req.campaignId, { includeDisabled: true });
  if (!base) return json(400, { error: '未知のキャンペーンです', sideEffects: 'none' });
  const campaign = resolveStepCampaign({ campaign: base, step: req.step });
  if (!campaign) return json(400, { error: '未知のステップです', sideEffects: 'none' });

  const recordIds = Array.isArray(req.recordIds) ? req.recordIds.map(String) : [];
  if (recordIds.length === 0) return json(400, { error: '対象が選択されていません', sideEffects: 'none' });
  // ⚠️ 判定と表示で**同じ上限**を使う（閾値とメッセージがズレていると、
  //    「上限 500 件」と言いながら 900 件を受け付ける、が起きる）
  if (recordIds.length > DUPLICATE_CHECK_MAX) {
    return json(400, {
      error: `選択が多すぎます（上限 ${DUPLICATE_CHECK_MAX} 件）`,
      limit: DUPLICATE_CHECK_MAX, given: recordIds.length, sideEffects: 'none',
    });
  }
  // 重複した recordId は**受け付けない**。候補数と鍵の数がズレて
  // 「判定できた」と誤認する余地を作らない
  const uniqueIds = new Set(recordIds);
  if (uniqueIds.size !== recordIds.length) {
    return json(400, {
      error: '対象に重複があります（重複したまま判定しません）',
      duplicates: recordIds.length - uniqueIds.size, sideEffects: 'none',
    });
  }

  const fromEmail = getBrandConfig(BRAND).defaultFromEmail;
  const campaignType = `${campaign.campaignId}:v${campaign.version}`;

  // ① 宛先を名指しで引く（全件走査しない）
  let customers;
  try {
    customers = await fetchByRecordIds({ KEY, BASE, table: CUSTOMERS_TABLE, recordIds });
  } catch (e) {
    return json(500, {
      error: '対象顧客を取り切れなかったため、重複を判定しません。',
      code: 'duplicate_customers_fetch_incomplete',
      detail: String((e && e.message) || 'unknown'), sideEffects: 'none',
    });
  }
  const byId = new Map(customers.map((r) => [r.id, r]));
  const keys = [];
  const candidateEmails = new Set();   // ⚠️ 応答にもログにも出さない（照合にだけ使う）
  let unresolved = 0;   // 顧客が引けない / メールが無い = 鍵を作れない
  for (const id of recordIds) {
    const email = String(((byId.get(id) || {}).fields || {}).Email || '').trim().toLowerCase();
    const key = email
      ? computeCampaignDeliveryKey({ campaign, recipientEmail: email, brand: BRAND, fromEmail })
      : null;
    if (key) { keys.push(key); candidateEmails.add(email); } else unresolved += 1;
  }

  // ② その鍵の配信行だけを名指しで引く（台帳の大きさに依存しない）
  let rows;
  try {
    rows = await fetchDeliveryRowsByKeys({ KEY, BASE, campaignType, keys });
  } catch (e) {
    return json(500, {
      error: '配信行を取り切れなかったため、重複を判定しません。',
      code: 'duplicate_deliveries_fetch_incomplete',
      detail: String((e && e.message) || 'unknown'), sideEffects: 'none',
    });
  }

  const byStatus = {};
  const jobIds = new Set();
  const seenKeys = new Set();
  for (const r of rows) {
    const f = (r && r.fields) || {};
    const st = String(f.Status || '(空)').toLowerCase();
    byStatus[st] = (byStatus[st] || 0) + 1;
    // 送信経路が `already_delivered` とみなすのは queued / sent
    if (st === 'queued' || st === 'sent') {
      const k = String(f.DeliveryKey || '');
      if (k) seenKeys.add(k);
    }
    const j = String(f.ScheduledEmailJobId || '').trim();
    if (j) jobIds.add(j);
  }

  // ③ 候補に紐づくジョブの状態だけを見る（campaign 全履歴は見ない）。
  //    「この人たちが既に送信待ちのジョブに載っていないか」を確認する。
  let linkedJobs = [];
  try {
    linkedJobs = jobIds.size > 0
      ? await fetchByJobIds({ KEY, BASE, jobIds: [...jobIds] })
      : [];
  } catch (e) {
    return json(500, {
      error: '候補に紐づくジョブを取り切れなかったため、重複を判定しません。',
      code: 'duplicate_jobs_fetch_incomplete',
      detail: String((e && e.message) || 'unknown'), sideEffects: 'none',
    });
  }
  const jobStatus = {};
  for (const r of linkedJobs) {
    const st = String(((r && r.fields) || {}).Status || '(空)').toUpperCase();
    jobStatus[st] = (jobStatus[st] || 0) + 1;
  }

  // ④ **本当の orphan PENDING** を捕まえる。
  //
  // ③ は `CampaignDeliveries → ScheduledEmailJobId → ScheduledEmails` と辿るので、
  // **配信行が欠けている**ジョブは見えない。ところがキュー登録は
  // 「ジョブ行を作る → 配信行を upsert する」の順なので、途中で落ちると
  // **PENDING ジョブだけが残り配信行が無い**状態になる。これが本当の orphan で、
  // 見逃すと同じ人へ 2 通目のジョブを積んでしまう。
  //
  // ジョブ側には宛先（`Recipients`）が入っているので、**送信待ちのジョブだけ**を
  // 引いて候補と突き合わせる。`PENDING` は「いま詰まっているキュー」なので
  // 件数は小さく、campaign の全履歴を走査することにはならない。
  let pendingJobRecords = [];
  try {
    pendingJobRecords = await fetchAllStrict({
      KEY, BASE, table: SCHEDULED_TABLE,
      filterByFormula: `AND({Status}='PENDING',${MARKETING_JOB_FORMULA})`,
      maxPages: TARGETED_MAX_PAGES,
      fields: ['JobId', 'Status', 'Recipients', 'TargetPlan', 'Notes'],
    });
  } catch (e) {
    return json(500, {
      error: '送信待ちジョブを取り切れなかったため、重複を判定しません。',
      code: 'duplicate_pending_fetch_incomplete',
      detail: String((e && e.message) || 'unknown'), sideEffects: 'none',
    });
  }

  const stepContentHash = computeCampaignContentHash(campaign);
  const overlap = { jobs: 0, candidates: 0, sameStep: 0, otherStep: 0, unknownStep: 0 };
  const overlapped = new Set();
  for (const rec of pendingJobRecords) {
    const f = (rec && rec.fields) || {};
    const parsed = parseJobCampaign(f);
    // campaign / version が違うジョブは対象外（別キャンペーンの滞留は別問題）
    if (String(parsed.campaignId) !== String(campaign.campaignId)) continue;
    if (String(parsed.version) !== String(campaign.version)) continue;
    const hit = splitRecipients(f.Recipients).filter((e) => candidateEmails.has(e));
    if (hit.length === 0) continue;
    overlap.jobs += 1;
    for (const e of hit) overlapped.add(e);
    // step の同一性は**内容 hash**で見る（ステップごとに件名・本文が違うので hash も違う）
    if (!parsed.contentHash) overlap.unknownStep += 1;
    else if (stepContentHash.startsWith(parsed.contentHash)) overlap.sameStep += 1;
    else overlap.otherStep += 1;
  }
  overlap.candidates = overlapped.size;

  return json(200, {
    mode: 'duplicate-check',
    sideEffects: 'none',
    campaignId: campaign.campaignId,
    version: campaign.version,
    step: campaign.sequenceStep ?? null,
    /** 判定できた候補数（= 鍵を作れた数）。要求数と違えば fail closed の材料 */
    candidates: recordIds.length,
    resolved: keys.length,
    unresolved,
    /** 既に queued / sent の鍵を持つ候補数。**0 でなければ送ってはいけない** */
    alreadyDelivered: seenKeys.size,
    /** 参考: 見つかった配信行の状態内訳（cancelled / skipped も見える） */
    byStatus,
    /** 候補に紐づくジョブの状態内訳。PENDING があれば送信待ちに載っている */
    linkedJobs: linkedJobs.length,
    linkedJobStatus: jobStatus,
    pendingLinkedJobs: jobStatus.PENDING || 0,
    /**
     * **配信行が無くても**候補が送信待ちジョブに載っているか
     * （`Recipients` 側から突き合わせた結果。本当の orphan PENDING を捕まえる）。
     * `sameStep` / `otherStep` は内容 hash による step 同一性。
     */
    pendingOverlap: overlap,
    /** 送信待ちジョブに載っている候補数（**0 でなければ送ってはいけない**） */
    pendingCandidates: overlap.candidates,
    notice: 'いま選んでいる宛先ぶんだけを DeliveryKey で名指し確認しています'
      + '（campaign の過去実績は見ていません）。何も書き込んでいません。',
  });
}

/** 重複確認で受け付ける候補数の上限（**判定と表示で同じ値を使う**） */
const DUPLICATE_CHECK_MAX = MAX_RECIPIENTS_PER_SEND;

/**
 * `ScheduledEmails.Recipients`（`a@x, b@y` 形式）を小文字のアドレス配列にする。
 * ⚠️ 戻り値は**照合にだけ**使う。応答にもログにも出さない。
 */
function splitRecipients(value) {
  return String(value ?? '')
    .split(/[,;\n]/)
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

/** 候補の DeliveryKey に一致する配信行だけを引く（名指し・fail closed） */
async function fetchDeliveryRowsByKeys({ KEY, BASE, campaignType, keys }) {
  const out = [];
  for (const group of chunkList(keys, TARGETED_CHUNK)) {
    const formula = buildDeliveryKeyFormula({ campaignType, keys: group });
    if (!formula) continue;
    // eslint-disable-next-line no-await-in-loop -- チャンクごとに順に読む
    const rows = await fetchAllStrict({
      KEY, BASE, table: DELIVERIES_TABLE, filterByFormula: formula,
      maxPages: TARGETED_MAX_PAGES,
      fields: ['DeliveryKey', 'Status', 'ScheduledEmailJobId'],
    });
    out.push(...rows);
  }
  return out;
}

/** 指定 JobId のジョブ行だけを引く（名指し・fail closed） */
async function fetchByJobIds({ KEY, BASE, jobIds }) {
  const out = [];
  for (const group of chunkList(jobIds, JOB_ID_CHUNK)) {
    const safe = group.filter((id) => /^[A-Za-z0-9_.-]{1,120}$/.test(id));
    if (safe.length !== group.length) {
      throw new Error(`${SCHEDULED_TABLE}: formula へ載せられない JobId があります（判定を中止します）`);
    }
    if (safe.length === 0) continue;
    const formula = `OR(${safe.map((id) => `{JobId}='${id}'`).join(',')})`;
    // eslint-disable-next-line no-await-in-loop
    const rows = await fetchAllStrict({
      KEY, BASE, table: SCHEDULED_TABLE, filterByFormula: formula,
      maxPages: JOB_ID_MAX_PAGES, fields: ['JobId', 'Status'],
    });
    out.push(...rows);
  }
  return out;
}

async function handleTrialGrantPreview({ now, req }) {
  // 下見でだけ「もし N 件なら」を試せる（**実行には効かない**。env が正本）
  const override = Number.isInteger(req && req.batchSize) ? req.batchSize : null;
  if (override !== null && (override <= 0 || override > HARD_MAX_BATCH_SIZE)) {
    return json(400, { error: `batchSize は 1〜${HARD_MAX_BATCH_SIZE} で指定してください`, sideEffects: 'none' });
  }

  // 🛡️ **cron と同じ 1 本**を通す。formula / sort / 関所 / 指紋が構造的に一致する。
  //    ここで全件走査に戻してはいけない（14,489 件で必ずタイムアウトする）。
  const loaded = await loadAndPlanLightTrial({
    env: process.env, nowMs: now, batchSizeOverride: override,
  });
  if (!loaded.ok) {
    // 取得上限に達した = 数え切れていない。**黙って少なく見せない**
    return json(200, {
      mode: 'trial-grant-preview',
      sideEffects: 'none',
      ok: false,
      abort: loaded.abort,
      fetch: loaded.fetch || null,
      notice: '取得の上限に達したため、下見を確定できませんでした（**付与も行いません**）。',
    });
  }

  const planned = loaded.planned;
  const counts = planned.counts || {};
  const observable = assertCohortObservable(planned.cohort || {});

  return json(200, {
    mode: 'trial-grant-preview',
    sideEffects: 'none',
    offerId: planned.offerId,
    operationId: planned.operationId,
    auto: {
      enabled: (planned.gates || {}).allOpen === true,
      missing: (planned.gates || {}).missing || [],
      note: (planned.gates || {}).allOpen
        ? '自動付与は有効です。cron が 1 日 1 回、先頭から順に付与します。'
        : '自動付与は停止中です。付与するには管理画面（カムバック特典）から手動で行います。',
    },
    cohort: {
      /** ⚠️ **全体数ではない**。今回の下見で実際に読んだ範囲 */
      observed: planned.cohort ? planned.cohort.inCohort : 0,
      byBatch: planned.cohort ? planned.cohort.byBatch : {},
      partial: true,
      observable: observable.ok,
      note: observable.ok
        ? 'コホート全体は数えていません（全件走査を廃止したため）。表示は読んだ範囲の内訳です。'
        : 'CSV 取り込みの痕跡が 1 件も見つかりません。**この状態では誰にも付与しません**。',
    },
    /** 今回処理予定 → 残りは「正確には出さない」 */
    batch: counts.batchSize || 0,
    batchSize: planned.batchSize,
    batchSizeSource: override !== null ? 'request-preview' : planned.batchSizeSource,
    hardMax: HARD_MAX_BATCH_SIZE,
    /** 全件走査をやめたので **exact な残数は出さない** */
    remainingExact: null,
    moreAvailable: loaded.fetch.moreAvailable,
    pagesFetched: loaded.fetch.pagesFetched,
    recordsFetched: loaded.fetch.recordsFetched,
    barrier: {
      granted: (planned.barrier || {}).granted || 0,
      outstandingStep1: (planned.barrier || {}).outstanding || 0,
      resolved: (planned.barrier || {}).resolved || 0,
      nextBatchAllowed: (planned.barrier || {}).nextBatchAllowed === true,
      recordsFetched: loaded.fetch.barrierRecords,
      byReason: Object.fromEntries(
        Object.entries((planned.barrier || {}).byReason || {})
          .map(([k, v]) => [BARRIER_RESOLVED_LABEL[k] || k, v]),
      ),
    },
    planFingerprint: planned.planFingerprint || '',
    abort: planned.ok ? null : planned.abort,
    abortReason: planned.reason || null,
    excludedByReason: Object.fromEntries(
      Object.entries(counts.byReason || {})
        .map(([k, v]) => [AUTOGRANT_SKIP_LABEL[k] || COHORT_SKIP_LABEL[k] || k, v]),
    ),
    notice: 'これは下見です。**付与もキュー登録もしていません**。付与しても Step1 は自動送信されません。',
  });
}

/**
 * 連続配信の状況（**read-only**・送信もキュー登録もしない）。
 *
 * 「いま誰が何通目か」「次に送れるのは何人か」「なぜ止まったか」を
 * **実送信と同じ判定**（`sequenceProgress.js`）で数える。
 * 画面はこの数字だけを出す（独自に数え直さない）。
 */
/**
 * 連続配信の実績（**配信台帳の実データ**由来）。
 *
 * 集計は cron が台帳を走査するときに作られる（追加の読み取りをしない）。
 * ここは**読むだけ**。アドレスも recordId も返さない。
 *
 * ⚠️ **queued を「送信済み」として返さない。** 別の項目として出し、
 *    未送信残（queued のまま sent になっていない数）も併記する。
 */
/**
 * 反応（open / click）の集計を **hash のまま**返す（read-only・**1 バイトも書かない**）。
 *
 * ── なぜ要るか ──────────────────────────────────────────────
 * prospect 移行の判定は「開封した人は Customers へ残す」なので、**開封者の集合**が要る。
 * ところが集計は Redis にあり、本番の接続情報は masked secret なので手元からは読めない。
 * かといって画面の集計（件数だけ）では、どのレコードが開封者なのか分からない。
 *
 * ── アドレスを出さない ──────────────────────────────────────
 * 集計は元から `sha256(email).slice(0,32)` を鍵にしているので、**その鍵をそのまま返す**。
 * 呼び出し側は手元の Customers から同じ hash を計算して突き合わせる。
 * **アドレスも氏名も recordId もこの応答には入らない。**
 *
 * ⚠️ 集計を読めないときは `available:false` を返す。**空配列と混同させない**
 *    （空を「開封者ゼロ」と解釈すると、開封した人まで prospect へ落とす）。
 */
/** 投入の書き込みを開く env（**未設定なら下見しかできない**） */
const PROSPECT_INTAKE_ENV = 'PROSPECT_MIGRATION_ENABLED';
/** 1 回で扱う Customers の件数（名指し取得と per-page parity が収まる大きさ） */
const INTAKE_PAGE_SIZE = 300;
/** 書き込みを許す確認文字列（画面から流し込めない値にしておく） */
const INTAKE_CONFIRM = 'MIGRATE PROSPECTS';

/**
 * CSV 取り込み分を **prospect プールへ移す**（1 ページずつ）。
 *
 * ── 何をして、何をしないか ────────────────────────────────────
 *   する   … Customers を 1 ページ読み、移行対象だけを prospect レコードへ組み直し、
 *            **そのページだけで両経路の一致（parity）を確かめてから** Redis へ書く
 *   しない … **Customers を 1 件も消さない**。削除は別工程・別承認
 *
 * ── 書き込みが起きる条件（4 つ全部）──────────────────────────
 *   1. `PROSPECT_MIGRATION_ENABLED=true`（env。既定は下見のみ）
 *   2. `confirm` が一致
 *   3. 反応（開封）の集計が**読めている**（読めないなら開封者を移してしまう）
 *   4. **そのページの parity が差分 0**（対象 / 次 step / DeliveryKey / 停止理由 / delivered）
 *
 * ⚠️ 1 つでも欠ければ**下見の結果だけ**を返して 1 バイトも書かない（fail closed）。
 * ⚠️ 既に prospect が居るアドレスは上書きしない（`addIfAbsent`）。
 *    抑止台帳に載っている相手は復活しない（store 側で弾く）。
 * ⚠️ 既送信の `DeliveryKey` は**そのまま**台帳へ入れる。作り方を変えない。
 */
async function handleProspectIntake({ KEY, BASE, now, req }) {
  const campaignId = String(req.campaignId || 'campaign-discount-free').trim();
  const campaign = getCampaign(campaignId, { includeDisabled: true });
  if (!campaign || !isSequenceCampaign(campaign)) {
    return json(400, { error: '連続配信のキャンペーンを指定してください', sideEffects: 'none' });
  }
  const fromEmail = getBrandConfig(BRAND).defaultFromEmail;
  const offset = String(req.offset || '').trim() || undefined;
  const dryRun = req.apply !== true;

  // 1) Customers を 1 ページ読む（**取り込み由来だけ**を名指しで絞る）
  let page;
  try {
    page = await fetchCustomersPage({
      KEY, BASE, offset, pageSize: INTAKE_PAGE_SIZE,
      filterByFormula: `LEFT({Source}, ${IMPORT_SOURCE_PREFIX.length}) = '${IMPORT_SOURCE_PREFIX}'`,
    });
  } catch (e) {
    return json(500, { error: 'Customers を読めませんでした', detail: String((e && e.message) || ''), sideEffects: 'none' });
  }

  const records = page.records;
  const emails = records.map((r) => String((r.fields || {}).Email || '').trim().toLowerCase()).filter(Boolean);

  // 2) その人たちの配信履歴（**名指し**。台帳全体は読まない）
  let deliveries;
  try {
    deliveries = await fetchDeliveriesByEmails({ KEY, BASE, emails });
  } catch (e) {
    return json(500, {
      error: '配信履歴を取り切れなかったため中止します（数えられない数で移行しません）',
      detail: String((e && e.message) || ''), sideEffects: 'none',
    });
  }

  // 3) 反応の集計（**読めなければ 1 件も作らない**）
  const signals = await loadEngagementSignals();
  const engagementApplied = signals.available === true;
  const openHashes = engagementApplied && signals.openByHash instanceof Map
    ? new Set(signals.openByHash.keys()) : null;
  const clickHashes = engagementApplied && signals.clickByHash instanceof Map
    ? new Set(signals.clickByHash.keys()) : null;
  const engagedEmails = new Set();
  if (engagementApplied) {
    for (const e of emails) {
      const h = hashEmailForSignal(e);
      if (openHashes.has(h) || clickHashes.has(h)) engagedEmails.add(e);
    }
  }

  // 4) 投入計画（判定も引き継ぎも純粋モジュール）
  //    ⚠️ 台帳へ引き継ぐのは **この campaign の鍵だけ**（別 campaign の鍵を混ぜない）
  const campaignKeys = new Set();
  for (const e of emails) {
    for (const [, k] of prospectStepKeys({ campaign, email: e, brand: BRAND, fromEmail })) {
      campaignKeys.add(k);
    }
  }
  const plan = planProspectIntakeFromCustomers({
    records, deliveries, campaignKeys,
    openHashes, clickHashes, hashEmail: emailHash, signalHash: hashEmailForSignal,
    engagedEmails: engagementApplied ? engagedEmails : undefined,
    nowMs: now,
  });

  // 5) **このページだけの parity**（移す前に、移しても同じ答えになることを確かめる）
  const parity = computePageParity({
    campaign, records, deliveries, plan, brand: BRAND, fromEmail, nowMs: now,
  });

  const writeEnabled = String(process.env[PROSPECT_INTAKE_ENV] || '').trim() === 'true';
  const gate = canIntake({
    writeEnabled, confirmed: String(req.confirm || '') === INTAKE_CONFIRM,
    engagementApplied, parityOk: parity.ok, plan,
  });

  const view = {
    mode: dryRun ? 'prospect-intake-dry-run' : 'prospect-intake',
    campaignId, page: { size: records.length, nextOffset: page.offset || null },
    counts: plan.counts, skipped: plan.skipped,
    engagement: {
      applied: engagementApplied, reason: signals.reason || null,
      matched: engagedEmails.size,
    },
    parity: { ok: parity.ok, diff: parity.diff, reason: parity.reason || null },
    gate: { allowed: gate.allowed, reasons: gate.reasons, labels: gate.labels, env: PROSPECT_INTAKE_ENV },
  };

  if (dryRun || !gate.allowed) {
    return json(200, {
      ...view, sideEffects: 'none',
      notice: dryRun
        ? 'これは下見です。**1 バイトも書いていません**。'
        : '安全条件を満たさないため**書き込みませんでした**。',
    });
  }

  // 6) 書き込み（**Customers は 1 件も触らない**）
  let store; let ledger;
  try {
    // ⚠️ 1 件ずつ書くと 1 ページで 600 往復になり **Function の実行時間を超える**
    //    （2026-08-27 に本番で 504）。pipeline を渡してまとめ書きにする。
    store = createProspectStore({
      cmd: makeRedisCmd(process.env), pipeline: makeRedisPipeline(process.env),
    });
    ledger = createDeliveryKeyStore({
      redisCmd: makeRedisCmd(process.env), redisPipeline: makeRedisPipeline(process.env),
    });
  } catch {
    return json(500, { ...view, error: 'Redis へ接続できません', sideEffects: 'none' });
  }

  let added = 0; let existed = 0; let blocked = 0; let failed = 0; let unverified = 0;
  try {
    const r = await store.addManyIfAbsent(plan.prospects);
    added = r.added; existed = r.existed; blocked = r.blocked; unverified = r.unverified;
  } catch (e) {
    // ⚠️ 途中まで書けている可能性がある。**成功と言わない**（再実行は冪等）
    return json(500, {
      ...view, sideEffects: 'partial_unconfirmed',
      error: 'prospect の投入を確定できませんでした（再実行してください。既存分は上書きされません）',
      detail: String((e && e.message) || '').slice(0, 120),
    });
  }
  if (unverified > 0) failed = unverified;

  // 7) 既送信の鍵を台帳へ（**読み戻して確かめる**）
  const scope = { brand: BRAND, campaignId: campaign.campaignId, version: campaign.version };
  let ledgerAdded = 0; let ledgerMissing = null;
  if (plan.ledgerKeys.length > 0) {
    try {
      const res = await ledger.markDelivered({ ...scope, keys: plan.ledgerKeys });
      ledgerAdded = res.added;
      const have = new Set(await ledger.filterDelivered({ ...scope, keys: plan.ledgerKeys }));
      ledgerMissing = plan.ledgerKeys.filter((k) => !have.has(k)).length;
    } catch {
      ledgerMissing = plan.ledgerKeys.length;
    }
  } else {
    ledgerMissing = 0;
  }

  return json(200, {
    ...view,
    sideEffects: 'redis_written',
    written: { added, existed, blocked, failed, unverified },
    ledger: { keys: plan.ledgerKeys.length, added: ledgerAdded, unverified: ledgerMissing },
    customersDeleted: 0,
    notice: 'prospect プールへ投入しました。**Customers は 1 件も削除していません**（削除は別承認）。',
  });
}

/**
 * 1 ページぶんの parity。**移す前に、移しても同じ答えになることを確かめる**。
 * 差分が 1 つでもあれば書かない。
 */
function computePageParity({ campaign, records, deliveries, plan, brand, fromEmail, nowMs }) {
  const targets = new Set(plan.prospects.map((p) => p.email));
  if (targets.size === 0) return { ok: false, reason: 'no_targets', diff: null };

  const customerRows = records
    .filter((r) => targets.has(String((r.fields || {}).Email || '').trim().toLowerCase()))
    .map((r) => ({
      recordId: r.id, fields: r.fields || {},
      marketing: resolveCustomerMarketing({ fields: r.fields || {}, nowMs }),
    }));
  const pageDeliveries = deliveries.filter(
    (d) => targets.has(String(((d && d.fields) || {}).RecipientEmail || '').trim().toLowerCase()),
  );

  const A = buildSequenceProgress({
    campaign, selected: customerRows, deliveries: pageDeliveries,
    brand, fromEmail, nowMs, providerSuppressed: new Set(), softBounced: new Set(),
  });
  const ledgerKeys = new Set(plan.ledgerKeys);
  const h = hydrateProspectSequenceInputs({
    prospects: plan.prospects, campaign, brand, fromEmail, deliveredKeys: ledgerKeys,
  });
  if (!h.ok) return { ok: false, reason: h.reason, diff: null };
  const rows = buildProspectSequenceRows({ prospects: plan.prospects, nowMs });
  const B = buildSequenceProgress({
    campaign, selected: rows.rows, deliveries: h.deliveries,
    brand, fromEmail, nowMs, providerSuppressed: h.providerSuppressed, softBounced: new Set(),
  });

  const keyOf = (progress) => {
    const m = new Map();
    for (const r of progress.rows) {
      if (!r.email || !Number.isInteger(r.nextStep)) continue;
      const eff = resolveSequenceStep(campaign, r.nextStep);
      if (!eff) continue;
      m.set(r.email, computeCampaignDeliveryKey({
        campaign: eff, recipientEmail: r.email, brand, fromEmail,
      }));
    }
    return m;
  };
  const deliveredA = new Map();
  for (const r of customerRows) {
    const e = String((r.fields || {}).Email || '').trim().toLowerCase();
    deliveredA.set(e, pageDeliveries.filter((d) => {
      const f = (d && d.fields) || {};
      return String(f.RecipientEmail || '').trim().toLowerCase() === e
        && String(f.Status || '').trim().toLowerCase() === 'sent';
    }).length);
  }
  const deliveredB = new Map(plan.prospects.map((p) => [p.email, p.delivered]));

  const result = compareSequenceParity({
    customers: A, prospects: B, customerKeys: keyOf(A), prospectKeys: keyOf(B),
    customerDelivered: deliveredA, prospectDelivered: deliveredB,
  });
  return { ok: result.ok, diff: result.diff, reason: result.unusable };
}

/**
 * 移行後の検証（read-only・**1 バイトも書かない**）。
 *
 * **実際の Redis**（prospect プール ＋ 配信台帳）だけを読み、
 * 「移した相手が、いつ、どの step の対象になるか」を出す。
 * 投入計画の写しではなく**入った状態そのもの**を見るので、
 * 「入ったつもり」を検出できる。
 *
 * `at`（ISO 文字列）を渡すと、その時刻での対象も返す（8/31 の 2 通目の確認用）。
 *
 * ⚠️ アドレスも recordId も返さない（件数と内訳だけ）。
 * ⚠️ 索引・台帳を読めなければ `ok:false`（0 件と混同しない）。
 */
/**
 * 投入したはずの hash が**索引に居るか**を突き合わせる（**読み取りのみ**）。
 *
 * ⚠️ `prospectSequenceCheck` は索引に居る人しか見ないので、
 *    **索引から丸ごと欠けている人を検出できない**。ここがその穴を埋める。
 *
 * ⚠️ 入出力は **hash だけ**。生アドレスは受け取らないし返さない。
 * ⚠️ 書き込みは一切しない（読むのは SMEMBERS ×3 と GET のみ）。
 */
/** 索引の修復を許す確認文字列（画面から流し込めない値にしておく） */
const INDEX_REPAIR_CONFIRM = 'REPAIR PROSPECT INDEX';
/** 1 回で直せる上限（**取り違えの被害を構造的に小さくする**）*/
const INDEX_REPAIR_MAX = 10;

/**
 * 名指しした hash の**索引だけ**を、保存済みレコードの state に合わせて直す。
 *
 * ## できることが構造的に限られている
 *
 *   - 触るのは `ACTIVE_INDEX` / `ENGAGED_INDEX` の**所属だけ**。レコードは書かない
 *   - **保存済みレコードが無い hash には何もしない**（居ない人を作れない）
 *   - **抑止台帳に載っている相手には何もしない**（復活させられない）
 *   - あるべき所属と違うときだけ 1 コマンド出す（既に正しければ**0 コマンド**）
 *   - 1 回 10 件まで（`INDEX_REPAIR_MAX`）
 *   - 送信も queue も Airtable も**一切触らない**
 *
 * ⚠️ 既定は**下見**。`apply: true` ＋ 確認文字列が揃ったときだけ書く。
 */
/** 復元を許す確認文字列 */
const RESTORE_CONFIRM = 'RESTORE CUSTOMERS FROM EXPORT';

/**
 * 控え（export）から Customers を作り直す（**rollback 専用**）。
 *
 * ⚠️ **同じアドレスの行が既に在れば作らない**（二重作成しない・冪等）。
 * ⚠️ recordId は Airtable が新しく振る（元の id には戻せない）。
 *    prospect 側は hash（アドレス由来）で紐づくので、配信の継続性には影響しない。
 */
async function handleCustomerDeletionRestore({ KEY, BASE, req }) {
  const rawRows = (Array.isArray(req.records) ? req.records : [])
    .map((r) => ({ fields: (r && r.fields) || {} }))
    .filter((r) => String(r.fields.Email || '').trim());

  // ⚠️ **本番 schema から「作成時に書ける field」を取り直す。**
  //    控えは監査用に全フィールドを持っているので、そのまま POST すると
  //    `登録日`（createdTime）などで**復元そのものが失敗する**。
  let schema;
  try {
    schema = classifyFields(await fetchCustomersFieldSchema({ KEY, BASE }));
  } catch (e) {
    return json(503, {
      error: 'Customers の schema を取れませんでした（**作らずに中止**）',
      detail: String((e && e.message) || '').slice(0, 120), sideEffects: 'none',
    });
  }
  if (schema.writable.size === 0) {
    return json(503, { error: 'schema が空（**作らずに中止**）', sideEffects: 'none' });
  }

  const droppedByField = {};
  const rows = rawRows.map((r) => {
    const { fields, dropped } = buildRestoreFields(r.fields, schema.writable);
    for (const d of dropped) droppedByField[d] = (droppedByField[d] || 0) + 1;
    return { fields };
  });

  // 送る直前の検算（計算 field・知らない field が 1 つでも混ざっていたら送らない）
  const valid = validateRestorePayload({ records: rows, ...schema });
  if (!valid.ok) {
    return json(400, {
      error: '復元 payload が schema に合いません（**作らずに中止**）',
      reasons: valid.reasons.slice(0, 20), sideEffects: 'none',
    });
  }
  if (rows.length === 0) {
    return json(400, { error: 'records（fields.Email 必須）を渡してください', sideEffects: 'none' });
  }
  if (rows.length > DELETE_MAX_PER_CALL) {
    return json(400, {
      error: `一度に復元できるのは ${DELETE_MAX_PER_CALL} 件までです`, sideEffects: 'none',
    });
  }
  const confirmed = String(req.confirm || '') === RESTORE_CONFIRM;
  const apply = req.apply === true && confirmed;

  // 既に在るアドレスは作らない
  const emails = rows.map((r) => String(r.fields.Email).trim().toLowerCase());
  let existing = new Set();
  try {
    const found = await fetchCustomersByEmails({ KEY, BASE, emails });
    existing = new Set(found.map((e) => e.toLowerCase()));
  } catch (e) {
    return json(500, {
      error: '既存 Customers を確認できませんでした（**作らずに中止**）',
      detail: String((e && e.message) || '').slice(0, 120), sideEffects: 'none',
    });
  }
  const toCreate = rows.filter((r) => !existing.has(String(r.fields.Email).trim().toLowerCase()));

  const view = {
    mode: apply ? 'customer-restore' : 'customer-restore-dry-run',
    requested: rows.length, alreadyPresent: rows.length - toCreate.length,
    toCreate: toCreate.length, confirmed,
    /** 書けないので落とした field（監査用の控えには残っている）*/
    droppedFields: droppedByField,
    schema: {
      writable: schema.writable.size, computed: schema.computed.size,
      links: schema.links.size, unknown: [...schema.unknown],
    },
    payloadValid: valid.ok,
  };
  if (!apply) {
    return json(200, {
      ...view, created: 0, sideEffects: 'none',
      notice: 'これは下見です。**1 件も作っていません**（apply と確認文字列が要ります）。',
    });
  }

  let created = 0; const failed = [];
  for (let i = 0; i < toCreate.length; i += 10) {
    const chunk = toCreate.slice(i, i + 10);
    try {
      const url = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}`;
      // eslint-disable-next-line no-await-in-loop -- 10 件ずつ（Airtable の上限）
      const res = await fetch(url, {
        method: 'POST',
        headers: { ...authHeaders(KEY), 'Content-Type': 'application/json' },
        body: JSON.stringify({ records: chunk, typecast: true }),
      });
      if (!res.ok) throw new Error(`restore_${res.status}`);
      // eslint-disable-next-line no-await-in-loop
      const j = await res.json();
      created += (j.records || []).length;
    } catch (e) {
      failed.push(String((e && e.message) || '').slice(0, 80));
    }
  }
  return json(200, {
    ...view, created, failed: failed.length,
    sideEffects: created > 0 ? 'customers_created' : 'none',
    notice: 'recordId は新しく振られます（prospect は hash で紐づくため配信に影響しません）。',
  });
}

/**
 * 本番 Customers の field schema を取る（**読み取りのみ**）。
 *
 * ⚠️ 型を推測しない。**Meta API の実際の型**で書ける / 書けないを決める。
 */
async function fetchCustomersFieldSchema({ KEY, BASE }) {
  const url = `https://api.airtable.com/v0/meta/bases/${BASE}/tables`;
  const res = await fetch(url, { headers: authHeaders(KEY) });
  if (!res.ok) throw new Error(`schema_${res.status}`);
  const j = await res.json();
  const t = (j.tables || []).find((x) => x.name === CUSTOMERS_TABLE);
  if (!t) throw new Error('customers_table_not_found');
  return t.fields || [];
}

/** アドレスで既存 Customers を引く（復元の二重作成防止）*/
async function fetchCustomersByEmails({ KEY, BASE, emails }) {
  const list = [...new Set((emails || []).map((e) => String(e || '').trim().toLowerCase()))]
    .filter(Boolean);
  const out = [];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const formula = `OR(${chunk.map((e) => `LOWER({Email})='${e.replace(/'/g, "\\'")}'`).join(',')})`;
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}`);
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('filterByFormula', formula);
    url.searchParams.set('fields[]', 'Email');
    // eslint-disable-next-line no-await-in-loop -- 50 件ずつ
    const res = await fetch(url, { headers: authHeaders(KEY) });
    if (!res.ok) throw new Error(`customers_by_email_${res.status}`);
    // eslint-disable-next-line no-await-in-loop
    const j = await res.json();
    for (const r of j.records || []) out.push(String((r.fields || {}).Email || ''));
  }
  return out;
}

/** 1 回で見る Customers の件数（Redis 突き合わせが 2 往復で収まる大きさ）*/
const DELETION_PAGE_SIZE = 100;

/**
 * 削除計画の材料を 1 ページぶん集める（**読み取りのみ**）。
 * `plan` と `apply` の両方がこれを使うので、**判定が 2 通りに割れない**。
 */
async function buildDeletionPageInputs({ KEY, BASE, offset, ids }) {
  const page = ids && ids.length > 0
    ? await fetchCustomersByIds({ KEY, BASE, ids })
    : await fetchCustomersPage({
      KEY, BASE, offset, pageSize: DELETION_PAGE_SIZE,
      filterByFormula: `LEFT({Source}, ${IMPORT_SOURCE_PREFIX.length}) = '${IMPORT_SOURCE_PREFIX}'`,
    });
  const records = page.records;
  const emails = records
    .map((r) => String((r.fields || {}).Email || '').trim().toLowerCase()).filter(Boolean);

  // 開封（**読めなければ後段で中止**）
  const signals = await loadEngagementSignals();
  const engagementApplied = signals.available === true;
  const openHashes = engagementApplied && signals.openByHash instanceof Map
    ? new Set(signals.openByHash.keys()) : null;
  const clickHashes = engagementApplied && signals.clickByHash instanceof Map
    ? new Set(signals.clickByHash.keys()) : null;
  const engagedEmails = new Set();
  if (engagementApplied) {
    for (const e of emails) {
      const h = hashEmailForSignal(e);
      if (openHashes.has(h) || clickHashes.has(h)) engagedEmails.add(e);
    }
  }

  // prospect プールと索引（**読めなければ null のまま渡して中止させる**）
  let prospectByHash = null; let activeByHash = null;
  try {
    const store = createProspectStore({
      cmd: makeRedisCmd(process.env), pipeline: makeRedisPipeline(process.env),
    });
    const hashes = emails.map((e) => emailHash(e));
    const loaded = await store.loadMany(hashes);
    prospectByHash = new Map(loaded.map((p) => [p.hash, p]));
    activeByHash = await store.activeMembership(hashes);
  } catch {
    prospectByHash = null; activeByHash = null;
  }

  return {
    page, records, engagementApplied, engagedEmails, prospectByHash, activeByHash,
  };
}

/**
 * 消してよい Customers を数える（**読み取りのみ**）。
 *
 * ⚠️ 応答に **`export` を含めるとアドレスが入る**（控えを取るために必要）。
 *    端末のファイルへ保存する用途のみ。ログや画面へ出さないこと。
 */
async function handleCustomerDeletionPlan({ KEY, BASE, req }) {
  const offset = String(req.offset || '').trim() || undefined;
  const withExport = req.withExport === true;
  let inputs;
  try {
    inputs = await buildDeletionPageInputs({ KEY, BASE, offset });
  } catch (e) {
    return json(500, {
      error: 'Customers を読めませんでした',
      detail: String((e && e.message) || '').slice(0, 120), sideEffects: 'none',
    });
  }
  const plan = planCustomerDeletion({
    records: inputs.records,
    engagedEmails: inputs.engagedEmails,
    engagementApplied: inputs.engagementApplied,
    prospectByHash: inputs.prospectByHash,
    activeByHash: inputs.activeByHash,
    hashOf: emailHash,
  });

  const byId = new Map(inputs.records.map((r) => [r.id, r]));
  return json(200, {
    mode: 'customer-deletion-plan',
    sideEffects: 'none',
    page: { size: inputs.records.length, nextOffset: inputs.page.offset || null },
    ok: plan.ok,
    abort: plan.abort,
    checked: plan.checked,
    deletable: plan.deletableIds.length,
    deletableIds: plan.deletableIds,
    blocked: plan.blocked,
    decisions: plan.decisions,
    /** ⚠️ アドレスを含む。**控えの保存だけ**に使うこと */
    export: withExport
      ? plan.deletableIds.map((id) => ({ id, fields: (byId.get(id) || {}).fields || {} }))
      : undefined,
    notice: 'これは読み取りのみです。**1 件も消していません**。',
  });
}

/**
 * 名指しした Customers を消す。**既定は下見**。
 *
 * ⚠️ 渡された id を**そのまま消さない**。サーバ側で計画を作り直し、
 *    いまも「消してよい」と判定された id だけを消す（`reconcileDeletionTargets`）。
 * ⚠️ 既に消えている id は **already_deleted**（2 回実行しても安全）。
 * ⚠️ 控え（export）を取ったという申告が無ければ実行しない。
 */
async function handleCustomerDeletionApply({ KEY, BASE, req }) {
  const ids = [...new Set((Array.isArray(req.recordIds) ? req.recordIds : [])
    .map((x) => String(x || '').trim()).filter(Boolean))];
  const confirmed = String(req.confirm || '') === DELETE_CONFIRM;
  const gate = canDeleteCustomers({
    confirmed, ids, exportProven: req.exportSaved === true,
  });
  const apply = req.apply === true && gate.allowed;
  const dryRun = !apply;

  if (ids.length === 0) {
    return json(400, { error: 'recordIds を渡してください', sideEffects: 'none' });
  }
  if (ids.length > DELETE_MAX_PER_CALL) {
    return json(400, {
      error: `一度に消せるのは ${DELETE_MAX_PER_CALL} 件までです`, sideEffects: 'none',
    });
  }

  let inputs;
  try {
    inputs = await buildDeletionPageInputs({ KEY, BASE, ids });
  } catch (e) {
    return json(500, {
      error: 'Customers を読めませんでした',
      detail: String((e && e.message) || '').slice(0, 120), sideEffects: 'none',
    });
  }
  const plan = planCustomerDeletion({
    records: inputs.records,
    engagedEmails: inputs.engagedEmails,
    engagementApplied: inputs.engagementApplied,
    prospectByHash: inputs.prospectByHash,
    activeByHash: inputs.activeByHash,
    hashOf: emailHash,
  });
  const targets = reconcileDeletionTargets({
    requestedIds: ids,
    deletableIds: plan.ok ? plan.deletableIds : [],
    presentIds: inputs.records.map((r) => r.id),
  });

  const view = {
    mode: dryRun ? 'customer-deletion-dry-run' : 'customer-deletion',
    requested: ids.length,
    planOk: plan.ok,
    abort: plan.abort,
    toDelete: targets.toDelete.length,
    alreadyDeleted: targets.alreadyDeleted.length,
    refused: targets.refused.length,
    refusedIds: targets.refused.slice(0, 50),
    blocked: plan.blocked,
    decisions: plan.decisions,
    gate: { allowed: gate.allowed, reasons: gate.reasons },
  };

  if (dryRun) {
    return json(200, {
      ...view, deleted: 0, sideEffects: 'none',
      notice: 'これは下見です。**1 件も消していません**（apply / 確認文字列 / 控えの申告が要ります）。',
    });
  }
  if (!plan.ok) {
    return json(409, {
      ...view, deleted: 0, sideEffects: 'none',
      error: '判定の材料が読めないため中止しました', reason: plan.abort,
    });
  }

  let deleted = 0; const failed = [];
  for (const id of targets.toDelete) {
    try {
      // eslint-disable-next-line no-await-in-loop -- 件数は上限つき（最大 200）
      await deleteCustomerRecord({ KEY, BASE, id });
      deleted += 1;
    } catch (e) {
      failed.push({ id, detail: String((e && e.message) || '').slice(0, 80) });
    }
  }

  return json(200, {
    ...view,
    deleted,
    failed: failed.length,
    failedIds: failed.slice(0, 20),
    sideEffects: deleted > 0 ? 'customers_deleted' : 'none',
    notice: '控えから復元できます（Redis / prospect は触っていません）。',
  });
}

async function handleProspectIndexRepair({ req }) {
  const hashes = normalizeHashes(req.hashes);
  if (hashes.length === 0) {
    return json(400, { error: 'hashes（64 桁 hex）を渡してください', sideEffects: 'none' });
  }
  if (hashes.length > INDEX_REPAIR_MAX) {
    return json(400, {
      error: `一度に直せるのは ${INDEX_REPAIR_MAX} 件までです`, sideEffects: 'none',
    });
  }
  const confirmed = String(req.confirm || '') === INDEX_REPAIR_CONFIRM;
  const apply = req.apply === true && confirmed;
  const dryRun = !apply;

  let store;
  try {
    store = createProspectStore({
      cmd: makeRedisCmd(process.env), pipeline: makeRedisPipeline(process.env),
    });
  } catch {
    return json(503, { error: 'Redis へ接続できません', sideEffects: 'none' });
  }

  let res;
  try {
    res = await store.reindexByHash(hashes, { apply });
  } catch (e) {
    return json(500, {
      error: '索引を直せませんでした',
      detail: String((e && e.message) || '').slice(0, 120),
      sideEffects: apply ? 'partial_unconfirmed' : 'none',
    });
  }

  // 直したあと（または下見）の所在を返す。アドレスは含めない
  const details = res.planned.map((p) => ({
    hash: p.hash, state: p.state, wasActive: p.isActive, changes: p.changes,
  }));

  return json(200, {
    mode: dryRun ? 'prospect-index-repair-dry-run' : 'prospect-index-repair',
    sideEffects: apply ? 'redis_written' : 'none',
    confirmed,
    checked: res.checked,
    planned: details,
    /** 実際に変わった件数（下見なら常に 0）*/
    applied: res.applied,
    skipped: res.skipped,
    customersDeleted: 0,
    notice: dryRun
      ? 'これは下見です。**1 バイトも書いていません**（apply と確認文字列が要ります）。'
      : '索引の所属だけを直しました。**レコード・Customers・送信は一切触っていません**。',
  });
}

async function handleProspectIndexAudit({ req }) {
  const expected = normalizeHashes(req.hashes);
  if (expected.length === 0) {
    return json(400, { error: 'hashes（64 桁 hex）を渡してください', sideEffects: 'none' });
  }
  if (expected.length > 20000) {
    return json(400, { error: 'hashes が多すぎます（20,000 まで）', sideEffects: 'none' });
  }

  let store;
  try {
    store = createProspectStore({
      cmd: makeRedisCmd(process.env), pipeline: makeRedisPipeline(process.env),
    });
  } catch {
    return json(503, { error: 'Redis へ接続できません', sideEffects: 'none' });
  }

  // ⚠️ 索引を読めなければ中止する（「居ない」と混同しない）
  let active; let engaged; let blocked;
  try {
    active = await store.activeHashes();
    engaged = await store.engagedHashes();
    blocked = await store.blockedHashes();
  } catch {
    return json(500, { error: '索引を読めませんでした', reason: 'index_unavailable', sideEffects: 'none' });
  }

  const audit = auditProspectIndex({ expected, active, engaged, blocked });

  // 送信候補でない hash のレコードを読む（**上限つき**・アドレスは返さない）
  const detailFor = audit.notActive.slice(0, Math.min(200, audit.notActive.length));
  const details = [];
  for (const hash of detailFor) {
    let rec = null;
    try {
      // eslint-disable-next-line no-await-in-loop -- 件数は上限つき（通常 0〜数件）
      rec = await store.loadByHash(hash);
    } catch {
      rec = null;
    }
    let blockedInfo = null;
    if (audit.placeByHash.get(hash) === 'blocked') {
      try {
        // eslint-disable-next-line no-await-in-loop -- 同上
        const b = await store.loadBlocked(hash);
        blockedInfo = b ? { kind: b.kind, reason: b.reason, at: b.at } : null;
      } catch { blockedInfo = null; }
    }
    details.push({
      hash,
      place: audit.placeByHash.get(hash),
      hasRecord: rec !== null && rec !== undefined,
      record: safeRecordView(rec),
      blocked: blockedInfo,
    });
  }

  return json(200, {
    mode: 'prospect-index-audit',
    sideEffects: 'none',
    checked: audit.checked,
    counts: audit.counts,
    indexSizes: audit.indexSizes,
    /** ⚠️ どの索引にも居ない = Customers を消すと復元手段が無くなる */
    nowhereCount: audit.nowhere.length,
    notActiveCount: audit.notActive.length,
    /** 索引に居るが期待一覧に無い hash（逆向きのズレ）*/
    unexpectedActiveCount: audit.unexpectedActive.length,
    unexpectedActive: audit.unexpectedActive.slice(0, 50),
    details,
    truncated: audit.notActive.length > detailFor.length,
    notice: 'これは読み取りのみです（Redis の実状態）。アドレスは含みません。',
  });
}

async function handleProspectSequenceCheck({ now, req }) {
  const campaignId = String(req.campaignId || 'campaign-discount-free').trim();
  const campaign = getCampaign(campaignId, { includeDisabled: true });
  if (!campaign || !isSequenceCampaign(campaign)) {
    return json(400, { error: '連続配信のキャンペーンを指定してください', sideEffects: 'none' });
  }
  const fromEmail = getBrandConfig(BRAND).defaultFromEmail;

  let store; let ledger;
  try {
    store = createProspectStore({
      cmd: makeRedisCmd(process.env), pipeline: makeRedisPipeline(process.env),
    });
    ledger = createDeliveryKeyStore({
      redisCmd: makeRedisCmd(process.env), redisPipeline: makeRedisPipeline(process.env),
    });
  } catch {
    return json(503, { error: 'Redis へ接続できません', sideEffects: 'none' });
  }

  // ⚠️ 1 万件超を 1 回で見ると **Function の実行時間を超える**（2026-08-27 に本番で 504。
  //    MGET 24 回 + SMISMEMBER 180 回 + 進行の再計算で 30 秒を超えた）。
  //    索引の窓（`offset` / `limit`）で分割して呼ぶ。応答の `nextOffset` で続きから。
  const limit = Math.min(4000, Math.max(1, Number(req.limit) || 2000));
  const from = Math.max(0, Number(req.offset) || 0);
  // ⚠️ 2 窓目以降は **1 窓目の `digest` を必ず渡す**。索引が途中で変わっていたら
  //    窓がずれて重複・読み落としが起きるので、その場合は最初からやり直す。
  const expectDigest = String(req.digest || '').trim() || undefined;
  const inputs = await loadProspectSequenceInputs({
    store, deliveryKeyStore: ledger, campaign, brand: BRAND, fromEmail, nowMs: now,
    maxRecipients: limit, offset: from, expectDigest,
  });
  if (!inputs.ok) {
    const changed = inputs.reason === AUDIENCE_FAIL.INDEX_CHANGED;
    return json(changed ? 409 : 500, {
      error: changed
        ? '読んでいる間に prospect の集合が変わりました。**最初からやり直してください**（窓がずれて重複・読み落としになります）'
        : 'prospect を読み切れませんでした',
      reason: inputs.reason,
      digest: inputs.digest || null,
      indexSize: inputs.indexSize ?? null,
      sideEffects: 'none',
    });
  }

  // ⚠️ 復元は **1 回だけ**。時刻ごとに作り直すと同じ入力を 2 回組み立てることになり、
  //    そこだけで実行時間を使い切る。進行の導出だけを時刻違いで 2 回まわす。
  const rowsOnce = buildProspectSequenceRows({ prospects: inputs.prospects, nowMs: now });
  const runAt = (nowMs) => {
    const progress = buildSequenceProgress({
      campaign, selected: rowsOnce.rows, deliveries: inputs.deliveries,
      brand: BRAND, fromEmail, nowMs,
      providerSuppressed: inputs.providerSuppressed, softBounced: new Set(),
      engagementByEmail: inputs.engagementByEmail,
    });
    return progress.ok ? progress.summary : null;
  };

  const atMs = Date.parse(String(req.at || '')) || null;
  // 引き継いだ delivered の分布（打ち切り判定の分母が正しく入っているか）
  const deliveredHist = {};
  let deliveredMax = 0; let opensTotal = 0;
  for (const p of inputs.prospects) {
    const d = Number(p.delivered) || 0;
    deliveredHist[d] = (deliveredHist[d] || 0) + 1;
    if (d > deliveredMax) deliveredMax = d;
    if (Number(p.opens) > 0) opensTotal += 1;
  }
  const counts = await store.counts();

  return json(200, {
    mode: 'prospect-sequence-check',
    sideEffects: 'none',
    campaignId,
    /** 索引のどこを見たか（`nextOffset` が null なら読み切り） */
    window: {
      offset: from,
      limit,
      indexSize: inputs.indexSize,
      returned: inputs.prospects.length,
      /** この窓で**索引を消費した件数**（最終判定の合算に使う）*/
      scanned: inputs.scanned,
      /**
       * 索引にはあるが値を読めなかった件数（窓は消費済みとして進める）。
       * ⚠️ **走査は止めないが、最終判定は合計が 0 のときしか通さない**
       *    （`prospectVerification.js`）。何通目まで送ったか確かめられていない相手の
       *    Customers 行を消すと、進行の復元手段が消える。
       */
      missing: inputs.missing ?? 0,
      /** ⚠️ 次の窓では**この digest を必ず渡す**（変わっていたらやり直し） */
      digest: inputs.digest,
      /**
       * ⚠️ 次の窓は **`scanned`（索引を消費した件数）**だけ進める。
       *    `prospects.length`（読めた件数）で進めると、値を読めなかった hash の分だけ
       *    窓が巻き戻って**同じ人を 2 回読む**。1 窓まるごと読めない場合は
       *    `nextOffset === from` となり**永久に進まない**。
       */
      nextOffset: from + inputs.scanned < inputs.indexSize ? from + inputs.scanned : null,
    },
    pool: counts,
    loaded: inputs.counts,
    ledger: { restoredDeliveries: inputs.deliveries.length },
    delivered: { max: deliveredMax, histogram: deliveredHist, withOpens: opensTotal },
    now: runAt(now),
    at: atMs ? { at: new Date(atMs).toISOString(), summary: runAt(atMs) } : null,
    notice: 'これは読み取りのみです（Redis の実状態）。',
  });
}

/** その campaign の step 別 DeliveryKey（鍵の作り方は `campaignSend.js` が唯一の生成元） */
function prospectStepKeys({ campaign, email, brand, fromEmail }) {
  const m = new Map();
  for (const st of getSequenceSteps(campaign)) {
    const eff = resolveSequenceStep(campaign, st.stepNumber);
    if (!eff) continue;
    const k = computeCampaignDeliveryKey({ campaign: eff, recipientEmail: email, brand, fromEmail });
    if (k) m.set(st.stepNumber, k);
  }
  return m;
}

/** Customers を 1 ページだけ読む（**全件走査しない**。offset で続きから） */
/**
 * recordId を**名指し**で引く（削除の直前に、いまの中身を取り直すため）。
 *
 * ⚠️ 見つからない id は**黙って落ちる**。呼び出し側はそれを
 *    「もう消えている」と解釈する（`reconcileDeletionTargets`）。
 */
async function fetchCustomersByIds({ KEY, BASE, ids }) {
  const list = [...new Set((ids || []).map(String))].filter(Boolean);
  const out = [];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const formula = `OR(${chunk.map((id) => `RECORD_ID()='${id}'`).join(',')})`;
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}`);
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('filterByFormula', formula);
    // eslint-disable-next-line no-await-in-loop -- 50 件ずつ（最大 4 回）
    const res = await fetch(url, { headers: authHeaders(KEY) });
    if (!res.ok) throw new Error(`customers_by_ids_${res.status}`);
    // eslint-disable-next-line no-await-in-loop
    const j = await res.json();
    for (const r of j.records || []) out.push({ id: r.id, fields: r.fields || {} });
  }
  return { records: out, offset: null };
}

/**
 * Customers を 1 件消す。
 *
 * ⚠️ **元に戻せない。** 呼ぶ前に控え（export）を取っていること。
 * ⚠️ 404 は「もう消えている」として成功扱いにする（2 回実行しても壊れない）。
 */
async function deleteCustomerRecord({ KEY, BASE, id }) {
  const url = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}/${id}`;
  const res = await fetch(url, { method: 'DELETE', headers: authHeaders(KEY) });
  if (res.status === 404) return { deleted: false, alreadyGone: true };
  if (!res.ok) throw new Error(`customer_delete_${res.status}`);
  return { deleted: true, alreadyGone: false };
}

async function fetchCustomersPage({ KEY, BASE, offset, pageSize, filterByFormula }) {
  const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}`);
  url.searchParams.set('pageSize', String(Math.min(100, pageSize || 100)));
  if (filterByFormula) url.searchParams.set('filterByFormula', filterByFormula);
  if (offset) url.searchParams.set('offset', offset);
  const res = await fetch(url, { headers: authHeaders(KEY) });
  if (!res.ok) throw new Error(`customers_page_${res.status}`);
  const j = await res.json();
  return { records: (j.records || []).map((r) => ({ id: r.id, fields: r.fields || {} })), offset: j.offset || null };
}

async function handleEngagementDigest({ now }) {
  const signals = await loadEngagementSignals();
  const openHashes = signals.openByHash instanceof Map ? [...signals.openByHash.keys()] : [];
  const clickHashes = signals.clickByHash instanceof Map ? [...signals.clickByHash.keys()] : [];
  const meta = signals.meta || {};
  return json(200, {
    mode: 'engagement-digest',
    sideEffects: 'none',
    available: signals.available === true,
    reason: signals.reason || null,
    algorithm: 'sha256(lowercase(email)).hex.slice(0,32)',
    counts: { open: openHashes.length, click: clickHashes.length },
    meta: {
      startedAt: meta.startedAtMs ? new Date(meta.startedAtMs).toISOString() : null,
      firstOpenAt: meta.firstOpenAtMs ? new Date(meta.firstOpenAtMs).toISOString() : null,
      lastEventAt: meta.lastEventAtMs ? new Date(meta.lastEventAtMs).toISOString() : null,
      readAt: new Date(now).toISOString(),
    },
    openHashes,
    clickHashes,
    notice: 'これは読み取りのみです。アドレスは含まれません（hash だけ）。',
  });
}

async function handleSeqMetrics({ req }) {
  const base = getCampaign(req.campaignId, { includeDisabled: true });
  if (!base) return json(400, { error: '未知のキャンペーンです', sideEffects: 'none' });
  if (!isSequenceCampaign(base)) {
    return json(400, { error: 'このキャンペーンは連続配信ではありません', sideEffects: 'none' });
  }
  const campaignType = `${base.campaignId}:v${base.version}`;

  let stored = null;
  try {
    stored = await createSequenceMetricsStore({ redisCmd: makeRedisCmd(process.env) }).read(campaignType);
  } catch { stored = null; }

  if (!stored) {
    return json(200, {
      mode: 'read-only', sideEffects: 'none',
      campaignId: base.campaignId, version: base.version,
      metrics: describeMetrics(emptyMetrics(), { complete: false, computedAtMs: null }),
      available: false,
      note: 'まだ集計がありません（自動配信が台帳を 1 周読むと出ます）。',
    });
  }

  // 確定版（1 周読み切ったもの）があればそれを出す。無ければ途中経過。
  const useFinal = Boolean(stored.final);
  const metrics = useFinal ? stored.final : (stored.running || emptyMetrics());
  return json(200, {
    mode: 'read-only', sideEffects: 'none',
    campaignId: base.campaignId, version: base.version,
    available: true,
    metrics: describeMetrics(metrics, {
      complete: useFinal,
      computedAtMs: useFinal ? stored.finalAtMs : stored.updatedAtMs,
    }),
    /** 台帳の走査が何周目か（進捗の目安） */
    pass: Number.isInteger(stored.pass) ? stored.pass : 0,
    updatedAt: Number.isFinite(Number(stored.updatedAtMs))
      ? new Date(Number(stored.updatedAtMs)).toISOString() : null,
  });
}

async function handleSequence({ KEY, BASE, now, req }) {
  const base = getCampaign(req.campaignId, { includeDisabled: true });
  if (!base) return json(400, { error: '未知のキャンペーンです', sideEffects: 'none' });
  if (!isSequenceCampaign(base)) {
    return json(400, { error: 'このキャンペーンは連続配信ではありません', sideEffects: 'none' });
  }

  // 🛡️ **受信対象だけ**を読む（全件走査しない）。Customers 15,962 件を先頭から読むと
  //    先頭 4,000 件で打ち切られ、付与した人が数人しか見えなくなる（2026-08-13 実測）。
  const audience = await loadCampaignAudience({ KEY, BASE, now, campaign: base });
  if (!audience.ok) {
    // 少ない人数のまま集計も dry-run も進めない
    return json(audience.code === 'audience_not_narrowable' ? 400 : 500, {
      error: audience.code === 'audience_not_narrowable'
        ? 'このキャンペーンは受信対象を絞り込めません（全件走査はしません）。宣言（requiresActiveGrant / requiresImportCohort）を追加してください。'
        : '受信対象の取得が上限に達しました。人数を確定できないため進行状況を返しません。',
      code: audience.code,
      pagesFetched: audience.pagesFetched ?? null,
      sideEffects: 'none',
    });
  }

  const { emails: blacklistEmails } = await loadBlacklistEmails({ brand: BRAND, baseId: BASE, apiKey: KEY });
  // 配信履歴は **受信対象の宛先だけ**を名指しで引く（台帳全体は読まない）。
  //
  // ⚠️ 旧実装は `{EmailType}='campaign'` の全件取得だった。「campaign で絞ってあるから
  //    全件走査ではない」という前提が崩れており、台帳が 4,000 行を超えた時点で
  //    `fetchAll` の 4,000 行打ち切りに掛かっていた（2026-08-15 実測）。
  //    その結果、Step1 を 10 名ぶん登録した直後に「送信済み 1 名 / 残り 9 名」と
  //    **過少表示**した。取得コストも対象人数に比例させる。
  const audienceEmails = audience.records
    .map((rec) => String((rec.fields || {}).Email || '').trim().toLowerCase())
    .filter(Boolean);
  let deliveries;
  try {
    deliveries = await fetchDeliveriesByEmails({ KEY, BASE, emails: audienceEmails });
  } catch (e) {
    // 数えられないなら**数を出さない**（部分集合を全体として表示しない）
    return json(500, {
      error: '配信履歴を取り切れなかったため、進行状況を返しません（数えられない数は出しません）。',
      code: 'deliveries_fetch_incomplete',
      detail: String((e && e.message) || 'unknown'),
      sideEffects: 'none',
    });
  }
  const history = summarizeHistory(deliveries);
  const list = audience.records.map((rec) => {
    const fields = rec.fields || {};
    const email = String(fields.Email || '').trim().toLowerCase();
    return {
      recordId: rec.id,
      record: rec,
      fields,
      marketing: resolveCustomerMarketing({
        fields, nowMs: now, blacklistEmails, history: history.get(email),
      }),
    };
  });

  // 除外の材料。**確認できないものは fail closed**（送らない側へ倒す）
  const provider = await fetchProviderSuppression({ apiKey: process.env.SENDGRID_API_KEY, now });
  const blacklist = await loadBlacklistSets({ KEY, BASE });
  const { view: engagementView } = await resolveEngagementView({ list, deliveries, now });

  const fromEmail = getBrandConfig(BRAND).defaultFromEmail;
  const progress = buildSequenceProgress({
    campaign: base, selected: list, deliveries,
    brand: BRAND, fromEmail, nowMs: now,
    providerSuppressed: provider.ok ? provider.emails : null,
    softBounced: blacklist.soft,
    engagementByEmail: engagementView.engagementByEmail,
    engagementThresholds: engagementView.thresholds,
  });
  if (!progress.ok) return json(400, { error: `進行を計算できません: ${progress.error}` });

  const next = selectNextDueStep(progress, { maxRecipients: MAX_RECIPIENTS_PER_SEND });
  const seq = describeSequence(base);
  const nextDueAt = progress.rows
    .filter((r) => r.status === 'waiting' && Number.isFinite(r.nextSendAtMs))
    .map((r) => r.nextSendAtMs)
    .sort((a, b) => a - b)[0] || null;

  return json(200, {
    mode: 'sequence-status',
    sideEffects: 'none',
    campaignId: base.campaignId,
    campaignName: base.name,
    version: base.version,
    enabled: base.enabled === true,
    /** 自動配信のゲート状態（env）。**開いていなければ自動では 1 通も出ない** */
    auto: readSequenceAutoState(process.env, now),
    maxSends: resolveMaxSends(base),
    sequence: seq,
    /** 次に流せるステップと人数（この人数がそのまま dry-run の対象になる） */
    next: {
      step: next.step,
      recipients: next.recordIds.length,
      truncated: next.truncated === true,
      cap: MAX_RECIPIENTS_PER_SEND,
      /** 送信対象の recordId（画面がそのまま dry-run へ渡す。PII は含まない） */
      recordIds: next.recordIds,
    },
    nextScheduledAt: nextDueAt ? new Date(nextDueAt).toISOString() : null,
    summary: progress.summary,
    stopLabels: SEQ_STOP_LABEL,
    engagement: engagementResponse(engagementView, list),
    providerSuppression: describeProviderSuppression(provider),
    notice: 'これは状況の確認です。**まだ何も送っていません**（キュー登録もしていません）。',
  });
}

/**
 * キュー登録の入口。**live のときだけ排他を取ってから**本体を呼ぶ。
 *
 * ⚠️ `JobId` は plan fingerprint 由来なので、同じキャンペーンのキュー登録が 2 本重なると
 *    **同じ JobId の行が 2 つ**できる（2026-08-20 に本番で発生。cron の tick が
 *    1 スロットで 3 回走っていた実測もある）。鍵が取れない = 他が書いている、
 *    確かめられない = 状態不明。**どちらも 1 バイトも書かずに終わる**（fail closed）。
 * ⚠️ dry-run は何も書かないので鍵を取らない（確認は何本走ってもよい）。
 * ⚠️ 本体がどこで return しても `finally` で必ず鍵を返す。
 */
async function handleQueuedPlan({ KEY, BASE, now, req, live }) {
  if (!live) return handlePlan({ KEY, BASE, now, req, live });

  const campaignId = String((req && req.campaignId) || '').trim();
  const stepPart = Number.isFinite(Number(req && req.step)) ? `:s${Number(req.step)}` : '';
  const lockId = `queue:${campaignId}${stepPart}`;
  if (!isSafeJobId(lockId)) {
    return json(400, { error: 'キャンペーンの指定が不正です', sideEffects: 'none' });
  }

  let lock = null;
  let token = null;
  try {
    lock = createDispatchLock({ cmd: makeRedisCmd(process.env), root: QUEUE_LOCK_ROOT });
    const got = await lock.acquire({ jobId: lockId, ttlSec: DISPATCH_LOCK_TTL_SEC });
    if (!got.ok) {
      return json(got.reason === LOCK_FAIL.BUSY ? 409 : 503, {
        error: got.reason === LOCK_FAIL.BUSY
          ? '同じキャンペーンのキュー登録が実行中です（二重に積まないため中止しました）'
          : 'キュー登録の排他を確認できないため中止しました',
        code: got.reason, sideEffects: 'none',
      });
    }
    token = got.token;
  } catch {
    return json(503, {
      error: 'キュー登録の排他を確認できないため中止しました',
      code: LOCK_FAIL.UNAVAILABLE, sideEffects: 'none',
    });
  }

  try {
    return await handlePlan({ KEY, BASE, now, req, live });
  } finally {
    try { await lock.release({ jobId: lockId, token }); } catch { /* TTL で切れる */ }
  }
}

async function handlePlan({ KEY, BASE, now, req, live }) {
  const baseCampaign = getCampaign(req.campaignId);
  if (baseCampaign && isSequenceCampaign(baseCampaign) && !Number.isFinite(Number(req.step))) {
    // 連続配信は**何通目かを明示**させる（取り違えると別の文面が届く）
    return json(400, {
      error: 'このキャンペーンは連続配信です。step を指定してください（1〜' + resolveMaxSends(baseCampaign) + '）',
      sequence: describeSequence(baseCampaign),
      sideEffects: 'none',
    });
  }
  // ステップを解決して以降は**キャンペーンと同じ扱い**にする
  // （描画・contentHash・DeliveryKey・除外判定はすべて既存関数がそのまま処理する）
  const campaign = baseCampaign ? resolveStepCampaign({ campaign: baseCampaign, step: req.step }) : null;
  if (baseCampaign && !campaign) {
    return json(400, { error: '未知のステップです', sideEffects: 'none' });
  }
  if (!campaign) {
    // 停止中なら理由を返す（「未知」と区別する）
    const disabled = getCampaign(req.campaignId, { includeDisabled: true });
    if (disabled) {
      return json(409, {
        error: `このキャンペーンは使用停止中です: ${disabled.disabledReason || '利用不可'}`,
        detail: disabled.disabledDetail || null,
        campaignId: disabled.campaignId,
        sideEffects: 'none',
      });
    }
    return json(400, { error: '未知のキャンペーンです' });
  }

  // ── 今回送る文面（管理画面で編集された下書き）─────────────────
  //   下書きが無ければテンプレートそのまま。**カタログは書き換えない**。
  const check = resolveDraft({ campaign, req });
  if (!check.ok) return json(400, { error: check.errors.join(' / '), errors: check.errors, sideEffects: 'none' });
  const sending = check.campaign;      // 以降、描画・hash・fingerprint はすべてこれを使う
  const contentHash = computeCampaignContentHash(sending);
  // 画面が確認した文面と一致するか（別本文へのすり替えを止める）
  if (req.contentHash && String(req.contentHash) !== contentHash) {
    return json(409, {
      error: '確認した文面と送ろうとしている文面が違います。もう一度確認してください。',
      expected: contentHash.slice(0, 12), got: String(req.contentHash).slice(0, 12),
      sideEffects: 'none',
    });
  }

  // ── シェル（組み立て方）の版が確認時と同じか ─────────────────────
  // dry-run とキュー登録の間に deploy が入ると、同じ campaign 定義でも
  // **違う HTML** が積まれてしまう。版を突き合わせて食い違いを止める。
  if (live) {
    if (!req.contentHash) {
      return json(400, { error: '確認した文面の hash が必要です（dry-run からやり直してください）', sideEffects: 'none' });
    }
    const shellVersion = Number(req.shellVersion);
    if (!Number.isFinite(shellVersion)) {
      return json(400, { error: 'メールの組み立て版が必要です（dry-run からやり直してください）', sideEffects: 'none' });
    }
    if (shellVersion !== MARKETING_EMAIL_SHELL_VERSION) {
      return json(409, {
        error: '確認したあとにメールの組み立て方が更新されました。もう一度 dry-run で内容を確認してください。',
        expected: MARKETING_EMAIL_SHELL_VERSION, got: shellVersion,
        sideEffects: 'none',
      });
    }
  }

  // ── 送信対象の指定（画面選択 or 無料付与成功者の引き継ぎ）────────────
  // 引き継ぎモードでは **クライアントの recordIds を読まない**。
  // 「誰に付与できたか」は Customers 側の事実であって、画面の申告ではないため。
  const grantOperationId = String(req.grantOperationId || '').trim();
  const recordIds = grantOperationId
    ? []
    : (Array.isArray(req.recordIds) ? req.recordIds.map(String) : []);
  if (!grantOperationId && recordIds.length === 0) {
    return json(400, { error: '送信対象が選択されていません' });
  }
  if (recordIds.length > MAX_RECIPIENTS_PER_SEND * 2) {
    return json(400, { error: `選択が多すぎます（上限 ${MAX_RECIPIENTS_PER_SEND} 件）` });
  }

  // 🛡️ live enqueue は既定で無効（env 未設定なら何も書かずに 503）
  if (live && !isMarketingSendEnabled(process.env)) {
    return json(503, {
      error: 'キャンペーン送信は無効です（MARKETING_CAMPAIGN_ENABLED 未設定）',
      flag: 'MARKETING_CAMPAIGN_ENABLED',
      sideEffects: 'none',
      hint: 'dry-run で対象確定までは確認できます。有効化には承認と env 設定が必要です。',
    });
  }

  const fromEmail = getBrandConfig(BRAND).defaultFromEmail;
  validateBrandFromEmail(BRAND, fromEmail); // 送信元とブランドの取り違え防止

  // 引き継ぎモード: 対象を Customers から**サーバーが導出する**（唯一の正）
  //
  // 「その回に付与された人」は `LightGrantOp` / `PremiumGrantOp` で名指しできるので、
  // **全件走査しない**（旧実装は先頭 4,000 件で打ち切られ、付与した 10 名のうち
  // 2 名しか見えなかった。その状態で queue を積むと 8 名へ案内が飛ばない）。
  let handoffView = null;
  let targetIds = recordIds;
  if (grantOperationId) {
    const opAudience = await loadCampaignAudience({
      KEY, BASE, now, campaign: null, formula: buildGrantOperationFormula(grantOperationId),
    });
    if (!opAudience.ok) {
      return json(500, {
        error: '引き継ぎ対象の取得が上限に達しました。人数を確定できないため中止します。',
        code: opAudience.code,
        grantOperationId,
        sideEffects: 'none',
      });
    }
    const list = opAudience.records.map((rec) => ({
      recordId: rec.id, record: rec, fields: rec.fields || {},
    }));
    const resolved = collectGrantedRecipients({ records: list, operationId: grantOperationId, nowMs: now });
    const verdict = validateHandoffResolution({
      operationId: grantOperationId,
      recordIds: resolved.recordIds,
      latestGrantedAtMs: resolved.latestGrantedAtMs,
      nowMs: now,
    });
    if (!verdict.ok) {
      // 期限切れは 410（もう使えない）、それ以外は 409（いまは使えない）
      return json(verdict.reason === HANDOFF_BLOCK.EXPIRED ? 410 : 409, {
        error: HANDOFF_BLOCK_LABEL[verdict.reason] || '引き継ぎを受け付けられません',
        reason: verdict.reason,
        grantOperationId,
        sideEffects: 'none',
      });
    }
    if (resolved.recordIds.length > MAX_RECIPIENTS_PER_SEND * 2) {
      return json(400, { error: `引き継ぎ対象が多すぎます（上限 ${MAX_RECIPIENTS_PER_SEND} 件）` });
    }
    targetIds = resolved.recordIds;
    // 画面に返すのは件数と期限だけ（アドレスも recordId も返さない）
    handoffView = {
      grantOperationId,
      resolved: verdict.recipientCount,
      byTier: resolved.byTier,
      expiresAt: new Date(verdict.expiresAtMs).toISOString(),
      note: '対象は無料付与が成功した顧客だけをサーバー側で確定しています（画面の選択は使っていません）。',
    };
  }

  // 🛡️ 送信対象は **名指しで**引く。全件走査は MAX_PAGES で黙って打ち切られ、
  //    後ろの顧客が `unknown_customer` として静かに落ちる（= 送ったつもりで未送信）。
  const targeted = await loadMarketingForRecordIds({ KEY, BASE, now, recordIds: targetIds });
  const byId = new Map(targeted.list.map((c) => [c.recordId, c]));
  const fetchAudit = summarizeTargetedFetch({ requested: targetIds, received: targeted.records });

  const selected = targetIds.map((id) => byId.get(id) || { recordId: id, fields: null, marketing: null });

  // 既送信突合（同一 campaignId:version）
  //
  // ⚠️ campaign 単位の全件取得にしてはいけない。配信実績が `MAX_PAGES`（4,000 行）を
  //    超えた時点で黙って打ち切られ、`deliveredKeys` が不完全になる
  //    = `already_delivered` を見落として**二重送信**する。
  //    判定に要るのは「今回送ろうとしている鍵が既にあるか」だけなので名指しで引く。
  //    取り切れなければ例外（fail closed）。握り潰して送らない。
  const candidateKeys = selected
    .map((c) => (c.marketing
      ? computeCampaignDeliveryKey({
        campaign: sending, recipientEmail: c.marketing.email, brand: BRAND, fromEmail,
      })
      : null))
    .filter(Boolean);
  // 🛡️ 既送信の判定源は `MARKETING_DELIVERY_STORE` の単一源に従う。
  //    既定（未設定）は従来どおり Airtable のみ。`dual` なら Airtable と Redis の
  //    **和集合**を取る（移行途中に片側しか無い既送信を見落とさないため）。
  //    Redis が落ちても dual なら Airtable の答えで継続し、degraded として記録する。
  const deliveryStoreMode = resolveDeliveryStoreMode(process.env);
  const deliveryStoreScope = {
    brand: BRAND, campaignId: campaign.campaignId, version: campaign.version,
  };
  const deliveredResolution = await resolveDeliveredKeys({
    mode: deliveryStoreMode,
    keys: candidateKeys,
    fetchAirtableDelivered: (keys) => fetchDeliveredKeys({
      KEY, BASE, campaignType: `${campaign.campaignId}:v${campaign.version}`, keys,
    }),
    fetchRedisDelivered: async (keys) => {
      const store = createDeliveryKeyStore({ redisCmd: makeRedisCmd(process.env) });
      return store.filterDelivered({ ...deliveryStoreScope, keys });
    },
  });
  const deliveredKeys = deliveredResolution.delivered;
  if (deliveredResolution.degraded) {
    // 値・アドレスは出さない。理由コードだけ残す
    console.warn('⚠️ [admin-marketing] delivery store degraded:', deliveredResolution.degraded);
  }

  // 🛡️ SendGrid 側 suppression を毎回確認する。AK の EmailBlacklist は Webhook 稼働以降しか
  //    持たないため、これが無いと provider では送れない相手を「送信対象」に数えてしまう。
  //    取得できなければ計画を作らない（fail closed）。
  const provider = await fetchProviderSuppression({ apiKey: process.env.SENDGRID_API_KEY, now });
  const blacklist = await loadBlacklistSets({ KEY, BASE });

  // 受信者ごとの申込 URL が要るキャンペーンだけ、割引オファー台帳を読む（read-only）。
  // 生トークンは保存されていないが `signOfferToken` は決定的なので、鍵があれば再生成できる。
  let offerRecords = null;
  if (requiresOfferUrl(campaign)) {
    offerRecords = await fetchAll({ KEY, BASE, table: OFFERS_TABLE }).catch(() => null);
  }

  // 🛡️ 反応が無い相手の除外。**材料が揃っているときだけ** Map を渡す。
  //    渡さなければ `buildCampaignPlan` は素通りさせる（誰も除外しない）。
  //    dry-run と live は同じこの関数を通るので、判定が食い違わない。
  const { view: engagementView } = await resolveEngagementView({
    list: targeted.list, deliveries: targeted.deliveries, now,
  });

  const plan = buildCampaignPlan({
    campaign: sending, selected, deliveredKeys,
    providerSuppressed: provider.ok ? provider.emails : null,
    softBounced: blacklist.soft,
    audienceContext: buildAudienceContext(process.env),
    brand: BRAND, fromEmail, nowMs: now,
    offerRecords, offerSecret: getOfferSecret(process.env),
    engagementByEmail: engagementView.engagementByEmail,
    engagementThresholds: engagementView.thresholds,
  });
  if (!plan.ok) {
    if (plan.error === 'provider_suppression_unavailable') {
      return json(503, {
        error: 'SendGrid の配信停止リストを確認できないため中止しました（確認できないまま送信しません）',
        detail: describeProviderSuppression(provider),
        sideEffects: 'none',
      });
    }
    if (plan.error === 'offer_ledger_unavailable' || plan.error === 'offer_secret_unavailable') {
      return json(503, {
        error: '割引オファーの台帳または署名鍵を確認できないため中止しました（専用 URL を作れないまま送信しません）',
        detail: plan.error === 'offer_secret_unavailable'
          ? 'PROMO_OFFER_SECRET が未設定です'
          : 'PromotionalOffers を読み取れませんでした（COMEBACK_OFFER_TABLE_READY / テーブルを確認してください）',
        sideEffects: 'none',
      });
    }
    return json(400, { error: `送信計画を作成できません: ${plan.error}` });
  }

  const excludedDetail = Object.entries(plan.counts.byReason)
    .map(([reason, count]) => ({ reason, label: MK_EXCLUSION_LABEL[reason] || reason, count }))
    .sort((a, b) => b.count - a.count);

  // 誰がなぜ除外されたかを **1 人ずつ**返す（集計だけでは「自分が選んだあの人」が分からない）。
  // 判定は buildCampaignPlan が済ませたもので、ここでは形を変えるだけ（再判定しない）。
  // PII は recordId と理由コードのみ（氏名・メールは画面が一覧から突き合わせる）。
  const excludedRecords = plan.excluded.map((e) => ({
    recordId: String(e.recordId || ''),
    reason: String(e.reason || ''),
    label: MK_EXCLUSION_LABEL[e.reason] || String(e.reason || ''),
  }));
  // 画面が「誰が対象か」を人物単位で確定してよいかを **サーバーが宣言する**。
  // 明細が 1 件でも欠けていたら false にし、画面は対象者一覧を作らない（推測させない）。
  const detailComplete = excludedRecords.length === plan.excluded.length
    && excludedRecords.every((e) => e.recordId)
    && new Set(excludedRecords.map((e) => e.recordId)).size === excludedRecords.length;

  // 🛡️ 選んだ recordId を Airtable から**全部引けたか**を明示する。
  //    引けなかった分は `unknown_customer` として除外されるので、取得漏れと
  //    「本当に対象外」を取り違えないよう、件数を必ず応答に載せる。
  if (!fetchAudit.complete) {
    return json(502, {
      error: '選択した顧客レコードを全部読み取れませんでした（不完全なまま送信しません）',
      requested: fetchAudit.requested,
      received: fetchAudit.received,
      missing: fetchAudit.missing.length,
      sideEffects: 'none',
    });
  }

  // 割引案内は「何をいくらで案内するのか」を最終確認に出す（金額の取り違え防止）。
  // 有効期限は台帳の実値（受信者ごとに違いうるので最短を出す）。
  const offerSummary = requiresOfferUrl(campaign) ? (() => {
    // ⚠️ OfferId だけで数えない。**revoked / redeemed / 期限切れを除外**する
    //    （除外しないと「有効なオファーが 4 件」のような嘘の件数を最終確認に出してしまう）。
    const live = (offerRecords || [])
      .filter((r) => String(r.fields?.OfferId || '') === String(campaign.offerId))
      .filter((r) => isLiveOffer({ record: r, nowMs: now }))
      .map((r) => Date.parse(String(r.fields?.ExpiresAt || '')))
      .filter((t) => Number.isFinite(t));
    return {
      offerId: campaign.offerId,
      regularPrice: campaign.regularPrice,
      offerPrice: campaign.offerPrice,
      discountPercent: campaign.regularPrice
        ? Math.round((1 - campaign.offerPrice / campaign.regularPrice) * 100) : 0,
      // CTA は受信者ごとに違うため、実 URL ではなく形だけを見せる
      ctaLabel: campaign.ctaLabel,
      ctaKind: 'お客様ごとの専用 URL（/offer/?t=…）',
      earliestExpiresAt: live.length ? new Date(Math.min(...live)).toISOString() : null,
      liveOffers: live.length,
    };
  })() : null;

  const summary = {
    campaignId: campaign.campaignId,
    campaignName: campaign.name,
    version: campaign.version,
    /** 連続配信のときだけ入る（何通目を送ろうとしているか） */
    step: campaign.sequenceStep || null,
    stepName: campaign.sequenceStepName || null,
    maxSends: campaign.sequenceMaxSends || null,
    // 「今回送る」件名・本文（テンプレートではなく確定した文面）
    subject: sending.subject,
    body: sending.body,
    contentHash,
    contentEdited: check.edited,
    contentWarnings: check.warnings,
    offerSummary,
    selected: plan.counts.selected,
    excluded: plan.counts.excluded,
    willSend: plan.counts.recipients,
    excludedDetail,
    excludedRecords,
    detailComplete,
    // 反応なし除外の状態（適用中か・閾値・期間・今回何人落ちたか）
    engagement: {
      ...engagementResponse(engagementView, targeted.list),
      blockedThisPlan: plan.counts.byReason[MK_EXCLUSION.ENGAGEMENT_BLOCKED] || 0,
    },
    planFingerprint: plan.planFingerprint,
    // 確認した「組み立て方」の版。送信時にこの値の一致を要求する
    shellVersion: MARKETING_EMAIL_SHELL_VERSION,
    // 引き継ぎモードのときだけ入る（件数と期限のみ。PII なし）
    handoff: handoffView,
  };

  if (!live) {
    return json(200, {
      mode: 'dry-run',
      sideEffects: 'none',
      ...summary,
      // 完成形は**送信と同じレンダラー**で作る（プレビュー専用の描画を持たない）
      preview: buildPreview({ campaign: sending, fromEmail }),
      // PII は最小限（宛先ドメインのみ）。個々のアドレスは一覧側で既に見えている。
      recipientDomains: countDomains(plan.recipients),
      sendEnabled: isMarketingSendEnabled(process.env),
      dispatchEnabled: isDispatchEnabled(process.env),
      providerSuppression: describeProviderSuppression(provider),
      notice: 'この時点では何も書き込んでいません。送信するには確認のうえ実行してください。',
    });
  }

  // ── live: dry-run と同一の母集団であることを検証（TOCTOU 防止）──
  const token = String(req.planFingerprint || '');
  if (!token) return json(400, { error: 'dry-run の確認トークンが必要です' });
  if (token !== plan.planFingerprint) {
    return json(409, {
      error: '対象が変化したため中止しました。もう一度 dry-run を実行してください。',
      expected: plan.planFingerprint.slice(0, 12),
      got: token.slice(0, 12),
      sideEffects: 'none',
    });
  }
  if (plan.recipients.length === 0) return json(400, { error: '送信対象が 0 件です' });

  const rendered = renderCampaign({ campaign: sending, name: null }); // 1 ジョブ 1 本文（汎用呼びかけ）
  if (!rendered) return json(500, { error: 'テンプレート描画に失敗しました' });

  // ── 0) prospect は **1 行も書く前に予約する**（2026-08-27 恒久修正）────────
  //
  // prospect は `CampaignDeliveries` に行を作らないので、冪等性の根拠は
  // Redis の集合だけ。**queue のあとに記録する順序だと、記録が落ちた瞬間に
  // 「未送信」に戻り、次の実行で二重 queue になる**。
  //
  // ここでは **all-or-nothing**。1 件でも予約できなければ、
  // ジョブも配信行も 1 つも作らずに中止する（この経路は運用者が押す 1 回なので、
  // 部分的に進めるより「やり直せる状態で止める」方が安全）。
  const prospectPlanRecipients = plan.recipients.filter(
    (r) => !resolveRecipientLedgerPolicy({
      mode: deliveryStoreMode, source: (r && (r['出所'] ?? r.source)) || RECIPIENT_SOURCE.CUSTOMER,
    }).writeAirtable,
  );
  const prospectScope = { brand: BRAND, campaignId: campaign.campaignId, version: campaign.version };
  let prospectClaimed = [];
  if (prospectPlanRecipients.length > 0) {
    const keys = prospectPlanRecipients.map((r) => r.deliveryKey).filter(Boolean);
    if (keys.length !== prospectPlanRecipients.length) {
      return json(500, {
        error: 'prospect の DeliveryKey を作れませんでした（中止しました）',
        reason: 'prospect_key_build_failed', sideEffects: 'none',
      });
    }
    try {
      const store = createDeliveryKeyStore({
        redisCmd: makeRedisCmd(process.env), redisPipeline: makeRedisPipeline(process.env),
      });
      const claim = await store.claimDelivered({ ...prospectScope, keys });
      prospectClaimed = claim.claimed;
      if (claim.claimed.length !== keys.length) {
        // 既に他が持っている / 既送信 → **この計画のままでは送れない**。
        // 自分が取った分は戻してから中止する（取りっぱなしにすると二度と送られない）。
        if (claim.claimed.length > 0) {
          try { await store.releaseClaims({ ...prospectScope, keys: claim.claimed }); } catch { /* 記録のみ */ }
        }
        return json(409, {
          error: 'prospect の一部が既に送信済み・予約済みでした。dry-run からやり直してください。',
          reason: 'prospect_already_claimed',
          requested: keys.length, claimed: claim.claimed.length,
          sideEffects: 'none',
        });
      }
    } catch {
      // ⚠️ **予約が確定できない = 送らない**（未送信と見なして送ると二重送信になる）
      return json(503, {
        error: 'prospect の配信台帳を予約できないため中止しました（二重送信を避けるため）',
        reason: 'prospect_ledger_unavailable',
        prospectRecipients: prospectPlanRecipients.length,
        sideEffects: 'none',
      });
    }
  }

  /** 予約したのに queue できなかった鍵を戻す（**戻さないと二度と送られない**） */
  const releaseProspectClaims = async (keys) => {
    const list = (keys || []).filter(Boolean);
    if (list.length === 0) return;
    try {
      const store = createDeliveryKeyStore({
        redisCmd: makeRedisCmd(process.env), redisPipeline: makeRedisPipeline(process.env),
      });
      await store.releaseClaims({ ...prospectScope, keys: list });
    } catch {
      console.error('🛑 [admin-marketing] prospect の予約を戻せませんでした');
    }
  };

  // 1) ScheduledEmails に PENDING ジョブを作る（実送信は送信基盤が担当）
  const jobIdByEmail = new Map();
  const jobs = [];
  const batches = chunkRecipients(plan.recipients);
  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    // ⚠️ ジョブの形は **共通契約** が単一源（手動送信と自動配信で同じ行を作る）。
    //    ここで独自に組み立てない（形がズレると dispatcher の扱いが変わる）。
    const jobId = buildJobId({
      campaignId: campaign.campaignId, version: campaign.version,
      fingerprint: plan.planFingerprint, index: i + 1,
    });
    const jobFields = buildScheduledEmailFields({
      subject: rendered.subject,
      html: rendered.html,
      emails: batch.map((r) => r.email),
      scheduledAtIso: new Date(now).toISOString(),
      jobId,
      campaignId: campaign.campaignId,
      // 何を送ったかを後から照合できるようにする（既存の Notes だけを使う）
      // 引き継ぎ由来なら、どの付与操作から来たジョブかも残す（アドレスは入れない）
      // dispatcher が読む: どの組み立て方で作った HTML か（版が違えば送らない）
      notes: buildJobNotes({
        campaignId: campaign.campaignId,
        campaignVersion: campaign.version,
        shellVersionNote: `${SHELL_VERSION_NOTE_PREFIX}${MARKETING_EMAIL_SHELL_VERSION}`,
        contentHash,
        edited: check.edited,
        handoffNote: grantOperationId ? handoffNote(grantOperationId) : '',
      }),
    });
    /**
     * ⚠️ **未検証の印を付けて作る。** ジョブは作った瞬間から dispatcher の対象
     *    （`{Status}='PENDING'`）になるので、配信行を確認する前に「送ってよい」状態で
     *    置いてはいけない。実行が途中で終わっても、残るのは**送られないジョブ**にする
     *    （2026-08-18 / 08-20 の orphan 事故）。印は配信行を読み戻して確認できてから外す。
     */
    jobFields.Notes = markUnverified(jobFields.Notes);
    if (!assertOnlyScheduledFields(jobFields)) return json(500, { error: 'field allow-list violation' });
    /**
     * ⚠️ **同じ `JobId` の行を二重に作らない。** `JobId` は plan fingerprint 由来なので、
     *    同じ母集団・同じ本文で積み直すと**同じ JobId** になる。`createRecord` は毎回
     *    新しい行を作るため、失敗して積み直すと同じ JobId の行が 2 つできる
     *    （2026-08-20 に本番で発生）。既存行があるならそれを作り直して使う。
     * ⚠️ 送信済みのジョブは**絶対に作り直さない**（二重送信になる）。読めなければ書かない。
     */
    let existingRows = null;
    try {
      existingRows = await fetchAllStrict({
        KEY, BASE, table: SCHEDULED_TABLE, filterByFormula: `{JobId}='${jobId}'`,
        maxPages: TARGETED_MAX_PAGES, fields: ['JobId', 'Status', 'SentCount'],
      });
    } catch {
      existingRows = null;                 // 読めない = 判断できない（fail closed）
    }
    const decided = decideJobRowAction({ rows: existingRows });
    if (decided.action === JOB_ROW_ACTION.REJECT) {
      await rollbackQueue({
        KEY, BASE, campaign, now, jobs, rows: new Map(), reason: decided.reason,
      });
      return json(409, {
        error: 'キュー登録を中止しました（同じジョブの状態を確かめられません）',
        reason: decided.reason, jobId,
        sideEffects: jobs.length > 0 ? 'rolled_back' : 'none',
        notice: '同じ内容のジョブが既に送信済み、もしくは状態を確認できません。'
          + '**積み直すと二重送信になり得るため、何も書いていません。**',
      });
    }
    let recordId = decided.recordId;
    if (decided.action === JOB_ROW_ACTION.REUSE) {
      const ok = await patchRecord({
        KEY, BASE, table: SCHEDULED_TABLE, recordId: decided.recordId, fields: jobFields,
      });
      if (!ok) {
        await rollbackQueue({ KEY, BASE, campaign, now, jobs, rows: new Map(), reason: 'job_reuse_failed' });
        return json(500, {
          error: 'キュー登録を確定できませんでした（既存ジョブを作り直せません）',
          reason: 'job_reuse_failed', jobId, sideEffects: jobs.length > 0 ? 'rolled_back' : 'none',
        });
      }
    } else {
      const created = await createRecord({ KEY, BASE, table: SCHEDULED_TABLE, fields: jobFields });
      recordId = created?.id || null;
    }
    for (const r of batch) jobIdByEmail.set(r.email, { jobId, recordId });
    jobs.push({ jobId, recipientCount: batch.length, recordId });
  }

  // 2) CampaignDeliveries を DeliveryKey 冪等で upsert（二重送信の最終防壁）
  //
  // ── prospect（CSV 取り込み由来）は Airtable へ 1 行も書かない（2026-08-27 MK 確定）──
  //
  // Airtable は本番でレコード上限を超過中（実測 50,789 / 50,000。うち
  // `CampaignDeliveries` が 33,112 行）。CSV 由来へ 1 step 配るだけで受信者数ぶん増えるため、
  // **出所が prospect の受信者は Airtable 台帳を作らず Redis の集合だけで冪等性を担保する**。
  // 判断は `deliveryKeySource.js` の単一源に委ねる（ここで条件を書かない）。
  //
  // ⚠️ Customers 由来は**従来どおり**（`MARKETING_DELIVERY_STORE` に従う）。
  // ⚠️ 出所が書かれていない受信者は customer 扱い（prospect へ倒すと台帳が消える）。
  const ledgerPolicyOf = (r) => resolveRecipientLedgerPolicy({
    mode: deliveryStoreMode, source: (r && (r['出所'] ?? r.source)) || RECIPIENT_SOURCE.CUSTOMER,
  });
  const airtableRecipients = plan.recipients.filter((r) => ledgerPolicyOf(r).writeAirtable);
  const prospectRecipients = plan.recipients.filter((r) => !ledgerPolicyOf(r).writeAirtable);
  const ledgerSplit = partitionRecipientsForLedger({ mode: deliveryStoreMode, recipients: plan.recipients });

  /**
   * ⚠️ **fail closed**: prospect が居るのに Redis へ書けない構成なら、
   *    その人たちの「送った」がどこにも残らず**次回そのまま二重送信**になる。
   *    1 行も書かずに中止する（ジョブだけ巻き戻す）。
   */
  // ⚠️ prospect の予約は**ジョブを作る前**に済ませてある（上の 0 段）。
  //    ここで改めて Redis の到達性を確かめる必要は無い。

  const deliveryRecords = buildDeliveryRecords({ campaign, recipients: airtableRecipients, jobIdByEmail, nowMs: now });
  for (const rec of deliveryRecords) {
    if (!assertOnlyDeliveryFields(rec.fields)) return json(500, { error: 'field allow-list violation' });
  }
  /**
   * ⚠️ 組み立て段の**黙った取りこぼし**を先に捕まえる。
   *    `buildDeliveryRecords` は許可外フィールドが混ざった行を `continue` で落とすので、
   *    全件落ちても 0 件のまま素通りし、`upsertDeliveries` は HTTP を 1 回も呼ばない
   *    （＝例外も出ない）。ここで数を突き合わせておかないと
   *    「配信行 0 件なのにキュー成功」になる（2026-08-18 の事故）。
   */
  if (deliveryRecords.length !== airtableRecipients.length) {
    // まだ 1 行も書いていないので、取り消すのはジョブだけでよい（配信行は存在しない）
    const rb = await rollbackQueue({
      KEY, BASE, campaign, now, jobs, rows: new Map(), reason: QUEUE_FAIL.RECORDS_DROPPED,
    });
    return json(500, {
      error: 'キュー登録を確定できませんでした（配信行を組み立てられません）',
      reason: QUEUE_FAIL.RECORDS_DROPPED,
      expected: airtableRecipients.length, built: deliveryRecords.length,
      rolledBack: rb.verified === true,
      rollback: {
        jobsTargeted: rb.jobsTargeted, jobsCancelled: rb.jobsCancelled,
        jobsFailed: rb.jobsFailed, jobsStillPending: rb.jobsStillPending,
      },
      sideEffects: rb.verified === true ? 'rolled_back' : 'partial_unconfirmed',
    });
  }
  // 🛡️ 記録先も単一源に従う。既定は Airtable のみ。`dual` は Redis へも SADD する。
  //    Airtable 側の失敗は従来どおり致命（台帳が欠ける）。Redis 側の失敗は dual なら
  //    致命にせず、差分は scripts/reconcile-delivery-stores.mjs で拾う。
  /**
   * ⚠️ **投げっぱなしで 500 にしない。** `upsertDeliveries` が最後に throw すると、
   *    ジョブだけ作られて配信行が無い状態（2026-08-18 の事故そのもの）で
   *    補償へ到達しないので、例外は捕まえて**同じ確定処理へ通す**。
   */
  let writeError = null;
  try {
    const deliveryWrite = await recordDelivered({
      mode: deliveryStoreMode,
      // ⚠️ Redis へ改めて記録するのは **customer 分だけ**。
      //    prospect は予約済みなので、ここで書いても書かなくても集合は変わらない。
      keys: ledgerSplit.redisKeys.filter((k) => !prospectClaimed.includes(k)),
      // ⚠️ Airtable へは **customer 由来だけ**（prospect の行は 1 つも作らない）
      writeAirtable: () => upsertDeliveries({ KEY, BASE, records: deliveryRecords }),
      writeRedis: async (keys) => {
        const store = createDeliveryKeyStore({ redisCmd: makeRedisCmd(process.env) });
        await store.markDelivered({ ...deliveryStoreScope, keys });
      },
    });
    // ⚠️ prospect の冪等性は **ジョブを作る前の予約**で確定済み（上の 0 段）。
    //    ここで改めて記録・検証はしない（記録の失敗で二重 queue になる順序を作らない）。
    if (deliveryWrite.redis === 'failed') {
      console.warn('⚠️ [admin-marketing] delivery store redis write failed（Airtable が正本のため継続）');
    }
  } catch (e) {
    writeError = String((e && e.message) || 'delivery_write_failed').slice(0, 120);
  }

  /**
   * ⚠️ **配信行の実在を読み戻して確かめてから**キュー成功と言う。
   *    例外が出なかったことは「書けた」の証拠にならない。読めなければ 0 件とも言わず、
   *    部分成功も成功へ丸めない（`queueDeliveryOutcome.js` が単一源）。
   *    足りなければまず**不足ぶんだけ冪等に補完**し、それでも駄目なら
   *    **既存の rollback 契約**で配信行ごと巻き戻す（ジョブだけ取り消さない）。
   */
  // ⚠️ Airtable 台帳の突合は **Airtable へ書く対象だけ**を分母にする
  //    （prospect を混ぜると「行が足りない」と誤判定して巻き戻す）。
  const settled = await settleQueueWrite({
    KEY, BASE, campaign, now, jobs, recipients: airtableRecipients, deliveryRecords, writeError,
  });
  if (!settled.ok) {
    const rb = settled.rollback || {};
    // ⚠️ 巻き戻すなら prospect の予約も**必ず戻す**（戻さないと二度と送られない）
    await releaseProspectClaims(prospectClaimed);
    console.error('🛑 [admin-marketing] キュー登録を確定できず巻き戻し:', {
      campaignId: campaign.campaignId, reason: settled.outcome.reason,
      expected: settled.outcome.expected, verified: settled.outcome.verified,
      missing: settled.outcome.missing, rollbackVerified: rb.verified === true,
    });
    return json(500, {
      error: 'キュー登録を確定できませんでした（配信行を確認できません）',
      reason: settled.outcome.reason,
      writeError: settled.writeError,
      expected: settled.outcome.expected,
      verified: settled.outcome.verified,
      missing: settled.outcome.missing,
      /** ⚠️ 巻き戻しを**確認できたときだけ** true。件数も丸めない */
      rolledBack: rb.verified === true,
      rollback: {
        deliveriesTargeted: rb.deliveriesTargeted ?? null,
        deliveriesCancelled: rb.deliveriesCancelled ?? null,
        deliveriesFailed: rb.deliveriesFailed ?? null,
        deliveriesStillActive: rb.deliveriesStillActive ?? null,
        jobsTargeted: rb.jobsTargeted ?? null,
        jobsCancelled: rb.jobsCancelled ?? null,
        jobsFailed: rb.jobsFailed ?? null,
        jobsStillPending: rb.jobsStillPending ?? null,
      },
      sideEffects: rb.verified === true ? 'rolled_back' : 'partial_unconfirmed',
      notice: rb.verified === true
        ? '配信行を確認できないため、作成した送信待ちジョブと配信行を取り消しました。'
          + '取消済み配信行は既送信に数えないので、そのまま再実行できます。'
        : '⚠️ 巻き戻しを確認できていません。**人が状態を確認するまで再実行しないでください。**',
    });
  }

  /**
   * ⚠️ **ここで初めて「送ってよい」状態にする。** 配信行の実在を読み戻して確認できたので、
   *    未検証の印を外す。外せたことも**読み戻して確かめる**（外したつもりにしない）。
   *    外せなければ成功と言わず、作ったものを巻き戻す（fail closed）。
   */
  const promoted = await promoteVerifiedJobs({ KEY, BASE, jobs });
  if (!promoted.ok) {
    const rb = await rollbackQueue({
      KEY, BASE, campaign, now, jobs, rows: await readDeliveryRows({
        KEY, BASE, campaign, keys: [...collectDeliveryKeys(plan.recipients)],
      }), reason: 'job_promote_unconfirmed',
    });
    console.error('🛑 [admin-marketing] 未検証の印を外せず巻き戻し:', {
      campaignId: campaign.campaignId, promoted: promoted.promoted, targeted: promoted.targeted,
      rollbackVerified: rb.verified === true,
    });
    return json(500, {
      error: 'キュー登録を確定できませんでした（ジョブを送信可能な状態にできません）',
      reason: 'job_promote_unconfirmed',
      targeted: promoted.targeted, promoted: promoted.promoted, stillUnverified: promoted.stillUnverified,
      rolledBack: rb.verified === true,
      sideEffects: rb.verified === true ? 'rolled_back' : 'partial_unconfirmed',
      notice: rb.verified === true
        ? '送信可能な状態にできなかったため、作成したジョブと配信行を取り消しました。'
        : '⚠️ 巻き戻しを確認できていません。**人が状態を確認するまで再実行しないでください。**',
    });
  }

  console.log('✅ [admin-marketing] キャンペーンをキューへ登録:', {
    campaignId: campaign.campaignId, version: campaign.version,
    queued: plan.recipients.length, jobs: jobs.length,
    dispatchEnabled: isDispatchEnabled(process.env),
  });

  return json(200, {
    mode: 'queued',
    ...summary,
    queued: plan.recipients.length,
    jobs,
    dispatchEnabled: isDispatchEnabled(process.env),
    notice: isDispatchEnabled(process.env)
      ? '送信キューへ登録しました。実送信は送信基盤が順次行います。'
      : '送信キューへ登録しましたが、キャンペーン送信は無効（MARKETING_CAMPAIGN_DISPATCH_ENABLED != true）のため実送信されません。',
  });
}

/**
 * 送信ジョブの状況（read-only）。
 *
 * 「いま何が送信待ちで、どれが失敗し、どれを取り消せるのか」を 1 リクエストで返す。
 * 判定は `marketingJobs.js` に委譲し、ここでは取得だけ行う。
 * ⚠️ **アドレスは返さない**（件数と理由コードだけ）。
 */
async function handleJobs({ KEY, BASE }) {
  // ① ジョブは **マーケティング分だけ**を引く（ScheduledEmails 全件を読まない）。
  //    formula は `isMarketingJob` と同じ 3 条件で、`buildJobView` 側の再判定と食い違わない。
  // ② 配信行は **①で得たジョブ ID を名指し**で引く。旧実装は台帳を
  //    `{EmailType}='campaign'` で全件取得しており、4,000 行を超えた時点で
  //    4,000 行打ち切りに掛かって各ジョブの件数が過少表示されていた（2026-08-15 実測）。
  // ③ どちらも取り切れなければ **例外 → 500**。短い結果を全体として出さない。
  let scheduled;
  let deliveries;
  let jobsTotal = 0;
  try {
    const allJobs = await fetchAllStrict({
      KEY, BASE, table: SCHEDULED_TABLE, filterByFormula: MARKETING_JOB_FORMULA,
    });
    jobsTotal = allJobs.length;
    // ④ 読む量を**表示する件数**に合わせる。全ジョブぶんの配信行を引くと
    //    台帳全体（14,426 行 / 実測 2026-08-15）を読むのと変わらず、実行時間に収まらない。
    //    落とした分は `jobsTotal` / `jobsShown` で**明示する**（黙って切らない）。
    scheduled = allJobs
      .slice()
      .sort((a, b) => String(((b && b.fields) || {}).ScheduledFor || '')
        .localeCompare(String(((a && a.fields) || {}).ScheduledFor || '')))
      .slice(0, JOBS_VIEW_LIMIT);
    const jobIds = scheduled
      .map((r) => String(((r && r.fields) || {}).JobId || '').trim())
      .filter(Boolean);
    deliveries = await fetchDeliveriesByJobIds({ KEY, BASE, jobIds });
  } catch (e) {
    return json(500, {
      error: 'ジョブの状況を取り切れなかったため、一覧を返しません（数えられない数は出しません）。',
      code: 'jobs_fetch_incomplete',
      detail: String((e && e.message) || 'unknown'),
      sideEffects: 'none',
    });
  }
  const jobs = buildJobView({ jobRecords: scheduled, deliveryRecords: deliveries, isMarketingJob });
  return json(200, {
    jobs,
    /** 何件のうち何件を出しているか（**黙って切らない**） */
    jobsTotal,
    jobsShown: jobs.length,
    jobsLimit: JOBS_VIEW_LIMIT,
    jobsTruncated: jobsTotal > jobs.length,
    sendEnabled: isMarketingSendEnabled(process.env),
    dispatchEnabled: isDispatchEnabled(process.env),
    notice: isDispatchEnabled(process.env)
      ? '送信が有効です。PENDING のジョブは dispatcher を実行したときに送信されます（自動実行はしません）。'
      : 'キャンペーン配信は無効（MARKETING_CAMPAIGN_DISPATCH_ENABLED 未設定）。PENDING のままでは送信されません。',
    cancelNote: 'PENDING のジョブだけ取り消せます。SENT / FAILED は送信済みの事実なので取り消せません。',
  });
}

/**
 * 送信予定（PENDING）ジョブの取消。
 *
 * - **PENDING 以外は取り消せない**（SENT / FAILED は送った事実。消さない）
 * - 取り消すのは `ScheduledEmails.Status` と **queued の配信行だけ**。
 *   `sent` の配信行には **1 バイトも触れない**
 * - `operationId` 必須。同じ取消を 2 回実行しても 2 重に書かない（冪等）
 * - 書き込み列は allow-list で固定する
 */
async function handleCancelJob({ KEY, BASE, now, req }) {
  const jobId = String(req.jobId || '').trim();
  const operationId = String(req.operationId || '').trim();
  if (!jobId) return json(400, { error: 'jobId が必要です' });
  if (!operationId) return json(400, { error: '操作 ID（operationId）が必要です' });
  // formula へ外部入力を直挿ししない（識別子の形だけを許す）
  if (!/^[A-Za-z0-9_.:-]{1,120}$/.test(jobId) || !/^[A-Za-z0-9_.:-]{1,120}$/.test(operationId)) {
    return json(400, { error: '識別子の形式が不正です' });
  }

  // ⚠️ 取得失敗を `[]` に潰さない。潰すと「ジョブが見つかりません」(404) と
  //    区別が付かず、取り消せたのか取り消せていないのか分からなくなる。
  let scheduled;
  try {
    scheduled = await fetchAllStrict({
      KEY, BASE, table: SCHEDULED_TABLE, filterByFormula: `{JobId}='${jobId}'`,
      maxPages: TARGETED_MAX_PAGES,
    });
  } catch (e) {
    return json(500, {
      error: 'ジョブを取得できなかったため中止しました（取消は行っていません）。',
      code: 'cancel_job_fetch_failed',
      detail: String((e && e.message) || 'unknown'),
      sideEffects: 'none',
    });
  }
  const job = scheduled.find((r) => String(r.fields?.JobId || '') === jobId) || null;
  if (!job) return json(404, { error: 'ジョブが見つかりません', reason: CANCEL_REJECT.NOT_FOUND });
  if (!isMarketingJob(job.fields || {})) {
    return json(403, { error: 'マーケティングジョブではありません', reason: CANCEL_REJECT.NOT_MARKETING });
  }

  // 冪等: 同じ操作 ID で既に取消済みなら、何も書かずに成功として返す
  if (isAlreadyCancelledBy({ job, operationId })) {
    return json(200, { cancelled: true, alreadyDone: true, jobId, sideEffects: 'none' });
  }

  const verdict = canCancelJob(job);
  if (!verdict.ok) {
    return json(409, {
      error: verdict.reason === CANCEL_REJECT.ALREADY_SENT
        ? '送信済みのジョブは取り消せません（メールは取り消せません）'
        : '取り消せない状態です',
      reason: verdict.reason,
      sideEffects: 'none',
    });
  }

  // 1) 送信待ちの配信行（queued のみ）を cancelled にする。**sent には触れない**
  //
  // ⚠️ ここを `.catch(() => [])` にしてはいけない。取得に失敗すると対象 0 件となり、
  //    **ジョブだけ取り消して配信行を `queued` のまま残す**（＝部分取消）。
  //    残った `queued` は `already_delivered` として永久に除外され、
  //    その人には二度と Step が届かなくなる。取れないなら 1 バイトも書かない。
  let deliveries;
  try {
    deliveries = await fetchAllStrict({
      KEY, BASE, table: DELIVERIES_TABLE, filterByFormula: `{ScheduledEmailJobId}='${jobId}'`,
      maxPages: TARGETED_MAX_PAGES,
    });
  } catch (e) {
    return json(500, {
      error: '配信行を取り切れなかったため中止しました（部分取消を避けるため何も書いていません）。',
      code: 'cancel_deliveries_fetch_incomplete',
      detail: String((e && e.message) || 'unknown'),
      sideEffects: 'none',
    });
  }
  const targets = selectCancelableDeliveries({ jobId, deliveryRecords: deliveries });
  const deliveryFields = buildDeliveryCancelFields({ operationId, nowMs: now });
  if (!deliveryFields || !assertOnlyCancelFields(deliveryFields, DELIVERY_CANCEL_WRITABLE_FIELDS)) {
    return json(500, { error: 'field allow-list violation', sideEffects: 'none' });
  }
  let cancelledDeliveries = 0;
  for (const rec of targets) {
    const ok = await patchRecord({ KEY, BASE, table: DELIVERIES_TABLE, recordId: rec.id, fields: deliveryFields });
    if (ok) cancelledDeliveries += 1;
  }

  // 2) ジョブ自体を CANCELLED にする（配信行を確定させた後）
  const jobFields = buildJobCancelFields({ operationId, nowMs: now, previousNotes: job.fields?.Notes });
  if (!jobFields || !assertOnlyCancelFields(jobFields, JOB_CANCEL_WRITABLE_FIELDS)) {
    return json(500, { error: 'field allow-list violation', sideEffects: 'partial' });
  }
  const jobOk = await patchRecord({ KEY, BASE, table: SCHEDULED_TABLE, recordId: job.id, fields: jobFields });

  console.log('🛑 [admin-marketing] ジョブ取消:', { jobId, cancelledDeliveries, jobOk });
  return json(jobOk ? 200 : 500, {
    cancelled: jobOk,
    jobId,
    cancelledDeliveries,
    keptSent: deliveries.filter((r) => String(r.fields?.Status || '') === 'sent').length,
    sideEffects: 'ScheduledEmails / CampaignDeliveries のみ',
    notice: jobOk
      ? '送信予定を取り消しました。送信済みの配信は取り消していません。'
      : '取消に失敗しました。もう一度実行してください（同じ操作 ID なら二重には書きません）。',
  });
}

async function handleHistory({ KEY, BASE }) {
  // ⚠️ **配信台帳からは数えない。**
  //    `CampaignDeliveries` は 14,426 行（145 ページ / 実測 162 秒・2026-08-15）まで育っており、
  //    Function の実行時間（最大 26 秒）では**原理的に読み切れない**。
  //    4,000 行で黙って打ち切っていた頃は「動いているが数が嘘」だった。
  //    ジョブ台帳は 1 送信 = 1 行（マーケティング分 152 行）で、
  //    「いつ・どのキャンペーンを・何人へ流したか」はここで完結する。
  let jobRecords;
  try {
    jobRecords = await fetchAllStrict({
      KEY, BASE, table: SCHEDULED_TABLE, filterByFormula: MARKETING_JOB_FORMULA,
    });
  } catch (e) {
    return json(500, {
      error: '送信ジョブを取り切れなかったため、集計を返しません（部分集計は実績として出しません）。',
      code: 'history_fetch_incomplete',
      detail: String((e && e.message) || 'unknown'),
      sideEffects: 'none',
    });
  }
  // 配信行は読まない（counts は使わない）。ジョブ自身が持つ件数だけで組み立てる
  const jobRows = buildJobView({ jobRecords, deliveryRecords: [], isMarketingJob });
  return json(200, {
    runs: summarizeCampaignRunsFromJobs(jobRows),
    jobs: jobRows.length,
    /** 数の出所。**画面はこれを必ず出す**（台帳集計だと誤読させない） */
    source: 'scheduled-emails',
    notice: '送信ジョブ台帳の集計です。sent は「送信基盤が処理した」件数で、'
      + '実配信（delivered）とは別です。配信行 1 件ずつの状態（skipped 等）は'
      + '配信台帳が大きすぎて集計できないため出していません。',
  });
}

function countDomains(recipients) {
  const out = {};
  for (const r of recipients || []) {
    const d = String(r.email || '').split('@')[1] || '(unknown)';
    out[d] = (out[d] || 0) + 1;
  }
  return out;
}

/**
 * レコード 1 件の更新（取消でのみ使う）。
 * 呼び出し側が allow-list で列を固定してから渡すこと。応答本文は読まない（PII 混入の遮断）。
 */
async function patchRecord({ KEY, BASE, table, recordId, fields }) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}/${recordId}`, {
    method: 'PATCH',
    headers: { ...authHeaders(KEY), 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) console.error(`❌ [admin-marketing] ${table} PATCH failed: HTTP ${res.status}`);
  return res.ok;
}

async function createRecord({ KEY, BASE, table, fields }) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: { ...authHeaders(KEY), 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  });
  if (!res.ok) throw new Error(`${table} create failed: HTTP ${res.status}`);
  return res.json();
}

/** DeliveryKey を merge key にした upsert。同じ key は何度実行しても 1 行のまま。 */
/**
 * 指定した `DeliveryKey` の**行**を読む（read-only）。
 *
 * ⚠️ 読めなければ `null`（**0 件と言わない**）。呼び出し側が fail closed する。
 * ⚠️ 既存の名指し formula（`buildDeliveryKeyFormula`）を使う。全件走査しない。
 *
 * @returns {Promise<Map<string,{id:string,status:string}>|null>} key → 行
 */
async function readDeliveryRows({ KEY, BASE, campaign, keys }) {
  const list = (Array.isArray(keys) ? keys : []).map((k) => String(k || '').trim()).filter(Boolean);
  if (list.length === 0) return null;
  const campaignType = `${campaign.campaignId}:v${campaign.version}`;
  const out = new Map();
  for (let i = 0; i < list.length; i += 40) {
    const group = list.slice(i, i + 40);
    const formula = buildDeliveryKeyFormula({ campaignType, keys: group });
    if (!formula) return null;
    let rows;
    try {
      // eslint-disable-next-line no-await-in-loop -- 40 件ずつ名指し
      rows = await fetchAllStrict({
        KEY, BASE, table: DELIVERIES_TABLE, filterByFormula: formula,
        maxPages: TARGETED_MAX_PAGES, fields: ['DeliveryKey', 'Status'],
      });
    } catch {
      return null;                       // 読めない = 確認できない
    }
    if (!Array.isArray(rows)) return null;
    for (const r of rows) {
      const f = (r && r.fields) || {};
      const k = String(f.DeliveryKey || '').trim();
      if (k) out.set(k, { id: r.id, status: String(f.Status || '').trim() });
    }
  }
  return out;
}

/**
 * 「送ったことになる」行だけを鍵の集合にする。
 *
 * ⚠️ 判定は **`fetchDeliveredKeys` と同一**（`sent` / `queued` のみ）。
 *    `cancelled` / `failed` は既送信に数えない ＝ **再 queue の対象へ戻る**。
 *    ここを変えると二重送信の防壁と rollback 契約が食い違う。
 */
function activeDeliveryKeys(rows) {
  if (!(rows instanceof Map)) return null;
  const out = new Set();
  for (const [k, v] of rows) {
    const st = String((v && v.status) || '');
    if (st === 'sent' || st === 'queued') out.add(k);
  }
  return out;
}

/** 不足ぶんだけ冪等に補完する回数（`DeliveryKey` upsert なので行は増えない） */
const DELIVERY_COMPLETE_MAX_RETRY = 2;

/**
 * キュー登録の後始末。**例外・読めない・0 件・部分成功を同じ確定処理へ通す。**
 *
 * ⚠️ `upsertDeliveries` が投げても**ここへ来る**（投げっぱなしで 500 にしない）。
 *    ジョブと配信行の**実状態を read-only で数え直してから**次の処置を決める。
 *
 * 手順:
 *   A. 不足している `DeliveryKey` だけを**冪等に補完**し、読み戻して確認する
 *   B. それでも揃わなければ **既存の rollback 契約**で巻き戻す
 *      （配信行を `cancelled` にすると `fetchDeliveredKeys` の既送信集合から外れ、
 *        全員をそのまま再 queue できる。**新しい Status も削除も使わない**）
 */
async function settleQueueWrite({
  KEY, BASE, campaign, now, jobs, recipients, deliveryRecords, writeError,
}) {
  const expected = [...collectDeliveryKeys(recipients)];
  let rows = await readDeliveryRows({ KEY, BASE, campaign, keys: expected });
  let outcome = classifyQueueOutcome({
    recipients, builtCount: deliveryRecords.length, verifiedKeys: activeDeliveryKeys(rows),
  });

  // ── A. 不足だけ補完（部分成功・0 件・書き込み例外のいずれからも来る）──
  for (let attempt = 0; attempt < DELIVERY_COMPLETE_MAX_RETRY; attempt += 1) {
    if (outcome.ok || rows === null || outcome.reason !== QUEUE_FAIL.INCOMPLETE) break;
    const active = activeDeliveryKeys(rows) || new Set();
    const missing = deliveryRecords.filter((r) => !active.has(String(r.fields.DeliveryKey || '')));
    if (missing.length === 0) break;
    try {
      // eslint-disable-next-line no-await-in-loop -- 補完は最大 2 回
      await upsertDeliveries({ KEY, BASE, records: missing });
    } catch {
      // 投げても止めない。**次の読み戻しが実状態で判断する**
    }
    // eslint-disable-next-line no-await-in-loop
    rows = await readDeliveryRows({ KEY, BASE, campaign, keys: expected });
    outcome = classifyQueueOutcome({
      recipients, builtCount: deliveryRecords.length, verifiedKeys: activeDeliveryKeys(rows),
    });
  }
  if (outcome.ok) return { ok: true, outcome, writeError: writeError || null };

  // ── B. 巻き戻す（**ジョブだけ取り消して配信行を残さない**）────────
  const rollback = await rollbackQueue({
    KEY, BASE, campaign, now, jobs, rows, reason: outcome.reason,
  });
  return { ok: false, outcome, rollback, writeError: writeError || null };
}

/**
 * 配信行を確認できたジョブから**未検証の印を外す**（＝ dispatcher が送ってよい状態にする）。
 *
 * ⚠️ **外したことを読み戻して確かめる。** PATCH が 200 でも、実際に印が消えているかは
 *    別の話（他の実行が同時に書き戻すこともある）。確かめられなければ `ok:false` を返し、
 *    呼び出し側は成功と言わずに巻き戻す。
 * ⚠️ 印が最初から無い行（この修正より前に積まれたもの）は**そのまま成功扱い**にする。
 */
async function promoteVerifiedJobs({ KEY, BASE, jobs }) {
  const list = (Array.isArray(jobs) ? jobs : []).filter((j) => j && j.recordId && j.jobId);
  const report = { ok: false, targeted: list.length, promoted: 0, stillUnverified: null };
  if (list.length === 0) return { ...report, ok: true };

  for (const j of list) {
    let rows = null;
    try {
      // eslint-disable-next-line no-await-in-loop -- ジョブ 1 件ずつ名指し
      rows = await fetchAllStrict({
        KEY, BASE, table: SCHEDULED_TABLE, filterByFormula: `{JobId}='${j.jobId}'`,
        maxPages: TARGETED_MAX_PAGES, fields: ['JobId', 'Notes'],
      });
    } catch {
      return { ...report, stillUnverified: null };   // 読めない = 確認できない
    }
    const row = (rows || []).find((r) => String(((r && r.fields) || {}).JobId || '') === j.jobId);
    if (!row) return { ...report, stillUnverified: null };
    const notes = String((row.fields || {}).Notes || '');
    if (!hasUnverifiedMark(notes)) { report.promoted += 1; continue; }
    const fields = { Notes: clearUnverified(notes) };
    if (!assertOnlyScheduledFields(fields)) return { ...report };
    try {
      // eslint-disable-next-line no-await-in-loop -- 1 件ずつ
      const ok = await patchRecord({ KEY, BASE, table: SCHEDULED_TABLE, recordId: row.id, fields });
      if (!ok) return { ...report };
    } catch {
      return { ...report };
    }
    report.promoted += 1;
  }

  // 読み戻して「印が 1 つも残っていない」ことを確かめる
  let stillUnverified = 0;
  for (const j of list) {
    let rows = null;
    try {
      // eslint-disable-next-line no-await-in-loop -- 1 件ずつ名指し
      rows = await fetchAllStrict({
        KEY, BASE, table: SCHEDULED_TABLE, filterByFormula: `{JobId}='${j.jobId}'`,
        maxPages: TARGETED_MAX_PAGES, fields: ['JobId', 'Notes'],
      });
    } catch {
      return { ...report, stillUnverified: null };
    }
    const row = (rows || []).find((r) => String(((r && r.fields) || {}).JobId || '') === j.jobId);
    if (!row) return { ...report, stillUnverified: null };
    if (hasUnverifiedMark(String((row.fields || {}).Notes || ''))) stillUnverified += 1;
  }
  return { ...report, stillUnverified, ok: stillUnverified === 0 };
}

/**
 * 作りかけのキュー登録を**既存契約で**巻き戻す。
 *
 * ⚠️ **配信行を先に `cancelled` にしてからジョブを取り消す**（`handleCancelJob` と同じ順）。
 *    ジョブだけ取り消して配信行を `queued` のまま残すと、`fetchDeliveredKeys` が
 *    それを既送信として数え、**送っていない人が再 queue から永久に外れる**。
 * ⚠️ 取消は**確認できたぶんだけ**成功と数える。1 件でも確かめられなければ
 *    `ok:false`（呼び出し側は「取消しました」と言わない）。
 */
async function rollbackQueue({ KEY, BASE, campaign, now, jobs, rows, reason }) {
  const op = `queue-unconfirmed:${String(reason || 'unknown')}`.slice(0, 60);
  const report = {
    deliveriesTargeted: 0, deliveriesCancelled: 0, deliveriesFailed: 0,
    jobsTargeted: 0, jobsCancelled: 0, jobsFailed: 0,
    verified: false,
  };

  // ① 配信行（`queued` のものだけ）を取り消す
  const targets = [];
  if (rows instanceof Map) {
    for (const [, v] of rows) {
      if (v && String(v.status) === 'queued' && v.id) targets.push(v.id);
    }
  }
  report.deliveriesTargeted = targets.length;
  const deliveryFields = buildDeliveryCancelFields({ operationId: op, nowMs: now });
  if (deliveryFields && assertOnlyCancelFields(deliveryFields, DELIVERY_CANCEL_WRITABLE_FIELDS)) {
    for (const id of targets) {
      try {
        // eslint-disable-next-line no-await-in-loop -- 1 行ずつ
        const okRow = await patchRecord({
          KEY, BASE, table: DELIVERIES_TABLE, recordId: id, fields: deliveryFields,
        });
        if (okRow) report.deliveriesCancelled += 1; else report.deliveriesFailed += 1;
      } catch {
        report.deliveriesFailed += 1;
      }
    }
  } else {
    report.deliveriesFailed = targets.length;
  }

  // ② ジョブを取り消す
  const jobList = (Array.isArray(jobs) ? jobs : []).filter((j) => j && j.recordId);
  report.jobsTargeted = jobList.length;
  const jobFields = buildJobCancelFields({ operationId: op, nowMs: now });
  if (jobFields && assertOnlyCancelFields(jobFields, JOB_CANCEL_WRITABLE_FIELDS)) {
    for (const j of jobList) {
      try {
        // eslint-disable-next-line no-await-in-loop -- 1 ジョブずつ
        const okJob = await patchRecord({
          KEY, BASE, table: SCHEDULED_TABLE, recordId: j.recordId, fields: jobFields,
        });
        if (okJob) report.jobsCancelled += 1; else report.jobsFailed += 1;
      } catch {
        report.jobsFailed += 1;
      }
    }
  } else {
    report.jobsFailed = jobList.length;
  }

  // ③ **読み戻して確かめる**（「取り消したつもり」を成功にしない）
  /**
   * ⚠️ **「読めなかった」と「読めた結果 0 行」を分ける。**
   *    まだ 1 行も書いていない段階（`delivery_records_dropped`）は
   *    呼び出し側が**空の Map**（＝読めていて 0 行）を渡す。ここを `null` と
   *    同じに扱うと、完全に巻き戻せていても「確認できていない」と報告して
   *    安全な再 queue まで止めてしまう。
   */
  let stillActive = null;
  if (rows instanceof Map && rows.size === 0) {
    stillActive = new Set();                 // 生きている配信行はそもそも無い
  } else if (rows instanceof Map) {
    let verifiedRows = null;
    try {
      verifiedRows = await readDeliveryRows({ KEY, BASE, campaign, keys: [...rows.keys()] });
    } catch { verifiedRows = null; }
    stillActive = activeDeliveryKeys(verifiedRows);
  }
  let jobsStillPending = null;
  try {
    const after = await fetchAllStrict({
      KEY, BASE, table: SCHEDULED_TABLE,
      filterByFormula: `AND({Status}='PENDING',${MARKETING_JOB_FORMULA})`,
      maxPages: TARGETED_MAX_PAGES, fields: ['JobId', 'Status'],
    });
    const pendingIds = new Set((after || []).map((r) => String(((r && r.fields) || {}).JobId || '')));
    jobsStillPending = jobList.filter((j) => pendingIds.has(String(j.jobId))).length;
  } catch { jobsStillPending = null; }

  report.deliveriesStillActive = stillActive instanceof Set ? stillActive.size : null;
  report.jobsStillPending = jobsStillPending;
  // ⚠️ 判定は純粋関数が単一源（`rollback failure` を成功扱いしない）
  const verdict = summarizeRollback(report);
  report.verified = verdict.verified;
  report.verifyReason = verdict.reason;
  return { ok: report.verified, ...report };
}

/** Airtable は 1 base 5 req/sec。既存の取得側（`airtable-fetch.js`）と同じ間隔を空ける */
const AIRTABLE_PACE_MS = 220;
/** 一過性（429 / 5xx）だけ、この回数まで待って再試行する */
const UPSERT_MAX_RETRY = 3;

async function upsertDeliveries({ KEY, BASE, records }) {
  const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    // ⚠️ 1 回の呼び出しで最大 10 件（Airtable の performUpsert 上限）。
    //    ここは**冪等**（`DeliveryKey` をマージキーにした upsert）なので、
    //    再試行しても行は増えない。
    let lastStatus = 0;
    let ok = false;
    for (let attempt = 0; attempt <= UPSERT_MAX_RETRY; attempt += 1) {
      if (i > 0 || attempt > 0) {
        // eslint-disable-next-line no-await-in-loop -- 5rps を超えないための間隔
        await sleep(AIRTABLE_PACE_MS * (attempt + 1));
      }
      let res;
      try {
        // eslint-disable-next-line no-await-in-loop -- 10 件ずつ
        res = await fetch(`https://api.airtable.com/v0/${BASE}/${DELIVERIES_TABLE}`, {
          method: 'PATCH',
          headers: { ...authHeaders(KEY), 'Content-Type': 'application/json' },
          body: JSON.stringify({ performUpsert: { fieldsToMergeOn: ['DeliveryKey'] }, records: batch }),
        });
      } catch {
        lastStatus = 0;                       // 通信失敗も一過性として再試行
        continue;
      }
      if (res.ok) { ok = true; break; }
      lastStatus = res.status;
      // ⚠️ 4xx（429 以外）は投げ直しても直らない。**即座に諦める**
      if (res.status !== 429 && res.status < 500) break;
    }
    if (!ok) throw new Error(`${DELIVERIES_TABLE} upsert failed: HTTP ${lastStatus}`);
  }
}


/**
 * 大規模セグメントの**件数だけ**を返す（read-only・書き込み 0）。
 *
 * ── 個人情報を返さない ────────────────────────────────────────
 * AK 登録済みの無料ユーザーだけで約 1,300 名。外部保有リスト約 13,000 件を
 * 取り込めば 14,000 件規模になる。一覧 API と同じ形で
 * 顧客を返すと、**画面が固まるうえに個人情報を大量に送出**する。
 * ここが返すのは 母数 / 送信候補 / 除外数 / 除外理由別件数 / 条件ハッシュ と、
 * **匿名化した検証用サンプル（属性のみ）**だけ。宛先も recordId も返さない。
 *
 * ── 対象の正本はサーバー側 ────────────────────────────────────
 * 画面から recordId 一覧を受け取らない。条件（segmentId）だけを受け取り、
 * 対象はサーバーが評価する。
 *
 * ⚠️ 配信履歴の読み解きと配信基盤の設定取得は `crm/segmentInputs.js` に分離してある
 *    （この Function に宛先列や SendGrid のエンドポイントを持ち込まないため）。
 */
/**
 * セグメントの**名前だけ**を返す（Airtable を一切読まない）。
 *
 * 下見（`segments`）は 1 セグメントずつ数える設計にしたので、
 * 選択肢を並べるためだけに全セグメントを数える必要はない。
 * ここで件数を返さないのは意図的（**数えていないものを件数として出さない**）。
 */
function handleSegmentCatalog() {
  return json(200, {
    mode: 'segment-catalog',
    sideEffects: 'none',
    catalogVersion: SEGMENT_CATALOG_VERSION,
    segments: SEGMENTS.map((s) => ({
      segmentId: s.id,
      segmentName: s.name,
      description: s.description || '',
      requires: s.requires || [],
    })),
    notice: '件数はここでは数えません。セグメントを選んで「数える」を押してください。',
  });
}

async function handleSegments({ KEY, BASE, now, req }) {
  const wanted = String(req.segmentId || '').trim();
  if (wanted && !SEGMENT_IDS.includes(wanted)) {
    return json(400, { error: '未知のセグメントです', sideEffects: 'none' });
  }
  const sampleSize = Number.isInteger(req.sampleSize) ? Math.min(req.sampleSize, 20) : 0;

  // 🛡️ **セグメントは 1 つずつ下見する**（全セグメント一括 = 実質全件走査になるため）。
  //    Customers 15,962 件を無条件に読み切る道は取らない（Airtable の毎秒 5 リクエスト制限で
  //    最短 32 秒。同期 Function に入らず、途中で切ると件数が嘘になる）。
  if (!wanted) {
    return json(400, {
      ...describeNotNarrowable({
        what: 'セグメント下見',
        hint: 'セグメントを 1 つ選んでください（全セグメント一括の下見は行いません）。',
      }),
      segmentIds: SEGMENT_IDS,
    });
  }
  const segFormula = buildSegmentFormula(wanted);
  const loaded = await fetchCustomersBounded({
    KEY, BASE, formula: segFormula, what: `セグメント「${wanted}」の下見`,
  });
  if (!loaded.ok) {
    return json(loaded.body.code === SCAN_FAIL.NOT_NARROWABLE ? 400 : 500, {
      ...loaded.body,
      ...(segFormula ? {} : {
        hint: 'このセグメントの条件は Customers の列だけでは絞り込めません'
          + '（開封記録は配信台帳側にあります）。件数を確定できないため下見を行いません。',
      }),
    });
  }

  const { list, blacklistEmails, deliveries } = await loadCustomerMarketing({
    KEY, BASE, now, customers: loaded.records,
  });

  // 除外の材料。**確認できないものは fail closed**（送らない側へ倒す）
  const hard = blacklistEmails instanceof Set ? blacklistEmails : new Set();
  const blRows = await fetchAll({ KEY, BASE, table: 'EmailBlacklist' }).catch(() => null);
  const soft = new Set();
  if (Array.isArray(blRows)) {
    for (const row of blRows) {
      const addr = String((row.fields || {}).Email || '').trim().toLowerCase();
      if (addr) soft.add(addr);
    }
  }
  const provider = await fetchProviderSuppression({ apiKey: process.env.SENDGRID_API_KEY, now });

  // エンゲージメント（5 区分の件数・閾値・適用可否）。**実送信と同じ判定**を使う。
  // 適用できるときだけ `blockedEmails` が埋まり、セグメントの「送信できる人数」からも引かれる。
  const { view: engagementView, measurement } = await resolveEngagementView({ list, deliveries, now });

  const records = list.map((c) => ({ id: c.recordId, fields: c.fields }));
  const shared = {
    records, nowMs: now,
    blacklistHard: hard, blacklistSoft: soft,
    providerSuppressed: provider.ok ? provider.emails : null,
    lastContactAtMs: buildLastContactMap(deliveries),
    engagementBlockedEmails: engagementView.applied ? engagementView.blockedEmails : null,
    sampleSize,
  };
  // 候補は選んだセグメント専用に絞ってあるので、ここで別のセグメントを評価しない
  const results = [evaluateSegment({ ...shared, segmentId: wanted })];

  const engagement = {
    ...engagementResponse(engagementView, list),
    // click は tracking が無効だと常に 0。画面で「反応が無い」と読み違えないよう明示する
    clickTracking: isMarketingClickTrackingEnabled(process.env) ? 'enabled' : 'disabled',
    /** セグメント別に「今回 engagement 理由で除外される人数」（母数は選んだセグメント） */
    blockedBySegment: Object.fromEntries(
      results.map((r) => [r.segmentId, (r.byReason || {}).engagement_blocked || 0]),
    ),
  };

  return json(200, {
    mode: 'segment-preview',
    sideEffects: 'none',
    engagement,
    catalogVersion: SEGMENT_CATALOG_VERSION,
    evaluatedAt: new Date(now).toISOString(),
    providerSuppression: provider.ok
      ? { available: true, total: provider.total }
      : { available: false, note: '配信基盤の停止リストを確認できないため、全員を送信不可として数えています' },
    segments: results.map((r) => ({
      segmentId: r.segmentId, segmentName: r.segmentName, description: r.description,
      total: r.total, sendable: r.sendable, excluded: r.excluded,
      byReason: r.byReason, byReasonLabeled: r.byReasonLabeled,
      balanced: r.balanced, ignoredRecords: r.ignoredRecords,
      conditionHash: r.conditionHash, requires: r.requires,
      sample: r.sample,
    })),
    measurement,
    notice: 'これは件数の下見です。**まだ送信対象は固定されていません**（キュー登録も送信もしていません）。',
    labels: { exclude: SEG_EXCLUDE_LABEL },
  });
}
