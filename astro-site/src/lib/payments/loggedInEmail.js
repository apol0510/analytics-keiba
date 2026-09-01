/**
 * loggedInEmail.js — ブラウザに保存された「ログイン中のメールアドレス」を読む判定の正本。
 *
 * ⚠️ **本人確認の根拠にしてはいけない。** localStorage はブラウザ側で書き換えられる。
 *    用途は入力補助（初期値）だけ。実際の拒否はサーバーが ak_session を検証して行う
 *    （`src/lib/payments/applicationIdentity.js` / `bank-transfer-application.js`）。
 *
 * ※ `.astro` の is:inline スクリプトは import できないため、
 *   `src/components/BankApplicationEmailLock.astro` に同一ロジックを複製している。
 *   変更時は両方を合わせること（`contact-autofill.js` と同じ方針）。
 */

/**
 * @param {{ getItem: (k: string) => (string|null) }} storage localStorage 互換
 * @returns {string} 正規化済みメール（無ければ ''）
 */
export function readLoggedInEmail(storage) {
  if (!storage || typeof storage.getItem !== 'function') return '';
  try {
    const raw = storage.getItem('user-plan');
    if (raw) {
      const up = JSON.parse(raw);
      if (up && typeof up.email === 'string' && up.email.trim()) {
        return up.email.trim().toLowerCase();
      }
    }
  } catch (_) { /* 壊れた JSON は無視して次の候補へ */ }
  try {
    const direct = storage.getItem('userEmail');
    if (typeof direct === 'string' && direct.trim()) return direct.trim().toLowerCase();
  } catch (_) { /* 参照自体が投げる環境がある */ }
  return '';
}
