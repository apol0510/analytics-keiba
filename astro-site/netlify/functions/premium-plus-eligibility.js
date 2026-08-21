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
  PP_SALE_PAUSE_FIELDS,
  PP_ROUTE,
  describeReleaseState,
  resolvePremiumPlusRelease,
} from '../../src/lib/premiumPlus/premiumPlusRelease.js';
import { resolvePlusMemberFromFields } from '../../src/lib/premiumPlus/premiumPlusMember.js';
import { eligibilityAxisFields } from '../../src/lib/premiumPlus/premiumPlusAdminEligibilityAxis.js';
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
  buildSalePauseFields,
  assertOnlyPlusFields,
  isPlusFieldsEnabled,
  isReleaseOverrideEnabled,
  isSalePauseEnabled,
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
import { OFFERS_TABLE, isOfferTableEnabled, assertOnlyOfferFields } from '../../src/lib/promotions/promotionalOffer.js';
import {
  PP_COUPON_ADMIN_ACTION,
  resolveCouponAdminPlanFor,
  describeCouponAdminState,
  describeCouponAdminActions,
} from '../../src/lib/premiumPlus/premiumPlusCouponAdmin.js';
import { buildReservationRevokeFields } from '../../src/lib/premiumPlus/premiumPlusCouponReservation.js';
import {
  createCouponOperationLock,
  LOCK_RESULT,
  LOCK_REJECT_TEXT,
} from '../../src/lib/coupons/couponOperationLock.js';
import { createCouponHistoryStore } from '../../src/lib/coupons/couponHistoryStore.js';
import {
  buildHistoryRecord,
  buildRepairRecord,
  findHistoryRepairTargets,
  isCouponHistoryEnabled,
} from '../../src/lib/coupons/couponOperationHistory.js';
import { PP_COUPON_BINDING } from '../../src/lib/premiumPlus/premiumPlusCouponAdmin.js';
import { parseCouponAudit, computeCouponEntityId } from '../../src/lib/coupons/couponPlatform.js';
import {
  describeCouponLifecycle,
  describeLedgerUnavailable,
  COUPON_LIFECYCLE,
  LEDGER_UNAVAILABLE,
} from '../../src/lib/premiumPlus/premiumPlusCouponReservation.js';
import {
  readReopenCoupon,
  isReopenCouponEnabled,
  PP_REOPEN_COUPON,
  PP_REOPEN_COUPON_FIELDS,
  describeCouponTerms,
  describeCouponDiscount,
  describeCouponPrice,
  describeCouponExpiry,
} from '../../src/lib/premiumPlus/premiumPlusReopenCoupon.js';
// 再募集の開始日時（`reopenStartsAt`）。**顧客画面・申込・admin が同じ値を読む**
import {
  withReopenStart,
  resolveReopenStatus,
  isSafeCustomerRecordId,
  REOPEN_START_REJECT,
  REOPEN_UNAVAILABLE,
} from '../../src/lib/premiumPlus/premiumPlusReopenStart.js';
import {
  createReopenStartStore,
  REOPEN_ADMIN_TIMEOUT_MS,
} from '../../src/lib/premiumPlus/premiumPlusReopenStartStore.js';
// 「販売再開 ＋ 再募集開始」を 1 つの業務操作として扱う単一源（純粋）
import {
  classifyLaunch,
  planReopenLaunch,
  describeLaunchAction,
  computeReopenLockId,
  computeReopenOperationId,
  LAUNCH_STATE,
  LAUNCH_REJECT,
} from '../../src/lib/premiumPlus/premiumPlusReopenLaunch.js';

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
    if (action === 'setSalePause') return await handleSetSalePause({ KEY, BASE, now, req });
    if (action === 'couponAdmin') return await handleCouponAdmin({ KEY, BASE, now, req });
    if (action === 'couponHistory') return await handleCouponHistory({ KEY, BASE, req });
    if (action === 'couponHistoryRepair') return await handleCouponHistoryRepair({ KEY, BASE, now, req });
    // **会員ごとの**再募集の開始状態を読むだけ（write なし）
    if (action === 'reopenStatus') return await handleReopenStatus({ req });
    // **会員ごとに**「販売再開 ＋ 再募集期間の開始」を 1 操作で行う
    // （**サーバー時刻で first-write-wins**。上書き経路は持たない）
    if (action === 'reopenStart') return await handleReopenStart({ KEY, BASE, now, req });
    return json(400, { error: `未知の action: ${action}` });
  } catch (e) {
    console.error('❌ [premium-plus-eligibility]', e.message);
    return json(500, { error: 'internal error' });
  }
};


/**
 * 予約台帳を**読めていない**ことを表す既定値。
 *
 * ⚠️ 既定を「空の台帳」にしない。台帳を渡し忘れた呼び出しが
 *    「クーポン所持中・予約 0 件」と**断定表示**してしまうため、
 *    **渡し忘れ = 確認できない**へ倒す（fail closed）。
 */
const UNREAD_LEDGER = Object.freeze({
  rows: null, available: false, reason: LEDGER_UNAVAILABLE.NOT_PROVIDED,
});

/**
 * 1 レコード → 管理一覧の 1 行。**list と lookup で同じ組み立てを使う**
 * （別々に書くと「一覧の値」と「個別検索の値」がズレる）。
 * `candidate.listed` は呼び出し側が判断に使う（ここでは落とさない）。
 *
 * @param {object} rec Airtable の 1 レコード
 * @param {number} now 判定に使う現在時刻
 * @param {{ rows: object[]|null, available: boolean, reason: string }} ledger
 *   クーポン予約台帳。**`available:false` を空配列へ潰さないこと**
 *   （「読めた結果 0 件」と「確認できない」は別の事実）。
 */
function buildAdminRow(rec, now, ledger = UNREAD_LEDGER) {
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

    // ── 資格の軸（停止とは別軸）─────────────────────────────
    // ⚠️ 停止中は release が denied（phase=1 / overrideApplied=false）になる。
    //    そのまま一覧へ流すと、保存値は変わっていないのに資格バッジが
    //    「即時販売」→「PHASE 1」に化け、「即時販売」の件数も減る。
    //    停止を外した状態で同じ単一源を解き直し、**資格の表示だけ**そちらを使う。
    //    顧客向け表示（upsellChannel / state / showProductPage）は release のまま。
    const axis = eligibilityAxisFields({ fields, nowMs: now, release });

    const eligibility = member.eligibility;
    // 取得状態は 1 レコードの値をそのまま読むだけ（他会員は一切参照しない）
    const reopenCoupon = readReopenCoupon(fields);
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
        // 資格の軸（停止で動かさない）。停止の有無は salePaused 列が持つ。
        overrideApplied: axis.overrideApplied,
        state: describeReleaseState(release),
        eligibleAt: fields['PremiumPlusEligibleAt'] || '',
        updatedAt: fields['PremiumPlusEligibilityUpdatedAt'] || '',
        updatedBy: fields['PremiumPlusEligibilityUpdatedBy'] || '',
        phase: axis.phase,
        sanrenpukuPaidAt: member.sanrenpukuPaidAtMs ? new Date(member.sanrenpukuPaidAtMs).toISOString() : '',
        // ── 会員単位の販売 一時停止（資格とは別の軸）──────────────
        // ⚠️ `eligibility='blocked'`（販売対象外）と混同させない。停止は資格を保持したまま
        //    全面を閉じているだけで、再開すれば元の phase / 資格がそのまま戻る。
        salePaused: member.salePaused === true,
        salePausedLabel: member.salePaused === true ? '一時停止中' : '販売中',
        salePausedAt: fields[PP_SALE_PAUSE_FIELDS.UPDATED_AT] || '',
        salePausedBy: fields[PP_SALE_PAUSE_FIELDS.UPDATED_BY] || '',
        salePauseReason: fields[PP_SALE_PAUSE_FIELDS.REASON] || '',
        // ── 再募集クーポンの取得（資格とも停止とも別の軸）──────────────
        // ⚠️ 「販売できるか」ではない。**停止中に受付休止ページから会員自身が
        //    取得した**という事実だけ。取得しても資格・停止・会員権は動かない。
        reopenCouponName: PP_REOPEN_COUPON.name,
        reopenCouponClaimed: reopenCoupon.claimed === true,
        reopenCouponClaimedAt: reopenCoupon.claimedAtIso,
        reopenCouponLabel: reopenCoupon.claimed === true ? 'クーポン取得済み' : 'クーポン未取得',
        reopenCouponId: reopenCoupon.couponId,
        reopenCouponSource: reopenCoupon.source,
        /** 取得の記録が本番で保存できる状態か（画面の注意表示に使う） */
        reopenCouponWritable: isReopenCouponEnabled(process.env),
        // 価格条件は**単一源が作った文字列**をそのまま載せる（管理画面で数値を組み立てない）
        // 割引・価格は会員によらず同じ（正本の静的な条件）
        reopenCouponTerms: describeCouponTerms(),
        reopenCouponDiscountText: describeCouponDiscount(),
        reopenCouponPriceText: describeCouponPrice(),
        // ⚠️ **有効期限だけは会員ごと**（その会員の再募集開始日時 + 14 日）。
        //    ここでは基準（未確定）を入れ、後段の attachReopenStart が会員ごとに解き直す。
        reopenCouponExpiryText: describeCouponExpiry(),
        /** その会員の再募集開始状態（attachReopenStart が入れる） */
        reopenStart: null,
        // クーポンのライフサイクル（所持中 / 利用予約 / 使用済み / 予約取消 / 要修復）。
        // ⚠️ 通常の販促オファーとは**別軸**。Airtable を直接見に行かせないための表示。
        // 管理者が今この会員に対して行える操作（**表示用**。可否はサーバーが再判定する）
        couponAdmin: describeCouponAdminActions({
          fields,
          offerRows: ledger.available ? ledger.rows : null,
          ledgerAvailable: ledger.available === true,
          env: process.env,
          customerRecordId: rec.id,
        }),
        couponLifecycle: describeCouponLifecycle({
          fields,
          // ⚠️ 読めていないときは null のまま渡す（[] へ潰すと 0 件と断定される）
          offerRows: ledger.available ? ledger.rows : null,
          ledgerAvailable: ledger.available === true,
          ledgerReason: ledger.reason,
          customerRecordId: rec.id,
        }),
        /**
         * 停止/再開の操作が本番で受け付けられる状態か（画面のボタン活性に使う）。
         */
        salePauseWritable: isSalePauseEnabled(process.env),
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

  // 一覧と**同じ台帳・同じ判定**を使う（片方だけ台帳を見ないと状態が食い違う）
  const ledger = await readReservationLedger({ KEY, BASE });
  const rows = recs.map((rec) => {
    const row = buildAdminRow(rec, now, ledger);
    return {
      ...row,
      /** 一覧の絞り込み対象に入っているか（false = 検索でしか出てこない人） */
      inCandidateSet: row.__listed === true,
    };
  });
  const { measurement, funnel } = await attachRealViews(rows);
  const { notified } = await attachPlusNotified({ KEY, BASE, rows });
  // 会員ごとの再募集開始状態（一覧と同じ経路。片方だけ別に解くと表示がズレる）
  const reopen = await attachReopenStart(rows);

  return json(200, {
    found: true,
    rows,
    // 予約台帳を読めたか（一覧と同じ塊。読めていないなら画面に「確認できない」と出す）
    couponLedger: describeLedger(ledger),
    // 再募集の開始は**会員ごと**。全体の値は無く、行の `reopenStart` を見る。
    // ここに出すのは「読めたか」と「開始済みの人数」だけ。
    reopenStarts: { available: reopen.available, reason: reopen.reason, started: reopen.started },
    // 個別検索でも一覧と同じ実閲覧の情報（段階・初回/最終/回数）を返す
    funnel,
    query: raw,
    exactEmail: built.exactEmail,
    measurement,
    notified,
    sideEffects: 'none',
  });
}

/** 予約台帳のページ上限（暴走防止）。上限に当たったら「確認できない」として返す。 */
const LEDGER_MAX_PAGES = 10;

/**
 * クーポン利用予約の台帳を読む（**read-only**）。
 *
 * 返すのは **`{ rows, available, reason }`**。
 * `available:false` は「予約 0 件」ではなく「**確認できない**」で、理由は次の 3 つ:
 *   - `gate_off`     … 台帳が有効化されていない
 *   - `read_failed`  … Airtable の読み取りに失敗した
 *   - `page_limit`   … 全件を読み切れなかった
 *
 * ⚠️ 呼び出し側は `rows || []` のように**空配列へ潰さないこと**。
 *    潰すと「読めていない」が「予約 0 件（＝クーポン所持中）」として断定表示される。
 */
async function readReservationLedger({ KEY, BASE }) {
  const unavailable = (reason) => ({ rows: null, available: false, reason });
  if (!isOfferTableEnabled(process.env)) return unavailable(LEDGER_UNAVAILABLE.GATE_OFF);
  const out = [];
  let offset;
  let pages = 0;
  try {
    do {
      const res = await fetch(
        `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(OFFERS_TABLE)}/listRecords`,
        {
          method: 'POST',
          headers: { ...airtableHeaders(KEY), 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageSize: 100, ...(offset ? { offset } : {}) }),
        },
      );
      if (!res.ok) return unavailable(LEDGER_UNAVAILABLE.READ_FAILED);
      const data = await res.json();
      out.push(...(data.records || []));
      offset = data.offset;
      pages += 1;
      // 全部見きれていない = 確認できない（読めた分だけを「全部」として返さない）
      if (pages >= LEDGER_MAX_PAGES && offset) return unavailable(LEDGER_UNAVAILABLE.PAGE_LIMIT);
    } while (offset);
    // ここまで来たら読み切れている。**空配列は「読めた結果 0 件」**
    return { rows: out, available: true, reason: '' };
  } catch {
    return unavailable(LEDGER_UNAVAILABLE.READ_FAILED);
  }
}

/** 台帳の状態を画面へそのまま出すための塊（一覧・個別検索で同じものを返す）*/
function describeLedger(ledger) {
  return {
    available: ledger.available === true,
    reason: ledger.reason || '',
    note: ledger.available === true ? '' : describeLedgerUnavailable(ledger.reason),
  };
}

/**
 * 再募集クーポンの**管理者操作**（付与 / 予約取消 / 誤取得訂正 / 再発行）。
 *
 * 認可はハンドラ先頭の `x-admin-secret` 検証だけが根拠（この画面は /admin/* の
 * Basic 認証の背後だが、**API 直叩きでも同じ制約を通す**）。
 *
 * 安全条件（**すべてサーバー側で再判定する**。画面がボタンを出したかは根拠にしない）:
 *   - 対象は `recordId` で名指しした **1 会員だけ**。他会員のレコードは読み書きしない
 *   - 予約台帳を読めなければ**全操作を拒否**（使用済みか判断できないまま書き換えない）
 *   - **使用済み**のクーポンは取得状態へ戻さない・再発行しない
 *   - 取得済みへの二重付与 / 取消済み予約の二重取消は状態遷移で構造的に防ぐ
 *   - 書けるのはクーポン 3 列（Customers）または予約行の 2 列（台帳）だけ。
 *     資格 / 停止 / 会員権 / 決済 / メールは**1 バイトも触らない**
 *   - 操作者・理由は必須。監査値は `Source` / `Notes` に構造化して残す
 */
async function handleCouponAdmin({ KEY, BASE, now, req }) {
  const recordId = String(req.recordId || '').trim();
  const couponAction = String(req.couponAction || '').trim();
  const actor = String(req.actor || '').trim();
  const reason = String(req.reason || '').trim();
  if (!recordId) return json(400, { error: 'recordId が必要です', sideEffects: 'none' });

  /** 現状（Customers + 予約台帳）を読み直す。**クライアント申告は一切信用しない** */
  const readState = async () => {
    const res = await fetch(`https://api.airtable.com/v0/${BASE}/${CUSTOMERS_TABLE}/${recordId}`, {
      headers: airtableHeaders(KEY),
    });
    if (!res.ok) return null;
    const fields = (await res.json()).fields || {};
    const ledger = await readReservationLedger({ KEY, BASE });
    return { fields, ledger };
  };
  const describe = (fields, ledger) => describeCouponAdminState({
    fields,
    offerRows: ledger.available ? ledger.rows : null,
    ledgerAvailable: ledger.available === true,
    customerRecordId: recordId,
  });
  const makePlan = (fields, ledger) => resolveCouponAdminPlanFor({
    action: couponAction,
    fields,
    offerRows: ledger.available ? ledger.rows : null,
    ledgerAvailable: ledger.available === true,
    env: process.env,
    actor, reason, nowMs: now,
    customerRecordId: recordId,
  });
  const rejectStatus = (code) => ({
    unknown_action: 400, missing_actor: 400, missing_reason: 400,
    ledger_unavailable: 503, coupon_storage_disabled: 503,
  })[code] || 409;

  // ── ① 現状を read ──────────────────────────────────────────
  const first = await readState();
  if (!first) return json(404, { error: 'Record not found', sideEffects: 'none' });
  const before = describe(first.fields, first.ledger);
  // 対象会員を取り違えないよう、応答に必ず本人の識別情報を載せる
  const subject = {
    recordId,
    email: first.fields['Email'] || '',
    name: first.fields['氏名'] || '',
    plan: first.fields['プラン'] || '',
  };

  // ── ② 安定 OperationId を算出（現在時刻は材料にしない）────
  const planned = makePlan(first.fields, first.ledger);
  if (!planned.ok) {
    return json(rejectStatus(planned.code), {
      error: planned.message, code: planned.code, subject, before,
      couponLedger: describeLedger(first.ledger), sideEffects: 'none',
    });
  }

  // ── ③ **状態変更より前に**排他を取る ───────────────────────
  //    ⚠️ 鍵は **entity id（会員 × 商品 × クーポン）**。OperationId を鍵にすると
  //       claim と grant のような**別種の操作が同時に state を書けてしまう**。
  //    ここを history append の直前にすると、同時 2 本が両方 PATCH に成功し、
  //    Customers の最終監査値と履歴が食い違う。
  const entityId = couponEntityIdFor(recordId);
  const lock = createCouponOperationLock({ redisCmd: makeRedisCmd(process.env) });
  const got = await lock.acquire({ entityId });
  if (got.status !== LOCK_RESULT.ACQUIRED) {
    const lost = got.status === LOCK_RESULT.LOST;
    return json(lost ? 409 : 503, {
      error: LOCK_REJECT_TEXT[lost ? 'lost' : 'unavailable'],
      code: lost ? 'operation_in_progress' : 'lock_unavailable',
      operationId: planned.operationId,
      subject, before, sideEffects: 'none',
    });
  }

  try {
    // ── ④ lock 取得後に**もう一度** read（TOCTOU を閉じる）──
    //    ⚠️ PATCH の判断材料は**この読み直した値だけ**。①の値は使わない。
    const fresh = await readState();
    if (!fresh) return json(404, { error: 'Record not found', sideEffects: 'none' });
    const currentFields = fresh.fields;

    // ── ⑤ サーバー側の条件を**再判定** ───────────────────────
    const plan = makePlan(currentFields, fresh.ledger);
    if (!plan.ok) {
      return json(rejectStatus(plan.code), {
        error: plan.message, code: plan.code, subject,
        before: describe(currentFields, fresh.ledger),
        couponLedger: describeLedger(fresh.ledger), sideEffects: 'none',
      });
    }
    // 読み直した状態で OperationId が変わった = 別の操作が先に通った
    if (plan.operationId !== planned.operationId) {
      return json(409, {
        error: 'この会員の状態が操作の直前に変わりました。再読込して状態を確認してから、もう一度実行してください。',
        code: 'stale_state',
        subject, before: describe(currentFields, fresh.ledger), sideEffects: 'none',
      });
    }

    // ── ⑥ 状態変更（書く直前に lock を検証。奪われていたら書かない）──
    const held = await lock.verify({ entityId, token: got.token });
    if (!held.ok) {
      return json(409, {
        error: LOCK_REJECT_TEXT.lost, code: 'operation_lock_lost',
        operationId: plan.operationId, subject, sideEffects: 'none',
      });
    }

    if (plan.target === 'reservation') {
      const target = (fresh.ledger.rows || []).find((r) => r.id === plan.reservationRecordId);
      const built = buildReservationRevokeFields({ record: target, nowMs: now, reason: plan.note });
      if (!built.fields) {
        return json(409, {
          error: `利用予約を取り消せません（${built.skipped}）`, code: built.skipped,
          subject, before, sideEffects: 'none',
        });
      }
      if (!assertOnlyOfferFields(built.fields)) return json(500, { error: 'field allow-list violation' });
      const res = await fetch(
        `https://api.airtable.com/v0/${BASE}/${encodeURIComponent(OFFERS_TABLE)}/${plan.reservationRecordId}`,
        {
          method: 'PATCH',
          headers: { ...airtableHeaders(KEY), 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: built.fields }),
        },
      );
      if (!res.ok) {
        const detail = await res.text();
        console.error('❌ [premium-plus-eligibility] 予約取消 PATCH failed:', res.status);
        return json(502, {
          error: '予約台帳の更新に失敗しました', status: res.status, detail: detail.slice(0, 300),
          subject, before,
        });
      }
      console.log('✅ [premium-plus-eligibility] 利用予約を取消:', { recordId, actor });
      // 台帳が変わったので**読み直す**（手元の ledger を使い回さない）
      const after = await reloadCouponState({ KEY, BASE, recordId });
      // ⑦ 履歴（同じ lock の中・同じ OperationId）。失敗しても状態は巻き戻さない
      const history = await appendOperationHistory({
        KEY, BASE, recordId, plan, actor, reason, before, after, detail: plan.note,
      });
      return json(200, {
        success: true, couponAction, subject, before, after,
        changed: true,
        operationId: plan.operationId,
        history,
        /** Customers 側は 1 バイトも書いていない */
        customerFieldsUnchanged: true,
        note: '利用予約を取り消しました。クーポンの取得（保有）はそのまま残っています。',
        rollback: '同じクーポンで改めてお申し込みいただけます。'
          + '取り消した予約行を issued へ戻す操作は用意していません（二重予約を防ぐため）。',
        sideEffects: 'coupon_reservation_revoked',
      });
    }

    // 付与 / 誤取得訂正 / 再発行: Customers のクーポン 3 列だけ
    const res = await fetch(`https://api.airtable.com/v0/${BASE}/${CUSTOMERS_TABLE}/${recordId}`, {
      method: 'PATCH',
      headers: { ...airtableHeaders(KEY), 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: plan.fields, typecast: true }),
    });
    if (!res.ok) {
      const detail = await res.text();
      console.error('❌ [premium-plus-eligibility] クーポン操作 PATCH failed:', res.status);
      return json(502, {
        error: 'Airtable update failed', status: res.status, detail: detail.slice(0, 300),
        subject, before,
      });
    }
    console.log('✅ [premium-plus-eligibility] クーポン操作:', { recordId, couponAction, actor });

    // ── ⑦ 履歴は同じ OperationId で積む（**本番テーブル未作成のため未接続**）──
    //    状態変更が成功していれば、監査文字列に残した op= から後で
    //    history-only で積み直せる（⑧ 部分成功の回復）。
    const after = await reloadCouponState({ KEY, BASE, recordId });
    // ⑦ 履歴（同じ lock の中・同じ OperationId）。失敗しても状態は巻き戻さない
    const history = await appendOperationHistory({
      KEY, BASE, recordId, plan, actor, reason, before, after,
      detail: String(plan.fields[PP_REOPEN_COUPON_FIELDS.SOURCE] || ''),
    });
    return json(200, {
      success: true,
      couponAction,
      subject,
      before,
      after,
      changed: true,
      operationId: plan.operationId,
      history,
      /** 資格・停止・会員権・決済は変更していない（応答でも明示して履歴に残す） */
      eligibilityUnchanged: true,
      membershipUnchanged: true,
      rollback: couponAction === PP_COUPON_ADMIN_ACTION.CORRECT
        ? '「クーポンを再発行」で取得状態へ戻せます（訂正前の取得日時は監査記録に残っています）。'
        : '「誤取得を訂正」で取得を取り消せます。',
      sideEffects: 'coupon_fields_updated',
    });
  } finally {
    // ── ⑨ 解放（token 一致時のみ）。失敗しても TTL で必ず回復する ──
    await lock.release({ entityId, token: got.token });
  }
}

/**
 * この会員 × この商品 × このクーポンの **排他の鍵**（entity id）。
 *
 * ⚠️ **OperationId ではない。** OperationId は操作種別ごとに変わるので、
 *    鍵にすると `claim` と `grant` のような別種の操作が同時に state を書ける。
 */
function couponEntityIdFor(recordId) {
  return computeCouponEntityId({
    customerRecordId: recordId,
    productKey: PP_COUPON_BINDING.productKey,
    couponId: PP_COUPON_BINDING.couponId,
    version: PP_COUPON_BINDING.version,
  });
}

/**
 * 操作の履歴を 1 行積む（**append-only**）。
 *
 * ⚠️ **呼び出せるのは operation lock を保持したまま**（状態変更と同じ鍵の中）。
 * ⚠️ **失敗しても状態変更を巻き戻さない。** 監査に残した `op=` から
 *    `couponHistoryRepair` で後から同じ OperationId で積み直せる。
 * ⚠️ gate（`COUPON_HISTORY_TABLE_READY`）が off なら**何もしない**。
 */
async function appendOperationHistory({
  KEY, BASE, recordId, plan, actor, reason, before, after, detail,
}) {
  if (!isCouponHistoryEnabled(process.env)) {
    return { appended: false, reason: 'history_disabled' };
  }
  const record = buildHistoryRecord({
    customerRecordId: recordId,
    productKey: PP_COUPON_BINDING.productKey,
    couponId: PP_COUPON_BINDING.couponId,
    version: PP_COUPON_BINDING.version,
    operationType: plan.operation || plan.action,
    actor, reason,
    beforeState: (before && before.lifecycle) || '',
    afterState: (after && after.lifecycle) || '',
    detail: detail || '',
    atIso: plan.atIso || new Date().toISOString(),
    operationId: plan.operationId,
  });
  if (!record) return { appended: false, reason: 'no_record' };
  const store = createCouponHistoryStore({ apiKey: KEY, baseId: BASE, env: process.env });
  const out = await store.append({ record, lockStatus: 'acquired' });
  if (!out.appended && out.reason !== 'already_recorded') {
    // 状態は成功している。**巻き戻さず**、未記録として運営者に見せる
    console.warn('⚠️ [premium-plus-eligibility] 履歴を積めませんでした:',
      { recordId, operationId: plan.operationId, reason: out.reason });
  }
  return out;
}

/**
 * 会員 1 人ぶんのクーポン操作履歴を**時系列で返す**（read-only）。
 *
 * これがあるので、通常運用で **Airtable を直接見る必要がない**。
 * ⚠️ 他会員の行は混ざらない（`CustomerRecordId` 一致だけを引く）。
 * ⚠️ gate が off / 読めないときは **0 件と断定しない**（「確認できない」を返す）。
 */
async function handleCouponHistory({ KEY, BASE, req }) {
  const recordId = String(req.recordId || '').trim();
  if (!recordId) return json(400, { error: 'recordId が必要です', sideEffects: 'none' });

  const store = createCouponHistoryStore({ apiKey: KEY, baseId: BASE, env: process.env });
  const got = await store.listForCustomer({ customerRecordId: recordId });
  return json(200, {
    recordId,
    available: got.available,
    reason: got.reason,
    note: got.available ? '' : (got.reason === 'history_disabled'
      ? '操作履歴の保存はこの本番環境でまだ有効化されていません（COUPON_HISTORY_TABLE_READY 未設定）。'
        + 'これまでの操作は記録されていないため、履歴は表示できません。'
      : '操作履歴を読み取れませんでした。0 件と判断しないでください。'),
    rows: (got.rows || []).map((r) => ({
      operationId: r.fields.OperationId || '',
      occurredAt: r.fields.OccurredAt || '',
      operationType: r.fields.OperationType || '',
      actor: r.fields.Actor || '',
      reason: r.fields.Reason || '',
      beforeState: r.fields.BeforeState || '',
      afterState: r.fields.AfterState || '',
      productKey: r.fields.ProductKey || '',
      couponId: r.fields.CouponId || '',
      couponVersion: r.fields.CouponVersion ?? null,
    })),
    sideEffects: 'none',
  });
}

/**
 * **history-only repair**（状態は成功したが履歴だけ未記録、を収束させる）。
 *
 * 監査文字列に残した `op=<OperationId>` を根拠に、履歴に無い分だけを
 * **同じ OperationId** で積み直す。**状態は 1 バイトも触らない。**
 *
 * ⚠️ 同じ OperationId の operation lock を取ってから積む（並行 repair でも 1 件）。
 * ⚠️ 何度実行しても増えない（既に積まれていれば `already_recorded` でスキップ）。
 */
async function handleCouponHistoryRepair({ KEY, BASE, now, req }) {
  const recordId = String(req.recordId || '').trim();
  if (!recordId) return json(400, { error: 'recordId が必要です', sideEffects: 'none' });
  if (!isCouponHistoryEnabled(process.env)) {
    return json(503, {
      error: '操作履歴の保存が有効化されていないため修復できません（COUPON_HISTORY_TABLE_READY 未設定）。',
      code: 'history_disabled', sideEffects: 'none',
    });
  }

  const getRes = await fetch(`https://api.airtable.com/v0/${BASE}/${CUSTOMERS_TABLE}/${recordId}`, {
    headers: airtableHeaders(KEY),
  });
  if (!getRes.ok) return json(404, { error: 'Record not found', sideEffects: 'none' });
  const fields = (await getRes.json()).fields || {};

  const store = createCouponHistoryStore({ apiKey: KEY, baseId: BASE, env: process.env });
  const existing = await store.listForCustomer({ customerRecordId: recordId });
  if (!existing.available) {
    return json(503, {
      error: '操作履歴を読み取れないため修復できません。', code: existing.reason, sideEffects: 'none',
    });
  }

  // Customers に残っている**直近 1 回**の監査から未記録を拾う
  const audit = parseCouponAudit(readReopenCoupon(fields).source);
  const targets = findHistoryRepairTargets({
    audits: [{ customerRecordId: recordId, audit }], rows: existing.rows,
  });
  if (targets.length === 0) {
    return json(200, {
      recordId, repaired: 0, note: '未記録の操作はありません（履歴は state と一致しています）。',
      sideEffects: 'none',
    });
  }

  const lock = createCouponOperationLock({ redisCmd: makeRedisCmd(process.env) });
  // repair も**同じ entity lock**を取る（進行中の操作と直列化する）
  const entityId = couponEntityIdFor(recordId);
  const results = [];
  for (const t of targets) {
    const got = await lock.acquire({ entityId });
    if (got.status !== LOCK_RESULT.ACQUIRED) {
      results.push({ operationId: t.operationId, appended: false, reason: got.status });
      continue;
    }
    try {
      const record = buildRepairRecord({
        customerRecordId: recordId,
        productKey: PP_COUPON_BINDING.productKey,
        couponId: PP_COUPON_BINDING.couponId,
        version: PP_COUPON_BINDING.version,
        audit: t.audit,
        // 当時の前後状態は残っていないので**推測しない**（空のまま積む）
        beforeState: '', afterState: '',
      });
      const out = await store.append({ record, lockStatus: 'acquired' });
      results.push({ operationId: t.operationId, ...out });
    } finally {
      await lock.release({ entityId, token: got.token });
    }
  }
  return json(200, {
    recordId,
    repaired: results.filter((r) => r.appended).length,
    results,
    note: '履歴だけを積み直しました。**会員の状態は 1 バイトも変更していません。**',
    sideEffects: 'coupon_history_appended',
  });
}

/** 操作後の状態を **Airtable から読み直して**返す（送った値が通った前提にしない） */
async function reloadCouponState({ KEY, BASE, recordId, ledger }) {
  const fresh = await fetch(`https://api.airtable.com/v0/${BASE}/${CUSTOMERS_TABLE}/${recordId}`, {
    headers: airtableHeaders(KEY),
  });
  if (!fresh.ok) return null;   // 読めなければ null（成功したことにしない）
  const fields = (await fresh.json()).fields || {};
  const led = ledger || await readReservationLedger({ KEY, BASE });
  return describeCouponAdminState({
    fields,
    offerRows: led.available ? led.rows : null,
    ledgerAvailable: led.available === true,
    customerRecordId: recordId,
  });
}

/**
 * **会員ごとの**再募集開始状態を読む（**write なし**）。
 *
 * 一覧は会員数ぶんを **1 回の `HMGET`** で読む（会員ごとに引かない）。
 * ⚠️ 読めなかったときは `available:false`＝「確認できない」。**「全員未開始」に丸めない**。
 *
 * @param {{ rows: Array<{recordId:string,email?:string}> }} input
 * @returns {Promise<{ available: boolean, reason: string,
 *                     statusOf: (row:object)=>object, defOf: (row:object)=>object }>}
 */
async function readReopenStates(rows) {
  const store = createReopenStartStore({ redisCmd: makeRedisCmd(process.env) });
  let out;
  try {
    out = await store.readMany({
      recordIds: (rows || []).map((r) => r.recordId), timeoutMs: REOPEN_ADMIN_TIMEOUT_MS,
    });
  } catch {
    out = { available: false, reason: REOPEN_UNAVAILABLE.READ_FAILED, rows: new Map() };
  }
  const startsOf = (row) => {
    const hit = out.rows.get(String(row && row.recordId)) || null;
    return hit ? hit.startsAtIso : null;
  };
  return {
    available: out.available === true,
    reason: out.reason || '',
    /** 表示用の状態（会員 1 人ぶん）。確認ダイアログの文言も**対象会員入り**で作る */
    statusOf: (row) => resolveReopenStatus({
      available: out.available === true,
      startsAtIso: startsOf(row),
      reason: out.reason,
      memberLabel: (row && (row.email || row.name)) || '',
    }),
    /**
     * その会員の実効クーポン定義。
     * ⚠️ 読めない / 未開始なら基準定義のまま = 期限未確定 = 予約 write は fail closed。
     * ⚠️ **会員ごとに呼ぶこと**（1 人ぶんの def を他会員へ使い回さない）。
     */
    defOf: (row) => (out.available === true ? withReopenStart(startsOf(row)) : PP_REOPEN_COUPON),
  };
}

/**
 * 行に**会員ごとの**再募集状態を載せる（一覧・個別検索で共用）。
 * 有効期限の表示だけがこの軸に依存するので、そこだけ会員ごとに解き直す。
 */
async function attachReopenStart(rows) {
  const st = await readReopenStates(rows);
  const saleWritable = isSalePauseEnabled(process.env);
  for (const r of rows) {
    r.reopenStart = st.statusOf(r);
    // ⚠️ **その会員の**開始日時から導出する（未開始なら「募集再開日から14日間」のまま）
    r.reopenCouponExpiryText = describeCouponExpiry(st.defOf(r));
    // 「再募集 × 販売」を 1 つの状態として出す（運営者が主操作を迷わないため）。
    // ⚠️ 販売状態は行が既に持っている値をそのまま使う（別経路で読み直さない）。
    const view = classifyLaunch({
      reopen: { available: st.available, startsAtIso: r.reopenStart.startsAtIso, reason: st.reason },
      fields: {
        [PP_SALE_PAUSE_FIELDS.PAUSED]: r.salePaused === true,
        [PP_SALE_PAUSE_FIELDS.UPDATED_AT]: r.salePausedAt || '',
      },
    });
    r.reopenLaunch = {
      ...view,
      action: describeLaunchAction({
        view, memberLabel: r.email || r.name || '', salePauseWritable: saleWritable,
      }),
    };
  }
  return {
    available: st.available,
    reason: st.reason,
    /** 開始済みの人数（読めていないときは null＝件数を確定できない） */
    started: st.available ? rows.filter((r) => r.reopenStart.state === 'started').length : null,
  };
}

/**
 * action='reopenStatus'（read-only・**会員 1 人ぶん**）。押下後の確認・再読込に使う。
 */
async function handleReopenStatus({ req }) {
  const recordId = String((req && req.recordId) || '').trim();
  if (!isSafeCustomerRecordId(recordId)) {
    return json(400, {
      error: '会員の指定が不正です', code: REOPEN_START_REJECT.INVALID_MEMBER, sideEffects: 'none',
    });
  }
  const st = await readReopenStates([{ recordId, email: String((req && req.email) || '') }]);
  const row = { recordId, email: String((req && req.email) || '') };
  return json(200, {
    recordId,
    reopenStart: st.statusOf(row),
    sideEffects: 'none',
  });
}

/**
 * action='reopenStart' — **その会員 1 人の「販売再開 ＋ 再募集期間の開始」**（1 業務操作）。
 *
 * ## 何を書くか（2 か所・順序が意味を持つ）
 *
 * | 順 | 保存先 | 内容 | 冪等性 |
 * |---|---|---|---|
 * | ④ | Upstash Redis | その会員の `reopenStartsAt` | `HSETNX`（**再送しても変わらない**）|
 * | ⑥ | Airtable Customers | `PremiumPlusSalePaused=false`（+ 監査 3 列）| 既に false なら **PATCH しない** |
 *
 * **Redis を先に書く。** ⑥ が落ちても残るのは「開始済み・販売は停止したまま」＝
 * **お金の経路は閉じたまま**（fail closed）で、同じボタンの再送で復旧できる。
 * 逆順にすると「販売だけ開いて再募集期間が始まっていない」という悪い側に倒れる。
 *
 * ## 何を書かないか
 *
 * `PremiumPlusEligibility` / `PremiumPlusReleaseOverride` / `PremiumPlusEligibleAt` /
 * PHASE / route / プラン / 会員権 / 決済 / クーポン保有（3 列）は **1 バイトも変えない**。
 * **他会員のレコードにも触れない。**
 *
 * ## 時刻はサーバーが決める
 *
 * ⚠️ 要求 body の時刻（開始日時・現在時刻・期限）は**一切読まない**。
 *    受け取るのは `recordId`（対象会員）と `actor`（操作者名）だけ。
 *
 * ## 前提が 1 つでも確認できなければ**何も書かない**
 *
 * gate（Plus フィールド / 販売停止フィールド）・Airtable の read・Redis の read・排他。
 * 特に「停止中なのに販売停止フィールドが未有効」なら、**開始日時も書かない**
 * （開始だけ確定して売れない片側状態を作らない）。
 *
 * ## 緊急停止は勝手に解除しない
 *
 * 開始後に運営者が止めた会員（`pausedAt >= startsAt`、または停止時刻が不明）は
 * **409 で断る**。解除は独立した「販売を再開する」で明示的に行わせる。
 */
async function handleReopenStart({ KEY, BASE, now, req }) {
  const recordId = String((req && req.recordId) || '').trim();
  if (!isSafeCustomerRecordId(recordId)) {
    return json(400, {
      error: '会員の指定が不正です', code: LAUNCH_REJECT.INVALID_MEMBER, sideEffects: 'none',
    });
  }
  const actor = String((req && req.actor) || 'admin');
  const memberLabel = String((req && req.email) || '');
  const store = createReopenStartStore({ redisCmd: makeRedisCmd(process.env) });

  /** Airtable の 1 レコードを読む（read できなければ **null**＝何も書かない） */
  const readMember = async () => {
    const res = await fetch(`https://api.airtable.com/v0/${BASE}/${CUSTOMERS_TABLE}/${recordId}`, {
      headers: airtableHeaders(KEY),
    });
    if (!res.ok) return null;
    return (await res.json()).fields || {};
  };

  const gates = {
    plusFieldsReady: isPlusFieldsEnabled(process.env),
    salePauseWritable: isSalePauseEnabled(process.env),
  };

  // ① 前提の確認（両方の read）。読めなければ **何も書かない**
  const fields0 = await readMember();
  if (!fields0) {
    return json(404, { error: 'Record not found', code: LAUNCH_REJECT.UNAVAILABLE, sideEffects: 'none' });
  }
  const reopen0 = await store.read({ recordId, timeoutMs: REOPEN_ADMIN_TIMEOUT_MS });
  const plan0 = planReopenLaunch({ reopen: reopen0, fields: fields0, recordId, ...gates });
  if (!plan0.ok) return denyLaunch(plan0, recordId);

  // ② 排他（取れなければ書かない）。⑨ で必ず解放する
  const entityId = computeReopenLockId(recordId);
  const lock = createCouponOperationLock({ redisCmd: makeRedisCmd(process.env) });
  const got = await lock.acquire({ entityId });
  if (got.status !== LOCK_RESULT.ACQUIRED) {
    return json(503, {
      ok: false,
      code: got.status === LOCK_RESULT.LOST ? 'reopen_operation_in_progress' : 'reopen_lock_unavailable',
      error: got.status === LOCK_RESULT.LOST ? LOCK_REJECT_TEXT.lost : LOCK_REJECT_TEXT.unavailable,
      sideEffects: 'none',
    });
  }

  let startWritten = false;
  let saleResumed = false;
  try {
    // ③ lock 後に**読み直して**判断し直す（TOCTOU を閉じる）
    const fields = await readMember();
    if (!fields) {
      return json(404, { error: 'Record not found', code: LAUNCH_REJECT.UNAVAILABLE, sideEffects: 'none' });
    }
    const reopen = await store.read({ recordId, timeoutMs: REOPEN_ADMIN_TIMEOUT_MS });
    const plan = planReopenLaunch({ reopen, fields, recordId, ...gates });
    if (!plan.ok) return denyLaunch(plan, recordId);

    // 既に開始済みで販売中 = 何もしない（冪等な成功）
    if (plan.noop) {
      return await launchResult({
        KEY, BASE, recordId, store, memberLabel, gates,
        startWritten: false, saleResumed: false, created: false, alreadyStarted: true,
        note: '既にこの会員の再募集は開始済みで、販売も開いています（変更していません）。',
      });
    }

    // ④ Redis（HSETNX）。**書く直前に排他を検証する**
    if (plan.writeStart) {
      const held = await lock.verify({ entityId, token: got.token });
      if (!held.ok) {
        return json(503, {
          ok: false, code: 'reopen_operation_in_progress',
          error: LOCK_REJECT_TEXT.lost, sideEffects: 'none',
        });
      }
      const out = await store.start({ recordId, nowMs: now, actor });
      if (out.ok !== true) {
        // 保存できていないのに「開始した」と言わない（この時点で副作用ゼロ）
        return json(503, {
          ok: false, started: false, recordId,
          code: 'reopen_store_unavailable', reason: out.reason,
          error: 'この会員の再募集の開始日時を保存できませんでした。'
            + '何も変更していません。時間をおいて再実行してください。',
          sideEffects: 'none',
        });
      }
      startWritten = out.created === true;
    }

    // ⑥ Airtable（販売停止の解除）。**必要なときだけ** PATCH する
    if (plan.resumeSale) {
      const held = await lock.verify({ entityId, token: got.token });
      if (!held.ok) {
        // 開始日時は書けている可能性がある。**曖昧にせず**そのまま返す
        return await launchResult({
          KEY, BASE, recordId, store, memberLabel, gates,
          startWritten, saleResumed: false, created: startWritten, alreadyStarted: !plan.writeStart,
          status: 503, ok: false, code: 'reopen_operation_in_progress',
          note: '別の実行と競合したため、販売の再開は行っていません。'
            + '画面を再読込して状態を確認してください。',
        });
      }
      const built = buildSalePauseFields({
        paused: false,
        current: fields[PP_SALE_PAUSE_FIELDS.PAUSED],
        reason: '',
        // 監査に「どの操作で再開したか」を残す（冪等キーは再送で同じ値）
        actor: `${actor} / reopen-start op=${computeReopenOperationId(recordId)}`,
        now: new Date(now),
        enabled: true,
      });
      // 既に false なら PATCH しない（監査日時を無意味に更新しない）
      if (built && built.changed) {
        if (!assertOnlyPlusFields(built.fields)) {
          return json(500, { error: 'field allow-list violation', sideEffects: startWritten ? 'reopen_start_only' : 'none' });
        }
        const res = await fetch(`https://api.airtable.com/v0/${BASE}/${CUSTOMERS_TABLE}/${recordId}`, {
          method: 'PATCH',
          headers: { ...airtableHeaders(KEY), 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields: built.fields, typecast: true }),
        });
        if (!res.ok) {
          console.error('❌ [premium-plus-eligibility] 再募集開始: 販売再開 PATCH failed:', res.status);
          // **途中成功を曖昧にしない**。開始日時は確定・販売は停止のまま
          return await launchResult({
            KEY, BASE, recordId, store, memberLabel, gates,
            startWritten, saleResumed: false, created: startWritten, alreadyStarted: !plan.writeStart,
            status: 502, ok: false, code: 'sale_resume_failed',
            note: '再募集の開始日時は確定しましたが、**販売の再開に失敗しました**。'
              + 'この会員はまだ購入できません。もう一度同じボタンを実行すると、'
              + '開始日時はそのままで販売だけ再開します。',
          });
        }
        saleResumed = true;
      }
    }

    return await launchResult({
      KEY, BASE, recordId, store, memberLabel, gates,
      startWritten, saleResumed, created: startWritten, alreadyStarted: !plan.writeStart,
      note: '',
    });
  } finally {
    // ⑨ token 一致時のみ解放（crash 時は TTL で回復）
    await lock.release({ entityId, token: got.token });
  }
}

/** 計画段階で断ったときの応答（**副作用ゼロ**であることを明示する） */
function denyLaunch(plan, recordId) {
  const status = plan.reason === LAUNCH_REJECT.INVALID_MEMBER ? 400
    : (plan.reason === LAUNCH_REJECT.DELIBERATELY_PAUSED ? 409 : 503);
  return json(status, {
    ok: false, recordId, code: plan.reason, state: plan.state,
    error: plan.message, sideEffects: 'none',
  });
}

/**
 * 実行後の**実状態を読み直して**返す（送った値が通った前提にしない）。
 * `startWritten` / `saleResumed` を**別々に**返し、途中成功を曖昧にしない。
 */
async function launchResult({
  KEY, BASE, recordId, store, memberLabel, gates,
  startWritten, saleResumed, created, alreadyStarted, note, status = 200, ok = true, code,
}) {
  const res = await fetch(`https://api.airtable.com/v0/${BASE}/${CUSTOMERS_TABLE}/${recordId}`, {
    headers: airtableHeaders(KEY),
  });
  const fields = res.ok ? ((await res.json()).fields || {}) : null;
  const reopen = await store.read({ recordId, timeoutMs: REOPEN_ADMIN_TIMEOUT_MS });
  const view = classifyLaunch({ reopen, fields });
  const sideEffects = startWritten && saleResumed ? 'reopen_start_and_sale_resume'
    : (startWritten ? 'reopen_start_only' : (saleResumed ? 'sale_resume_only' : 'none'));
  return json(status, {
    ok,
    ...(code ? { code } : {}),
    recordId,
    /** この呼び出しが**実際に**開始日時を書いたか（false = 既にあったので書いていない）*/
    startWritten: startWritten === true,
    /** この呼び出しが**実際に**販売停止を解除したか */
    saleResumed: saleResumed === true,
    created: created === true,
    alreadyStarted: alreadyStarted === true,
    reopenStart: resolveReopenStatus({
      available: reopen.available, startsAtIso: reopen.startsAtIso, reason: reopen.reason,
      memberLabel,
    }),
    launch: {
      ...view,
      action: describeLaunchAction({
        view, memberLabel, salePauseWritable: gates.salePauseWritable,
      }),
    },
    /** 資格・段階公開・会員権・決済は触っていない（画面の履歴に残す）*/
    eligibilityUnchanged: true,
    note: note || '',
    sideEffects,
  });
}

async function handleList({ KEY, BASE, now, onlyReview }) {
  // 予約台帳は**1 回だけ**読む（会員ごとに引かない）。
  // ⚠️ 読めなければ available:false＝「確認できない」。**[] へ潰さない**
  const ledger = await readReservationLedger({ KEY, BASE });
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
      const row = buildAdminRow(rec, now, ledger);
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
  // 会員ごとの再募集開始状態（**1 回の HMGET**）。有効期限の表示もここで会員ごとに解き直す。
  const reopen = await attachReopenStart(rows);

  return json(200, {
    rows,
    // 予約台帳を読めたか（個別検索と同じ塊）。
    // ⚠️ 読めていないときは件数も状態も確定していない。画面は「確認できない」と出す。
    couponLedger: describeLedger(ledger),
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
      // 一時停止は資格とは別の軸なので**別に数える**（eligible / immediate からは引かない）。
      // 資格は「販売可」のまま止まっている、が正しい状態なので、
      // 上の件数から差し引くと「販売可」の実数が読めなくなる。
      salePaused: rows.filter((r) => r.salePaused === true).length,
      // 再募集クーポンの取得済み。**資格・停止のどちらの内訳でもない**ので別に数える。
      // 再募集時に「取得済み会員だけを抽出する」ための件数でもある。
      reopenCouponClaimed: rows.filter((r) => r.reopenCouponClaimed === true).length,
      // **会員ごとの**再募集を開始済みの人数。⚠️ 読めていないときは数えない（null）。
      // 0 と返すと「誰も開始していない」と読まれる（確認できないことを 0 件にしない）。
      reopenStarted: reopen.available
        ? rows.filter((r) => r.reopenStart && r.reopenStart.state === 'started').length
        : null,
      /**
       * **販売再開が未完了**（開始日時は確定したが停止解除が終わっていない）人数。
       * ⚠️ 放置すると「期限だけ進んで買えない」会員になるので、運営者に必ず見せる。
       */
      reopenIncomplete: reopen.available
        ? rows.filter((r) => r.reopenLaunch && r.reopenLaunch.state === LAUNCH_STATE.INCOMPLETE).length
        : null,
      // クーポンの**利用状態**の内訳。⚠️ 台帳を読めていないときは数えない（null）。
      // 0 と返すと「予約 0 件」と読まれる（確認できないことを 0 件にしない）。
      couponReserved: ledger.available
        ? rows.filter((r) => r.couponLifecycle && r.couponLifecycle.state === COUPON_LIFECYCLE.RESERVED).length
        : null,
      couponRedeemed: ledger.available
        ? rows.filter((r) => r.couponLifecycle && r.couponLifecycle.state === COUPON_LIFECYCLE.REDEEMED).length
        : null,
      couponNeedsRepair: ledger.available
        ? rows.filter((r) => r.couponLifecycle && r.couponLifecycle.needsRepair === true).length
        : null,
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
    // 販売の一時停止が**本番で実際に使えるか**。画面はこれで
    // 「今は使えない」ことを明示する（使えるように見せない）。
    // 2 系統（Airtable フィールド + deny-marker ストア）が揃って初めて true。
    salePause: {
      writable: isSalePauseEnabled(process.env),
      fieldsReady: isSalePauseEnabled(process.env),
    },
    // 再募集クーポンの取得記録が本番で保存できるか（停止フラグとは別 gate）
    reopenCoupon: {
      writable: isReopenCouponEnabled(process.env),
      fieldsReady: isReopenCouponEnabled(process.env),
      name: PP_REOPEN_COUPON.name,
      termsDetermined: PP_REOPEN_COUPON.terms.determined === true,
      termsText: describeCouponTerms(),
      // ⚠️ 期限が確定するのは「**その会員の**再募集を開始したあと」だけ。
      //    全体で確定するものではないので、ここでは常に false を返す（行ごとに見る）。
      expiryDetermined: false,
    },
    /**
     * 再募集の開始は**会員ごと**（全体で 1 個の開始日時は存在しない）。
     * ここに出すのは「読めたか」と「開始済みの人数」だけで、状態は各行の `reopenStart`。
     */
    reopenStarts: { available: reopen.available, reason: reopen.reason, started: reopen.started },
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
 * 会員単位の「販売中 ⇔ 一時停止」を切り替える（1 クリック操作の受け口）。
 *
 * ## 何を変えるか
 *
 * `PremiumPlusSalePaused` 系 4 フィールドだけ。
 * **販売資格（PremiumPlusEligibility）・段階公開 anchor・override は一切書かない。**
 * だから止めても資格は残り、再開すれば PHASE も元のまま戻る（rollback 可能）。
 *
 * ## 影響範囲
 *
 * 1 レコードのみ。他会員・16:30 以降の翌日販売・通常の eligibility 判定には影響しない
 * （停止判定は resolvePremiumPlusRelease の中で **その会員の fields からのみ**導出される）。
 *
 * ## fail closed
 *
 * フィールド未作成（gate off）なら **503 で拒否**する。書けないのに
 * 「停止しました」と返すと、止めたつもりで売れ続ける。
 */
async function handleSetSalePause({ KEY, BASE, now, req }) {
  if (!isPlusFieldsEnabled(process.env)) {
    return json(503, {
      error: 'Premium Plus フィールドが未有効（PREMIUM_PLUS_FIELDS_READY 未設定）',
      sideEffects: 'none',
    });
  }
  if (!isSalePauseEnabled(process.env)) {
    return json(503, {
      error: '販売の一時停止は未有効（PremiumPlusSalePaused 系フィールド未作成 / PREMIUM_PLUS_SALE_PAUSE_READY 未設定）',
      hint: 'Airtable に PremiumPlusSalePaused / PremiumPlusSalePausedAt / PremiumPlusSalePausedBy / PremiumPlusSalePauseReason を作成後、env を 1 にしてください',
      code: 'sale_pause_not_ready',
      sideEffects: 'none',
    });
  }

  const recordId = String(req.recordId || '').trim();
  if (!recordId) return json(400, { error: 'recordId が必要です', sideEffects: 'none' });
  if (typeof req.paused !== 'boolean') {
    return json(400, { error: 'paused は true / false で指定してください', sideEffects: 'none' });
  }

  // 変更前の状態は **Airtable から読む**（クライアント申告は信用しない）
  const getRes = await fetch(`https://api.airtable.com/v0/${BASE}/${CUSTOMERS_TABLE}/${recordId}`, {
    headers: airtableHeaders(KEY),
  });
  if (!getRes.ok) return json(404, { error: 'Record not found', sideEffects: 'none' });
  const currentFields = (await getRes.json()).fields || {};

  // 同時編集の検知。停止操作は**停止側の更新時刻**を版として使う
  // （資格の UpdatedAt とは別の軸なので混ぜない）。
  if (req.expectedPausedAt !== undefined) {
    const seen = String(req.expectedPausedAt ?? '').trim();
    const nowValue = String(currentFields[PP_SALE_PAUSE_FIELDS.UPDATED_AT] ?? '').trim();
    if (seen !== nowValue) {
      return json(409, {
        error: 'この会員の販売状態は別の操作で更新されています。再読込してから操作してください。',
        code: 'stale_record',
        seenPausedAt: seen || null,
        currentPausedAt: nowValue || null,
        sideEffects: 'none',
      });
    }
  }

  const built = buildSalePauseFields({
    paused: req.paused,
    current: currentFields[PP_SALE_PAUSE_FIELDS.PAUSED],
    reason: req.reason,
    actor: req.actor || 'admin',
    now: new Date(now),
    enabled: true,
  });
  if (!built) return json(400, { error: '販売状態の更新内容を組み立てられませんでした', sideEffects: 'none' });

  // 既に同じ状態なら PATCH しない（監査日時を無意味に更新しない）
  if (!built.changed) {
    return json(200, {
      success: true, recordId, paused: built.paused, changed: false,
      label: built.paused ? '一時停止中' : '販売中',
      note: '既に同じ状態のため変更していません',
      pausedAt: currentFields[PP_SALE_PAUSE_FIELDS.UPDATED_AT] || null,
      sideEffects: 'none',
    });
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
    console.error('❌ [premium-plus-eligibility] 販売停止 PATCH failed:', res.status);
    return json(502, {
      error: 'Airtable update failed', status: res.status, detail: detail.slice(0, 300),
    });
  }

  console.log('✅ [premium-plus-eligibility] 販売状態を更新:', {
    recordId, paused: built.paused, actor: req.actor || 'admin',
  });
  return json(200, {
    success: true,
    recordId,
    paused: built.paused,
    changed: true,
    previousPaused: currentFields[PP_SALE_PAUSE_FIELDS.PAUSED] === true,
    label: built.paused ? '一時停止中' : '販売中',
    pausedAt: built.fields[PP_SALE_PAUSE_FIELDS.UPDATED_AT] || null,
    pausedBy: built.fields[PP_SALE_PAUSE_FIELDS.UPDATED_BY] || null,
    // 資格は触っていないことを応答でも明示する（画面の履歴に残す）
    eligibilityUnchanged: true,
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
