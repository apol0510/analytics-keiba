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
 * 実名ではない「表示用プレースホルダ」。氏名として採用してはいけない値。
 *
 * 経緯: dashboard.astro が user-plan に `name: 'お客様'` を既定値として書き込んでいたため、
 * 問い合わせフォームがこれを自動入力し、管理者宛メールが「お名前: お客様」で届いて
 * 返信時に相手を特定できなかった（2026-07-18 報告）。dashboard 側は修正済みだが、
 * **既存ブラウザの localStorage には 'お客様' が残り続ける**ため、読み出し側でも空として扱う。
 */
export const PLACEHOLDER_NAMES = ['お客様'];

/**
 * 氏名文字列を正規化する。前後空白を除去し、プレースホルダは空文字にする。
 * @param {unknown} v
 * @returns {string}
 */
export function normalizeContactName(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return PLACEHOLDER_NAMES.includes(s) ? '' : s;
}

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

  const name = normalizeContactName(data.name);
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
