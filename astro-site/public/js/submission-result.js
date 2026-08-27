// 送信完了画面と申請履歴の共通ユーティリティ（クライアント側）
// is:inline スクリプトからも利用できるよう window.SubmissionResult に公開する
(function (global) {
  'use strict';

  var HISTORY_KEY = 'submission-history';
  var MAX_HISTORY = 50;

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function getSubmissionHistory() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      var list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch (e) {
      return [];
    }
  }

  // ── 誰の記録か（端末を共有しても混ざらないように）──────────────
  //
  // ⚠️ 2026-08-27 MK 報告: 有料会員がログアウトし、別の方が無料で
  //    ログインしても**前の方の申込履歴（商品名・金額）が見えていた**。
  //    記録は localStorage にあり、これまで**誰のものか**を見ていなかった。
  //
  // 2 段で塞ぐ:
  //   1. ログアウトで消す（`AUTH_LOCALSTORAGE_KEYS` に追加）
  //   2. 表示時にも本人のものだけに絞る（既に端末へ残っている記録の救済、
  //      ログアウトを挟まずに別アカウントでログインした場合の担保）

  function normalizeEmail(v) {
    return String(v == null ? '' : v).trim().toLowerCase();
  }

  /** いま見ている人のメールアドレス（分からなければ空文字） */
  function currentViewerEmail() {
    try {
      var raw = localStorage.getItem('user-plan');
      if (raw) {
        var o = JSON.parse(raw);
        if (o && o.email) return normalizeEmail(o.email);
      }
    } catch (e) { /* 読めないときは未ログイン扱い */ }
    try { return normalizeEmail(localStorage.getItem('userEmail')); } catch (e) { return ''; }
  }

  /**
   * この記録を、いま見ている人に見せてよいか。
   *
   * ⚠️ **別のアドレスの記録は見せない**（端末の共有・アカウント切替）。
   * ⚠️ 送り主が分からない記録は見せる（ログイン前の送信を消さないため）。
   * ⚠️ 見ている人が分からない（未ログイン）ときは従来どおり見せる。
   *    ログアウト時には記録ごと消えるので、ここで隠す必要が無い。
   */
  function belongsToViewer(entry, viewerEmail) {
    var owner = normalizeEmail(entry && entry.details && entry.details.email);
    var viewer = normalizeEmail(viewerEmail);
    if (!owner) return true;
    if (!viewer) return true;
    return owner === viewer;
  }

  /** いま見ている人に見せてよい記録だけ */
  function getVisibleSubmissionHistory(viewerEmail) {
    var viewer = viewerEmail === undefined ? currentViewerEmail() : viewerEmail;
    return getSubmissionHistory().filter(function (item) {
      return belongsToViewer(item, viewer);
    });
  }

  function recordSubmission(entry) {
    try {
      var list = getSubmissionHistory();
      var item = {
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        timestamp: new Date().toISOString(),
        type: (entry && entry.type) || 'submission',
        label: (entry && entry.label) || '送信',
        status: (entry && entry.status) || 'pending',
        details: (entry && entry.details) || {}
      };
      list.unshift(item);
      if (list.length > MAX_HISTORY) list.length = MAX_HISTORY;
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
      return item;
    } catch (e) {
      console.warn('recordSubmission failed', e);
    }
  }

  // ── 記録の読み方（文言の単一源）────────────────────────────
  //
  // ⚠️ この履歴は**この端末に残る「送信の記録」**で、サーバーの処理状況は入ってこない。
  //    入金確認は Airtable での手作業で、1 件ごとの状態を持つ台帳が無い。
  //    だから状態名は「送信しました」で固定し、**そのあとどうなるか**を商品ごとに言う。
  //
  // ⚠️ Premium Plus は**単品購入**で、会員ステータスには**反映されない**
  //    （買い目は入金確認後に個別にお届けする運用。docs/PREMIUM_PLUS.md）。
  //    プランの申込と同じ案内を出すと嘘になる（2026-08-26 MK 指摘）。

  var STATUS_TEXT = {
    pending: '送信しました',
    sent: '送信しました',
    completed: '完了',
    failed: '送信できませんでした'
  };

  /** その申込が Premium Plus（単品）か */
  function isPremiumPlusOrder(entry) {
    var e = entry || {};
    var name = (e.details && e.details.productName) || '';
    var text = String(name || e.label || '');
    return /Premium\s*Plus/i.test(text);
  }

  /** 状態の見え方（あとから見ても嘘にならない言葉だけ） */
  function describeStatus(entry) {
    var e = entry || {};
    var key = String(e.status || 'pending');
    return {
      label: STATUS_TEXT[key] || key,
      className: 'status-' + key
    };
  }

  /** このあとどうなるか（商品ごとに違う。空文字なら出さない） */
  function describeFollowUp(entry) {
    var e = entry || {};
    if (String(e.status || '') === 'failed') return '';
    if (String(e.type || '') !== 'bank-transfer') return '';
    // ⚠️ Premium Plus（単品購入）には**何も書かない**（2026-08-26 MK 判断）。
    //    この記録は書き換わらないので、「これからメールでご案内します」と書くと
    //    配信が済んだあとも未完了のままに読める（「確認待ち」と同じ誤り）。
    //    プランの行に案内を出せるのは、約束ではなく**変わらない事実の在り処**
    //    （会員ステータス）を指しているから。Plus にはその置き場が無い。
    if (isPremiumPlusOrder(e)) return '';
    return '入金の確認後、上の会員ステータスに反映されます。';
  }

  function clearSubmissionHistory() {
    try { localStorage.removeItem(HISTORY_KEY); } catch (e) {}
  }

  function buildSuccessHtml(options) {
    options = options || {};
    var title = options.title || '送信が完了しました';
    var message = options.message || 'ご送信ありがとうございました。';
    var subMessage = options.subMessage || '確認メールをお送りしましたのでご確認ください。マイページから申請状況も確認できます。';
    return (
      '<div class="submission-success-panel" role="status" aria-live="polite">' +
        '<div class="submission-success-icon">✅</div>' +
        '<h3 class="submission-success-title">' + escapeHtml(title) + '</h3>' +
        '<p class="submission-success-message">' + escapeHtml(message) + '</p>' +
        '<p class="submission-success-sub">' + escapeHtml(subMessage) + '</p>' +
        '<div class="submission-success-actions">' +
          '<a href="/" class="submission-success-btn submission-success-btn--secondary">🏠 トップに戻る</a>' +
          '<a href="/dashboard/" class="submission-success-btn submission-success-btn--primary">👤 マイページに戻る</a>' +
        '</div>' +
      '</div>'
    );
  }

  function ensureSuccessStyles() {
    if (document.getElementById('submission-success-styles')) return;
    var style = document.createElement('style');
    style.id = 'submission-success-styles';
    style.textContent = [
      '.submission-success-wrapper { display: block !important; background: transparent !important; border: none !important; padding: 0 !important; color: inherit !important; }',
      '.submission-success-panel {',
      '  background: linear-gradient(135deg, rgba(16, 185, 129, 0.12), rgba(59, 130, 246, 0.10));',
      '  border: 1px solid rgba(16, 185, 129, 0.45);',
      '  border-radius: 14px;',
      '  padding: 28px 24px;',
      '  text-align: center;',
      '  color: #e2e8f0;',
      '  box-shadow: 0 10px 30px rgba(16, 185, 129, 0.12);',
      '}',
      '.submission-success-icon { font-size: 48px; line-height: 1; margin-bottom: 12px; }',
      '.submission-success-title { font-size: 1.35rem; font-weight: 700; color: #34d399; margin: 0 0 10px; }',
      '.submission-success-message { font-size: 1rem; color: #e2e8f0; margin: 0 0 8px; line-height: 1.6; }',
      '.submission-success-sub { font-size: 0.9rem; color: #94a3b8; margin: 0 0 22px; line-height: 1.6; }',
      '.submission-success-actions { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }',
      '.submission-success-btn {',
      '  display: inline-block;',
      '  padding: 12px 22px;',
      '  border-radius: 10px;',
      '  font-weight: 700;',
      '  font-size: 0.95rem;',
      '  text-decoration: none;',
      '  transition: transform 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease;',
      '  min-width: 160px;',
      '  cursor: pointer;',
      '}',
      '.submission-success-btn--secondary {',
      '  background: rgba(15, 23, 42, 0.7);',
      '  color: #e2e8f0;',
      '  border: 1px solid rgba(148, 163, 184, 0.45);',
      '}',
      '.submission-success-btn--primary {',
      '  background: linear-gradient(135deg, #3b82f6, #8b5cf6);',
      '  color: #fff;',
      '  border: 1px solid transparent;',
      '  box-shadow: 0 6px 18px rgba(59, 130, 246, 0.35);',
      '}',
      '.submission-success-btn:hover { transform: translateY(-1px); opacity: 0.95; }',
      '@media (max-width: 480px) {',
      '  .submission-success-actions { flex-direction: column; }',
      '  .submission-success-btn { width: 100%; }',
      '}'
    ].join('\n');
    document.head.appendChild(style);
  }

  // メッセージ要素を「送信完了パネル」に置き換える
  // opts: { formEl, messageEl, hideEls, options, history }
  function showSuccessScreen(opts) {
    opts = opts || {};
    ensureSuccessStyles();
    var html = buildSuccessHtml(opts.options || {});
    if (opts.messageEl) {
      opts.messageEl.innerHTML = html;
      opts.messageEl.style.display = 'block';
      opts.messageEl.className = String(opts.messageEl.className || '').replace(/\b(success|error|form-message)\b/g, '').trim();
      opts.messageEl.classList.add('submission-success-wrapper');
    }
    if (opts.formEl) {
      opts.formEl.style.display = 'none';
    }
    if (opts.hideEls && opts.hideEls.length) {
      for (var i = 0; i < opts.hideEls.length; i++) {
        if (opts.hideEls[i]) opts.hideEls[i].style.display = 'none';
      }
    }
    if (opts.history) {
      recordSubmission(opts.history);
    }
    // スクロールして見えるようにする
    if (opts.messageEl && typeof opts.messageEl.scrollIntoView === 'function') {
      try { opts.messageEl.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) {}
    }
  }

  global.SubmissionResult = {
    currentViewerEmail: currentViewerEmail,
    belongsToViewer: belongsToViewer,
    getVisibleSubmissionHistory: getVisibleSubmissionHistory,
    isPremiumPlusOrder: isPremiumPlusOrder,
    describeStatus: describeStatus,
    describeFollowUp: describeFollowUp,
    recordSubmission: recordSubmission,
    getSubmissionHistory: getSubmissionHistory,
    clearSubmissionHistory: clearSubmissionHistory,
    buildSuccessHtml: buildSuccessHtml,
    showSuccessScreen: showSuccessScreen
  };
})(typeof window !== 'undefined' ? window : this);
