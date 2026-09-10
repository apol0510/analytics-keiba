/**
 * verifyRequiresUserAction.guard.test.mjs — マジックリンクは「押したときだけ」使われる
 *   node --test src/lib/auth/verifyRequiresUserAction.guard.test.mjs
 *
 * ## なぜ要るか（2026-09-10 MK 指摘）
 *
 * > このリンクやボタン長押しでコピーするとログインリンクが使用されたことになり、
 * > 認証エラーになるんでこれは混乱します。
 *
 * `/auth/verify` は**開いた瞬間に**トークン検証を走らせていた。
 * iOS はリンクを長押ししただけでプレビューを描画し、その中で **JS を実行する**ため、
 * 「コピーしようとしただけ」でトークンが使用済みになり、貼り付けた先では必ず
 * 「このリンクは既に使用済みです」になった。メールのリンク検査ボットや先読みでも同じ。
 *
 * 確定仕様: **GET で `/auth/verify` を開いただけでは絶対に消費しない。**
 * 「ログインする」を押したときだけ `verify-magic-link` を呼ぶ。
 *
 * トークンの単回性・有効期限（サーバー側）は `verifyMagicLinkFlow.test.mjs` が守る。
 * ここは「いつ呼ぶか」だけを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const PAGE = read('../../pages/auth/verify.astro');
const MAIL = read('../../../netlify/functions/send-magic-link.js');

/** トークンを消費する唯一の通信 */

/**
 * 画面に出る文字列だけを集める。
 * ⚠️ ソース全体を検索すると**コメントに書いた説明**まで拾ってしまう。
 *    仕組みの説明はコメントに残す方針なので、markup と textContent / innerHTML の
 *    代入だけを対象にする。
 */
function renderedText() {
  const markupStart = PAGE.indexOf('<section class="verify-section">');
  const markupEnd = PAGE.indexOf('</section>', markupStart);
  const markup = PAGE.slice(markupStart, markupEnd).replace(/<!--[\s\S]*?-->/g, '');
  const assigned = [...PAGE.matchAll(/(?:textContent|innerHTML)\s*=\s*([`'"][\s\S]*?[`'"]);/g)]
    .map((m) => m[1]).join('\n');
  return markup + '\n' + assigned;
}

const CONSUME_CALL = 'fetch(`/.netlify/functions/verify-magic-link?token=';

test('トークンを消費する通信は 1 か所だけ', () => {
  const n = PAGE.split(CONSUME_CALL).length - 1;
  assert.equal(n, 1, `verify-magic-link の呼び出しが ${n} か所ある（1 か所に保つ）`);
});

test('消費はクリック用の関数の中でだけ行う（読み込み時に走らせない）', () => {
  const fnAt = PAGE.indexOf('async function verify()');
  assert.ok(fnAt > 0, 'クリック用の verify() が無い');
  const callAt = PAGE.indexOf(CONSUME_CALL);
  assert.ok(callAt > fnAt, '消費する通信が verify() の外にある（読み込み時に走ってしまう）');
});

test('検証はクリックでのみ起動する', () => {
  assert.match(PAGE, /btn\.addEventListener\('click', verify\)/, 'クリックで起動していない');
  // 自動起動に化ける書き方を禁止する
  assert.doesNotMatch(PAGE, /^\s*verify\(\);/m, 'verify() を直接呼んでいる（自動実行）');
  assert.doesNotMatch(PAGE, /btn\.click\(\)/, 'プログラムからクリックしている');
  for (const ev of ['DOMContentLoaded', 'load', 'pageshow', 'visibilitychange', 'focus']) {
    assert.doesNotMatch(
      PAGE, new RegExp(`addEventListener\\('${ev}'`),
      `${ev} で自動起動している（プレビュー／先読みで消費される）`,
    );
  }
});

test('スクリプト全体が読み込み時 await する形（async IIFE）に戻っていない', () => {
  // 以前は `(async () => { ... await fetch ... })()` で開いた瞬間に消費していた
  assert.doesNotMatch(PAGE, /\(async \(\) => \{/, '読み込み時に await する形へ戻っている');
});

test('「ログインする」ボタンが実在する', () => {
  assert.match(PAGE, /<button type="button" id="login-btn"/);
  assert.match(PAGE, /document\.getElementById\('login-btn'\)/);
  assert.match(PAGE, /ログインする<\/button>/);
});

// 2026-09-10 MK 確定方針: 内部事情（消費 / 長押し / 先読み）は画面に書かない。
// 「今すること」だけを出す。仕組みの説明はソースのコメントに置く。
test('確認画面は「今すること」だけを出す', () => {
  assert.match(PAGE, /ログインするには、下のボタンを押してください。/);
  for (const ng of ['押すまでリンクは使われません', '長押し', '先読み', 'トークンを確認しています']) {
    assert.ok(!renderedText().includes(ng), `画面に内部事情が出ている: ${ng}`);
  }
});

test('ログインメールが「開いた画面で押す」導線を案内している', () => {
  assert.match(MAIL, /開いた画面で「ログインする」を押してください/);
});

// 2026-09-10 MK 指示で削除した補足。**必要ない文言**として消したので、戻さない。
// 「押すまで使われない」ことは確認画面（このページ）に出ているので、メールでは繰り返さない。
test('削除した補足をログインメールへ戻していない', () => {
  assert.doesNotMatch(MAIL, /リンクを開いただけでは使われません/);
});
