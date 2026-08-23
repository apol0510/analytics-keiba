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

/**
 * **すぐ反映されないと困る読み取り**の許容鮮度（ms）。
 *
 * ## なぜ要るか（2026-08-23 / MK 報告「反映されない」）
 *
 * クーポンの保有状態は**管理画面の操作で変わる**。ところが管理操作は別の Function で
 * 動くため、こちらの**プロセス内キャッシュを無効化できない**。
 * その結果、再発行しても顧客画面は最大 10 分**古いまま**で、
 * 「渡したのに画面が変わらない」状態になっていた（実際に本番で発生）。
 *
 * 段階公開のアンカー（日単位）は 10 分で構わないが、
 * **クーポンの保有・お知らせ・申込価格**は分単位で追いつく必要がある。
 */
export const FRESH_LOOKUP_MAX_AGE_MS = 60 * 1000;

/** recordId → { fields, expiresAt } */
const cache = new Map();

/** テスト用: キャッシュを空にする。 */
export function clearAnchorCache() {
  cache.clear();
}

/**
 * 1 レコードだけキャッシュから落とす。
 *
 * このモジュールは 10 分キャッシュを持つため、**同じリクエスト系列で Customers を
 * 更新した直後**（例: クーポン取得）に読み直すと古い値が返り、画面が「未取得」の
 * ままになる。書き込んだ側がここを呼んで、自分の更新だけを確実に見えるようにする。
 *
 * ⚠️ 全消し（clearAnchorCache）を本番経路で呼ばないこと。他会員の取得まで巻き添えで
 *    無効化され、Airtable への再取得が一斉に走る。
 */
export function invalidateCustomerFields(recordId) {
  if (typeof recordId === 'string' && recordId) cache.delete(recordId);
}

/**
 * Customers レコードの fields を取得する（キャッシュ付き・読み取り専用）。
 * 取得できないときは null。
 *
 * @param {{ recordId?: string|null, env?: object, now?: number, fetchImpl?: Function }} input
 * @returns {Promise<object|null>}
 */
export async function lookupCustomerFields(input) {
  const r = await lookupCustomerFieldsResult(input);
  return r.ok ? r.fields : null;
}

/**
 * `lookupCustomerFields` の理由付き版。**認可に使う側はこちらを使うこと。**
 *
 * ⚠️ **失敗を絶対にキャッシュしない。**
 *    2026-08-08 の障害: Airtable の一時障害（429 / タイムアウト）で null が返り、
 *    それが 10 分キャッシュされたため、**有効な有料会員が 10 分間 302 /login** になった。
 *    キャッシュ鍵は recordId なので、**マジックリンクで入り直しても回復しない**。
 *    利用者は繰り返しログインを試み、負荷が増えて 429 がさらに出る悪循環になった。
 *
 * @returns {Promise<{ok:true, fields:object} | {ok:false, reason:'not_found'|'unavailable'}>}
 */
export async function lookupCustomerFieldsResult(input) {
  const { recordId, env = {}, now = Date.now(), fetchImpl } = input || {};
  if (!recordId || typeof recordId !== 'string') return { ok: false, reason: 'not_found' };

  // ⚠️ `maxAgeMs` を渡すと、TTL 内でも**それより古い値は使わない**。
  //    管理画面の操作（付与・再発行・訂正）は別 Function なので、こちらの
  //    プロセス内キャッシュを無効化できない。すぐ反映が要る読み取りはここで鮮度を指定する。
  const maxAgeMs = Number.isFinite(input.maxAgeMs) ? Number(input.maxAgeMs) : null;
  const cached = cache.get(recordId);
  const fresh = cached
    && cached.expiresAt > now
    && (maxAgeMs === null || now - cached.cachedAt <= maxAgeMs);
  if (fresh) return { ok: true, fields: cached.fields };

  const r = await fetchCustomerFields({ recordId, env, fetchImpl });
  // ✅ 成功したときだけ入れる。失敗（not_found / unavailable）は入れない。
  if (r.ok) cache.set(recordId, { fields: r.fields, cachedAt: now, expiresAt: now + ANCHOR_CACHE_TTL_MS });
  return r;
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
 * **通常 Light / Premium の「有料化が確定した時刻」だけ**を返す薄いラッパ（read-only）。
 *
 * ── なぜこの 1 関数を足すのか ──────────────────────────────────
 * DRM の購入帰属は「いつ有料になったか」だけが要る。ところが
 * `lookupCustomerFields` は Customers の **fields をまるごと**返すので、
 * 分析側へ渡すと氏名・アドレス・契約状態まで持ち出してしまう。
 * ここで**時刻 1 つに絞って**返し、raw fields を外へ出さない。
 *
 * ── `PaidAt` の意味（取り違えない）──────────────────────────────
 * ⚠️ **checkout（申込）時刻ではない。** `bankPaymentFlow.buildConfirmationFields` が
 *    `PaidAt: confirmedAt.toISOString()` として書く、**入金確認 = 有料化が確定した時刻**。
 *    申込フォーム送信時には書かれない（申込時は `Requested*` へ退避するだけ）。
 * ⚠️ 読めない / 無い / 解釈できない値は **`null`**（`reason` つき）。
 *    **推測で時刻を作らない。** 呼び出し側は帰属を `unattributed` にする。
 *
 * @param {{ recordId?: string|null, env?: object, now?: number, fetchImpl?: Function }} input
 * @returns {Promise<{ paidAtMs: number|null, reason: 'ok'|'missing'|'invalid'|'not_found'|'unavailable' }>}
 */
export async function lookupPaidConfirmedAt(input) {
  const r = await lookupCustomerFieldsResult(input);
  if (!r.ok) return { paidAtMs: null, reason: r.reason };
  const raw = (r.fields || {})['PaidAt'];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { paidAtMs: null, reason: 'missing' };
  }
  const ms = Date.parse(String(raw));
  if (!Number.isFinite(ms)) return { paidAtMs: null, reason: 'invalid' };
  return { paidAtMs: ms, reason: 'ok' };
}

/**
 * Airtable Customers から 1 レコードの fields を読む。失敗はすべて null。
 * @returns {Promise<object|null>}
 */
async function fetchCustomerFields({ recordId, env, fetchImpl }) {
  const apiKey = env.AIRTABLE_API_KEY;
  const baseId = env.AIRTABLE_BASE_ID;
  const table = env.AIRTABLE_CUSTOMERS_TABLE || 'Customers';
  if (!recordId || typeof recordId !== 'string') return { ok: false, reason: 'not_found' };
  if (!apiKey || !baseId) return { ok: false, reason: 'unavailable' };

  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { ok: false, reason: 'unavailable' };

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), ANCHOR_LOOKUP_TIMEOUT_MS) : null;
  try {
    const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(table)}/${encodeURIComponent(recordId)}`;
    const res = await doFetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller ? controller.signal : undefined,
    });
    if (!res) return { ok: false, reason: 'unavailable' };
    // 404 = レコードが本当に無い。それ以外の非 2xx は**一時障害**として区別する。
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    const json = await res.json();
    return json && typeof json.fields === 'object'
      ? { ok: true, fields: json.fields }
      : { ok: false, reason: 'not_found' };
  } catch {
    // 通信障害 / タイムアウト / JSON 破損。内容はログしない（fail closed）。
    return { ok: false, reason: 'unavailable' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
