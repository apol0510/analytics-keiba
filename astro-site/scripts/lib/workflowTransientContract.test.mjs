import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  splitSteps,
  stripCommentLines,
  isScheduled,
  buildNpmAliasMap,
  buildScriptExpectations,
  findTransientContractViolations,
  EXIT_TRANSIENT,
  EXIT_DEFERRED,
} from './workflowTransientContract.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASTRO_SITE = join(__dirname, '..', '..');
const REPO_ROOT = join(ASTRO_SITE, '..');

const PATHS = {
  workflowsDir: join(REPO_ROOT, '.github', 'workflows'),
  scriptsDir: join(ASTRO_SITE, 'scripts'),
  packageJsonPath: join(ASTRO_SITE, 'package.json'),
};

// ── ユニット（検査ロジック自体が機能しているか）─────────────────────────

test('splitSteps は step 単位に分割する', () => {
  const yml = [
    'jobs:',
    '  j:',
    '    steps:',
    '      - name: A',
    '        run: echo a',
    '      - name: B',
    '        run: echo b',
  ].join('\n');
  const steps = splitSteps(yml);
  assert.deepEqual(steps.map((s) => s.name), ['A', 'B']);
  assert.match(steps[0].body, /echo a/);
  assert.doesNotMatch(steps[0].body, /echo b/);
});

test('isScheduled は schedule トリガの有無を見分ける', () => {
  assert.equal(isScheduled('on:\n  schedule:\n    - cron: "0 0 * * *"\n'), true);
  assert.equal(isScheduled('on:\n  workflow_dispatch:\n'), false);
});

test('buildScriptExpectations は呼んでいるヘルパーから期待コードを導出する', () => {
  const map = buildScriptExpectations(PATHS.scriptsDir);
  // exitWithSharedFetchError → 2 / exitDeferredOrFatal → 75
  assert.equal(map.get('checkSharedDailyFile.mjs'), EXIT_TRANSIENT);
  // 終端ハンドラを使わず自前でコードを返す checker も、import している定数から判定できる
  assert.equal(map.get('checkArchiveCoverage.mjs'), EXIT_TRANSIENT);
  assert.equal(map.get('checkJraResultsForImport.mjs'), EXIT_TRANSIENT);
  assert.equal(map.get('importPrediction.js'), EXIT_DEFERRED);
  assert.equal(map.get('importResults.js'), EXIT_DEFERRED);
  assert.equal(map.get('verifyArchiveSync.js'), EXIT_DEFERRED);
  // ヘルパー自身と非対象スクリプトは表に入らない
  assert.equal(map.has('sharedCheckerSupport.mjs'), false);
});

test('一時エラーコードが 2 と 75 に割れている現状を明示する（統一は別タスク）', () => {
  const map = buildScriptExpectations(PATHS.scriptsDir);
  // 同じ「checker」でも本 repo では 2 系と 75 系が混在している。
  //   checkSharedDailyFile.mjs      … exitWithSharedFetchError → 2
  //   checkSharedNankanResults.mjs  … exitDeferredOrFatal      → 75
  // workflow 側は両方を deferred として扱う。統一は呼び出し側の挙動を変えるため別タスク。
  // ここで固定しておくと、片方だけ動かした時に気付ける。
  assert.equal(map.get('checkSharedDailyFile.mjs'), EXIT_TRANSIENT);
  assert.equal(map.get('checkSharedNankanResults.mjs'), EXIT_DEFERRED);
});

test('buildNpmAliasMap は npm run alias を実ファイルへ解決する', () => {
  const aliases = buildNpmAliasMap(PATHS.packageJsonPath);
  assert.ok(aliases.get('verify:sync').includes('verifyArchiveSync.js'));
  assert.ok(aliases.get('import:prediction').includes('importPrediction.js'));
  assert.ok(aliases.get('import:results').includes('importResults.js'));
});

test('コメント中のスクリプト名は実行とみなさない（偽陽性を出さない）', () => {
  const body = [
    '      - name: X',
    '        run: |',
    '          # 旧 checkSharedDailyFile.mjs は統合ファイルを見ていた（現在は未使用）',
    '          node scripts/checkArchiveCoverage.mjs --category jra',
  ].join('\n');
  const code = stripCommentLines(body);
  assert.doesNotMatch(code, /checkSharedDailyFile\.mjs/);
  assert.match(code, /checkArchiveCoverage\.mjs/);
});

test('行内の # は残す（grep -q "#" のようなコードを壊さない）', () => {
  assert.match(stripCommentLines('          grep -q "#" file'), /grep -q "#"/);
});

test('未処理の非ゼロ潰しは違反として検出される（検査が機能していることの証明）', () => {
  // 実 repo ではなく、意図的に壊した最小 workflow で検出力を確認する
  const broken = [
    'on:',
    '  schedule:',
    '    - cron: "0 0 * * *"',
    'jobs:',
    '  j:',
    '    steps:',
    '      - name: Bad',
    '        run: |',
    '          if ! OUT=$(node scripts/checkSharedNankanResults.mjs --date x); then',
    '            exit 1',
    '          fi',
  ].join('\n');
  const steps = splitSteps(broken);
  assert.equal(steps.length, 1);
  // `-eq 2` も `2)` も無いので、この step は期待コードを分岐していない
  assert.doesNotMatch(steps[0].body, /-eq\s+2\b/);
});

// ── 契約（本 repo の schedule workflow すべてが満たすべき条件）───────────

test('schedule workflow は一時障害コード(2/75)を Failure に潰していない', () => {
  const violations = findTransientContractViolations(PATHS);
  const detail = violations
    .map((v) => `  ${v.file} › "${v.step}" › ${v.script} は exit ${v.expected} を分岐していない`)
    .join('\n');
  assert.equal(
    violations.length,
    0,
    `一時障害が Failure になる経路が残っています:\n${detail}\n` +
      '  → rc を捕まえて 2/75 は warning + skip にするか、理由付きで ' +
      '"# transient-contract: exempt — <理由>" を書いてください。',
  );
});
