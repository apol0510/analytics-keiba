/**
 * 決済後のログイン案内（2026-11-02 MK 確定）: 利用開始メールは送らない（2026-10-22 仕様）ので、
 * カード（PayPal 定期課金）経路の文言で「決済するとログインリンクが自動で届く」と読める表現を出さない。
 * ログイン画面で入力したときに届くマジックリンク（認証）は従来どおり。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SUBSCRIPTION_RETURN_GUEST as g } from './subscriptionReturnCopy.js';

const pricing = readFileSync(fileURLToPath(new URL('../../../pages/pricing.astro', import.meta.url)), 'utf8');

// 自動送信を約束していた旧表現（2026-11-02 まで）
const AUTO_SEND = [/ログインリンクをこのアドレスへお送りします/, /ログインはメールでお送りするリンクから/];

test('料金ページのカード申込（メール入力・FAQ）は、決済でログインリンクが自動送信されると書かない', () => {
  for (const re of AUTO_SEND) assert.doesNotMatch(pricing, re);
  // メール入力欄の注記（決済の直前）: このアドレスでログインして使えることだけを書く。
  // 「届きません」のような打ち消しの注記は決済前に出さない（共通 A-3・入力欄で 6 人中 5 人が離脱・GA4 11/12〜11/26）。
  // ログイン画面での手順は決済完了の戻り先（下の test）で案内する。
  assert.match(pricing, /お申し込み後は、このメールアドレスでログインしてすぐにご利用いただけます。/);
  assert.doesNotMatch(pricing, /決済後にメールは自動では届きません/);
  // FAQ: 自動遷移（2026-10-22 仕様）と、未ログインはログイン画面で入力
  assert.match(pricing, /Premium の利用画面へ自動でご案内します/);
  assert.match(pricing, /ログイン画面でお申し込みのメールアドレスを入力し、届いたログインリンクからログイン/);
});

test('決済完了（未ログイン）の戻り先は、メールが自動では届かないことと入力の手順を出す', () => {
  assert.match(g.activeNext, /メールは自動では届きません/);
  assert.match(g.activeNext, /ログイン画面でお申し込みのメールアドレスを入力/);
  for (const t of [g.activeNext, g.loginRequired.text, g.timeoutText]) {
    for (const re of AUTO_SEND) assert.doesNotMatch(t, re);
    assert.doesNotMatch(t, /(お送りしました|送信しました)/);
  }
});
