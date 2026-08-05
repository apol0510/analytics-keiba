/**
 * automationCanaryContracts.js — **canary が検証する対象そのもの**（純粋・I/O なし）
 *
 * ── なぜこのファイルがあるか ──────────────────────────────────
 * メルマガ自動化の Redis primitive（CAS / lock / fencing / key 生成）だけを
 * 実 production Redis で確かめるために、**検証対象の成果物だけ**をここに置く。
 * 管理 UI・管理 API・scheduler・enqueue・Airtable 処理は**本番へ持ち込まない**。
 *
 * ⚠️ 中身は自動化本体（PR #237 の `automationStore.js`）から**改変せずに抜き出したもの**。
 *    **両者は常に同一でなければならない。** 下の `EXPECTED_SHA256` は抽出時点の
 *    PR #237 実装の sha256 で、テストが一致を固定する。
 *    自動化本体を本番へ入れる際は、両ファイルを突き合わせる guard を追加すること。
 *
 * ⚠️ この経路は Airtable・Customers・メール送信に一切依存しない（import が存在しない）。
 */

import { createHash } from 'node:crypto';

/** 自動化本体と同じ名前空間（canary はこの配下の `canary:` だけを使う） */
export const AUTO_ROOT = 'ak:marketing-automation:';

export const autoKey = Object.freeze({
  def: (automationId) => `${AUTO_ROOT}def:${automationId}`,
  run: (runId) => `${AUTO_ROOT}run:${runId}`,
  lock: (automationId) => `${AUTO_ROOT}lock:${automationId}`,
  recipient: (runId, emailHash) => `${AUTO_ROOT}recipient:${runId}:${emailHash}`,
  activeIndex: () => `${AUTO_ROOT}index:active`,
  fence: () => `${AUTO_ROOT}fence`,
});

/** 正規化メール → sha256（**復元不能**。これ以外を鍵に使わない） */
export function emailHash(email) {
  const e = String(email ?? '').trim().toLowerCase();
  return e ? createHash('sha256').update(e, 'utf8').digest('hex') : '';
}

/** 自分の値のときだけ書き換える CAS（Lua）。**PR #237 と同一** */
export const CAS_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then
  if ARGV[2] == '' then redis.call('SET', KEYS[1], ARGV[1]) return 'OK' end
  return 'MISSING'
end
local v = string.match(cur, '"configVersion":(%d+)')
if v ~= ARGV[2] then return 'CONFLICT' end
redis.call('SET', KEYS[1], ARGV[1])
return 'OK'
`;

/** 自分の token のときだけ解放する。**PR #237 と同一** */
export const RELEASE_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 'LOST' end
if cur ~= ARGV[1] then return 'STOLEN' end
redis.call('DEL', KEYS[1])
return 'OK'
`;

/** 所有権の再検証。**PR #237 と同一** */
export const VERIFY_LUA = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 'LOST' end
if cur ~= ARGV[1] then return 'STOLEN' end
return 'OK'
`;

/**
 * 抽出時点の PR #237 実装の sha256。
 * テストがこれと一致することを固定し、**取り違えた Lua を本番で走らせない**。
 */
export const EXPECTED_SHA256 = Object.freeze({
  CAS_LUA: 'e07dc3cf2b1e7c14541b3a6173179d06f88cdd691b191114a365abdd6383cf27',
  RELEASE_LUA: '6ac73ff085507be2c7e005c103d2ba88764cd3d60b10710186740ef7e09a89c4',
  VERIFY_LUA: '544780330fbc6e2044bf200ca2dbcfa633b63ce36ec74b48d416c36ad54fdfb1',
});

export function luaSha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}
