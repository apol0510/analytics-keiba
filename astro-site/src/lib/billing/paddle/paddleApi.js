/**
 * paddleApi.js — Paddle Billing API の薄いクライアント（鍵はログに出さない）。
 * 一回払い（paddleServer.js）と定期課金（paddleSubscriptionServer.js）が共有する。
 */

import { randomUUID } from 'node:crypto';
import { PRODUCTION_ORIGIN } from '../cardSales.js';
import { signTsBody } from './paddleCore.js';

/**
 * このサイト・この鍵が無い本番で、Paddle の API を使う処理を分離サイトへ委譲する条件。
 * 本番サイト（PADDLE_API_KEY を 4KB 制約で置けない）だけが true。鍵を持つサイト（分離サイト・Sandbox preview）は false。
 */
export function shouldDelegatePaddle({ env = {}, origin } = {}) {
  return !env.PADDLE_API_KEY && Boolean(env.CARD_GRANT_INTERNAL_SECRET) && String(origin || '') === PRODUCTION_ORIGIN;
}

/**
 * 本番サイト → 分離サイトへ、短寿命・署名付き intent（CARD_GRANT_INTERNAL_SECRET・ts:rawBody）を送る（server-to-server）。
 * @returns {Promise<{ ok: boolean, status: number, data: object|null }>}  通信失敗は status 0
 */
export async function postSignedIntent({ url, intent, secret, fetchImpl }) {
  const f = fetchImpl || fetch;
  const body = JSON.stringify({ v: 1, ...intent, nonce: intent.nonce || randomUUID() });
  const sig = signTsBody({ rawBody: body, secret });
  let res;
  try {
    res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-internal-signature': sig }, body });
  } catch { return { ok: false, status: 0, data: null }; }
  const text = await res.text().catch(() => '');
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

export function paddleApi({ apiBase, key, fetchImpl }) {
  const f = fetchImpl || fetch;
  async function call(method, path, body) {
    const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
    const res = await f(`${apiBase}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const code = json?.error?.code || res.status;
      throw Object.assign(new Error(`paddle_${res.status}_${code}`), { status: res.status });
    }
    return json?.data ?? null;
  }
  return {
    createTransaction: (body) => call('POST', '/transactions', body),
    getTransaction: (id) => call('GET', `/transactions/${encodeURIComponent(id)}`),
    getSubscription: (id) => call('GET', `/subscriptions/${encodeURIComponent(id)}`),
    // 即時解約（マイページの即時退会）。返金はしない（Paddle の cancel は返金を作らない・返金は adjustment で別に行う）
    cancelSubscriptionNow: (id) => call('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { effective_from: 'immediately' }),
    getAdjustment: async (id) => {
      const list = await call('GET', `/adjustments?id=${encodeURIComponent(id)}`);
      return Array.isArray(list) ? list.find((a) => a?.id === id) || null : null;
    },
  };
}
