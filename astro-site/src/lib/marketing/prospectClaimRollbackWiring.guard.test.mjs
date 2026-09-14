/**
 * prospectClaimRollbackWiring.guard.test.mjs — **配線**を固定する
 *   node --test src/lib/marketing/prospectClaimRollbackWiring.guard.test.mjs
 *
 * 判定モジュールの単体テストが通っていても、Function が**古い経路**を呼んでいれば
 * 本番では退避なしで剥がれてしまう。ここは呼び出し側の形そのものを検査する。
 *
 * ## 固定する契約
 *
 *   1. 解放は **`stashAndRelease`** を通る（生の `releaseClaims` で剥がさない）
 *   2. **`runId` 必須**（退避 set の名前。無ければどこから戻すか決められない）
 *   3. 復元の入口（`prospectClaimRestore`）が在る
 *   4. 応答に **`DeliveryKey` を載せない**
 *   5. 「再計算で戻せる」という前提に戻していない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url)),
  'utf8',
);
const LIB = readFileSync(
  fileURLToPath(new URL('./deliveryKeyRollback.js', import.meta.url)),
  'utf8',
);

/** 解放ハンドラの本文だけを切り出す */
function releaseHandler() {
  const start = SRC.indexOf('async function handleProspectClaimRelease');
  const end = SRC.indexOf('async function handleProspectClaimRestore');
  assert.ok(start > 0 && end > start, 'ハンドラを切り出せない');
  return SRC.slice(start, end);
}

test('【重要】解放は退避つき経路（stashAndRelease）を通る', () => {
  const body = releaseHandler();
  assert.match(body, /rollbackStore\.stashAndRelease\(/, '退避つき経路を呼んでいない');
  // 生の releaseClaims で剥がす旧経路へ戻していない
  assert.doesNotMatch(body, /ledger\.releaseClaims\(/, '退避なしで剥がす経路に戻っている');
});

test('【重要】runId が無ければ剥がさない（退避 set を指せないため）', () => {
  const body = releaseHandler();
  assert.match(body, /RUN_ID\.test\(runId\)/, 'runId の検証が無い');
  const iCheck = body.indexOf('RUN_ID.test(runId)');
  const iRelease = body.indexOf('rollbackStore.stashAndRelease(');
  assert.ok(iCheck > 0 && iCheck < iRelease, 'runId を検証する前に剥がしている');
});

test('【重要】復元の入口がある（同じ runId で書き戻せる）', () => {
  assert.match(SRC, /action === 'prospectClaimRestore'/, '復元 action が配線されていない');
  assert.match(SRC, /async function handleProspectClaimRestore/);
  assert.match(SRC, /rollbackStore\.restore\(scope\)/, '復元が退避 set から読んでいない');
});

test('【重要】応答に DeliveryKey を載せない', () => {
  const body = releaseHandler();
  /**
   * `plan.keys` が出てよいのは **2 か所だけ**:
   *   - `keys: plan.keys`   … Redis へ渡す（退避と SREM の材料）
   *   - `plan.keys.length`  … 件数
   * それ以外（応答オブジェクトへ入れる等）は鍵の漏洩。
   */
  const uses = [...body.matchAll(/plan\.keys(\.length)?/g)].map((m) => {
    const at = m.index;
    const before = body.slice(Math.max(0, at - 8), at);
    return m[1] ? 'length' : (/keys:\s*$/.test(before) ? 'redis-arg' : `bare(${before.trim()})`);
  });
  for (const u of uses) {
    assert.ok(u === 'length' || u === 'redis-arg', `鍵を応答に入れている疑い: ${u}`);
  }
  assert.ok(uses.includes('redis-arg'), 'Redis へ鍵を渡す呼び出しが見つからない');
  assert.doesNotMatch(body, /\.\.\.plan,/, 'plan をそのまま展開している（keys が漏れる）');
  // 応答に入れてよいのは件数・監査情報だけ
  assert.match(body, /released: result\.released/);
  assert.match(body, /stashed: result\.stashed/);
});

test('【重要】退避モジュールは「順序」と「確認できなければ剥がさない」を持つ', () => {
  // ① SADD → ② SMISMEMBER → ③ SREM の順で現れる
  const iAdd = LIB.indexOf("'SADD', rollbackKey");
  const iChk = LIB.indexOf("'SMISMEMBER', rollbackKey");
  const iRem = LIB.indexOf("'SREM', deliveredKey");
  assert.ok(iAdd > 0 && iChk > iAdd && iRem > iChk, `順序が違う: ${iAdd}/${iChk}/${iRem}`);
  // 確認が揃わなければ throw（= SREM に到達しない）
  assert.match(LIB, /verified !== unique\.length/);
  assert.match(LIB, /stash_incomplete/);
});

test('【重要】復元は退避 set から読む（鍵を作り直さない）', () => {
  assert.match(LIB, /'SSCAN', rollbackKey/, '退避 set を走査していない');
  // 復元経路で鍵を計算していないこと
  const start = LIB.indexOf('async restore(');
  const end = LIB.indexOf('async describe(');
  const body = LIB.slice(start, end);
  assert.doesNotMatch(body, /computeCampaignDeliveryKey|computeDeliveryKey/, '復元で鍵を再計算している');
});

test('監査情報に鍵を混ぜない（件数・digest・TTL・実行 ID だけ）', () => {
  const start = LIB.indexOf('const meta = [');
  const end = LIB.indexOf('const metaKey =');
  const meta = LIB.slice(start, end);
  for (const want of ['runId', 'campaignId', 'version', 'step', 'digest', 'ttlSec', 'targeted', 'released']) {
    assert.ok(meta.includes(`'${want}'`), `監査情報に ${want} が無い`);
  }
  assert.doesNotMatch(meta, /keys|unique\.map|\.join\(/, '監査情報へ鍵を入れている');
});

test('退避 set は配信台帳と別の名前空間', () => {
  assert.match(LIB, /ROLLBACK_NAMESPACE = 'ak:mkt:delivered-rollback:v1'/);
  assert.doesNotMatch(LIB, /ROLLBACK_NAMESPACE = 'ak:mkt:delivered'/);
});
