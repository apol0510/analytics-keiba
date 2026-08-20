/**
 * dispatchLock.js — 実送信の**同一ジョブ二重起動**を原子的に止める（Redis）
 *
 * ── 何が壊れていたか（2026-08-15 の設計監査）────────────────────
 * `marketing-campaign-dispatch` の live 実行は
 *
 *   ① CampaignDeliveries を読む → ② `alreadySent` を作る
 *   → ③ SendGrid へ送る → ④ `sent` を Airtable へ記録
 *
 * の順で進む。①〜④ の間に**同じ jobId の live がもう 1 本走る**と、
 * 両方が「まだ誰も送っていない」状態を読み、両方が `expectedWillSend` を通り、
 * **同じ受信者へ 2 通**送れてしまう（二重クリック / HTTP retry /
 * Function の並行起動）。「逐次再実行には冪等」だけでは塞げない。
 *
 * ── なぜ Redis か ────────────────────────────────────────────
 * - **新しい外部サービスも新しい本番 env も増やさない。**
 *   既に本番で動いている `UPSTASH_REDIS_REST_*` と、
 *   `automationStore.js` の `SET NX EX` + fencing token + Lua をそのまま使う
 * - Netlify Blobs は**正本にしない**（read-after-write が eventual で、
 *   排他の判定には使えない。2026-07-16 に実測済み）
 * - Airtable の `PENDING → PROCESSING` 更新は CAS ではない
 *   （読んで書くまでの間に別実行が同じ遷移を書ける）
 *
 * ── TTL 切れの安全性 ──────────────────────────────────────────
 * TTL は **Function の最大実行時間より十分長く**取る（既定 300 秒 >> 26 秒）。
 * したがって「送信中に TTL が切れて別実行が入る」ことは構造的に起きない。
 * それでも、送信の直前に必ず `verify()` を通し、**奪われていたら送らない**。
 *
 * ⚠️ 鍵に入れてよいのは jobId だけ。**アドレス・secret は 1 文字も入れない**
 *    （jobId は `mkt-<campaign>-v<n>-<fingerprint>-<index>` で PII を含まない）。
 */

import { LOCK_VERIFY_LUA, LOCK_RELEASE_LUA } from './automationStore.js';

/**
 * **token が一致するときだけ**期限を延ばす（atomic）。
 * `GET` → `EXPIRE` の 2 段では、その隙に切れて別実行が取った鍵を延命しうる。
 */
const RENEW_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 'LOST' end
if cur ~= ARGV[1] then return 'STOLEN' end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 'OK'
`;

/** dispatch 専用の鍵空間（automation とは分ける） */
export const DISPATCH_LOCK_ROOT = 'ak:marketing-dispatch:';

export const dispatchKey = Object.freeze({
  lock: (jobId) => `${DISPATCH_LOCK_ROOT}lock:${jobId}`,
  fence: () => `${DISPATCH_LOCK_ROOT}fence`,
});

/**
 * **キュー登録**用の鍵空間（送信の鍵と混ぜない）。
 *
 * ⚠️ 同じ相手・同じ本文なら `JobId` は plan fingerprint 由来で同じになる。
 *    2 本の実行が同時に積むと、同じ JobId の行が 2 つできる（2026-08-20 に本番で発生）。
 *    書く前にここで排他を取る。
 */
export const QUEUE_LOCK_ROOT = 'ak:marketing-queue:';

/**
 * **cron tick** 用の鍵空間。
 *
 * ⚠️ 2 分間隔のはずの tick が、実測で 1 スロットにつき 3 回走っていた（2026-08-19/20）。
 *    重なった実行は同じ事実を読んで同じ処置をしようとするので、
 *    tick 全体を 1 本に絞る。
 */
export const TICK_LOCK_ROOT = 'ak:marketing-tick:';

/**
 * 同期 Function 用の既定 TTL（秒）。
 * Netlify の上限は 26 秒。**その 10 倍以上**を取り、送信中に期限切れが起きない側へ倒す。
 */
export const DISPATCH_LOCK_TTL_SEC = 300;

/**
 * Background Function 用の TTL（秒）。
 *
 * ⚠️ **同期用の 300 秒を流用してはいけない。** Background は最大 15 分動き、
 *    既定予算は 8 分。300 秒（5 分）だと**送信の途中で排他が切れ**、
 *    別の実行が同じジョブを取得して二重送信できてしまう。
 *
 * 内訳（`assertBackgroundTtlCovers()` がテストで固定する）:
 *   予算 8 分 + 1 チャンク（最大 1 分）+ 後片付け・解放の余白
 * さらに **チャンクごとに `renew()`** して、実行が長引いても切れないようにする。
 */
export const DISPATCH_LOCK_BACKGROUND_TTL_SEC = 20 * 60;

/**
 * TTL が「予算 + 1 チャンク + 後片付け」を覆っているかを確かめる。
 * 覆っていなければ**送信中に排他が切れる**ので、呼び出し側は起動しない。
 */
export function assertBackgroundTtlCovers({ ttlSec, budgetMs, chunkMs, cleanupMs = 30_000 }) {
  const need = Number(budgetMs) + Number(chunkMs) + Number(cleanupMs);
  const have = Number(ttlSec) * 1000;
  return { ok: have >= need, needMs: need, haveMs: have };
}

export const LOCK_FAIL = Object.freeze({
  /** 他の実行が持っている（正常な衝突） */
  BUSY: 'busy',
  /** Redis へ届かない / 応答が読めない = **状態不明**。送ってはいけない */
  UNAVAILABLE: 'unavailable',
  /** 途中で奪われた / 消えた */
  LOST: 'lost',
  STOLEN: 'stolen',
  /** jobId の形が不正 */
  BAD_JOB_ID: 'bad_job_id',
});

export class DispatchLockError extends Error {
  constructor(code, detail) {
    super(`dispatch_lock:${code}`);
    this.name = 'DispatchLockError';
    this.code = code;
    this.detail = detail || null;
  }
}

/** 鍵へ入れてよい jobId の形（PII を含まない識別子だけ） */
export function isSafeJobId(jobId) {
  return typeof jobId === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(jobId);
}

/**
 * @param {{cmd: (args: string[]) => Promise<any>}} deps
 *   `cmd` は `makeRedisCmd(process.env)`（Upstash REST）を想定。
 */
export function createDispatchLock(deps = {}) {
  const cmd = deps.cmd;
  if (typeof cmd !== 'function') throw new Error('createDispatchLock: cmd が必要です');
  /**
   * 鍵空間。既定は送信用（従来どおり）。キュー登録・tick は別空間を渡す。
   * ⚠️ **用途ごとに分ける**。同じ空間を使うと、送信中の鍵をキュー登録が奪える。
   */
  const root = String(deps.root || DISPATCH_LOCK_ROOT);
  /** 鍵名は root から作る（`dispatchKey` は送信用の既定 root 固定なので使わない） */
  const keyOf = Object.freeze({
    lock: (jobId) => `${root}lock:${jobId}`,
    fence: () => `${root}fence`,
  });

  /** 自分の鍵空間の外は触らない（他用途の鍵を消さない） */
  const assertKey = (key) => {
    const k = String(key ?? '');
    if (!k.startsWith(root)) {
      throw new DispatchLockError(LOCK_FAIL.UNAVAILABLE, 'out_of_namespace');
    }
    return k;
  };

  const call = async (args, code) => {
    const op = String(args[0] || '').toUpperCase();
    if (['GET', 'SET', 'DEL', 'INCR', 'EXPIRE'].includes(op)) assertKey(args[1]);
    if (op === 'EVAL') {
      const n = Number(args[2]);
      for (const k of args.slice(3, 3 + (Number.isFinite(n) ? n : 0))) assertKey(k);
    }
    let res;
    try {
      res = await cmd(args);
    } catch (e) {
      // ⚠️ 例外の中身（URL・token を含みうる）は載せない
      throw new DispatchLockError(code || LOCK_FAIL.UNAVAILABLE, op);
    }
    if (res === undefined) throw new DispatchLockError(LOCK_FAIL.UNAVAILABLE, op);
    return res;
  };

  return {
    assertKey,

    /**
     * この jobId の live 実行を 1 本だけ通す。
     * @returns {{ok:true, token:string} | {ok:false, reason:'busy'}}
     * @throws {DispatchLockError} 状態が読めないとき（**送ってはいけない**）
     */
    async acquire({ jobId, ttlSec }) {
      if (!isSafeJobId(jobId)) throw new DispatchLockError(LOCK_FAIL.BAD_JOB_ID);
      const n = await call(['INCR', keyOf.fence()]);
      const token = String(n);
      if (!/^[1-9][0-9]*$/.test(token)) throw new DispatchLockError(LOCK_FAIL.UNAVAILABLE, 'fence');
      const res = await call([
        'SET', keyOf.lock(jobId), token, 'NX', 'EX',
        String(Number.isFinite(ttlSec) && ttlSec > 0 ? Math.floor(ttlSec) : DISPATCH_LOCK_TTL_SEC),
      ]);
      if (res === 'OK') return { ok: true, token };
      // Upstash は取得できなかったとき null を返す
      if (res === null) return { ok: false, reason: LOCK_FAIL.BUSY };
      throw new DispatchLockError(LOCK_FAIL.UNAVAILABLE, 'set');
    },

    /**
     * **送信の直前に必ず通す。** 失っていたら 1 通も送らない。
     * @returns {{ok:true} | {ok:false, reason:'lost'|'stolen'}}
     */
    async verify({ jobId, token }) {
      if (!isSafeJobId(jobId)) throw new DispatchLockError(LOCK_FAIL.BAD_JOB_ID);
      const res = await call(['EVAL', LOCK_VERIFY_LUA, '1', keyOf.lock(jobId), String(token)]);
      if (res === 'OK') return { ok: true, reason: null };
      if (res === 'LOST') return { ok: false, reason: LOCK_FAIL.LOST };
      if (res === 'STOLEN') return { ok: false, reason: LOCK_FAIL.STOLEN };
      throw new DispatchLockError(LOCK_FAIL.UNAVAILABLE, 'verify');
    },

    /**
     * **自分の token のときだけ**期限を延ばす（atomic）。
     *
     * Background は 1 チャンクごとにこれを呼ぶ。`GET` してから `EXPIRE` の 2 段だと、
     * その隙に TTL 切れ→別実行が取得、という状態を延命してしまう。
     * 失っていたら `{ok:false}` を返し、**呼び出し側は即停止する**。
     */
    async renew({ jobId, token, ttlSec }) {
      if (!isSafeJobId(jobId)) throw new DispatchLockError(LOCK_FAIL.BAD_JOB_ID);
      const ttl = Number.isFinite(ttlSec) && ttlSec > 0
        ? Math.floor(ttlSec) : DISPATCH_LOCK_BACKGROUND_TTL_SEC;
      const res = await call([
        'EVAL', RENEW_LUA, '1', keyOf.lock(jobId), String(token), String(ttl),
      ]);
      if (res === 'OK') return { ok: true, reason: null };
      if (res === 'LOST') return { ok: false, reason: LOCK_FAIL.LOST };
      if (res === 'STOLEN') return { ok: false, reason: LOCK_FAIL.STOLEN };
      throw new DispatchLockError(LOCK_FAIL.UNAVAILABLE, 'renew');
    },

    /**
     * 自分の token のときだけ解放する（他実行の lock を消さない）。
     * ⚠️ **解放できなくても「成功」にしない。** 呼び出し側は結果を記録する
     *    （TTL で自然に開くので、握り潰すより「不明」と言う方が安全）。
     */
    async release({ jobId, token }) {
      if (!isSafeJobId(jobId)) return { ok: false, reason: LOCK_FAIL.BAD_JOB_ID };
      try {
        const res = await call(['EVAL', LOCK_RELEASE_LUA, '1', keyOf.lock(jobId), String(token)]);
        if (res === 'OK') return { ok: true, reason: null };
        return { ok: false, reason: String(res).toLowerCase() };
      } catch (e) {
        return { ok: false, reason: (e && e.code) || LOCK_FAIL.UNAVAILABLE };
      }
    },
  };
}

export default createDispatchLock;
