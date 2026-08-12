#!/usr/bin/env node
/**
 * check-functions-no-undef.mjs — Netlify Functions の**未定義識別子**を静的に検出する
 *   node scripts/check-functions-no-undef.mjs
 *
 * ## なぜ必要か
 *
 * Functions は「その行を実際に通したとき」に初めて ReferenceError になる。
 * import し忘れた 1 語が、**本番で 500 になるまで誰にも気づかれない**。
 *
 * 実際に起きたこと（2026-08-12 に 3 件まとめて発見）:
 *   - `admin-marketing.js` の `getCampaign(TRIAL_SEQUENCE_ID)` … #319 で混入。
 *     管理画面の「無料体験の入口」下見が本番で 500。
 *   - `admin-marketing.js` の `isMarketingClickTrackingEnabled(...)` … #296 で混入。
 *     セグメント下見が本番で 500。**2 週間以上気づかれなかった**
 *   - `admin-customer-import-job.js` の `selectCreateRowsTargeted` / `selectCreateRows`。
 *     CSV 取り込みの**書き込み経路**。次のバッチで落ちる状態だった
 *
 * いずれも構文は正しく、テストも build も通る。だから**静的に見るしかない**。
 *
 * ## 判定
 *
 * ファイル内で参照されている識別子のうち、
 *   - そのファイルで宣言されていない（import / const / function / 引数 / 分割代入 …）
 *   - Node の実行環境にグローバルとして存在しない（`globalThis` で実測する）
 * ものを**未定義**として落とす。グローバル一覧を手で持たないので陳腐化しない。
 *
 * 対象は `netlify/functions/*.js` のみ（Node 実行・ブラウザ globals が出てこない）。
 * ブラウザ向けの `src/lib` は `window` / `document` を持つため対象外。
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FUNCTIONS_DIR = path.join(ROOT, 'netlify', 'functions');

/** `globalThis` で判定できないもの（言語側のキーワード / CJS の実行時変数） */
const EXTRA_GLOBALS = new Set([
  'undefined', 'NaN', 'Infinity', 'globalThis', 'arguments',
  'require', 'module', 'exports', '__dirname', '__filename',
]);

let acorn;
try {
  acorn = await import('acorn');
} catch {
  console.error('❌ acorn を解決できません（astro の依存）。`npm ci` を実行してください。');
  process.exit(1);
}

/**
 * 宣言された名前と参照された名前を集める。
 *
 * **スコープは意図的に無視**して 1 つの集合に潰す。ここで見たいのは
 * 「どこにも無い名前」だけなので、潰したほうが誤検知が出ない。
 */
function collect(node, declared, refs) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) collect(n, declared, refs); return; }
  if (!node.type) return;

  /** 束縛側（パターン）を宣言として登録する */
  const bind = (p) => {
    if (!p || typeof p !== 'object') return;
    switch (p.type) {
      case 'Identifier': declared.add(p.name); break;
      case 'ObjectPattern':
        for (const pr of p.properties) {
          if (pr.type === 'RestElement') { bind(pr.argument); continue; }
          if (pr.computed) collect(pr.key, declared, refs);
          bind(pr.value);
        }
        break;
      case 'ArrayPattern': for (const el of p.elements) bind(el); break;
      case 'AssignmentPattern': bind(p.left); collect(p.right, declared, refs); break;
      case 'RestElement': bind(p.argument); break;
      default: collect(p, declared, refs);
    }
  };

  switch (node.type) {
    case 'ImportDeclaration':
      for (const s of node.specifiers) declared.add(s.local.name);
      return;
    // `export { X } from './y.js'` は**再エクスポート**。ローカル参照ではない
    case 'ExportNamedDeclaration':
      if (node.source) return;
      collect(node.declaration, declared, refs);
      for (const s of node.specifiers || []) refs.add(s.local.name);
      return;
    case 'ExportAllDeclaration': return;
    case 'VariableDeclarator': bind(node.id); collect(node.init, declared, refs); return;
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      if (node.id) declared.add(node.id.name);
      for (const p of node.params) bind(p);
      collect(node.body, declared, refs);
      return;
    case 'ClassDeclaration':
    case 'ClassExpression':
      if (node.id) declared.add(node.id.name);
      collect(node.superClass, declared, refs);
      collect(node.body, declared, refs);
      return;
    case 'CatchClause':
      if (node.param) bind(node.param);
      collect(node.body, declared, refs);
      return;
    // `a.b` の `b`、`{ b: v }` の `b` は識別子ではなくプロパティ名
    case 'MemberExpression':
      collect(node.object, declared, refs);
      if (node.computed) collect(node.property, declared, refs);
      return;
    case 'Property':
      if (node.computed) collect(node.key, declared, refs);
      collect(node.value, declared, refs);
      return;
    case 'MethodDefinition':
    case 'PropertyDefinition':
      if (node.computed) collect(node.key, declared, refs);
      collect(node.value, declared, refs);
      return;
    case 'MetaProperty': return;      // import.meta
    case 'LabeledStatement': collect(node.body, declared, refs); return;
    case 'BreakStatement':
    case 'ContinueStatement': return;
    case 'Identifier': refs.add(node.name); return;
    default:
      for (const k of Object.keys(node)) {
        if (k === 'type' || k === 'loc' || k === 'range' || k === 'start' || k === 'end') continue;
        collect(node[k], declared, refs);
      }
  }
}

/** 1 ファイルの未定義識別子（名前 → 最初に出てくる行） */
export function findUndefinedIdentifiers(file) {
  const src = readFileSync(file, 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const declared = new Set();
  const refs = new Set();
  collect(ast, declared, refs);

  const missing = [...refs].filter((n) => !declared.has(n)
    && !EXTRA_GLOBALS.has(n)
    && typeof globalThis[n] === 'undefined');

  const lines = src.split('\n');
  return missing.map((name) => {
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const idx = lines.findIndex((l) => re.test(l));
    return { name, line: idx >= 0 ? idx + 1 : 0 };
  }).sort((a, b) => a.line - b.line);
}

const files = readdirSync(FUNCTIONS_DIR)
  .filter((f) => f.endsWith('.js'))
  .sort()
  .map((f) => path.join(FUNCTIONS_DIR, f));

if (files.length === 0) {
  console.error('❌ 検査対象の Function が 0 件です（素通り防止）。');
  process.exit(1);
}

let failed = 0;
for (const file of files) {
  let found;
  try {
    found = findUndefinedIdentifiers(file);
  } catch (e) {
    console.error(`❌ ${path.basename(file)}: 解析に失敗しました — ${e.message}`);
    failed += 1;
    continue;
  }
  if (found.length === 0) continue;
  failed += 1;
  console.error(`❌ ${path.relative(ROOT, file)}`);
  for (const { name, line } of found) {
    console.error(`   L${line}: ${name} — import されていない / 宣言されていない`);
  }
}

if (failed > 0) {
  console.error('');
  console.error(`未定義の識別子が ${failed} ファイルにあります。**その行を通ると本番で 500 になります。**`);
  console.error('import を足すか、名前の綴りを直してください。');
  process.exit(1);
}

console.log(`✅ Netlify Functions ${files.length} 件: 未定義の識別子なし`);
