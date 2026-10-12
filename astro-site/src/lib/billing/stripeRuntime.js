/**
 * stripeRuntime.js — Stripe 系 Function の共通部品（Stripe クライアント・戻り先 URL・ログイン中の会員）
 */

import Stripe from 'stripe';
import { hasStripeSecret, STRIPE_ENV } from './stripePlans.js';

export const PRODUCTION_ORIGIN = 'https://analytics.keiba.link';

/**
 * 決済後の戻り先に使ってよいオリジン。**許可リストの完全一致だけ**（オープンリダイレクトにしない）。
 * 本番・Netlify の Deploy Preview / Branch deploy・ローカル開発。
 */
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/analytics\.keiba\.link$/,
  /^https:\/\/[a-z0-9-]+--analytics-keiba\.netlify\.app$/,
  /^https:\/\/analytics-keiba\.netlify\.app$/,
  /^http:\/\/localhost:(4321|8888)$/,
];

/**
 * 決済会社 Sandbox 専用の中立ホスト（静的プロキシ `ops/checkout-sandbox/` → Sandbox 用 Deploy Preview）。
 * **リクエストを受けたのが Deploy Preview / Branch deploy のときだけ**許可する（本番 analytics.keiba.link は
 * このオリジンを信用しない＝本番の CORS・戻り先を広げない）。本番オリジンではないので resolveCardMode はテスト鍵しか通さない。
 */
const SANDBOX_PROXY_ORIGINS = [/^https:\/\/sandbox\.checkout\.tirol\.link$/];
// Netlify はリクエストの Host で配信先サイトを決めるため、本番 analytics.keiba.link が受けたリクエストの Host がこれらになることはない。
// プロキシ経由（Host が元のホストのまま届く）と Deploy Preview 直アクセスの両方を受ける。
const PREVIEW_HOST = /^([a-z0-9-]+--analytics-keiba\.netlify\.app|sandbox\.checkout\.tirol\.link|tirol-checkout-sandbox\.netlify\.app)$/;

export function isAllowedOrigin(origin, host = '') {
  const o = String(origin || '').trim();
  if (ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(o))) return true;
  return PREVIEW_HOST.test(String(host || '').trim().toLowerCase()) && SANDBOX_PROXY_ORIGINS.some((re) => re.test(o));
}

const hostOf = (h) => (h || {}).host || (h || {}).Host || '';

/** リクエストの Origin（無ければ Referer のオリジン）が許可リストにあればそれ、無ければ本番 */
export function resolveSiteOrigin(headers = {}) {
  const h = headers || {};
  const origin = h.origin || h.Origin || '';
  if (isAllowedOrigin(origin, hostOf(h))) return origin;
  try {
    const ref = new URL(h.referer || h.Referer || '').origin;
    if (isAllowedOrigin(ref, hostOf(h))) return ref;
  } catch { /* 無視 */ }
  return PRODUCTION_ORIGIN;
}

/** CORS（同一オリジンからの fetch が前提。許可リスト外には本番を返す） */
export function corsHeaders(headers = {}) {
  const origin = (headers || {}).origin || (headers || {}).Origin || '';
  return {
    'Access-Control-Allow-Origin': isAllowedOrigin(origin, hostOf(headers)) ? origin : PRODUCTION_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
}

export function getStripe(env) {
  if (!hasStripeSecret(env)) return null;
  return new Stripe(String(env[STRIPE_ENV.SECRET_KEY]).trim(), {
    maxNetworkRetries: 2,
    timeout: 8000,
    appInfo: { name: 'analytics-keiba' },
  });
}

/** Stripe のキーが本番用か（表示・ログの区別用。値は返さない） */
export function stripeMode(env) {
  return /_live_/.test(String(env[STRIPE_ENV.SECRET_KEY] || '')) ? 'live' : 'test';
}

/**
 * ログイン中（ak_session 署名 Cookie）の会員の recordId。読めなければ null。
 * ⚠️ 読めない＝未ログイン扱い（決済はメールアドレスで受け付ける）。fail closed にすると障害時に販売が止まる。
 */
export async function readSessionRecordId(cookieHeader, env, now = Date.now()) {
  try {
    const secret = env.SESSION_SIGNING_SECRET;
    if (!secret) return null;
    const { checkSigningSecret, readSessionCookie, verifySession } = await import('../auth/index.js');
    if (!checkSigningSecret(secret).ok) return null;
    const token = readSessionCookie(cookieHeader || '');
    if (!token) return null;
    const verified = await verifySession({ token, secret, now });
    if (!verified.ok) return null;
    const sub = String(verified.payload?.sub || '');
    return /^rec[A-Za-z0-9]{14}$/.test(sub) ? sub : null;
  } catch {
    return null;
  }
}

/** 署名検証用の生ボディ（Netlify v1 は base64 のことがある） */
export function rawBody(event) {
  const b = event?.body || '';
  return event?.isBase64Encoded ? Buffer.from(b, 'base64').toString('utf8') : b;
}
