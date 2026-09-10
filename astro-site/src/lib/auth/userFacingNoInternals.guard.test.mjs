/**
 * userFacingNoInternals.guard.test.mjs — ユーザー向けの画面・メールに内部事情を書かない
 *   node --test src/lib/auth/userFacingNoInternals.guard.test.mjs
 *
 * ## 確定方針（2026-09-10 MK）
 *
 * > 今後、ユーザー向け画面・メールには、token消費、ブラウザ差、長押し、先読み、セッション等の
 * > 内部事情を原則出さず、「ユーザーが今すること／結果」だけを表示する方針として正本にも固定
 *
 * 経緯: ログイン周りの案内が「なぜそうなるか」の説明で膨らみ、
 * 読み手には**自分が何をすればいいのか分からない**状態になっていた。
 * 仕組みの説明は**ソースのコメントと docs** に置き、画面とメールには出さない。
 *
 * ここが見るのは「画面・メールに出る文字列」だけ。コメントは対象外
 * （＝理由はコメントに書いてよい）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** 内部事情の語。ユーザー向けの文言に出てはいけない */
const BANNED = [
  'トークン', 'token', 'Token',
  'セッション', 'Cookie', 'クッキー', 'localStorage', 'HttpOnly',
  '長押し', '先読み', 'プレビュー', 'キャッシュ', 'WKWebView',
  'メールアプリ内のブラウザ', 'メールアプリ内ブラウザ', '別のブラウザでは再度ログイン', '同じブラウザ',
  '消費されません', '使われません',
];

function assertClean(label, text) {
  const hit = BANNED.filter((w) => text.includes(w));
  assert.deepEqual(hit, [], `${label} に内部事情が出ている: ${hit.join(' / ')}`);
}

// ── /auth/verify（画面）────────────────────────────────────
test('/auth/verify の表示文言に内部事情が無い', () => {
  const page = read('../../pages/auth/verify.astro');
  const a = page.indexOf('<section class="verify-section">');
  const markup = page.slice(a, page.indexOf('</section>', a)).replace(/<!--[\s\S]*?-->/g, '');
  const assigned = [...page.matchAll(/(?:textContent|innerHTML)\s*=\s*([`'"][\s\S]*?[`'"]);/g)]
    .map((m) => m[1]).join('\n');
  assertClean('/auth/verify', markup + '\n' + assigned);
});

test('/auth/verify は「今すること」と「結果」を出す', () => {
  const page = read('../../pages/auth/verify.astro');
  assert.match(page, /ログインするには、下のボタンを押してください。/, '今することが無い');
  assert.match(page, /まもなくマイページへ移動します。/, '結果の案内が無い');
});

// ── /login（画面）──────────────────────────────────────────
test('/login の理由表示に内部事情が無い', () => {
  const page = read('../../pages/login.astro');
  const a = page.indexOf('const REASON_NOTICES');
  const b = page.indexOf('};', a);
  assert.ok(a > 0 && b > a, 'REASON_NOTICES を取り出せなかった');
  assertClean('/login の理由表示', page.slice(a, b));
});

// ── ログインメール ──────────────────────────────────────────
test('ログインメールの本文に内部事情が無い', () => {
  const fn = read('../../../netlify/functions/send-magic-link.js');
  const a = fn.indexOf('html: `');
  const b = fn.indexOf('`,', a);
  assert.ok(a > 0 && b > a, 'メール本文を取り出せなかった');
  assertClean('ログインメール', fn.slice(a, b));
});

test('ログインメールは「今すること」だけを書く', () => {
  const fn = read('../../../netlify/functions/send-magic-link.js');
  assert.match(fn, /開いた画面で「ログインする」を押してください/);
});
