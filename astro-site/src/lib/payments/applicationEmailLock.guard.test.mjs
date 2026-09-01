/**
 * applicationEmailLock.guard.test.mjs — 入金完了報告フォームの取り違え防止が
 * **どのページでも外れていない**ことを強制する。
 *   node --test src/lib/payments/applicationEmailLock.guard.test.mjs
 *
 * 2026-09-01: フォームが 17 ページに複製されており、ログイン中のアドレスを
 * 初期値にしていたのは一部だけだった。本アドレスでログインしたままサブアドレスで
 * 申し込め、Customers に別レコードができて二重付与の一歩手前まで行った。
 * ページを増やすたびに取り残しが出るため、ここで網羅を検査する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url)); // astro-site/
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** src/pages 配下の .astro を再帰列挙 */
function pages(dir = join(ROOT, 'src/pages'), out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) pages(full, out);
    else if (name.endsWith('.astro')) out.push(relative(ROOT, full));
  }
  return out;
}

/** 入金完了報告フォームを持つページ（構造アンカー = 振込日の入力欄）*/
const formPages = pages().filter((rel) => /name="transferDate"|id="transferDate"/.test(read(rel)));

test('入金完了報告フォームを持つページが検出できている（素通り防止）', () => {
  assert.ok(formPages.length >= 10, `検出 ${formPages.length} ページは少なすぎる（セレクタが陳腐化した疑い）`);
});

test('フォームを持つ全ページでメール欄がロックされる（BaseLayout 経由 or 直接）', () => {
  const base = read('src/layouts/BaseLayout.astro');
  const viaBaseLayout = /BankApplicationEmailLock/.test(base);
  assert.ok(viaBaseLayout, 'BaseLayout が BankApplicationEmailLock を読み込んでいない');

  const missing = formPages.filter((rel) => {
    const src = read(rel);
    if (/BankApplicationEmailLock/.test(src)) return false;   // 直接読み込み
    return !/BaseLayout/.test(src);                            // BaseLayout 経由でもない
  });
  assert.deepEqual(missing, [],
    `メール欄のロックが効かないページがある: ${missing.join(', ')}`);
});

test('ロック部品は構造アンカーで探す（ページ固有 id に依存しない）', () => {
  const c = read('src/components/BankApplicationEmailLock.astro');
  assert.match(c, /\[name="transferDate"\]/, '振込日の入力欄をアンカーにしていない');
  assert.match(c, /readOnly = true/, 'メール欄を読み取り専用にしていない');
  assert.match(c, /dashboard/, 'マイページでの変更を案内していない');
  assert.match(c, /if \(!email\) return;/, '未ログイン時に何もしない保証が無い');
});

test('サーバー側の拒否が生きている（クライアントだけに頼らない）', () => {
  const fn = read('netlify/functions/bank-transfer-application.js');
  assert.match(fn, /decideApplicationEmail/, 'Function が判定の単一源を使っていない');
  assert.match(fn, /resolveSessionEmail\(event\)/, 'セッションからメールを引いていない');
  assert.match(fn, /statusCode: 403/, '不一致を拒否していない');
  assert.doesNotMatch(fn, /decideApplicationEmail\(\{\s*sessionEmail:\s*rawEmail/,
    'クライアント申告値をセッション扱いにしている');
});
