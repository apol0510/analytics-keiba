/**
 * メールアドレス設定（一元管理）
 *
 * ⚠️ 重要：メールアドレスを変更する場合は、このファイルのみを修正してください
 *
 * 履歴：
 * - 2026-02-13: support@keiba.link に統一（誤った nankan.analytics@keiba.link を修正）
 */

// サポート・問い合わせ用メールアドレス
export const SUPPORT_EMAIL = 'support@keiba.link';

// 管理者通知用メールアドレス
export const ADMIN_EMAIL = 'support@keiba.link';

// システム送信元メールアドレス（SendGrid等で使用）
export const FROM_EMAIL = 'noreply@keiba.link';

// メールアドレス表示用（HTMLメール内のリンク等）
export const DISPLAY_SUPPORT_EMAIL = 'support@keiba.link';

// 代替メールアドレス（必要に応じて）
export const ALT_EMAIL = 'nankan-analytics@keiba.link';

/**
 * メールアドレスを取得する汎用関数
 * @param {string} type - 'support' | 'admin' | 'from' | 'display'
 * @returns {string} メールアドレス
 */
export function getEmail(type = 'support') {
  switch (type) {
    case 'support':
      return SUPPORT_EMAIL;
    case 'admin':
      return ADMIN_EMAIL;
    case 'from':
      return FROM_EMAIL;
    case 'display':
      return DISPLAY_SUPPORT_EMAIL;
    case 'alt':
      return ALT_EMAIL;
    default:
      return SUPPORT_EMAIL;
  }
}

// デフォルトエクスポート
export default {
  SUPPORT_EMAIL,
  ADMIN_EMAIL,
  FROM_EMAIL,
  DISPLAY_SUPPORT_EMAIL,
  ALT_EMAIL,
  getEmail
};
