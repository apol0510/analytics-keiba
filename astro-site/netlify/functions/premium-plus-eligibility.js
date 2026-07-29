/**
 * Premium Plus 販売対象の管理（管理画面専用）
 *
 * `/admin/premium-plus-eligibility` から呼ぶ。
 *   action='list'   … Plus 販売候補（ROUTE A / ROUTE B）を一覧で返す
 *   action='update' … 1 会員の販売資格を変更する。plusAction は次の 4 つ:
 *                     staged（段階公開で販売可）/ immediate（今すぐ販売可）/
 *                     review（保留）/ blocked（販売対象外）
 *   action='preview'… 1 会員の Premium Plus 表示状態を read-only で解決して返す（管理者プレビュー）。
 *                     **会員セッションを作らない / Cookie を触らない / 一切書き込まない。**
 *
 * 設計上の要点:
 * - **Premium Plus の販売資格だけ**を変更する。プラン / Status / 有効期限 / PaidAt /
 *   LifetimeSanrenpuku / メール状態は絶対に書かない（premiumPlusEligibility.js の
 *   allow-list で構造的に強制し、PATCH 直前にも assertOnlyPlusFields で再確認する）。
 * - 資格変更でメール・LINE・通知を送らない。課金も昇格も起こさない。
 * - 判定（route / eligibility / phase）は純粋関数の単一源を再利用する。
 *
 * 認可: x-admin-secret == PREMIUM_PLUS_ADMIN_SECRET（未設定なら 503 で無効）。
 * env: AIRTABLE_API_KEY / AIRTABLE_BASE_ID / PREMIUM_PLUS_ADMIN_SECRET /
 *      PREMIUM_PLUS_FIELDS_READY（本番フィールド作成後に '1'）
 */

import {
  PP_ELIGIBILITY,
  PP_ELIGIBILITY_LABEL,
  PP_ELIGIBILITY_FIELDS,
  PP_ROUTE,
  describeReleaseState,
  resolvePremiumPlusRelease,
} from '../../src/lib/premiumPlus/premiumPlusRelease.js';
import { resolvePlusMemberFromFields } from '../../src/lib/premiumPlus/premiumPlusMember.js';
import {
  buildPreviewSnapshot,
  describePreviewVisibility,
  PP_PREVIEW_TIMES,
  PP_PREVIEW_PHASES,
} from '../../src/lib/premiumPlus/premiumPlusPreview.js';
import {
  buildAdminActionFields,
  assertOnlyPlusFields,
  isPlusFieldsEnabled,
  isReleaseOverrideEnabled,
  PP_ADMIN_ACTION,
} from '../../src/lib/premiumPlus/premiumPlusEligibility.js';

const CUSTOMERS_TABLE = process.env.AIRTABLE_CUSTOMERS_TABLE || 'Customers';
/** 一覧取得のページ上限（暴走防止）。1 ページ 100 件。 */
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

function airtableHeaders(key) {
  return { Authorization: `Bearer ${key}` };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return json(200, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });

  const SECRET = process.env.PREMIUM_PLUS_ADMIN_SECRET;
  const KEY = process.env.AIRTABLE_API_KEY;
  const BASE = process.env.AIRTABLE_BASE_ID;

  if (!SECRET) return json(503, { error: 'PREMIUM_PLUS_ADMIN_SECRET 未設定（機能無効）' });
  const provided = event.headers?.['x-admin-secret'] || event.headers?.['X-Admin-Secret'];
  if (provided !== SECRET) return json(403, { error: 'Forbidden' });
  if (!KEY || !BASE) return json(500, { error: 'Airtable 認証情報が未設定' });

  let req;
  try { req = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
  const action = req.action || 'list';
  const now = Date.now();

  try {
    if (action === 'list') return await handleList({ KEY, BASE, now, onlyReview: !!req.onlyReview });
    if (action === 'update') return await handleUpdate({ KEY, BASE, now, req });
    if (action === 'preview') return await handlePreview({ KEY, BASE, now, req });
    return json(400, { error: `未知の action: ${action}` });
  } catch (e) {
    console.error('❌ [premium-plus-eligibility]', e.message);
    return json(500, { error: 'internal error' });
  }
};

async function handleList({ KEY, BASE, now, onlyReview }) {
  const rows = [];
  let offset;
  let pages = 0;
  let truncated = false;

  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE}/${CUSTOMERS_TABLE}`);
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);
    const res = await fetch(url, { headers: airtableHeaders(KEY) });
    if (!res.ok) return json(502, { error: `Airtable list failed: ${res.status}` });
    const data = await res.json();

    for (const rec of data.records || []) {
      const fields = rec.fields || {};
      const member = resolvePlusMemberFromFields(fields, { nowMs: now });
      const release = resolvePremiumPlusRelease({ ...member, nowMs: now });

      // Plus 候補（route あり）か、既に資格が設定済みのレコードだけを返す
      const hasExplicitEligibility = !!fields['PremiumPlusEligibility'];
      if (release.route === PP_ROUTE.NONE && !hasExplicitEligibility) continue;

      const eligibility = member.eligibility;
      if (onlyReview && eligibility !== PP_ELIGIBILITY.REVIEW) continue;

      rows.push({
        recordId: rec.id,
        email: fields['Email'] || '',
        name: fields['氏名'] || '',
        plan: fields['プラン'] || '',
        planType: fields['PlanType'] || '',
        hasSanrenpuku: member.hasSanrenpuku,
        premiumActive: member.premiumActive,
        daysSincePremium: release.daysSincePremium,
        route: release.route,
        eligibility,
        eligibilityLabel: PP_ELIGIBILITY_LABEL[eligibility],
        reason: fields['PremiumPlusEligibilityReason'] || '',
        releaseOverride: release.releaseOverride || '',
        overrideApplied: release.overrideApplied,
        state: describeReleaseState(release),
        eligibleAt: fields['PremiumPlusEligibleAt'] || '',
        updatedAt: fields['PremiumPlusEligibilityUpdatedAt'] || '',
        updatedBy: fields['PremiumPlusEligibilityUpdatedBy'] || '',
        phase: release.phase,
        sanrenpukuPaidAt: member.sanrenpukuPaidAtMs ? new Date(member.sanrenpukuPaidAtMs).toISOString() : '',
      });
    }

    offset = data.offset;
    pages += 1;
    if (offset && pages >= MAX_PAGES) { truncated = true; break; }
  } while (offset);

  // 保留（管理者確認待ち）を先頭に
  const order = { review: 0, eligible: 1, blocked: 2 };
  rows.sort((a, b) => (order[a.eligibility] - order[b.eligibility]) || String(a.email).localeCompare(String(b.email)));

  return json(200, {
    rows,
    counts: {
      total: rows.length,
      review: rows.filter((r) => r.eligibility === PP_ELIGIBILITY.REVIEW).length,
      eligible: rows.filter((r) => r.eligibility === PP_ELIGIBILITY.ELIGIBLE).length,
      blocked: rows.filter((r) => r.eligibility === PP_ELIGIBILITY.BLOCKED).length,
      routeA: rows.filter((r) => r.route === PP_ROUTE.SANRENPUKU).length,
      routeB: rows.filter((r) => r.route === PP_ROUTE.PREMIUM_30D).length,
      immediate: rows.filter((r) => r.overrideApplied).length,
    },
    writeEnabled: isPlusFieldsEnabled(process.env),
    overrideEnabled: isReleaseOverrideEnabled(process.env),
    truncated,
  });
}

async function handleUpdate({ KEY, BASE, now, req }) {
  // 本番 Airtable にフィールドが無い間は書かない（422 で他の更新まで落とさない）
  if (!isPlusFieldsEnabled(process.env)) {
    return json(503, {
      error: 'Premium Plus フィールドが未有効（PREMIUM_PLUS_FIELDS_READY 未設定）',
      hint: 'Airtable に PremiumPlusEligibility 系フィールドを作成後、env を 1 にしてください',
    });
  }

  const recordId = String(req.recordId || '').trim();
  if (!recordId) return json(400, { error: 'recordId が必要です' });

  // 変更前の資格を Airtable から読む（クライアント申告は信用しない）。
  // PremiumPlusEligibleAt を「eligible への実遷移のときだけ」更新するために必須。
  const getRes = await fetch(`https://api.airtable.com/v0/${BASE}/${CUSTOMERS_TABLE}/${recordId}`, {
    headers: airtableHeaders(KEY),
  });
  if (!getRes.ok) return json(404, { error: 'Record not found' });
  const currentFields = (await getRes.json()).fields || {};

  const overrideFieldEnabled = isReleaseOverrideEnabled(process.env);
  const plusAction = String(req.plusAction || '').trim().toLowerCase();

  // 「今すぐ販売可」は override フィールド未作成なら受け付けない（fail closed）
  if (plusAction === PP_ADMIN_ACTION.IMMEDIATE && !overrideFieldEnabled) {
    return json(503, {
      error: '「今すぐ販売可」は未有効（PremiumPlusReleaseOverride 未作成 / PREMIUM_PLUS_OVERRIDE_READY 未設定）',
      hint: 'Airtable に PremiumPlusReleaseOverride を作成後、env を 1 にしてください',
    });
  }

  const built = buildAdminActionFields({
    action: plusAction,
    current: currentFields[PP_ELIGIBILITY_FIELDS.STATUS],
    currentOverride: currentFields[PP_ELIGIBILITY_FIELDS.OVERRIDE],
    reason: req.reason,
    actor: req.actor || 'admin',
    now: new Date(now),
    overrideFieldEnabled,
  });
  if (!built) {
    return json(400, { error: 'plusAction は staged / immediate / review / blocked のいずれかです' });
  }

  // PATCH 直前の最終防衛（Plus 専用フィールド以外が混ざっていないか）
  if (!assertOnlyPlusFields(built.fields)) return json(500, { error: 'field allow-list violation' });

  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${CUSTOMERS_TABLE}/${recordId}`, {
    method: 'PATCH',
    headers: { ...airtableHeaders(KEY), 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: built.fields, typecast: true }),
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error('❌ [premium-plus-eligibility] PATCH failed:', res.status);
    return json(502, { error: 'Airtable update failed', status: res.status, detail: detail.slice(0, 300) });
  }

  console.log('✅ [premium-plus-eligibility] 販売資格を更新:', {
    recordId, action: plusAction, next: built.next,
    override: built.override, eligibleAtUpdated: built.eligibleAtUpdated,
  });
  return json(200, {
    success: true,
    recordId,
    action: plusAction,
    next: built.next,
    label: PP_ELIGIBILITY_LABEL[built.next],
    override: built.override,
    overrideChanged: built.overrideChanged,
    // true のときだけ段階公開 anchor が動く（= PHASE 1 から見え始める）
    eligibleAtUpdated: built.eligibleAtUpdated,
  });
}

/**
 * 管理者プレビュー（完全 read-only）。
 *
 * - Airtable は **GET のみ**。PATCH / POST / DELETE は一切行わない
 * - 会員セッション（ak_session）を作らない・Cookie を返さない・メールを送らない
 * - 判定は単一源（premiumPlusPreview → premiumPlusRelease）に委譲する
 * - 応答に Email / 氏名などの PII を含めない
 * - 時刻 / PHASE のシミュレーションはこの応答の中だけに閉じる（会員向けページには影響しない）
 */
async function handlePreview({ KEY, BASE, now, req }) {
  const recordId = String(req.recordId || '').trim();
  if (!recordId) return json(400, { error: 'recordId が必要です' });

  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${CUSTOMERS_TABLE}/${encodeURIComponent(recordId)}`, {
    headers: airtableHeaders(KEY),
  });
  if (!res.ok) return json(404, { error: 'Record not found' });
  const fields = (await res.json()).fields || {};

  const built = buildPreviewSnapshot({
    fields,
    nowMs: now,
    atMin: req.atMin,
    phaseDaysAgo: req.phaseDaysAgo,
  });
  if (!built.ok) {
    return json(400, { error: `プレビュー条件が不正です: ${built.reason}` });
  }

  return json(200, {
    preview: built.preview,
    visibility: describePreviewVisibility(built.preview),
    options: { times: PP_PREVIEW_TIMES, phases: PP_PREVIEW_PHASES },
    // 管理者が誤解しないための明示
    notice: '管理者プレビュー / 実顧客には影響しません',
  });
}
