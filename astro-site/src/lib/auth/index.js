/**
 * index.js — 有料セッション共通ライブラリの公開エントリ（ランタイム非依存）
 *
 * PR-B 以降（Node Functions / Astro middleware / Netlify Edge）はここから import する。
 * 環境変数の読取・秘密鍵の解決は **呼び出し側の責務**。この層では行わない。
 */

export {
  SESSION_SCHEMA_VERSION,
  SESSION_SCHEMA_VERSION_V2,
  SUPPORTED_SCHEMA_VERSIONS,
  ISSUE_SCHEMA_VERSION,
  SESSION_COOKIE_NAME,
  MAX_SESSION_TTL_MS,
  ABSOLUTE_SESSION_TTL_MS,
  CLOCK_SKEW_MS,
  MIN_SECRET_LENGTH,
  ALLOWED_PAYLOAD_KEYS,
  ALLOWED_PAYLOAD_KEYS_V2,
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
  buildPayloadV2,
  validatePayload,
  PAYLOAD_REJECT,
} from './sessionPayload.js';

export {
  serializeSessionCookie,
  serializeLogoutCookie,
  readSessionCookie,
} from './sessionCookie.js';

export { createSession, createSessionV2, verifySession, VERIFY_REJECT } from './session.js';

export {
  decideRefresh,
  resolveCarriedSessionStart,
  REFRESH_DECISION,
  REFRESH_REJECT,
  REFRESH_THRESHOLD_MS,
} from './sessionRefresh.js';

export { resolveEdgeGateMode } from './edgeGatePolicy.js';

export {
  verifyPlanAccess,
  PREMIUM_PLUS_ALLOWED_PLANS,
  PREMIUM_PLUS_CANDIDATE_PLANS,
  PAGE_ACCESS_REJECT,
} from './pageAccess.js';

export {
  decideRefreshOrigin,
  isProductionContext,
  ORIGIN_DECISION,
  PROD_ALLOWED_ORIGINS,
  NONPROD_EXTRA_ORIGINS,
  NON_PRODUCTION_CONTEXTS,
} from './originPolicy.js';

// --- PR-B: 会員判定 / セッション発行オーケストレーション ---
export {
  resolveMembership,
  resolveSessionVersion,
  MEMBER_TYPE,
  MEMBER_REASON,
} from './memberResolution.js';

export {
  issuePaidSessionCookie,
  buildLogoutCookie,
  checkSigningSecret,
  DEFAULT_SESSION_TTL_MS,
  ISSUE_REJECT,
} from './sessionIssuance.js';

export {
  decideFreeLogin,
  shouldSendMagicLink,
  FREE_LOGIN_OUTCOME,
} from './authPolicies.js';

export {
  classifyCustomerMatches,
  CUSTOMER_LOOKUP,
} from './customerLookup.js';

export { runVerifyMagicLink, VERIFY_FLOW } from './verifyMagicLinkFlow.js';
