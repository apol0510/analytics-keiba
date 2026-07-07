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
 * 有料セッションの絶対最大 TTL（ミリ秒）。
 * expiresAt - issuedAt がこれを超える payload は発行時・検証時とも拒否する。
 * 短寿命セッション設計。PR-B の呼び出しミスで長期有料セッションを発行できないよう
 * ライブラリ側の絶対上限を 30 分に固定する（PR-B の通常 TTL は 20 分予定）。
 */
export const MAX_SESSION_TTL_MS = 30 * 60 * 1000; // 30分

/**
 * 時刻ズレ許容（ミリ秒）。未来すぎる issuedAt の判定にのみ使う。
 * issuedAt がこの値を超えて未来なら「未来すぎる」として拒否する。
 * ※ 有効期限（expiresAt）の延長には使わない（skew で寿命を伸ばさない）。
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
