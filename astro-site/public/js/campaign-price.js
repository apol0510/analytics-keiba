/**
 * campaign-price.js — 申込モーダルの金額を**サーバーが請求する額**に揃える
 *
 * ## なぜ要るか（2026-08-25 の不具合）
 *
 * キャンペーン割引はサーバーが `RequestedAmount` に確定値を書くが、
 * **画面のモーダルは元の金額のまま**だった。三連複なら
 *   案内「¥78,000 → ¥68,000」／ モーダル「¥78,000」／ 実際の請求 ¥68,000
 * となり、お客様は割引を確認できない。
 *
 * ## なぜページごとに直さないのか
 *
 * `openBankModal` は **16 ページにコピペで散在**している（過去に
 * 「15 ページだけ直し漏れて全部 400 で失敗」という事故が起きている）。
 * ここで **1 か所だけ**、既存の `openBankModal` を包んで金額を差し替える。
 *
 * ## 金額はサーバーが決める
 *
 * 表示する額は `/api/campaign.json?product=…` が返した値をそのまま出す。
 * **この画面では 1 円も計算しない。** 申込 Function と同じ関数・同じ商品名の
 * 読み替えを使うので、「見せた額」と「請求する額」は構造的に一致する。
 *
 * ⚠️ 取得に失敗したときは**元の金額のまま**にする（勝手に安く見せない）。
 */
(function () {
  var API = '/api/campaign.json';

  function declaredPlan() {
    try {
      var raw = localStorage.getItem('user-plan');
      if (!raw) return '';
      var o = JSON.parse(raw);
      return String((o && o.plan) || '');
    } catch (e) { return ''; }
  }

  /**
   * 三連複の買い切り権を持っているか（**事実だけを送る**。意味づけはサーバー）。
   * ⚠️ 三連複はプラン名に現れない（Airtable の別フィールド）。これを送らないと、
   *    買ったばかりの方に「三連複 10,000円OFF」を出し続ける（2026-08-25 実発生）。
   */
  function declaredSanrenpuku() {
    try {
      var raw = localStorage.getItem('user-plan');
      if (!raw) return '';
      var o = JSON.parse(raw);
      return (o && o.lifetimeSanrenpuku === true) ? '1' : '';
    } catch (e) { return ''; }
  }

  /** API へ渡す申告（2 か所で同じ文字列を作るための単一源）*/
  function declaredQuery() {
    return 'plan=' + encodeURIComponent(declaredPlan())
      + '&sanrenpuku=' + encodeURIComponent(declaredSanrenpuku());
  }

  function yen(n) { return '¥' + Number(n).toLocaleString('ja-JP'); }

  /**
   * 金額の下に出す 1 行（文言・行き先はサーバー由来）。
   * ⚠️ 登録のご案内には**必ずリンクを添える**。「◯◯円OFFになります」と
   *    言うだけで行き方が無いのは不親切（2026-08-25 MK 指摘）。
   */
  function setNote(text, color, link) {
    var amountEl = document.getElementById('modalAmount');
    if (!amountEl) return;
    var id = 'campaignPriceNote';
    var note = document.getElementById(id);
    if (!text) { if (note) note.remove(); return; }
    if (!note) {
      note = document.createElement('div');
      note.id = id;
      amountEl.parentNode.appendChild(note);
    }
    note.style.cssText = 'margin-top:.35rem;font-size:.82rem;font-weight:700;color:' + color + ';';
    note.textContent = '';
    note.appendChild(document.createTextNode(text));
    if (link && link.href && link.label) {
      var a = document.createElement('a');
      a.href = link.href;
      a.textContent = link.label;
      a.style.cssText = 'display:inline-block;margin-left:.5em;padding:.3em .9em;border-radius:999px;'
        + 'background:#f59e0b;color:#111827;font-weight:800;text-decoration:none;white-space:nowrap;';
      note.appendChild(a);
    }
  }

  /** モーダルの金額表示を差し替える。要素が無いページでは何もしない */
  function paint(pricing) {
    if (!pricing) return;
    // ⚠️ **無料登録特典**。未登録の方には割り引かず、登録のご案内だけ出す。
    //    金額は元のまま（勝手に安く見せない）。
    if (pricing.applied !== true) {
      setNote(pricing.registerPrompt || '', '#fbbf24', {
        href: pricing.registerHref, label: pricing.registerLabel,
      });
      return;
    }
    if (!pricing.finalPrice) return;

    var amountEl = document.getElementById('modalAmount');
    var infoEl = document.getElementById('modalPlanInfo');
    var inputEl = document.getElementById('transferAmount');

    // ⚠️ **元の金額も見せる**（2026-08-25 MK 指摘）。
    //    割引後だけだと、いくら得なのかがその場で分からない。
    if (amountEl) {
      amountEl.textContent = '';
      if (pricing.regularPrice) {
        var before = document.createElement('span');
        before.textContent = yen(pricing.regularPrice);
        before.style.cssText = 'margin-right:.5em;font-size:.8em;color:#94a3b8;text-decoration:line-through;';
        amountEl.appendChild(before);
      }
      amountEl.appendChild(document.createTextNode(yen(pricing.finalPrice)));
    }
    // 「プラン: X (¥49,800/年)」の金額部分だけを置き換える
    if (infoEl && pricing.regularPrice) {
      infoEl.textContent = infoEl.textContent.replace(yen(pricing.regularPrice), yen(pricing.finalPrice));
    }
    // ⚠️ 送信値も揃える。サーバーは自分で決め直すが、画面と送信値がズレたままにしない
    if (inputEl) inputEl.value = String(pricing.finalPrice);

    // 何が起きたのかを 1 行で伝える（文言はサーバー由来）
    // ⚠️ 元の金額は上の取り消し線で見えているので、ここでは繰り返さない
    if (pricing.note) setNote(pricing.note, '#34d399');
  }

  function fetchAndPaint(productName) {
    var url = API
      + '?' + declaredQuery()
      + '&product=' + encodeURIComponent(productName);
    fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { paint(j && j.pricing); })
      // ⚠️ 失敗したら**元の金額のまま**。勝手に安く見せない
      .catch(function () {});
  }

  /**
   * ページ内の「その商品の価格」を出している場所を、割引後の値へ揃える。
   *
   * ⚠️ 申込モーダルの手前に**もう 1 枚**説明の画面があると、そこだけ元の値段が残る
   *    （2026-08-25: 三連複の説明モーダルが ¥78,000 のままだった）。
   *    ページごとに書かず、印を付けた要素をここでまとめて差し替える。
   *
   *    使い方（ページ側は**金額を書き換えるコードを持たない**）:
   *      <span data-ak-price="Premium Sanrenpuku Lifetime">¥78,000</span>
   *      <span data-ak-price-strike="Premium Sanrenpuku Lifetime">¥108,000</span>
   *
   *    `data-ak-price`       … 割引後の金額に差し替える
   *    `data-ak-price-strike`… 取り消し線側。**割引前（＝いまの販売価格）**に差し替える
   */
  function paintMarkedPrices() {
    var nodes = document.querySelectorAll('[data-ak-price],[data-ak-price-strike]');
    if (!nodes.length) return;
    var byProduct = {};
    Array.prototype.forEach.call(nodes, function (el) {
      var name = el.getAttribute('data-ak-price') || el.getAttribute('data-ak-price-strike');
      if (!name) return;
      (byProduct[name] = byProduct[name] || []).push(el);
    });
    Object.keys(byProduct).forEach(function (name) {
      fetch(API + '?' + declaredQuery() + '&product=' + encodeURIComponent(name),
        { credentials: 'same-origin' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          var p = j && j.pricing;
          // ⚠️ 割引が乗らないときは**元の表示のまま**（勝手に書き換えない）
          if (!p || p.applied !== true || !p.finalPrice) return;
          byProduct[name].forEach(function (el) {
            if (el.hasAttribute('data-ak-price-strike')) el.textContent = yen(p.regularPrice);
            else el.textContent = yen(p.finalPrice);
          });
        })
        .catch(function () {});
    });
  }

  /** 既存の openBankModal を包む（ページ側のコードは 1 行も触らない） */
  function wrap() {
    if (typeof window.openBankModal !== 'function' || window.__akCampaignPriceWrapped) return false;
    var original = window.openBankModal;
    window.openBankModal = function (planName) {
      var out = original.apply(this, arguments);
      try { fetchAndPaint(planName); } catch (e) {}
      return out;
    };
    window.__akCampaignPriceWrapped = true;
    return true;
  }

  // 印を付けた価格は、モーダルを開く前に揃えておく
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', paintMarkedPrices);
  } else {
    paintMarkedPrices();
  }

  // ページ側の定義より後に読み込まれるとは限らないので、少しの間だけ待つ
  if (!wrap()) {
    var tries = 0;
    var timer = setInterval(function () {
      if (wrap() || ++tries > 40) clearInterval(timer);
    }, 100);
    document.addEventListener('DOMContentLoaded', wrap);
  }
})();
