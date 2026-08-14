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
import { resolveSaleTarget } from '../../src/lib/premiumPlus/premiumPlusSaleDate.js';
import { shapeRaceCalendar, checkCalendarFreshness } from '../../src/lib/premiumPlus/premiumPlusRaceCalendar.js';
import ppRaceCalendar from '../../src/data/premiumPlusRaceCalendar.json' with { type: 'json' };
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
import { createFunnelStore, describeFunnelRow, funnelJst } from '../../src/lib/premiumPlus/premiumPlusFunnelStore.js';
import { makeRedisCmd } from '../../src/lib/premiumPlus/premiumPlusFunnelServer.js';
import {
  buildPlusDeliveryFormula,
  indexPlusDeliveries,
  describePlusNotified,
  summarizePlusNotified,
} from '../../src/lib/premiumPlus/plusNotifiedStatus.js';
import { chunkList, assertFetchComplete, TARGETED_MAX_PAGES } from '../../src/lib/marketing/marketingTargetedLoad.js';
import {
  resolveFunnelStage,
  lastReactionAtMs,
  summarizeFunnel,
  summarizeFunnelBySource,
  countUnknownSource,
  hasSourceTotalMismatch,
  SOURCE_TOTAL_NOTE,
  summarizePurchaseBySource,
  PURCHASE_ENTRY_ONLY_NOTE,
  extractNotPurchased,
  summarizeDaily,
} from '../../src/lib/premiumPlus/premiumPlusFunnelAnalytics.js';
import {
  buildLookupFormula,
  SEARCH_ERROR_TEXT,
  MAX_SEARCH_PAGES,
} from '../../src/lib/premiumPlus/premiumPlusAdminSearch.js';

const CUSTOMERS_TABLE = process.env.AIRTABLE_CUSTOMERS_TABLE || 'Customers';
/** 配信履歴。**名指しでしか引かない**（14,000 行超あり全件走査は不可能）。 */
const DELIVERIES_TABLE = process.env.AIRTABLE_DELIVERIES_TABLE || 'CampaignDeliveries';
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
 * 行に **実閲覧（実測）** を足す。
 *
 * ⚠️ **「表示判定」とは別物**。`upsellDisplay` は「この人には CTA を出す設定になっている」
 *    という判定結果で、見た証拠ではない。ここで足す `realView` だけが実測。
 *
 * 読めない / 未設定のときは **全員 `available:false`（＝「未確認」）** にする。
 * 0 回として返すと「見ていない」と読まれてしまう。
 *
 * @returns {Promise<{measurement: object}>} rows は破壊的に更新する
 */
/** 期間集計を読む。読めなければ available:false（**0 件と断定しない**） */
async function readDailySafe() {
  const cmd = makeRedisCmd(process.env);
  if (!cmd) return { available: false, entries: null };
  try {
    return await createFunnelStore({ redisCmd: cmd }).readDaily({ nowMs: Date.now() });
  } catch {
    return { available: false, entries: null };
  }
}

async function attachRealViews(rows) {
  const cmd = makeRedisCmd(process.env);
  const unavailable = (reason) => {
    for (const r of rows) {
      r.realView = describeFunnelRow(null, { available: false });
      // 読めていないので段階は「未確認」。**「未表示」とは書かない**
      r.funnelStage = resolveFunnelStage(r.realView).stage;
      r.funnelStageLabel = resolveFunnelStage(r.realView).label;
      r.lastReactionAtMs = null;
    }
    return {
      measurement: {
        available: false,
        reason,
        startedAtJst: null,
        note: '実閲覧を読み取れませんでした。表示は全員「未確認」です（0 回という意味ではありません）',
      },
      funnel: {
        ...summarizeFunnel(rows),
        bySource: summarizeFunnelBySource(rows),
        unknownSource: countUnknownSource(rows),
        sourceTotalMismatch: hasSourceTotalMismatch(rows),
        sourceNote: SOURCE_TOTAL_NOTE,
      },
    };
  };
  if (!cmd) return unavailable('measurement_unavailable');

  let out;
  try {
    out = await createFunnelStore({ redisCmd: cmd }).readMany({ recordIds: rows.map((r) => r.recordId) });
  } catch {
    return unavailable('read_failed');
  }
  if (!out.available) return unavailable(out.reason || 'read_failed');

  for (const r of rows) {
    r.realView = describeFunnelRow(out.rows.get(r.recordId) || null, {
      available: true,
      startedAtMs: out.startedAtMs,
    });
    // 段階・最終反応時刻は**判定の単一源**に委ねる（画面で組み立て直さない）
    const st = resolveFunnelStage(r.realView);
    r.funnelStage = st.stage;
    r.funnelStageLabel = st.label;
    r.lastReactionAtMs = lastReactionAtMs(r.realView);
  }
  return {
    measurement: {
      available: true,
      startedAtJst: funnelJst(out.startedAtMs),
      // 計測開始より前のことは分からない、と管理画面に常設で書く
      note: out.startedAtMs
        ? `実閲覧は ${funnelJst(out.startedAtMs)} JST から記録しています。それ以前に見たかどうかは記録が存在せず確認できません`
        : 'まだ実閲覧の記録がありません。過去に見たかどうかは記録が存在せず確認できません',
    },
    // 表示 → クリック → 到達の人数と転換率（分母が確定しなければ率は null）。
    // 導線別（ダッシュボード / 三連複ページ / 商品ページ内）も同じ数え方で併記する。
    // 種類（流入 / 商品ページ内）は analytics 側が付ける。ここでは組み立て直さない。
    funnel: {
      ...summarizeFunnel(rows),
      bySource: summarizeFunnelBySource(rows),
      unknownSource: countUnknownSource(rows),
      sourceTotalMismatch: hasSourceTotalMismatch(rows),
      sourceNote: SOURCE_TOTAL_NOTE,
      // 決済開始 → 購入完了の導線別転換（人数）
      purchaseBySource: summarizePurchaseBySource(rows),
      purchaseEntryOnlyNote: PURCHASE_ENTRY_ONLY_NOTE,
      // 抽出: クリック済み未購入 / 到達済み未購入（購入を確認できない人は別枠）
      notPurchased: (() => {
        const x = extractNotPurchased(rows);
        return {
          clickedNotPurchased: x.clickedNotPurchased.length,
          reachedNotPurchased: x.reachedNotPurchased.length,
          unverified: x.unverified.length,
          note: '「未購入」は計測開始以降に購入記録が無い人です。読み取れなかった人は別に数えます（0 ではありません）。',
        };
      })(),
      // 期間集計（今日 / 7 日 / 30 日）。**件数**であり人数ではない
      daily: summarizeDaily(await readDailySafe(), Date.now()),
    },
  };
}

/**
 * 行に **案内済みかどうか**（CampaignDeliveries の実績）を足す。
 *
 * ⚠️ これは `upsellDisplay`（出す設定か）とも `realView`（本人が見たか）とも別の軸で、
 *    **こちらから声をかけたか**を表す。3 つを同じ列にまとめない。
 *
 * 2026-08-13 実測: `premium-plus-offer` の配信は本番全体で 0 件。
 * 「販売可・CTA 表示中」と出ている会員に、こちらからは一度も案内していなかった。
 *
 * 取得は **名指しのみ**（recordId + アドレス）。`CampaignDeliveries` は 14,000 行超で、
 * 全件走査は Function の実行時間では原理的に終わらない（`check:no-unbounded-scan`）。
 * 取り切れなかったら `assertFetchComplete` が投げ、**短い結果を「送っていない」と
 * 誤読させない**（catch して全員「未確認」に倒す）。
 *
 * @returns {Promise<{notified: object}>} rows は破壊的に更新する
 */
async function attachPlusNotified({ KEY, BASE, rows }) {
  const unavailable = (reason) => {
    for (const r of rows) r.plusNotified = describePlusNotified({ entries: null, available: false });
    const sum = summarizePlusNotified(rows);
    return { notified: { ...sum, available: false, reason } };
  };
  if (!KEY || !BASE) return unavailable('airtable_unavailable');
  if (rows.length === 0) return { notified: summarizePlusNotified(rows) };

  const records = [];
  try {
    // recordId とアドレスを別チャンクで引く（1 本の formula を長くしすぎない）。
    const idGroups = chunkList(rows.map((r) => r.recordId));
    const mailGroups = chunkList(rows.map((r) => String(r.email || '').trim().toLowerCase()));
    const queries = [
      ...idGroups.map((g) => buildPlusDeliveryFormula({ recordIds: g })),
      ...mailGroups.map((g) => buildPlusDeliveryFormula({ emails: g })),
    ].filter(Boolean);

    for (const formula of queries) {
      let offset;
      let pages = 0;
      do {
        const body = { filterByFormula: formula, pageSize: 100 };
        if (offset) body.offset = offset;
        const res = await fetch(
          `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(DELIVERIES_TABLE)}/listRecords`,
          {
            method: 'POST',
            headers: { ...airtableHeaders(KEY), 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        );
        if (!res.ok) throw new Error(`${DELIVERIES_TABLE} fetch failed: HTTP ${res.status}`);
        const data = await res.json();
        records.push(...(data.records || []));
        offset = data.offset;
        pages += 1;
        // 打ち切ったまま返さない。不完全な履歴は「未案内」の誤表示に直結する。
        if (offset && pages >= TARGETED_MAX_PAGES) {
          assertFetchComplete({ table: DELIVERIES_TABLE, offset, pages, maxPages: TARGETED_MAX_PAGES });
        }
      } while (offset);
    }
  } catch (e) {
    // 理由はログにだけ残す（アドレス・レコード内容は出さない）
    console.error('❌ [premium-plus-eligibility] 配信履歴の取得に失敗:', e.message);
    return unavailable('read_failed');
  }

  const { byRecordId, byEmail } = indexPlusDeliveries(records);
  for (const r of rows) {
    const email = String(r.email || '').trim().toLowerCase();
    // recordId 側とアドレス側の**和集合**。片方にしか無い行を落とさない。
    const merged = [...(byRecordId.get(r.recordId) || []), ...(byEmail.get(email) || [])];
    // 同じ行が両方から入るので重複を落とす（件数を水増ししない）
    const seen = new Set();
    const entries = merged.filter((e) => {
      const k = `${e.campaignType}|${e.status}|${e.atMs}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    r.plusNotified = describePlusNotified({
      entries,
      available: true,
      upsellChannel: r.upsellChannel,
    });
  }
  return { notified: summarizePlusNotified(rows) };
}

/**
 * 1 人を名指しで調べる（**候補集合の外も引ける**）。
 *
 * 一覧は「販売候補になり得る人」だけへ絞り込んでいるので、
 * 無料会員など候補外の人は一覧に出ない。管理者が「あの人はどうなっている？」を
 * 確認できるよう、**検索だけは絞り込みを迂回**する。
 *
 * 検索語は **氏名の一部 / アドレスの一部**でよい（式の組み立ては
 * `premiumPlusAdminSearch.js` が単一源）。完全一致の Email しか引けないと、
 * 手元に氏名しか無い相手を調べられず「調べられない」が「見ていない」と誤読される。
 *
 * 行の組み立ては一覧と同じ `buildAdminRow`（値がズレない）。実閲覧も併せて返す。
 */
async function handleLookup({ KEY, BASE, now, req }) {
  // recordId 指定は「保存後にその 1 件を読み直す」用。
  // ⚠️ アドレスで読み直すと **Email が空の会員を確認できない**（保存できたのに
  //    「再読込に失敗」と出る）。確認は操作の一部なので、必ず引ける経路を用意する。
  const byId = String((req && req.recordId) || '').trim();
  const built = byId
    ? { ok: true, exactEmail: false, formula: `RECORD_ID() = '${byId.replace(/'/g, "\\'")}'` }
    : buildLookupFormula(String((req && (req.query ?? req.email)) || ''));
  const raw = byId || String((req && (req.query ?? req.email)) || '');
  if (!built.ok) return json(400, { error: SEARCH_ERROR_TEXT[built.reason] || '検索語が不正です' });

  const recs = [];
  let offset;
  let pages = 0;
  do {
    const res = await fetch(
      `https://api.airtable.com/v0/${BASE}/${CUSTOMERS_TABLE}/listRecords`,
      {
        method: 'POST',
        headers: { ...airtableHeaders(KEY), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pageSize: 100,
          filterByFormula: built.formula,
          sort: [{ field: 'Email', direction: 'asc' }],
          ...(offset ? { offset } : {}),
        }),
      },
    );
    if (!res.ok) return json(502, { error: `Airtable lookup failed: ${res.status}` });
    const data = await res.json();
    recs.push(...(data.records || []));
    offset = data.offset;
    pages += 1;
    // 一致が多すぎるときは **一部を返さない**（先頭 N 件を「該当者はこれだけ」と
    // 読まれると、探している人が居ないと誤解される）。fail closed で絞り込みを促す。
    if (offset && pages >= MAX_SEARCH_PAGES) {
      return json(400, {
        error: `「${raw}」に一致する会員が多すぎます（${pages * 100} 件以上）。`
          + '一部だけを表示すると探している人を見落とすため、結果を返しません。検索語を絞り込んでください',
        code: 'search_too_broad',
        query: raw,
        sideEffects: 'none',
      });
    }
  } while (offset);

  if (recs.length === 0) {
    return json(200, {
      found: false, rows: [], query: raw, exactEmail: built.exactEmail, sideEffects: 'none',
    });
  }

  const rows = recs.map((rec) => {
    const row = buildAdminRow(rec, now);
    return {
      ...row,
      /** 一覧の絞り込み対象に入っているか（false = 検索でしか出てこない人） */
      inCandidateSet: row.__listed === true,
    };
  });
  const { measurement, funnel } = await attachRealViews(rows);
  const { notified } = await attachPlusNotified({ KEY, BASE, rows });

  return json(200, {
    found: true,
    rows,
    // 個別検索でも一覧と同じ実閲覧の情報（段階・初回/最終/回数）を返す
    funnel,
    query: raw,
    exactEmail: built.exactEmail,
    measurement,
    notified,
    sideEffects: 'none',
  });
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

  // 実閲覧（実測）を足す。**表示判定とは別列**として返す
  const { measurement, funnel } = await attachRealViews(rows);
  // 案内済み（こちらから送ったか）を足す。表示判定とも実閲覧とも別の軸。
  const { notified } = await attachPlusNotified({ KEY, BASE, rows });

  return json(200, {
    rows,
    // いま販売している対象日（16:30 以降は翌日分）と開催区分。
    // 例外リストの確認期限切れは**警告するだけ**（販売は止めない）。
    saleTarget: (() => {
      const cal = shapeRaceCalendar(ppRaceCalendar);
      const t = resolveSaleTarget(now, { calendar: cal });
      const f = checkCalendarFreshness({ calendar: cal, nowDate: t.baseDate });
      return { ...t, calendarStale: f.stale, calendarNote: f.stale || f.expiringSoon ? f.note : '' };
    })(),
    measurement,
    notified,
    funnel,
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
    // 実測（表示判定の件数とは別物。混ぜて数えない）
    realViewCounts: {
      ctaViewed: rows.filter((r) => r.realView?.cta?.measured).length,
      clicked: rows.filter((r) => r.realView?.click?.measured).length,
      pageViewed: rows.filter((r) => r.realView?.page?.measured).length,
      /** 記録が無い人。**「見ていない」ではなく「確認できない」** */
      unknown: rows.filter((r) => !r.realView?.anyMeasured).length,
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

  // 🛡️ 別の管理者の変更を黙って上書きしない。
  //    画面が「見ていた時点の最終更新」を送ってくるので、いまの値と食い違えば止める。
  //    未送信（古い画面・API 直叩き）のときは従来どおり通す（後方互換）。
  if (req.expectedUpdatedAt !== undefined) {
    const seen = String(req.expectedUpdatedAt ?? '').trim();
    const nowValue = String(currentFields[PP_ELIGIBILITY_FIELDS.UPDATED_AT] ?? '').trim();
    if (seen !== nowValue) {
      return json(409, {
        error: 'この会員は別の操作で更新されています。再読込して最新の状態を確認してから操作してください。',
        code: 'stale_record',
        seenUpdatedAt: seen || null,
        currentUpdatedAt: nowValue || null,
        currentUpdatedBy: currentFields[PP_ELIGIBILITY_FIELDS.UPDATED_BY] || null,
        currentEligibility: currentFields[PP_ELIGIBILITY_FIELDS.STATUS] || null,
        sideEffects: 'none',
      });
    }
  }

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
    // 変更の**前後**を返す（画面が「何が変わったか」を履歴に書けるようにする）
    previous: currentFields[PP_ELIGIBILITY_FIELDS.STATUS] || null,
    previousLabel: PP_ELIGIBILITY_LABEL[currentFields[PP_ELIGIBILITY_FIELDS.STATUS]] || null,
    next: built.next,
    label: PP_ELIGIBILITY_LABEL[built.next],
    override: built.override,
    overrideChanged: built.overrideChanged,
    // true のときだけ段階公開 anchor が動く（= PHASE 1 から見え始める）
    eligibleAtUpdated: built.eligibleAtUpdated,
    // 次の操作の版として画面が持ち直す（毎回フル再読込しなくても競合検知が効く）
    updatedAt: built.fields[PP_ELIGIBILITY_FIELDS.UPDATED_AT] || null,
    updatedBy: built.fields[PP_ELIGIBILITY_FIELDS.UPDATED_BY] || null,
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

  console.log('✅ [premium-plus-eligibility] 販売導線を更新:', {
    recordId, before, next, actor: String(req.actor || '').slice(0, 32) || '(未入力)',
  });
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
