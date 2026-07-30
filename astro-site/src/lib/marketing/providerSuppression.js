/**
 * providerSuppression.js — SendGrid 側 suppression の読み取り（GET のみ・唯一の provider I/O）
 *
 * ── なぜ必要か（2026-07-30 監査で判明した実測ギャップ）────────────────────
 * AK の `EmailBlacklist` は **Event Webhook が動き始めて以降のイベントしか持たない**。
 * SendGrid 側には過去分を含む suppression が蓄積されており、実測で次の乖離があった:
 *
 *   SendGrid suppression 61 件（bounces 58 / blocks 4）
 *   AK EmailBlacklist    12 件（うち送信除外に効くのは HARD_BOUNCE 4 件のみ）
 *   → **SendGrid では送れないのに AK が「送信可」と判断する Customers が 42 名**
 *
 * Webhook 同期だけでは、この過去分の差は永久に埋まらない（既に起きたイベントは再送されない）。
 * したがってマーケティング送信では **送信計画の時点で provider へ直接問い合わせる**。
 *
 * ── 原則 ────────────────────────────────────────────────────────────
 * - **GET のみ。** suppression の追加・削除（write）は一切しない
 * - API キー・レスポンス本文・メールアドレスをログへ出さない
 * - 取得できなければ `ok:false` を返す。**呼び出し側は送信を中止する（fail closed）**
 *   「確認できないから送る」を構造的に禁止する
 */

/** 参照する suppression リスト（すべて GET） */
export const SUPPRESSION_LISTS = Object.freeze([
  { key: 'bounces', path: '/v3/suppression/bounces' },
  { key: 'blocks', path: '/v3/suppression/blocks' },
  { key: 'spam_reports', path: '/v3/suppression/spam_reports' },
  { key: 'invalid_emails', path: '/v3/suppression/invalid_emails' },
  { key: 'global_unsubscribes', path: '/v3/suppression/unsubscribes' },
]);

/** 1 リクエストあたりの取得件数と最大ページ数（暴走防止） */
export const PAGE_SIZE = 500;
export const MAX_PAGES = 20;

/** 取得のタイムアウト（ms）。管理画面の操作を長く待たせない */
export const FETCH_TIMEOUT_MS = 8000;

/** キャッシュ TTL（ms）。suppression は分単位で変わるものではない */
export const CACHE_TTL_MS = 5 * 60 * 1000;

let cache = null; // { expiresAt, result }

/** テスト用: キャッシュを空にする */
export function clearProviderSuppressionCache() {
  cache = null;
}

function normalize(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/**
 * SendGrid の suppression を読み取り、正規化した email の Set を返す。
 *
 * @param {{ apiKey?: string, fetchImpl?: Function, now?: number, useCache?: boolean }} input
 * @returns {Promise<{
 *   ok: boolean,
 *   emails: Set<string>,
 *   counts: Record<string, number>,
 *   total: number,
 *   error: string|null,
 *   fetchedAt: number|null,
 *   cached: boolean,
 * }>}
 */
export async function fetchProviderSuppression({ apiKey, fetchImpl, now = Date.now(), useCache = true } = {}) {
  const fail = (error) => ({
    ok: false, emails: new Set(), counts: {}, total: 0, error, fetchedAt: null, cached: false,
  });

  if (useCache && cache && cache.expiresAt > now) {
    return { ...cache.result, cached: true };
  }
  if (!apiKey) return fail('missing_api_key');

  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return fail('no_fetch');

  const emails = new Set();
  const counts = {};

  for (const list of SUPPRESSION_LISTS) {
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS) : null;
      let res;
      try {
        res = await doFetch(`https://api.sendgrid.com${list.path}?limit=${PAGE_SIZE}&offset=${offset}`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller ? controller.signal : undefined,
        });
      } catch {
        // 通信失敗・タイムアウト。理由の詳細（URL/本文）はログにも戻り値にも載せない
        return fail(`fetch_failed:${list.key}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (!res || !res.ok) return fail(`http_${res ? res.status : 'no_response'}:${list.key}`);

      let data;
      try { data = await res.json(); } catch { return fail(`invalid_json:${list.key}`); }
      const arr = Array.isArray(data) ? data : [];
      for (const item of arr) {
        const e = normalize(item && item.email);
        if (e) emails.add(e);
      }
      counts[list.key] = (counts[list.key] || 0) + arr.length;
      if (arr.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
  }

  const result = { ok: true, emails, counts, total: emails.size, error: null, fetchedAt: now, cached: false };
  if (useCache) cache = { expiresAt: now + CACHE_TTL_MS, result };
  return result;
}

/**
 * 応答へ載せてよい要約（PII を含まない）。
 * @param {Awaited<ReturnType<typeof fetchProviderSuppression>>} r
 */
export function describeProviderSuppression(r) {
  if (!r || !r.ok) {
    return { available: false, error: (r && r.error) || 'unknown', total: 0, counts: {} };
  }
  return { available: true, error: null, total: r.total, counts: r.counts, cached: !!r.cached };
}
