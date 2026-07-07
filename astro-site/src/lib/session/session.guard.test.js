/**
 * session.guard.test.js — セッション共通ライブラリの再発防止 静的 guard（PR-A）
 *
 * ライブラリ本体（*.js、テスト除く）が「ランタイム非依存・鍵は引数注入・機密を出さない」
 * 制約を破らないことをソース上で固定する。コメントは除去して実コードだけ検査。
 *
 * 実行: node src/lib/session/session.guard.test.js （astro-site 直下から）
 */
import assert from 'assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ✅ ${name}`); } catch (e) { fail++; console.error(`  ❌ ${name}\n     ${e.message}`); } };

const DIR = 'src/lib/session';
const LIB_FILES = readdirSync(join(process.cwd(), DIR))
  .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
  .sort();

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}
const codeOf = (f) => stripComments(readFileSync(join(process.cwd(), DIR, f), 'utf-8'));

t('検査対象のライブラリファイルが存在する', () => {
  assert.ok(LIB_FILES.length >= 5, `lib files too few: ${LIB_FILES.join(',')}`);
  for (const need of ['index.js', 'crypto.js', 'payload.js', 'cookie.js', 'constants.js']) {
    assert.ok(LIB_FILES.includes(need), `${need} が無い`);
  }
});

t('process.env を直接参照しない', () => {
  for (const f of LIB_FILES) assert.ok(!/process\.env/.test(codeOf(f)), `${f} が process.env を参照`);
});
t('Deno.env を直接参照しない', () => {
  for (const f of LIB_FILES) assert.ok(!/Deno\.env/.test(codeOf(f)), `${f} が Deno.env を参照`);
});
t('Buffer に依存しない', () => {
  for (const f of LIB_FILES) {
    const c = codeOf(f);
    assert.ok(!/\bBuffer\b/.test(c), `${f} が Buffer を使用`);
    assert.ok(!/from\s+['"]buffer['"]|require\(\s*['"]buffer['"]\s*\)/.test(c), `${f} が buffer を import`);
  }
});
t('localStorage / document / window を参照しない', () => {
  for (const f of LIB_FILES) {
    const c = codeOf(f);
    assert.ok(!/\blocalStorage\b/.test(c), `${f} が localStorage を参照`);
    assert.ok(!/\bdocument\b/.test(c), `${f} が document を参照`);
    assert.ok(!/\bwindow\./.test(c), `${f} が window を参照`);
  }
});
t('fs を参照しない', () => {
  for (const f of LIB_FILES) {
    const c = codeOf(f);
    assert.ok(!/from\s+['"](node:)?fs['"]|require\(\s*['"](node:)?fs['"]\s*\)/.test(c), `${f} が fs を import`);
  }
});
t('デフォルト秘密鍵（埋め込み鍵）が無い', () => {
  for (const f of LIB_FILES) {
    const c = codeOf(f);
    assert.ok(!/\bsecret\b\s*=\s*['"]/i.test(c), `${f} に secret への文字列デフォルト代入`);
    assert.ok(!/\bsecret\b\s*\|\|\s*['"]/i.test(c), `${f} に secret の '||' 文字列フォールバック`);
    // 環境変数名の埋め込みも禁止（読み取りは呼び出し側=PR-B の責務）
    assert.ok(!/SESSION_SIGNING_SECRET/.test(c), `${f} に環境変数名を埋め込み`);
  }
});
t('console でログ出力しない（payload/secret 漏洩防止）', () => {
  for (const f of LIB_FILES) assert.ok(!/console\.[a-z]+\(/i.test(codeOf(f)), `${f} が console を使用`);
});
t('free plan を発行拒否する分岐が存在する（生成側）', () => {
  const idx = codeOf('index.js');
  assert.ok(/SESSION_CREATE_FREE_PLAN/.test(idx), 'index.js に free 発行拒否コードが無い');
  const pay = codeOf('payload.js');
  assert.ok(/FREE_PLAN/.test(pay), 'payload.js に free 検証拒否が無い');
});
t('検証は crypto.subtle.verify を使う（文字列比較でない）', () => {
  const cr = codeOf('crypto.js');
  assert.ok(/subtle\.verify/.test(cr), 'crypto.subtle.verify を使っていない');
  assert.ok(!/===\s*sig|sig\s*===|signature\s*===/.test(cr), '署名を文字列比較している疑い');
});

console.log(`\nsession.guard.test.js: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
