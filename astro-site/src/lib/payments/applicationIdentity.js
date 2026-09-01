/**
 * applicationIdentity.js — 入金完了報告フォームの「誰の申込か」を決める単一源（純粋・IO なし）。
 *
 * ## なぜ要るか（2026-09-01 / MK 報告）
 *
 * > u.non.4110@gmail.com を sanrenpuku にした。サブメール yskr4110@gmail.com でも
 * > 申し込んでしまったようだ。
 *
 * 同じお客様が **本アドレスとサブアドレスの 2 つで申し込み**、Customers に別レコードが
 * 2 件でき、片方が `Status=pending` / `RequestedPlan=Premium Sanrenpuku` のまま残った。
 * そのまま `PaymentConfirmed` を押すと**二重付与**になる。
 *
 * 原因は `bank-transfer-application.js` が **セッションを一切見ず、body の `email` を
 * そのまま採用**していたこと。フォームは 17 ページに複製されており、
 * ログイン中のアドレスを初期値に入れているページは一部だけだった。
 *
 * ## 決めたこと（2026-09-01 MK 確定）
 *
 * | 状態 | 扱い |
 * |---|---|
 * | ログイン中 | **セッションのアドレス以外では申し込めない**（別アドレスは拒否） |
 * | 未ログイン | 従来どおり自由入力で申込可（新規のお客様の購入導線を塞がない） |
 *
 * 別のアドレスで申し込みたい場合は、マイページでメールアドレスを変更してもらう。
 *
 * ⚠️ セッションを読めないとき（Cookie 無し / 署名鍵未設定 / Airtable 障害）は
 *    `sessionEmail` を空で渡すこと。**申込自体は止めない**（= 未ログイン扱い）。
 *    ここを fail closed にすると、障害時に売上導線が全部止まる。
 *    なりすまし防止ではなく「取り違え防止」が目的なので、この非対称は意図的。
 */

/** 比較用の正規化（trim + lowercase）。Airtable 側の検索と同じ規則。 */
export function normalizeApplicationEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** 判定結果。 */
export const APPLICATION_EMAIL = Object.freeze({
  /** 未ログイン（またはセッションを読めない）→ 従来どおり通す */
  NO_SESSION: 'no_session',
  /** ログイン中で、申込アドレスが一致 */
  MATCH: 'match',
  /** ログイン中で、別のアドレスが入力されている → 拒否 */
  MISMATCH: 'mismatch',
});

/** 拒否したときにフォームへ出す文言（**画面ごとに書き分けない**）。 */
export const APPLICATION_EMAIL_MISMATCH_MESSAGE =
  'ログイン中のメールアドレスでのみお申し込みいただけます。'
  + '別のメールアドレスでお申し込みになる場合は、マイページでメールアドレスを変更してください。';

/**
 * 申込を受け付けてよいかを決める。
 *
 * @param {{ sessionEmail?: string, submittedEmail?: string }} input
 *   `sessionEmail` は **検証済みセッションから引いた Customers の Email** のみを渡すこと。
 *   クライアントから送られた値（localStorage 等）を渡してはいけない。
 * @returns {{ ok: boolean, reason: string, sessionEmail: string, submittedEmail: string }}
 */
export function decideApplicationEmail({ sessionEmail, submittedEmail } = {}) {
  const session = normalizeApplicationEmail(sessionEmail);
  const submitted = normalizeApplicationEmail(submittedEmail);

  if (!session) return { ok: true, reason: APPLICATION_EMAIL.NO_SESSION, sessionEmail: '', submittedEmail: submitted };
  if (session === submitted) return { ok: true, reason: APPLICATION_EMAIL.MATCH, sessionEmail: session, submittedEmail: submitted };
  return { ok: false, reason: APPLICATION_EMAIL.MISMATCH, sessionEmail: session, submittedEmail: submitted };
}
