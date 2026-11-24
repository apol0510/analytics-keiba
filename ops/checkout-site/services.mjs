/**
 * services.mjs — 中立の決済専用サイト（checkout.tirol.link）で Paddle 決済を受ける「AK 以外のサービス」の表（純粋・単一源）
 *
 * 2026-11-24 MK 決定: KEIBA LIVE（KL）と 上部 圭の競馬な日々（HIBI）の Stripe アカウントが入金を受けられなくなったため、
 * カードの継続課金を Paddle へ移す。Paddle Live は承認ドメイン（checkout.tirol.link）でしか決済画面を開かないので、
 * AK と同じ中立サイトで取引を作り・決済画面を開き・通知を受けて、各サービスへ署名付きで転送する
 * （プロトコルの正本は apol0510/keiba-live PR #57 の web/src/lib/billing/paddleProvider.js・paddleWebhook.js・pages/api/billing/paddle-grant.js）。
 *
 * - 🛑 AK（analytics.keiba.link）の経路はこの表に入れない。AK の通知・取引は従来どおり（custom_data の ak_* で識別）。
 * - 各サービスの内部 secret は別（KL_GRANT_INTERNAL_SECRET / HIBI_GRANT_INTERNAL_SECRET・AK の CARD_GRANT_INTERNAL_SECRET とも別）。
 *   intent の署名に使った secret と、intent の svc・呼ばれた endpoint のサービスが一致するときだけ受ける。
 * - 価格・名前は各サービスの正本（KL: web/src/lib/tiers.js・HIBI: src/lib/tiers.js）の値を写したもの。🛑 価格は MK の事業判断。
 *   変えるときは各サービスの表と同時に変える（各サービスの webhook は plan_code と金額・JPY・周期がこの表と一致したときだけ権利を付ける）。
 * - 決済会社に見せる名前は中立名だけ（競馬関連語を含めない・checkoutSite.guard / servicePaddle.test が検査する）。
 * - 決済完了・閉じたときの戻り先は中立サイトの /r/<svc>/complete・/r/<svc>/cancel（`_redirects` で各サービスへ 302）。
 */

export const SERVICES = Object.freeze({
  kl: Object.freeze({
    svc: 'kl',
    secretEnv: 'KL_GRANT_INTERNAL_SECRET',
    grantUrl: 'https://keiba-live.com/api/billing/paddle-grant',
    successUrl: 'https://keiba-live.com/checkout/success',
    cancelUrl: 'https://keiba-live.com/pricing?checkout=canceled',
    // KL の PADDLE_PLAN_TABLE（tiers.js の PLANS・paymentDisplayNames）と同じ値
    plans: Object.freeze([
      Object.freeze({ planCode: 'PL-M', name: 'Live Analytics Premium Light (Monthly)', amount: '2980', currency: 'JPY', interval: 'month', frequency: 1 }),
      Object.freeze({ planCode: 'PL-Y', name: 'Live Analytics Premium Light (Annual)', amount: '29800', currency: 'JPY', interval: 'year', frequency: 1 }),
      Object.freeze({ planCode: 'P-M', name: 'Live Analytics Premium (Monthly)', amount: '5980', currency: 'JPY', interval: 'month', frequency: 1 }),
      Object.freeze({ planCode: 'P-Y', name: 'Live Analytics Premium (Annual)', amount: '59800', currency: 'JPY', interval: 'year', frequency: 1 }),
    ]),
  }),
  hibi: Object.freeze({
    svc: 'hibi',
    secretEnv: 'HIBI_GRANT_INTERNAL_SECRET',
    grantUrl: 'https://apolon.keibanahibi.com/api/billing/paddle-grant',
    // HIBI の service.js（Stripe）と同じ戻り先
    successUrl: 'https://apolon.keibanahibi.com/checkout/success',
    cancelUrl: 'https://apolon.keibanahibi.com/pricing?checkout=canceled',
    // カードの継続課金は月額だけ（6 か月・12 か月は銀行振込のみ・HIBI tiers.js）
    plans: Object.freeze([
      // offers: 初回の請求だけの値引き（Paddle の discount を env の ID で付ける）。対象の判定（カムバックの資格）は HIBI が済ませてから intent に offer を付ける。
      //   comeback = 初月 1,000 円（Paddle の discount: flat 4,980 JPY・recur false → 初回 1,000 円・2 回目以降 5,980 円・HIBI §6.6）
      Object.freeze({ planCode: 'P-M', name: 'Daily Analytics Premium (Monthly)', amount: '5980', currency: 'JPY', interval: 'month', frequency: 1,
        offers: Object.freeze({ comeback: Object.freeze({ discountEnv: 'HIBI_PADDLE_DISCOUNT_COMEBACK' }) }) }),
    ]),
  }),
});

export const SERVICE_IDS = Object.freeze(Object.keys(SERVICES));

/** 中立サイトの戻り先（Paddle.js の successUrl・閉じたとき）。パスに競馬関連語を入れない */
export const servicePaths = (svc) => ({ complete: `/r/${svc}/complete`, cancel: `/r/${svc}/cancel` });

/** checkout.tirol.link の `_redirects` に足す行（AK の NEUTRAL_ROUTES の後ろ）。各サービスの実 URL へ 302 */
export const SERVICE_ROUTES = Object.freeze(SERVICE_IDS.flatMap((id) => [
  Object.freeze({ from: servicePaths(id).complete, to: SERVICES[id].successUrl, status: '302!' }),
  Object.freeze({ from: servicePaths(id).cancel, to: SERVICES[id].cancelUrl, status: '302!' }),
]));

export const serviceById = (svc) => (typeof svc === 'string' && Object.prototype.hasOwnProperty.call(SERVICES, svc) ? SERVICES[svc] : null);
/** プランの初回特典（offer）。表に無い offer は null（拒否する側が判定する） */
export const offerFor = (plan, offer) => (plan?.offers && typeof offer === 'string' && Object.prototype.hasOwnProperty.call(plan.offers, offer) ? plan.offers[offer] : null);
export const planFor = (svc, planCode) => serviceById(svc)?.plans.find((p) => p.planCode === planCode) || null;
