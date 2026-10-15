/**
 * paypalWebhookLedger.js — PayPal 月額の Webhook を「受け取って処理した」記録（件数だけ・識別子なし）
 *
 * 2026-10-15 MK: 販売者本人の自己決済テストは行わない。本番の初回実購入が起きたら、決済・Webhook・権限付与を
 * read-only で確認する。権限付与と決済は Customers（PaidAt・有効期限 等）で読めるが、Webhook が届いたかは
 * Function ログ（履歴を後から取れない）にしか残らないため、ここへ件数だけを残す。
 *
 * 記録するのは署名検証（PayPal の verify-webhook-signature = SUCCESS）を通った月額のイベントだけ。
 * HASH `ak:paypal:webhook:v1:sub`
 *   field `n|{eventType}|{result}` = 件数（HINCRBY）
 *   field `last|{eventType}`       = 最後に受けた時刻（ISO）
 * 会員 ID・購読 ID・金額・メールは書かない。result は処理結果のコード（write_attached など有限の値）。
 * 記録に失敗しても Webhook の処理（権限の反映）は変えない（best effort）。
 */

export const PAYPAL_WEBHOOK_LEDGER_KEY = 'ak:paypal:webhook:v1:sub';

const safe = (s) => String(s || 'unknown').replace(/[^A-Za-z0-9_.\-]/g, '_').slice(0, 80);

export async function recordPaypalSubscriptionWebhook(redis, { eventType, result, now = new Date() } = {}) {
  if (!redis) return false;
  try {
    const t = safe(eventType);
    await redis(['HINCRBY', PAYPAL_WEBHOOK_LEDGER_KEY, `n|${t}|${safe(result)}`, 1]);
    await redis(['HSET', PAYPAL_WEBHOOK_LEDGER_KEY, `last|${t}`, now.toISOString()]);
    return true;
  } catch {
    return false;
  }
}

/** HGETALL の結果（[k,v,k,v...] または {k:v}）→ { total, byEvent: { [eventType]: { count, last, results: {[result]: n} } } } */
export function summarizePaypalWebhookLedger(raw) {
  const pairs = Array.isArray(raw)
    ? Array.from({ length: Math.floor(raw.length / 2) }, (_, i) => [raw[2 * i], raw[2 * i + 1]])
    : Object.entries(raw || {});
  const byEvent = {};
  let total = 0;
  const ev = (t) => (byEvent[t] ||= { count: 0, last: null, results: {} });
  for (const [k, v] of pairs) {
    const parts = String(k).split('|');
    if (parts[0] === 'n' && parts.length === 3) {
      const n = Number(v) || 0;
      const e = ev(parts[1]);
      e.count += n;
      e.results[parts[2]] = (e.results[parts[2]] || 0) + n;
      total += n;
    } else if (parts[0] === 'last' && parts.length === 2) {
      ev(parts[1]).last = String(v);
    }
  }
  return { total, byEvent };
}

export async function readPaypalWebhookLedger(redis) {
  if (!redis) return null;
  return summarizePaypalWebhookLedger(await redis(['HGETALL', PAYPAL_WEBHOOK_LEDGER_KEY]));
}
