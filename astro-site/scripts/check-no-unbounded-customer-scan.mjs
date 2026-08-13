#!/usr/bin/env node
/**
 * check-no-unbounded-customer-scan.mjs — **無フィルタ全件走査＋打ち切り**を検出する
 *   node scripts/check-no-unbounded-customer-scan.mjs
 *
 * ## なぜ必要か
 *
 * Customers が 15,962 件へ育った結果、「無フィルタで先頭から読み、`MAX_PAGES` で
 * 黙って打ち切る」実装が**人を静かに取りこぼす**ようになった。実際に起きたこと:
 *
 *   - `admin-marketing` の無料体験 下見 … コホート 3,629 / 候補 3,588 と過少表示
 *     （真値 14,489 / 14,320）→ PR #320 で修正
 *   - `premium-plus-eligibility` の販売一覧 … 即時販売 3 名が 3 名とも窓の外へ落ち
 *     「即時販売 0」と表示 → PR #321 で修正
 *   - `admin-marketing` の連続配信（sequence / dryRun / send）… Light 付与 10 名のうち
 *     **2 名しか見えない** → 本 PR で修正
 *
 * いずれも**構文は正しく、テストも build も通る**。落ちるのは本番データの規模でだけ。
 * だから静的に検出する。
 *
 * ## 判定
 *
 * 対象ファイルの中で
 *   1. `filterByFormula` を伴わない Customers 取得ループがあり
 *   2. かつ `MAX_PAGES`（相当の上限）で `break` して**結果を返し続ける**
 * ものを落とす。上限で `throw` / `return`（fail closed）しているものは許可する。
 *
 * 新しく全件走査を足したくなったら、まず「その API に必要な候補は誰か」を
 * formula で表現できないか検討すること。
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FN_DIR = path.join(ROOT, 'netlify', 'functions');

/**
 * 既知の許可（理由付き）。
 * ここへ足すときは「なぜ全件で安全か」を必ず書くこと。
 */
const ALLOWED = new Map([
  // file -> { count, reason }
  // **件数まで固定する**。1 つでも増えたらこの検査は落ちる（新規混入を止めるため）。
  // 減らしたら count も下げること（減った分の枠を残さない）。
  ['admin-marketing.js', {
    count: 1,
    reason: 'loadCustomerMarketing（customers / customerDetail / segments 用）。'
      + '販売・配信の判定経路（sequence / plan / trialGrant）は bounded 化済み。'
      + '一覧系の bounded 化は別 PR で対応する。',
  }],
  ['admin-comeback-grants.js', {
    count: 1,
    reason: 'カムバック特典の候補一覧。同型だが本 PR の対象外。別 PR で bounded 化する。',
  }],
  ['admin-customer-import.js', {
    count: 1,
    reason: 'CSV 取り込みの重複判定。全件突合が要件だが、打ち切りは fail closed へ直す必要がある。別 PR。',
  }],
  ['admin-customer-import-run.js', {
    count: 1,
    reason: '同上（取り込み実行側）。別 PR。',
  }],
]);

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

/** その打ち切りが fail closed か（throw / return して結果を返さない） */
function isFailClosed(snippet) {
  return /throw new Error\(/.test(snippet) || /return json\(/.test(snippet);
}

const findings = [];

/** `fn({ ... })` の引数オブジェクト本文を取り出す（括弧の対応を数える） */
function callArgs(code, fnName) {
  const out = [];
  const re = new RegExp(`\\b${fnName}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(code)) !== null) {
    let i = m.index + m[0].length - 1;
    let depth = 0;
    const start = i;
    for (; i < code.length; i += 1) {
      if (code[i] === '(') depth += 1;
      else if (code[i] === ')') { depth -= 1; if (depth === 0) break; }
    }
    out.push({ text: code.slice(start, i + 1), index: m.index });
  }
  return out;
}

const lineOf = (raw, idx) => raw.slice(0, idx).split('\n').length;

for (const file of readdirSync(FN_DIR).filter((f) => f.endsWith('.js')).sort()) {
  const full = path.join(FN_DIR, file);
  const raw = readFileSync(full, 'utf8');
  const code = stripComments(raw);
  if (!/Customers/.test(code)) continue;

  // ① ページング helper を **Customers に対して formula 無しで**呼んでいる箇所
  for (const fn of ['fetchAll', 'fetchAllRecords', 'listAll']) {
    for (const call of callArgs(code, fn)) {
      const a = call.text;
      if (!/CUSTOMERS_TABLE|['"`]Customers['"`]/.test(a)) continue;
      if (/filterByFormula/.test(a)) continue;
      findings.push({ file, line: lineOf(code, call.index), why: `${fn}() を Customers へ formula 無しで呼んでいる` });
    }
  }

  // ② その場でページングし、上限で黙って break しているループ
  const re = /if\s*\([^)]*pages\s*>=\s*[A-Z_]*MAX_PAGES[^)]*\)\s*\{?([^}]*)\}?/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const snippet = m[0];
    if (isFailClosed(snippet)) continue;
    if (!/break/.test(snippet)) continue;
    const before = code.slice(Math.max(0, m.index - 1400), m.index);
    if (!/CUSTOMERS_TABLE|\/Customers/.test(before)) continue;
    if (/filterByFormula/.test(before)) continue;
    findings.push({ file, line: lineOf(code, m.index), why: '無フィルタのページングを上限で黙って break している' });
  }
}

// 既知分は「件数まで一致」なら通す。増えたら落とす（新規混入の検知）
const byFile = new Map();
for (const f of findings) byFile.set(f.file, [...(byFile.get(f.file) || []), f]);

const unexpected = [];
for (const [file, list] of byFile) {
  const allow = ALLOWED.get(file);
  const allowed = allow ? allow.count : 0;
  if (list.length > allowed) unexpected.push(...list.slice(allowed));
}

if (unexpected.length === 0 && byFile.size > 0) {
  console.log('✅ 新規の無フィルタ全件走査なし（既知の残件のみ）');
  for (const [file, list] of byFile) {
    console.log(`   既知: ${file} × ${list.length} — ${(ALLOWED.get(file) || {}).reason || ''}`);
  }
  process.exit(0);
}

if (unexpected.length > 0) {
  const findingsOut = unexpected;
  console.error('❌ Customers を無フィルタで全件走査し、黙って打ち切っている箇所が増えています:\n');
  for (const f of findingsOut) console.error(`   ${f.file}:${f.line}  — ${f.why}`);
  console.error('');
  console.error('Customers は 15,962 件あります。先頭 N 件だけ読むと**人が静かに消えます**。');
  console.error('filterByFormula で必要な候補だけを取るか、上限では fail closed にしてください。');
  process.exit(1);
}

console.log('✅ Customers の無フィルタ全件走査＋黙って打ち切り: 該当なし');
