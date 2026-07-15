/**
 * originPolicy.js — refresh-session の Origin 認可判定（純粋・ランタイム非依存）
 *
 * CSRF 対策。本番では Origin を厳格に検証する（欠落・不一致・複数はすべて拒否＝fail closed）。
 * 非本番（Netlify Dev / Deploy Preview / Branch Deploy）に限り、ツールや同一オリジン fetch が
 * Origin を送らないケースを許容する。context 未設定・未知値は「本番相当」として fail closed。
 *
 * クライアント入力（Origin ヘッダ）は信用の対象ではなく照合の対象。許可オリジンは
 * サーバー側の固定リスト（正規本番 URL）から決める。
 */

/** 正規の本番オリジン（唯一の同一オリジン）。 */
export const PROD_ALLOWED_ORIGINS = Object.freeze(['https://analytics.keiba.link']);

/** 非本番でのみ追加で許可するオリジン（Deploy Preview / ローカル）。 */
export const NONPROD_EXTRA_ORIGINS = Object.freeze([
  'https://analytics-keiba.netlify.app',
  'http://localhost:4321',
  'http://localhost:3000',
]);

/** Netlify の非本番 context 値。これ以外（'production' / 未設定 / 未知）は本番相当扱い。 */
export const NON_PRODUCTION_CONTEXTS = Object.freeze(['dev', 'deploy-preview', 'branch-deploy']);

export const ORIGIN_DECISION = Object.freeze({
  ALLOW: 'allow',
  DENY: 'deny',
});

const NON_PROD_SET = new Set(NON_PRODUCTION_CONTEXTS);

/**
 * context が本番相当かどうか。未設定・空・未知値は本番相当（fail closed）。
 * @param {unknown} context process.env.CONTEXT 相当
 * @returns {boolean}
 */
export function isProductionContext(context) {
  return !NON_PROD_SET.has(context);
}

/**
 * refresh リクエストの Origin を認可するか判定する。
 *
 * ルール:
 *   - Origin が単一かつ許可リスト完全一致 → ALLOW（本番・非本番問わず）
 *   - Origin 不一致 / 複数 / 不正形式 → DENY
 *   - Origin 欠落 → 本番は DENY（fail closed）、非本番のみ ALLOW
 *
 * @param {{ origin?: unknown, context?: unknown }} input
 * @returns {'allow'|'deny'}
 */
export function decideRefreshOrigin(input = {}) {
  const { origin, context } = input;
  const isProd = isProductionContext(context);

  const allowSet = new Set(
    isProd ? PROD_ALLOWED_ORIGINS : [...PROD_ALLOWED_ORIGINS, ...NONPROD_EXTRA_ORIGINS],
  );

  const hasOrigin = typeof origin === 'string' && origin.length > 0;
  if (!hasOrigin) {
    // 欠落: 本番は拒否・非本番のみ許可
    return isProd ? ORIGIN_DECISION.DENY : ORIGIN_DECISION.ALLOW;
  }

  // 単一かつ完全一致のみ許可。
  // 複数値（"a, b" 等のカンマ結合）・末尾空白付きなどは完全一致しないので DENY になる。
  return allowSet.has(origin) ? ORIGIN_DECISION.ALLOW : ORIGIN_DECISION.DENY;
}
