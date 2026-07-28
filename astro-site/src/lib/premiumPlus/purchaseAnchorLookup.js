/**
 * purchaseAnchorLookup.js — Premium Plus 判定に必要な Customers レコードの取得（唯一の I/O 層）
 *
 * 判定そのものは premiumPlusRelease.js（純粋）/ premiumPlusMember.js（純粋）が行う。
 * ここは Airtable Customers を **GET するだけ**。書き込み・スキーマ変更は一切しない。
 *
 * 読む値:
 *   - SanrenpukuPaidAt / 三連複購入日時 … ROUTE A の anchor
 *   - PaidAt                          … ROUTE B の anchor
 *   - PremiumPlusEligibility 系        … 販売資格
 *   - プラン / PlanType / 有効期限 / Status / LifetimeSanrenpuku … 既存の権限正本が使う
 *   （Airtable は 1 レコード GET で fields をまとめて返すので、判定側が必要分だけ読む）
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

/** recordId → { fields, expiresAt } */
const cache = new Map();

/** テスト用: キャッシュを空にする。 */
export function clearAnchorCache() {
  cache.clear();
}

/**
 * Customers レコードの fields を取得する（キャッシュ付き・読み取り専用）。
 * 取得できないときは null。
 *
 * @param {{ recordId?: string|null, env?: object, now?: number, fetchImpl?: Function }} input
 * @returns {Promise<object|null>}
 */
export async function lookupCustomerFields(input) {
  const { recordId, env = {}, now = Date.now(), fetchImpl } = input || {};
  if (!recordId || typeof recordId !== 'string') return null;

  const cached = cache.get(recordId);
  if (cached && cached.expiresAt > now) return cached.fields;

  const fields = await fetchCustomerFields({ recordId, env, fetchImpl });
  cache.set(recordId, { fields, expiresAt: now + ANCHOR_CACHE_TTL_MS });
  return fields;
}

/**
 * 三連複購入確定日時だけを解決する（ROUTE A 用の薄いラッパ）。
 *
 * 優先順:
 *   1. Customers の SanrenpukuPaidAt / 三連複購入日時
 *   2. env PREMIUM_PLUS_FUNNEL_ANCHOR（会員別の正本が用意されるまでの全体アンカー・暫定）
 *   3. どちらも無ければ null → 呼び出し側は PHASE 1（fail closed）
 *
 * @param {{ recordId?: string|null, env?: object, now?: number, fetchImpl?: Function }} input
 * @returns {Promise<{ paidAtMs: number|null, source: 'field'|'anchor'|'none' }>}
 */
export async function lookupSanrenpukuPaidAt(input) {
  const { env = {} } = input || {};
  const fields = await lookupCustomerFields(input);
  return resolveSanrenpukuPaidAt({ fields, fallbackAnchor: env.PREMIUM_PLUS_FUNNEL_ANCHOR });
}

/**
 * Airtable Customers から 1 レコードの fields を読む。失敗はすべて null。
 * @returns {Promise<object|null>}
 */
async function fetchCustomerFields({ recordId, env, fetchImpl }) {
  const apiKey = env.AIRTABLE_API_KEY;
  const baseId = env.AIRTABLE_BASE_ID;
  const table = env.AIRTABLE_CUSTOMERS_TABLE || 'Customers';
  if (!recordId || typeof recordId !== 'string') return null;
  if (!apiKey || !baseId) return null;

  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return null;

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), ANCHOR_LOOKUP_TIMEOUT_MS) : null;
  try {
    const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}/${encodeURIComponent(recordId)}`;
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
