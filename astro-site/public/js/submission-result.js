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
    recordSubmission: recordSubmission,
    getSubmissionHistory: getSubmissionHistory,
    clearSubmissionHistory: clearSubmissionHistory,
    buildSuccessHtml: buildSuccessHtml,
    showSuccessScreen: showSuccessScreen
  };
})(typeof window !== 'undefined' ? window : this);
