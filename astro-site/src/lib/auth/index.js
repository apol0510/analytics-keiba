/**
 * index.js — 有料セッション共通ライブラリの公開エントリ（ランタイム非依存）
 *
 * PR-B 以降（Node Functions / Astro middleware / Netlify Edge）はここから import する。
 * 環境変数の読取・秘密鍵の解決は **呼び出し側の責務**。この層では行わない。
 */

export {
  SESSION_SCHEMA_VERSION,
  SESSION_COOKIE_NAME,
  MAX_SESSION_TTL_MS,
  CLOCK_SKEW_MS,
  MIN_SECRET_LENGTH,
  ALLOWED_PAYLOAD_KEYS,
  EDGE_GATE_MODE,
} from './constants.js';

export {
  CANONICAL_PLANS,
  PAID_PLANS,
  CANONICAL_VENUES,
  normalizePlan,
  isPaidPlan,
  normalizeVenueAccess,
  isValidVenueAccessArray,
} from './planNormalization.js';

export {
  checkSecret,
  assertSecret,
  signHmac,
  verifyHmac,
  SecretError,
} from './sessionCrypto.js';

export {
  buildPayload,
  validatePayload,
  PAYLOAD_REJECT,
} from './sessionPayload.js';

export {
  serializeSessionCookie,
  serializeLogoutCookie,
  readSessionCookie,
} from './sessionCookie.js';

export { createSession, verifySession, VERIFY_REJECT } from './session.js';

export { resolveEdgeGateMode } from './edgeGatePolicy.js';
