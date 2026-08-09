/**
 * importStepNoFullScan.guard.test.mjs — step が Customers を全件走査しないことを固定する
 *   node --test src/lib/crm/importStepNoFullScan.guard.test.mjs
 *
 * 2026-08-09 の本実行: Customers 15,967 件で **1 回の全件取得に約 170 秒**（160 ページ）。
 * step は facts 用と突合用で 2 回引いており、Function タイムアウト（最大 26 秒）を
 * 大きく超えて毎回 504 になった。列を絞っても改善しない（コストはページ数）。
 * 実測で名指しクエリは 100 件 1 コール 1.7 秒。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FN = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/admin-customer-import-job.js', import.meta.url)), 'utf8');

/** handleStep の本体だけを切り出す */
function stepBody() {
  const i = FN.indexOf('async function handleStep');
  assert.ok(i > -1, 'handleStep が無い');
  const j = FN.indexOf('\nasync function ', i + 10);
  return FN.slice(i, j > -1 ? j : undefined);
}

test('step は buildJobContext を skipAllRecords で呼ぶ', () => {
  assert.match(stepBody(), /buildJobContext\(\{[^}]*skipAllRecords:\s*true/s,
    'step が Customers を全件取得している');
});

test('step は名指し取得（fetchByEmails）で facts を組む', () => {
  const b = stepBody();
  assert.match(b, /selectRows:\s*async/, '名指し選定を注入していない');
  assert.match(b, /fetchByEmails\(\{/, 'fetchByEmails を使っていない');
  assert.match(b, /selectCreateRowsTargeted\(/);
});

test('名指し取得は listRecords(POST) を使い、失敗を握りつぶさない', () => {
  const i = FN.indexOf('async function fetchByEmails');
  const body = FN.slice(i, i + 1600);
  assert.match(body, /listRecords/, 'GET の formula 長制限に当たる書き方をしている');
  assert.match(body, /method: 'POST'/);
  assert.match(body, /throw new Error\(/, '失敗時に空配列を返している（fail open）');
});

test('per-batch 検証を毎 step 実行し、NG なら BLOCKED にする', () => {
  const b = stepBody();
  assert.match(b, /verifyWrittenBatch\(\{/);
  assert.match(b, /if \(!batchVerify\.ok\)/);
  assert.match(b, /markJobBlocked\(/);
});

test('全体突合は cadence + 完了時のみ（毎 step ではない）', () => {
  const b = stepBody();
  assert.match(b, /shouldRunFullReconcile\(\{[^}]*isFinal/s);
  // step 内の全件取得は**すべて条件付き**の 3 箇所まで:
  //   ① 追いつき（childHistory が空の初回のみ）
  //   ② 全体突合（cadence + 完了時）
  //   ③ 過少計測の測り直し（件数系が落ちたときだけ）
  // 通常の step ではどれも走らない。
  const n = (b.match(/fetchAllReadOnly\(\{/g) || []).length;
  assert.ok(n <= 3, `step 内の全件取得が ${n} 箇所ある`);
  // 無条件に全件を引く行が無いこと（直前が条件式であること）
  assert.ok(!/^\s*const \w+ = await fetchAllReadOnly\(\{[^}]*\}\);\s*$/m.test(b)
    || /childHistory \|\| \[\]\)\.length === 0/.test(b),
  '無条件の全件取得がある');
});

test('全体突合を省いた回は、省いたことを正本に残す（黙って OK にしない）', () => {
  assert.match(stepBody(), /deferredFullReconcile:\s*true/,
    '省略を記録していない（あとから「検証済み」と誤読される）');
});

test('完了時は必ず全体突合する', () => {
  const b = stepBody();
  const i = b.indexOf('shouldRunFullReconcile({');
  const call = b.slice(i, i + 200);
  assert.match(call, /isFinal/, '完了判定を渡していない');
  assert.match(b, /const isFinal =[^;]*COMPLETED/s, 'isFinal を COMPLETED から導出していない');
});

test('fetchAllReadOnly の打ち切りは例外のまま（前回の修正を戻さない）', () => {
  const i = FN.indexOf('async function fetchAllReadOnly');
  const body = FN.slice(i, i + 1200);
  assert.match(body, /throw new Error\([^)]*truncated/);
});
