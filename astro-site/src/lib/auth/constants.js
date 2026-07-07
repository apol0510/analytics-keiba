/**
 * constants.js — 有料セッション（ak_session）共通定数
 *
 * PR-A スコープ: ランタイム非依存の純粋定数のみ。
 *   - 本番秘密鍵・デフォルト秘密鍵は **ここに置かない**（呼び出し側が PR-B 以降で注入）。
 *   - process.env / Deno.env / fs / window / localStorage は参照しない。
 *
 * 全ランタイム（Node Functions / Astro middleware / Netlify Edge(Deno)）で共有する。
 */

/** 現行スキーマバージョン（payload.v）。未知の v は検証で拒否する。 */
export const SESSION_SCHEMA_VERSION = 1;

/** Cookie 名（有料セッション専用）。 */
export const SESSION_COOKIE_NAME = 'ak_session';

/**
 * 有料セッションの最大 TTL（ミリ秒）。
 * expiresAt - issuedAt がこれを超える payload は拒否する。
 */
export const MAX_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30日

/**
 * 時刻ズレ許容（ミリ秒）。
 * issuedAt がこの値を超えて未来なら「未来すぎる」として拒否、
 * expiresAt はこの猶予を足したうえで期限切れ判定する。
 */
export const CLOCK_SKEW_MS = 5 * 60 * 1000; // 5分

/**
 * 秘密鍵の最小長（文字数）。これ未満・空・非文字列は失敗にする。
 * ※ これは長さの下限ガードであり、鍵そのものではない。
 */
export const MIN_SECRET_LENGTH = 32;

/**
 * payload に許可するキー（allow-list）。
 * これ以外のキー（氏名 / points / 支払情報 / 内部メモ 等）を含む payload は拒否する。
 */
export const ALLOWED_PAYLOAD_KEYS = Object.freeze([
  'v',
  'sub',
  'plan',
  'venueAccess',
  'sessionVersion',
  'issuedAt',
  'expiresAt',
]);

/**
 * EDGE_GATE_ENABLED の解決結果（PR-C 設計メモ用）。
 *   - enabled:      ゲート有効。Cookie を検証し、正当なセッションのみ通す。
 *   - passThrough:  緊急解除。全リクエストを素通り（明示 "false" のときのみ）。
 *   - failClosed:   未設定 / 不正値。全リクエストを拒否（安全側）。
 */
export const EDGE_GATE_MODE = Object.freeze({
  ENABLED: 'enabled',
  PASS_THROUGH: 'pass-through',
  FAIL_CLOSED: 'fail-closed',
});
