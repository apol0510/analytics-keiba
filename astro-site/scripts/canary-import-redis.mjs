#!/usr/bin/env node
/**
 * canary-import-redis.mjs — 取り込みジョブ Redis 版の Phase 0 / Phase 1 canary
 *
 * ⚠️ **Airtable へは一切触れない。** Redis のみ。メール送信もしない。
 * ⚠️ 書き込んでよいのは **`customer-import:canary:<canaryId>:*` だけ**。
 *    本番キー（`customer-import:lock:global` / `customer-import:fence` /
 *    `customer-import:email:*` / `customer-import:job:*` / 入金確認メール系）には
 *    **1 バイトも触れない**。そのため本スクリプトは `createClaimStore()` の
 *    `acquireGlobalLock()`（本番キー固定）を**呼ばず**、Lua 本文だけを canary キーで検証する。
 * ⚠️ URL / token / キー内容 / PII は**出力しない**。
 *
 * ── 使い方（secret を transcript に出さないこと）────────────────
 *   1. リポジトリ外に env ファイルを作る（例 ~/.ak-upstash.env）:
 *        UPSTASH_REDIS_REST_URL=...
 *        UPSTASH_REDIS_REST_TOKEN=...
 *   2. node astro-site/scripts/canary-import-redis.mjs ~/.ak-upstash.env
 *
 *   環境変数が既にシェルにあるなら引数なしでも動く。
 *
 * 異常を検知したら**その場で停止**し、cleanup だけ行う。
 */

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  CLAIM_ROWS_LUA, MARK_CREATED_LUA, VERIFY_LOCK_LUA, RELEASE_LOCK_LUA,
  emailClaimKey, emailHash,
} from '../src/lib/crm/importClaimStore.js';
import { canReleaseClaim } from '../src/lib/crm/importJobReconcile.js';

// ── 認証情報（値は絶対に出力しない）────────────────────────────
const envFile = process.argv[2];
if (envFile) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const URL_ = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!URL_ || !TOKEN) {
  console.error('❌ UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN が取得できません。');
  console.error('   引数に env ファイルのパスを渡すか、シェルに export してください（値は出力しません）。');
  process.exit(2);
}

let fail = 0;
const ok = (l, cond, d) => {
  if (!cond) fail += 1;
  console.log(`  ${cond ? '✅' : '❌'} ${l}${d ? ' — ' + d : ''}`);
  return cond;
};
const die = (msg) => { console.error(`\n🛑 即時停止: ${msg}`); throw new Error('halt'); };

async function cmd(args) {
  const t0 = Date.now();
  const res = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`upstash HTTP ${res.status}`);
  const j = await res.json();
  return { result: j.result, ms, status: res.status };
}

// ── canaryId（日時 + ランダム）────────────────────────────────
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const canaryId = `${stamp}-${randomBytes(4).toString('hex')}`;
const P = `customer-import:canary:${canaryId}:`;
/** ⚠️ 本スクリプトが書いてよい唯一の接頭辞。ここを外れたら停止する */
const guardKey = (k) => (String(k).startsWith(P) ? k : die(`canary 接頭辞外のキーに触れようとした: ${String(k).slice(0, 40)}`));

const created = new Set();
const put = async (args) => { guardKey(args[1]); created.add(args[1]); return cmd(args); };

const LOCK = `${P}lock`;
const FENCE = `${P}fence`;

console.log(`# 取り込みジョブ Redis canary`);
console.log(`canaryId: ${canaryId}`);
console.log(`接頭辞: customer-import:canary:${canaryId}:*\n`);

try {
  // ══ Phase 0 — read-only ═══════════════════════════════════════
  console.log('## Phase 0 — read-only');
  const ping = await cmd(['PING']);
  ok(`PING（HTTP ${ping.status} / ${ping.ms}ms）`, ping.result === 'PONG', String(ping.result));

  const size0 = await cmd(['DBSIZE']);
  const dbsizeBefore = Number(size0.result);
  ok(`DBSIZE（${size0.ms}ms）`, Number.isFinite(dbsizeBefore), `既存キー ${dbsizeBefore} 件`);

  const ev = await cmd(['EVAL', 'return 1+1', '0']);
  ok(`EVAL "return 1+1"（${ev.ms}ms）`, Number(ev.result) === 2, String(ev.result));

  const lat = [ping.ms, size0.ms, ev.ms];
  console.log(`  レイテンシ: min ${Math.min(...lat)}ms / max ${Math.max(...lat)}ms / avg ${Math.round(lat.reduce((a, b) => a + b, 0) / lat.length)}ms`);

  // ══ Phase 1 — canary 接頭辞への限定書込み ══════════════════════
  console.log(`\n## Phase 1 — canary 接頭辞への限定書込み`);

  // 事前: 同じ接頭辞のキーが 0 件であること
  const pre = await cmd(['KEYS', `${P}*`]);
  if (!ok('実行前 canary キー 0 件', (pre.result || []).length === 0, `${(pre.result || []).length} 件`)) {
    die('canaryId が衝突している');
  }

  // 1. SET NX の勝者は 1 件だけ
  const w1 = await put(['SET', LOCK, 'tokenA', 'NX', 'EX', '60']);
  const w2 = await cmd(['SET', LOCK, 'tokenB', 'NX', 'EX', '60']);
  if (!ok('1. SET NX の勝者は 1 件だけ', w1.result === 'OK' && w2.result === null,
    `1st=${w1.result} / 2nd=${w2.result}`)) die('SET NX で複数の勝者が出た');

  // 2. fencing token が単調増加（**canary 専用 fence**。本番 fence は触らない）
  const f1 = await put(['INCR', FENCE]);
  const f2 = await cmd(['INCR', FENCE]);
  const f3 = await cmd(['INCR', FENCE]);
  ok('2. fencing token が単調増加', Number(f2.result) > Number(f1.result) && Number(f3.result) > Number(f2.result),
    `${f1.result} < ${f2.result} < ${f3.result}`);

  // 3. CLAIM_ROWS_LUA が OK / MINE / CREATED / TAKEN を返す
  const kA = `${P}email:a`; const kB = `${P}email:b`;
  const claimArgs = (keys, owner, batch, op, fence) => ([
    'EVAL', CLAIM_ROWS_LUA, String(keys.length), ...keys,
    owner, batch, op, String(fence), new Date().toISOString(),
    new Date(Date.now() + 600_000).toISOString(), '600',
  ]);
  keysGuard(kA); keysGuard(kB);
  const c1 = await put(['SET', kA, '__placeholder__', 'NX', 'EX', '1']);   // 予約（すぐ消す）
  await cmd(['DEL', kA]);
  created.add(kA); created.add(kB);

  const r1 = await cmd(claimArgs([kA, kB], 'jobA', 'batch-1', 'op-1', 10));
  ok('3a. 未設定キーは OK', Array.isArray(r1.result) && r1.result[0] === 'OK' && r1.result[1] === 'OK',
    JSON.stringify(r1.result));

  const r2 = await cmd(claimArgs([kA], 'jobA', 'batch-1', 'op-2', 11));
  ok('3b. 自分の CLAIMED は MINE', r2.result[0] === 'MINE', String(r2.result[0]));

  const r3 = await cmd(claimArgs([kA], 'jobB', 'batch-2', 'op-3', 12));
  if (!ok('3c/5. 他 job・他 batchId は TAKEN（奪えない）', r3.result[0] === 'TAKEN', String(r3.result[0]))) {
    die('異なる batchId で同一メールを双方が claim できた');
  }

  await cmd(['EVAL', MARK_CREATED_LUA, '1', kA, 'jobA', new Date().toISOString()]);
  const r4 = await cmd(claimArgs([kA], 'jobB', 'batch-2', 'op-4', 13));
  ok('3d. CREATED は誰も取り直せない', r4.result[0] === 'CREATED', String(r4.result[0]));

  // 4. 正規化: 大文字小文字・前後空白が同一 claim キーへ収束
  const base = emailClaimKey('user@example.invalid');
  const variants = ['USER@EXAMPLE.INVALID', '  user@example.invalid  ', 'User@Example.Invalid',
    'mailto:user@example.invalid', '<user@example.invalid>'];
  ok('4. 大文字小文字・空白・mailto 差が同一キーへ収束',
    variants.every((v) => emailClaimKey(v) === base) && emailHash('A@B.invalid') === emailHash('a@b.invalid'));

  // 6. 期限切れ claim を通常 worker が奪わない
  const kExp = `${P}email:expired`;
  created.add(kExp);
  await cmd(['EVAL', CLAIM_ROWS_LUA, '1', kExp, 'jobA', 'batch-1', 'op-x', '20',
    new Date(Date.now() - 600_000).toISOString(), new Date(Date.now() - 300_000).toISOString(), '600']);
  const rExp = await cmd(claimArgs([kExp], 'jobB', 'batch-2', 'op-y', 21));
  if (!ok('6. 期限切れ（expiresAt 過去）claim を通常 worker が奪わない', rExp.result[0] === 'TAKEN',
    String(rExp.result[0]))) die('期限切れ claim を reconciler 以外が取得できた');

  // 7. VERIFY_LOCK_LUA
  const v1 = await cmd(['EVAL', VERIFY_LOCK_LUA, '1', LOCK, 'tokenA']);
  ok('7a. 正当な所有者は OK', v1.result === 'OK', String(v1.result));
  const v2 = await cmd(['EVAL', VERIFY_LOCK_LUA, '1', LOCK, 'tokenB']);
  if (!ok('7b. 別 token は STOLEN', v2.result === 'STOLEN', String(v2.result))) die('stale lock が有効扱いになった');
  const kGone = `${P}lock-gone`;
  const v3 = await cmd(['EVAL', VERIFY_LOCK_LUA, '1', kGone, 'tokenA']);
  ok('7c. キーが無ければ LOST', v3.result === 'LOST', String(v3.result));

  // 8. 所有権喪失後は write 許可判定が fail-closed
  ok('8. 所有権喪失（STOLEN/LOST）は write 不許可', v2.result !== 'OK' && v3.result !== 'OK');
  const rel = await cmd(['EVAL', RELEASE_LOCK_LUA, '1', LOCK, 'tokenB']);
  ok('8b. 他人の token では解放できない', rel.result === 'STOLEN', String(rel.result));

  // 9. Lua 応答不明を成功扱いにしない（不正 script は例外になること）
  let threw = false;
  try { await cmd(['EVAL', 'this is not lua', '0']); } catch { threw = true; }
  ok('9. 不正な Lua は例外になり成功扱いしない', threw);

  // 10. claim の状態遷移と reconciler 解放条件
  const kRel = `${P}email:release`;
  created.add(kRel);
  await cmd(['EVAL', CLAIM_ROWS_LUA, '1', kRel, 'jobA', 'batch-1', 'op-r', '30',
    new Date(Date.now() - 600_000).toISOString(), new Date(Date.now() - 300_000).toISOString(), '600']);
  const cur = JSON.parse((await cmd(['GET', kRel])).result);
  ok('10a. CLAIMED 状態が保存される', cur.state === 'CLAIMED', cur.state);
  const relNo = canReleaseClaim({ claim: cur, absentInCustomers: false, absentForSource: true, nowMs: Date.now(), currentFencingToken: 999 });
  ok('10b. Customers に存在するなら解放しない', relNo.ok === false, relNo.reason);
  const relNo2 = canReleaseClaim({ claim: cur, absentInCustomers: true, absentForSource: true, nowMs: Date.now(), currentFencingToken: 30 });
  ok('10c. fencing token が現行なら解放しない', relNo2.ok === false, relNo2.reason);
  const relYes = canReleaseClaim({ claim: cur, absentInCustomers: true, absentForSource: true, nowMs: Date.now(), currentFencingToken: 999 });
  ok('10d. 4 条件すべて満たせば解放可', relYes.ok === true);
  await cmd(['EVAL', MARK_CREATED_LUA, '1', kRel, 'jobA', new Date().toISOString()]);
  const cur2 = JSON.parse((await cmd(['GET', kRel])).result);
  ok('10e. CREATED へ遷移する', cur2.state === 'CREATED', cur2.state);

  // 11. 既存キーへの影響が無いこと（canary 分を差し引いて比較）
  const sizeMid = Number((await cmd(['DBSIZE'])).result);
  const canaryNow = (await cmd(['KEYS', `${P}*`])).result || [];
  ok('11. 既存キー件数に変化なし（canary 分を除く）',
    sizeMid - canaryNow.length === dbsizeBefore,
    `DBSIZE ${dbsizeBefore} → ${sizeMid} / canary ${canaryNow.length} 件`);

  // 12. cleanup
  console.log('\n## cleanup');
  const toDelete = (await cmd(['KEYS', `${P}*`])).result || [];
  for (const k of toDelete) { guardKey(k); await cmd(['DEL', k]); }
  const left = (await cmd(['KEYS', `${P}*`])).result || [];
  const sizeAfter = Number((await cmd(['DBSIZE'])).result);
  ok(`12a. canary キー全削除（作成 ${toDelete.length} 件 / 削除 ${toDelete.length - left.length} 件）`, left.length === 0,
    `残存 ${left.length} 件`);
  ok('12b. DBSIZE が実行前へ戻る', sizeAfter === dbsizeBefore, `${dbsizeBefore} → ${sizeAfter}`);
  if (left.length > 0) {
    console.log('  残存キー（値なし・PII なし）:');
    for (const k of left) console.log('   -', k);
  }

  console.log(`\n${fail === 0 ? '✅ Phase 0 / Phase 1 すべて通過' : `❌ 未達 ${fail} 件`}`);
  console.log(JSON.stringify({
    canaryId, dbsizeBefore, dbsizeAfter: sizeAfter,
    canaryKeysCreated: toDelete.length, canaryKeysDeleted: toDelete.length - left.length,
    canaryKeysRemaining: left.length, checksFailed: fail,
  }, null, 1));
  process.exit(fail === 0 ? 0 : 1);
} catch (e) {
  console.error(`\n❌ 中断: ${e.message}`);
  try {
    const left = (await cmd(['KEYS', `${P}*`])).result || [];
    for (const k of left) if (String(k).startsWith(P)) await cmd(['DEL', k]);
    const after = (await cmd(['KEYS', `${P}*`])).result || [];
    console.error(`cleanup: 残存 ${after.length} 件`);
    for (const k of after) console.error(' -', k);
  } catch (e2) {
    console.error('cleanup も失敗しました。残存キーを手動で確認してください（接頭辞のみ）:', P);
  }
  process.exit(1);
}

function keysGuard(k) { return guardKey(k); }
