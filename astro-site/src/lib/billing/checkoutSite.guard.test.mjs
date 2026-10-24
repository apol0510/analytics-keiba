// checkout.tirol.link（英語の決済専用サイト）の確定仕様を固定する（docs/decisions.md 2026-10-12・CARD_PAYMENT_PROVIDERS.md §7）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BUSINESS, PLANS, MEMBER_PLAN, CARD_PAYMENTS_AVAILABLE, INDEXABLE, PAGE_PATHS, buildFiles, renderPage, renderPayPage } from '../../../../ops/checkout-site/site.mjs';
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
  for (const k of ['style.css', '_headers', 'robots.txt', 'sitemap.xml']) assert.doesNotMatch(files[k], BANNED, k);
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

test('検索エンジン設定: checkout.tirol.link 接続後は掲載（canonical・sitemap は独自ドメイン）', () => {
  assert.equal(INDEXABLE, true);
  assert.doesNotMatch(files._headers, /noindex/);
  assert.match(files['robots.txt'], /Allow: \/\nSitemap: https:\/\/checkout\.tirol\.link\/sitemap\.xml/);
  for (const p of PAGE_PATHS) {
    assert.ok(files['sitemap.xml'].includes(`<loc>https://checkout.tirol.link${p}</loc>`), p);
    assert.ok(renderPage(p).includes(`<link rel="canonical" href="https://checkout.tirol.link${p}">`), p);
    assert.doesNotMatch(renderPage(p), /noindex/, p);
  }
  assert.doesNotMatch(files['sitemap.xml'], BANNED);
  assert.equal(files._redirects.split('\n')[0], 'https://tirol-checkout.netlify.app/* https://checkout.tirol.link/:splat 301!');
});

test('決済会社の戻り先・Webhook の中継（2026-10-15 MK 確定）: 会員サイトへ 302・Webhook は 200 プロキシ・画面には出さない', () => {
  assert.equal(files._redirects, [
    'https://tirol-checkout.netlify.app/* https://checkout.tirol.link/:splat 301!',
    '/r/paypal/order-return  https://analytics.keiba.link/checkout/paypal-return/  302!',
    '/r/paypal/subscription-return  https://analytics.keiba.link/checkout/paypal-subscription-return/  302!',
    '/r/paypal/cancel  https://analytics.keiba.link/pricing/?checkout=cancelled  302!',
    '/hooks/paypal  https://analytics.keiba.link/.netlify/functions/paypal-order-webhook  200!',
    '/r/paddle/complete  https://analytics.keiba.link/checkout/card-complete/  302!',
    '/hooks/paddle  https://analytics.keiba.link/.netlify/functions/paddle-webhook  200!',
    '',
  ].join('\n'));
  // 中継先は会員サイトの本番だけ（他のホストへ転送しない）
  for (const l of files._redirects.trim().split('\n').slice(1)) assert.match(l.split(/\s+/)[1], /^https:\/\/analytics\.keiba\.link\//);
  // 決済会社に渡すパス自体に禁止語が無い
  for (const l of files._redirects.trim().split('\n').slice(1)) assert.doesNotMatch(l.split(/\s+/)[0], BANNED);
});

test('Paddle の決済ページ /pay/（2026-10-24）: ナビ・sitemap に載せず noindex・受付中かつ live token のときだけ Paddle.js を読む', () => {
  assert.ok(files['pay/index.html']);
  assert.ok(!PAGE_PATHS.includes('/pay/'));
  assert.doesNotMatch(files['sitemap.xml'], /\/pay\//);
  const TOKEN = 'live_0123456789abcdef0123456789a';
  for (const h of [renderPayPage(), renderPayPage({ paddleClientToken: TOKEN }), renderPayPage({ paddleClientToken: 'test_abc' })]) {
    assert.match(h, /<meta name="robots" content="noindex, nofollow">/);
    assert.doesNotMatch(h, /[\u3040-\u30ff\u4e00-\u9fff]/);
    assert.doesNotMatch(visible(h), BANNED);
  }
  // test_ の token・未設定は決済画面を開かない（Sandbox は会員サイトの Deploy Preview 側で行う）
  assert.doesNotMatch(renderPayPage({ paddleClientToken: 'test_abc' }), /paddle\.js/);
  assert.doesNotMatch(renderPayPage(), /paddle\.js/);
  const live = renderPayPage({ paddleClientToken: TOKEN });
  if (CARD_PAYMENTS_AVAILABLE) {
    assert.match(live, /cdn\.paddle\.com\/paddle\/v2\/paddle\.js/);
    assert.match(live, /successUrl: location\.origin \+ '\/r\/paddle\/complete\?provider=paddle&order='/);
    assert.doesNotMatch(live, /Environment\.set\('sandbox'\)/);
  } else {
    // 受付を閉じている間は token があっても開かない
    assert.doesNotMatch(live, /paddle\.js/);
    assert.match(live, /not available yet/);
  }
});
