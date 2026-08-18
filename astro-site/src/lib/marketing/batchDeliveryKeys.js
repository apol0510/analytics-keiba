/**
 * batchDeliveryKeys.js — 直前の論理バッチの **DeliveryKey 集合**を取る（read-only）
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * バッチ健全性は「**その 500 名へ送った通**に起きたイベント」だけを数えたい。
 * campaign と時刻の窓だけで切ると、同じ campaign の
 *   - 別バッチ（直前より前に送った 500 名）の遅れて届いたイベント
 *   - 別 touch（Step2〜24 の定期便）のイベント
 * が混ざる。**通の一意キー（DeliveryKey）で切る**のが唯一正確な方法。
 *
 * ── どこから取るか（既存の識別子だけ）────────────────────────
 * バッチを queue したときに作られた **ScheduledEmails の JobId** を状態に控えてあるので、
 *   `CampaignDeliveries.ScheduledEmailJobId ∈ そのバッチの jobIds`
 * を名指しで引き、`DeliveryKey` を集める。
 * formula は既存の `buildJobIdFormula`（`marketingTargetedLoad.js`）を使う。
 * **新しいテーブルも schema も作らない。読むだけ。**
 *
 * ⚠️ 取り切れない（ページ上限・HTTP 失敗・jobId が無い）ときは **null**。
 *    呼び出し側は「範囲を決められない」＝ fail closed で止める。
 * ⚠️ 返すのは **DeliveryKey（sha256 hex）だけ**。アドレスも recordId も持ち出さない。
 */

import { buildJobIdFormula } from './marketingTargetedLoad.js';

export const DELIVERIES_TABLE = 'CampaignDeliveries';
/** 1 回の formula に入れる jobId の数（式が長くなりすぎないように） */
export const JOB_ID_CHUNK = 10;
/** 1 チャンクで許すページ数（1 ページ 100 行。500 名 = 5 ページで足りる） */
export const MAX_PAGES_PER_CHUNK = 12;

const str = (v) => String(v ?? '').trim();
/** `computeCampaignDeliveryKey` と同じ形（sha256 hex 64） */
const DELIVERY_KEY = /^[a-f0-9]{64}$/;

export function isDeliveryKey(v) {
  return DELIVERY_KEY.test(str(v));
}

/** 配列を n 個ずつに割る */
export function chunk(list, n) {
  const out = [];
  const src = Array.isArray(list) ? list : [];
  for (let i = 0; i < src.length; i += n) out.push(src.slice(i, i + n));
  return out;
}

/**
 * 直前バッチの DeliveryKey を集める。
 *
 * @param {{apiKey: string, baseId: string, jobIds: string[],
 *          fetchImpl?: Function}} input
 * @returns {Promise<Set<string>|null>} 取り切れなければ null（fail closed）
 */
export async function readBatchDeliveryKeys({
  apiKey, baseId, jobIds, fetchImpl = fetch,
} = {}) {
  const ids = (Array.isArray(jobIds) ? jobIds : []).map(str).filter(Boolean);
  if (!apiKey || !baseId || ids.length === 0) return null;

  const keys = new Set();
  for (const group of chunk(ids, JOB_ID_CHUNK)) {
    const formula = buildJobIdFormula(group);
    if (!formula) return null;
    let offset;
    let pages = 0;
    do {
      const url = new URL(`https://api.airtable.com/v0/${baseId}/${encodeURIComponent(DELIVERIES_TABLE)}`);
      url.searchParams.set('pageSize', '100');
      url.searchParams.set('filterByFormula', formula);
      // ⚠️ 取る列は鍵だけ（**アドレスも recordId も取らない**）
      url.searchParams.append('fields[]', 'DeliveryKey');
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
      for (const r of data.records || []) {
        const k = str((r && r.fields && r.fields.DeliveryKey) || '');
        if (isDeliveryKey(k)) keys.add(k);
      }
      offset = data.offset;
      pages += 1;
      // 取り切れない = 範囲を決められない。**黙って一部で判定しない**
      if (offset && pages >= MAX_PAGES_PER_CHUNK) return null;
    } while (offset);
  }
  // 1 件も取れないのは「まだ台帳に出ていない / 引けていない」＝範囲を決められない
  return keys.size > 0 ? keys : null;
}

export default readBatchDeliveryKeys;
