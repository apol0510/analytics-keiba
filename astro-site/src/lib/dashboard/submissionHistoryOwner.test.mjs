/**
 * submissionHistoryOwner.test.mjs — 申請・送信履歴を**他の人に見せない**
 *
 * ## 2026-08-27 MK 報告
 *
 * > 有料会員からログアウトして無料でログインしても申請送信履歴が残ってしまっている
 *
 * 記録は端末の localStorage にあり、これまで**誰のものか**を見ていなかった。
 * そのため、端末を共有していると前の方の**商品名・金額**が次の人に見えていた。
 *
 * ## 2 段で塞ぐ
 *
 * | | 何を守るか |
 * |---|---|
 * | ログアウトで消す | 通常の経路（ログアウト → 別の方がログイン）|
 * | 表示時に本人のものだけへ絞る | すでに端末へ残っている記録／ログアウトを挟まない切替 |
 *
 * ⚠️ 送り主が分からない記録は消さない（ログイン前の送信を失わせない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url).pathname, 'utf8');

/** 公開 JS を localStorage ごと動かして、**実際の挙動**を見る */
function load(store = {}) {
  const src = read('../../../public/js/submission-result.js');
  const win = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  new Function('window', 'localStorage', 'document', src)(win, localStorage, { getElementById: () => null });
  return { SR: win.SubmissionResult, store };
}

const PAID = 'paid@example.com';
const FREE = 'free@example.com';
const HISTORY = [
  { id: '1', type: 'bank-transfer', status: 'pending', label: '銀行振込お申し込み: Premium Plus 8月23日分 (¥68,000)', details: { email: PAID } },
  { id: '2', type: 'contact', status: 'sent', label: 'お問い合わせ: 予想について', details: { email: FREE } },
  { id: '3', type: 'submission', status: 'sent', label: '送信', details: {} },
];
const seeded = (viewer) => {
  const store = { 'submission-history': JSON.stringify(HISTORY) };
  if (viewer) store['user-plan'] = JSON.stringify({ email: viewer, plan: 'free' });
  return load(store);
};

test('別の方の記録は見せない（今回の報告そのもの）', () => {
  const { SR } = seeded(FREE);
  const ids = SR.getVisibleSubmissionHistory().map((e) => e.id);
  assert.ok(!ids.includes('1'), '前の会員の申込（商品名・金額）が見えている');
  assert.deepEqual(ids, ['2', '3']);
});

test('自分の記録は残る', () => {
  const { SR } = seeded(PAID);
  assert.deepEqual(SR.getVisibleSubmissionHistory().map((e) => e.id), ['1', '3']);
});

test('大文字・空白の違いで別人にしない', () => {
  const { SR } = seeded('  PAID@Example.COM ');
  assert.ok(SR.getVisibleSubmissionHistory().map((e) => e.id).includes('1'), '本人の記録が消えている');
});

test('送り主が分からない記録は消さない（ログイン前の送信）', () => {
  const { SR } = seeded(PAID);
  assert.ok(SR.getVisibleSubmissionHistory().map((e) => e.id).includes('3'));
});

test('未ログインのときは従来どおり（ログアウトで消えるので隠す必要が無い）', () => {
  const { SR } = seeded(null);
  assert.equal(SR.getVisibleSubmissionHistory().length, 3);
});

test('user-plan が壊れていても落ちない', () => {
  const { SR } = load({ 'submission-history': JSON.stringify(HISTORY), 'user-plan': '壊れたJSON' });
  assert.equal(SR.currentViewerEmail(), '');
  assert.equal(SR.getVisibleSubmissionHistory().length, 3);
});

test('旧キー userEmail しか無い端末でも本人判定できる', () => {
  const { SR } = load({ 'submission-history': JSON.stringify(HISTORY), userEmail: PAID });
  assert.equal(SR.currentViewerEmail(), PAID);
  assert.deepEqual(SR.getVisibleSubmissionHistory().map((e) => e.id), ['1', '3']);
});

// ── ログアウトで消す ────────────────────────────────────
test('ログアウトで履歴を消す（単一源に入っている）', () => {
  const page = read('../../pages/dashboard.astro');
  const i = page.indexOf('const AUTH_LOCALSTORAGE_KEYS');
  assert.ok(i > 0, '消すキーの単一源が無い');
  const list = page.slice(i, page.indexOf('];', i));
  assert.match(list, /'submission-history'/, 'ログアウトしても履歴が残る');
});

test('マイページは本人のぶんだけを描く', () => {
  const page = read('../../pages/dashboard.astro');
  const i = page.indexOf('var SR = window.SubmissionResult;');
  const body = page.slice(i, i + 600);
  assert.match(body, /getVisibleSubmissionHistory/, '全件を描いている');
  // 古い /js/submission-result.js がキャッシュに残っていても壊さない
  assert.match(body, /SR\.getVisibleSubmissionHistory \?/, '関数が無い場合に落ちる');
});
