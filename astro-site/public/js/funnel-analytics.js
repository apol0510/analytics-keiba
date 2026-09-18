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

  global.AkFunnel = {
    PLAN_LABELS: PLAN_LABELS,
    PLAN_TYPE_LABELS: PLAN_TYPE_LABELS,
    APPLICATION_HISTORY_TYPE: APPLICATION_HISTORY_TYPE,
    DEDUPE_MS: DEDUPE_MS,
    planLabel: planLabel,
    planTypeLabel: planTypeLabel,
    applicationStart: applicationStart,
    applicationSubmitted: applicationSubmitted,
    _install: install,
    _reset: _reset
  };
})(typeof window !== 'undefined' ? window : this);
