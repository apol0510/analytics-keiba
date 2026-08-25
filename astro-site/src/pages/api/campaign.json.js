/**
 * /api/campaign.json — 全会員向けキャンペーン割引の案内（**公開・read-only**）
 *
 * ## なぜ公開なのか
 *
 * ⚠️ **無料会員にはサーバーセッションが発行されない**（`ak_session` は有料判定用で、
 *    `sessionPayload.js` が `free_plan_not_allowed` で拒否する仕様）。
 *    そのため `/api/upsell.json` は無料の方に永久に 404 を返し、
 *    「全会員向け」と言いながら**有料の方にしか届いていなかった**
 *    （2026-08-24 MK 報告「無料でログインしたらお知らせがありません」）。
 *
 * ここが返すのは `/pricing/` に出ている**公開の価格情報**だけなので、
 * 認証なしで返しても漏れるものが無い。会員情報・契約状態は 1 つも返さない。
 *
 * ## どこまで正確か（正直に書く）
 *
 *   - **どの割引が存在するか / 期間 / 停止しているか** … 正確（サーバーが決める）
 *   - **その人にどれを出すか** … `?plan=` の申告で決める。**表示のためだけ**
 *   - **実際に割り引くか** … ここでは決めない。申込時にサーバーが
 *     Airtable の実データと停止スイッチ・個別除外を見て決める
 *
 * ⚠️ したがって `?plan=` を偽っても**お金は動かない**。見える案内が変わるだけ。
 * ⚠️ 個別除外は本人を特定できないため**表示には反映されない**。申込では効く。
 */
export const prerender = false;

import {
  describeCampaignForMember, isCampaignActive, describeCampaignDeadline,
  resolveCampaignPricing,
} from '../../lib/promotions/campaignOffers.js';
import { derivePlanFromProductName, hasOwnSpecialPrice } from '../../lib/payments/productName.js';
import { campaignControlStore } from '../../lib/promotions/campaignControlStore.js';
import { resolveCampaignAllowed } from '../../lib/promotions/campaignControl.js';

/** `?plan=` を、出し分けに使う権利の形へ読み替える（**表示のためだけ**） */
function entitlementsFromDeclaredPlan(raw) {
  const p = String(raw || '').trim().toLowerCase();
  if (p.includes('sanrenpuku') || p.includes('combo')) {
    return { canViewSanrenpuku: true, canViewPremium: true, canViewLight: true };
  }
  if (p.startsWith('premium') || p === 'pro' || p === 'pro-plus') {
    return { canViewPremium: true, canViewLight: true };
  }
  if (p === 'light' || p === 'standard') return { canViewLight: true };
  return {};
}

export async function GET({ url }) {
  const now = Date.now();

  // 停止スイッチは全員共通。読めなければ案内しない（fail closed）
  const control = await campaignControlStore(process.env).readControl();
  const allowed = resolveCampaignAllowed({
    withinWindow: isCampaignActive(now),
    control,
    // ⚠️ 本人を特定できないので個別除外は表示に反映できない。
    //    申込では必ず見る（`bank-transfer-application`）。ここでは「除外なし」として扱う。
    excluded: false,
  });

  const view = describeCampaignForMember({
    entitlements: entitlementsFromDeclaredPlan(url.searchParams.get('plan')),
    nowMs: now,
    allowed,
  });

  // ── `?product=` … その商品を**いくらで請求するか**を返す ────────────
  //
  // ⚠️ 申込画面が表示する金額はここから取る。
  //    画面が自分で計算すると「見せた額と請求額が違う」事故になる
  //    （2026-08-25: 三連複の申込モーダルが ¥78,000 のままだった）。
  //    申込 Function と**同じ関数・同じ商品名の読み替え**を使うこと。
  const product = url.searchParams.get('product');
  let pricing = null;
  if (product) {
    const d = derivePlanFromProductName(product);
    // すでに特別価格が付いた商品には重ねない（申込 Function と同じ扱い）
    const p = hasOwnSpecialPrice(d.fullPlanName)
      ? { applied: false, reason: 'has_own_special_price' }
      : resolveCampaignPricing({
        planName: d.planName,
        planType: d.planType,
        entitlements: entitlementsFromDeclaredPlan(url.searchParams.get('plan')),
        nowMs: now,
        allowed,
      });
    pricing = {
      applied: p.applied === true,
      reason: p.reason || '',
      planName: d.planName,
      planType: d.planType,
      // 割引が乗らないときは null（画面は元の金額のまま出す）
      finalPrice: p.applied === true ? p.finalPrice : null,
      regularPrice: p.applied === true ? p.regularPrice : null,
      discount: p.applied === true ? p.discount : null,
      /** 画面に添える 1 行（文言はサーバーが持つ）*/
      note: p.applied === true
        ? `キャンペーン適用：${Number(p.discount).toLocaleString('ja-JP')}円OFF`
        : '',
    };
  }

  return new Response(JSON.stringify({
    active: view.active,
    deadlineText: describeCampaignDeadline(),
    signature: view.signature,
    offers: view.offers,
    /** `?product=` を渡したときだけ入る。**請求される金額**（画面はこれを出す）*/
    pricing,
    /** ⚠️ 実際に割り引くかは申込時にサーバーが決める（ここは案内） */
    appliesAtCheckout: true,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      // 会員ごとに内容が変わるのでキャッシュさせない
      'Cache-Control': 'private, no-store',
    },
  });
}
