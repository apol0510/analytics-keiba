/**
 * メールアドレス設定（一元管理 / 正本）
 *
 * ⚠️ 重要：メールアドレスを変更する場合は、このファイルのみを修正してください
 *
 * 契約（2026-08-31 固定）:
 * - **問い合わせ・返信先 = `support@keiba.link`**（`SUPPORT_EMAIL` / `ADMIN_EMAIL`）
 *   受信は Cloudflare Email Routing 経由。管理者宛通知の宛先もここに集約する。
 * - **システム送信元 = `noreply@keiba.link`**（`FROM_EMAIL`）
 *
 * 例外（このファイルを参照しない経路。触る前に必読）:
 * - **決済メール v2** は `src/lib/payments/senderIdentity.js` が送信元の単一源。
 *   正式送信元は `support@keiba.link` で、env 不一致は fail closed。
 *   `FROM_EMAIL`（noreply）への fallback は**禁止**。
 * - **メルマガ**は `src/lib/newsletter/brand-config.js` が単一源。
 *   From は DeliveryKey の構成要素なので**変更すると二重送信**になる。
 * - 問い合わせ / 退会フォームの From は `SUPPORT_EMAIL`（迷惑メール対策で 2025-11-26 に
 *   support へ変更した経緯があるため noreply へ戻さない）。
 *
 * 履歴：
 * - 2026-02-13: support@keiba.link に統一（誤った nankan.analytics@keiba.link を修正）
 * - 2026-08-31: 旧サイト名残の管理者アドレス（Gmail / 旧ドメイン別名）を全廃し、
 *   現役経路を本ファイルの定数へ統一。未使用の ALT_EMAIL を削除。
 *   再混入は `npm run test:email-identity` が検知する。
 */

// サポート・問い合わせ用メールアドレス（返信先の正本）
export const SUPPORT_EMAIL = 'support@keiba.link';

// 管理者通知用メールアドレス（管理者宛通知の宛先の正本）
export const ADMIN_EMAIL = 'support@keiba.link';

// システム送信元メールアドレス（SendGrid等で使用）
export const FROM_EMAIL = 'noreply@keiba.link';

// メールアドレス表示用（HTMLメール内のリンク等）
export const DISPLAY_SUPPORT_EMAIL = 'support@keiba.link';

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
  getEmail
};
