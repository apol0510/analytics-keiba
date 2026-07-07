/**
 * contact-autofill.js — お問い合わせフォームの氏名・メール自動入力ヘルパ（正本）
 *
 * 目的: ログイン済みユーザーが問い合わせフォームで氏名・メールを再入力しなくて済むよう、
 *       localStorage['user-plan'] から氏名・メールを安全に取り出す。
 *
 * 🔒 セキュリティ上の注意:
 *   - user-plan はブラウザで改ざん可能な値。ここで取り出す name/email は
 *     「入力補助（初期値）」にのみ使用する。本人確認済み情報として扱わない。
 *   - サーバーへ本人性の根拠として送らない（送信 Function は従来どおり入力値を受け取るだけ）。
 *
 * 堅牢性: JSON 破損・キー欠落・null・配列・不正な型のいずれでも例外を投げず
 *         { name: '', email: '' } を返す。
 *
 * ※ .astro の is:inline スクリプトはこのモジュールを import できないため、
 *   各フォーム側には同一ロジックを inline 複製している（挙動一致・本ファイルが正本）。
 *   ロジックを変更する場合は inline 複製側も必ず合わせること。
 */

/**
 * user-plan の生文字列を受け取り、氏名・メールを取り出す純粋関数。
 * @param {unknown} raw localStorage.getItem('user-plan') の戻り値
 * @returns {{ name: string, email: string }}
 */
export function parseLoggedInContact(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { name: '', email: '' };

  let data;
  try {
    data = JSON.parse(raw);
  } catch (_e) {
    return { name: '', email: '' };
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { name: '', email: '' };
  }

  const name = typeof data.name === 'string' ? data.name.trim() : '';
  const email = typeof data.email === 'string' ? data.email.trim() : '';
  return { name, email };
}

/**
 * localStorage（または渡された storage）から user-plan を読み、氏名・メールを返す。
 * storage 未指定時はグローバル localStorage を使用。取得不能時は空を返す。
 * @param {{ getItem: (k: string) => (string | null) }} [storage]
 * @returns {{ name: string, email: string }}
 */
export function getLoggedInContact(storage) {
  try {
    const s = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!s || typeof s.getItem !== 'function') return { name: '', email: '' };
    return parseLoggedInContact(s.getItem('user-plan'));
  } catch (_e) {
    return { name: '', email: '' };
  }
}
