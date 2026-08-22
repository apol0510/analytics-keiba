/**
 * /api/premium-plus-coupon.json — 「再募集時に使える優待クーポン」を取得する（SSR・POST のみ）
 *
 * ## 取得できるのは誰か（サーバー側でしか判定しない）
 *
 * **Plus の対象会員のうち、その会員の再募集が開始済みで期限内の人だけ**。
 * 判定は 1 か所（`resolveCouponAccess` / `resolveClaimDecision`）で、材料は
 * 「Plus の対象会員か（停止フラグを外したら商品ページを
 * 見られたはずの人か）。
 *
 * URL 直打ち・fetch の直接呼び出し・古いタブからの再送でも同じ判定を通る。
 * **画面が CTA を出していたかどうかは根拠にしない**（クライアントの状態は信用しない）。
 * 対象外には存在も知らせない（404）。
 *
 * ## 会員本人にしか紐づかない
 *
 * 対象レコードは **`ak_session` から解決した recordId のみ**。
 * body の id / email は読まない（他会員への発行・なりすましを構造的に防ぐ）。
 *
 * ## これが**しない**こと（guard テストで固定）
 *
 *   - 申込・課金・価格の変更・Premium 昇格
 *   - メール送信 / queue 登録 / 配信予約
 *   - 販売停止の解除（`PremiumPlusSalePaused` は 1 バイトも書かない）
 *   - 資格 / override / anchor / プラン / 決済フィールドの変更
 *
 * 書くのは `PremiumPlusReopenCoupon*` の 3 フィールドだけで、
 * `assertOnlyCouponFields` が PATCH 直前に機械的に検査する。
 *
 * ## 冪等
 *
 * 既に取得済みなら **PATCH せずに** 200 を返す（取得日時を上書きしない＝二重取得なし）。
 */
export const prerender = false;

import { verifyPlanAccess, PREMIUM_PLUS_CANDIDATE_PLANS } from '../../lib/auth/index.js';
import { lookupCustomerFields, invalidateCustomerFields } from '../../lib/premiumPlus/purchaseAnchorLookup.js';
import { resolveUpsellForCustomer } from '../../lib/upsell/upsellTarget.js';
import {
  readReopenCoupon,
  PP_REOPEN_COUPON_FIELDS,
  buildReopenCouponClaimFields,
  assertOnlyCouponFields,
  isReopenCouponEnabled,
  normalizeCouponSource,
} from '../../lib/premiumPlus/premiumPlusReopenCoupon.js';
// 「取得してよいか」の**単一源**。⚠️ 販売停止フラグでは決めない（2026-08-22 修正）
import {
  resolveCouponAccess,
  resolveClaimDecision,
  claimRejectStatus,
  COUPON_ACCESS_REJECT,
  describeCouponAccessReject,
} from '../../lib/premiumPlus/premiumPlusCouponAccess.js';
import { loadReopenStart } from '../../lib/premiumPlus/premiumPlusReopenStartStore.js';
import {
  COUPON_OPERATION,
  computeCouponEntityId,
  computeCouponOperationId,
} from '../../lib/coupons/couponPlatform.js';
import {
  createCouponOperationLock,
  LOCK_RESULT,
} from '../../lib/coupons/couponOperationLock.js';
import { createCouponHistoryStore } from '../../lib/coupons/couponHistoryStore.js';
import {
  buildHistoryRecord,
  isCouponHistoryEnabled,
} from '../../lib/coupons/couponOperationHistory.js';
import { PP_COUPON_BINDING } from '../../lib/premiumPlus/premiumPlusCouponAdmin.js';
import { makeRedisCmd } from '../../lib/premiumPlus/premiumPlusFunnelServer.js';

/** Airtable PATCH のタイムアウト（ms）。取得ボタンを長く待たせない。 */
const PATCH_TIMEOUT_MS = 4000;

function notFound() {
  return new Response('Not Found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' },
  });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, no-store',
      Vary: 'Cookie',
    },
  });
}

/**
 * Customers の 1 レコードへ**クーポンフィールドだけ**を PATCH する。
 * 失敗は例外を投げずに false（呼び出し側は「取得できなかった」と正直に返す）。
 */
async function patchCouponFields({ recordId, fields, env }) {
  if (!assertOnlyCouponFields(fields)) return false;
  const apiKey = env.AIRTABLE_API_KEY;
  const baseId = env.AIRTABLE_BASE_ID;
  const table = env.AIRTABLE_CUSTOMERS_TABLE || 'Customers';
  if (!apiKey || !baseId || !recordId) return false;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), PATCH_TIMEOUT_MS) : null;
  try {
    const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}/${encodeURIComponent(recordId)}`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields }),
      signal: controller ? controller.signal : undefined,
    });
    return !!res && res.ok;
  } catch {
    // 通信障害 / タイムアウト。レコード内容・鍵はログに出さない
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function POST({ request }) {
  const now = Date.now();

  const access = await verifyPlanAccess({
    cookieHeader: request.headers.get('cookie') || '',
    secret: process.env.SESSION_SIGNING_SECRET,
    now,
    allowedPlans: PREMIUM_PLUS_CANDIDATE_PLANS,
  });
  if (!access.ok) return notFound();

  // ⚠️ 対象は**セッションの recordId だけ**。body の id / email は読まない
  const recordId = access.payload?.sub || '';
  if (!recordId) return notFound();

  let body = {};
  try { body = await request.json(); } catch { body = {}; }
  const source = normalizeCouponSource(body && body.source);

  const fields = await lookupCustomerFields({ recordId, env: process.env, now });
  const view = resolveUpsellForCustomer({
    fields,
    nowMs: now,
    fallbackAnchor: process.env.PREMIUM_PLUS_FUNNEL_ANCHOR,
  });
  const coupon = readReopenCoupon(fields);
  const enabled = isReopenCouponEnabled(process.env);

  // ⚠️ **その会員の**再募集開始状態。読めなければ「未開始」に丸めず fail closed
  const reopen = await loadReopenStart({ recordId, env: process.env });
  const couponAccess = resolveCouponAccess({
    audience: view.plusAudience?.isPlusAudience === true,
    // ⚠️ 配る相手は「**いま買えない人**」。買える人には出さない
    salePaused: view.plusRelease?.salePaused === true,
    reopen,
    fields,
    nowMs: now,
    storageReady: enabled,
  });
  const decision = resolveClaimDecision(couponAccess);
  if (!decision.ok) {
    // 対象外は存在を知らせない。未開始・期限切れ・保存不可は理由を返す
    if (decision.reason === COUPON_ACCESS_REJECT.NOT_ELIGIBLE) return notFound();
    return json(claimRejectStatus(decision.reason), {
      ok: false,
      claimed: false,
      code: decision.reason,
      error: describeCouponAccessReject(decision.reason),
      sideEffects: 'none',
    });
  }
  // 既に取得済み: 何も書かずに成功（冪等・取得日時を保持）
  if (decision.alreadyClaimed) {
    return json(200, {
      ok: true, claimed: true, alreadyClaimed: true,
      claimedAt: coupon.claimedAtIso, sideEffects: 'none',
    });
  }

  // ── ここから先は管理操作と**同じ手順**（claim を例外にしない）──────
  //   ① 最初の read（上で完了）→ ② entity lock → ③ 再 read → ④ 再判定
  //   → ⑤ OperationId 算出 → ⑥ lock verify → ⑦ state 変更 → ⑧ history append
  const entityId = computeCouponEntityId({
    customerRecordId: recordId,
    productKey: PP_COUPON_BINDING.productKey,
    couponId: PP_COUPON_BINDING.couponId,
    version: PP_COUPON_BINDING.version,
  });
  const lock = createCouponOperationLock({ redisCmd: makeRedisCmd(process.env) });
  const got = await lock.acquire({ entityId });
  if (got.status !== LOCK_RESULT.ACQUIRED) {
    // ⚠️ 排他できないまま書かない（fail closed）。取得したことにもしない
    return json(503, {
      ok: false, claimed: false,
      code: got.status === LOCK_RESULT.LOST ? 'coupon_operation_in_progress' : 'coupon_lock_unavailable',
      sideEffects: 'none',
    });
  }

  try {
    // ③ lock 取得後に**読み直す**（TOCTOU を閉じる）。キャッシュを使わない
    invalidateCustomerFields(recordId);
    const freshFields = await lookupCustomerFields({ recordId, env: process.env, now });
    const freshCoupon = readReopenCoupon(freshFields);
    // ④ 再判定。lock 待ちの間に別の実行が取得していれば**既取得として 200**
    const freshReopen = await loadReopenStart({ recordId, env: process.env });
    const freshView = resolveUpsellForCustomer({
      fields: freshFields, nowMs: now,
      fallbackAnchor: process.env.PREMIUM_PLUS_FUNNEL_ANCHOR,
    });
    const freshAccess = resolveCouponAccess({
      audience: freshView.plusAudience?.isPlusAudience === true,
      salePaused: freshView.plusRelease?.salePaused === true,
      reopen: freshReopen,
      fields: freshFields,
      nowMs: now,
      storageReady: enabled,
    });
    const freshDecision = resolveClaimDecision(freshAccess);
    if (!freshDecision.ok) {
      if (freshDecision.reason === COUPON_ACCESS_REJECT.NOT_ELIGIBLE) return notFound();
      return json(claimRejectStatus(freshDecision.reason), {
        ok: false, claimed: false, code: freshDecision.reason,
        error: describeCouponAccessReject(freshDecision.reason), sideEffects: 'none',
      });
    }
    if (freshDecision.alreadyClaimed) {
      return json(200, {
        ok: true, claimed: true, alreadyClaimed: true,
        claimedAt: freshCoupon.claimedAtIso, sideEffects: 'none',
      });
    }

    // ⑤ 履歴の冪等キー（**現在時刻を材料にしない**。未取得からの claim なので anchor は 'none'）
    const operationId = computeCouponOperationId({
      productKey: PP_COUPON_BINDING.productKey,
      couponId: PP_COUPON_BINDING.couponId,
      version: PP_COUPON_BINDING.version,
      customerRecordId: recordId,
      operationType: COUPON_OPERATION.CLAIM,
      anchor: 'none',
    });

    const built = buildReopenCouponClaimFields({
      current: freshFields, now, source, enabled, operationId,
    });
    if (!built || built.changed !== true) {
      return json(503, {
        ok: false, claimed: false,
        code: COUPON_ACCESS_REJECT.STORAGE_UNAVAILABLE, sideEffects: 'none',
      });
    }

    // ⑥ 書く直前に lock を検証（奪われていたら書かない）
    const held = await lock.verify({ entityId, token: got.token });
    if (!held.ok) {
      return json(503, {
        ok: false, claimed: false, code: 'coupon_operation_in_progress', sideEffects: 'none',
      });
    }

    // ⑦ state 変更（クーポン 3 列だけ）
    const wrote = await patchCouponFields({ recordId, fields: built.fields, env: process.env });
    if (!wrote) {
      // 保存できていないのに「取得しました」と言わない
      return json(503, {
        ok: false, claimed: false,
        code: COUPON_ACCESS_REJECT.STORAGE_UNAVAILABLE, sideEffects: 'none',
      });
    }
    // 自分の更新だけキャッシュから落とす（直後のページ表示が「未取得」に戻らないように）
    invalidateCustomerFields(recordId);

    // ⑧ 履歴（同じ lock の中・同じ OperationId）。
    // ⚠️ **失敗しても取得は巻き戻さない。** `Source` に残した `op=` から
    //    後で history-only repair で積み直せる。
    const history = await appendClaimHistory({
      recordId, operationId, now, source, built, coupon: freshCoupon,
    });

    return json(200, {
      ok: true, claimed: true, alreadyClaimed: false,
      claimedAt: built.claimedAtIso, sideEffects: 'coupon_only',
      historyRecorded: history.appended === true,
    });
  } finally {
    // ⑨ token 一致時のみ解放（crash 時は TTL で回復）
    await lock.release({ entityId, token: got.token });
  }
}

/**
 * 取得の履歴を 1 行積む（**gate が off なら何もしない**）。
 * ⚠️ 失敗しても取得自体は成功のまま。`op=` から後で repair できる。
 */
async function appendClaimHistory({ recordId, operationId, now, source, built }) {
  if (!isCouponHistoryEnabled(process.env)) return { appended: false, reason: 'history_disabled' };
  const record = buildHistoryRecord({
    customerRecordId: recordId,
    productKey: PP_COUPON_BINDING.productKey,
    couponId: PP_COUPON_BINDING.couponId,
    version: PP_COUPON_BINDING.version,
    operationType: COUPON_OPERATION.CLAIM,
    // お客様ご自身の操作。管理者名は入らない
    actor: 'customer',
    reason: `お客様ご自身の取得（${normalizeCouponSource(source)}）`,
    beforeState: 'none',
    afterState: 'held',
    detail: String(built.fields[PP_REOPEN_COUPON_FIELDS.SOURCE] || ''),
    atIso: built.claimedAtIso || new Date(now).toISOString(),
    operationId,
  });
  if (!record) return { appended: false, reason: 'no_record' };
  const store = createCouponHistoryStore({
    apiKey: process.env.AIRTABLE_API_KEY,
    baseId: process.env.AIRTABLE_BASE_ID,
    env: process.env,
  });
  return store.append({ record, lockStatus: 'acquired' });
}

/** GET は使わせない（プリフェッチで意図せず取得させないため） */
export function GET() {
  return notFound();
}
