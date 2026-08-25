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
  resolveCampaignPricing, describeRegisterPrompt, CAMPAIGN_NOT_REGISTERED,
  describeCampaignOffersFor, CAMPAIGN_REGISTER_HREF, CAMPAIGN_REGISTER_LABEL,
} from '../../lib/promotions/campaignOffers.js';
import { derivePlanFromProductName, hasOwnSpecialPrice } from '../../lib/payments/productName.js';
import { campaignControlStore } from '../../lib/promotions/campaignControlStore.js';
import { resolveCampaignAllowed } from '../../lib/promotions/campaignControl.js';

/**
 * `?plan=` と `?sanrenpuku=` を、出し分けに使う権利の形へ読み替える（**表示のためだけ**）。
 *
 * ⚠️ **三連複の権利はプラン名に現れない。**
 *    三連複は買い切りの追加権で、Airtable では別フィールド `LifetimeSanrenpuku` が持つ。
 *    契約が「Premium ＋ 三連複買い切り」の方は `プラン` が `'Premium'` のままなので、
 *    プラン名だけで判定すると**買ったばかりの方に「三連複 10,000円OFF」を出し続ける**
 *    （2026-08-25 に実在の会員で発生）。
 *    そこで画面は保存済みの `lifetimeSanrenpuku` を**事実として**送り、
 *    それが何を意味するかの判断は（他の判定と同じく）ここサーバーが持つ。
 */
function entitlementsFromDeclaredPlan(raw, sanrenpukuRaw) {
  const p = String(raw || '').trim().toLowerCase();
  const lifetime = ['1', 'true', 'yes'].includes(String(sanrenpukuRaw || '').trim().toLowerCase());
  if (lifetime || p.includes('sanrenpuku') || p.includes('combo')) {
    return { canViewSanrenpuku: true, canViewPremium: true, canViewLight: true };
  }
  if (p.startsWith('premium') || p === 'pro' || p === 'pro-plus') {
    return { canViewPremium: true, canViewLight: true };
  }
  if (p === 'light' || p === 'standard') return { canViewLight: true };
  return {};
}

/** 登録済みだったらいくら安くなるか（案内文に使う） */
function discountIfRegistered(derived, allowed, now) {
  const p = resolveCampaignPricing({
    planName: derived.planName,
    planType: derived.planType,
    // 未登録の方は「無料の方」として案内する
    entitlements: {},
    nowMs: now,
    allowed,
    registered: true,
  });
  return p.applied === true ? p.discount : 0;
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
    entitlements: entitlementsFromDeclaredPlan(
      url.searchParams.get('plan'), url.searchParams.get('sanrenpuku'),
    ),
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
  // ⚠️ **無料登録特典**（2026-08-25 MK 確定）。
  //    画面が知っているのは localStorage の契約だけ。値があれば「ログイン＝登録済み」。
  //    無ければ未登録として扱い、割引を出さずに登録をご案内する。
  //    ⚠️ 登録済みでログインしていない方は通常価格が見えるが、申込では割り引かれる
  //       （＝見せた額より安い側なので安全）。
  const declared = url.searchParams.get('plan');
  const registered = String(declared || '').trim() !== '';
  let pricing = null;
  if (product) {
    const d = derivePlanFromProductName(product);
    // すでに特別価格が付いた商品には重ねない（申込 Function と同じ扱い）
    const p = hasOwnSpecialPrice(d.fullPlanName)
      ? { applied: false, reason: 'has_own_special_price' }
      : resolveCampaignPricing({
        planName: d.planName,
        planType: d.planType,
        entitlements: entitlementsFromDeclaredPlan(declared, url.searchParams.get('sanrenpuku')),
        nowMs: now,
        allowed,
        registered,
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
      /**
       * 未登録のため割り引かなかったときのご案内。
       * ⚠️ いくら安くなるかは**登録済みとして計算し直した結果**を出す
       *    （「◯◯円OFF」を画面で作らないため）。
       */
      // ⚠️ 割引の対象でない商品（Premium 月額など）には**案内を出さない**。
      //    「無料登録でお得に」とだけ出すと、登録しても安くならないのに期待させる。
      registerPrompt: (() => {
        if (p.applied || p.reason !== CAMPAIGN_NOT_REGISTERED) return '';
        const yen = discountIfRegistered(d, allowed, now);
        return yen > 0 ? describeRegisterPrompt(yen) : '';
      })(),
      /** ⚠️ 案内を出すときは**必ず行き方も渡す**（言うだけにしない） */
      registerHref: CAMPAIGN_REGISTER_HREF,
      registerLabel: CAMPAIGN_REGISTER_LABEL,
    };
  }

  // ── ページ上部のご案内（`/pricing/` `/free-signup/` などが出す）────────
  //
  // ⚠️ 文言はここで作る。**ページごとに書くと必ずズレる**（金額・期限・条件が
  //    3 か所で食い違った事故を 2026-08-24〜25 に繰り返した）。
  const banner = (() => {
    if (!view.active) return { show: false };
    const yen = (n) => `¥${Number(n).toLocaleString('ja-JP')}`;

    if (!registered) {
      // 未登録の方には「登録すると何が得か」を出す。金額は**実際の最大割引**から作る
      const best = describeCampaignOffersFor({})
        .reduce((max, o) => Math.max(max, Number(o.discountValue) || 0), 0);
      if (!best) return { show: false };
      return {
        show: true,
        headline: `無料登録で最大 ${Number(best).toLocaleString('ja-JP')}円OFF`,
        sub: `${describeCampaignDeadline()}の期間限定です。ご登録後、お申し込み時に自動で適用されます。`,
        ctaHref: CAMPAIGN_REGISTER_HREF,
        ctaLabel: CAMPAIGN_REGISTER_LABEL,
        offers: view.offers,
      };
    }
    // 登録済みの方には、その方が実際に使える割引を出す
    if (!view.offers.length) return { show: false };
    const lines = view.offers.map((o) => `${o.name}（${o.regularPriceText} → ${o.offerPriceText}）`);
    // ⚠️ 「ご優待が 3 件」だけでは**何が安くなるのか分からない**（2026-08-25 MK 指摘）。
    //    見出しにいくら安くなるかを出し、副文に中身を並べる。
    const best = view.offers.reduce((max, o) => {
      const n = Number(String(o.discountText).replace(/[^0-9]/g, '')) || 0;
      return Math.max(max, n);
    }, 0);
    return {
      show: true,
      headline: view.offers.length === 1
        ? view.offers[0].name
        : `期間限定のご優待 最大 ${best.toLocaleString('ja-JP')}円OFF`,
      sub: view.offers.length === 1
        ? `${view.offers[0].regularPriceText} → ${view.offers[0].offerPriceText}`
          + `／${describeCampaignDeadline()}・お申し込み時に自動で適用されます。`
        : `${view.offers.map((o) => o.name).join('・')}`
          + `／${describeCampaignDeadline()}・お申し込み時に自動で適用されます。`,
      // ⚠️ **買えない場所で案内しない**（2026-08-25 MK 指摘）。
      //    三連複は `/pricing/` で売っていないため、そこに出しても行き止まりになる。
      //    購入導線がマイページにしか無い商品しか無いときは、マイページへ送る。
      //    （見ているページがマイページなら、同じページ判定でボタンは出ない）
      ctaHref: view.offers.every((o) => !o.applyHref) ? '/dashboard/' : null,
      ctaLabel: view.offers.every((o) => !o.applyHref) ? 'マイページでお申し込み' : '',
      lines,
      offers: view.offers,
    };
  })();

  return new Response(JSON.stringify({
    active: view.active,
    /** ページ上部に出すご案内（文言はサーバーが持つ）*/
    banner,
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
