/**
 * importResultsNankanWorkflow.test.mjs — workflow 静的テスト（node:test / 新規依存なし）
 *
 * .github/workflows/import-results-nankan-daily.yml の前段(results存在確認)と
 * sanrenpuku step の失敗伝播契約を文字列レベルで検証する。
 *   node --test scripts/importResultsNankanWorkflow.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WF_PATH = join(__dirname, '..', '..', '.github', 'workflows', 'import-results-nankan-daily.yml');
const wf = readFileSync(WF_PATH, 'utf-8');
const lines = wf.split('\n');

/** 指定 step 名から次の "- name:" 直前までを抽出（区間限定で誤検出を防ぐ） */
function extractStep(stepName) {
  const startIdx = lines.findIndex((l) => l.includes(`- name: ${stepName}`));
  assert.ok(startIdx >= 0, `step が見つからない: ${stepName}`);
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^\s*-\s+name:/.test(lines[i])) { endIdx = i; break; }
  }
  return lines.slice(startIdx, endIdx).join('\n');
}

const checkStep = extractStep('Check for missing results');
const sanrenpukuStep = extractStep('Import missing sanrenpuku results');

// ---- workflow 全体（匿名 shared 取得ゼロ） ----
test('1. workflow 全体に匿名 raw.githubusercontent.com/.../keiba-data-shared が無い', () => {
  assert.doesNotMatch(wf, /raw\.githubusercontent\.com\/apol0510\/keiba-data-shared/);
});

test('1b. workflow 内に未認証の api.github.com 参照（gh api/Authorization 以外の素の curl）が無い', () => {
  // shared への直接 URL 参照そのものを workflow shell に残さない（確認は Node script へ委譲）
  assert.doesNotMatch(wf, /api\.github\.com\/repos\/apol0510\/keiba-data-shared/);
});

// ---- results 確認ステップ ----
test('2. results 確認 step に KEIBA_DATA_SHARED_TOKEN が供給される', () => {
  assert.match(checkStep, /KEIBA_DATA_SHARED_TOKEN:\s*\$\{\{\s*secrets\.KEIBA_DATA_SHARED_TOKEN\s*\}\}/);
});

test('3. results 確認 step に token 未設定 fail-fast がある', () => {
  assert.match(checkStep, /if\s*\[\s*-z\s*"\$\{KEIBA_DATA_SHARED_TOKEN:-\}"\s*\]/);
  assert.match(checkStep, /exit 1/);
});

test('4. 認証付き Node 確認 script へ委譲し、匿名 curl -sf / raw を使わない', () => {
  assert.match(checkStep, /node scripts\/checkSharedNankanResults\.mjs/);
  assert.doesNotMatch(checkStep, /curl\s+-sf/);
  assert.doesNotMatch(checkStep, /raw\.githubusercontent\.com/);
});

test('5. secrets.GITHUB_TOKEN を private shared 読取に流用していない（確認 step に GITHUB_TOKEN env が無い）', () => {
  assert.doesNotMatch(checkStep, /GITHUB_TOKEN:\s*\$\{\{\s*secrets\.GITHUB_TOKEN\s*\}\}/);
});

test('6. FOUND_CODES 異常な空を成功扱いしない（script 失敗で step を exit 1）', () => {
  // `node ... || { ... exit 1; }` で fatal を握りつぶさない
  assert.match(checkStep, /checkSharedNankanResults\.mjs[\s\S]*\|\|\s*\{[\s\S]*exit 1/);
  // 握りつぶし(|| echo で継続)が無い
  assert.doesNotMatch(checkStep, /checkSharedNankanResults\.mjs[^\n]*\|\|\s*echo/);
});

// ---- sanrenpuku step ----
test('7. sanrenpuku step に continue-on-error: true が無い', () => {
  assert.doesNotMatch(sanrenpukuStep, /continue-on-error:\s*true/);
});

test('8. sanrenpuku step に importer の "|| echo" 握りつぶしが無い / exit 1 経路がある', () => {
  assert.doesNotMatch(sanrenpukuStep, /importResultsSanrenpuku\.js[^\n]*\|\|\s*echo/);
  assert.match(sanrenpukuStep, /exit 1/);
});

test('9. secret 値を echo していない（両 step）', () => {
  assert.doesNotMatch(checkStep, /echo[^\n]*\$\{\{\s*secrets\./);
  assert.doesNotMatch(sanrenpukuStep, /echo[^\n]*\$\{\{\s*secrets\./);
});

// ---- umatan step は PR-AK-2 で認証化（importResults.js 移行に伴い continue-on-error 撤去 + token 供給） ----
test('10. umatan step（Import missing results）は token 供給 + continue-on-error 撤去（PR-AK-2）', () => {
  const importResults = extractStep('Import missing results');
  assert.doesNotMatch(importResults, /continue-on-error:\s*true/);
  assert.match(importResults, /KEIBA_DATA_SHARED_TOKEN:\s*\$\{\{\s*secrets\.KEIBA_DATA_SHARED_TOKEN\s*\}\}/);
});
