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
  summarizeCampaignRuns,
  computePlanFingerprint,
  computeCampaignContentHash,
  assertOnlyDeliveryFields,
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
  SEGMENT_IDS, SEGMENT_CATALOG_VERSION, evaluateSegment, SEG_EXCLUDE_LABEL,
} from '../../src/lib/crm/audienceSegments.js';
import { buildLastContactMap, readMeasurementSettings } from '../../src/lib/crm/segmentInputs.js';
import { measuredCount } from '../../src/lib/crm/deliveryMeasurement.js';
import { getBrandConfig, validateBrandFromEmail } from '../../src/lib/newsletter/brand-config.js';
import { EMAIL_EVENTS_TABLE as EMAIL_EVENTS_TABLE_NAME } from '../../src/lib/webhooks/emailEventLedger.js';
import { validateSelection } from '../../src/lib/marketing/adminMultiFilter.js';
import {
  chunkList, buildRecordIdFormula, buildDeliveryKeyFormula, assertFetchComplete,
  summarizeTargetedFetch, TARGETED_CHUNK, TARGETED_MAX_PAGES,
} from '../../src/lib/marketing/marketingTargetedLoad.js';
import {
  resolveDeliveryStoreMode, resolveDeliveredKeys, recordDelivered,
} from '../../src/lib/marketing/deliveryKeySource.js';
import { createDeliveryKeyStore, makeRedisCmd } from '../../src/lib/marketing/deliveryKeyStore.js';
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

/** Customers + EmailBlacklist + 自分のキャンペーン履歴を読み、顧客ごとの判定を作る（read-only）。 */
async function loadCustomerMarketing({ KEY, BASE, now, withLogins = false }) {
  const [customers, deliveries, tokens] = await Promise.all([
    fetchAll({ KEY, BASE, table: CUSTOMERS_TABLE }),
    fetchAll({ KEY, BASE, table: DELIVERIES_TABLE, filterByFormula: `{EmailType}='campaign'` })
      .catch(() => []), // 履歴が読めなくても一覧は出す（履歴なし扱い）
    // ログイン列は補助情報。読めなくても一覧・送信判定は成立させる
    withLogins
      ? fetchAll({ KEY, BASE, table: AUTH_TOKENS_TABLE }).catch(() => [])
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
  return { list, records };
}

/** 頻度ガード用に、指定アドレスの配信履歴だけを引く。 */
async function fetchDeliveriesByEmails({ KEY, BASE, emails }) {
  const out = [];
  for (const group of chunkList(emails, TARGETED_CHUNK)) {
    const safe = group.filter((e) => !e.includes("'"));
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
    if (action === 'dryRun') return await handlePlan({ KEY, BASE, now, req, live: false });
    if (action === 'send') return await handlePlan({ KEY, BASE, now, req, live: true });
    if (action === 'segments') return await handleSegments({ KEY, BASE, now, req });
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
  const campaign = getCampaign(req.campaignId, { includeDisabled: true });
  if (!campaign) return json(400, { error: '未知のキャンペーンです' });
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
  const { list, blacklistStatus, blacklistSize } = await loadCustomerMarketing({
    KEY, BASE, now, withLogins: true,
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
    segments: summarizeSegments(list.map((c) => c.marketing)),
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
  const uniq = [...new Map(mine.map((o) => [o.id, o])).values()];
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

  const { list, deliveries, tokens, magicLogins, blacklistEmails } =
    await loadCustomerMarketing({ KEY, BASE, now, withLogins: true });
  const hit = list.find((c) => c.recordId === recordId);
  if (!hit) return json(404, { error: '該当する顧客が見つかりません' });

  const email = String(hit.fields.Email || '').trim().toLowerCase();

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
async function handlePlan({ KEY, BASE, now, req, live }) {
  const campaign = getCampaign(req.campaignId);
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
  // ⚠️ 引き継ぎだけは「誰が付与されたか」を Customers 側から探すため全件走査が要る。
  //    通常の選択送信（recordIds 指定）は名指し取得だけで済ませ、全件走査へ落とさない。
  let handoffView = null;
  let targetIds = recordIds;
  if (grantOperationId) {
    const { list } = await loadCustomerMarketing({ KEY, BASE, now });
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

  const plan = buildCampaignPlan({
    campaign: sending, selected, deliveredKeys,
    providerSuppressed: provider.ok ? provider.emails : null,
    softBounced: blacklist.soft,
    audienceContext: buildAudienceContext(process.env),
    brand: BRAND, fromEmail, nowMs: now,
    offerRecords, offerSecret: getOfferSecret(process.env),
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
    if (!assertOnlyScheduledFields(jobFields)) return json(500, { error: 'field allow-list violation' });
    const created = await createRecord({ KEY, BASE, table: SCHEDULED_TABLE, fields: jobFields });
    for (const r of batch) jobIdByEmail.set(r.email, { jobId, recordId: created?.id || null });
    jobs.push({ jobId, recipientCount: batch.length, recordId: created?.id || null });
  }

  // 2) CampaignDeliveries を DeliveryKey 冪等で upsert（二重送信の最終防壁）
  const deliveryRecords = buildDeliveryRecords({ campaign, recipients: plan.recipients, jobIdByEmail, nowMs: now });
  for (const rec of deliveryRecords) {
    if (!assertOnlyDeliveryFields(rec.fields)) return json(500, { error: 'field allow-list violation' });
  }
  // 🛡️ 記録先も単一源に従う。既定は Airtable のみ。`dual` は Redis へも SADD する。
  //    Airtable 側の失敗は従来どおり致命（台帳が欠ける）。Redis 側の失敗は dual なら
  //    致命にせず、差分は scripts/reconcile-delivery-stores.mjs で拾う。
  const deliveryWrite = await recordDelivered({
    mode: deliveryStoreMode,
    keys: plan.recipients.map((r) => r.deliveryKey).filter(Boolean),
    writeAirtable: () => upsertDeliveries({ KEY, BASE, records: deliveryRecords }),
    writeRedis: async (keys) => {
      const store = createDeliveryKeyStore({ redisCmd: makeRedisCmd(process.env) });
      await store.markDelivered({ ...deliveryStoreScope, keys });
    },
  });
  if (deliveryWrite.redis === 'failed') {
    console.warn('⚠️ [admin-marketing] delivery store redis write failed（Airtable が正本のため継続）');
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
  const [scheduled, deliveries] = await Promise.all([
    fetchAll({ KEY, BASE, table: SCHEDULED_TABLE }).catch(() => []),
    fetchAll({ KEY, BASE, table: DELIVERIES_TABLE, filterByFormula: `{EmailType}='campaign'` }).catch(() => []),
  ]);
  const jobs = buildJobView({ jobRecords: scheduled, deliveryRecords: deliveries, isMarketingJob });
  return json(200, {
    jobs,
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

  const scheduled = await fetchAll({
    KEY, BASE, table: SCHEDULED_TABLE, filterByFormula: `{JobId}='${jobId}'`,
  }).catch(() => []);
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
  const deliveries = await fetchAll({
    KEY, BASE, table: DELIVERIES_TABLE, filterByFormula: `{ScheduledEmailJobId}='${jobId}'`,
  }).catch(() => []);
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
  const deliveries = await fetchAll({ KEY, BASE, table: DELIVERIES_TABLE, filterByFormula: `{EmailType}='campaign'` })
    .catch(() => []);
  return json(200, {
    runs: summarizeCampaignRuns(deliveries),
    total: deliveries.length,
    notice: 'Status=sent は「送信基盤が処理した」を意味します。実配信（delivered）とは別です。',
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
async function upsertDeliveries({ KEY, BASE, records }) {
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const res = await fetch(`https://api.airtable.com/v0/${BASE}/${DELIVERIES_TABLE}`, {
      method: 'PATCH',
      headers: { ...authHeaders(KEY), 'Content-Type': 'application/json' },
      body: JSON.stringify({ performUpsert: { fieldsToMergeOn: ['DeliveryKey'] }, records: batch }),
    });
    if (!res.ok) throw new Error(`${DELIVERIES_TABLE} upsert failed: HTTP ${res.status}`);
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
async function handleSegments({ KEY, BASE, now, req }) {
  const wanted = String(req.segmentId || '').trim();
  if (wanted && !SEGMENT_IDS.includes(wanted)) {
    return json(400, { error: '未知のセグメントです', sideEffects: 'none' });
  }
  const sampleSize = Number.isInteger(req.sampleSize) ? Math.min(req.sampleSize, 20) : 0;

  const { list, blacklistEmails, deliveries } = await loadCustomerMarketing({ KEY, BASE, now });

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

  const records = list.map((c) => ({ id: c.recordId, fields: c.fields }));
  const shared = {
    records, nowMs: now,
    blacklistHard: hard, blacklistSoft: soft,
    providerSuppressed: provider.ok ? provider.emails : null,
    lastContactAtMs: buildLastContactMap(deliveries),
    sampleSize,
  };
  const ids = wanted ? [wanted] : SEGMENT_IDS;
  const results = ids.map((id) => evaluateSegment({ ...shared, segmentId: id }));

  // 計測状態（「0 件」と「計測していない」を画面で混同させないため一緒に返す）
  const measurement = await readMeasurementSettings({ apiKey: process.env.SENDGRID_API_KEY });

  return json(200, {
    mode: 'segment-preview',
    sideEffects: 'none',
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
