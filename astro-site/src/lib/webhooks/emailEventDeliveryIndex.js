/**
 * emailEventDeliveryIndex.js — 受信イベント → `CampaignDeliveries` の索引（Phase 1d / I/O 注入）
 *
 * ── なぜ必要か ────────────────────────────────────────────────
 * Phase 1c で送信側が `delivery_key` / `campaign_delivery_id` / `customer_record_id` を刻むようになった。
 * 受信側がそれを**配信台帳の実データと突き合わせて**初めて `resolved` にできる。
 * 刻印だけを信じて resolved にすると、偽装された custom_args で別人の反応を作れてしまう。
 *
 * ── 安全側の設計 ──────────────────────────────────────────
 * - **read-only**。`CampaignDeliveries` を GET するだけで 1 バイトも書かない
 * - **必要なときだけ引く**。custom_args を持つイベントが 1 件も無ければ**リクエストを出さない**
 *   （Webhook は高頻度で叩かれる。無条件に全件取得すると毎回コストを払う）
 * - **必要な鍵だけ引く**。バッチ内の `delivery_key` を OR 条件にして取得する（全件走査しない）
 * - **失敗しても止めない**。索引が引けなければ空の Map を返し、イベントは `unresolved` として保存される
 *   （推測で結び付けるより、確定できない事実をそのまま残す方が安全）
 * - 応答本文のうち**必要な列だけ**を読む。生アドレスは索引に載せない
 */

/** 1 リクエストで問い合わせる鍵の数（formula 長の暴発を防ぐ） */
export const INDEX_CHUNK_SIZE = 20;

/** 1 回の受信で引く鍵の総数の上限（暴走防止） */
export const INDEX_MAX_KEYS = 100;

/** `CampaignDeliveries` から索引に載せる列（**生アドレスは載せない**） */
export const INDEX_FIELDS = Object.freeze([
  'DeliveryKey', 'CustomerRecordId', 'CampaignType', 'Status',
]);

const str = (v) => String(v ?? '').trim();

/** 索引を引く価値のある鍵（custom_args を持つイベントの delivery_key）を集める */
export function collectDeliveryKeys(rawEvents = []) {
  const keys = new Set();
  for (const e of rawEvents || []) {
    if (!e || typeof e !== 'object') continue;
    const k = str(e.delivery_key);
    // 送信側は sha256 hex を刻む。形式が違うものは引きに行かない（無駄打ち・injection 防止）
    if (/^[a-f0-9]{64}$/.test(k)) keys.add(k);
    if (keys.size >= INDEX_MAX_KEYS) break;
  }
  return [...keys];
}

/** `<campaignId>:v<version>` を分解（壊れていれば空） */
export function splitCampaignType(raw) {
  const m = /^([a-z0-9][a-z0-9-]{0,63}):v([0-9]{1,4})$/.exec(str(raw));
  return m ? { campaignId: m[1], campaignVersion: m[2] } : { campaignId: '', campaignVersion: '' };
}

/** Airtable の formula 文字列を安全に組む（鍵は hex のみなのでエスケープ不要だが再検査する） */
export function buildDeliveryFilterFormula(keys = []) {
  const safe = keys.filter((k) => /^[a-f0-9]{64}$/.test(String(k)));
  if (safe.length === 0) return '';
  const terms = safe.map((k) => `{DeliveryKey}='${k}'`);
  return terms.length === 1 ? terms[0] : `OR(${terms.join(',')})`;
}

/** 配列を chunk する */
export function chunk(list = [], size = INDEX_CHUNK_SIZE) {
  const n = Math.max(1, Number(size) || INDEX_CHUNK_SIZE);
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * Airtable のレコード配列を索引へ変換する。
 *
 * - `DeliveryKey` と recordId の**両方**を引けるようにする（受信側で 3 点照合するため）
 * - **同じ `DeliveryKey` に複数レコードがあれば、その鍵は索引に載せない**
 *   （どれが 1 通か決められない → 受信側では `delivery_not_found` になり unresolved のまま残る）
 */
export function buildDeliveryIndex(records = []) {
  const byKey = new Map();
  const duplicated = new Set();
  for (const rec of records || []) {
    const f = (rec && rec.fields) || {};
    const key = str(f.DeliveryKey);
    if (!key) continue;
    if (byKey.has(key)) { duplicated.add(key); continue; }
    const { campaignId, campaignVersion } = splitCampaignType(f.CampaignType);
    byKey.set(key, {
      recordId: str(rec.id),
      deliveryKey: key,
      customerRecordId: str(f.CustomerRecordId),
      campaignId,
      campaignVersion,
      status: str(f.Status),
    });
  }
  for (const k of duplicated) byKey.delete(k);

  // recordId 側からも引けるようにする（値は同じオブジェクト）
  const index = new Map();
  for (const [key, entry] of byKey) {
    index.set(key, entry);
    if (entry.recordId) index.set(entry.recordId, entry);
  }
  return index;
}

/**
 * 受信バッチに必要な配信索引を作る。**read-only / 必要なときだけ / 失敗しても止めない**。
 *
 * @param {{rawEvents: object[], apiKey: string, baseId: string, table?: string,
 *          fetchFn: Function, maxKeys?: number}} input
 * @returns {Promise<{index: Map<string,object>, lookedUp: number, found: number, requests: number, ok: boolean}>}
 */
export async function fetchDeliveryIndex({
  rawEvents = [], apiKey, baseId, table = 'CampaignDeliveries', fetchFn, maxKeys = INDEX_MAX_KEYS,
} = {}) {
  const empty = { index: new Map(), lookedUp: 0, found: 0, requests: 0, ok: true };
  const keys = collectDeliveryKeys(rawEvents).slice(0, maxKeys);
  // 刻印を持つイベントが無ければ**問い合わせない**（本番 Webhook の無駄打ちを避ける）
  if (keys.length === 0 || !apiKey || !baseId || typeof fetchFn !== 'function') return empty;

  const records = [];
  let requests = 0;
  let ok = true;
  for (const part of chunk(keys)) {
    const formula = buildDeliveryFilterFormula(part);
    if (!formula) continue;
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`);
    url.searchParams.set('pageSize', '100');
    url.searchParams.set('filterByFormula', formula);
    for (const f of INDEX_FIELDS) url.searchParams.append('fields[]', f);
    try {
      requests += 1;
      const res = await fetchFn(url.toString(), { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res || !res.ok) { ok = false; continue; }
      const data = await res.json();
      records.push(...((data && data.records) || []));
    } catch {
      // 索引が引けないだけ。イベントは unresolved として保存する（推測しない）
      ok = false;
    }
  }

  return { index: buildDeliveryIndex(records), lookedUp: keys.length, found: records.length, requests, ok };
}
