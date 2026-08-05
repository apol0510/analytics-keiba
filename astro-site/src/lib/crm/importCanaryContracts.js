/**
 * importCanaryContracts.js — **canary が検証する対象そのもの**（純粋・I/O なし）
 *
 * ── なぜこのファイルがあるか ──────────────────────────────────
 * Redis canary は「取り込みジョブ本体を本番へ入れずに」Lua と判定ロジックだけを
 * 実 Redis で検証するために存在する。そこで **検証対象の成果物だけ**をここに置き、
 * 取り込みジョブ本体（親ジョブ・排他・正本・管理画面）は**本番へ持ち込まない**。
 *
 * ⚠️ 中身は取り込みジョブ側の実装（PR #235 の `importClaimStore.js` /
 *    `importJobReconcile.js`）から**改変せずに抜き出したもの**。
 *    **両者は常に同一でなければならない。**
 *    取り込みジョブ側を本番へ入れる際に、同一性を検証する guard を追加すること。
 *
 * ⚠️ この経路は Airtable・Customers・メール送信に一切依存しない（import が存在しない）。
 */

import { createHash } from 'node:crypto';
import { normalizeEmail } from './customerImport.js';

/** 取り込みジョブ側と同じ数値化ヘルパ（`importJobReconcile.js` と同一） */
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

export const EMAIL_CLAIM_PREFIX = 'customer-import:email:';

export const CLAIM_STATE = Object.freeze({
  CLAIMED: 'CLAIMED',                   // 確保した。まだ Airtable へ作っていない
  CREATED: 'CREATED',                   // Airtable で作成済みを確認した
  RELEASE_PENDING: 'RELEASE_PENDING',   // reconciler が解放候補と判定した
});

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

export const VERIFY_LOCK_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 'LOST' end
if cur ~= ARGV[1] then return 'STOLEN' end
return 'OK'
`;

export const RENEW_LOCK_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 'LOST' end
if cur ~= ARGV[1] then return 'STOLEN' end
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
return 'OK'
`;

export const RELEASE_LOCK_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 'LOST' end
if cur ~= ARGV[1] then return 'STOLEN' end
redis.call('DEL', KEYS[1])
return 'OK'
`;

/**
 * reconciler が claim を解放してよいか。**4 条件すべて**を満たすときだけ true。
 *
 * @param {{
 *   claim: object,                     Redis の claim
 *   absentInCustomers: boolean,        同じ正規化メールが Customers に無い
 *   absentForSource: boolean,          同じ Source の行として作られていない
 *   nowMs: number,
 *   currentFencingToken: string|number,
 * }} input
 */
export function canReleaseClaim({
  claim, absentInCustomers, absentForSource, nowMs, currentFencingToken,
} = {}) {
  const no = (reason) => ({ ok: false, reason });
  if (!claim) return no('no_claim');
  if (claim.state === 'CREATED') return no('already_created');
  // 1) Customers に同じメールが無いこと
  if (absentInCustomers !== true) return no('present_in_customers');
  // 2) 同じ Source の行として作られていないこと
  if (absentForSource !== true) return no('present_for_source');
  // 3) claim が期限切れであること
  const exp = Date.parse(claim.expiresAt);
  if (!Number.isFinite(exp)) return no('bad_expiry');
  if (exp > int(nowMs)) return no('not_expired');
  // 4) 旧 fencing token が失効していること（現在の token より古い）
  if (Number(claim.fencingToken) >= Number(currentFencingToken)) return no('fencing_token_still_current');
  return { ok: true, reason: null };
}
