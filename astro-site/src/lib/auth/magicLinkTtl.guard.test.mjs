/**
 * magicLinkTtl.guard.test.mjs — マジックリンク有効期限の単一源を強制する
 *   node --test src/lib/auth/magicLinkTtl.guard.test.mjs
 *
 * 2026-08-09 の障害:
 *   有効期限が 15 分だったため、Yahoo 側の配信遅延（実測 21〜75 分の滞留）で
 *   **届いた時点でトークンが期限切れ**になり、有料会員がログインできなかった。
 *   同時刻の gmail / docomo / au は遅延 0%。yahoo.co.jp / ymail.ne.jp だけで発生。
 *
 * send-magic-link.js は CommonJS で ESM の定数を import できないため、
 * 値が 2 箇所に存在する。**ズレると案内分数と実際の期限が食い違う**ので、
 * ここで一致を強制する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MAGIC_LINK_TTL_MINUTES, MAGIC_LINK_TTL_MS } from './constants.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const sender = read('../../../netlify/functions/send-magic-link.js');
const verifyPage = read('../../pages/auth/verify.astro');
const loginPage = read('../../pages/login.astro');
const paymentEmail = read('../payments/paymentConfirmationEmail.js');

test('ESM 定数の分とミリ秒が整合する', () => {
  assert.equal(MAGIC_LINK_TTL_MS, MAGIC_LINK_TTL_MINUTES * 60 * 1000);
});

test('send-magic-link.js の TTL が ESM 定数と一致する', () => {
  const m = sender.match(/const MAGIC_LINK_TTL_MINUTES\s*=\s*(\d+)\s*;/);
  assert.ok(m, 'send-magic-link.js に MAGIC_LINK_TTL_MINUTES が無い');
  assert.equal(Number(m[1]), MAGIC_LINK_TTL_MINUTES,
    `送信側 ${m[1]} 分 と 定数 ${MAGIC_LINK_TTL_MINUTES} 分 がズレている`);
});

test('送信側は定数から期限を計算する（数値の直書きをしない）', () => {
  assert.match(sender, /new Date\(Date\.now\(\) \+ MAGIC_LINK_TTL_MS\)/);
  assert.doesNotMatch(sender, /Date\.now\(\)\s*\+\s*15\s*\*\s*60\s*\*\s*1000/,
    '15 分が直書きで残っている');
});

test('メール文面の分数も定数から出す（直書きしない）', () => {
  assert.match(sender, /\$\{MAGIC_LINK_TTL_MINUTES\}分間有効/);
  assert.doesNotMatch(sender, /このリンクは\s*15\s*分間有効/);
});

test('期限切れ画面の分数も定数から出す', () => {
  assert.match(verifyPage, /define:vars=\{\{\s*TTL_MIN:\s*MAGIC_LINK_TTL_MINUTES\s*\}\}/);
  assert.match(verifyPage, /有効期限（\$\{TTL_MIN\}分）/);
  assert.doesNotMatch(verifyPage, /有効期限（15分）/, '15 分が直書きで残っている');
});

test('ログイン画面の送信完了メッセージも定数から出す（直書きしない）', () => {
  // 2026-08-23 の問い合わせ: 送信側 TTL は 60 分なのに、この画面だけ「15分以内」と
  // 直書きしていた。キャリアメールの配信遅延で「もう切れた」と誤認させ、
  // リンクを開かずに離脱する原因になる。
  //
  // ⚠️ verify.astro と違い `define:vars` は使えない（下のテストで固定）。
  //    このページのスクリプトは TS を含む通常 <script> なので、data 属性で受け渡す。
  assert.match(loginPage, /import \{ MAGIC_LINK_TTL_MINUTES \} from '\.\.\/lib\/auth\/constants\.js'/,
    'login.astro が MAGIC_LINK_TTL_MINUTES を import していない');
  assert.match(loginPage, /data-ttl-min=\{MAGIC_LINK_TTL_MINUTES\}/,
    '定数を data-ttl-min で渡していない');
  assert.match(loginPage, /Number\(form\.dataset\.ttlMin\)/,
    'スクリプトが data-ttl-min を読んでいない');
  assert.doesNotMatch(loginPage, /のメールを\s*\d+\s*分以内/,
    '分数が直書きで残っている');
});

test('login.astro のスクリプトは define:vars にしない（TS を含むため）', () => {
  // `define:vars` は `is:inline` を含意し、Astro が TS を落とさない。
  // このページのスクリプトは型注釈を含むので、付けた瞬間に SyntaxError で
  // フォームが 1 行も動かなくなる（2026-08-09 verify.astro 障害と同型）。
  assert.doesNotMatch(loginPage, /<script[^>]*define:vars/,
    'login.astro の <script> に define:vars が付いている');
});

test('入金確認メールの分数も定数から出す（直書きしない）', async () => {
  // 2026-09-01 の問い合わせ: 2026-08-09 に TTL を 15→60 分へ延ばした際、
  // 入金確認メール（v2）だけ 15 のまま取り残され、実際より短い時間を案内していた。
  // 有料化した直後の会員が最初に読むメールなので、ここがズレると
  // 「もう期限切れだ」と誤認してログインを諦める。
  assert.match(paymentEmail, /import \{ MAGIC_LINK_TTL_MINUTES \} from '\.\.\/auth\/constants\.js'/,
    'paymentConfirmationEmail.js が単一源を import していない');
  assert.doesNotMatch(paymentEmail, /export const MAGIC_LINK_TTL_MIN\s*=\s*\d+\s*;/,
    'MAGIC_LINK_TTL_MIN に数値が直書きされている');

  const { MAGIC_LINK_TTL_MIN, buildPaymentConfirmationEmail } = await import('../payments/paymentConfirmationEmail.js');
  assert.equal(MAGIC_LINK_TTL_MIN, MAGIC_LINK_TTL_MINUTES,
    `入金確認メール ${MAGIC_LINK_TTL_MIN} 分 と 定数 ${MAGIC_LINK_TTL_MINUTES} 分 がズレている`);

  // 本文（HTML / text 両方）に実際の分数が出ることまで確認する。
  const mail = buildPaymentConfirmationEmail({ plan: 'Light', planType: 'Monthly', expiration: '2026-10-01' });
  assert.ok(mail.html.includes(`${MAGIC_LINK_TTL_MINUTES}分間`), 'HTML 本文に有効時間が出ていない');
  assert.ok(mail.text.includes(`${MAGIC_LINK_TTL_MINUTES}分間`), 'text 本文に有効時間が出ていない');
});

test('配信遅延に耐える長さがある（30 分以上）', () => {
  // 2026-08-09 の実測滞留は最大 75 分。最低でも 30 分は必要。
  assert.ok(MAGIC_LINK_TTL_MINUTES >= 30,
    `TTL ${MAGIC_LINK_TTL_MINUTES} 分は配信遅延に耐えられない`);
});

test('無期限にはしない（単回使用でも上限は設ける）', () => {
  assert.ok(MAGIC_LINK_TTL_MINUTES <= 24 * 60, 'TTL が長すぎる');
});
