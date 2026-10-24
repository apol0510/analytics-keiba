/**
 * cardCheckout.js — お客様向けの「カードで支払う」共通入口（決済会社に依存しない）
 *
 * 2026-10-13 MK 確定（冗長化）: お客様は決済会社を選ばない。申込は cardSales.ACTIVE_CARD_PROVIDER の 1 社へだけ作る。
 * - 作成に失敗しても**別の決済会社へ自動で作り直さない**（502 のまま返す）。未確定の取引が 2 社に並ぶと二重決済になる。
 * - 運営が切り替えた直後に、切替前の決済会社で作った申込（未確定かもしれない）が残っている会員は、
 *   新しい決済会社では申込を作らせない（409 checkout_in_progress）。OPEN_CHECKOUT_TTL_SEC が過ぎれば作れる。
 *   既に払われていた場合の重複は、反映側の 30 分ルール（entitlementLedger）でも管理者へ回る。
 * - 会員権限・料金・購入資格・完了画面は決済会社によらず共通（cardOneTime / entitlementLedger / card-complete）。
 */
import { ACTIVE_CARD_PROVIDER } from './cardSales.js';
import { createPaddleCheckout, resolvePaddleModeForEnv } from './paddle/paddleServer.js';
import { createPaypalOrder } from './paypal/paypalServer.js';
import { resolvePaypalMode } from './paypal/paypalCore.js';

export const OPEN_CHECKOUT_TTL_SEC = 24 * 60 * 60;
export const openCheckoutKey = (recordId) => `ak:billing:open-checkout:${recordId}`;

const CREATORS = Object.freeze({
  paddle: async (a) => { const r = await createPaddleCheckout(a); return r.ok ? { ...r, orderId: r.transactionId } : r; },
  paypal: (a) => createPaypalOrder(a),
});

/** 申込先（ACTIVE_CARD_PROVIDER）がこのサイト・この鍵で受け付けられるか（各社の resolve*Mode と同じ判定）。
 *  paddle は委譲（本番は鍵なし）も含めて resolvePaddleModeForEnv で判定する（鍵の有無だけで早期に弾かない）。 */
export function resolveActiveCardMode({ env = {}, origin, active = ACTIVE_CARD_PROVIDER } = {}) {
  if (active === 'paddle') return resolvePaddleModeForEnv({ env, origin });
  if (active === 'paypal') return resolvePaypalMode({ env, origin });
  return { ok: false, reason: 'card_provider_unset' };
}

/**
 * @returns {{ ok: true, provider, url, orderId } | { ok: false, status, code }}
 */
export async function startCardCheckout({ env, origin, recordId, productId, redis, active = ACTIVE_CARD_PROVIDER, creators = CREATORS, now = new Date() }) {
  const create = creators[active];
  if (!create) return { ok: false, status: 503, code: 'card_provider_unset' };
  if (!recordId) return { ok: false, status: 401, code: 'login_required' };
  if (!redis) return { ok: false, status: 503, code: 'redis_missing' };

  let open = null;
  try { const v = await redis(['GET', openCheckoutKey(recordId)]); open = v ? JSON.parse(v) : null; } catch {
    return { ok: false, status: 503, code: 'redis_unavailable' };
  }
  if (open && open.provider && open.provider !== active) return { ok: false, status: 409, code: 'checkout_in_progress' };

  const r = await create({ env, origin, recordId, productId, entry: 'card', now });
  if (!r.ok) return r;
  try {
    await redis(['SET', openCheckoutKey(recordId), JSON.stringify({ provider: active, orderId: r.orderId, at: now.toISOString() }), 'EX', String(OPEN_CHECKOUT_TTL_SEC)]);
  } catch { /* 取引は作れている。印が残らなくても反映側の 30 分ルールが重複を止める */ }
  return { ok: true, provider: active, url: r.url, orderId: r.orderId };
}
