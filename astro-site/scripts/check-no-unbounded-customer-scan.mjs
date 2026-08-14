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
 *
 * ## 🎉 現在 **0 件**。この状態を維持すること。
 *
 * 2026-08-13 に残り 4 系統をすべて bounded 化した:
 *
 *   - `admin-marketing` customers / segments … 用途別 formula + fail closed
 *   - `admin-marketing` customerDetail       … recordId で名指しに 1 件だけ引く
 *   - `admin-comeback-grants`                … 候補 formula / 付与操作 ID / recordId で引く
 *   - `admin-customer-import{,-run}`         … **問いを逆向きに**して CSV のアドレスを名指しで引く
 *
 * ## ⛔ ここへ 1 行足す前に読むこと
 *
 * 例外を足すのは「今は直せないので黙って人を落とす」と宣言することに等しい。
 * まず次を検討する:
 *
 *   1. **その API に必要な候補は誰か**を formula で書けないか
 *   2. **1 件しか要らない**のに全件読んでいないか（recordId で引けないか）
 *   3. **問いの向きが逆**ではないか（「全員」ではなく「この人たちは居るか」で足りないか）
 *   4. 絞れないなら **fail closed**（少ない件数を正しい件数として見せない）
 *
 * **`MAX_PAGES` を上げるのは解決ではない。** Airtable は 1 ページ 100 件・
 * base あたり毎秒 5 リクエストなので、15,962 件の走査は最短 32 秒。
 * 上限を上げても打ち切りがタイムアウトへ移るだけ。
 */
const ALLOWED = new Map([
  // file -> { count, reason }
  // **件数まで固定する**。1 つでも増えたらこの検査は落ちる（新規混入を止めるため）。
]);

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

/**
 * その打ち切りが fail closed か（throw / return して**結果を返さない**）。
 * 独自の Error 派生（`CustomerFetchTruncatedError` 等）も throw なので許可する。
 */
function isFailClosed(snippet) {
  return /throw\s+new\s+[A-Za-z0-9_$]+\s*\(/.test(snippet) || /return json\(/.test(snippet);
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

  // ① ページング helper を **Customers に対して formula 無しで**呼んでいる箇所。
  //    ただし helper 自身が上限で fail closed（throw）しているなら「完走するか落ちるか」の
  //    どちらかなので、黙って人が消えることはない → 許可する。
  const failClosedHelpers = new Set();
  for (const def of code.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g)) {
    const start = def.index;
    const next = code.slice(start + 1).search(/\n(?:async\s+)?function\s/);
    const body = code.slice(start, next > 0 ? start + 1 + next : code.length);
    if (/pages\s*>=/.test(body) && /throw\s+new\s+\w*Error/.test(body)) failClosedHelpers.add(def[1]);
  }
  for (const fn of [
    'fetchAll', 'fetchAllRecords', 'listAll', 'fetchAllReadOnly',
    'fetchBounded', 'fetchCustomersBounded',
  ]) {
    if (failClosedHelpers.has(fn)) continue; // 上限で落ちる = 黙って切らない
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

  // ③ **上限の名前に依らない網**: ② は `MAX_PAGES` という綴りだけを見ていたので、
  //    `LIMIT` 等へ改名すると素通りしていた。`pages >= <上限>` を綴りに依らず見る。
  const loopRe = /while\s*\(\s*offset\s*\)/g;
  let lm;
  while ((lm = loopRe.exec(code)) !== null) {
    // ループ本体は while の手前にある（do { ... } while (offset)）
    const before = code.slice(Math.max(0, lm.index - 2500), lm.index);
    const body = before.slice(Math.max(0, before.lastIndexOf('do')));
    if (!/CUSTOMERS_TABLE|['"`]Customers['"`]|\/Customers/.test(body)) continue;
    if (/filterByFormula/.test(body)) continue;
    // 上限で **throw / return** しているなら「完走するか落ちるか」。黙って消えない
    const cap = body.match(/pages\s*>=\s*[A-Za-z0-9_$]+[^\n]*/);
    if (!cap) continue;                 // 上限が無い = 打ち切らない（完走するかタイムアウト）
    const guard = body.slice(body.indexOf(cap[0]), body.indexOf(cap[0]) + 400);
    if (isFailClosed(guard)) continue;
    findings.push({
      file,
      line: lineOf(code, lm.index),
      why: 'Customers を無フィルタで回し、上限で黙って打ち切っている',
    });
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
