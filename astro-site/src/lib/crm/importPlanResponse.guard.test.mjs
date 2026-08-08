/**
 * importPlanResponse.guard.test.mjs — plan の**応答形状**を固定する
 *   node --test src/lib/crm/importPlanResponse.guard.test.mjs
 *
 * 追加の経緯（2026-08-09）:
 *   PR #266 で `summarizeImportPlan` を作り import まで足したのに、
 *   **plan の応答へ組み込む差分だけが入らなかった**。ライブラリ単体テストは通り、
 *   module も読めてしまうため、本番で実行するまで気づけなかった。
 *   「応答に何が入るか」を見るテストが無かったのが原因なので、ここで固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FN = fileURLToPath(new URL('../../../netlify/functions/admin-customer-import-job.js', import.meta.url));
const raw = readFileSync(FN, 'utf8');
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** handlePlan の本体だけを切り出す */
function planBody() {
  const i = code.indexOf('async function handlePlan');
  assert.ok(i > -1, 'handlePlan が見つからない');
  const j = code.indexOf('\nasync function ', i + 10);
  return code.slice(i, j > -1 ? j : undefined);
}

test('plan の応答に内訳 7 項目がすべて入る', () => {
  const body = planBody();
  for (const k of ['CSV行数', 'CREATE', 'EXISTING', 'EXCLUDED', 'REVIEW_REQUIRED',
    'CSV内の正規化メール重複', '理由別', '合計一致']) {
    assert.ok(body.includes(`${k}:`), `plan の応答に ${k} が無い`);
  }
});

test('plan の応答に snapshot 指紋が入る', () => {
  const body = planBody();
  assert.match(body, /snapshot指紋:\s*computeSnapshotFingerprint\(/,
    'snapshot 指紋を返していない');
  assert.match(body, /computeSnapshotFingerprint\(ctx\.orderedHashes\)/,
    'orderedHashes 以外から指紋を作っている（開始時の値と一致しなくなる）');
});

test('内訳は summarizeImportPlan から作る（別ロジックで数え直さない）', () => {
  const body = planBody();
  assert.match(body, /summarizeImportPlan\(\{/, 'summarizeImportPlan を呼んでいない');
  // ctx の 3 点をそのまま渡していること（別 facts を作らない）
  assert.match(body, /entries:\s*ctx\.entries/);
  assert.match(body, /facts:\s*ctx\.facts/);
  assert.match(body, /providerEmails:\s*ctx\.providerEmails/);
});

test('import した summarizeImportPlan が実際に使われている（未使用 import を許さない）', () => {
  assert.match(code, /import \{[^}]*summarizeImportPlan[^}]*\} from/);
  const uses = (code.match(/summarizeImportPlan\s*\(/g) || []).length;
  assert.ok(uses >= 1, 'summarizeImportPlan を import しただけで使っていない');
});

test('computeSnapshotFingerprint の import が重複していない', () => {
  const importLine = code.split('\n').find((l) => l.includes('computeSnapshotFingerprint') && l.includes(','));
  if (importLine) {
    const n = (importLine.match(/computeSnapshotFingerprint/g) || []).length;
    assert.equal(n, 1, `import 行に computeSnapshotFingerprint が ${n} 回ある`);
  }
});

test('plan は read-only のまま（書き込み系を呼ばない）', () => {
  const body = planBody();
  for (const bad of ['createRecord', 'writeCreateBatch', 'claimRows', 'saveFenced', "'PATCH'"]) {
    assert.ok(!body.includes(bad), `plan が ${bad} を呼んでいる（read-only でなくなる）`);
  }
  assert.match(body, /sideEffects:\s*'none'/, "plan が sideEffects:'none' を宣言していない");
});

test('plan の応答に PII を入れない', () => {
  const body = planBody();
  // entries / records そのものを返していないこと
  assert.ok(!/\bentries:\s*ctx\.entries\s*,?\s*\n\s*\}/.test(body), 'entries をそのまま返している');
  assert.ok(!body.includes('records: ctx.records'), 'records をそのまま返している');
});
