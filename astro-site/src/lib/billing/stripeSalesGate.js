/**
 * stripeSalesGate.js — Stripe の live 決済受付が可能なときだけ、Stripe 月額を案内するメールを送る
 *
 * 2026-10-02 MK 確定: Stripe live 決済が無効な間は、新しい Stripe 月額商品（Premium ¥4,980 / 中央・南関 ¥2,980）を
 * 案内するメールを**実送信しない**（申込先で決済できないため）。テンプレート・CTA の修正とテストは先に済ませる。
 *
 * 判定: `GET /v1/account` の `charges_enabled === true` かつ `capabilities.card_payments === 'active'`。
 * 読めない・鍵が無い・通信失敗は**開いていない**とみなす（fail closed＝送らない側）。
 */

/** @returns {Promise<{ open: boolean, reason: string }>} */
export async function checkStripeLiveSales(env = {}, { fetchImpl } = {}) {
  const key = String(env.STRIPE_SECRET_KEY || '').trim();
  if (!/^(sk|rk)_(live|test)_/.test(key)) return { open: false, reason: 'stripe_key_missing' };
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return { open: false, reason: 'no_fetch' };
  try {
    const res = await f('https://api.stripe.com/v1/account', { headers: { Authorization: `Bearer ${key}` } });
    if (!res || !res.ok) return { open: false, reason: `stripe_http_${res ? res.status : 'none'}` };
    const a = await res.json();
    if (a?.charges_enabled === true && a?.capabilities?.card_payments === 'active') return { open: true, reason: 'ok' };
    return { open: false, reason: `charges_disabled:${a?.requirements?.disabled_reason || 'unknown'}` };
  } catch {
    return { open: false, reason: 'stripe_unreachable' };
  }
}

/**
 * 送信モードを、Stripe の受付状態で絞る。live でも受付不可なら dry-run（件数だけ・送信 0）に落とす。
 * off / dry-run はそのまま（広げる方向には絶対に変えない）。
 */
export function gateModeOnStripeSales(mode, sales) {
  if (String(mode) !== 'live') return mode;
  return sales && sales.open === true ? 'live' : 'dry-run';
}
