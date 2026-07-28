/**
 * purchaseAnchorLookup.js — 三連複「購入確定日時」の取得（唯一の I/O 層）
 *
 * 段階公開の判定そのものは premiumPlusRelease.js（純粋）が行う。ここはその入力である
 * 購入確定日時を **読み取るだけ**。Airtable への書き込み・スキーマ変更は一切しない。
 *
 * 解決順（premiumPlusRelease.resolveSanrenpukuPaidAt と同じ優先順位）:
 *   1. Airtable Customers レコードの SanrenpukuPaidAt / 三連複購入日時
 *      （**このフィールドは 2026-07-28 時点で本番に存在しない**。存在しなければ undefined が
 *        返るだけで無害。作成されたら自動的にこちらが使われる）
 *   2. env PREMIUM_PLUS_FUNNEL_ANCHOR（会員別の正本が用意されるまでの全体アンカー・暫定）
 *   3. どちらも無ければ null → 呼び出し側は PHASE 1（fail closed）
 *
 * fail closed の原則: 鍵が無い / 通信失敗 / タイムアウト / レコード無し は **例外を投げず
 * null を返す**。判定できないときは公開しない側へ倒れる。
 * 秘密鍵・レコード内容はログに出さない。
 */

import { resolveSanrenpukuPaidAt } from './premiumPlusRelease.js';

/** Airtable 取得のタイムアウト（ms）。会員ページの描画を長く待たせない。 */
export const ANCHOR_LOOKUP_TIMEOUT_MS = 2500;

/** 同一レコードの再取得を抑えるキャッシュ TTL（ms）。段階公開は日単位なので粗くてよい。 */
export const ANCHOR_CACHE_TTL_MS = 10 * 60 * 1000;

/** recordId → { paidAtMs, source, expiresAt } */
const cache = new Map();

/** テスト用: キャッシュを空にする。 */
export function clearAnchorCache() {
  cache.clear();
}

/**
 * 購入確定日時を解決する。
 *
 * @param {{
 *   recordId?: string|null,      ak_session payload.sub（Airtable recordId）
 *   env?: object,                process.env 相当
 *   now?: number,                Date.now()（キャッシュ判定用）
 *   fetchImpl?: Function,        テスト用 fetch 差し替え
 * }} input
 * @returns {Promise<{ paidAtMs: number|null, source: 'field'|'anchor'|'none' }>}
 */
export async function lookupSanrenpukuPaidAt(input) {
  const { recordId, env = {}, now = Date.now(), fetchImpl } = input || {};
  const fallbackAnchor = env.PREMIUM_PLUS_FUNNEL_ANCHOR;

  const cached = recordId ? cache.get(recordId) : null;
  if (cached && cached.expiresAt > now) {
    return { paidAtMs: cached.paidAtMs, source: cached.source };
  }

  const fields = await fetchCustomerFields({ recordId, env, fetchImpl });
  const resolved = resolveSanrenpukuPaidAt({ fields, fallbackAnchor });

  if (recordId) {
    cache.set(recordId, { ...resolved, expiresAt: now + ANCHOR_CACHE_TTL_MS });
  }
  return resolved;
}

/**
 * Airtable Customers から 1 レコードの fields を読む。失敗はすべて null。
 * @returns {Promise<object|null>}
 */
async function fetchCustomerFields({ recordId, env, fetchImpl }) {
  const apiKey = env.AIRTABLE_API_KEY;
  const baseId = env.AIRTABLE_BASE_ID;
  if (!recordId || typeof recordId !== 'string') return null;
  if (!apiKey || !baseId) return null;

  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return null;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), ANCHOR_LOOKUP_TIMEOUT_MS) : null;
  try {
    const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/Customers/${encodeURIComponent(recordId)}`;
    const res = await doFetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller ? controller.signal : undefined,
    });
    if (!res || !res.ok) return null;
    const json = await res.json();
    return json && typeof json.fields === 'object' ? json.fields : null;
  } catch {
    // 通信障害 / タイムアウト / JSON 破損。理由も内容もログしない（fail closed）。
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
