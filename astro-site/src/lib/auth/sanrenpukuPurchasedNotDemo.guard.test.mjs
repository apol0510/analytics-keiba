/**
 * sanrenpukuPurchasedNotDemo.guard.test.mjs
 *   node --test src/lib/auth/sanrenpukuPurchasedNotDemo.guard.test.mjs
 *
 * ## 守る要件
 *
 *   **三連複を購入した方に、三連複の無料体験ページを見せない。**
 *
 * ## 事故（2026-09-02・顧客申告）
 *
 * 三連複を買い切りで購入した会員がマイページの「南関 三連複を見る」を押すと、
 * `/premium-sanrenpuku/` が `/sanrenpuku-demo/`（無料体験）へリダイレクトしていた。
 * 中央（`/premium-sanrenpuku-jra/`）は同じスクリプトを持たないため正常だった。
 *
 * 原因は **判定を `plan` 文字列だけで行っていたこと**。三連複は買い切りの追加権で、
 * 承認時に書かれるのは `LifetimeSanrenpuku=true` だけ（`プラン` は 'Premium' のまま。
 * `payments/bankPaymentFlow.js` の `buildConfirmationFields`）。
 * よって `plan === 'Premium'` を「三連複 未購入」と読むと購入者を締め出す。
 *
 * このファイルは**同じ読み違いが別の場所で再発しないこと**を静的に固定する。
 * 認可そのものの検証は `sanrenpukuLifetimeAccess.test.mjs`（サーバー 3 層）にある。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isFunnelTarget, planSanrenpukuDisplay } from '../sanrenpuku/sanrenpukuCtaStage.js';

const root = process.cwd(); // astro-site
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const SRP_NANKAN = 'src/pages/premium-sanrenpuku.astro';
const SRP_JRA = 'src/pages/premium-sanrenpuku-jra.astro';
const DEMO = 'src/pages/sanrenpuku-demo.astro';
const PREMIUM_PAGES = ['src/pages/premium-prediction/nankan.astro', 'src/pages/premium-prediction/jra.astro'];

// ── 1. 有料三連複ページが無料体験へ飛ばさない ──────────────────────
test('三連複ページ（南関・中央）は無料体験ページへリダイレクトしない', () => {
  for (const rel of [SRP_NANKAN, SRP_JRA]) {
    const src = read(rel);
    assert.ok(!/sanrenpuku-demo/.test(src),
      `${rel}: 有料三連複ページから無料体験ページへの導線が復活している`);
  }
});

test('南関三連複の本文が localStorage の plan 文字列で隠されていない', () => {
  const src = read(SRP_NANKAN);
  assert.match(src, /<div id="sanrenpuku-content" class="page-container">/,
    '本文コンテナに display:none が戻っている（表示がクライアント判定に依存する）');
  assert.ok(!/getElementById\('sanrenpuku-content'\)/.test(src),
    '本文の表示/非表示をスクリプトで切り替えている（AccessControl と二重判定になる）');
  assert.ok(!/localStorage\.getItem\('user-plan'\)/.test(src),
    'ページ独自に user-plan を読んでいる（三連複の買い切り権を見落とす 3 つ目の判定）');
});

// ── 2. 認可は 2 層（サーバー + AccessControl）で、南関・中央が同じ構造 ────
test('南関・中央とも サーバー側 gatePaidPage と AccessControl の 2 層で認可する', () => {
  for (const rel of [SRP_NANKAN, SRP_JRA]) {
    const src = read(rel);
    assert.match(src, /export const prerender = false;/, `${rel}: SSR 化が外れている`);
    assert.match(src, /gatePaidPage\(/, `${rel}: サーバー側認可が無い`);
    assert.match(src, /<AccessControl requiredPlan="Premium Sanrenpuku">/, `${rel}: AccessControl が無い`);
  }
});

// ── 3. 無料体験ページ側も買い切り購入者を通さない ────────────────────
test('無料体験ページは買い切り購入者（lifetimeSanrenpuku）を有料ページへ戻す', () => {
  const src = read(DEMO);
  assert.match(src, /lifetimeSanrenpuku === true/,
    '買い切り購入者を plan 文字列だけで判定している（購入済みの方に無料体験を見せる）');
});

// ── 4. 追加購入 CTA を購入済みの方に出さない ─────────────────────────
test('isFunnelTarget は買い切り購入者を funnel 対象から外す', () => {
  // 事故当時の実データの形: プラン=Premium + LifetimeSanrenpuku=true
  assert.equal(isFunnelTarget('Premium', true), false, '購入済みに追加購入 CTA を出している');
  assert.equal(isFunnelTarget('Premium Predictions', true), false);
  // 未購入の馬単 Premium は従来どおり対象
  assert.equal(isFunnelTarget('Premium', false), true, '未購入 Premium への導線まで消している');
  assert.equal(isFunnelTarget('Premium'), true, '第2引数省略時の既定が変わっている');
  // 旧プラン名の三連複保有者も従来どおり対象外
  assert.equal(isFunnelTarget('Premium Sanrenpuku'), false);
});

test('planSanrenpukuDisplay も買い切り購入者には何も出さない', () => {
  const now = Date.now();
  const view = planSanrenpukuDisplay({
    planRaw: 'Premium', lifetimeSanrenpuku: true,
    firstSeen: now - 30 * 24 * 60 * 60 * 1000, now, hasResultSection: true,
  });
  assert.equal(view.isFunnelTarget, false);
  assert.equal(view.showCta, false, '購入済みに申込 CTA が出ている');
  assert.equal(view.teaser, 'none');
  assert.equal(view.showResult, false);
});

test('有料予想ページ（南関・中央）が買い切りフラグを渡している', () => {
  for (const rel of PREMIUM_PAGES) {
    const src = read(rel);
    assert.match(src, /lifetimeSanrenpuku === true/, `${rel}: user-plan から買い切りフラグを読んでいない`);
    assert.match(src, /isFunnelTarget\(planRaw, srpLifetime\)/, `${rel}: isFunnelTarget に買い切りフラグを渡していない`);
    assert.match(src, /planSanrenpukuDisplay\(\{ planRaw: planRaw, lifetimeSanrenpuku: srpLifetime,/,
      `${rel}: planSanrenpukuDisplay に買い切りフラグを渡していない`);
  }
});
