#!/usr/bin/env node
/**
 * 【著作権・表示安全対策 - 静的ガード】
 * テンプレート（.astro / .jsx / .tsx）に `horse.computerIndex` / `horse.sourceComputerIndex`
 * を **直接 JSX 出力** している箇所が無いかを文字列レベルで検査する。
 *
 * 直接表示は禁止。必ず `getDisplayComputerIndex(...)` または
 * `formatDisplayComputerIndex(...)` を通すこと（共通関数は
 * `src/lib/shared-prediction-logic.js` に定義）。
 *
 * NG 例:
 *   {horse.computerIndex}
 *   {horse.sourceComputerIndex}
 *   {horse?.computerIndex}
 *   {h.computerIndex}
 *
 * OK 例:
 *   horse.computerIndex != null              // 存在チェック
 *   horse.computerIndex !== 0                // 存在チェック
 *   getDisplayComputerIndex(horse.computerIndex)
 *   formatDisplayComputerIndex(horse.computerIndex)
 *   Number(horse.computerIndex)              // 数値変換
 *   parseInt(horse.computerIndex)            // 数値変換
 *   parseFloat(horse.computerIndex)          // 数値変換
 *   horse.computerIndex ?? null              // 保持
 *
 * 検出ルール:
 *   1) `{ <expr>.computerIndex }` または `{ <expr>.sourceComputerIndex }` の
 *      括弧を閉じる直前まで（同じ波括弧内に getDisplayComputerIndex / formatDisplayComputerIndex
 *      / Number / parseInt / parseFloat が無ければ NG）
 *   2) 行コメント (// で始まる) は除外
 *
 * exit:
 *   0  違反なし
 *   1  違反あり（ファイル:行 と該当行を出力）
 *   2  対象ファイル 0 件（CI で「素通り」を防ぐ）
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const SCAN_ROOTS = [
  join(REPO_ROOT, 'src/pages'),
  join(REPO_ROOT, 'src/components'),
];
const FILE_EXTS = ['.astro', '.jsx', '.tsx'];

function walk(dir, files = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return files; }
  for (const name of entries) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, files);
    else if (FILE_EXTS.some((ext) => full.endsWith(ext))) files.push(full);
  }
  return files;
}

// JSX/Astro 補間 { ... } の中身を 1 段だけ取り出すための簡易バランス括弧パーサ
function findInterpolations(line) {
  const ranges = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '{') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        ranges.push(line.slice(start, i));
        start = -1;
      }
    }
  }
  return ranges;
}

const NG_BARE_EXPR = /(^|[^A-Za-z0-9_$])([A-Za-z_$][A-Za-z0-9_$]*)\??\.(?:computerIndex|sourceComputerIndex)(?![A-Za-z0-9_$])/;
const SAFE_WRAPS = [
  'getDisplayComputerIndex',
  'formatDisplayComputerIndex',
  'Number(',
  'parseInt(',
  'parseFloat(',
];

function isViolation(interpolation) {
  // 補間内に対象プロパティが現れる
  if (!NG_BARE_EXPR.test(interpolation)) return false;
  // 同じ補間内で安全関数で包まれていれば OK
  for (const wrap of SAFE_WRAPS) {
    if (interpolation.includes(wrap)) return false;
  }
  // 存在チェック専用 (例: horse.computerIndex != null / !== 0) は出力ではないので除外
  // ただし JSX 補間として書かれている時点で「真偽値を画面に出してる」可能性が残るため、
  // テンプレート補間に != / !== / == / === のみで終わっているなら OK 扱い。
  const trimmed = interpolation.trim();
  if (/^[A-Za-z_$][A-Za-z0-9_$.\?\s]*\.(?:computerIndex|sourceComputerIndex)\s*(==|!=|===|!==)\s*[^&|]+$/.test(trimmed)) {
    return false;
  }
  // `... && <jsx>` のような構造で先頭に boolean 条件があり、その後の表示が安全関数経由なら OK
  // すでに SAFE_WRAPS チェックでカバー済みなので、ここに来る = 直接表示の可能性が高い
  return true;
}

function scanFile(path) {
  const lines = readFileSync(path, 'utf-8').split('\n');
  const hits = [];
  lines.forEach((line, idx) => {
    // 行頭からのコメントは除外（簡易）
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    const interps = findInterpolations(line);
    for (const interp of interps) {
      if (isViolation(interp)) {
        hits.push({ line: idx + 1, text: line.trim().slice(0, 200), interp: interp.trim().slice(0, 200) });
      }
    }
  });
  return hits;
}

function main() {
  const files = SCAN_ROOTS.flatMap((r) => walk(r));
  if (files.length === 0) {
    console.error('❌ 対象ファイル 0 件。scan root 設定が壊れている可能性。');
    process.exit(2);
  }

  console.log(`scan: ${files.length} files under src/pages, src/components (.astro/.jsx/.tsx)`);

  let totalHits = 0;
  for (const f of files) {
    const hits = scanFile(f);
    if (hits.length === 0) continue;
    totalHits += hits.length;
    const rel = relative(REPO_ROOT, f);
    for (const h of hits) {
      console.log(`❌ ${rel}:${h.line}`);
      console.log(`    補間: { ${h.interp} }`);
    }
  }

  console.log(`\n--- まとめ ---`);
  console.log(`scanned: ${files.length} files`);
  console.log(`violations: ${totalHits}`);

  if (totalHits > 0) {
    console.error('\n❌ horse.computerIndex / horse.sourceComputerIndex を JSX に直接出力している箇所があります。');
    console.error('   getDisplayComputerIndex(...) または formatDisplayComputerIndex(...) で必ずラップしてください。');
    process.exit(1);
  }
  console.log('\n✅ 直接表示なし（著作権・表示安全ガード OK）');
}

main();
