/**
 * segmentInputs.js — セグメント集計に渡す「除外の材料」を作る
 *
 * ── なぜ Function に直接書かないか ────────────────────────────
 * `admin-marketing.js` には**構造的な禁止**が 2 つある（guard テストで固定）:
 *
 *   1. SendGrid のエンドポイントを組み立てない（＝この画面からメールを送らせない）
 *   2. 応答に宛先アドレスを載せない
 *
 * 集計の材料づくりには「配信履歴から宛先ごとの最終送信日時を作る」処理と
 * 「配信基盤の計測設定を読む」処理が要る。どちらも Function に直接書くと
 * 上の 2 つに引っかかるので、**読み取り専用のモジュールとしてここに分離**する。
 *
 * このモジュールがすること:
 *   - Airtable の配信履歴 → email ごとの最終送信時刻の Map（Function へは Map しか返さない）
 *   - SendGrid の**設定だけ** GET（`/v3/tracking_settings/*` と webhook 設定）
 *
 * このモジュールがしないこと:
 *   - メール送信（`/v3/mail/send` を持たない）
 *   - 書き込み全般
 */

import { resolveMeasurementState } from './deliveryMeasurement.js';

const SG_BASE = 'https://api.sendgrid.com';
/** 読んでよいのは**設定だけ**。送信系のパスはここに書かない */
const SETTINGS_PATHS = Object.freeze({
  openTracking: '/v3/tracking_settings/open',
  clickTracking: '/v3/tracking_settings/click',
  eventWebhook: '/v3/user/webhooks/event/settings',
});

const str = (v) => String(v ?? '').trim();
const em = (v) => str(v).toLowerCase();

/**
 * 配信履歴 → 宛先ごとの最終送信時刻。
 * **戻り値は Map だけ**（呼び出し側の応答には載らない）。
 *
 * @param {Array<{fields?: object}>} deliveries CampaignDeliveries の行
 */
export function buildLastContactMap(deliveries) {
  const map = new Map();
  for (const rec of deliveries || []) {
    const f = (rec && rec.fields) || {};
    const status = str(f.Status);
    // 送った / 送る予定のものだけ。skip したものは接触に数えない
    if (status !== 'sent' && status !== 'queued') continue;
    const to = em(f.RecipientEmail);
    if (!to) continue;
    const at = Date.parse(str(f.SentAt) || str(f.QueuedAt) || '');
    if (!Number.isFinite(at)) continue;
    const cur = map.get(to);
    if (cur === undefined || at > cur) map.set(to, at);
  }
  return map;
}

/**
 * 特定キャンペーンで既に送った宛先の集合。
 * @param {Array<{fields?: object}>} deliveries
 * @param {string} campaignType `<campaignId>:v<version>`
 */
export function buildDeliveredSet(deliveries, campaignType) {
  const want = str(campaignType);
  const out = new Set();
  if (!want) return out;
  for (const rec of deliveries || []) {
    const f = (rec && rec.fields) || {};
    if (str(f.CampaignType) !== want) continue;
    const to = em(f.RecipientEmail);
    if (to) out.add(to);
  }
  return out;
}

/**
 * 配信基盤の**計測設定だけ**を読む（GET のみ）。
 * 読めない項目は `null` のまま渡し、判定側が「不明」と答える（推測しない）。
 *
 * @param {{ apiKey?: string, fetchImpl?: Function }} input
 */
export async function readMeasurementSettings({ apiKey, fetchImpl } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const get = async (path) => {
    if (!apiKey || !doFetch) return null;
    try {
      const res = await doFetch(`${SG_BASE}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res || !res.ok) return null;
      return await res.json();
    } catch {
      return null;   // 読めないことは「不明」であって「無効」ではない
    }
  };

  const [openTracking, clickTracking, eventWebhook] = await Promise.all([
    get(SETTINGS_PATHS.openTracking),
    get(SETTINGS_PATHS.clickTracking),
    get(SETTINGS_PATHS.eventWebhook),
  ]);
  return resolveMeasurementState({ openTracking, clickTracking, eventWebhook });
}

export default buildLastContactMap;
