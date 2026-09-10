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

// ── 2026-09-10 MK 指示で削除した「別ブラウザ」案内 ──────────────
//
// > 以下を削除→普段ご利用の Safari / Chrome などのブラウザでリンクを開いてください。…
// > 理由は現在必要ない文言だと思われる
//
// ログインメールと `/login/` の no_session 文面から削除した。
// 復活させないことをここで固定する（消したはずの文言が戻ると、また長い案内に戻るため）。
test('「no_session」の文面に別ブラウザの説明を戻していない', () => {
  const start = loginPage.indexOf('no_session: {');
  const block = loginPage.slice(start, loginPage.indexOf('session_expired: {'));
  assert.doesNotMatch(block, /メールアプリ内のブラウザ/);
  assert.doesNotMatch(block, /普段お使いのブラウザ/);
  // 本題（もう一度ログインしてほしい）は残っていること
  assert.match(block, /もう一度ログインしてください/);
});

test('ログインメールに別ブラウザの案内を戻していない', () => {
  assert.doesNotMatch(sendMagicLink, /普段ご利用の Safari \/ Chrome などのブラウザでリンクを開いてください/);
  assert.doesNotMatch(sendMagicLink, /メールアプリ内のブラウザで開くと、別のブラウザでは再度ログインが必要になる場合があります/);
  // コピー用 URL の案内自体は残す（別ブラウザで開きたい人の導線）
  assert.match(sendMagicLink, /以下のURLをコピーしてブラウザに貼り付けてください/);
});

// 2026-09-10 MK 確定方針: 画面には「今すること」と「結果」だけを出す。
// ブラウザ差の説明は成功画面からも外した（旧: 「このブラウザへのログインが完了しました」）。
test('/auth/verify 成功画面は結果だけを伝える', () => {
  assert.match(verifyPage, /status\.textContent = 'ログインしました'/);
  assert.match(verifyPage, /msg\.textContent = 'まもなくマイページへ移動します。'/);
  assert.doesNotMatch(verifyPage, /このブラウザへのログインが完了しました/);
  assert.doesNotMatch(verifyPage, /次回から同じブラウザのブックマークからアクセスできます/);
});

test('成功画面の自動遷移が短すぎず長すぎない', () => {
  const m = verifyPage.match(/const REDIRECT_DELAY_MS = (\d+);/);
  assert.ok(m, 'REDIRECT_DELAY_MS が無い');
  const ms = Number(m[1]);
  // 旧: 長い案内を読ませるため 5000ms 以上を強制していた。案内を外したので短くてよい。
  // ただし「ログインしました」が見えないほど短くしない。
  assert.ok(ms >= 1500 && ms <= 5000, `自動遷移 ${ms}ms は範囲外（1500〜5000ms）`);
});
