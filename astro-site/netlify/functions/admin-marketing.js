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
 */

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
import { requiresOfferUrl, isLiveOffer } from '../../src/lib/promotions/offerCampaignLink.js';
import { OFFERS_TABLE, getOfferSecret } from '../../src/lib/promotions/promotionalOffer.js';
import {
  buildCampaignPlan,
  buildDeliveryRecords,
  chunkRecipients,
  summarizeHistory,
  summarizeCampaignRuns,
  computePlanFingerprint,
  assertOnlyDeliveryFields,
  MK_EXCLUSION_LABEL,
  MAX_RECIPIENTS_PER_SEND,
} from '../../src/lib/marketing/campaignSend.js';
import {
  fetchProviderSuppression,
  describeProviderSuppression,
} from '../../src/lib/marketing/providerSuppression.js';
import {
  isMarketingEnqueueEnabled,
  isMarketingDispatchEnabled,
} from '../../src/lib/marketing/marketingDispatchGate.js';
import {
  fetchEmailBlacklistReadOnly,
  buildBlacklistEmailSet,
  loadBlacklistEmails,
} from '../../src/lib/newsletter/airtable-fetch.js';
import { parseTestRecipientsEnv } from '../../src/lib/newsletter/test-recipients.js';
import { getBrandConfig, validateBrandFromEmail } from '../../src/lib/newsletter/brand-config.js';
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
    list, deliveries, magicLogins, blacklistStatus, blacklistSize: blacklistEmails.size,
    blacklistEmails,
  };
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
    if (action === 'history') return await handleHistory({ KEY, BASE });
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
    labels: { exclusion: MK_EXCLUSION_LABEL, suppression: MK_SUPPRESSION_LABEL },
    filters: {
      contract: Object.values(MK_CONTRACT),
      plan: Object.values(MK_PLAN),
      marketing: Object.values(MK_SEND),
    },
  });
}

/** 本文プレビュー（Airtable も SendGrid も触らない完全ローカル処理） */
function handlePreview({ req }) {
  // 停止中でも中身は確認できるようにする（送信経路ではないため）
  const campaign = getCampaign(req.campaignId, { includeDisabled: true });
  if (!campaign) return json(400, { error: '未知のキャンペーンです' });
  const rendered = renderCampaign({ campaign, name: req.sampleName });
  if (!rendered) return json(500, { error: 'テンプレート描画に失敗しました' });
  return json(200, {
    campaignId: campaign.campaignId,
    version: campaign.version,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    notice: 'プレビューのみ / 送信しません。配信停止リンクは送信時に自動付与されます。',
  });
}

async function handleCustomers({ KEY, BASE, now, req }) {
  const { list, blacklistStatus, blacklistSize } = await loadCustomerMarketing({
    KEY, BASE, now, withLogins: true,
  });

  const filter = {
    contract: req.contract, plan: req.plan, marketing: req.marketing,
    premiumPlus: req.premiumPlus, history: req.history,
  };
  // 最終ログインの絞り込みは既存フィルタと直交させる（判定モジュールを汚さない）
  const wantLogin = String(req.lastLogin || '').trim();
  const matched = list
    .filter((c) => matchesMarketingFilter(c.marketing, filter))
    .filter((c) => !wantLogin || loginSegment(c.daysSinceLogin) === wantLogin);

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
  }));

  return json(200, {
    rows,
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
 * 1 顧客のカルテ（read-only）。
 *
 * 「なぜこの人はログインできないのか / なぜ送信対象外なのか / 何を持っているのか」を
 * 1 リクエストで返す。判定は `customerDossier.js` へ委譲し、ここでは取得だけ行う。
 * provider suppression は失敗しても **カルテ自体は返す**（`null`＝不明として表示させる）。
 */
async function handleCustomerDetail({ KEY, BASE, now, req }) {
  const recordId = String(req.recordId || '').trim();
  if (!recordId) return json(400, { error: 'recordId が必要です' });

  const { list, deliveries, magicLogins, blacklistEmails } =
    await loadCustomerMarketing({ KEY, BASE, now, withLogins: true });
  const hit = list.find((c) => c.recordId === recordId);
  if (!hit) return json(404, { error: '該当する顧客が見つかりません' });

  const email = String(hit.fields.Email || '').trim().toLowerCase();

  // ソフトバウンスは販促では除外対象。HARD/COMPLAINT とは別枠で持つ（既存ヘルパーを再利用）
  const blacklist = await loadBlacklistSets({ KEY, BASE });

  const [offers, provider] = await Promise.all([
    fetchAll({ KEY, BASE, table: OFFERS_TABLE }).catch(() => []),
    fetchProviderSuppression({ apiKey: process.env.SENDGRID_API_KEY, now }).catch(() => ({ ok: false })),
  ]);

  const dossier = buildCustomerDossier({
    record: hit.record,
    nowMs: now,
    magicLinkAtMs: magicLogins.get(email) ?? null,
    offerRecords: offers,
    deliveryRecords: deliveries,
    blacklistEmails: blacklist.hard.size ? blacklist.hard : blacklistEmails,
    softBounceEmails: blacklist.soft,
    providerSuppressed: provider && provider.ok ? provider.emails : null,
    history: hit.marketing.history,
  });

  return json(200, {
    dossier,
    providerSuppression: describeProviderSuppression(provider),
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

  const recordIds = Array.isArray(req.recordIds) ? req.recordIds.map(String) : [];
  if (recordIds.length === 0) return json(400, { error: '送信対象が選択されていません' });
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

  const { list } = await loadCustomerMarketing({ KEY, BASE, now });
  const byId = new Map(list.map((c) => [c.recordId, c]));
  const selected = recordIds.map((id) => byId.get(id) || { recordId: id, fields: null, marketing: null });

  // 既送信突合（同一 campaignId:version）
  const priorDeliveries = await fetchAll({
    KEY, BASE, table: DELIVERIES_TABLE,
    filterByFormula: `AND({CampaignType}='${campaign.campaignId}:v${campaign.version}', OR({Status}='sent', {Status}='queued'))`,
  }).catch(() => []);
  const deliveredKeys = new Set(priorDeliveries.map((r) => String(r.fields?.DeliveryKey || '')).filter(Boolean));

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
    campaign, selected, deliveredKeys,
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
    subject: campaign.subject,
    offerSummary,
    selected: plan.counts.selected,
    excluded: plan.counts.excluded,
    willSend: plan.counts.recipients,
    excludedDetail,
    planFingerprint: plan.planFingerprint,
  };

  if (!live) {
    return json(200, {
      mode: 'dry-run',
      sideEffects: 'none',
      ...summary,
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

  const rendered = renderCampaign({ campaign, name: null }); // 1 ジョブ 1 本文（汎用呼びかけ）
  if (!rendered) return json(500, { error: 'テンプレート描画に失敗しました' });

  // 1) ScheduledEmails に PENDING ジョブを作る（実送信は送信基盤が担当）
  const jobIdByEmail = new Map();
  const jobs = [];
  const batches = chunkRecipients(plan.recipients);
  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const jobId = `mkt-${campaign.campaignId}-v${campaign.version}-${plan.planFingerprint.slice(0, 8)}-${i + 1}`;
    const created = await createRecord({
      KEY, BASE, table: SCHEDULED_TABLE,
      fields: {
        Subject: rendered.subject,
        Content: rendered.html,
        Recipients: batch.map((r) => r.email).join(', '),
        ScheduledFor: new Date(now).toISOString(),
        Status: 'PENDING',
        CreatedBy: 'admin-marketing',
        JobId: jobId,
        RecipientCount: batch.length,
        TargetPlan: `campaign:${campaign.campaignId}`,
        Notes: `marketing campaign ${campaign.campaignId} v${campaign.version}`,
      },
    });
    for (const r of batch) jobIdByEmail.set(r.email, { jobId, recordId: created?.id || null });
    jobs.push({ jobId, recipientCount: batch.length, recordId: created?.id || null });
  }

  // 2) CampaignDeliveries を DeliveryKey 冪等で upsert（二重送信の最終防壁）
  const deliveryRecords = buildDeliveryRecords({ campaign, recipients: plan.recipients, jobIdByEmail, nowMs: now });
  for (const rec of deliveryRecords) {
    if (!assertOnlyDeliveryFields(rec.fields)) return json(500, { error: 'field allow-list violation' });
  }
  await upsertDeliveries({ KEY, BASE, records: deliveryRecords });

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
