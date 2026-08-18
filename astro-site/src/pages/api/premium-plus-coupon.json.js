/**
 * /api/premium-plus-coupon.json — 「再募集時に使える優待クーポン」を取得する（SSR・POST のみ）
 *
 * ## 取得できるのは誰か（サーバー側でしか判定しない）
 *
 * **販売を一時停止している対象会員だけ**。判定は 1 か所（`resolveCouponClaimDecision`）で、
 * 材料は `resolveUpsellForCustomer().pauseNotice`（＝停止フラグを外したら商品ページを
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
  buildReopenCouponClaimFields,
  resolveCouponClaimDecision,
  assertOnlyCouponFields,
  isReopenCouponEnabled,
  normalizeCouponSource,
  COUPON_CLAIM_REJECT,
} from '../../lib/premiumPlus/premiumPlusReopenCoupon.js';

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

  const decision = resolveCouponClaimDecision({
    pauseNotice: view.pauseNotice,
    coupon,
    enabled,
  });
  if (!decision.ok) {
    // 対象外は存在を知らせない
    if (decision.reason === COUPON_CLAIM_REJECT.NOT_ELIGIBLE) return notFound();
    // 保存先が本番でまだ有効化されていない。**取得したことにしない**（fail closed）
    return json(503, {
      ok: false,
      claimed: false,
      code: decision.reason,
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

  const built = buildReopenCouponClaimFields({ current: fields, now, source, enabled });
  if (!built || built.changed !== true) {
    return json(503, {
      ok: false, claimed: false,
      code: COUPON_CLAIM_REJECT.STORAGE_UNAVAILABLE, sideEffects: 'none',
    });
  }

  const wrote = await patchCouponFields({ recordId, fields: built.fields, env: process.env });
  if (!wrote) {
    // 保存できていないのに「取得しました」と言わない
    return json(503, {
      ok: false, claimed: false,
      code: COUPON_CLAIM_REJECT.STORAGE_UNAVAILABLE, sideEffects: 'none',
    });
  }
  // 自分の更新だけキャッシュから落とす（直後のページ表示が「未取得」に戻らないように）
  invalidateCustomerFields(recordId);

  return json(200, {
    ok: true, claimed: true, alreadyClaimed: false,
    claimedAt: built.claimedAtIso, sideEffects: 'coupon_only',
  });
}

/** GET は使わせない（プリフェッチで意図せず取得させないため） */
export function GET() {
  return notFound();
}
