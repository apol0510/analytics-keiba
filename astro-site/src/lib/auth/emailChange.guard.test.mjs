/**
 * emailChange.guard.test.mjs — メールアドレス変更の**危ない実装に戻らない**ことを強制する。
 *   node --test src/lib/auth/emailChange.guard.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** コメントを落とす。**説明文の中の語**を実装の証拠と取り違えないため。 */
const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const REQUEST = read('../../../netlify/functions/request-email-change.js');
const CONFIRM = read('../../../netlify/functions/confirm-email-change.js');
const STORE = read('./emailChangeStore.js');
const PAGE = read('../../pages/auth/change-email.astro');

test('申請の時点では Customers を書き換えない（確定まで何も変わらない）', () => {
  assert.doesNotMatch(REQUEST, /method:\s*'PATCH'/, '申請段階で PATCH している');
  assert.doesNotMatch(REQUEST, /method:\s*'POST'[\s\S]{0,200}api\.airtable\.com/, '申請段階で Airtable へ書いている');
});

test('現在のアドレスはサーバーがセッションから引く（クライアント申告を信じない）', () => {
  assert.match(REQUEST, /verifySession/, 'セッションを検証していない');
  assert.match(REQUEST, /Customers\/\$\{encodeURIComponent\(recordId\)\}/, 'recordId で現在の Email を引いていない');
  assert.doesNotMatch(REQUEST, /currentEmail\s*=\s*normalizeEmail\(body\./, 'body の申告値を現在のアドレスにしている');
});

test('確定は POST でしか行わない（メールの自動巡回で消費されない）', () => {
  assert.match(CONFIRM, /httpMethod !== 'POST'/, 'POST 以外を弾いていない');
  assert.match(PAGE, /confirmBtn/, 'ページが確定ボタンを持っていない');
  assert.match(PAGE, /method:\s*'POST'/, 'ページが POST していない');
});

test('確定で書き換えるのは Email 1 列だけ（契約・特典に触れない）', () => {
  const m = CONFIRM.match(/body: JSON\.stringify\(\{ fields: \{[^}]*\}/);
  assert.ok(m, 'PATCH の fields が見つからない');
  assert.match(m[0], /Email: nextEmail/);
  for (const f of ['プラン', 'PlanType', 'Status', '有効期限', 'LifetimeSanrenpuku', 'RequestedPlan', 'PaymentConfirmed']) {
    assert.ok(!m[0].includes(f), `Email 以外の列を書いている: ${f}`);
  }
});

test('確定時に重複と横取りを再確認する（申請〜確定の間に変わることがある）', () => {
  assert.match(CONFIRM, /nowEmail !== normalizeEmail\(currentEmail\)/, '申請後のアドレス変化を見ていない');
  assert.match(CONFIRM, /statusCode: 409/, '衝突を 409 で断っていない');
});

test('確認トークンは AuthTokens に入れない（ログイン用と混ぜない）', () => {
  for (const [name, src] of [['request', REQUEST], ['confirm', CONFIRM], ['store', STORE]]) {
    assert.ok(!/AuthTokens/.test(codeOf(src)),
      `${name} が AuthTokens を使っている（未確認アドレスでログインできてしまう）`);
  }
  assert.match(STORE, /GETDEL/, '単回使用になっていない');
});

test('障害を「無効なリンク」と言わない（再発行の無限ループを作らない）', () => {
  assert.match(CONFIRM, /unavailable \? 503 : 400/, '障害と期限切れを区別していない');
});
