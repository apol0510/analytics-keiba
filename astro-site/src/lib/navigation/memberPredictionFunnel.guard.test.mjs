/**
 * memberPredictionFunnel.guard.test.mjs — 「会員が予想に辿り着けること」を守る静的 guard
 *   node --test src/lib/navigation/memberPredictionFunnel.guard.test.mjs
 *
 * ## なぜ必要か（2026-09-02 の Light 会員問い合わせ）
 *
 * > ライトプランですが今日のメインレース見れません
 *
 * 権利も当日データも正常だったのに、会員が予想へ到達できなかった。原因は導線:
 *
 *   A. 上部ナビ・スマホナビ・フッターに**有料予想への直リンクが 1 本も無い**
 *   B. マイページの表示が**localStorage だけ**で決まる
 *      （`isAuthenticated()` は 5 つのキーのいずれかが在るかを見るだけ）
 *   C. Light カードは**プラン文字列一致**でしか出ない（既定 display:none）
 *
 * A+B+C が重なると、`ak_session` が有効な有料会員でも、履歴を消しただけで
 * **サイト内から予想へ行く手段が全部消える**。
 *
 * DOM は評価せず、ソース文字列を検査する（`pageGuards.test.mjs` と同型）。
 * ここが落ちたときは「昔の localStorage 判定に戻していないか」を先に疑うこと。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd(); // astro-site
const read = (rel) => readFileSync(join(root, rel), 'utf8');

/**
 * コメントを落として**実コードだけ**にする。
 * このファイルが守る規約は説明を長く書くので、禁止語をコメントで説明した箇所を
 * 「復活した」と誤検知しないようにする（説明を書けなくなると規約が形骸化する）。
 */
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')   // /* */ と /** */（Astro の {/* */} も中身が消える）
  .replace(/^\s*\/\/.*$/gm, ' ');      // 行コメント

const DASHBOARD = 'src/pages/dashboard.astro';
const LAYOUT = 'src/layouts/BaseLayout.astro';
const ROUTER = 'src/pages/today.astro';
const REDIRECT_ONLY_PAGES = [
  'src/pages/light-predictions-urawa.astro',
  'src/pages/light-predictions-funabashi.astro',
];

// ── A. ナビから予想へ 1 本で行ける ──────────────────────────────
test('上部ナビとスマホナビの両方に「今日の予想」(/today/) がある', () => {
  const src = read(LAYOUT);
  const header = src.slice(src.indexOf('<ul class="nav-menu"'), src.indexOf('id="mobile-nav-menu"'));
  const mobile = src.slice(src.indexOf('id="mobile-nav-menu"'), src.indexOf('<footer'));
  for (const [name, part] of [['上部ナビ', header], ['スマホナビ', mobile]]) {
    assert.ok(part.includes('href="/today/"'), `${name} に /today/ が無い（会員が予想へ行けない）`);
    assert.ok(part.includes('今日の予想'), `${name} に「今日の予想」の文言が無い`);
  }
});

test('無料予想の入口を消していない（フッターかスマホナビに /free/ が残る）', () => {
  const src = read(LAYOUT);
  const afterHeader = src.slice(src.indexOf('id="mobile-nav-menu"'));
  assert.ok(afterHeader.includes('href="/free/"'), '無料予想の入口が消えている');
});

test('ナビは行き先をプランで分岐しない（分岐はサーバーの /today/ が持つ）', () => {
  const src = read(LAYOUT);
  const header = src.slice(src.indexOf('<ul class="nav-menu"'), src.indexOf('id="mobile-nav-menu"'));
  for (const paid of ['/light-predictions', '/premium-prediction']) {
    assert.ok(
      !header.includes(`href="${paid}`),
      `ナビが ${paid} を直接指している。localStorage 由来の分岐が復活すると、`
      + '履歴を消した会員に誤った行き先を見せる（行き先は /today/ に集約すること）',
    );
  }
});

// ── /today/ ルータ ────────────────────────────────────────────
test('/today/ は SSR で、単一源に委譲する', () => {
  assert.ok(existsSync(join(root, ROUTER)), '/today/ ルータが存在しない');
  const src = read(ROUTER);
  assert.match(src, /export const prerender = false/, '静的化すると全員が同じ行き先に固定される');
  assert.match(src, /resolveViewer\(/, '閲覧者の確定を単一源へ委譲していない');
  assert.match(src, /resolvePredictionDestination\(/, '行き先の決定を単一源へ委譲していない');
  assert.ok(!/localStorage/.test(codeOnly(src)), 'ルータが localStorage を読んでいる（サーバーで決めること）');
});

// ── B. マイページはサーバー権威 ─────────────────────────────────
test('マイページは SSR（静的 HTML に固定された会員状態を配らない）', () => {
  assert.match(read(DASHBOARD), /export const prerender = false/, 'マイページが静的に戻っている');
});

test('マイページはサーバーで閲覧者を確定し、権威値を渡す', () => {
  const src = read(DASHBOARD);
  assert.match(src, /resolveViewer\(/, 'サーバー側の閲覧者確定が無い');
  assert.match(src, /__AK_SERVER_AUTH__/, 'サーバー権威値を画面へ渡していない');
  assert.match(src, /viewFromEntitlements\(/, 'カード表示を権利から決めていない');
});

test('isAuthenticated がサーバー判定を先に見る（localStorage 単独判定へ戻さない）', () => {
  const src = read(DASHBOARD);
  const fn = src.slice(src.indexOf('function isAuthenticated()'));
  const body = fn.slice(0, fn.indexOf('\n        }'));
  assert.match(body, /isServerMember\(\)/, 'localStorage だけで「ログイン済み」を判定している');
  assert.ok(
    body.indexOf('isServerMember()') < body.indexOf("localStorage.getItem('user-plan')"),
    'サーバー判定より先に localStorage を見ている',
  );
});

test('localStorage が空でも会員なら描画データを組み立てられる', () => {
  const src = read(DASHBOARD);
  const fn = src.slice(src.indexOf('function getCachedCustomerData()'));
  const body = fn.slice(0, fn.indexOf('\n        }\n'));
  assert.match(body, /isServerMember\(\)/, 'サーバー由来の組み立て経路が無い（ログインフォームのまま止まる）');
});

// ── C. カードは権利で出す ──────────────────────────────────────
test('無料 / Light カードをプラン文字列だけで出し分けていない', () => {
  const src = read(DASHBOARD);
  const fn = src.slice(src.indexOf('function showPlanContent('));
  const body = fn.slice(0, fn.indexOf('\n        }\n'));
  assert.match(body, /showLightCard/, 'Light カードが権利で決まっていない');
  assert.match(body, /showFreeCard/, '無料カードが権利で決まっていない');
  // プラン文字列判定は「サーバー判定が無いときのフォールバック」としてのみ残す
  assert.match(body, /_byServer/, 'サーバー判定を優先する分岐が無い');
});

test('サーバー権威値に entitlements 全体やレコードを素通ししない', () => {
  const src = read(DASHBOARD);
  const block = src.slice(src.indexOf('const serverAuth = {'), src.indexOf('Astro.response.headers.set'));
  assert.ok(!/entitlements:/.test(block), 'entitlements をそのまま画面へ渡している');
  assert.ok(!/\.\.\.viewer/.test(block), 'viewer をスプレッドで素通ししている');
});

test('マイページを共有キャッシュへ載せない（別人へ配られるのを防ぐ）', () => {
  assert.match(read(DASHBOARD), /private, no-store/, 'Cache-Control が private, no-store でない');
});

// ── 会場別 Light ページは 301 のみ ──────────────────────────────
test('孤立していた Light 会場別ページは 301 のみ（予想を描画しない）', () => {
  for (const rel of REDIRECT_ONLY_PAGES) {
    const src = read(rel);
    assert.match(src, /Astro\.redirect\('\/light-predictions\/', 301\)/, `${rel}: 301 になっていない`);
    const code = codeOnly(src);
    for (const banned of ['pickLatestAndAdapt', 'AccessControl', 'gatePaidPage', 'bettingLines']) {
      assert.ok(!code.includes(banned), `${rel}: 予想描画（${banned}）が復活している`);
    }
  }
});

test('正規の Light ページは残っている（301 の行き先が消えていない）', () => {
  const src = read('src/pages/light-predictions.astro');
  assert.match(src, /gatePaidPage\(/, '正規 Light ページのサーバー認可が消えている');
  assert.match(src, /requiredPlan: 'standard'/, 'Light の要求権利が変わっている');
});
