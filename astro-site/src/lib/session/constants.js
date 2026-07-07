/**
 * session/constants.js — セッション共通ライブラリの定数（PR-A）
 *
 * ランタイム非依存。process.env / Deno.env / Buffer / fs / window は参照しない。
 * 本番秘密鍵やデフォルト秘密鍵は一切含めない（鍵は呼び出し側から引数注入）。
 */

// Cookie 名（有料セッション専用）
export const COOKIE_NAME = 'ak_session';

// payload スキーマ version（未知 version は検証で拒否）
export const SESSION_SCHEMA_VERSION = 1;

// TTL 上限（秒）。呼び出し側は ttlSeconds を指定するが、これを超える発行は拒否。
// Phase 1 は 15〜30 分運用想定。ライブラリ上限は 1 時間に固定。
export const MAX_TTL_SECONDS = 60 * 60;

// 秘密鍵の最小長（文字数）。これ未満は発行・検証とも失敗（fail closed）。
export const MIN_SECRET_LENGTH = 32;

// issuedAt が「未来すぎる」と判定する許容クロックスキュー（秒）
export const CLOCK_SKEW_SECONDS = 60;

// 正規プラン（canonical）。表示表記・大小・日本語はここへ正規化する。
export const PLAN_FREE = 'free';
export const PLAN_LIGHT = 'light';
export const PLAN_PREMIUM = 'premium';
export const PLAN_PREMIUM_COMBO = 'premium-combo';
export const PLAN_PREMIUM_PLUS = 'premium-plus';
export const PLAN_PREMIUM_SANRENPUKU = 'premium-sanrenpuku';
export const PLAN_PREMIUM_SANRENTAN = 'premium-sanrentan';

export const CANONICAL_PLANS = Object.freeze([
  PLAN_FREE,
  PLAN_LIGHT,
  PLAN_PREMIUM,
  PLAN_PREMIUM_COMBO,
  PLAN_PREMIUM_PLUS,
  PLAN_PREMIUM_SANRENPUKU,
  PLAN_PREMIUM_SANRENTAN,
]);

// 有料プラン = free 以外。free は有料セッションとして発行不可。
export const PAID_PLANS = Object.freeze(CANONICAL_PLANS.filter((p) => p !== PLAN_FREE));

// 正規 venue（VenueAccess）。未知 venue は拒否。
export const CANONICAL_VENUES = Object.freeze(['all', 'jra', 'nankan']);

// payload 必須キー
export const REQUIRED_PAYLOAD_KEYS = Object.freeze([
  'v',
  'sub',
  'plan',
  'venueAccess',
  'sessionVersion',
  'issuedAt',
  'expiresAt',
]);
