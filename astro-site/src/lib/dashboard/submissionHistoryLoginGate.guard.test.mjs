/**
 * submissionHistoryLoginGate.guard.test.mjs — 申請・送信履歴を**ログイン前に見せない**
 *
 * ## 2026-09-08 MK 報告
 *
 * > ログイン前から申請送信履歴が表示されてしまっている
 *
 * `#submission-history-section` は `#dashboard-section` の**外**にあり、
 * 「ログイン状態に関わらず表示」というコメント付きで初期表示のまま置かれていた。
 *
 * 記録は端末の localStorage にあり、**送り主が分からない記録は消さない**方針
 * （ログイン前の送信を失わせないため / `submissionHistoryOwner.test.mjs`）。
 * つまり未ログインでも中身が出うる。端末を共有していれば、前の方の申込が
 * ログインしていない人の目に入る。
 *
 * ## 直し方（この 2 つを固定する）
 *
 * | | 何を守るか |
 * |---|---|
 * | 既定は `display: none` | 認証が確定する前・未認証のとき（**fail closed**）|
 * | 表示は dashboard-section と同じ 1 か所 | ログイン判定をここで作らない |
 *
 * ⚠️ 記録を**消す**変更ではない。ログインすれば従来どおり自分の記録が見える。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../../pages/dashboard.astro', import.meta.url).pathname, 'utf8');
/** コメントを除いたコード（説明の語で誤検知しない） */
const code = page.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('【重要】履歴セクションの既定は非表示（未ログインに出さない）', () => {
  const m = code.match(/<div id="submission-history-section"[^>]*>/);
  assert.ok(m, '#submission-history-section が見つからない');
  assert.match(m[0], /style="display:\s*none;?"/,
    '既定が非表示になっていない。未ログインの端末に前の方の申込が見える');
});

test('【重要】履歴を出すのはログイン確定と同じ箇所だけ', () => {
  // dashboard-section を出す行と、履歴を出す行が同じ処理に入っていること
  const i = code.indexOf("getElementById('dashboard-section').style.display = 'block'");
  assert.ok(i > 0, 'dashboard-section を表示する箇所が見つからない');
  const near = code.slice(i, i + 400);
  assert.match(near, /submission-history-section/,
    'ログイン確定の箇所で履歴を表示していない（別のログイン判定を作っていないか確認）');
});

test('履歴を表示する箇所は 1 か所だけ（判定を増やさない）', () => {
  const shows = code.match(/submission-history-section'\)[\s\S]{0,80}?style\.display\s*=/g) || [];
  assert.equal(shows.length, 1,
    `履歴の表示切替が ${shows.length} か所ある。ログイン判定が分散するとまたズレる`);
});

test('「ログイン状態に関わらず表示」に戻していない', () => {
  assert.doesNotMatch(page, /申請・送信履歴（ログイン状態に関わらず表示）/,
    '常時表示の実装に戻っている');
});

test('記録そのものを消す実装になっていない（ログインすれば自分の記録は見える）', () => {
  // 表示を切り替えるだけ。履歴キーを消す処理をこのセクション用に足していないこと
  const i = code.indexOf("getElementById('submission-history-section')");
  const near = code.slice(i, i + 300);
  assert.doesNotMatch(near, /removeItem|clearSubmissionHistory/,
    '表示を隠すついでに記録を消している（ログイン前の送信が失われる）');
});
