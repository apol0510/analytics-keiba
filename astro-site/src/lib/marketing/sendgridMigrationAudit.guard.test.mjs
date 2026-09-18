/**
 * sendgridMigrationAudit.guard.test.mjs — 突合スクリプトが**読むだけ**であることを固定する
 *
 * このスクリプトは本番の Redis / Airtable / SendGrid を**手元から**読む。
 * 書き込みが 1 つでも混ざれば本番事故になるので、
 *   - Redis は読み取りコマンドだけ
 *   - Airtable / SendGrid は GET だけ
 *   - 出力にアドレスを含めない（含んだら中止する）
 *   - 資格情報が無ければ**何もせず終了**
 * を **source と実行の両方**で固定する。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SCRIPT = fileURLToPath(new URL('../../../scripts/sendgrid-migration-audit.mjs', import.meta.url));
const src = readFileSync(SCRIPT, 'utf8');

test('Redis は読み取りコマンドしか許さない', () => {
  const m = src.match(/READ_ONLY_REDIS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, '許可リストが見つからない');
  const allowed = m[1].split(',').map((s) => s.replace(/['"\s]/g, '')).filter(Boolean);
  assert.deepEqual(
    [...allowed].sort(),
    ['GET', 'MGET', 'SCARD', 'SISMEMBER', 'SMEMBERS', 'SMISMEMBER'].sort(),
  );
  // 書き込み系が許可リストへ紛れていない
  for (const w of ['SET', 'SADD', 'SREM', 'DEL', 'EXPIRE', 'INCR', 'EVAL', 'HSET', 'RENAME']) {
    assert.equal(allowed.includes(w), false, `${w} が許可されている`);
  }
  // 実行前に必ず許可リストで弾く
  assert.match(src, /read_only_violation/);
});

test('Airtable / SendGrid は GET しか出さない', () => {
  // fetch に method を渡しているのは Upstash（POST でコマンドを送る仕様）だけ
  const methods = [...src.matchAll(/method:\s*'([A-Z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(methods)], ['POST'], 'Upstash 以外に method を付けていない');
  const upstashBlock = src.slice(src.indexOf('async function redis'), src.indexOf('async function airtableGet'));
  assert.match(upstashBlock, /method:\s*'POST'/);
  for (const verb of ["method: 'PUT'", "method: 'DELETE'", "method: 'PATCH'"]) {
    assert.equal(src.includes(verb), false, `${verb} が含まれている`);
  }
});

test('出力にアドレスが混ざったら中止する', () => {
  assert.match(src, /containsEmailLike\(out\)/);
  assert.match(src, /process\.exit\(3\)/);
});

test('鍵の作り方・判定を再実装していない（単一源を import している）', () => {
  assert.match(src, /from '\.\.\/src\/lib\/marketing\/sendgridMessagePlan\.js'/);
  assert.match(src, /from '\.\.\/src\/lib\/marketing\/sendgridNextMessage\.js'/);
  assert.match(src, /from '\.\.\/src\/lib\/marketing\/deliveryKeyStore\.js'/);
  // 鍵を自前で組み立てていない
  assert.equal(src.includes('createHash(\'sha256\')'), false);
});

test('管理 API 経由でも read-only の action しか叩かない', () => {
  const m = src.match(/READ_ONLY_ADMIN_ACTIONS = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, '管理 API の許可リストが見つからない');
  const allowed = m[1].split(',').map((x) => x.replace(/['"\s]/g, '')).filter(Boolean);
  assert.deepEqual([...allowed].sort(), ['prospectIndexAudit', 'prospectSequenceCheck']);
  // 書き込み系の action 名が混ざっていない
  for (const w of ['intake', 'promote', 'suppress', 'purge', 'enqueue', 'send', 'cancelJob']) {
    assert.equal(allowed.includes(w), false, `${w} が許可されている`);
  }
  assert.match(src, /read_only_violation:\$\{payload && payload\.action\}/);
});

test('通し番号は「第1期の currentStep + 1」で決まる（第2期は完了者だけ）', async () => {
  const { nextMessageFromCurrentSteps } = await import('./sendgridNextMessage.js');
  // 第1期: 未受信 10 / 1通目まで 2 / 2通目まで 5 / 配り終え 3、第2期: 3 のうち 1 名が 2 通目まで
  const r = nextMessageFromCurrentSteps({ 0: 10, 1: 2, 2: 5, 3: 3 }, { 0: 17, 2: 1 });
  assert.equal(r['分布'][1], 10);
  assert.equal(r['分布'][2], 2);
  assert.equal(r['分布'][3], 5);
  assert.equal(r['分布'][4], 2, '第1期完了 3 名 − 第2期に入った 1 名');
  assert.equal(r['分布'][6], 1, '第2期の 2 通目まで受け取った人は次が 6 通目');
  assert.equal(r['配り終えた'], 0);
});

test('資格情報が無ければ何もせず終了する（ネットワークへ出ない）', () => {
  let code = 0;
  try {
    execFileSync(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH },   // Redis の資格情報を渡さない
      stdio: 'pipe',
      timeout: 20000,
    });
  } catch (e) {
    code = e.status;
  }
  assert.equal(code, 2, '資格情報が無いときは exit 2 で止まる');
});
