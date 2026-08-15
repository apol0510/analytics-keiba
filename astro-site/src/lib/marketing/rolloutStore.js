/**
 * rolloutStore.js — 展開状態の保存（Redis が正本 / I/O は cmd に委譲）
 *
 * ── なぜ env ではなく状態を持つのか ──────────────────────────
 * 毎バッチ env を開閉して redeploy する運用は、14,479 名を配るには回らない
 *（145 回の手操作になる）。1 日あたりの上限・段階・停止は
 * **redeploy 無しで変えられる状態**として持つ。
 *
 * ただし **env のマスタースイッチは残す**。状態だけで動くようにすると、
 * 「Redis を書ける人＝本番配信を始められる人」になってしまう。
 *   - env（`MARKETING_ROLLOUT_ENABLED`）… 機能そのものの許可。既定 OFF
 *   - 状態（Redis）………………………… 日々の運用（段階・件数・停止）
 *
 * ── なぜ Redis か ────────────────────────────────────────────
 * - 既に本番で動いている `UPSTASH_REDIS_REST_*` を使う（**新しい外部サービスを増やさない**）
 * - 「読んで書く」の間に別実行が入らないよう **CAS（Lua）** で更新する
 * - Netlify Blobs は read-after-write が eventual なので**正本にしない**
 * - Airtable は CAS が無く、レート制限も厳しいので状態管理には使わない
 *
 * ⚠️ 鍵にも値にも **PII を入れない**。入るのは段階・件数・日付だけ。
 */

import { normalizeRolloutState, defaultRolloutState } from './rolloutPlan.js';

/** 展開状態の鍵空間（automation / dispatch とは分ける） */
export const ROLLOUT_ROOT = 'ak:marketing-rollout:';

export const rolloutKey = Object.freeze({
  /** campaignId ごとに独立した状態 */
  state: (campaignId) => `${ROLLOUT_ROOT}state:${campaignId}`,
});

export const ROLLOUT_STORE_FAIL = Object.freeze({
  UNREACHABLE: 'unreachable',
  UNKNOWN_RESULT: 'unknown_result',
  OUT_OF_NAMESPACE: 'out_of_namespace',
  CAS_CONFLICT: 'cas_conflict',
  DATA_CORRUPT: 'data_corrupt',
  BAD_CAMPAIGN_ID: 'bad_campaign_id',
});

export class RolloutStoreError extends Error {
  constructor(code, detail) {
    super(`rollout_store:${code}`);
    this.name = 'RolloutStoreError';
    this.code = code;
    this.detail = detail || null;
  }
}

/** 鍵に入れてよい campaignId の形（PII を含まない識別子だけ） */
export function isSafeCampaignId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,80}$/.test(id);
}

/**
 * **読んだ版と一致するときだけ**書き換える（CAS）。
 * 版が違えば `CONFLICT` を返し、呼び出し側は読み直してやり直す。
 *
 *   KEYS[1] = state キー
 *   ARGV[1] = 保存する JSON / ARGV[2] = 期待する version（新規なら ''）
 */
const CAS_LUA = `
local cur = redis.call('GET', KEYS[1])
if cur then
  local v = string.match(cur, '"version":(%d+)')
  if v ~= ARGV[2] then return 'CONFLICT' end
elseif ARGV[2] ~= '' then
  return 'MISSING'
end
redis.call('SET', KEYS[1], ARGV[1])
return 'OK'
`;

/**
 * @param {{cmd: (args: string[]) => Promise<any>}} deps
 *   `cmd` は `makeRedisCmd(process.env)`（Upstash REST）を想定。
 */
export function createRolloutStore(deps = {}) {
  const cmd = deps.cmd;
  if (typeof cmd !== 'function') throw new Error('createRolloutStore: cmd が必要です');

  const assertKey = (key) => {
    const k = String(key ?? '');
    if (!k.startsWith(ROLLOUT_ROOT)) throw new RolloutStoreError(ROLLOUT_STORE_FAIL.OUT_OF_NAMESPACE);
    return k;
  };

  const call = async (args, code) => {
    const op = String(args[0] || '').toUpperCase();
    if (['GET', 'SET', 'DEL'].includes(op)) assertKey(args[1]);
    if (op === 'EVAL') {
      const n = Number(args[2]);
      for (const k of args.slice(3, 3 + (Number.isFinite(n) ? n : 0))) assertKey(k);
    }
    let res;
    try {
      res = await cmd(args);
    } catch (e) {
      // ⚠️ 例外の中身（URL・token を含みうる）は載せない
      throw new RolloutStoreError(code || ROLLOUT_STORE_FAIL.UNREACHABLE, op);
    }
    if (res === undefined) throw new RolloutStoreError(ROLLOUT_STORE_FAIL.UNKNOWN_RESULT, op);
    return res;
  };

  const guardId = (campaignId) => {
    if (!isSafeCampaignId(campaignId)) throw new RolloutStoreError(ROLLOUT_STORE_FAIL.BAD_CAMPAIGN_ID);
    return campaignId;
  };

  return {
    assertKey,

    /**
     * 状態を読む。**無ければ既定（停止）** を返す（`exists: false`）。
     * 壊れていれば例外（**動かさない**）。
     */
    async load(campaignId) {
      guardId(campaignId);
      const raw = await call(['GET', rolloutKey.state(campaignId)]);
      if (raw === null) return { exists: false, state: defaultRolloutState() };
      let parsed;
      try { parsed = JSON.parse(raw); } catch { throw new RolloutStoreError(ROLLOUT_STORE_FAIL.DATA_CORRUPT); }
      return { exists: true, state: normalizeRolloutState(parsed) };
    },

    /**
     * CAS で保存する。`expectedVersion` は `load()` が返した `state.version`
     *（新規作成なら `null`）。
     */
    async save({ campaignId, state, expectedVersion }) {
      guardId(campaignId);
      const next = normalizeRolloutState(state);
      next.version = (Number(expectedVersion) || 0) + 1;
      const res = await call([
        'EVAL', CAS_LUA, '1', rolloutKey.state(campaignId),
        JSON.stringify(next),
        expectedVersion === null || expectedVersion === undefined ? '' : String(expectedVersion),
      ]);
      if (res === 'OK') return { ok: true, state: next };
      if (res === 'CONFLICT' || res === 'MISSING') {
        throw new RolloutStoreError(ROLLOUT_STORE_FAIL.CAS_CONFLICT, String(res).toLowerCase());
      }
      throw new RolloutStoreError(ROLLOUT_STORE_FAIL.UNKNOWN_RESULT, 'cas');
    },

    /**
     * **緊急停止**。読み直して `killed` を立てるだけ（他の値は触らない）。
     * 競合したら 1 度だけやり直す（止める操作は通したい）。
     */
    async kill({ campaignId, nowMs, note = '' }) {
      guardId(campaignId);
      for (let i = 0; i < 2; i += 1) {
        const cur = await this.load(campaignId);
        try {
          return await this.save({
            campaignId,
            state: { ...cur.state, killed: true, updatedAtMs: nowMs ?? null, note: String(note || '').slice(0, 200) },
            expectedVersion: cur.exists ? cur.state.version : null,
          });
        } catch (e) {
          if (!(e instanceof RolloutStoreError) || e.code !== ROLLOUT_STORE_FAIL.CAS_CONFLICT) throw e;
        }
      }
      throw new RolloutStoreError(ROLLOUT_STORE_FAIL.CAS_CONFLICT, 'kill');
    },

    /** 停止の解除（**段階は上げない**。上げるのは別操作） */
    async resume({ campaignId, nowMs }) {
      guardId(campaignId);
      const cur = await this.load(campaignId);
      return this.save({
        campaignId,
        state: { ...cur.state, killed: false, updatedAtMs: nowMs ?? null },
        expectedVersion: cur.exists ? cur.state.version : null,
      });
    },
  };
}

/** 機能そのものの許可（**既定 OFF**）。日々の運用は状態側で行う */
export function isRolloutEnabled(env) {
  return !!env && env.MARKETING_ROLLOUT_ENABLED === 'true';
}

export default createRolloutStore;
