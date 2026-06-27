/**
 * resultsJraComputerMigration.test.mjs — PR-AK-3 静的監査テスト（node:test / 新規依存なし）
 *
 * importResultsJra / importComputer 移行と対象 workflow の token 供給・匿名ゼロを検証。
 *   node --test scripts/resultsJraComputerMigration.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const wfDir = join(__dirname, '..', '..', '.github', 'workflows');
const read = (p) => readFileSync(p, 'utf-8');

const MIGRATED = ['importResultsJra.js', 'importComputer.js'];

for (const f of MIGRATED) {
  test(`script ${f}: 匿名 shared 参照ゼロ・helper import・fail-fast`, () => {
    const src = read(join(__dirname, f));
    assert.doesNotMatch(src, /raw\.githubusercontent\.com\/apol0510\/keiba-data-shared/);
    assert.doesNotMatch(src, /api\.github\.com\/repos\/apol0510\/keiba-data-shared/);
    assert.match(src, /from '\.\/lib\/sharedFetch\.mjs'/);
    assert.match(src, /resolveSharedToken\(/);
  });
  test(`script ${f}: token 未設定で exit 非0（fail-fast）`, () => {
    const env = { ...process.env };
    delete env.KEIBA_DATA_SHARED_TOKEN;
    delete env.GITHUB_TOKEN_KEIBA_DATA_SHARED;
    delete env.GITHUB_TOKEN;
    let exit = 0, stderr = '';
    try {
      execFileSync('node', [join(__dirname, f), '--date', '2026-05-31'], {
        env, cwd: join(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'], timeout: 15000,
      });
    } catch (e) { exit = e.status ?? 1; stderr = (e.stderr || '').toString(); }
    assert.notEqual(exit, 0);
    assert.ok(!stderr.includes('ghp_'));
  });
}

// workflow: importResultsJra / importComputer 実行 step へ token 供給
test('workflow: import-results-jra.yml の import step に KEIBA_DATA_SHARED_TOKEN', () => {
  const wf = read(join(wfDir, 'import-results-jra.yml'));
  assert.match(wf, /KEIBA_DATA_SHARED_TOKEN:\s*\$\{\{\s*secrets\.KEIBA_DATA_SHARED_TOKEN\s*\}\}/);
});
test('workflow: import-computer-on-dispatch.yml の import step に KEIBA_DATA_SHARED_TOKEN', () => {
  const wf = read(join(wfDir, 'import-computer-on-dispatch.yml'));
  assert.match(wf, /KEIBA_DATA_SHARED_TOKEN:\s*\$\{\{\s*secrets\.KEIBA_DATA_SHARED_TOKEN\s*\}\}/);
});
test('workflow: import-results-jra-daily.yml の import step に KEIBA_DATA_SHARED_TOKEN', () => {
  const wf = read(join(wfDir, 'import-results-jra-daily.yml'));
  assert.match(wf, /KEIBA_DATA_SHARED_TOKEN:\s*\$\{\{\s*secrets\.KEIBA_DATA_SHARED_TOKEN\s*\}\}/);
});

// クリーン化2 workflow（dispatch系）に匿名 raw が残っていない
test('workflow: import-results-jra.yml / import-computer-on-dispatch.yml に匿名 raw なし', () => {
  for (const f of ['import-results-jra.yml', 'import-computer-on-dispatch.yml']) {
    assert.doesNotMatch(read(join(wfDir, f)), /raw\.githubusercontent\.com\/apol0510\/keiba-data-shared/, `${f}`);
  }
});
