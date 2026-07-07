/**
 * staticGuards.test.mjs — セッションライブラリのランタイム非依存性・非漏洩の静的 guard
 *   node --test src/lib/auth/staticGuards.test.mjs
 *
 * ライブラリ本体（*.js, テスト除く）のソースを走査し、以下の再発を防ぐ:
 *   - process.env / Deno.env 直接参照なし
 *   - Buffer 必須依存なし
 *   - localStorage / document / window 参照なし
 *   - fs / node: / require 参照なし（ランタイム固有 API を本体へ import しない）
 *   - デフォルト秘密鍵文字列なし
 *   - console.* で payload / secret を出していない（この層は一切 console を使わない）
 *   - free plan で発行可能な分岐がない（有料ガードが構造的に存在する）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = import.meta.dirname;

/** 本体ソース（テスト *.test.mjs を除く .js） */
const LIB_FILES = readdirSync(DIR)
  .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
  .sort();

/** コメントを除去したコード本体を返す（説明コメント中の語で誤検知しないため）。 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // ブロックコメント
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1'); // 行コメント（:// は温存）
}

function read(f) {
  return stripComments(readFileSync(`${DIR}/${f}`, 'utf8'));
}

test('本体ファイルが検出できている（素通り防止）', () => {
  assert.ok(LIB_FILES.length >= 7, `expected >= 7 lib files, got ${LIB_FILES.length}: ${LIB_FILES}`);
});

const FORBIDDEN = [
  ['process.env 直接参照', /process\.env/],
  ['Deno.env 直接参照', /Deno\.env/],
  ['Buffer 依存', /\bBuffer\b/],
  ['localStorage 参照', /\blocalStorage\b/],
  ['document 参照', /\bdocument\b/],
  ['window 参照', /\bwindow\b/],
  ['node: import', /from\s+['"]node:/],
  ['require() 使用', /\brequire\s*\(/],
  ['fs import', /from\s+['"](node:)?fs['"]/],
  ['console.* 使用（payload/secret 漏洩防止）', /\bconsole\.\w+\s*\(/],
];

for (const file of LIB_FILES) {
  const src = read(file);
  for (const [label, re] of FORBIDDEN) {
    test(`${file}: ${label} が無い`, () => {
      assert.equal(re.test(src), false, `${file} に禁止パターン (${label}) が見つかりました`);
    });
  }
}

test('デフォルト秘密鍵文字列を埋め込んでいない', () => {
  for (const file of LIB_FILES) {
    const src = read(file);
    // secret を文字列リテラルへフォールバックしていない（例: secret || 'xxx' / secret ?? "xxx"）
    assert.equal(
      /secret\s*(\|\||\?\?)\s*['"`]/i.test(src),
      false,
      `${file}: secret の文字列フォールバックを検出`,
    );
    // DEFAULT_SECRET / SIGNING_SECRET = '...' のようなハードコード鍵なし
    assert.equal(
      /(DEFAULT_SECRET|SIGNING_SECRET|SESSION_SECRET)\s*=\s*['"`]/i.test(src),
      false,
      `${file}: ハードコード秘密鍵を検出`,
    );
  }
});

test('free plan の有料ガードが構造的に存在する（発行経路）', () => {
  const payloadSrc = read('sessionPayload.js');
  // buildPayload / validatePayload の双方で isPaidPlan による free 拒否がある
  assert.match(payloadSrc, /isPaidPlan\(/);
  assert.match(payloadSrc, /FREE_PLAN/);
  // createSession は buildPayload を経由（free を直接組み立てる別経路が無い）
  const sessionSrc = read('session.js');
  assert.match(sessionSrc, /buildPayload\(/);
});
