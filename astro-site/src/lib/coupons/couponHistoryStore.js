/**
 * couponHistoryStore.js — `CouponOperationHistory` への **append-only** 書き込み / 読み出し
 *
 * ## 何を守るか
 *
 * - **gate が off なら 1 行も書かない**（`COUPON_HISTORY_TABLE_READY !== '1'`）
 * - **既存行を更新・削除しない**（append だけ。PATCH / DELETE を持たない）
 * - 同じ `OperationId` の行が既にあれば**積まない**（何度でも 1 件へ収束）
 * - **排他は呼び出し側の operation lock**（`couponOperationLock.js`）が持つ。
 *   状態変更と履歴を**同じ鍵**の中で行うので、
 *   「状態は 1 回・履歴も 1 件」が同じ排他で保証される
 * - **課金・権限を書かない**。このテーブルは権限の根拠にならない
 * - 会員の正本は `CustomerRecordId`。**アドレスを持たない**
 *
 * ⚠️ **Customers / PromotionalOffers を履歴の正本にしない。**
 *    あちらに残るのは直近 1 回の監査値だけで、履歴の正本はこのテーブル。
 *    逆に、**このテーブルを権限・課金の根拠にもしない**（読むのは表示と repair だけ）。
 */

import {
  COUPON_HISTORY_TABLE,
  assertOnlyHistoryFields,
  isCouponHistoryEnabled,
  listHistoryForCustomer,
  planHistoryAppend,
} from './couponOperationHistory.js';

/** 1 会員の履歴を引くページ上限（暴走防止）。超えたら「確認できない」 */
const MAX_PAGES = 5;

const esc = (v) => String(v ?? '').replace(/'/g, "\\'");

/**
 * @param {{ fetchImpl?: Function, apiKey: string, baseId: string, env?: object }} deps
 */
export function createCouponHistoryStore({ fetchImpl, apiKey, baseId, env } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const environment = env || {};
  const url = (qs) => `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(COUPON_HISTORY_TABLE)}${qs || ''}`;
  const headers = { Authorization: `Bearer ${apiKey}` };
  const usable = !!doFetch && !!apiKey && !!baseId;

  /** 読めなければ **null**（＝確認できない）。0 件と混同しない */
  async function query(formula) {
    if (!usable) return null;
    const out = [];
    let offset;
    let pages = 0;
    try {
      do {
        const res = await doFetch(url(`/listRecords`), {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageSize: 100, filterByFormula: formula, ...(offset ? { offset } : {}) }),
        });
        if (!res.ok) return null;
        const data = await res.json();
        out.push(...(data.records || []));
        offset = data.offset;
        pages += 1;
        if (offset && pages >= MAX_PAGES) return null;   // 読み切れていない
      } while (offset);
      return out;
    } catch {
      return null;
    }
  }

  return {
    /** gate。false のあいだは**読み書きとも行わない** */
    enabled: isCouponHistoryEnabled(environment),

    /**
     * 会員 1 人ぶんの履歴（**新しい順**）。他会員の行は混ざらない。
     * @returns {Promise<{ available: boolean, rows: object[], reason: string }>}
     */
    async listForCustomer({ customerRecordId }) {
      if (!isCouponHistoryEnabled(environment)) {
        return { available: false, rows: [], reason: 'history_disabled' };
      }
      const rows = await query(`{CustomerRecordId} = '${esc(customerRecordId)}'`);
      if (rows === null) return { available: false, rows: [], reason: 'read_failed' };
      return {
        available: true,
        rows: listHistoryForCustomer({ rows, customerRecordId }),
        reason: '',
      };
    },

    /** その `OperationId` の行が既にあるか（**null = 確認できない**） */
    async findByOperationId(operationId) {
      if (!isCouponHistoryEnabled(environment)) return null;
      const rows = await query(`{OperationId} = '${esc(operationId)}'`);
      return rows === null ? null : rows;
    },

    /**
     * 1 行だけ積む（**append-only**）。
     *
     * ⚠️ 呼び出し側は **operation lock を保持したまま**呼ぶこと（`lockStatus: 'acquired'`）。
     * ⚠️ 失敗しても**状態変更を巻き戻さない**。`op=` から後で repair できる。
     *
     * @returns {Promise<{ appended: boolean, reason: string }>}
     */
    async append({ record, lockStatus = 'acquired' }) {
      if (!record) return { appended: false, reason: 'no_record' };
      if (!isCouponHistoryEnabled(environment)) return { appended: false, reason: 'history_disabled' };
      const existing = await this.findByOperationId(record.operationId);
      if (existing === null) return { appended: false, reason: 'read_failed' };

      const plan = planHistoryAppend({ record, existing, env: environment, lock: lockStatus });
      if (!plan.append) return { appended: false, reason: plan.reason };
      if (!assertOnlyHistoryFields(record.fields)) {
        return { appended: false, reason: 'field_allow_list_violation' };
      }
      try {
        const res = await doFetch(url(), {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ records: [{ fields: record.fields }], typecast: false }),
        });
        if (!res.ok) return { appended: false, reason: `create_failed_${res.status}` };
        return { appended: true, reason: 'ok' };
      } catch {
        return { appended: false, reason: 'create_failed' };
      }
    },
  };
}
