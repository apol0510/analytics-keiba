/**
 * Premium Plus 販売対象の管理（管理画面専用）
 *
 * `/admin/premium-plus-eligibility` から呼ぶ。
 *   action='list'   … Plus 販売候補を一覧で返す。**表示条件は公開条件と別**（premiumPlusAdminAudience.js）。
 *                     ROUTE A / ROUTE B に加え、有効 Premium 会員で加入日（PaidAt）が無い旧会員・
 *                     加入 30 日未満の会員も「管理者レビュー候補」として返す。
 *                     一覧に出すこと自体は販売資格を一切与えない（eligibility は未設定のまま = 保留）。
 *   action='update' … 1 会員の販売資格を変更する。plusAction は次の 4 つ:
 *                     staged（段階公開で販売可）/ immediate（今すぐ販売可）/
 *                     review（保留）/ blocked（販売対象外）
 *   action='preview'… 1 会員の Premium Plus 表示状態を read-only で解決して返す（管理者プレビュー）。
 *                     **会員セッションを作らない / Cookie を触らない / 一切書き込まない。**
 *   action='setUpsell'… 販売導線（UpsellTarget: auto / sanrenpuku / plus / none）を 1 会員へ設定する。
 *                     ⚠️ これは「**何を売る導線を見せるか**」だけ。販売資格（PremiumPlusEligibility）
 *                     や会員権・決済には一切触れない。役割を混同しない。
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
import {
  resolveAdminCandidate,
  PP_CANDIDATE,
  buildAdminCandidateFormula,
} from '../../src/lib/premiumPlus/premiumPlusAdminAudience.js';
import {
  UPSELL_TARGET,
  UPSELL_TARGET_FIELD,
  UPSELL_TARGET_LABEL,
  normalizeUpsellTarget,
  readUpsellTarget,
  isUpsellFieldEnabled,
  resolveUpsellForCustomer,
  describeUpsellDisplay,
} from '../../src/lib/upsell/upsellTarget.js';
import { explainUpsell, UPSELL_AUTO_RULE_TEXT } from '../../src/lib/upsell/upsellExplain.js';
import { resolveEntitlements, fromAirtableFields } from '../../src/lib/entitlements/resolveEntitlements.js';
import { describeSanrenpukuHolding } from '../../src/lib/entitlements/sanrenpukuDisplay.js';

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
    if (action === 'lookup') return await handleLookup({ KEY, BASE, now, req });
    if (action === 'update') return await handleUpdate({ KEY, BASE, now, req });
    if (action === 'preview') return await handlePreview({ KEY, BASE, now, req });
    if (action === 'setUpsell') return await handleSetUpsell({ KEY, BASE, now, req });
    return json(400, { error: `未知の action: ${action}` });
  } catch (e) {
    console.error('❌ [premium-plus-eligibility]', e.message);
    return json(500, { error: 'internal error' });
  }
};


/**
 * 1 レコード → 管理一覧の 1 行。**list と lookup で同じ組み立てを使う**
 * （別々に書くと「一覧の値」と「個別検索の値」がズレる）。
 * `candidate.listed` は呼び出し側が判断に使う（ここでは落とさない）。
 */
function buildAdminRow(rec, now) {
    const fields = rec.fields || {};
    const member = resolvePlusMemberFromFields(fields, { nowMs: now });
    // 販売導線（UpsellTarget）込みの実表示。管理者が「設定値」と「実際に見えるもの」を
    // 区別できるように、両方を行に載せる。段階表示（何日目か）は localStorage 由来のため
    // サーバーでは確定できず、'三連複（段階表示）' として返す。
    // 「自動ならどうなるか」も併せて求める（管理者が手動指定中でも比較できるようにする）。
    // explain が内部で resolveUpsellForCustomer を呼ぶので、ここで二重に解決しない。
    const explain = explainUpsell({ fields, nowMs: now });
    const upsell = explain.effectiveView;
    const release = upsell.plusRelease;
    // 表示用（判定はしない）。canViewSanrenpuku は権限正本の値をそのまま使う。
    const srp = describeSanrenpukuHolding(resolveEntitlements(fromAirtableFields(fields), now));

    // 一覧に出すかは**表示専用の単一源**が決める（公開判定 resolvePremiumPlusRelease とは別）。
    // route が none でも「有効 Premium だが PaidAt が空な旧会員」を落とさないため。
    const candidate = resolveAdminCandidate({ fields, member, release });

    const eligibility = member.eligibility;
  return {
        /** 一覧に出す対象か（呼び出し側が判断に使う。lookup は false でも返す） */
        __listed: candidate.listed === true,
        recordId: rec.id,
        email: fields['Email'] || '',
        name: fields['氏名'] || '',
        plan: fields['プラン'] || '',
        planType: fields['PlanType'] || '',
        hasSanrenpuku: member.hasSanrenpuku,
        // 三連複保有の**表示**（判定は resolveEntitlements が正本。ここは日本語化のみ）。
        // 「プラン=Premium + LifetimeSanrenpuku=true」の現行形式と
        // 「プラン=Premium Sanrenpuku」の旧形式を、一覧で同じバッジで見分けられるようにする。
        sanrenpukuBadge: srp.badge,
        sanrenpukuLabel: srp.label,
        sanrenpukuNote: srp.note,
        sanrenpukuBasis: srp.basis,
        premiumActive: member.premiumActive,
        daysSincePremium: release.daysSincePremium,
        route: release.route,
        // 一覧に出した理由（表示専用。販売資格ではない）
        candidateKind: candidate.kind,
        candidateLabel: candidate.label,
        daysUntilRouteB: candidate.daysUntilRouteB,
        releaseBlockedBy: candidate.releaseBlockedBy,
        candidateNote: candidate.note,
        eligibility,
        eligibilityLabel: PP_ELIGIBILITY_LABEL[eligibility],
        // 販売導線（設定値 / 実表示 / 理由）
        upsellTarget: upsell.target,
        upsellTargetLabel: UPSELL_TARGET_LABEL[upsell.target],
        upsellChannel: upsell.channel,
        upsellDisplay: describeUpsellDisplay(upsell),
        upsellReason: upsell.reasonLabel,
        // 具体的な理由と「自動ならどうなるか」（管理画面の詳細で並べて出す）
        upsellReasonText: explain.reasonText,
        upsellChannelLabel: explain.channelLabel,
        upsellIsManual: explain.isManual,
        upsellAutoChannel: explain.autoChannel,
        upsellAutoChannelLabel: explain.autoChannelLabel,
        upsellAutoDisplay: explain.autoDisplay,
        upsellAutoReasonText: explain.autoReasonText,
        upsellDiffersFromAuto: explain.differsFromAuto,
        daysSincePremiumText: explain.daysSincePremiumText,
        routeLabel: explain.routeLabel,
        reason: fields['PremiumPlusEligibilityReason'] || '',
        releaseOverride: release.releaseOverride || '',
        overrideApplied: release.overrideApplied,
        state: describeReleaseState(release),
        eligibleAt: fields['PremiumPlusEligibleAt'] || '',
        updatedAt: fields['PremiumPlusEligibilityUpdatedAt'] || '',
        updatedBy: fields['PremiumPlusEligibilityUpdatedBy'] || '',
        phase: release.phase,
        sanrenpukuPaidAt: member.sanrenpukuPaidAtMs ? new Date(member.sanrenpukuPaidAtMs).toISOString() : '',
  };
}

/**
 * Email で 1 件だけ直接引く（**候補集合の外も引ける**）。
 *
 * 一覧は「販売候補になり得る人」だけへ絞り込んでいるので、
 * 無料会員など候補外の人は一覧に出ない。管理者が「あの人はどうなっている？」を
 * 確認できるよう、**検索だけは絞り込みを迂回**する。
 * 行の組み立ては一覧と同じ `buildAdminRow`（値がズレない）。
 */
async function handleLookup({ KEY, BASE, now, req }) {
  const email = String((req && req.email) || '').trim().toLowerCase();
  if (!email) return json(400, { error: 'email を指定してください' });
  // Airtable formula の文字列リテラルを壊さない
  const safe = email.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  const res = await fetch(
    `https://api.airtable.com/v0/${BASE}/${CUSTOMERS_TABLE}/listRecords`,
    {
      method: 'POST',
      headers: { ...airtableHeaders(KEY), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pageSize: 10,
        filterByFormula: `LOWER(TRIM({Email})) = '${safe}'`,
      }),
    },
  );
  if (!res.ok) return json(502, { error: `Airtable lookup failed: ${res.status}` });
  const data = await res.json();
  const recs = data.records || [];
  if (recs.length === 0) return json(200, { found: false, rows: [], sideEffects: 'none' });

  const rows = recs.map((rec) => {
    const row = buildAdminRow(rec, now);
    return {
      ...row,
      /** 一覧の絞り込み対象に入っているか（false = 検索でしか出てこない人） */
      inCandidateSet: row.__listed === true,
    };
  });
  return json(200, { found: true, rows, sideEffects: 'none' });
}

async function handleList({ KEY, BASE, now, onlyReview }) {
  const rows = [];
  let offset;
  let pages = 0;
  let truncated = false;

  // 🛡️ **Airtable 側で候補になり得ない人を落としてから読む**（全件走査しない）。
  //    無フィルタ全件走査は Customers 15,962 件で MAX_PAGES に当たり、
  //    販売資格者が黙って消えていた（2026-08-13）。formula は超集合（premiumPlusAdminAudience）。
  const candidateFormula = buildAdminCandidateFormula();

  do {
    const res = await fetch(
      `https://api.airtable.com/v0/${BASE}/${CUSTOMERS_TABLE}/listRecords`,
      {
        method: 'POST',
        headers: { ...airtableHeaders(KEY), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pageSize: 100,
          filterByFormula: candidateFormula,
          // Airtable の既定順（ビュー順）に結果が左右されないよう明示的に固定する
          sort: [{ field: 'Email', direction: 'asc' }],
          ...(offset ? { offset } : {}),
        }),
      },
    );
    if (!res.ok) return json(502, { error: `Airtable list failed: ${res.status}` });
    const data = await res.json();

    for (const rec of data.records || []) {
      const row = buildAdminRow(rec, now);
      if (!row.__listed) continue;
      if (onlyReview && row.eligibility !== PP_ELIGIBILITY.REVIEW) continue;
      rows.push(row);
    }

    offset = data.offset;
    pages += 1;
    // **黙って打ち切らない**。上限に当たったら「数え切れていない」ことを返して止める
    // （少ない件数を正しい件数として見せない）。
    if (offset && pages >= MAX_PAGES) {
      return json(500, {
        error: '候補の取得が上限に達しました。件数を確定できないため一覧を返しません。',
        code: 'candidate_scan_limit',
        pagesFetched: pages,
        maxPages: MAX_PAGES,
        sideEffects: 'none',
      });
    }
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
      // route 未成立のまま一覧に出している区分（表示専用。販売資格は付与していない）
      waiting30d: rows.filter((r) => r.candidateKind === PP_CANDIDATE.WAITING_30D).length,
      anchorMissing: rows.filter((r) => r.candidateKind === PP_CANDIDATE.ANCHOR_MISSING).length,
    },
    upsellCounts: {
      auto: rows.filter((r) => r.upsellTarget === UPSELL_TARGET.AUTO).length,
      sanrenpuku: rows.filter((r) => r.upsellTarget === UPSELL_TARGET.SANRENPUKU).length,
      plus: rows.filter((r) => r.upsellTarget === UPSELL_TARGET.PLUS).length,
      none: rows.filter((r) => r.upsellTarget === UPSELL_TARGET.NONE).length,
    },
    writeEnabled: isPlusFieldsEnabled(process.env),
    overrideEnabled: isReleaseOverrideEnabled(process.env),
    upsellEnabled: isUpsellFieldEnabled(process.env),
    // 「自動」の意味を管理画面に常設するための文言（正本は upsellExplain.js）
    upsellAutoRules: UPSELL_AUTO_RULE_TEXT,
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
/**
 * 販売導線（UpsellTarget）を 1 会員へ設定する。
 *
 * ⚠️ 書くのは `UpsellTarget` **1 列だけ**。販売資格（PremiumPlusEligibility 系）も
 *    会員権・決済フィールドも触らない。役割を混同しない。
 * ⚠️ Airtable にフィールドを作るまでは 503（未作成フィールドへの PATCH は 422 になり、
 *    同じ PATCH の他の更新まで巻き添えで失敗するため）。
 */
async function handleSetUpsell({ KEY, BASE, now, req }) {
  if (!isUpsellFieldEnabled(process.env)) {
    return json(503, {
      error: '販売導線フィールドが未有効（UPSELL_TARGET_FIELD_READY 未設定）',
      hint: `Airtable Customers に ${UPSELL_TARGET_FIELD}（単一選択: auto / sanrenpuku / plus / none）を作成後、env を 1 にしてください`,
      sideEffects: 'none',
    });
  }

  const recordId = String(req.recordId || '').trim();
  if (!recordId) return json(400, { error: 'recordId が必要です' });

  const raw = String(req.upsellTarget ?? '').trim().toLowerCase();
  if (!Object.values(UPSELL_TARGET).includes(raw)) {
    return json(400, { error: 'upsellTarget は auto / sanrenpuku / plus / none のいずれかです' });
  }
  const next = normalizeUpsellTarget(raw);

  // 対象の現状を読む（クライアント申告は信用しない）
  const getRes = await fetch(`https://api.airtable.com/v0/${BASE}/${CUSTOMERS_TABLE}/${recordId}`, {
    headers: airtableHeaders(KEY),
  });
  if (!getRes.ok) return json(404, { error: 'Record not found' });
  const currentFields = (await getRes.json()).fields || {};
  const before = readUpsellTarget(currentFields);

  // 設定は拒否しないが、**本当に表示されない場合だけ**理由を返す。
  //   - 三連複を保有済みの相手に sanrenpuku を指定した（再購入 CTA を出さない仕様）
  //   - blocked / Free・Light / 契約無効で Plus を出せない
  // ⚠️ 「eligibility が未設定 / review」は警告にしない。UpsellTarget=plus の明示指定自体が
  //    管理者の販売許可として扱われるため（二重操作をなくす）。
  const preview = resolveUpsellForCustomer({ fields: { ...currentFields, [UPSELL_TARGET_FIELD]: next }, nowMs: now });
  const warning = next === UPSELL_TARGET.SANRENPUKU && preview.entitlements.canViewSanrenpuku === true
    ? 'この会員は三連複を保有済みのため、三連複 CTA は表示されません（再購入 CTA は出しません）'
    : (preview.channel === 'none' && next !== UPSELL_TARGET.NONE
      ? `指定しましたが、現在この会員には表示されません（理由: ${preview.reasonLabel}）`
      : null);

  const fields = { [UPSELL_TARGET_FIELD]: next };
  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${CUSTOMERS_TABLE}/${recordId}`, {
    method: 'PATCH',
    headers: { ...airtableHeaders(KEY), 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error('❌ [premium-plus-eligibility] UpsellTarget PATCH failed:', res.status);
    return json(502, { error: 'Airtable update failed', status: res.status, detail: detail.slice(0, 300) });
  }

  console.log('✅ [premium-plus-eligibility] 販売導線を更新:', { recordId, before, next });
  return json(200, {
    success: true,
    recordId,
    before,
    upsellTarget: next,
    upsellTargetLabel: UPSELL_TARGET_LABEL[next],
    upsellDisplay: describeUpsellDisplay(preview),
    upsellReason: preview.reasonLabel,
    warning,
  });
}

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
