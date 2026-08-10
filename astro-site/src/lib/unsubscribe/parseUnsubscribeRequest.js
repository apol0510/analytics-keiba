/**
 * 配信停止リクエストの解釈（純粋・IO なし）。
 *
 * ── なぜ要るか（2026-08-10 の実害）────────────────────────────
 * 送信メールには `List-Unsubscribe-Post: List-Unsubscribe=One-Click`（RFC 8058）を
 * 付けている。Gmail / Yahoo はこれを見てネイティブの「配信停止」ボタンを出し、
 * 押されると **`application/x-www-form-urlencoded` の POST** を投げる:
 *
 *     POST <List-Unsubscribe の URL>
 *     Content-Type: application/x-www-form-urlencoded
 *
 *     List-Unsubscribe=One-Click
 *
 * ところが handler は body を無条件で `JSON.parse` していたため
 * **400 `invalid JSON body` で全部落ちていた**。13,956 通配信して配信停止フラグが
 * 0 件だった原因がこれ。押した人は「止めたつもり」で止まっていない。
 *
 * ── 仕様（RFC 8058）────────────────────────────────────────
 *  - **宛先は body ではなく URL に入っている**（`List-Unsubscribe` の URL 自体が
 *    受信者ごとに `?email=…&brand=…` を持つ）。body は意思表示だけ
 *  - ワンクリックは **配信停止専用**。`resubscribe` は受け付けない
 *  - 成功は **2xx** を返す。非 2xx だとメールクライアントは失敗として扱う
 */

export const REQUEST_KIND = Object.freeze({
  ONE_CLICK: 'one-click',   // RFC 8058。form-urlencoded
  JSON_API: 'json-api',     // 確認ページのボタンから
  INVALID: 'invalid',
});

/** `Content-Type: application/json; charset=utf-8` → `application/json` */
export function mediaType(contentType) {
  return String(contentType || '').split(';')[0].trim().toLowerCase();
}

/**
 * POST を解釈する。**Content-Type で分岐**し、どちらの経路も壊さない。
 *
 * @param {{
 *   contentType?: string,
 *   rawBody?: string,
 *   query?: {email?: string|null, brand?: string|null},
 * }} input
 * @returns {{kind: string, email: string|null, brand: string|null, action: string, reason: string|null}}
 */
export function parseUnsubscribeRequest({ contentType, rawBody, query } = {}) {
  const q = query || {};
  const type = mediaType(contentType);
  const body = typeof rawBody === 'string' ? rawBody : '';

  // ── RFC 8058 ワンクリック ─────────────────────────────────
  if (type === 'application/x-www-form-urlencoded') {
    let params;
    try {
      params = new URLSearchParams(body);
    } catch {
      return { kind: REQUEST_KIND.INVALID, email: null, brand: null, action: 'unsubscribe', reason: 'unparsable-form-body' };
    }
    // `List-Unsubscribe=One-Click` が仕様上の合図。大文字小文字は緩く見る
    const signal = params.get('List-Unsubscribe') ?? params.get('list-unsubscribe');
    if (String(signal || '').trim().toLowerCase() !== 'one-click') {
      return { kind: REQUEST_KIND.INVALID, email: null, brand: null, action: 'unsubscribe', reason: 'not-one-click' };
    }
    return {
      kind: REQUEST_KIND.ONE_CLICK,
      // ⚠️ 宛先は **URL 側**から取る。body の値を宛先に使わない
      //    （body から任意アドレスを止められると第三者による嫌がらせが成立する）
      email: q.email ?? null,
      brand: q.brand ?? null,
      action: 'unsubscribe', // ワンクリックは配信停止専用
      reason: null,
    };
  }

  // ── 既存の JSON 経路（確認ページのボタン）──────────────────
  // Content-Type 未指定でも JSON として解釈を試みる（従来互換）
  if (type === 'application/json' || type === '' || type === 'text/plain') {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { kind: REQUEST_KIND.INVALID, email: null, brand: null, action: 'unsubscribe', reason: 'invalid-json-body' };
    }
    const o = parsed && typeof parsed === 'object' ? parsed : {};
    return {
      kind: REQUEST_KIND.JSON_API,
      email: o.email ?? q.email ?? null,
      brand: o.brand ?? q.brand ?? null,
      action: o.action === 'resubscribe' ? 'resubscribe' : 'unsubscribe',
      reason: null,
    };
  }

  return {
    kind: REQUEST_KIND.INVALID, email: null, brand: null, action: 'unsubscribe',
    reason: `unsupported-content-type`,
  };
}

/**
 * 結果 → HTTP status。
 *
 * ワンクリックは **メールクライアントが見る**ので判定を分ける:
 *  - 成功も「元々登録が無い」も **200**。利用者から見た目的（もう届かない）は
 *    どちらも達成されており、かつ**アドレスの存在有無を漏らさない**
 *  - 構成不備・Airtable 障害は 2xx にしない（**握り潰すと直す機会を失う**）
 */
export function statusForResult({ kind, ok, reason }) {
  if (ok) return 200;
  const oneClick = kind === REQUEST_KIND.ONE_CLICK;
  if (reason === 'email-not-found') return oneClick ? 200 : 404;
  if (reason === 'invalid-email' || reason === 'brand-required' || reason === 'unknown-brand') return 400;
  if (reason === 'missing-env') return 503;
  return 502;
}
