/**
 * inlineScriptNoTs.guard.test.mjs — インライン <script> に TypeScript を書かせない
 *   node --test src/lib/auth/inlineScriptNoTs.guard.test.mjs
 *   （`npm run test:auth-session` の glob に含まれ、check:safety / CI で強制実行される）
 *
 * ## 2026-08-09〜08-10 の本番障害（有料会員が誰もログインできない）
 *
 * `src/pages/auth/verify.astro` のスクリプトを
 *   `<script>` → `<script define:vars={{ TTL_MIN: ... }}>`
 * に変えた。**`define:vars` は `is:inline` を含意する**ため、Astro はそのブロックを
 * **トランスパイルもバンドルもせず、書いたままの文字列を HTML へ埋め込む**。
 * 中に残っていた TS の型注釈（`as HTMLDivElement` / `text: string`）が
 * そのままブラウザへ届き、`SyntaxError: Unexpected identifier 'as'` で
 * **スクリプト全体が 1 行も実行されない**状態になった。
 *
 * 画面は「認証中... トークンを確認しています。しばらくお待ちください。」のまま
 * 永久に止まる（エラー表示すら出ない）。verify-magic-link は呼ばれないので
 * サーバーログにも Airtable にも痕跡が残らず、発見が約 29 時間遅れた。
 *
 * ## このガードが守ること
 *
 * 1. インライン（`is:inline` / `define:vars`）スクリプトが **素の JS として構文解析できる**
 * 2. TS 固有構文（`as 型` / 引数の型注釈 / `<T>` アサーション）が混ざっていない
 *
 * 対象は `src/**\/*.astro` 全体。`is:inline` を付けない通常の `<script>` は
 * Astro が TS を落としてくれるので対象外（TS を書いてよい）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const SRC_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function listAstroFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listAstroFiles(full));
    else if (entry.endsWith('.astro')) out.push(full);
  }
  return out;
}

/** インライン扱いになる <script> ブロックだけを取り出す（src= / JSON-LD は除く）。 */
function extractInlineScripts(source) {
  const blocks = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const attrs = m[1];
    const body = m[2];
    if (!/\bis:inline\b|\bdefine:vars\b/.test(attrs)) continue; // Astro が処理する = TS 可
    if (/\bsrc\s*=/.test(attrs)) continue;                      // 外部ファイル（本文なし）
    if (/type\s*=\s*["'][^"']*json/i.test(attrs)) continue;      // JSON-LD 等
    if (body.trim() === '') continue;
    blocks.push({ attrs: attrs.trim(), body, index: m.index });
  }
  return blocks;
}

/** 素の JS として構文解析できるか（実行はしない）。top-level await も許容する。 */
function parseAsPlainJs(body) {
  try {
    new vm.Script(body);
    return null;
  } catch (e1) {
    try {
      // top-level await を含むだけのケースを誤検知しない
      new vm.Script(`(async () => {\n${body}\n})`);
      return null;
    } catch {
      return e1.message;
    }
  }
}

// TS 固有構文の代表例（メッセージを分かりやすくするための補助検知）
const TS_PATTERNS = [
  { re: /\bas\s+(HTML[A-Za-z]*Element|Element|Node|string|number|boolean|any|unknown|[A-Z][A-Za-z0-9_]*)\b/, label: '型アサーション `as 型`' },
  { re: /function\s+[A-Za-z0-9_$]*\s*\([^)]*[A-Za-z0-9_$]\s*:\s*(string|number|boolean|any|unknown|void|[A-Z][A-Za-z0-9_]*)/, label: '引数の型注釈 `arg: 型`' },
];

const astroFiles = listAstroFiles(SRC_ROOT);

test('走査対象の .astro が 0 件ではない（素通り防止）', () => {
  assert.ok(astroFiles.length > 0, `.astro が 1 件も見つからない: ${SRC_ROOT}`);
});

test('インライン <script> は素の JS として構文解析できる（TS を書かない）', () => {
  const violations = [];
  for (const file of astroFiles) {
    const source = readFileSync(file, 'utf8');
    for (const block of extractInlineScripts(source)) {
      const err = parseAsPlainJs(block.body);
      const ts = TS_PATTERNS.filter((p) => p.re.test(block.body)).map((p) => p.label);
      if (err || ts.length) {
        const line = source.slice(0, block.index).split('\n').length;
        violations.push(
          `${relative(SRC_ROOT, file)}:${line} <script ${block.attrs}>` +
            (ts.length ? ` TS構文: ${ts.join(' / ')}` : '') +
            (err ? ` 構文エラー: ${err}` : ''),
        );
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    'is:inline / define:vars のスクリプトは Astro がトランスパイルしない。' +
      'TS を書くとブラウザが SyntaxError でブロック全体を実行せず、画面が無言で固まる。\n' +
      violations.join('\n'),
  );
});

test('verify.astro のスクリプトが実際にインライン扱いである（前提の固定）', () => {
  const verifyPage = readFileSync(join(SRC_ROOT, 'pages/auth/verify.astro'), 'utf8');
  const blocks = extractInlineScripts(verifyPage);
  assert.ok(
    blocks.some((b) => /define:vars/.test(b.attrs) && /verify-magic-link/.test(b.body)),
    'verify.astro の検証スクリプトが define:vars（=インライン）で見つからない。' +
      '構成を変えたなら本テストの前提も更新すること。',
  );
});
