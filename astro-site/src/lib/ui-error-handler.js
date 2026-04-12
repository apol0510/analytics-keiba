/**
 * フロントエンド用エラーハンドリング・UI改善モジュール
 * ユーザーフレンドリーなエラー表示とトースト通知を提供
 */

/**
 * エラーメッセージの種類とスタイル
 */
export const ERROR_TYPES = {
    ERROR: {
        type: 'error',
        icon: '❌',
        color: '#ef4444',
        bgColor: 'rgba(239, 68, 68, 0.1)',
        borderColor: 'rgba(239, 68, 68, 0.3)'
    },
    WARNING: {
        type: 'warning',
        icon: '⚠️',
        color: '#f59e0b',
        bgColor: 'rgba(245, 158, 11, 0.1)',
        borderColor: 'rgba(245, 158, 11, 0.3)'
    },
    SUCCESS: {
        type: 'success',
        icon: '✅',
        color: '#10b981',
        bgColor: 'rgba(16, 185, 129, 0.1)',
        borderColor: 'rgba(16, 185, 129, 0.3)'
    },
    INFO: {
        type: 'info',
        icon: '💡',
        color: '#3b82f6',
        bgColor: 'rgba(59, 130, 246, 0.1)',
        borderColor: 'rgba(59, 130, 246, 0.3)'
    },
    LOADING: {
        type: 'loading',
        icon: '⏳',
        color: '#6b7280',
        bgColor: 'rgba(107, 114, 128, 0.1)',
        borderColor: 'rgba(107, 114, 128, 0.3)'
    }
};

/**
 * ユーザーフレンドリーなエラーメッセージマッピング
 */
export const FRIENDLY_MESSAGES = {
    // ネットワークエラー
    'NetworkError': 'インターネット接続を確認してください',
    'Failed to fetch': 'サーバーに接続できません。しばらく待ってから再試行してください',
    'TypeError: Failed to fetch': 'ネットワーク接続に問題があります',
    
    // 認証エラー
    'Unauthorized': 'ログインが必要です',
    'Forbidden': 'この操作を実行する権限がありません',
    'Authentication failed': 'ログイン情報を確認してください',
    
    // バリデーションエラー
    'Invalid JSON': 'データ形式に誤りがあります',
    'Required field missing': '必須項目が入力されていません',
    'Validation failed': '入力内容を確認してください',
    
    // データベースエラー
    'Database connection failed': 'システムエラーが発生しました。管理者にお問い合わせください',
    'Record not found': '指定されたデータが見つかりません',
    'Duplicate entry': '同じデータが既に存在します',
    
    // 汎用エラー
    'Internal Server Error': 'システムエラーが発生しました。しばらく待ってから再試行してください',
    'Service unavailable': 'サービスが一時的に利用できません',
    'Timeout': '処理がタイムアウトしました。再試行してください'
};

/**
 * トースト通知システム
 */
class ToastManager {
    constructor() {
        this.container = this.createContainer();
        this.toasts = new Map();
        this.nextId = 1;
    }
    
    createContainer() {
        let container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.style.cssText = `
                position: fixed;
                top: 20px;
                right: 20px;
                z-index: 10000;
                max-width: 400px;
                width: 100%;
                pointer-events: none;
            `;
            document.body.appendChild(container);
        }
        return container;
    }
    
    show(message, type = 'info', duration = 5000, options = {}) {
        const id = this.nextId++;
        const config = ERROR_TYPES[type.toUpperCase()] || ERROR_TYPES.INFO;
        
        const toast = document.createElement('div');
        toast.id = `toast-${id}`;
        toast.style.cssText = `
            background: ${config.bgColor};
            border: 1px solid ${config.borderColor};
            color: ${config.color};
            padding: 16px 20px;
            border-radius: 12px;
            margin-bottom: 12px;
            backdrop-filter: blur(10px);
            box-shadow: 0 4px 20px rgba(0,0,0,0.1);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 14px;
            font-weight: 500;
            line-height: 1.4;
            transform: translateX(100%);
            transition: all 0.3s ease;
            pointer-events: auto;
            cursor: pointer;
            position: relative;
            overflow: hidden;
        `;
        
        toast.innerHTML = `
            <div style="display: flex; align-items: flex-start; gap: 12px;">
                <span style="font-size: 18px; flex-shrink: 0;">${config.icon}</span>
                <div style="flex: 1;">
                    <div style="font-weight: 600; margin-bottom: 4px;">${this.getTypeLabel(type)}</div>
                    <div>${message}</div>
                </div>
                <button style="
                    background: none;
                    border: none;
                    color: ${config.color};
                    cursor: pointer;
                    font-size: 18px;
                    padding: 0;
                    line-height: 1;
                    opacity: 0.7;
                    flex-shrink: 0;
                " onclick="window.toastManager.hide(${id})">×</button>
            </div>
        `;
        
        // プログレスバー（自動消失用）
        if (duration > 0) {
            const progressBar = document.createElement('div');
            progressBar.style.cssText = `
                position: absolute;
                bottom: 0;
                left: 0;
                height: 2px;
                background: ${config.color};
                animation: toast-progress ${duration}ms linear;
            `;
            toast.appendChild(progressBar);
            
            // プログレスバーアニメーション
            const style = document.createElement('style');
            style.textContent = `
                @keyframes toast-progress {
                    from { width: 100%; }
                    to { width: 0%; }
                }
            `;
            document.head.appendChild(style);
        }
        
        this.container.appendChild(toast);
        this.toasts.set(id, { toast, timer: null });
        
        // アニメーション開始
        requestAnimationFrame(() => {
            toast.style.transform = 'translateX(0)';
        });
        
        // 自動消失タイマー
        if (duration > 0) {
            const timer = setTimeout(() => this.hide(id), duration);
            this.toasts.get(id).timer = timer;
        }
        
        // クリックで消去
        toast.addEventListener('click', () => this.hide(id));
        
        return id;
    }
    
    hide(id) {
        const toastData = this.toasts.get(id);
        if (!toastData) return;
        
        const { toast, timer } = toastData;
        
        if (timer) {
            clearTimeout(timer);
        }
        
        toast.style.transform = 'translateX(100%)';
        toast.style.opacity = '0';
        
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
            this.toasts.delete(id);
        }, 300);
    }
    
    getTypeLabel(type) {
        const labels = {
            error: 'エラー',
            warning: '警告',
            success: '成功',
            info: '情報',
            loading: '処理中'
        };
        return labels[type.toLowerCase()] || '通知';
    }
    
    clear() {
        this.toasts.forEach((_, id) => this.hide(id));
    }
}

// グローバルインスタンス
let toastManager;
if (typeof window !== 'undefined') {
    toastManager = new ToastManager();
    window.toastManager = toastManager;
}

/**
 * エラーを解析してユーザーフレンドリーなメッセージを生成
 * @param {Error|string} error - エラーオブジェクトまたはメッセージ
 * @returns {string} ユーザーフレンドリーなメッセージ
 */
export function getFriendlyErrorMessage(error) {
    if (typeof error === 'string') {
        return FRIENDLY_MESSAGES[error] || error;
    }
    
    if (error && error.message) {
        const message = error.message;
        
        // 完全一致を最初にチェック
        if (FRIENDLY_MESSAGES[message]) {
            return FRIENDLY_MESSAGES[message];
        }
        
        // 部分一致でチェック
        for (const [key, friendlyMessage] of Object.entries(FRIENDLY_MESSAGES)) {
            if (message.includes(key)) {
                return friendlyMessage;
            }
        }
        
        return message;
    }
    
    return 'エラーが発生しました';
}

/**
 * 統一されたエラー表示関数
 * @param {Error|string} error - エラー
 * @param {string} context - エラーが発生した場所
 * @param {Object} options - 表示オプション
 */
export function showError(error, context = '', options = {}) {
    const message = getFriendlyErrorMessage(error);
    const contextPrefix = context ? `[${context}] ` : '';
    
    // コンソールにログ出力
    console.error(`${contextPrefix}${error}`);
    
    // トースト通知
    if (toastManager && !options.silent) {
        toastManager.show(message, 'error', options.duration);
    }
    
    // 既存のアラート要素にも表示
    const alertElement = document.getElementById('alert');
    if (alertElement) {
        alertElement.innerHTML = `❌ ${message}`;
        alertElement.className = 'alert error';
        alertElement.style.display = 'block';
        
        if (options.autoHide !== false) {
            setTimeout(() => {
                alertElement.style.display = 'none';
            }, options.duration || 5000);
        }
    }
}

/**
 * 成功メッセージ表示
 */
export function showSuccess(message, options = {}) {
    if (toastManager) {
        toastManager.show(message, 'success', options.duration || 3000);
    }
    
    const alertElement = document.getElementById('alert');
    if (alertElement) {
        alertElement.innerHTML = `✅ ${message}`;
        alertElement.className = 'alert success';
        alertElement.style.display = 'block';
        
        if (options.autoHide !== false) {
            setTimeout(() => {
                alertElement.style.display = 'none';
            }, options.duration || 3000);
        }
    }
}

/**
 * 警告メッセージ表示
 */
export function showWarning(message, options = {}) {
    if (toastManager) {
        toastManager.show(message, 'warning', options.duration || 4000);
    }
}

/**
 * 情報メッセージ表示
 */
export function showInfo(message, options = {}) {
    if (toastManager) {
        toastManager.show(message, 'info', options.duration || 3000);
    }
}

/**
 * 非同期処理のエラーハンドリングラッパー
 * @param {Function} asyncFn - 非同期関数
 * @param {string} context - コンテキスト
 * @param {Object} options - オプション
 */
export async function withErrorHandling(asyncFn, context = '', options = {}) {
    try {
        if (options.showLoading) {
            const loadingId = toastManager.show('処理中...', 'loading', 0);
            
            try {
                const result = await asyncFn();
                toastManager.hide(loadingId);
                return result;
            } catch (error) {
                toastManager.hide(loadingId);
                throw error;
            }
        } else {
            return await asyncFn();
        }
    } catch (error) {
        showError(error, context, options);
        throw error;
    }
}

/**
 * フォームバリデーションエラーの表示
 * @param {Object} errors - フィールド別エラー
 * @param {string} formId - フォームのID
 */
export function showValidationErrors(errors, formId = '') {
    Object.entries(errors).forEach(([field, message]) => {
        const fieldElement = document.getElementById(field);
        const errorElement = document.getElementById(`${field}-error`);
        
        if (fieldElement) {
            fieldElement.style.borderColor = ERROR_TYPES.ERROR.color;
        }
        
        if (errorElement) {
            errorElement.textContent = message;
            errorElement.style.color = ERROR_TYPES.ERROR.color;
            errorElement.style.display = 'block';
        }
    });
    
    // サマリーエラーも表示
    const errorCount = Object.keys(errors).length;
    if (errorCount > 0) {
        showError(`${errorCount}件の入力エラーがあります`, formId);
    }
}

/**
 * 確認ダイアログの改善版
 * @param {string} message - 確認メッセージ
 * @param {Object} options - オプション
 */
export function showConfirm(message, options = {}) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0,0,0,0.5);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10001;
            backdrop-filter: blur(5px);
        `;
        
        modal.innerHTML = `
            <div style="
                background: #1e293b;
                color: #e2e8f0;
                padding: 24px;
                border-radius: 12px;
                max-width: 400px;
                width: 90%;
                box-shadow: 0 10px 30px rgba(0,0,0,0.3);
            ">
                <h3 style="margin: 0 0 16px 0; font-size: 18px; font-weight: 600;">
                    ${options.title || '確認'}
                </h3>
                <p style="margin: 0 0 24px 0; line-height: 1.5; color: #94a3b8;">
                    ${message}
                </p>
                <div style="display: flex; gap: 12px; justify-content: flex-end;">
                    <button id="cancel-btn" style="
                        background: #374151;
                        color: #d1d5db;
                        border: none;
                        padding: 8px 16px;
                        border-radius: 6px;
                        cursor: pointer;
                        font-weight: 500;
                    ">キャンセル</button>
                    <button id="confirm-btn" style="
                        background: #3b82f6;
                        color: white;
                        border: none;
                        padding: 8px 16px;
                        border-radius: 6px;
                        cursor: pointer;
                        font-weight: 500;
                    ">${options.confirmText || 'OK'}</button>
                </div>
            </div>
        `;
        
        document.body.appendChild(modal);
        
        document.getElementById('confirm-btn').onclick = () => {
            document.body.removeChild(modal);
            resolve(true);
        };
        
        document.getElementById('cancel-btn').onclick = () => {
            document.body.removeChild(modal);
            resolve(false);
        };
        
        modal.onclick = (e) => {
            if (e.target === modal) {
                document.body.removeChild(modal);
                resolve(false);
            }
        };
    });
}

// デフォルトエクスポート
export default {
    showError,
    showSuccess,
    showWarning,
    showInfo,
    showConfirm,
    withErrorHandling,
    showValidationErrors,
    getFriendlyErrorMessage
};