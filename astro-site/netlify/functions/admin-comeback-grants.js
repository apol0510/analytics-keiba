/**
 * AK カムバック特典管理（管理画面専用）
 *
 * `/admin/premium-plus-eligibility` の「🎁 カムバック特典」タブから呼ぶ。
 *   action='offers'   … 選べるオファーと gate 状態を返す（書き込みなし）
 *   action='customers'… 条件に一致する顧客一覧＋件数（read-only）
 *   action='dryRun'   … 付与対象・理由別の除外件数・顧客ごとの before/after を確定（書き込みなし）
 *   action='grant'    … dry-run で確定した対象へ特典を付与する（Customers の特典フィールドのみ）
 *   action='revokeDryRun' / action='revoke' … 特典の取り消し（promotional grant だけ）
 *   action='reconcile'… operationId の適用状況を読み直して突合する（read-only）
 *
 * ── この Function は絶対にメールを送らない ───────────────────────────
 * SendGrid も ScheduledEmails も CampaignDeliveries も触らない（guard テストで固定）。
 * 特典付与と案内メールは**別操作**。付与成功後に管理者がマーケティングタブで送る。
 *
 * ── 課金・契約・販売資格を書き換えない ──────────────────────────────
 * 書き込むのは promotionalGrants.js の allowlist にある**特典専用フィールドだけ**。
 * プラン / PlanType / Status / 有効期限 / PaidAt / PaymentConfirmed / PaymentEmailSent /
 * LifetimeSanrenpuku / PremiumPlus* / WithdrawalRequested は 1 バイトも書かない。
 * PATCH 直前にも assertPlanWritesOnlyGrantFields で再確認する。
 *
 * ── 三重ガード ──────────────────────────────────────────────────
 *   1. 認可: x-admin-secret（COMEBACK_ADMIN_SECRET があれば優先／無ければ PREMIUM_PLUS_ADMIN_SECRET）
 *   2. フィールド gate: COMEBACK_GRANT_FIELDS_READY='1'（本番 Airtable に列を作るまで書けない）
 *   3. 実行 gate: COMEBACK_GRANT_ENABLED='true'（既定 OFF。承認後に立てる）
 *   さらに grant/revoke は dry-run が返した planFingerprint と operationId が必須。
 */

import {
  buildGrantPlan,
  buildRevokePlan,
  computeGrantPlanFingerprint,
  assertPlanWritesOnlyGrantFields,
  chunkTargets,
  reconcileOperation,
  describeOfferEffect,
  getOffer,
  COMEBACK_OFFERS,
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
  PROMO_GRANT,
  PROMO_GRANT_LABEL,
  PROMO_WRITABLE_FIELDS,
  PROMO_FORBIDDEN_FIELDS,
  PREMIUM_TRIAL_DAYS,
  isGrantFieldsEnabled,
  isGrantWriteEnabled,
} from '../../src/lib/entitlements/promotionalGrants.js';
import { MK_CONTRACT, MK_PLAN } from '../../src/lib/marketing/customerMarketingAudience.js';

const CUSTOMERS_TABLE = process.env.AIRTABLE_CUSTOMERS_TABLE || 'Customers';
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

async function fetchAllCustomers({ KEY, BASE }) {
  const out = [];
  let offset;
  let pages = 0;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers: authHeaders(KEY) });
    if (!res.ok) throw new Error(`Customers fetch failed: HTTP ${res.status}`);
    const data = await res.json();
    out.push(...(data.records || []));
    offset = data.offset;
    pages += 1;
    if (offset && pages >= MAX_PAGES) break;
  } while (offset);
  return out;
}

/** Customers を読んで顧客ごとの判定を作る（read-only） */
async function loadCustomers({ KEY, BASE, now }) {
  const records = await fetchAllCustomers({ KEY, BASE });
  const list = records.map((rec) => {
    const fields = rec.fields || {};
    return {
      recordId: rec.id,
      fields,
      view: resolveComebackCustomer({ fields, nowMs: now }),
    };
  });
  return { list, byId: new Map(list.map((c) => [c.recordId, c])) };
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
    if (action === 'customers') return await handleCustomers({ KEY, BASE, now, req });
    if (action === 'dryRun') return await handlePlan({ KEY, BASE, now, req, live: false });
    if (action === 'grant') return await handlePlan({ KEY, BASE, now, req, live: true });
    if (action === 'revokeDryRun') return await handleRevoke({ KEY, BASE, now, req, live: false });
    if (action === 'revoke') return await handleRevoke({ KEY, BASE, now, req, live: true });
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
    writeEnabled: isGrantWriteEnabled(process.env),
  };
}

function handleOffers() {
  const now = Date.now();
  const gate = gateState();
  return json(200, {
    offers: COMEBACK_OFFERS.map((o) => ({
      offerId: o.offerId,
      name: o.name,
      description: o.description,
      grants: o.grants,
      effect: describeOfferEffect(o, now),
    })),
    grantTypes: Object.values(PROMO_GRANT).map((g) => ({ grantType: g, label: PROMO_GRANT_LABEL[g] })),
    trialDays: PREMIUM_TRIAL_DAYS,
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
      ? '特典付与は有効です。実行すると会員の閲覧権限が変わります（課金・メールは変わりません）。'
      : (gate.fieldsReady
        ? '特典付与は無効（COMEBACK_GRANT_ENABLED 未設定）。dry-run までは利用できます。'
        : '特典フィールドが未作成（COMEBACK_GRANT_FIELDS_READY 未設定）。dry-run までは利用できます。'),
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
      plan: c.fields['プラン'] || '',
      contract: v.marketing.contract,
      planGroup: v.marketing.plan,
      daysToExpiry: v.marketing.daysToExpiry,
      withdrawn: v.marketing.withdrawn,
      hasSanrenpuku: v.marketing.hasSanrenpuku,
      stateText: v.stateText,
      paidText: v.paidText,
      promoText: v.promoText,
      promoLight: v.promoLight,
      promoTrialActive: v.promoTrialActive,
      promoTrialExpired: v.promoTrialExpired,
      promoInconsistent: v.promoInconsistent,
      grantable: v.grantable,
      grantBlockedReason: v.grantBlockedReason,
      grantBlockedLabel: v.grantBlockedReason ? (CB_SKIP_LABEL[v.grantBlockedReason] || v.grantBlockedReason) : '',
      grantSource: v.grantSource,
      // 送信可否は表示のみ（特典付与の条件にはしない）
      sendable: v.marketing.sendable,
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

/** dry-run（live=false）と 実付与（live=true）の共通経路。対象確定は同じ関数で行う。 */
async function handlePlan({ KEY, BASE, now, req, live }) {
  const offer = getOffer(req.offerId);
  if (!offer) return json(400, { error: '未知のオファーです' });

  const recordIds = Array.isArray(req.recordIds) ? req.recordIds.map(String) : [];
  if (recordIds.length === 0) return json(400, { error: '対象が選択されていません' });
  if (recordIds.length > MAX_GRANT_RECORDS) {
    return json(400, { error: `選択が多すぎます（上限 ${MAX_GRANT_RECORDS} 件）` });
  }

  // 🛡️ 実付与は二重 gate。env が無ければ 1 バイトも書かずに 503。
  if (live && !isGrantFieldsEnabled(process.env)) {
    return json(503, {
      error: '特典フィールドが未作成です（COMEBACK_GRANT_FIELDS_READY 未設定）',
      flag: 'COMEBACK_GRANT_FIELDS_READY',
      sideEffects: 'none',
      hint: 'Airtable に特典フィールドを作成後、env を 1 にしてください。dry-run は今でも利用できます。',
    });
  }
  if (live && !isGrantWriteEnabled(process.env)) {
    return json(503, {
      error: '特典付与は無効です（COMEBACK_GRANT_ENABLED 未設定）',
      flag: 'COMEBACK_GRANT_ENABLED',
      sideEffects: 'none',
      hint: 'dry-run で対象確定までは確認できます。有効化には承認と env 設定が必要です。',
    });
  }

  // 実行時は操作 ID 必須（冪等性の鍵）。dry-run では未指定なら新規発行する。
  const operationId = String(req.operationId || '').trim() || newOperationId(offer.offerId);
  if (live && !String(req.operationId || '').trim()) {
    return json(400, { error: 'operationId が必要です（dry-run の値をそのまま渡してください）' });
  }

  const { byId } = await loadCustomers({ KEY, BASE, now });
  const selected = recordIds.map((id) => {
    const hit = byId.get(id);
    return { recordId: id, fields: hit ? hit.fields : null };
  });

  const plan = buildGrantPlan({
    offer,
    selected,
    nowMs: now,
    operationId,
    actor: String(req.actor || 'admin').slice(0, 64),
    source: req.source,
  });
  if (!plan.ok) return json(400, { error: `付与計画を作成できません: ${plan.error}` });

  const summary = {
    offerId: offer.offerId,
    offerName: offer.name,
    effect: describeOfferEffect(offer, now),
    operationId,
    selected: plan.counts.selected,
    willGrant: plan.counts.willGrant,
    skipped: plan.counts.skipped,
    skippedDetail: Object.entries(plan.counts.byReason)
      .map(([reason, count]) => ({ reason, label: CB_SKIP_LABEL[reason] || reason, count }))
      .sort((a, b) => b.count - a.count),
    planFingerprint: plan.planFingerprint,
  };

  if (!live) {
    return json(200, {
      mode: 'dry-run',
      sideEffects: 'none',
      ...summary,
      // 顧客ごとの before/after（メールは含めるが名前は返さない）
      preview: plan.targets.slice(0, 50).map((t) => ({
        recordId: t.recordId,
        email: t.email,
        before: t.before.text,
        after: t.after.text,
        grants: t.applied.map((a) => PROMO_GRANT_LABEL[a.grantType]),
        partial: t.skippedParts.map((p) => ({
          grant: PROMO_GRANT_LABEL[p.grantType],
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
      notice: 'この時点では何も書き込んでいません。付与するには内容を確認のうえ実行してください。',
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
  if (plan.targets.length === 0) return json(400, { error: '付与対象が 0 件です' });

  // PATCH 直前の最終防衛（特典フィールド以外が 1 つでも混ざったら書かない）
  if (!assertPlanWritesOnlyGrantFields(plan.targets)) {
    return json(500, { error: 'field allow-list violation' });
  }

  // ── 書き込み（10 件ずつ。1 顧客の複合特典は 1 レコードなので顧客単位では原子的）──
  const applied = [];
  const failed = [];
  const batches = chunkTargets(plan.targets);
  for (const batch of batches) {
    const res = await fetch(`https://api.airtable.com/v0/${BASE}/${encodeURIComponent(CUSTOMERS_TABLE)}`, {
      method: 'PATCH',
      headers: { ...authHeaders(KEY), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        records: batch.map((t) => ({ id: t.recordId, fields: t.fields })),
        typecast: true,
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error('❌ [admin-comeback-grants] PATCH failed:', res.status);
      failed.push(...batch.map((t) => t.recordId));
      // 以降のバッチは実行しない（部分適用を最小限に留め、状態を確定させる）
      const remaining = plan.targets
        .filter((t) => !applied.includes(t.recordId) && !failed.includes(t.recordId))
        .map((t) => t.recordId);
      return json(502, {
        error: 'Airtable への書き込みに失敗しました（途中で中止）',
        status: res.status,
        detail: detail.slice(0, 300),
        operationId,
        applied: applied.length,
        failed: failed.length,
        notAttempted: remaining.length,
        sideEffects: applied.length > 0 ? 'partial' : 'none',
        howToRecover: '同じ operationId で dry-run → 付与を再実行してください（適用済みは自動的に除外されます）',
      });
    }
    applied.push(...batch.map((t) => t.recordId));
  }

  console.log('✅ [admin-comeback-grants] 特典を付与:', {
    offerId: offer.offerId, operationId, granted: applied.length,
  });

  return json(200, {
    mode: 'granted',
    ...summary,
    granted: applied.length,
    operationId,
    emailSent: false,
    notice: '特典を付与しました。案内メールは送信していません（マーケティングタブから別途送信してください）。',
  });
}

/** 取り消し（promotional grant だけ）。dry-run → confirm は付与と同じ形。 */
async function handleRevoke({ KEY, BASE, now, req, live }) {
  const grantTypes = Array.isArray(req.grantTypes) ? req.grantTypes.map(String) : [];
  const recordIds = Array.isArray(req.recordIds) ? req.recordIds.map(String) : [];
  if (recordIds.length === 0) return json(400, { error: '対象が選択されていません' });

  if (live && !isGrantWriteEnabled(process.env)) {
    return json(503, {
      error: '特典の取り消しは無効です（COMEBACK_GRANT_ENABLED / COMEBACK_GRANT_FIELDS_READY 未設定）',
      sideEffects: 'none',
    });
  }

  const { byId } = await loadCustomers({ KEY, BASE, now });
  const selected = recordIds.map((id) => {
    const hit = byId.get(id);
    return { recordId: id, fields: hit ? hit.fields : null };
  });

  const plan = buildRevokePlan({
    grantTypes, selected, nowMs: now,
    actor: String(req.actor || 'admin').slice(0, 64),
    reason: req.reason,
  });
  if (!plan.ok) return json(400, { error: `取り消し計画を作成できません: ${plan.error}` });

  const summary = {
    grantTypes,
    grantLabels: grantTypes.map((g) => PROMO_GRANT_LABEL[g] || g),
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
        recordId: t.recordId, email: t.email,
        before: t.before.text, after: t.after.text,
      })),
      ...gateState(),
      notice: 'この時点では何も書き込んでいません。取り消すのは無料特典だけで、有料契約・三連複買い切りは変わりません。',
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
        records: batch.map((t) => ({ id: t.recordId, fields: t.fields })),
        typecast: true,
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return json(502, {
        error: 'Airtable への書き込みに失敗しました（途中で中止）',
        status: res.status, detail: detail.slice(0, 300),
        revoked: applied.length,
        sideEffects: applied.length > 0 ? 'partial' : 'none',
        howToRecover: 'もう一度 dry-run → 取り消しを実行してください（取り消し済みは自動的に除外されます）',
      });
    }
    applied.push(...batch.map((t) => t.recordId));
  }

  console.log('✅ [admin-comeback-grants] 特典を取り消し:', { grantTypes, revoked: applied.length });
  return json(200, { mode: 'revoked', ...summary, revoked: applied.length, emailSent: false });
}

/** operationId の適用状況を読み直して突合する（read-only） */
async function handleReconcile({ KEY, BASE, now, req }) {
  const operationId = String(req.operationId || '').trim();
  if (!operationId) return json(400, { error: 'operationId が必要です' });
  const recordIds = Array.isArray(req.recordIds) ? req.recordIds.map(String) : [];

  const { byId } = await loadCustomers({ KEY, BASE, now });
  const targets = (recordIds.length ? recordIds : [...byId.keys()])
    .map((id) => ({ recordId: id, fields: byId.get(id)?.fields || {} }));

  const result = reconcileOperation({ operationId, records: targets, nowMs: now });
  return json(200, {
    mode: 'reconcile',
    sideEffects: 'none',
    operationId,
    ...result.counts,
    missingRecordIds: result.missing.slice(0, 100),
    notice: result.counts.missing === 0
      ? 'この操作の対象はすべて適用済みです。'
      : '未適用が残っています。同じ operationId で dry-run → 付与を実行すると残りだけが対象になります。',
  });
}

/** 操作 ID（冪等性の鍵）。同じ ID の再実行は各フィールドで already_applied になる。 */
function newOperationId(offerId) {
  const rand = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID().slice(0, 8)
    : Math.floor(Math.random() * 0xffffffff).toString(16);
  return `cb-${offerId}-${new Date().toISOString().slice(0, 10)}-${rand}`;
}

// guard テストが参照する定数（実装から外れないように再エクスポート）
export const COMEBACK_WRITABLE_FIELDS = PROMO_WRITABLE_FIELDS;
export const COMEBACK_FORBIDDEN_FIELDS = PROMO_FORBIDDEN_FIELDS;
