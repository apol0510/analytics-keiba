/**
 * loginReasonNotice.guard.test.mjs — 「なぜログイン画面に来たのか」を伝える経路の恒久条件
 *   node --test src/lib/auth/loginReasonNotice.guard.test.mjs
 *   （`npm run test:auth-session` の glob に含まれ、check:safety / CI で強制実行される）
 *
 * ── 背景（2026-08-09〜10 の問い合わせ）────────────────────────────
 * 有効な有料会員から「マジックリンクからは予想を見られるが、あとでブラウザから
 * 直接開くと再度メール認証を要求される」という報告が複数あった。
 * `ak_session` は **リンクを開いたブラウザのクッキー領域にしか入らない**ため、
 * メールアプリ内ブラウザで認証して後から Safari を開くと未ログインになる。
 * これは仕様どおりだが、画面にも文面にも説明が一切無く、
 * 利用者からは「ログインが保持されない不具合」に見えていた（最有力仮説・未確定）。
 *
 * さらに `gatePaidPage` は Cookie 無し・期限切れ・権利不足・**Airtable 一時障害**の
 * すべてを同じ `302 /login` に潰しており、利用者にも運用にも切り分けができなかった。
 *
 * ── ここで守る恒久条件 ──────────────────────────────────────────
 * 1. `/login` の理由表示コードが `paidPageGate` の公開コードと**過不足なく一致**する
 * 2. `/login` は URL の `?r=` を**そのまま描画しない**（固定文言を textContent で入れる）
 * 3. ログインメールと `/auth/verify` 成功画面に「同じブラウザで開く」案内がある
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { PUBLIC_LOGIN_REASON_CODES } from './paidPageGate.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const loginPage = read('../../pages/login.astro');
const verifyPage = read('../../pages/auth/verify.astro');
const sendMagicLink = read('../../../netlify/functions/send-magic-link.js');

/** login.astro の REASON_NOTICES に定義されているキーを抜き出す。 */
function noticeKeys(src) {
  const start = src.indexOf('const REASON_NOTICES');
  assert.ok(start > -1, 'login.astro に REASON_NOTICES が無い');
  const end = src.indexOf('showReasonNotice', start);
  assert.ok(end > start, 'login.astro の REASON_NOTICES の終端が見つからない');
  const block = src.slice(start, end);
  return [...block.matchAll(/^\s{4}([a-z_]+):\s*\{/gm)].map((m) => m[1]);
}

test('/login の理由コードが paidPageGate の公開コードと一致する', () => {
  const keys = noticeKeys(loginPage).sort();
  const codes = [...PUBLIC_LOGIN_REASON_CODES].sort();
  assert.deepEqual(keys, codes,
    'gate が出すコードと /login が表示できるコードがズレている。'
    + `gate=${codes.join(',')} / login=${keys.join(',')}`);
});

test('/login は ?r= の値をそのまま画面に出さない', () => {
  // allow-list に無いコードは何も表示しない実装であること
  assert.match(loginPage, /hasOwnProperty\.call\(REASON_NOTICES, code\)/,
    'allow-list 判定が無い（未知の値を表示しうる）');
  assert.match(loginPage, /if \(!notice\) return;/, '未知コードで早期 return していない');
  // 文言の流し込みは textContent のみ（innerHTML に URL 由来の値を混ぜない）
  const start = loginPage.indexOf('function showReasonNotice');
  const block = loginPage.slice(start, loginPage.indexOf('const form ='));
  assert.ok(!/innerHTML/.test(block), '理由表示に innerHTML を使っている（注入経路になる）');
  assert.match(block, /textContent = notice\.title/);
  assert.match(block, /textContent = notice\.body/);
});

test('別ブラウザ問題の案内が「no_session」の文面に含まれる', () => {
  const start = loginPage.indexOf('no_session: {');
  const block = loginPage.slice(start, loginPage.indexOf('session_expired: {'));
  assert.match(block, /メールアプリ内のブラウザ/, '別ブラウザ問題に触れていない');
  assert.match(block, /普段お使いのブラウザ/);
});

test('ログインメールに「普段使うブラウザで開く」案内がある', () => {
  assert.match(sendMagicLink, /普段ご利用の Safari \/ Chrome などのブラウザでリンクを開いてください/);
  assert.match(sendMagicLink, /メールアプリ内のブラウザで開くと、別のブラウザでは再度ログインが必要になる場合があります/);
});

test('/auth/verify 成功画面が「このブラウザにログインした」と伝える', () => {
  assert.match(verifyPage, /このブラウザへのログインが完了しました/);
  assert.match(verifyPage, /次回から同じブラウザのブックマークからアクセスできます/);
});

test('成功画面の自動遷移が案内を読める長さある（3秒に戻さない）', () => {
  const m = verifyPage.match(/const REDIRECT_DELAY_MS = (\d+);/);
  assert.ok(m, 'REDIRECT_DELAY_MS が無い');
  assert.ok(Number(m[1]) >= 5000,
    `自動遷移 ${m[1]}ms は案内を読み切れない（5000ms 以上にすること）`);
  // 表示秒数は定数から出す（文言と実挙動がズレないこと）
  assert.match(verifyPage, /Math\.round\(REDIRECT_DELAY_MS \/ 1000\)\}秒後に/);
});
