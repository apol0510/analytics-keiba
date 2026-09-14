/**
 * deliveryKeyRollback.js — 予約（DeliveryKey）を**退避してから**剥がす
 *
 * ## なぜ「再計算」ではだめか（2026-09-14 MK 確定）
 *
 * この基盤の確定設計は **「`DeliveryKey` を後から再計算しない」**。
 * enqueue 時に確定した鍵をそのまま持ち回るのが唯一の正しい扱いで、
 * 「あとで同じ材料から計算し直せるから復元できる」を rollback の根拠にするのは**仕様矛盾**。
 * 材料（本文定義・送信元・step・索引）が 1 つでも動けば別の鍵になり、
 * 復元したつもりで**別の集合を書き戻す**ことになる。
 *
 * したがって rollback の根拠は **「実際に剥がした鍵そのもの」**でなければならない。
 * ここは剥がす前にその集合を **Redis の退避 set へそのまま写す**。
 *
 * ## 手順（この順序を入れ替えない）
 *
 *   ① 退避   `SADD <rollback set> <keys...>`
 *   ② 確認   `SMISMEMBER <rollback set> <keys...>` が**全部 1**
 *   ③ 剥がす `SREM <delivered set> <keys...>`
 *
 * ⚠️ **② を通らなければ 1 件も ③ をしない**（退避できていない鍵を消さない）。
 * ⚠️ ①②③ の途中で落ちても壊れない:
 *      ①で落ちる → 何も剥がしていない
 *      ②で落ちる → 何も剥がしていない
 *      ③で落ちる → 剥がした分は**必ず退避済み**（復元できる）
 *    退避 set に「剥がしていない鍵」が余分に入るのは**無害**（復元は SADD なので冪等）。
 * ⚠️ **外部へ鍵を返さない。** このモジュールの戻り値は件数と監査情報だけ。
 *
 * ## 復元
 *
 * `restore()` が 退避 set の中身を **そのまま** `SADD` で書き戻す（再計算しない）。
 */

import {
  buildDeliveredSetKey, assertDeliveryKeys, DeliveryKeyStoreError, CHUNK,
} from './deliveryKeyStore.js';

/** 退避 set の名前空間（配信台帳の set とは別。取り違えを構造的に防ぐ） */
export const ROLLBACK_NAMESPACE = 'ak:mkt:delivered-rollback:v1';

/** 退避 set の既定 TTL（90 日）。監査情報として必ず記録する */
export const DEFAULT_ROLLBACK_TTL_SEC = 90 * 24 * 60 * 60;

const SAFE_PART = /^[A-Za-z0-9_.-]{1,120}$/;

/** 実行 ID の形（人が付ける。日付＋用途が読めるものを推奨） */
export const RUN_ID = /^[A-Za-z0-9_.-]{4,80}$/;

/**
 * 退避 set のキー。**campaign × version × step × runId** で 1 本。
 * runId を分けることで、やり直しても前回の退避を上書きしない。
 */
export function buildRollbackSetKey({ brand, campaignId, version, step, runId } = {}) {
  const b = String(brand ?? '').trim();
  const c = String(campaignId ?? '').trim();
  const v = Number(version);
  const s = Number(step);
  const r = String(runId ?? '').trim();
  if (!SAFE_PART.test(b)) throw new DeliveryKeyStoreError('bad_brand');
  if (!SAFE_PART.test(c)) throw new DeliveryKeyStoreError('bad_campaign');
  if (!Number.isInteger(v) || v < 1 || v > 9999) throw new DeliveryKeyStoreError('bad_version');
  if (!Number.isInteger(s) || s < 1 || s > 999) throw new DeliveryKeyStoreError('bad_step');
  if (!RUN_ID.test(r)) throw new DeliveryKeyStoreError('bad_run_id');
  return `${ROLLBACK_NAMESPACE}:${b}:${c}:v${v}:s${s}:${r}`;
}

/** 監査情報（件数・digest・TTL・実行 ID）を置く hash のキー */
export function buildRollbackMetaKey(input) {
  return `${buildRollbackSetKey(input)}:meta`;
}

const chunk = (list) => {
  const out = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
};

/**
 * 退避つきの解放。
 *
 * @param {{redisCmd: Function, redisPipeline?: Function}} deps
 */
export function createDeliveryKeyRollbackStore({ redisCmd, redisPipeline } = {}) {
  if (typeof redisCmd !== 'function') throw new DeliveryKeyStoreError('redis_not_configured');
  const call = async (args) => {
    try {
      return await redisCmd(args);
    } catch {
      // ⚠️ ここで空を返してはいけない（退避できていないのに剥がす原因になる）
      throw new DeliveryKeyStoreError('redis_unavailable');
    }
  };

  return {
    /**
     * ① 退避 → ② 確認 → ③ 剥がす。**②を通らなければ 1 件も剥がさない**。
     *
     * @returns {Promise<{stashed: number, verified: number, released: number,
     *                    rollbackKey: string, alreadyReleased: number}>}
     */
    async stashAndRelease({
      brand, campaignId, version, step, runId, keys, digest, ttlSec = DEFAULT_ROLLBACK_TTL_SEC, nowMs,
    }) {
      assertDeliveryKeys(keys);
      const deliveredKey = buildDeliveredSetKey({ brand, campaignId, version });
      const rollbackKey = buildRollbackSetKey({ brand, campaignId, version, step, runId });
      const unique = [...new Set(keys)];
      if (unique.length === 0) {
        return { stashed: 0, verified: 0, released: 0, rollbackKey, alreadyReleased: 0 };
      }

      // ① 退避（まとめて SADD。合計件数は見ない＝再実行で 0 でも正常）
      for (const group of chunk(unique)) {
        // eslint-disable-next-line no-await-in-loop -- CHUNK ごと
        await call(['SADD', rollbackKey, ...group]);
      }
      // TTL は毎回引き直す（退避が先に消えて復元できなくなるのを防ぐ）
      await call(['EXPIRE', rollbackKey, String(Math.max(1, Number(ttlSec) || DEFAULT_ROLLBACK_TTL_SEC))]);

      // ② 確認（**全部 1 でなければ中止**）
      let verified = 0;
      for (const group of chunk(unique)) {
        // eslint-disable-next-line no-await-in-loop
        const res = await call(['SMISMEMBER', rollbackKey, ...group]);
        if (!Array.isArray(res) || res.length !== group.length) {
          throw new DeliveryKeyStoreError('unexpected_response');
        }
        for (const v of res) if (Number(v) === 1) verified += 1;
      }
      if (verified !== unique.length) {
        // ⚠️ 1 件でも退避を確認できなければ **SREM を 1 回も実行しない**
        throw new DeliveryKeyStoreError('stash_incomplete');
      }

      // ③ 剥がす（`SREM` の戻り値＝実際に消えた件数。再実行なら 0）
      let released = 0;
      for (const group of chunk(unique)) {
        // eslint-disable-next-line no-await-in-loop
        const res = await call(['SREM', deliveredKey, ...group]);
        released += Number(res) || 0;
      }

      // 監査情報（**鍵は入れない**）
      const meta = [
        'runId', String(runId), 'campaignId', String(campaignId), 'version', String(version),
        'step', String(step), 'brand', String(brand),
        'digest', String(digest ?? ''), 'ttlSec', String(ttlSec),
        'targeted', String(unique.length), 'stashedVerified', String(verified),
        'released', String(released),
        'updatedAt', new Date(Number(nowMs) || Date.now()).toISOString(),
      ];
      const metaKey = buildRollbackMetaKey({ brand, campaignId, version, step, runId });
      await call(['HSET', metaKey, ...meta]);
      await call(['EXPIRE', metaKey, String(Math.max(1, Number(ttlSec) || DEFAULT_ROLLBACK_TTL_SEC))]);

      return {
        stashed: unique.length,
        verified,
        released,
        // 再実行したぶん（既に剥がしてあった鍵）。異常ではない
        alreadyReleased: unique.length - released,
        rollbackKey,
      };
    },

    /**
     * 退避 set から**そのまま**書き戻す（再計算しない）。
     *
     * @returns {Promise<{restored: number, members: number}>}
     */
    async restore({ brand, campaignId, version, step, runId }) {
      const deliveredKey = buildDeliveredSetKey({ brand, campaignId, version });
      const rollbackKey = buildRollbackSetKey({ brand, campaignId, version, step, runId });
      const members = [];
      let cursor = '0';
      let guard = 0;
      do {
        // eslint-disable-next-line no-await-in-loop
        const res = await call(['SSCAN', rollbackKey, cursor, 'COUNT', '500']);
        if (!Array.isArray(res) || res.length !== 2) {
          throw new DeliveryKeyStoreError('unexpected_response');
        }
        cursor = String(res[0]);
        for (const m of res[1] || []) members.push(String(m));
        guard += 1;
        if (guard > 5000) throw new DeliveryKeyStoreError('scan_not_converging');
      } while (cursor !== '0');

      if (members.length === 0) return { restored: 0, members: 0 };
      assertDeliveryKeys(members);
      let restored = 0;
      for (const group of chunk(members)) {
        // eslint-disable-next-line no-await-in-loop
        const res = await call(['SADD', deliveredKey, ...group]);
        restored += Number(res) || 0;
      }
      return { restored, members: members.length };
    },

    /** 監査情報を読む（**鍵は返さない**） */
    async describe({ brand, campaignId, version, step, runId }) {
      const metaKey = buildRollbackMetaKey({ brand, campaignId, version, step, runId });
      const rollbackKey = buildRollbackSetKey({ brand, campaignId, version, step, runId });
      const raw = await call(['HGETALL', metaKey]);
      const meta = {};
      if (Array.isArray(raw)) {
        for (let i = 0; i + 1 < raw.length; i += 2) meta[String(raw[i])] = String(raw[i + 1]);
      } else if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) meta[String(k)] = String(v);
      }
      const size = Number(await call(['SCARD', rollbackKey])) || 0;
      const ttl = Number(await call(['TTL', rollbackKey]));
      return { meta, stashSize: size, ttlSec: Number.isFinite(ttl) ? ttl : null, rollbackKey };
    },
  };
}

export default createDeliveryKeyRollbackStore;
