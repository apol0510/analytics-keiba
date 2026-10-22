/**
 * subscriptionReturnToken.js — 未ログインで定期課金を申し込んだブラウザだけが、戻り先で自分の購読の状態を見られる鍵（2026-10-22）
 *
 * 背景: #820 から未ログイン（無料会員・初めての方）はメール入力で申し込める。ところが戻り先
 * （/checkout/paypal-subscription-return/）が呼ぶ paypal-subscription-confirm は ak_session 必須で、
 * 未ログインの購入者には 401 →「ログインしてご確認ください」が出て、完了画面も GA4 purchase も出なかった
 * （権限は Webhook で付く）。
 *
 * 仕組み: 申込（monthly-create-checkout）で PayPal が購読を作った**直後**に、その購読 ID と会員 ID と期限へ
 * HMAC 署名した短命の HttpOnly Cookie を、申し込んだブラウザへだけ渡す。戻り先の確認はこの Cookie を
 *   ① 署名 ② 期限 ③ 照会する購読 ID と一致 の 3 つで検証し、さらに confirmPaypalSubscription が
 *   ④ PayPal の照会結果の custom_id（会員 ID）と一致 を確かめる。どれか 1 つでも欠ければ鍵なし（fail closed）。
 * - URL（?subscription_id=）だけを持つ第三者は Cookie を持たないので、何も見えない（401）。
 * - Cookie は確認の Function だけに送る（Path を限定）・JS から読めない（HttpOnly）・2 時間で失効。
 * - 署名鍵は SESSION_SIGNING_SECRET から用途別に導出する（ak_session の署名と同じ鍵を直接使わない＝
 *   この値がセッションとして通ることも、その逆も無い）。鍵が無ければ発行も検証もしない。
 * - 返すのは会員 ID だけ（呼び出し側はそれで従来どおりの照会・反映をする）。メール等は扱わない。
 * - 権限の反映（applyPaypalSubscription）・判定は変えない。Webhook が正本のまま。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { MIN_SECRET_LENGTH } from '../../auth/constants.js';
import { isSubscriptionId } from './paypalSubscriptionCore.js';

export const RETURN_COOKIE_NAME = 'ak_pp_return';
export const RETURN_COOKIE_PATH = '/.netlify/functions/paypal-subscription-confirm';
export const RETURN_TOKEN_TTL_SECONDS = 2 * 60 * 60;
const VERSION = 'v1';
const PURPOSE = 'ak-paypal-subscription-return:v1';
const REC_RE = /^rec[A-Za-z0-9]{14}$/;

function keyOf(secret) {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) return null;
  return createHmac('sha256', secret).update(PURPOSE).digest();
}

function sign(key, input) {
  return createHmac('sha256', key).update(input).digest('base64url');
}

/**
 * 申込直後に発行する。鍵が無い・値の形が違うときは null（Cookie を出さない＝戻り先はログイン案内になるだけ）。
 * @returns {string|null}
 */
export function issueReturnToken({ secret, subscriptionId, recordId, now = Date.now(), ttlSeconds = RETURN_TOKEN_TTL_SECONDS }) {
  const key = keyOf(secret);
  if (!key || !isSubscriptionId(subscriptionId) || !REC_RE.test(String(recordId || ''))) return null;
  const exp = Math.floor(now / 1000) + ttlSeconds;
  const body = `${VERSION}.${subscriptionId}.${recordId}.${exp}`;
  return `${body}.${sign(key, body)}`;
}

/**
 * @returns {{ ok: true, recordId: string } | { ok: false, reason: 'missing'|'secret_unset'|'malformed'|'bad_signature'|'expired'|'subscription_mismatch' }}
 */
export function verifyReturnToken({ secret, token, subscriptionId, now = Date.now() }) {
  if (!token) return { ok: false, reason: 'missing' };
  const key = keyOf(secret);
  if (!key) return { ok: false, reason: 'secret_unset' };
  const parts = String(token).split('.');
  if (parts.length !== 5 || parts[0] !== VERSION) return { ok: false, reason: 'malformed' };
  const [, sub, rec, expRaw, sig] = parts;
  if (!isSubscriptionId(sub) || !REC_RE.test(rec) || !/^\d{1,12}$/.test(expRaw)) return { ok: false, reason: 'malformed' };
  const expected = Buffer.from(sign(key, parts.slice(0, 4).join('.')));
  const got = Buffer.from(String(sig));
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return { ok: false, reason: 'bad_signature' };
  if (Number(expRaw) * 1000 <= now) return { ok: false, reason: 'expired' };
  if (sub !== String(subscriptionId || '')) return { ok: false, reason: 'subscription_mismatch' };
  return { ok: true, recordId: rec };
}

/** Set-Cookie の値（HttpOnly・Secure・SameSite=Lax・確認の Function だけへ送る） */
export function serializeReturnCookie(token, maxAgeSeconds = RETURN_TOKEN_TTL_SECONDS) {
  return [`${RETURN_COOKIE_NAME}=${token}`, `Max-Age=${maxAgeSeconds}`, `Path=${RETURN_COOKIE_PATH}`, 'SameSite=Lax', 'HttpOnly', 'Secure'].join('; ');
}

export function readReturnCookie(cookieHeader) {
  if (typeof cookieHeader !== 'string' || !cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === RETURN_COOKIE_NAME) return part.slice(i + 1).trim() || null;
  }
  return null;
}

/** 申込の Function 用: 未ログインの申込で作った購読に Cookie を付ける。出せなければ null */
export function returnCookieFor({ env = {}, subscriptionId, recordId, now = Date.now() }) {
  const token = issueReturnToken({ secret: env.SESSION_SIGNING_SECRET, subscriptionId, recordId, now });
  return token ? serializeReturnCookie(token) : null;
}

/**
 * 確認の Function 用: 戻り先の購読について、この閲覧者を誰として扱うか。
 * ログイン中（ak_session）が先（従来どおり・Cookie は見ない）。未ログインのときだけ申込の Cookie を検証する。
 * @param {{ cookieHeader: string, env: object, subscriptionId: string, readSession: (cookie: string, env: object) => Promise<string|null>, now?: number }} input
 * @returns {Promise<{ recordId: string, viewer: 'member'|'guest' } | { recordId: null, viewer: null, reason: string }>}
 */
export async function resolveConfirmViewer({ cookieHeader, env = {}, subscriptionId, readSession, now = Date.now() }) {
  const member = await readSession(cookieHeader || '', env);
  if (member) return { recordId: member, viewer: 'member' };
  const v = verifyReturnToken({ secret: env.SESSION_SIGNING_SECRET, token: readReturnCookie(cookieHeader || ''), subscriptionId, now });
  return v.ok ? { recordId: v.recordId, viewer: 'guest' } : { recordId: null, viewer: null, reason: v.reason };
}
