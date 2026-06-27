/**
 * resultsAuthMigration.test.mjs — PR-AK-2 静的監査テスト（node:test / 新規依存なし）
 *
 * 移行 script（importResults / syncArchiveResults / verifyArchiveSync）と
 * 対象 workflow が、匿名 shared 取得を残さず認証契約・失敗伝播を満たすことを検証する。
 *   node --test scripts/resultsAuthMigration.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptsDir = __dirname;
const wfDir = join(__dirname, '..', '..', '.github', 'workflows');
const read = (p) => readFileSync(p, 'utf-8');

const MIGRATED = ['importResults.js', 'syncArchiveResults.js', 'verifyArchiveSync.js'];

// ---- 移行 script: 匿名 shared 取得ゼロ・helper 使用・fail-fast ----
for (const f of MIGRATED) {
  test(`script ${f}: 匿名 raw.githubusercontent(keiba-data-shared) を含まない`, () => {
    const src = read(join(scriptsDir, f));
    assert.doesNotMatch(src, /raw\.githubusercontent\.com\/apol0510\/keiba-data-shared/);
    assert.doesNotMatch(src, /api\.github\.com\/repos\/apol0510\/keiba-data-shared/);
  });
  test(`script ${f}: sharedFetch helper を import し resolveSharedToken で fail-fast`, () => {
    const src = read(join(scriptsDir, f));
    assert.match(src, /from '\.\/lib\/sharedFetch\.mjs'/);
    assert.match(src, /resolveSharedToken\(/);
  });
}

// ---- 移行 script: token 未設定で取得前に fail（exit 非0・実通信なし） ----
for (const f of MIGRATED) {
  test(`script ${f}: token 全未設定で exit 非0（fail-fast・network 前）`, () => {
    const env = { ...process.env };
    delete env.KEIBA_DATA_SHARED_TOKEN;
    delete env.GITHUB_TOKEN_KEIBA_DATA_SHARED;
    delete env.GITHUB_TOKEN;
    let exitCode = 0;
    let stderr = '';
    try {
      execFileSync('node', [join(scriptsDir, f), '--date', '2026-05-08'], {
        env, cwd: join(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'], timeout: 15000,
      });
    } catch (e) {
      exitCode = e.status ?? 1;
      stderr = (e.stderr || '').toString();
    }
    assert.notEqual(exitCode, 0, `${f} は token 未設定で非0 exit すべき`);
    // token 値が stderr に出ない
    assert.ok(!stderr.includes('ghp_'), 'token 値がログに出ない');
  });
}

// ---- workflow: 完全クリーン化した 2 本（匿名 shared 参照ゼロ・token 供給・continue-on-error 撤去） ----
const CLEAN_WORKFLOWS = ['import-results-nankan-daily.yml', 'import-results-on-dispatch.yml'];

function extractStep(wf, stepName) {
  const lines = wf.split('\n');
  const start = lines.findIndex((l) => l.includes(`- name: ${stepName}`));
  assert.ok(start >= 0, `step が見つからない: ${stepName}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*-\s+name:/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

test('workflow: import-results-nankan-daily.yml の results/verify step が token 供給 + continue-on-error なし', () => {
  const wf = read(join(wfDir, 'import-results-nankan-daily.yml'));
  const importStep = extractStep(wf, 'Import missing results');
  assert.match(importStep, /KEIBA_DATA_SHARED_TOKEN:\s*\$\{\{\s*secrets\.KEIBA_DATA_SHARED_TOKEN\s*\}\}/);
  assert.doesNotMatch(importStep, /continue-on-error:\s*true/);
  assert.doesNotMatch(importStep, /GITHUB_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
  const verifyStep = extractStep(wf, 'Verify archive sync (MANDATORY)');
  assert.match(verifyStep, /KEIBA_DATA_SHARED_TOKEN:\s*\$\{\{\s*secrets\.KEIBA_DATA_SHARED_TOKEN\s*\}\}/);
});

test('workflow: import-results-on-dispatch.yml の results/verify step が token 供給 + continue-on-error なし', () => {
  const wf = read(join(wfDir, 'import-results-on-dispatch.yml'));
  const importStep = extractStep(wf, 'Import results from keiba-data-shared');
  assert.match(importStep, /KEIBA_DATA_SHARED_TOKEN:\s*\$\{\{\s*secrets\.KEIBA_DATA_SHARED_TOKEN\s*\}\}/);
  assert.doesNotMatch(importStep, /continue-on-error:\s*true/);
  const verifyStep = extractStep(wf, 'Verify archive sync (MANDATORY)');
  assert.match(verifyStep, /KEIBA_DATA_SHARED_TOKEN:\s*\$\{\{\s*secrets\.KEIBA_DATA_SHARED_TOKEN\s*\}\}/);
});

test('workflow: 完全クリーン化 2 本に匿名 raw(keiba-data-shared) が残っていない', () => {
  for (const f of CLEAN_WORKFLOWS) {
    const wf = read(join(wfDir, f));
    assert.doesNotMatch(wf, /raw\.githubusercontent\.com\/apol0510\/keiba-data-shared/, `${f} に匿名 raw が残存`);
  }
});

test('workflow: auto-sync-check.yml に job レベルで KEIBA_DATA_SHARED_TOKEN が供給される', () => {
  const wf = read(join(wfDir, 'auto-sync-check.yml'));
  // job レベル env（steps より前）に token がある
  const beforeSteps = wf.split('steps:')[0];
  assert.match(beforeSteps, /KEIBA_DATA_SHARED_TOKEN:\s*\$\{\{\s*secrets\.KEIBA_DATA_SHARED_TOKEN\s*\}\}/);
});
