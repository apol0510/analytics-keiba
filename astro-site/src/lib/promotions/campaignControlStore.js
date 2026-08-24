/**
 * campaignControlStore.js — キャンペーンの停止スイッチと個別除外の保存先（I/O。判定は持たない）
 *
 * ## 形
 *
 * ```
 * STRING ak:campaign:v1:paused      "1" のとき停止
 * HASH   ak:campaign:v1:excluded    field = Customers の recordId / value = 理由つき JSON
 * ```
 *
 * `premiumPlusReopenStartStore.js` と**同じ形**にしてある。
 * **本番 Airtable の schema を増やさない**（列も表も追加しない）。
 *
 * ## 読めないときは「止まっていない」と言わない
 *
 * 判定は `campaignControl.js` が持つ。ここは `available:false` を返すだけで、
 * **既定値を作らない**（読めないのに「停止していません」と答えると、
 * 止めたはずの割引が出続ける）。
 */

import { makeRedisCmd } from '../premiumPlus/premiumPlusFunnelServer.js';

export const CAMPAIGN_PAUSED_KEY = 'ak:campaign:v1:paused';
export const CAMPAIGN_EXCLUDED_KEY = 'ak:campaign:v1:excluded';

/** Customers の recordId の形（他の値を鍵にしない） */
export function isSafeRecordId(v) {
  return /^rec[A-Za-z0-9]{14}$/.test(String(v || ''));
}

export function createCampaignControlStore({ redisCmd } = {}) {
  const on = typeof redisCmd === 'function';

  return {
    /** 停止スイッチの状態。読めなければ `available:false` */
    async readControl() {
      if (!on) return { available: false, paused: false, reason: 'redis_unavailable' };
      try {
        const v = await redisCmd(['GET', CAMPAIGN_PAUSED_KEY]);
        return { available: true, paused: String(v ?? '') === '1', reason: '' };
      } catch {
        return { available: false, paused: false, reason: 'read_failed' };
      }
    },

    /** 止める / 再開する */
    async setPaused({ paused, actor }) {
      if (!on) return { ok: false, reason: 'redis_unavailable' };
      try {
        if (paused) await redisCmd(['SET', CAMPAIGN_PAUSED_KEY, '1']);
        else await redisCmd(['DEL', CAMPAIGN_PAUSED_KEY]);
        // 誰が操作したかは通常のログへ（Redis に監査を溜めない）
        return { ok: true, paused: !!paused, actor: String(actor || '') };
      } catch {
        return { ok: false, reason: 'write_failed' };
      }
    },

    /** その会員が除外されているか。読めなければ null（＝判断できない） */
    async isExcluded(recordId) {
      if (!on || !isSafeRecordId(recordId)) return null;
      try {
        const v = await redisCmd(['HGET', CAMPAIGN_EXCLUDED_KEY, String(recordId)]);
        return v !== null && v !== undefined;
      } catch {
        return null;
      }
    },

    /** 除外の一覧（管理画面用）。読めなければ `available:false` */
    async listExcluded() {
      if (!on) return { available: false, ids: [] };
      try {
        const v = await redisCmd(['HKEYS', CAMPAIGN_EXCLUDED_KEY]);
        return { available: true, ids: Array.isArray(v) ? v.map(String) : [] };
      } catch {
        return { available: false, ids: [] };
      }
    },

    /** 対象外にする / 戻す */
    async setExcluded({ recordId, excluded, actor, reason }) {
      if (!on) return { ok: false, reason: 'redis_unavailable' };
      if (!isSafeRecordId(recordId)) return { ok: false, reason: 'invalid_record_id' };
      try {
        if (excluded) {
          await redisCmd(['HSET', CAMPAIGN_EXCLUDED_KEY, String(recordId), JSON.stringify({
            actor: String(actor || ''), reason: String(reason || ''),
          })]);
        } else {
          await redisCmd(['HDEL', CAMPAIGN_EXCLUDED_KEY, String(recordId)]);
        }
        return { ok: true, excluded: !!excluded };
      } catch {
        return { ok: false, reason: 'write_failed' };
      }
    },
  };
}

/** 既定の保存先（本番の接続をそのまま使う） */
export function campaignControlStore(env = process.env) {
  return createCampaignControlStore({ redisCmd: makeRedisCmd(env) });
}
