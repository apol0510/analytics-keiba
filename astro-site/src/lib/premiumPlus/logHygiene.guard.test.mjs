/**
 * logHygiene.guard.test.mjs — ログに機密が出ないことを source レベルで固定する。
 *   node --test src/lib/premiumPlus/logHygiene.guard.test.mjs
 *
 * 検知: Function / lib の console 出力に error.message / secret / token / cookie /
 * base64 画像 / request body / 完全な storage key を渡していないこと。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FN = fileURLToPath(new URL('../../../netlify/functions/premium-plus-media.js', import.meta.url));
const LIB_DIR = fileURLToPath(new URL('.', import.meta.url));

function consoleCalls(src) {
  // console.xxx( ... ) の引数部分をざっくり抽出
  return [...src.matchAll(/console\.\w+\(([^;]*)\)/g)].map((m) => m[1]);
}

test('Function の console はエラー種別(name)のみ・message を出さない', () => {
  const src = readFileSync(FN, 'utf8');
  const calls = consoleCalls(src);
  for (const c of calls) {
    assert.doesNotMatch(c, /error\.message|err\.message|\.stack/, `leak: ${c}`);
    assert.doesNotMatch(c, /secret|token|cookie|authorization|imageBase64|event\.body|adminSecret|SIGNING/i, `leak: ${c}`);
  }
  // error.name のみ許可されている（存在確認）
  assert.match(src, /error\s*&&\s*error\.name/);
});

test('premiumPlus lib の console 出力に機密を渡していない', () => {
  const files = readdirSync(LIB_DIR).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    for (const c of consoleCalls(src)) {
      assert.doesNotMatch(c, /secret|token|cookie|imageBase64|bytes|\.message|checksum|\bkey\b|payload/i, `${f}: leak: ${c}`);
    }
  }
});
