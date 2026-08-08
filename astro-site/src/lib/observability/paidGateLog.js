/**
 * paidGateLog.js — 有料ページ認可の「異常だけ」を 1 行で残す。
 *
 * ── なぜ auth の外に置くのか ────────────────────────────────────
 * `src/lib/auth/*` は **console.* を禁止**している（payload / secret の漏洩防止。
 * `staticGuards.test.mjs` が強制）。この禁止は弱めない。
 * そこで「出してよい形」だけを知る小さなモジュールをここに置き、auth からは
 * これを呼ぶだけにする。**何を出せるかはこのファイルが単独で決める。**
 *
 * ── 出すもの ────────────────────────────────────────────────
 * reason コードと requiredPlan の 2 つだけ。引数に何が渡されても、
 * それ以外は**構造的に出力できない**（オブジェクトを受け取らない）。
 *
 * ⚠️ recordId(sub) / Cookie / token / メールアドレス / session payload は出さない。
 * ⚠️ 匿名アクセス（no_cookie / no_session）は bot を含め常時発生するので出さない。
 *    出すと本物の異常が埋もれる。
 */

/** 出力してよい reason（運用異常のみ）。ここに無いものは黙って捨てる。 */
export const LOGGED_DENY_REASONS = Object.freeze([
  'lookup_unavailable',   // Airtable の一時障害（2026-08-08 の障害の主因）
  'lookup_failed',        // lookup が例外を投げた
  'customer_not_found',   // session はあるが Customers に居ない
  'env_missing',          // 設定ミス
  'unknown_required_plan',
]);

/** ログ検索の入口。 */
export const PAID_GATE_LOG_TAG = '[paid-gate]';

/** requiredPlan として出してよい語（未知の値は other に丸める） */
const KNOWN_PLANS = Object.freeze(['Premium Sanrenpuku', 'premium', 'standard']);

/**
 * 認可の拒否を 1 行で残す。**文字列 2 つしか受け取らない。**
 * @param {string} reason
 * @param {string} requiredPlan
 */
export function logPaidGateDeny(reason, requiredPlan) {
  const r = typeof reason === 'string' ? reason : '';
  if (!LOGGED_DENY_REASONS.includes(r)) return;
  const p = typeof requiredPlan === 'string' && KNOWN_PLANS.includes(requiredPlan)
    ? requiredPlan : 'other';
  // 1 行 = 1 レコード。console を detach せず、引数 1 本の文字列で呼ぶ
  try {
    console.warn(`${PAID_GATE_LOG_TAG} ${JSON.stringify({ reason: r, requiredPlan: p })}`);
  } catch { /* ログ失敗で認可処理を止めない */ }
}

export default logPaidGateDeny;
