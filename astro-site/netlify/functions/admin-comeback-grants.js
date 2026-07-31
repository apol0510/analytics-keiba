/**
 * AK カムバック施策の管理（管理画面専用）
 *
 * `/admin/premium-plus-eligibility` の「🎁 カムバック特典」タブから呼ぶ。
 *   action='offers'    … 選べる特典（無料付与 / 割引）と gate 状態を返す（書き込みなし）
 *   action='customers' … 条件に一致する顧客一覧＋件数（read-only）
 *   action='preview'   … 選んだ特典から案内メール文面を生成して返す（**送信しない**）
 *   action='dryRun'    … 付与・発行の対象と理由別件数、顧客ごとの before/after を確定（書き込みなし）
 *   action='apply'     … dry-run で確定した内容を実行する
 *   action='revokeDryRun' / action='revoke' … 無料権利の取り消し（promotional grant だけ）
 *   action='offerList'   … 発行済み割引オファーの一覧（read-only。PII / token は返さない）
 *   action='offerRevokeDryRun' … 割引オファー 1 件の取り消し内容を確定（書き込みなし）
 *   action='offerRevoke' … 割引オファー 1 件を Status=revoked にする（Customers は触らない）
 *   action='reconcile' … operationId の適用状況を読み直して突合する（read-only）
 *
 * ── grant の取り消しと offer の取り消しを混ぜない ─────────────────
 *   revoke / revokeDryRun      … Customers の**特典カラム**を消す（＝閲覧権が減る）
 *   offerRevoke / ...DryRun    … PromotionalOffers の**1 行**だけ（＝購入条件が消えるだけ。
 *                                閲覧権も課金契約も動かない）
 *
 * ── 3 つの概念を混同しない ────────────────────────────────────────
 *   promotional grant … 無料の閲覧権。Customers の特典フィールドへ書く
 *   promotional offer … 割引の購入条件。PromotionalOffers へ 1 行積む。**権利は増えない**
 *   paid contract     … 通常購入の契約。この Function は**読むだけ**
 *
 * ── この Function は絶対にメールを送らない ───────────────────────────
 * SendGrid も ScheduledEmails も CampaignDeliveries も触らない（guard テストで固定）。
 * `preview` は文面を返すだけ。案内は付与・発行の完了後、管理者がマーケティングタブから送る。
 *
 * ── 課金・契約・販売資格を書き換えない ──────────────────────────────
 * 書き込むのは promotionalGrants.js / promotionalOffer.js の allowlist にあるフィールドだけ。
 * プラン / PlanType / Status / 有効期限 / PaidAt / PaymentConfirmed / PaymentEmailSent /
 * LifetimeSanrenpuku / PremiumPlus* / WithdrawalRequested は 1 バイトも書かない。
 *
 * ── gate ────────────────────────────────────────────────────────
 *   1. 認可: x-admin-secret（COMEBACK_ADMIN_SECRET があれば優先／無ければ PREMIUM_PLUS_ADMIN_SECRET）
 *   2. 特典フィールド: COMEBACK_GRANT_FIELDS_READY='1'
 *   3. offer 台帳:    COMEBACK_OFFER_TABLE_READY='1'
 *   4. 実行:          COMEBACK_GRANT_ENABLED='true'（既定 OFF）
 *   さらに apply / revoke は dry-run が返した planFingerprint と operationId が必須。
 */

import {
  buildComebackPlan,
  buildRevokePlan,
  buildOfferRecordsForPlan,
  assertPlanWritesOnlyGrantFields,
  chunkTargets,
  reconcileOperation,
  describeSelection,
  CB_SKIP_LABEL,
  MAX_GRANT_RECORDS,
} from '../../src/lib/comeback/comebackGrantPlan.js';
import {
  resolveComebackCustomer,
  matchesComebackFilter,
  summarizeComeback,
  CB_PROMO_FILTER,
  CB_GRANTABLE_FILTER,
} from '../../src/lib/comeback/comebackAudience.js';
import {
  OFFER_KIND,
  listOffers,
  resolveOffer,
  describeOffer,
  REGULAR_PRICE,
  CUSTOM_DAYS_RANGE,
  MIN_OFFER_PRICE,
} from '../../src/lib/promotions/promotionOfferCatalog.js';
import {
  OFFERS_TABLE,
  OFFER_STATUS,
  assertOnlyOfferFields,
  isOfferTableEnabled,
  getOfferSecret,
  DEFAULT_OFFER_TTL_DAYS,
} from '../../src/lib/promotions/promotionalOffer.js';
import {
  planOfferRevoke,
  listOffersForRevoke,
  computeOfferRevokeFingerprint,
  OFFER_REVOKE_SKIP_LABEL,
} from '../../src/lib/promotions/offerRevokePlan.js';
import { buildComebackEmailContent } from '../../src/lib/promotions/comebackEmailTemplate.js';
import {
  PROMO_TIER,
  PROMO_TIER_LABEL,
  PROMO_WRITABLE_FIELDS,
  PROMO_FORBIDDEN_FIELDS,
  isGrantFieldsEnabled,
  isGrantWriteEnabled,
  fmtDay,
} from '../../src/lib/entitlements/promotionalGrants.js';
import { MK_CONTRACT, MK_PLAN } from '../../src/lib/marketing/customerMarketingAudience.js';

const CUSTOMERS_TABLE = process.env.AIRTABLE_CUSTOMERS_TABLE || 'Customers';
/** 一覧で返す最大件数（PII をむやみに大量送出しない） */
const MAX_ROWS = 400;
const MAX_PAGES = 40;
/**
 * 割引オファーの申込ページ（トークン付き URL）。
 * ページ実装 = `src/pages/offer/index.astro` + `offer-lookup` / `offer-application`。
 * ここを変えるときは 3 か所（ページ・両 Function・案内メール）を必ず揃える。
 */
const OFFER_PATH = '/offer/';
const SITE = 'https://analytics.keiba.link';

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
    if (offset && pages >= MAX_PAGES) break;
  } while (offset);
  return out;
}

/** Customers（＋ offer 台帳）を読んで顧客ごとの判定を作る（read-only） */
async function loadCustomers({ KEY, BASE, now, withOffers = false }) {
  const records = await fetchAll({ KEY, BASE, table: CUSTOMERS_TABLE });
  const list = records.map((rec) => {
    const fields = rec.fields || {};
    return { recordId: rec.id, fields, view: resolveComebackCustomer({ fields, nowMs: now }) };
  });
  // offer 台帳が未作成なら「既存 offer なし」として扱う（一覧・dry-run は動く）
  const offers = withOffers
    ? await fetchAll({ KEY, BASE, table: OFFERS_TABLE }).catch(() => [])
    : [];
  return { list, byId: new Map(list.map((c) => [c.recordId, c])), offers };
}

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const SECRET = process.env.COMEBACK_ADMIN_SECRET || process.env.PREMIUM_PLUS_ADMIN_SECRET;
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
    if (action === 'offers') return handleOffers();
    if (action === 'preview') return handlePreview({ req, now });
    if (action === 'customers') return await handleCustomers({ KEY, BASE, now, req });
    if (action === 'dryRun') return await handlePlan({ KEY, BASE, now, req, live: false });
    if (action === 'apply') return await handlePlan({ KEY, BASE, now, req, live: true });
    if (action === 'revokeDryRun') return await handleRevoke({ KEY, BASE, now, req, live: false });
    if (action === 'revoke') return await handleRevoke({ KEY, BASE, now, req, live: true });
    if (action === 'offerList') return await handleOfferList({ KEY, BASE, now, req });
    if (action === 'offerRevokeDryRun') return await handleOfferRevoke({ KEY, BASE, now, req, live: false });
    if (action === 'offerRevoke') return await handleOfferRevoke({ KEY, BASE, now, req, live: true });
    if (action === 'reconcile') return await handleReconcile({ KEY, BASE, now, req });
    return json(400, { error: `未知の action: ${action}` });
  } catch (e) {
    console.error('❌ [admin-comeback-grants]', e.message);
    return json(500, { error: 'internal error' });
  }
};

function gateState() {
  return {
    fieldsReady: isGrantFieldsEnabled(process.env),
    offerTableReady: isOfferTableEnabled(process.env),
    writeEnabled: isGrantWriteEnabled(process.env),
    offerTokenReady: !!getOfferSecret(process.env),
  };
}

function handleOffers() {
  const gate = gateState();
  return json(200, {
    // Light（ベース特典）/ Premium 無料 / Premium 割引 を分けて返す（UI がそのまま 3 つの選択肢にする）
    lightOffers: listOffers({ tier: PROMO_TIER.LIGHT, kind: OFFER_KIND.GRANT }),
    premiumGrantOffers: listOffers({ tier: PROMO_TIER.PREMIUM, kind: OFFER_KIND.GRANT }),
    premiumPurchaseOffers: listOffers({ tier: PROMO_TIER.PREMIUM, kind: OFFER_KIND.PURCHASE }),
    tiers: Object.values(PROMO_TIER).map((t) => ({ tier: t, label: PROMO_TIER_LABEL[t] })),
    regularPrice: REGULAR_PRICE,
    customDaysRange: CUSTOM_DAYS_RANGE,
    minOfferPrice: MIN_OFFER_PRICE,
    offerTtlDays: DEFAULT_OFFER_TTL_DAYS,
    maxRecords: MAX_GRANT_RECORDS,
    labels: { skip: CB_SKIP_LABEL },
    filters: {
      contract: Object.values(MK_CONTRACT),
      plan: Object.values(MK_PLAN),
      promo: Object.values(CB_PROMO_FILTER),
      grantable: Object.values(CB_GRANTABLE_FILTER),
    },
    ...gate,
    notice: gate.writeEnabled
      ? '実行すると会員の閲覧権限が変わります（課金・入金状態・メールは変わりません）。'
      : '実行は無効（COMEBACK_GRANT_FIELDS_READY / COMEBACK_GRANT_ENABLED 未設定）。dry-run までは利用できます。',
  });
}

/**
 * 選択された特典を正規化する（無料付与 0〜2 件 + 割引 0〜1 件）。
 * 任意日数・任意価格の検証はカタログ側（resolveOffer）が行う。
 */
function resolveSelection(req) {
  const grantOffers = [];
  let purchaseOffer = null;

  for (const [id, custom] of [
    [req.lightOfferId, { customDays: req.lightCustomDays }],
    [req.premiumOfferId, { customDays: req.premiumCustomDays, customPrice: req.premiumCustomPrice }],
  ]) {
    if (!id || id === 'none') continue;
    const r = resolveOffer(id, custom);
    if (!r.ok) return { error: r.error, offerId: id };
    if (r.offer.kind === OFFER_KIND.GRANT) grantOffers.push(r.offer);
    else if (purchaseOffer) return { error: 'multiple_purchase_offers' };
    else purchaseOffer = r.offer;
  }
  if (grantOffers.length === 0 && !purchaseOffer) return { error: 'nothing_selected' };
  return { grantOffers, purchaseOffer };
}

/** 案内メールの文面プレビュー（Airtable にも SendGrid にも触らない・送信しない） */
function handlePreview({ req, now }) {
  const sel = resolveSelection(req);
  if (sel.error) return json(400, { error: `特典の指定が不正です: ${sel.error}` });
  const content = buildComebackEmailContent({
    grantOffers: sel.grantOffers,
    purchaseOffer: sel.purchaseOffer,
    offerUrl: sel.purchaseOffer ? `${SITE}${OFFER_PATH}?t=（顧客ごとのトークン）` : '',
    offerExpiresText: sel.purchaseOffer
      ? fmtDay(now + DEFAULT_OFFER_TTL_DAYS * 86400000) : '',
  });
  if (!content) return json(500, { error: '文面を生成できませんでした' });
  return json(200, {
    selection: describeSelection(sel),
    subject: content.subject,
    body: content.body,
    ctaLabel: content.ctaLabel,
    ctaUrl: content.ctaUrl,
    notice: 'プレビューのみ / 送信しません。案内メールは特典付与後にマーケティングタブから送ってください。',
  });
}

async function handleCustomers({ KEY, BASE, now, req }) {
  const { list } = await loadCustomers({ KEY, BASE, now });
  const filter = {
    contract: req.contract, plan: req.plan, history: req.history,
    withdrawn: req.withdrawn, promo: req.promo, grantable: req.grantable,
  };
  const matched = list.filter((c) => matchesComebackFilter(c.view, filter));

  const rows = matched.slice(0, MAX_ROWS).map((c) => {
    const v = c.view;
    return {
      recordId: c.recordId,
      email: v.marketing.email,
      name: c.fields['氏名'] || '',
      contract: v.marketing.contract,
      planGroup: v.marketing.plan,
      daysToExpiry: v.marketing.daysToExpiry,
      withdrawn: v.marketing.withdrawn,
      hasSanrenpuku: v.marketing.hasSanrenpuku,
      effectiveTier: v.effectiveTier,
      stateText: v.stateText,
      paidText: v.paidText,
      promoText: v.promoText,
      promoLight: v.promoLight,
      promoPremium: v.promoPremium,
      promoInconsistent: v.promoInconsistent,
      grantable: v.grantable,
      grantBlockedReason: v.grantBlockedReason,
      grantBlockedLabel: v.grantBlockedReason ? (CB_SKIP_LABEL[v.grantBlockedReason] || v.grantBlockedReason) : '',
      offerable: v.offerable,
      grantSource: v.grantSource,
      sendable: v.marketing.sendable, // 表示のみ（付与の条件にはしない）
    };
  });

  return json(200, {
    rows,
    matchedCount: matched.length,
    truncated: matched.length > rows.length,
    summary: summarizeComeback(list.map((c) => c.view)),
    totalCustomers: list.length,
    labels: { skip: CB_SKIP_LABEL },
    ...gateState(),
  });
}

/** dry-run（live=false）と 実行（live=true）の共通経路。対象確定は同じ関数で行う。 */
/* ────────────────────────────────────────────────────────────────
 * 割引オファーの取り消し（PromotionalOffers の 1 行だけ）
 *
 * grant revoke（handleRevoke）とは**別経路**。こちらは Customers を 1 バイトも読まないし
 * 書かない。オファーは購入条件であって閲覧権ではないので、取り消しても権限は動かない。
 *
 * gate は `COMEBACK_OFFER_TABLE_READY` のみ（＝台帳が存在すること）。
 * **`COMEBACK_GRANT_ENABLED` は要求しない**: 取り消しは「配ってしまった購入条件を消す」
 * 減算方向の安全操作であり、発行を緊急停止した直後こそ実行したい。発行の kill switch で
 * 取り消しまで止めると、誤発行が消せないまま残る。
 * ──────────────────────────────────────────────────────────────── */

/** 台帳の 1 行を取得する（見つからなければ null。404 を例外にしない） */
async function fetchOfferRecord({ KEY, BASE, offerRecordId }) {
  const url = `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(OFFERS_TABLE)}/${encodeURIComponent(offerRecordId)}`;
  const res = await fetch(url, { headers: authHeaders(KEY) });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`${OFFERS_TABLE} fetch failed: HTTP ${res.status}`);
  return await res.json();
}

/** 発行済みオファーの一覧（read-only）。PII / TokenHash / 生トークンは返さない。 */
async function handleOfferList({ KEY, BASE, now, req }) {
  if (!isOfferTableEnabled(process.env)) {
    return json(503, {
      error: 'オファー台帳が未作成です（COMEBACK_OFFER_TABLE_READY 未設定）',
      flag: 'COMEBACK_OFFER_TABLE_READY', sideEffects: 'none',
    });
  }
  const records = await fetchAll({ KEY, BASE, table: OFFERS_TABLE }).catch(() => []);
  const rows = listOffersForRevoke({
    records, nowMs: now,
    customerRecordId: req.customerRecordId ? String(req.customerRecordId) : '',
  });
  const counts = rows.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  return json(200, {
    rows: rows.slice(0, MAX_ROWS),
    total: rows.length,
    truncated: rows.length > MAX_ROWS,
    counts,
    labels: { skip: OFFER_REVOKE_SKIP_LABEL },
    notice: '取り消せるのは issued のオファーだけです。申込済み（redeemed）・期限切れ・取り消し済みは変更できません。',
    ...gateState(),
  });
}

/**
 * 割引オファー 1 件の取り消し。
 *
 * dry-run: 対象を読み、取り消し可否と `offerFingerprint` を返す（書き込みなし）。
 * 実行   : fingerprint を再計算して一致しなければ **409 で 1 バイトも書かない**。
 *          書くのは `buildOfferRevokeFields()` の戻り値（Status / Notes）だけ。
 */
async function handleOfferRevoke({ KEY, BASE, now, req, live }) {
  if (!isOfferTableEnabled(process.env)) {
    return json(503, {
      error: 'オファー台帳が未作成です（COMEBACK_OFFER_TABLE_READY 未設定）',
      flag: 'COMEBACK_OFFER_TABLE_READY', sideEffects: 'none',
    });
  }

  const offerRecordId = String(req.offerRecordId || '').trim();
  if (!offerRecordId) return json(400, { error: '対象のオファーが指定されていません', sideEffects: 'none' });
  // 1 件だけ。まとめて取り消す経路は作らない（誤操作の被害を 1 件に閉じ込める）
  if (Array.isArray(req.offerRecordIds)) {
    return json(400, { error: 'オファーの取り消しは 1 件ずつ行ってください', sideEffects: 'none' });
  }

  const reason = String(req.reason || '').slice(0, 150);
  const expect = {};
  if (req.operationId !== undefined) expect.operationId = String(req.operationId || '');
  if (req.customerRecordId !== undefined) expect.customerRecordId = String(req.customerRecordId || '');
  if (req.offerKey !== undefined) expect.offerKey = String(req.offerKey || '');

  const record = await fetchOfferRecord({ KEY, BASE, offerRecordId });
  const plan = planOfferRevoke({ record, nowMs: now, expect, reason });

  if (!plan.ok) {
    return json(record ? 409 : 404, {
      error: `取り消せません: ${OFFER_REVOKE_SKIP_LABEL[plan.reason] || plan.reason}`,
      reason: plan.reason,
      offer: plan.offer,
      sideEffects: 'none',
    });
  }

  if (!live) {
    return json(200, {
      mode: 'dry-run',
      sideEffects: 'none',
      offer: plan.offer,
      revocable: true,
      offerFingerprint: plan.fingerprint,
      willWriteFields: Object.keys(plan.fields),
      notice: 'この時点では何も書き込んでいません。取り消しても顧客の閲覧権・課金契約・入金状態は変わりません（メールも送信されません）。',
      ...gateState(),
    });
  }

  // ── live: dry-run と同一の状態であることを検証（TOCTOU 防止）──
  const token = String(req.offerFingerprint || '');
  if (!token) return json(400, { error: 'dry-run の確認トークンが必要です', sideEffects: 'none' });
  if (token !== plan.fingerprint) {
    return json(409, {
      error: 'オファーの状態が変化したため中止しました。もう一度 dry-run を実行してください。',
      expected: plan.fingerprint.slice(0, 12),
      got: token.slice(0, 12),
      sideEffects: 'none',
      howToRecover: '申込（redeemed）が入っていないかを確認してから、再度 dry-run → 取り消しを行ってください。',
    });
  }

  if (!assertOnlyOfferFields(plan.fields)) {
    return json(500, { error: 'offer field allow-list violation', sideEffects: 'none' });
  }

  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(OFFERS_TABLE)}`, {
    method: 'PATCH',
    headers: { ...authHeaders(KEY), 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [{ id: offerRecordId, fields: plan.fields }] }),
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error('❌ [admin-comeback-grants] Offer revoke failed:', res.status);
    return json(502, {
      error: 'オファーの取り消しに失敗しました（変更されていません）',
      status: res.status, detail: detail.slice(0, 300),
      sideEffects: 'none',
    });
  }
  const out = await res.json().catch(() => ({}));
  const after = (out.records && out.records[0]) || null;

  console.log('✅ [admin-comeback-grants] オファー取り消し:', {
    offerRecordId, offerId: plan.offer.offerId, operationId: plan.offer.operationId,
  });

  return json(200, {
    mode: 'revoked',
    offer: { ...plan.offer, status: OFFER_STATUS.REVOKED, rawStatus: OFFER_STATUS.REVOKED },
    offerFingerprint: after ? computeOfferRevokeFingerprint({ record: after }) : null,
    customersWritten: 0,
    emailSent: false,
    notice: '取り消しました。専用 URL は使えなくなります。顧客の閲覧権・課金契約・入金状態は変わっていません（メールも送信していません）。',
  });
}

async function handlePlan({ KEY, BASE, now, req, live }) {
  const sel = resolveSelection(req);
  if (sel.error) return json(400, { error: `特典の指定が不正です: ${sel.error}`, detail: sel.offerId || null });

  const recordIds = Array.isArray(req.recordIds) ? req.recordIds.map(String) : [];
  if (recordIds.length === 0) return json(400, { error: '対象が選択されていません' });
  if (recordIds.length > MAX_GRANT_RECORDS) {
    return json(400, { error: `選択が多すぎます（上限 ${MAX_GRANT_RECORDS} 件）` });
  }

  const needsGrantWrite = sel.grantOffers.length > 0;
  const needsOfferWrite = !!sel.purchaseOffer;

  // 🛡️ 実行は多段 gate。env が無ければ 1 バイトも書かずに 503。
  if (live) {
    if (needsGrantWrite && !isGrantFieldsEnabled(process.env)) {
      return json(503, {
        error: '特典フィールドが未作成です（COMEBACK_GRANT_FIELDS_READY 未設定）',
        flag: 'COMEBACK_GRANT_FIELDS_READY', sideEffects: 'none',
        hint: 'Airtable に特典フィールドを作成後、env を 1 にしてください。dry-run は今でも利用できます。',
      });
    }
    if (needsOfferWrite && !isOfferTableEnabled(process.env)) {
      return json(503, {
        error: 'オファー台帳が未作成です（COMEBACK_OFFER_TABLE_READY 未設定）',
        flag: 'COMEBACK_OFFER_TABLE_READY', sideEffects: 'none',
        hint: 'Airtable に PromotionalOffers テーブルを作成後、env を 1 にしてください。',
      });
    }
    if (!isGrantWriteEnabled(process.env)) {
      return json(503, {
        error: '実行は無効です（COMEBACK_GRANT_ENABLED 未設定）',
        flag: 'COMEBACK_GRANT_ENABLED', sideEffects: 'none',
        hint: 'dry-run で対象確定までは確認できます。有効化には承認と env 設定が必要です。',
      });
    }
  }

  const operationId = String(req.operationId || '').trim() || newOperationId(sel);
  if (live && !String(req.operationId || '').trim()) {
    return json(400, { error: 'operationId が必要です（dry-run の値をそのまま渡してください）' });
  }

  const { byId, offers } = await loadCustomers({ KEY, BASE, now, withOffers: needsOfferWrite });
  const selected = recordIds.map((id) => {
    const hit = byId.get(id);
    return { recordId: id, fields: hit ? hit.fields : null };
  });

  const plan = buildComebackPlan({
    grantOffers: sel.grantOffers,
    purchaseOffer: sel.purchaseOffer,
    selected,
    existingOffers: offers,
    nowMs: now,
    operationId,
    actor: String(req.actor || 'admin').slice(0, 64),
    source: req.source,
  });
  if (!plan.ok) return json(400, { error: `実行計画を作成できません: ${plan.error}` });

  const summary = {
    selection: describeSelection(sel),
    lightOffer: sel.grantOffers.find((o) => o.targetTier === PROMO_TIER.LIGHT)
      ? describeOffer(sel.grantOffers.find((o) => o.targetTier === PROMO_TIER.LIGHT)) : null,
    premiumOffer: sel.grantOffers.find((o) => o.targetTier === PROMO_TIER.PREMIUM)
      ? describeOffer(sel.grantOffers.find((o) => o.targetTier === PROMO_TIER.PREMIUM))
      : (sel.purchaseOffer ? describeOffer(sel.purchaseOffer) : null),
    purchaseOffer: sel.purchaseOffer ? {
      offerId: sel.purchaseOffer.offerId,
      regularPrice: sel.purchaseOffer.regularPrice,
      offerPrice: sel.purchaseOffer.offerPrice,
      discountPercent: sel.purchaseOffer.discountPercent,
      planName: sel.purchaseOffer.planName,
      planType: sel.purchaseOffer.planType,
    } : null,
    operationId,
    selected: plan.counts.selected,
    willGrant: plan.counts.willGrant,
    willOffer: plan.counts.willOffer,
    skipped: plan.counts.skipped,
    parts: plan.counts.parts,
    skippedDetail: Object.entries(plan.counts.byReason)
      .map(([reason, count]) => ({ reason, label: CB_SKIP_LABEL[reason] || reason, count }))
      .sort((a, b) => b.count - a.count),
    partSkipDetail: Object.entries(plan.counts.parts.partSkips)
      .map(([key, count]) => {
        const [part, reason] = key.split(':');
        return {
          part,
          partLabel: part === 'offer' ? '割引オファー' : (PROMO_TIER_LABEL[part] || part),
          reason,
          label: CB_SKIP_LABEL[reason] || reason,
          count,
        };
      })
      .sort((a, b) => b.count - a.count),
    planFingerprint: plan.planFingerprint,
  };

  if (!live) {
    return json(200, {
      mode: 'dry-run',
      sideEffects: 'none',
      ...summary,
      preview: plan.targets.slice(0, 50).map((t) => ({
        recordId: t.recordId,
        email: t.email,
        before: t.before.text,
        after: t.after.text,
        grants: t.grantParts.map((g) => g.label),
        offer: t.offer ? describeOffer(t.offer) : null,
        partial: t.partSkips.map((p) => ({
          part: p.part === 'offer' ? '割引オファー' : (PROMO_TIER_LABEL[p.part] || p.part),
          label: CB_SKIP_LABEL[p.reason] || p.reason,
        })),
      })),
      previewTruncated: plan.targets.length > 50,
      skippedPreview: plan.skipped.slice(0, 50).map((s) => ({
        recordId: s.recordId,
        reason: s.reason,
        label: CB_SKIP_LABEL[s.reason] || s.reason,
        before: s.before ? s.before.text : '',
      })),
      ...gateState(),
      notice: 'この時点では何も書き込んでいません。実行するには内容を確認のうえ確定してください。',
    });
  }

  // ── live: dry-run と同一の計画であることを検証（TOCTOU 防止）──
  const token = String(req.planFingerprint || '');
  if (!token) return json(400, { error: 'dry-run の確認トークンが必要です' });
  if (token !== plan.planFingerprint) {
    return json(409, {
      error: '対象の状態が変化したため中止しました。同じ operationId でもう一度 dry-run を実行してください。',
      expected: plan.planFingerprint.slice(0, 12),
      got: token.slice(0, 12),
      operationId,
      sideEffects: 'none',
    });
  }
  if (plan.targets.length === 0) return json(400, { error: '対象が 0 件です' });
  if (!assertPlanWritesOnlyGrantFields(plan.targets)) {
    return json(500, { error: 'field allow-list violation' });
  }

  // ── 1) 無料権利（Customers。1 顧客 1 PATCH ＝ 顧客単位で原子的）──
  const grantTargets = plan.targets.filter((t) => Object.keys(t.grantFields).length > 0);
  const granted = [];
  for (const batch of chunkTargets(grantTargets)) {
    const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}`, {
      method: 'PATCH',
      headers: { ...authHeaders(KEY), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        records: batch.map((t) => ({ id: t.recordId, fields: t.grantFields })),
        typecast: true,
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error('❌ [admin-comeback-grants] Customers PATCH failed:', res.status);
      return json(502, {
        error: '特典の付与に失敗しました（途中で中止・オファーは発行していません）',
        status: res.status, detail: detail.slice(0, 300),
        operationId,
        granted: granted.length,
        notAttempted: grantTargets.length - granted.length,
        offersIssued: 0,
        sideEffects: granted.length > 0 ? 'partial' : 'none',
        howToRecover: '同じ operationId で dry-run → 実行を再実行してください（適用済みは自動的に除外されます）',
      });
    }
    granted.push(...batch.map((t) => t.recordId));
  }

  // ── 2) 割引オファー（PromotionalOffers。権利は増えない）──
  const offerRows = buildOfferRecordsForPlan({
    targets: plan.targets, nowMs: now, operationId,
    source: req.source, ttlDays: req.offerTtlDays,
    secret: getOfferSecret(process.env),
  });
  for (const row of offerRows) {
    if (!assertOnlyOfferFields(row.fields)) return json(500, { error: 'offer field allow-list violation' });
  }
  const issued = [];
  for (const batch of chunkTargets(offerRows)) {
    const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(OFFERS_TABLE)}`, {
      method: 'PATCH',
      headers: { ...authHeaders(KEY), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        performUpsert: { fieldsToMergeOn: ['OfferKey'] },
        records: batch.map((r) => ({ fields: r.fields })),
        typecast: true,
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error('❌ [admin-comeback-grants] Offers upsert failed:', res.status);
      return json(502, {
        error: 'オファーの発行に失敗しました（無料付与は完了済み）',
        status: res.status, detail: detail.slice(0, 300),
        operationId,
        granted: granted.length,
        offersIssued: issued.length,
        sideEffects: 'partial',
        howToRecover: '同じ operationId で dry-run → 実行を再実行してください（付与済みは除外され、未発行のオファーだけが対象になります）',
      });
    }
    issued.push(...batch.map((r) => r.recordId));
  }

  console.log('✅ [admin-comeback-grants] 実行:', {
    operationId, granted: granted.length, offersIssued: issued.length,
  });

  return json(200, {
    mode: 'applied',
    ...summary,
    granted: granted.length,
    offersIssued: issued.length,
    // 生トークンは**この応答にだけ**現れる（Airtable にはハッシュしか保存しない）。
    // 案内メールの差し込みに使う。ログにも出さない。
    offerTokens: offerRows
      .filter((r) => r.token)
      .map((r) => ({ recordId: r.recordId, url: `${SITE}${OFFER_PATH}?t=${r.token}`, expiresAt: new Date(r.expiresMs).toISOString() })),
    emailSent: false,
    notice: '実行しました。案内メールは送信していません（マーケティングタブから別途送信してください）。',
  });
}

/** 取り消し（promotional grant だけ）。dry-run → confirm は付与と同じ形。 */
async function handleRevoke({ KEY, BASE, now, req, live }) {
  const tiers = Array.isArray(req.tiers) ? req.tiers.map(String) : [];
  const recordIds = Array.isArray(req.recordIds) ? req.recordIds.map(String) : [];
  if (recordIds.length === 0) return json(400, { error: '対象が選択されていません' });

  if (live && !isGrantWriteEnabled(process.env)) {
    return json(503, {
      error: '取り消しは無効です（COMEBACK_GRANT_ENABLED / COMEBACK_GRANT_FIELDS_READY 未設定）',
      sideEffects: 'none',
    });
  }

  const { byId } = await loadCustomers({ KEY, BASE, now });
  const selected = recordIds.map((id) => {
    const hit = byId.get(id);
    return { recordId: id, fields: hit ? hit.fields : null };
  });

  const plan = buildRevokePlan({
    tiers, selected, nowMs: now,
    actor: String(req.actor || 'admin').slice(0, 64),
    reason: req.reason,
  });
  if (!plan.ok) return json(400, { error: `取り消し計画を作成できません: ${plan.error}` });

  const summary = {
    tiers,
    tierLabels: tiers.map((t) => PROMO_TIER_LABEL[t] || t),
    selected: plan.counts.selected,
    willRevoke: plan.counts.willRevoke,
    skipped: plan.counts.skipped,
    skippedDetail: Object.entries(plan.counts.byReason)
      .map(([reason, count]) => ({ reason, label: CB_SKIP_LABEL[reason] || reason, count })),
    planFingerprint: plan.planFingerprint,
  };

  if (!live) {
    return json(200, {
      mode: 'dry-run',
      sideEffects: 'none',
      ...summary,
      preview: plan.targets.slice(0, 50).map((t) => ({
        recordId: t.recordId, email: t.email, before: t.before.text, after: t.after.text,
      })),
      ...gateState(),
      notice: 'この時点では何も書き込んでいません。取り消すのは無料権利だけで、有料契約・三連複買い切り・発行済みオファーは変わりません。',
    });
  }

  const token = String(req.planFingerprint || '');
  if (!token || token !== plan.planFingerprint) {
    return json(409, {
      error: '対象の状態が変化したため中止しました。もう一度 dry-run を実行してください。',
      sideEffects: 'none',
    });
  }
  if (plan.targets.length === 0) return json(400, { error: '取り消し対象が 0 件です' });
  if (!assertPlanWritesOnlyGrantFields(plan.targets)) {
    return json(500, { error: 'field allow-list violation' });
  }

  const applied = [];
  for (const batch of chunkTargets(plan.targets)) {
    const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}`, {
      method: 'PATCH',
      headers: { ...authHeaders(KEY), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        records: batch.map((t) => ({ id: t.recordId, fields: t.grantFields })),
        typecast: true,
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return json(502, {
        error: '取り消しに失敗しました（途中で中止）',
        status: res.status, detail: detail.slice(0, 300),
        revoked: applied.length,
        sideEffects: applied.length > 0 ? 'partial' : 'none',
        howToRecover: 'もう一度 dry-run → 取り消しを実行してください（取り消し済みは自動的に除外されます）',
      });
    }
    applied.push(...batch.map((t) => t.recordId));
  }

  console.log('✅ [admin-comeback-grants] 無料権利を取り消し:', { tiers, revoked: applied.length });
  return json(200, { mode: 'revoked', ...summary, revoked: applied.length, emailSent: false });
}

/** operationId の適用状況を読み直して突合する（read-only） */
async function handleReconcile({ KEY, BASE, now, req }) {
  const operationId = String(req.operationId || '').trim();
  if (!operationId) return json(400, { error: 'operationId が必要です' });
  const recordIds = Array.isArray(req.recordIds) ? req.recordIds.map(String) : [];

  const { byId, offers } = await loadCustomers({ KEY, BASE, now, withOffers: true });
  const targets = (recordIds.length ? recordIds : [...byId.keys()])
    .map((id) => ({ recordId: id, fields: byId.get(id)?.fields || {} }));

  const result = reconcileOperation({ operationId, records: targets, offerRecords: offers, nowMs: now });
  return json(200, {
    mode: 'reconcile',
    sideEffects: 'none',
    operationId,
    ...result.counts,
    missingRecordIds: result.missing.slice(0, 100),
    offerStatuses: OFFER_STATUS,
    notice: result.counts.missing === 0
      ? 'この操作の対象はすべて適用済みです。'
      : '未適用が残っています。同じ operationId で dry-run → 実行すると残りだけが対象になります。',
  });
}

/** 操作 ID（冪等性の鍵）。同じ ID の再実行は already_applied になる。 */
function newOperationId(sel) {
  const lead = (sel.grantOffers[0] || sel.purchaseOffer || {}).offerId || 'comeback';
  const rand = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : Math.floor(Math.random() * 0xffffffff).toString(16);
  return `cb-${lead}-${new Date().toISOString().slice(0, 10)}-${rand}`;
}

// guard テストが参照する定数（実装から外れないように再エクスポート）
export const COMEBACK_WRITABLE_FIELDS = PROMO_WRITABLE_FIELDS;
export const COMEBACK_FORBIDDEN_FIELDS = PROMO_FORBIDDEN_FIELDS;
