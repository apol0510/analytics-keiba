/**
 * couponOperationLock.js — クーポン操作の**排他**（状態変更より前に取る）
 *
 * ## なぜ「履歴の直前」ではなく「状態変更の前」か
 *
 * 墓標を history append の直前で取ると、**本体更新の race が残る**。
 * 未取得の同じ会員へ `grant` が同時に 2 本来た場合:
 *
 * ```
 * A: 未取得を read ──┐                     B: 未取得を read ──┐
 * A: Customers PATCH ┘（成功）              B: Customers PATCH ┘（成功・**上書き**）
 * → 履歴は OperationId で 1 件になるが、Customers の Source / actor / reason / at は
 *   後勝ちの B に上書きされ、**最終監査値と履歴が食い違う**
 * ```
 *
 * したがって排他は **① 状態を read → ② 安定 OperationId を算出 → ③ ここで lock** の順で取る。
 * lock を取れなかった要求は**副作用ゼロで競合として断る**。
 *
 * ## 既存の primitive を再利用する（新しい外部基盤を足さない）
 *
 * 鍵の取り方・検証・解放は `marketing/automationStore.js` と**同じ**:
 *   - `INCR` の fencing token
 *   - `SET <key> <token> NX EX <ttl>`
 *   - 検証・解放は **Lua で atomic**（`GET` してから `DEL` の 2 段だと、
 *     その隙に TTL 切れ → 別実行が取得、を消してしまう）
 *   - **token が一致しないと release しない**（他プロセスの鍵を消さない）
 *
 * `UPSTASH_REDIS_REST_*` は本番稼働中のものをそのまま使う。
 *
 * ## Redis が使えないとき
 *
 * **書かない**（fail closed）。排他できないまま本体を書くと、上の race がそのまま起きる。
 *
 * ## 鍵に入れてよいもの
 *
 * `OperationId`（sha256 の断片）**だけ**。アドレス・氏名・理由は 1 文字も入れない。
 * OperationId は会員・商品・クーポン・操作・anchor から作られるので、
 * **他会員・他商品・別操作は自動的に別の鍵**になる。
 */

import { LOCK_RELEASE_LUA, LOCK_VERIFY_LUA } from '../marketing/automationStore.js';

/** クーポン操作専用の鍵空間（automation / dispatch とは分ける） */
export const COUPON_LOCK_ROOT = 'ak:coupon-op:';

export const couponLockKey = Object.freeze({
  lock: (operationId) => `${COUPON_LOCK_ROOT}lock:${operationId}`,
  fence: () => `${COUPON_LOCK_ROOT}fence`,
});

/**
 * 既定 TTL（秒）。
 * Netlify の同期 Function は最大 26 秒なので、その 10 倍以上を取り、
 * **操作の途中で排他が切れない**側へ倒す。crash した場合は TTL で自然に回復する。
 */
export const COUPON_LOCK_TTL_SEC = 300;

/** lock の結果 */
export const LOCK_RESULT = Object.freeze({
  /** 取れた（この 1 本だけが状態を書いてよい） */
  ACQUIRED: 'acquired',
  /** 別の実行が保持している（**副作用ゼロで断る**） */
  LOST: 'lost',
  /** Redis が使えない / 応答が不明（**書かない**） */
  UNAVAILABLE: 'unavailable',
});

/** `OperationId` として鍵に載せてよい形か（PII 混入と鍵空間の汚染を防ぐ） */
export function isSafeOperationId(operationId) {
  return typeof operationId === 'string' && /^[0-9a-f]{16,64}$/.test(operationId);
}

/**
 * 排他を作る。`redisCmd` は `makeRedisCmd(env)` が返すもの（無ければ null）。
 *
 * @param {{ redisCmd: ((args: string[]) => Promise<any>)|null }} deps
 */
export function createCouponOperationLock({ redisCmd } = {}) {
  const call = async (args) => {
    if (typeof redisCmd !== 'function') return { ok: false, result: null };
    try {
      return { ok: true, result: await redisCmd(args) };
    } catch {
      // 応答が分からない = 取れたとみなさない（fail closed）
      return { ok: false, result: null };
    }
  };

  return {
    available: typeof redisCmd === 'function',

    /**
     * **状態変更より前に**取る。取れた 1 本だけが本体を書いてよい。
     * @returns {Promise<{ status: string, token: string|null }>}
     */
    async acquire({ operationId, ttlSec = COUPON_LOCK_TTL_SEC }) {
      if (!isSafeOperationId(operationId)) return { status: LOCK_RESULT.UNAVAILABLE, token: null };
      const fence = await call(['INCR', couponLockKey.fence()]);
      if (!fence.ok) return { status: LOCK_RESULT.UNAVAILABLE, token: null };
      const token = String(fence.result);
      if (!token || token === 'null') return { status: LOCK_RESULT.UNAVAILABLE, token: null };
      const res = await call([
        'SET', couponLockKey.lock(operationId), token, 'NX', 'EX', String(ttlSec),
      ]);
      if (!res.ok) return { status: LOCK_RESULT.UNAVAILABLE, token: null };
      if (res.result === 'OK') return { status: LOCK_RESULT.ACQUIRED, token };
      // NX に負けた = 別の実行が同じ操作を進めている（正常な競合）
      if (res.result === null) return { status: LOCK_RESULT.LOST, token: null };
      return { status: LOCK_RESULT.UNAVAILABLE, token: null };
    },

    /**
     * **本体を書く直前に必ず通す**。奪われていたら書かない。
     * @returns {Promise<{ ok: boolean, reason: string|null }>}
     */
    async verify({ operationId, token }) {
      if (!token) return { ok: false, reason: 'no_token' };
      const res = await call(['EVAL', LOCK_VERIFY_LUA, '1', couponLockKey.lock(operationId), String(token)]);
      if (!res.ok) return { ok: false, reason: 'unavailable' };
      if (res.result === 'OK') return { ok: true, reason: null };
      return { ok: false, reason: String(res.result || 'unknown').toLowerCase() };
    },

    /**
     * 解放。**token が一致するときだけ消す**（他プロセスの鍵を消さない）。
     * 解放に失敗しても TTL で必ず回復するので、呼び出し側は握りつぶしてよい。
     */
    async release({ operationId, token }) {
      if (!token) return { ok: false, reason: 'no_token' };
      const res = await call(['EVAL', LOCK_RELEASE_LUA, '1', couponLockKey.lock(operationId), String(token)]);
      if (!res.ok) return { ok: false, reason: 'unavailable' };
      return { ok: res.result === 'OK', reason: res.result === 'OK' ? null : String(res.result).toLowerCase() };
    },
  };
}

/**
 * lock を取れなかったときに返す内容（**副作用ゼロ**であることを明示する）。
 */
export const LOCK_REJECT_TEXT = Object.freeze({
  lost: 'この会員に対する同じ操作が、いま別の実行で進行中です。'
    + '二重に実行しないよう受け付けませんでした。数秒おいて画面を再読込し、結果を確認してください。',
  unavailable: '排他制御を確認できないため操作を受け付けませんでした。'
    + '同時実行で二重に書き換わるおそれがあるため、確認できない状態では書き込みません。',
});
