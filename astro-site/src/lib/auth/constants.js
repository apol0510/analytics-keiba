/**
 * constants.js — 有料セッション（ak_session）共通定数
 *
 * PR-A スコープ: ランタイム非依存の純粋定数のみ。
 *   - 本番秘密鍵・デフォルト秘密鍵は **ここに置かない**（呼び出し側が PR-B 以降で注入）。
 *   - process.env / Deno.env / fs / window / localStorage は参照しない。
 *
 * 全ランタイム（Node Functions / Astro middleware / Netlify Edge(Deno)）で共有する。
 */

/**
 * スキーマバージョン（payload.v）。
 * v1: 初期スキーマ（sessionStart 無し）。既存発行済み Cookie 互換のため検証は受理し続ける。
 * v2: sessionStart を必須にした版（絶対 TTL の起点）。新規発行・refresh 後はすべて v2。
 * SUPPORTED_SCHEMA_VERSIONS 以外の v は検証で拒否する。
 */
export const SESSION_SCHEMA_VERSION = 1; // = v1（後方互換の基準・既存参照を壊さないため据置）
export const SESSION_SCHEMA_VERSION_V2 = 2;

/** 検証側が受理するスキーマバージョン（移行期間中は v1/v2 両方）。 */
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([SESSION_SCHEMA_VERSION, SESSION_SCHEMA_VERSION_V2]);

/** 新規発行・refresh 時に採用するスキーマバージョン（常に v2）。 */
export const ISSUE_SCHEMA_VERSION = SESSION_SCHEMA_VERSION_V2;

/** Cookie 名（有料セッション専用）。 */
export const SESSION_COOKIE_NAME = 'ak_session';

/**
 * 絶対最大ログイン継続時間（ミリ秒）。
 * v2 payload の sessionStart（初回ログイン時刻。refresh で引き継ぐ）を起点に、
 * now - sessionStart >= これ で refresh を拒否し、再度マジックリンク認証を要求する。
 * refresh をいくら繰り返してもこの上限は延長されない。
 */
export const ABSOLUTE_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12時間

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
 * v2 payload に許可するキー（allow-list）。v1 の全キー + sessionStart。
 * v1 payload に sessionStart が来た場合は v1 allow-list 外 → 拒否される（版ごとに厳密分離）。
 */
export const ALLOWED_PAYLOAD_KEYS_V2 = Object.freeze([
  ...ALLOWED_PAYLOAD_KEYS,
  'sessionStart',
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
