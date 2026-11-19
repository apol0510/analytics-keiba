/**
 * contactRateLimit.js — 問い合わせ Function（contact-form / premium-plus-contact）の送信回数の上限
 *
 * 背景（2026-11-05 監査・KAO 5cd50962）:
 *   問い合わせ Function は未ログインで呼べ、受付の控え（自動返信）を「入力されたアドレス」へ
 *   support@keiba.link 名義で送る。回数の上限が無いと、第三者のアドレスへ大量に送る踏み台になり、
 *   SendGrid の送信枠と送信元ドメインの評判（=会員への決済メール・ログインメールの到達）を損なう。
 *
 * 方式:
 *   - 1 時間の固定窓で、送信元 IP ごと・宛先メールごとに件数を数える（どちらかが上限に達したら 429）。
 *   - 保存先は Netlify Blobs（store: ak-contact-rate）。キーは IP / メールの sha256 だけで、生の値は保存しない。
 *   - Blobs は last-write-wins のため件数は best-effort（同時送信で 1〜2 件ずれることはある）。
 *   - 保存先が使えないときは送信を止めない（fail-open・ログに degraded を残す）。
 *     お客様の問い合わせが届かない方が、まれな取りこぼしより実害が大きいため。
 *
 * この module は純粋部分（判定）と Blobs の adapter を分け、判定は in-memory store で test する。
 */

import { createHash } from 'node:crypto';

export const CONTACT_RATE_STORE = 'ak-contact-rate';

export const CONTACT_RATE_LIMITS = Object.freeze({
  windowMs: 60 * 60 * 1000,
  perIp: 5,
  perEmail: 3,
});

export const CONTACT_RATE_LIMIT_MESSAGE =
  '短い時間に送信が続いたため、いったん受付を止めています。1 時間ほどおいてから、もう一度お送りください。お急ぎの場合は support@keiba.link へ直接メールでお送りください。';

/** Netlify の event.headers から送信元 IP を取る（取れなければ null）。 */
export function clientIp(headers) {
  const h = headers && typeof headers === 'object' ? headers : {};
  const get = (name) => {
    const v = h[name] ?? h[name.toLowerCase()];
    return typeof v === 'string' ? v.trim() : '';
  };
  const direct = get('x-nf-client-connection-ip') || get('client-ip');
  if (direct) return direct;
  const xff = get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim() || null;
  return null;
}

/** 保存キーに使う hash（生の IP / メールは保存しない）。 */
export function hashKey(kind, value) {
  return createHash('sha256').update(`ak-contact:${kind}:${String(value)}`).digest('hex').slice(0, 32);
}

/**
 * 送信してよいかを判定し、許可したときだけ件数を 1 増やす。
 * @param {{store:{get:(k:string)=>Promise<any>, set:(k:string,v:any)=>Promise<void>}|null,
 *          scope:string, ip?:string|null, email?:string|null, now?:number, limits?:typeof CONTACT_RATE_LIMITS}} input
 * @returns {Promise<{allowed:boolean, reason:'ip'|'email'|null, degraded:boolean}>}
 */
export async function checkContactRateLimit({ store, scope, ip, email, now = Date.now(), limits = CONTACT_RATE_LIMITS }) {
  if (!store) return { allowed: true, reason: null, degraded: true };
  const bucket = Math.floor(now / limits.windowMs);
  const targets = [];
  if (ip) targets.push({ reason: 'ip', limit: limits.perIp, key: `${scope}/ip/${hashKey('ip', ip)}/${bucket}` });
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (normalizedEmail) {
    targets.push({ reason: 'email', limit: limits.perEmail, key: `email/${hashKey('email', normalizedEmail)}/${bucket}` });
  }
  try {
    const counts = [];
    for (const t of targets) {
      const rec = await store.get(t.key);
      const count = rec && Number.isFinite(rec.count) ? rec.count : 0;
      if (count >= t.limit) return { allowed: false, reason: t.reason, degraded: false };
      counts.push(count);
    }
    for (let i = 0; i < targets.length; i += 1) {
      await store.set(targets[i].key, { count: counts[i] + 1, bucket });
    }
    return { allowed: true, reason: null, degraded: false };
  } catch (error) {
    console.warn('[contact-rate] degraded', (error && error.name) || 'Error');
    return { allowed: true, reason: null, degraded: true };
  }
}

/**
 * Netlify Blobs の adapter（classic Function 用）。作れないときは null（判定側で fail-open）。
 * @param {object} event Netlify Function の event
 */
export async function createBlobsRateStore(event) {
  try {
    const { getStore, connectLambda } = await import('@netlify/blobs');
    try { connectLambda(event); } catch { /* local / env 注入済みなら不要 */ }
    const siteID = process.env.NETLIFY_SITE_ID;
    const token = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_API_TOKEN;
    const options = { name: CONTACT_RATE_STORE };
    const s = siteID && token ? getStore({ ...options, siteID, token }) : getStore(options);
    return {
      get: (key) => s.get(key, { type: 'json' }),
      set: (key, value) => s.setJSON(key, value),
    };
  } catch (error) {
    console.warn('[contact-rate] store unavailable', (error && error.name) || 'Error');
    return null;
  }
}

/** 429 応答（Retry-After は窓の長さ）。 */
export function rateLimitedResponse(headers, limits = CONTACT_RATE_LIMITS) {
  return {
    statusCode: 429,
    headers: { ...headers, 'Retry-After': String(Math.ceil(limits.windowMs / 1000)) },
    body: JSON.stringify({ error: CONTACT_RATE_LIMIT_MESSAGE }),
  };
}
