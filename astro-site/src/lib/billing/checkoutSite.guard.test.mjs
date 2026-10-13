// checkout.tirol.link（英語の決済専用サイト）の確定仕様を固定する（docs/decisions.md 2026-10-12・CARD_PAYMENT_PROVIDERS.md §7）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BUSINESS, PLANS, MEMBER_PLAN, CARD_PAYMENTS_AVAILABLE, INDEXABLE, PAGE_PATHS, buildFiles, renderPage } from '../../../../ops/checkout-site/site.mjs';
import { CARD_PRODUCTS } from './cardOneTime.js';
import { CARD_SALES_OPEN } from './cardSales.js';

const files = buildFiles();
const html = PAGE_PATHS.map((p) => renderPage(p)).join('\n');
const text = html.replace(/<[^>]+>/g, ' ');

test('必須ページがそろう（Home/Features/Pricing/Terms/Privacy/Refund/Contact/Billing）', () => {
  assert.deepEqual([...PAGE_PATHS].sort(), ['/', '/billing/', '/contact/', '/features/', '/pricing/', '/privacy/', '/refund/', '/terms/']);
  for (const k of ['index.html', 'billing/index.html', 'contact/index.html', 'features/index.html', 'pricing/index.html', 'privacy/index.html', 'refund/index.html', 'terms/index.html', 'style.css']) assert.ok(files[k], k);
});

// 公開文言に追加しない語（競馬・ギャンブル関連）。会員サイトへのリンク先 URL（href）だけは対象外（画面には出さない）
const BANNED = /keiba|horse|racing|racecourse|jockey|furlong|betting|\bbets?\b|wager|gambl|casino|odds|bookmak|lottery|\bJRA\b|Minami|Ohi|Kawasaki|Funabashi|Urawa/i;
const visible = (h) => h.replace(/href="[^"]*"/g, '').replace(/<link [^>]*>/g, '');

test('全面英語・中立ブランド・競馬/ギャンブル関連語を本文・メタ・フッター・リンク表示に出さない', () => {
  assert.doesNotMatch(html, /[\u3040-\u30ff\u4e00-\u9fff]/, '日本語が混入している');
  for (const p of PAGE_PATHS) assert.doesNotMatch(visible(renderPage(p)), BANNED, p);
  for (const k of ['style.css', '_headers', 'robots.txt']) assert.doesNotMatch(files[k], BANNED, k);
  assert.equal(BUSINESS.name, 'TIROL DATA LABO');
});

test('会員導線: 会員サイトへはリンクで案内し、ドメイン文字列は表示しない', () => {
  assert.equal(BUSINESS.memberSignInUrl, 'https://analytics.keiba.link/login/');
  for (const p of ['/', '/billing/']) assert.ok(renderPage(p).includes(`href="${BUSINESS.memberSignInUrl}"`), p);
  assert.doesNotMatch(text, /analytics\.keiba\.link/);
});

test('説明は実際の機能どおり（会員制のデータ分析情報サービス・成果保証なし）。AK 既存英文と同じ表現', () => {
  const legal = readFileSync(fileURLToPath(new URL('../../pages/legal.astro', import.meta.url)), 'utf8');
  assert.match(legal, /statistical analysis results and reference indicators based on sports data/);
  for (const p of ['/', '/features/', '/terms/']) {
    const t = renderPage(p);
    assert.match(t, /statistical analysis\s+results and reference indicators based on sports data/, p);
    assert.match(t, /does not guarantee any outcome/, p);
  }
});

test('公開住所は legal.astro と同一の新宿住所・自宅住所の欄は持たない', () => {
  const legal = readFileSync(fileURLToPath(new URL('../../pages/legal.astro', import.meta.url)), 'utf8');
  assert.ok(legal.includes(BUSINESS.address), 'legal.astro と表記がずれている');
  assert.match(BUSINESS.address, /Shinjuku/);
  for (const p of PAGE_PATHS) assert.ok(renderPage(p).includes(BUSINESS.address), `${p} のフッターに住所がない`);
});

test('価格は CARD_PRODUCTS と一致する', () => {
  const byId = Object.fromEntries(CARD_PRODUCTS.map((p) => [p.id, p.amountYen]));
  for (const p of [...PLANS, MEMBER_PLAN]) assert.equal(p.priceYen, byId[p.id], p.id);
  assert.equal(PLANS.length + 1, CARD_PRODUCTS.length);
});

test('カード受付の表示は CARD_SALES_OPEN と一致（閉じている間は「準備中」）', () => {
  assert.equal(CARD_PAYMENTS_AVAILABLE, Object.values(CARD_SALES_OPEN).some(Boolean));
  if (!CARD_PAYMENTS_AVAILABLE) assert.match(renderPage('/pricing/'), /not available yet/);
});

test('決済会社をお客様に選ばせる表示をしない（冗長化方針）', () => {
  assert.doesNotMatch(text.replace(/You will not be asked to choose a payment company/g, ''), /choose (a|your) (payment )?(provider|company)|select (a )?payment provider/i);
  assert.match(renderPage('/billing/'), /You will not be asked to choose a payment company/);
});

test('公開判断まで検索エンジンに載せない', () => {
  assert.equal(INDEXABLE, false);
  assert.match(files._headers, /X-Robots-Tag: noindex/);
  assert.match(files['robots.txt'], /Disallow: \//);
});
