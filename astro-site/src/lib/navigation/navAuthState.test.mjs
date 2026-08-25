/**
 * navAuthState.test.mjs — 「ナビでログイン中に見えるか」を全プランで固定する
 *
 * ## 直した不具合（2026-08-25 MK 指摘）
 *
 * ナビの判定が**小文字のプラン名しか知らず**、サーバーが保存する
 * `'Premium'` / `'Light'` / `'Premium Sanrenpuku'` などに一致しなかった。
 * その結果、マジックリンクで入った**有料会員が「未ログイン」扱い**になり、
 * ログアウトが出ないどころか「✨無料で始める」が表示されていた。
 *
 * ⚠️ プラン名を 1 つ足すたびにここへ書き足さなくて済むよう、
 *    判定は「ログインした事実があるか」だけを見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolveNavAuthState, readNavAuthState } from './navAuthState.js';

/** サーバー（verify-magic-link の displayPlanName）が実際に保存する値 */
const SERVER_PLANS = ['Light', 'Premium', 'Premium Sanrenpuku', 'Premium Plus', 'Premium Combo'];

const userPlan = (plan) => JSON.stringify({ email: 'a@example.com', plan });

test('サーバーが保存するプラン名すべてでログイン中と判定する', () => {
  for (const plan of SERVER_PLANS) {
    const a = resolveNavAuthState({ userPlanRaw: userPlan(plan) });
    assert.equal(a.loggedIn, true, `${plan} が未ログイン扱い（有料会員に「無料で始める」が出る）`);
    assert.equal(a.plan, plan, `${plan} のプラン名が失われている`);
  }
});

test('無料登録の経路（旧キー）でもログイン中と判定する', () => {
  // free-signup.astro / login.astro は user-plan と旧キーの両方を書く
  const both = resolveNavAuthState({
    userPlanRaw: JSON.stringify({ email: 'a@example.com', plan: 'free', nonAuthoritative: true }),
    legacyIsLoggedIn: 'true', legacyUserPlan: 'free',
  });
  assert.equal(both.loggedIn, true);
  // 旧キーしか無い古い端末も救う
  assert.equal(resolveNavAuthState({ legacyIsLoggedIn: 'true' }).loggedIn, true);
  assert.equal(resolveNavAuthState({ legacyUserPlan: 'Premium' }).loggedIn, true);
});

test('ログインしていない人はログイン中にしない', () => {
  for (const input of [
    {},
    { userPlanRaw: '' },
    { userPlanRaw: 'null' },
    { userPlanRaw: '{}' },                       // 中身が無い
    { userPlanRaw: '壊れたJSON' },
    { userPlanRaw: '[1,2,3]' },
    { legacyIsLoggedIn: 'false' },
    { legacyUserPlan: '   ' },
  ]) {
    const a = resolveNavAuthState(input);
    assert.equal(a.loggedIn, false, `未ログインのはず: ${JSON.stringify(input)}`);
    assert.equal(a.plan, '');
  }
});

test('プラン名が読めなくてもログインは失わない（表示だけ既定値）', () => {
  const a = resolveNavAuthState({ userPlanRaw: JSON.stringify({ email: 'a@example.com' }) });
  assert.equal(a.loggedIn, true);
  assert.equal(a.plan, 'Free');
});

test('localStorage が使えない環境でも落ちない', () => {
  const throwing = { getItem() { throw new Error('blocked'); } };
  assert.equal(readNavAuthState(throwing).loggedIn, false);
  assert.equal(readNavAuthState(null).loggedIn, false);
});

test('localStorage から読んで判定する（キー名を間違えない）', () => {
  const store = { 'user-plan': userPlan('Premium Sanrenpuku') };
  const a = readNavAuthState({ getItem: (k) => store[k] ?? null });
  assert.equal(a.loggedIn, true);
  assert.equal(a.plan, 'Premium Sanrenpuku');
});

// ── 画面側がこの単一源を使っていること ──────────────────
const LAYOUT = readFileSync(new URL('../../layouts/BaseLayout.astro', import.meta.url).pathname, 'utf8');

test('ナビは判定を自前で書かない（単一源を使う）', () => {
  assert.match(LAYOUT, /readNavAuthState/, '単一源を使っていない');
  // ⚠️ プラン名のべた書き比較が復活したら落とす（今回の不具合そのもの）。
  //    ただし**コメントは見ない**（説明の語まで禁止すると正しい実装が落ちる）。
  const code = LAYOUT.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /plan === 'premium'|plan === 'standard'/,
    'プラン名を画面で直接比較している（綴り違いで有料会員が未ログイン扱いになる）');
});

test('ログアウトはマイページの 1 実装だけ（ナビに不完全な実装を置かない）', () => {
  // ナビ版はサーバーの ak_session を消さず、localStorage も 5 個しか消していなかった
  assert.ok(!LAYOUT.includes('nav-logout'), 'ナビにログアウトを注入している');
  assert.doesNotMatch(LAYOUT, /window\.logout\s*=/, 'ナビに別のログアウト実装がある');

  const dash = readFileSync(new URL('../../pages/dashboard.astro', import.meta.url).pathname, 'utf8');
  assert.match(dash, /window\.logout\s*=/, 'マイページにログアウトが無い');
  assert.match(dash, /functions\/logout/, 'サーバーのセッションを消していない');
  assert.match(dash, /clearAuthLocalStorage/, '端末側のキーを消し切っていない');
});

test('ログイン中はナビから「マイページ」へ行ける（ログアウトへの唯一の入口）', () => {
  assert.match(LAYOUT, /id="nav-dashboard"[^>]*>\s*<a href="\/dashboard\/"/, 'PC ナビにマイページが無い');
  assert.match(LAYOUT, /id="mobile-nav-dashboard"[^>]*>\s*<a href="\/dashboard\/"/, 'スマホにマイページが無い');
});
