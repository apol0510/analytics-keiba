/**
 * importClaimStore.js — 取り込みの**排他と行 claim**（Redis / I/O は注入）
 *
 * ── ここが二重作成を閉じる本体 ────────────────────────────────
 * Customers の実在判定は **第二防御**であって、同時実行排他の代替ではない。
 * 2 つの実行が同時に「まだ無い」と読めば両方が作成しうる（TOCTOU）ため、
 * **作成の前に Redis で atomic に claim を取る**。claim に勝てるのは 1 つだけ。
 *
 * ── claim は batchId ではなく「正規化メール」に対してグローバルに張る ──
 * `importrow:<batchId>:<hash>` のように batchId で区切ると、**別の batchId が
 * 同じメールを同時に claim できてしまう**。したがってキーは
 * `customer-import:email:<sha256(normalizedEmail)>` の **1 本**にする。
 *
 * ── Redis 異常時は fail-closed ────────────────────────────────
 * 到達不能 / Lua 結果不明 / lock 状態不明 / claim 不整合 / データ欠損の疑い —
 * いずれも **新規 Airtable 書き込みを全面停止**する。`RedisUnavailableError` を投げ、
 * 呼び出し側は握りつぶさずに停止すること。
 */

import { createHash } from 'node:crypto';
import { normalizeEmail } from './customerImport.js';

/** AK 全体で同時に走れる write ジョブを 1 つに限定するグローバルロック */
export const GLOBAL_LOCK_KEY = 'customer-import:lock:global';
/** fencing token の採番元（単調増加） */
export const FENCE_KEY = 'customer-import:fence';
/** 行 claim のキー接頭辞（**batchId を含めない**） */
export const EMAIL_CLAIM_PREFIX = 'customer-import:email:';

/** 行 claim の状態 */
export const CLAIM_STATE = Object.freeze({
  CLAIMED: 'CLAIMED',                   // 確保した。まだ Airtable へ作っていない
  CREATED: 'CREATED',                   // Airtable で作成済みを確認した
  RELEASE_PENDING: 'RELEASE_PENDING',   // reconciler が解放候補と判定した
});

/** グローバルロックの既定 TTL（子バッチ 1 つ + 余裕） */
export const LOCK_TTL_MS = 120 * 1000;
/** 行 claim の既定 TTL。**期限切れでも自動解放しない**（reconciler だけが解放する） */
export const CLAIM_TTL_MS = 30 * 60 * 1000;

/** Redis が信用できない状態。**握りつぶさずに停止する** */
export class RedisUnavailableError extends Error {
  constructor(code, detail) {
    super(`redis_unavailable:${code}`);
    this.name = 'RedisUnavailableError';
    this.code = code;
    this.detail = detail || null;
  }
}

export const REDIS_FAIL = Object.freeze({
  UNREACHABLE: 'unreachable',                 // 到達できない
  UNKNOWN_RESULT: 'unknown_result',           // Lua / コマンドの結果が解釈できない
  LOCK_STATE_UNKNOWN: 'lock_state_unknown',   // ロック状態を確認できない
  JOB_UNREADABLE: 'job_unreadable',           // ジョブ正本が読めない
  CLAIM_INCONSISTENT: 'claim_inconsistent',   // claim の整合性が崩れている
  DATA_LOSS_SUSPECTED: 'data_loss_suspected', // データ欠損が疑われる
});

const str = (v) => String(v ?? '').trim();

/** 正規化メール → claim キー（**PII を保存しない**。sha256 のみ） */
export function emailClaimKey(rawEmail) {
  const e = normalizeEmail(rawEmail);
  if (!e) return '';
  return EMAIL_CLAIM_PREFIX + createHash('sha256').update(e, 'utf8').digest('hex');
}

/** メールの sha256（snapshot・突合用。復元不能） */
export function emailHash(rawEmail) {
  const e = normalizeEmail(rawEmail);
  if (!e) return '';
  return createHash('sha256').update(e, 'utf8').digest('hex');
}

/**
 * 行 claim を **atomic** に取る Lua。
 *
 * KEYS  = claim キー（最大 100 本）
 * ARGV  = [ownerJobId, batchId, operationId, fencingToken, nowIso, expiresAtIso, ttlSec]
 *
 * 各キーについて:
 *   - 未設定           → 自分のものとして CLAIMED で確保し "OK"
 *   - 自分の job が CLAIMED で保持 → "MINE"（再送・再開で同じ子バッチを流した場合）
 *   - CREATED          → "CREATED"（すでに作成済み。作り直さない）
 *   - 他者が保持       → "TAKEN"（**別 batchId でも奪わない**）
 *
 * ⚠️ **期限切れでも奪わない。** 期限切れ claim の回収は reconciler だけが行う
 *    （claim 済み・未作成の行を安易に解放すると二重作成になりうるため）。
 */
export const CLAIM_ROWS_LUA = `
local owner = ARGV[1]
local batch = ARGV[2]
local op = ARGV[3]
local fence = ARGV[4]
local now = ARGV[5]
local expires = ARGV[6]
local ttl = tonumber(ARGV[7])
local out = {}
for i, key in ipairs(KEYS) do
  local cur = redis.call('GET', key)
  if not cur then
    local v = string.format(
      '{"ownerJobId":"%s","batchId":"%s","operationId":"%s","fencingToken":"%s","state":"CLAIMED","claimedAt":"%s","expiresAt":"%s"}',
      owner, batch, op, fence, now, expires)
    redis.call('SET', key, v, 'EX', ttl)
    out[i] = 'OK'
  else
    local st = string.match(cur, '"state":"([A-Z_]+)"')
    local ow = string.match(cur, '"ownerJobId":"([^"]*)"')
    if st == 'CREATED' then
      out[i] = 'CREATED'
    elseif ow == owner and st == 'CLAIMED' then
      out[i] = 'MINE'
    else
      out[i] = 'TAKEN'
    end
  end
end
return out
`;

/** 作成できた行を CREATED へ進める Lua（**自分の claim のときだけ**） */
export const MARK_CREATED_LUA = `
local owner = ARGV[1]
local now = ARGV[2]
local out = {}
for i, key in ipairs(KEYS) do
  local cur = redis.call('GET', key)
  if not cur then
    out[i] = 'MISSING'
  else
    local ow = string.match(cur, '"ownerJobId":"([^"]*)"')
    if ow ~= owner then
      out[i] = 'NOT_MINE'
    else
      local v = string.gsub(cur, '"state":"[A-Z_]+"', '"state":"CREATED"')
      v = string.gsub(v, '"createdAt":"[^"]*"', '')
      redis.call('SET', key, v)
      out[i] = 'OK'
    end
  end
end
return out
`;

/**
 * ロック所有権 + fencing token の**再検証**。
 * 書き込み直前に必ず通し、失っていたら Airtable create を行わない。
 */
export const VERIFY_LOCK_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 'LOST' end
if cur ~= ARGV[1] then return 'STOLEN' end
return 'OK'
`;

/** 自分の token のときだけ TTL を伸ばす */
export const RENEW_LOCK_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 'LOST' end
if cur ~= ARGV[1] then return 'STOLEN' end
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
return 'OK'
`;

/** 自分の token のときだけ解放する */
export const RELEASE_LOCK_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 'LOST' end
if cur ~= ARGV[1] then return 'STOLEN' end
redis.call('DEL', KEYS[1])
return 'OK'
`;

/**
 * @param {{ cmd: (args: string[]) => Promise<any> }} deps
 *   `cmd` は Upstash REST の 1 コマンド実行。失敗時は throw すること。
 */
export function createClaimStore(deps = {}) {
  const cmd = deps.cmd;
  if (typeof cmd !== 'function') throw new Error('importClaimStore: cmd が渡されていません');

  /** Redis 呼び出しを fail-closed で包む。**例外を握りつぶさない** */
  const call = async (args, failCode) => {
    let res;
    try {
      res = await cmd(args);
    } catch (e) {
      throw new RedisUnavailableError(failCode || REDIS_FAIL.UNREACHABLE, e && e.message);
    }
    if (res === undefined) throw new RedisUnavailableError(REDIS_FAIL.UNKNOWN_RESULT, args[0]);
    return res;
  };

  return {
    /** fencing token を採番する（単調増加。stale writer の判別に使う） */
    async nextFencingToken() {
      const n = await call(['INCR', FENCE_KEY], REDIS_FAIL.UNREACHABLE);
      const v = Number(n);
      if (!Number.isFinite(v) || v <= 0) throw new RedisUnavailableError(REDIS_FAIL.UNKNOWN_RESULT, 'fence');
      return String(v);
    },

    /**
     * AK 全体のグローバルロックを取る。**取れなければ Airtable を一切読まない・書かない。**
     * job 単位ではなくグローバルなので、**異なる batchId 同士の競合も拒否**する。
     */
    async acquireGlobalLock({ ttlMs } = {}) {
      const token = await this.nextFencingToken();
      const ttlSec = Math.max(1, Math.ceil((ttlMs || LOCK_TTL_MS) / 1000));
      const res = await call(['SET', GLOBAL_LOCK_KEY, token, 'NX', 'EX', String(ttlSec)], REDIS_FAIL.LOCK_STATE_UNKNOWN);
      if (res === 'OK') return { ok: true, token };
      // NX に負けた = 他の実行が保持している（正常な fail-closed）
      if (res === null) return { ok: false, token: null, reason: 'locked' };
      throw new RedisUnavailableError(REDIS_FAIL.LOCK_STATE_UNKNOWN, String(res));
    },

    /** 書き込み直前の再検証。OK 以外なら **create してはいけない** */
    async verifyLockOwnership(token) {
      const res = await call(['EVAL', VERIFY_LOCK_LUA, '1', GLOBAL_LOCK_KEY, str(token)], REDIS_FAIL.LOCK_STATE_UNKNOWN);
      if (res === 'OK') return { ok: true, reason: null };
      if (res === 'LOST' || res === 'STOLEN') return { ok: false, reason: String(res).toLowerCase() };
      throw new RedisUnavailableError(REDIS_FAIL.LOCK_STATE_UNKNOWN, String(res));
    },

    /** lease 更新。**失敗したら次の子バッチへ進まない** */
    async renewLease(token, ttlMs) {
      const ms = String(Math.max(1000, ttlMs || LOCK_TTL_MS));
      const res = await call(['EVAL', RENEW_LOCK_LUA, '1', GLOBAL_LOCK_KEY, str(token), ms], REDIS_FAIL.LOCK_STATE_UNKNOWN);
      if (res === 'OK') return { ok: true, reason: null };
      if (res === 'LOST' || res === 'STOLEN') return { ok: false, reason: String(res).toLowerCase() };
      throw new RedisUnavailableError(REDIS_FAIL.LOCK_STATE_UNKNOWN, String(res));
    },

    async releaseGlobalLock(token) {
      const res = await call(['EVAL', RELEASE_LOCK_LUA, '1', GLOBAL_LOCK_KEY, str(token)], REDIS_FAIL.LOCK_STATE_UNKNOWN);
      return { ok: res === 'OK', reason: res === 'OK' ? null : String(res).toLowerCase() };
    },

    /**
     * 行 claim を atomic に取る。**別 batchId が同じメールを持っていれば TAKEN**。
     * @returns {{ won: string[], created: string[], taken: string[], mine: string[] }} 正規化メール単位
     */
    async claimRows({ emails, ownerJobId, batchId, operationId, fencingToken, nowIso, ttlMs }) {
      const list = (emails || []).map((e) => normalizeEmail(e)).filter(Boolean);
      if (list.length === 0) return { won: [], created: [], taken: [], mine: [] };
      const keys = list.map((e) => emailClaimKey(e));
      const ttlSec = Math.max(60, Math.ceil((ttlMs || CLAIM_TTL_MS) / 1000));
      const expiresAt = new Date(Date.parse(nowIso) + (ttlMs || CLAIM_TTL_MS)).toISOString();

      const res = await call([
        'EVAL', CLAIM_ROWS_LUA, String(keys.length), ...keys,
        str(ownerJobId), str(batchId), str(operationId), str(fencingToken),
        str(nowIso), expiresAt, String(ttlSec),
      ], REDIS_FAIL.UNKNOWN_RESULT);

      if (!Array.isArray(res) || res.length !== list.length) {
        // 結果が解釈できない = 何を確保したか不明 → **fail closed**
        throw new RedisUnavailableError(REDIS_FAIL.UNKNOWN_RESULT, 'claimRows');
      }
      const out = { won: [], created: [], taken: [], mine: [] };
      res.forEach((r, i) => {
        const email = list[i];
        if (r === 'OK') out.won.push(email);
        else if (r === 'CREATED') out.created.push(email);
        else if (r === 'MINE') out.mine.push(email);
        else if (r === 'TAKEN') out.taken.push(email);
        else throw new RedisUnavailableError(REDIS_FAIL.UNKNOWN_RESULT, String(r));
      });
      return out;
    },

    /** Airtable で作成できた行を CREATED へ進める */
    async markRowsCreated({ emails, ownerJobId, nowIso }) {
      const list = (emails || []).map((e) => normalizeEmail(e)).filter(Boolean);
      if (list.length === 0) return { ok: [], notMine: [], missing: [] };
      const keys = list.map((e) => emailClaimKey(e));
      const res = await call(['EVAL', MARK_CREATED_LUA, String(keys.length), ...keys, str(ownerJobId), str(nowIso)],
        REDIS_FAIL.UNKNOWN_RESULT);
      if (!Array.isArray(res) || res.length !== list.length) {
        throw new RedisUnavailableError(REDIS_FAIL.UNKNOWN_RESULT, 'markRowsCreated');
      }
      const out = { ok: [], notMine: [], missing: [] };
      res.forEach((r, i) => {
        if (r === 'OK') out.ok.push(list[i]);
        else if (r === 'NOT_MINE') out.notMine.push(list[i]);
        else if (r === 'MISSING') out.missing.push(list[i]);
        else throw new RedisUnavailableError(REDIS_FAIL.UNKNOWN_RESULT, String(r));
      });
      return out;
    },

    /** claim を 1 件読む（reconciler / 突合用） */
    async readClaim(rawEmail) {
      const key = emailClaimKey(rawEmail);
      if (!key) return null;
      const v = await call(['GET', key], REDIS_FAIL.CLAIM_INCONSISTENT);
      if (v === null) return null;
      try { return JSON.parse(v); } catch { throw new RedisUnavailableError(REDIS_FAIL.CLAIM_INCONSISTENT, 'parse'); }
    },

    /**
     * **reconciler だけが呼ぶ** claim の解放。
     *
     * ⚠️ 呼び出し側は次を**すべて**確認してから渡すこと（本関数は最終ガードのみ）:
     *   1. Customers に同じ正規化メールが存在しないこと
     *   2. Customers に同じ Source の行が無いこと（その行として作られていないこと）
     *   3. claim が期限切れであること
     *   4. claim の fencingToken が現在のロック token より古い（＝失効している）こと
     */
    async releaseClaimByReconciler({ rawEmail, expectedOwnerJobId, currentFencingToken, nowMs, checks }) {
      const c = checks || {};
      if (c.absentInCustomers !== true) return { released: false, reason: 'customers_present_or_unchecked' };
      if (c.absentForSource !== true) return { released: false, reason: 'source_present_or_unchecked' };
      const claim = await this.readClaim(rawEmail);
      if (!claim) return { released: false, reason: 'no_claim' };
      if (claim.state === CLAIM_STATE.CREATED) return { released: false, reason: 'already_created' };
      if (expectedOwnerJobId && claim.ownerJobId !== expectedOwnerJobId) {
        return { released: false, reason: 'owner_mismatch' };
      }
      const exp = Date.parse(claim.expiresAt);
      if (!Number.isFinite(exp) || exp > (nowMs || 0)) return { released: false, reason: 'not_expired' };
      // 旧 fencing token が失効していること（現在の token より小さい）
      if (Number(claim.fencingToken) >= Number(currentFencingToken)) {
        return { released: false, reason: 'fencing_token_still_current' };
      }
      await call(['DEL', emailClaimKey(rawEmail)], REDIS_FAIL.CLAIM_INCONSISTENT);
      return { released: true, reason: null };
    },
  };
}

export default createClaimStore;
