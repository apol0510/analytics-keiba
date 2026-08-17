/**
 * blacklistWindowReader.js — `EmailBlacklist` の**直近窓**だけを読む（唯一の読み口）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * バッチ健全性の入力は「前バッチで**起きた**」bounce / spam report / unsubscribe。
 * その正本は `EmailBlacklist`（`sendgrid-webhook.js` が Event Webhook から書く）で、
 * **イベントが起きたときにだけ行が増える**。母集団が増えても増えない。
 *
 * ⚠️ 読むのは**種別（`BounceType`）だけ**。アドレスも recordId も取らない。
 * ⚠️ 窓は直近数日のみ。**全件走査しない**（1 ページで足りる規模）。
 * ⚠️ 読めなければ **null**（0 件と書かない）。呼び出し側が fail closed する。
 * ⚠️ ここは**読むだけ**。`EmailBlacklist` へ書く経路は webhook が唯一で、増やさない。
 */

import { summarizeBlacklistWindow, blacklistWindowFormula } from './batchOutcomeSignals.js';

/** 窓が 1,000 行を超えるのは異常（数え切れていないとみなす） */
export const BLACKLIST_WINDOW_MAX_PAGES = 10;

export const BLACKLIST_TABLE = 'EmailBlacklist';

/**
 * @param {{apiKey: string, baseId: string, nowMs: number, days?: number,
 *          fetchImpl?: Function}} input
 * @returns {Promise<{complaints: number, unsubscribes: number, bounces: number,
 *                    softBounces: number, rows: number}|null>}
 */
export async function readBlacklistWindow({
  apiKey, baseId, nowMs, days = 2, fetchImpl = fetch,
} = {}) {
  if (!apiKey || !baseId) return null;
  const rows = [];
  let offset;
  for (let page = 0; page < BLACKLIST_WINDOW_MAX_PAGES; page += 1) {
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(BLACKLIST_TABLE)}`);
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('filterByFormula', blacklistWindowFormula(nowMs, days));
    url.searchParams.append('fields[]', 'BounceType');
    if (offset) url.searchParams.set('offset', offset);
    let data;
    try {
      // eslint-disable-next-line no-await-in-loop -- Airtable は offset 方式
      const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res || !res.ok) return null;
      // eslint-disable-next-line no-await-in-loop
      data = await res.json();
    } catch {
      return null;
    }
    if (!data) return null;
    rows.push(...(data.records || []));
    offset = data.offset;
    if (!offset) return summarizeBlacklistWindow(rows);
  }
  // 数え切れていないので **null**（黙って少ない数を返さない）
  return null;
}

export default readBlacklistWindow;
