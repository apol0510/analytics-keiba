/**
 * funnel-analytics.js — 有料化ファネルの計測（GA4 へ送るのはこのファイルだけ）
 *
 * ## なぜ要るか（2026-09-18 MK 確定）
 *
 * GA4 は `BaseLayout.astro` で全ページに入っている（測定 ID を持つのは
 * **BaseLayout の 1 か所だけ**。ここには書かない）。しかし
 * **カスタムイベントが 1 つも無かった**。見えるのは page_view だけなので、
 *
 *   流入 → 無料予想 → /results-showcase/ → /pricing/ → 申込
 *
 * の **最後の 1 段だけが観測できない**。申込はモーダルの中で起きて URL が
 * 変わらないため、page_view では「申込を始めた」と「申込が通った」を区別できない。
 *
 * | 段 | 何で見るか |
 * |---|---|
 * | 無料予想 / results-showcase / pricing 到達 | **page_view**（URL で判別できるのでイベントを増やさない）|
 * | 申込開始 | `application_start`（申込モーダルが開いた）|
 * | 申込成功 | `application_submitted`（**サーバーが受理を返した後だけ**）|
 * | 無料会員登録の完了 | `sign_up`（GA4 推奨イベント。**サーバーが新規登録を返したときだけ**・2026-09-29 追加）|
 * | カード決済の途中の段 | `card_checkout_click` / `card_checkout_email_form` / `card_checkout_blocked` / `card_checkout_error` / `pricing_card_link_click`（2026-10-22 追加・下の cardCheckoutStep）|
 *
 * ## なぜページごとに書かないのか
 *
 * `openBankModal` と申込フォームは **13 ページにコピペで散在**している
 * （過去に「15 ページだけ直し漏れて全部 400 で失敗」という事故が起きている）。
 * `campaign-price.js` と同じやり方で、**ここ 1 か所**で既存の関数を包む。
 * ページ側のコードは触らない（`dashboard.astro` だけは成功画面の共通処理を
 * 使っていないので、そこにだけ 1 行置く）。
 *
 * ## 絶対に守ること
 *
 * 1. **ボタンのクリックを「申込成功」にしない。**
 *    `application_submitted` は `bank-transfer-application` が受理を返した
 *    後の画面（成功画面の表示）からしか出ない。
 * 2. **入金確認（課金の確定）ではない。** 入金確認は Airtable の手作業で
 *    ブラウザには届かない。このイベントは「申込フォームの受理」まで。
 * 3. **個人を送らない。** 送る値は下の**閉じた語彙**だけ。氏名・メール・会員 ID・
 *    金額・振込日は受け取っても捨てる。構造的に混入しない形にしてある。
 *
 * ## GA4 管理画面側（コードではできないこと）
 *
 * カスタム ディメンション `plan` / `plan_type` の登録とキーイベント指定は
 * 管理画面の作業。未登録でもイベントは届く（探索でパラメータが使えないだけ）。
 * 手順は `astro-site/docs/GA4_CONVERSION_FUNNEL.md`。
 */
(function (global) {
  'use strict';

  /**
   * 送ってよいプラン名（**閉じた語彙**）。
   *
   * ⚠️ ここに無い文字列はすべて `'other'` に落とす。画面の商品名をそのまま
   *    送る作りにすると、将来だれかが商品名へ氏名やメールを混ぜた瞬間に
   *    GA4 へ流れる。「知っている名前だけ通す」ことで PII 混入を**設計で**塞ぐ。
   */
  var PLAN_LABELS = ['Premium Plus', 'Premium Sanrenpuku', 'Premium', 'Light', 'other'];
  var PLAN_TYPE_LABELS = ['Monthly', 'Annual', 'Lifetime'];

  /** 申込成功と見なす申請種別（`SubmissionResult` の history.type）。 */
  var APPLICATION_HISTORY_TYPE = 'bank-transfer';

  /**
   * 画面の商品名 → GA4 のプラン名。
   *
   * ⚠️ 判定順は変えないこと。`Premium Plus` と `Premium Sanrenpuku` は
   *    どちらも "Premium" を含むので、**細かい方から先に**見る。
   */
  function planLabel(planName) {
    var s = String(planName == null ? '' : planName);
    if (/premium\s*plus/i.test(s)) return 'Premium Plus';
    if (/sanrenpuku|三連複/i.test(s)) return 'Premium Sanrenpuku';
    if (/premium|プレミアム/i.test(s)) return 'Premium';
    if (/light|ライト|standard/i.test(s)) return 'Light';
    return 'other';
  }

  /**
   * 支払い期間 → GA4 の plan_type。
   *
   * `openBankModal(planName, amount)` のように **planType を渡さない呼び出し**が
   * 実在する（archive-sanrenpuku-all / sanrenpuku-demo / withdrawal-upsell）。
   * 申込成功側は商品名（`Premium Annual - Campaign (¥44,820/年)` の形）しか
   * 持っていない。どちらからも読めなければ Monthly
   * （`derivePlanFromProductName` の既定と揃える）。
   */
  function planTypeLabel(planType, planName) {
    var t = String(planType == null ? '' : planType).toLowerCase();
    if (t === 'lifetime') return 'Lifetime';
    if (t === 'annual') return 'Annual';
    if (t === 'monthly') return 'Monthly';
    var s = String(planName == null ? '' : planName);
    if (/lifetime|買い切り|永久/i.test(s)) return 'Lifetime';
    if (/annual|年払い|\/年/i.test(s)) return 'Annual';
    return 'Monthly';
  }

  // ── 二重送信よけ ────────────────────────────────────────────
  //
  // 申込まわりの処理は 13 ページへコピペで散っており、同じハンドラが二重に
  // 登録されていた事故が過去にある。同じイベント・同じプランが**ごく短時間に**
  // 続いたら 2 通目は捨てる。
  //
  // ⚠️ 「同じ人が 1 分後にもう一度モーダルを開いた」は**本物の再訪**なので
  //    捨てない。ここで潰すのは取りこぼしではなく**事故の重複**だけ。
  var DEDUPE_MS = 2000;
  var lastSent = {};

  function shouldSend(key, now) {
    var prev = lastSent[key];
    if (prev != null && now - prev < DEDUPE_MS) return false;
    lastSent[key] = now;
    return true;
  }

  /** 実際に GA4 へ送る。gtag が無い（未読込・広告ブロック）なら黙って何もしない。 */
  function send(eventName, planName, planType) {
    var params = {
      plan: planLabel(planName),
      plan_type: planTypeLabel(planType, planName)
    };
    var key = eventName + '|' + params.plan + '|' + params.plan_type;
    if (!shouldSend(key, Date.now())) return null;
    try {
      if (typeof global.gtag === 'function') global.gtag('event', eventName, params);
    } catch (e) {
      // 計測の失敗で申込を止めない
    }
    return { event: eventName, params: params };
  }

  /** 申込モーダルが開いた（＝申込開始）。成功ではない。 */
  function applicationStart(planName, planType) {
    return send('application_start', planName, planType);
  }

  /**
   * 申込がサーバーに受理された（＝申込成功）。
   * ⚠️ **必ず** `bank-transfer-application` が受理を返した後から呼ぶこと。
   */
  function applicationSubmitted(planName, planType) {
    return send('application_submitted', planName, planType);
  }

  /**
   * 無料会員の新規登録が完了した（GA4 推奨イベント `sign_up`）。
   *
   * ⚠️ **必ず** `auth-user` が `isNewUser: true` を返した後からだけ呼ぶこと
   *    （既存会員のログイン・ボタンのクリック・送信失敗では呼ばない）。
   * ⚠️ 送るのは `method: 'email'` だけ（閉じた語彙）。メール・会員 ID は送らない。
   */
  function signUpCompleted() {
    if (!shouldSend('sign_up', Date.now())) return null;
    var params = { method: 'email' };
    try {
      if (typeof global.gtag === 'function') global.gtag('event', 'sign_up', params);
    } catch (e) {
      // 計測の失敗で登録を止めない
    }
    return { event: 'sign_up', params: params };
  }

  // ── ページ側のコードを触らずに拾う ──────────────────────────

  /**
   * 既存の `openBankModal` を包む（`campaign-price.js` と同じやり方）。
   * 引数は `(planName, amount, planType)`。**amount は使わない**（送らない）。
   */
  function wrapOpenBankModal() {
    if (typeof global.openBankModal !== 'function' || global.__akFunnelModalWrapped) return false;
    var original = global.openBankModal;
    global.openBankModal = function (planName, amount, planType) {
      var out = original.apply(this, arguments);
      try { applicationStart(planName, planType); } catch (e) {}
      return out;
    };
    global.__akFunnelModalWrapped = true;
    return true;
  }

  /**
   * 既存の `SubmissionResult.showSuccessScreen` を包む。
   *
   * この関数は**サーバーが受理を返した分岐からしか呼ばれない**（13 ページ中
   * 12 ページ）。お問い合わせ・退会にも使われているので、
   * `history.type === 'bank-transfer'` のときだけ申込成功として数える。
   *
   * ⚠️ `history.details` には**メールアドレスが入っている**。ここで読むのは
   *    `productName` だけで、しかも閉じた語彙へ畳んでから送る。
   */
  function wrapSuccessScreen() {
    var SR = global.SubmissionResult;
    if (!SR || typeof SR.showSuccessScreen !== 'function' || global.__akFunnelSuccessWrapped) return false;
    var original = SR.showSuccessScreen;
    SR.showSuccessScreen = function (opts) {
      var out = original.apply(this, arguments);
      try {
        var h = (opts && opts.history) || {};
        if (String(h.type || '') === APPLICATION_HISTORY_TYPE) {
          var product = (h.details && h.details.productName) || h.label || '';
          applicationSubmitted(product, null);
        }
      } catch (e) {}
      return out;
    };
    global.__akFunnelSuccessWrapped = true;
    return true;
  }

  /**
   * 包む対象はこのファイルより後に定義されることがある
   * （`openBankModal` はページ末尾の is:inline スクリプト）。少しの間だけ待つ。
   */
  function install() {
    var doneModal = wrapOpenBankModal();
    var doneSuccess = wrapSuccessScreen();
    return doneModal && doneSuccess;
  }

  if (!install()) {
    var tries = 0;
    var timer = setInterval(function () {
      if (install() || ++tries > 40) clearInterval(timer);
    }, 100);
    if (global.document && global.document.addEventListener) {
      global.document.addEventListener('DOMContentLoaded', install);
    }
  }

  /** テスト用（本番コードからは使わない）。 */
  function _reset() { lastSent = {}; }

  /**
   * Stripe 月額（2026-10-02〜）。プラン ID は**閉じた語彙**（stripePlans.js の id）だけを通す。
   * - `begin_checkout`: Stripe の決済画面へ遷移する直前（サーバーが URL を返した後）
   * - `purchase`: 決済完了画面で**サーバーが反映済みを返した後**だけ。同じ決済で 2 回送らない
   */
  var STRIPE_PLAN_LABELS = { 'premium': 'Premium', 'premium-jra': 'Premium JRA', 'premium-nankan': 'Premium NANKAN' };
  var STRIPE_PLAN_YEN = { 'premium': 4980, 'premium-jra': 2980, 'premium-nankan': 2980 };
  /** PayPal 定期課金（2026-10-15〜）: 月額 3 本は Stripe と同じ商品・年額 2 本（paypalSubscriptionCore.SUBSCRIPTION_PLANS）。 */
  var ANNUAL_PLAN_LABELS = { 'premium-annual': 'Premium Annual', 'premium-annual-light': 'Premium Annual Light' };
  var ANNUAL_PLAN_YEN = { 'premium-annual': 49800, 'premium-annual-light': 44820 };
  var PAYMENT_METHODS = { stripe: 'stripe', paypal: 'paypal' };

  function stripeParams(planId, method) {
    var m = PAYMENT_METHODS[method] || 'stripe';
    if (m === 'paypal' && ANNUAL_PLAN_LABELS[planId]) {
      return { plan: ANNUAL_PLAN_LABELS[planId], plan_type: 'Annual', payment_method: m, currency: 'JPY', value: ANNUAL_PLAN_YEN[planId] };
    }
    var label = STRIPE_PLAN_LABELS[planId] || 'other';
    return { plan: label, plan_type: 'Monthly', payment_method: m, currency: 'JPY', value: STRIPE_PLAN_YEN[planId] || 0 };
  }

  function checkoutStart(planId, method) {
    try {
      if (typeof global.gtag === 'function') global.gtag('event', 'begin_checkout', stripeParams(planId, method));
    } catch (_) {}
  }

  function purchaseCompleted(planId, sessionId, method) {
    try {
      var key = 'ak_purchase_sent:' + String(sessionId || '').slice(0, 80);
      try { if (global.sessionStorage && global.sessionStorage.getItem(key)) return; } catch (_) {}
      var params = stripeParams(planId, method);
      // transaction_id は Stripe の決済セッション ID / PayPal の購読 ID（個人情報ではない・重複計上の防止）
      params.transaction_id = String(sessionId || '').slice(0, 80);
      if (typeof global.gtag === 'function') global.gtag('event', 'purchase', params);
      try { if (global.sessionStorage) global.sessionStorage.setItem(key, '1'); } catch (_) {}
    } catch (_) {}
  }

  /**
   * 料金ページのクレジットカード決済の途中の段（2026-10-22・PRICING_CONV_2026_10）。
   *
   * `begin_checkout` はサーバーが決済画面の URL を返した**後**にしか出ない。そのため
   * 「カードのボタンを押した」「未ログインでメールアドレス入力を求められた」
   * 「サーバーに断られた」「通信に失敗した」の各段で何人が止まったかが見えなかった。
   *
   * ⚠️ イベント名を段ごとに分ける（パラメータ `step` にすると GA4 管理画面で
   *    カスタム ディメンションを登録するまで標準レポートで分けられない）。
   * ⚠️ 送るのは `plan` / `plan_type`（登録済みのカスタム ディメンション）だけ。
   *    メールアドレス・金額・エラー本文は受け取らない（送りようがない）。
   * ⚠️ どれも**申込成功・購入ではない**（購入は `purchase` だけ）。
   */
  var CARD_STEP_EVENTS = {
    click: 'card_checkout_click',
    email_form: 'card_checkout_email_form',
    blocked: 'card_checkout_blocked',
    error: 'card_checkout_error',
    section_link: 'pricing_card_link_click'
  };

  function cardCheckoutStep(planId, step) {
    var name = Object.prototype.hasOwnProperty.call(CARD_STEP_EVENTS, step) ? CARD_STEP_EVENTS[step] : null;
    if (!name) return null;
    var params = {};
    if (planId) {
      var p = stripeParams(planId, 'paypal');
      params.plan = p.plan;
      params.plan_type = p.plan_type;
    }
    if (!shouldSend(name + '|' + (params.plan || ''), Date.now())) return null;
    try {
      if (typeof global.gtag === 'function') global.gtag('event', name, params);
    } catch (_) {}
    return { event: name, params: params };
  }

  global.AkFunnel = {
    cardCheckoutStep: cardCheckoutStep,
    CARD_STEP_EVENTS: CARD_STEP_EVENTS,
    checkoutStart: checkoutStart,
    purchaseCompleted: purchaseCompleted,
    PLAN_LABELS: PLAN_LABELS,
    PLAN_TYPE_LABELS: PLAN_TYPE_LABELS,
    APPLICATION_HISTORY_TYPE: APPLICATION_HISTORY_TYPE,
    DEDUPE_MS: DEDUPE_MS,
    planLabel: planLabel,
    planTypeLabel: planTypeLabel,
    applicationStart: applicationStart,
    applicationSubmitted: applicationSubmitted,
    signUpCompleted: signUpCompleted,
    _install: install,
    _reset: _reset
  };
})(typeof window !== 'undefined' ? window : this);
