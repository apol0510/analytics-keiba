/**
 * freeSignupPaidMember.guard.test.mjs — /free-signup/ に有料会員のメールが入ったとき行き止まりにしない
 *   node --test src/lib/auth/freeSignupPaidMember.guard.test.mjs
 *
 * auth-user は有料会員に `requiresMagicLink: true`（success: false）を返す。以前は free-signup が
 * これを例外にして「登録に失敗しました」と出し、ログインへの導線が無かった（2026-10-27 診断）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const page = readFileSync(fileURLToPath(new URL('../../pages/free-signup.astro', import.meta.url)), 'utf8');

function branchAfter(marker, len = 900) {
  const i = page.indexOf(marker);
  assert.ok(i >= 0, `marker not found: ${marker}`);
  return page.slice(i, i + len);
}

test('requiresMagicLink はログイン案内を出して return し、エラーにしない', () => {
  const b = branchAfter('if (data.requiresMagicLink === true) {', 200);
  assert.match(b, /showMemberLoginGuide\(\);\s*return;/);
});

test('denied は「登録に失敗」と出さずサーバー文言を出して return する', () => {
  const b = branchAfter('if (data.denied === true) {', 300);
  assert.match(b, /showError\(data\.message/);
  assert.match(b, /return;/);
  assert.doesNotMatch(b, /登録に失敗/);
});

test('ログイン案内は /login/ へのリンクを持ち、メールアドレスを URL に載せない', () => {
  const m = /<div id="member-login-guide"[\s\S]*?<\/div>/.exec(page);
  assert.ok(m, 'member-login-guide がある');
  assert.match(m[0], /href="\/login\/"/);
  assert.doesNotMatch(m[0], /email=/);
});

test('案内は他のメッセージ表示で隠れる（成功・エラーと同時に出さない）', () => {
  for (const fn of ['function showSuccess(', 'function showError(']) {
    assert.match(branchAfter(fn, 400), /member-login-guide'\)\.style\.display = 'none'/);
  }
});
