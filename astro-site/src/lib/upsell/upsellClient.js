/**
 * upsellClient.js — 顧客ページから販売導線の判定を 1 回だけ取りに行く（ブラウザ用）
 *
 * ページごとに fetch を書かず、**同じ答え**を全ページで共有するための薄い層。
 * 判定そのものはサーバー（/api/upsell.json → upsellTarget.js）が持つ。
 *
 * ── 取得できないときは既存挙動へ倒す（後方互換）─────────────────────
 * 未ログイン・404・通信エラー・API 未デプロイ のときは `channel='unknown'` を返す。
 * 呼び出し側は unknown を「従来どおり」として扱う:
 *   - 三連複の段階表示は従来どおり動く（localStorage だけで完結していたため）
 *   - Premium Plus は従来どおり `/api/premium-plus-stage.json` 側の判定に従う
 * ＝ この機能が落ちても販売導線が消えたり、逆に両方出たりしない。
 */

/** 販売導線。`unknown` は「判定を取得できなかった＝従来動作」 */
export const UPSELL_CLIENT_CHANNEL = Object.freeze({
  SANRENPUKU: 'sanrenpuku',
  PLUS: 'plus',
  NONE: 'none',
  UNKNOWN: 'unknown',
});

const ENDPOINT = '/api/upsell.json';
let cached = null;

/**
 * 販売導線を取得する（同一ページ内では 1 回だけ通信し、以後は使い回す）。
 * @returns {Promise<{channel: string, sanrenpuku: {allowed: boolean}, plus: object}>}
 */
export function getUpsellDecision() {
  if (cached) return cached;
  cached = (async () => {
    const fallback = {
      channel: UPSELL_CLIENT_CHANNEL.UNKNOWN,
      sanrenpuku: { allowed: true },
      plus: { allowed: false },
      // 取得できなければ「持っていない」扱い＝カードを出さない（fail closed）
      coupon: { claimed: false },
    };
    try {
      const res = await fetch(ENDPOINT, { credentials: 'same-origin' });
      if (!res.ok) return fallback; // 404 = 未ログイン等 → 従来どおり
      const data = await res.json();
      if (!data || typeof data.channel !== 'string') return fallback;
      return data;
    } catch {
      return fallback;
    }
  })();
  return cached;
}

/**
 * 三連複の導線（予告・CTA）を出してよいか。
 * `unknown` は従来どおり出す（この機能の障害で既存導線を止めない）。
 */
export async function canShowSanrenpukuUpsell() {
  const d = await getUpsellDecision();
  if (d.channel === UPSELL_CLIENT_CHANNEL.UNKNOWN) return true;
  return d.channel === UPSELL_CLIENT_CHANNEL.SANRENPUKU;
}

/**
 * 本人の取得済みクーポン（マイページのカード用）。
 *
 * 追加の通信はしない（`getUpsellDecision()` の結果を使い回す）。
 * 取得できない / 未取得のときは `{ claimed: false }` を返し、呼び出し側は**何も出さない**。
 * ⚠️ 表示文言・条件はサーバー（単一源）が返した文字列をそのまま使うこと。
 *    クライアントで条件文や価格を組み立てない。
 */
export async function getReopenCoupon() {
  const d = await getUpsellDecision();
  const c = d && d.coupon;
  return c && c.claimed === true ? c : { claimed: false };
}

/** Premium Plus の導線を出してよいか（unknown は従来どおり Plus 側 API の判定に委ねる） */
export async function canShowPlusUpsell() {
  const d = await getUpsellDecision();
  if (d.channel === UPSELL_CLIENT_CHANNEL.UNKNOWN) return true;
  return d.channel === UPSELL_CLIENT_CHANNEL.PLUS;
}
