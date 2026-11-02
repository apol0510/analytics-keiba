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

test('カード受付の表示は CARD_SALES_OPEN と一致（閉じている間は「準備中」・Paddle の定期課金を受け付けている間は定期課金の版）', async () => {
  assert.equal(CARD_PAYMENTS_AVAILABLE, Object.values(CARD_SALES_OPEN).some(Boolean));
  const { SUBSCRIPTION_PAYMENTS_AVAILABLE } = await import('../../../../ops/checkout-site/site.mjs');
  if (!CARD_PAYMENTS_AVAILABLE && !SUBSCRIPTION_PAYMENTS_AVAILABLE) assert.match(renderPage('/pricing/'), /not available yet/);
  if (SUBSCRIPTION_PAYMENTS_AVAILABLE) assert.match(renderPage('/pricing/'), /renew automatically/);
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
    '/r/paddle/subscription-complete  https://analytics.keiba.link/checkout/paypal-subscription-return/  302!',
    '/hooks/paddle  /.netlify/functions/paddle-webhook  200!',
    '',
  ].join('\n'));
  // 中継先は会員サイトの本番だけ（他のホストへ転送しない）。
  // 例外: /hooks/paddle はこの中立サイト自身の local function が受ける（案B・4KB 回避）。
  for (const l of files._redirects.trim().split('\n').slice(1)) {
    const target = l.split(/\s+/)[1];
    if (l.startsWith('/hooks/paddle ')) { assert.equal(target, '/.netlify/functions/paddle-webhook'); continue; }
    assert.match(target, /^https:\/\/analytics\.keiba\.link\//);
  }
  // 決済会社に渡すパス自体に禁止語が無い
  for (const l of files._redirects.trim().split('\n').slice(1)) assert.doesNotMatch(l.split(/\s+/)[0], BANNED);
});

test('Paddle の決済ページ /pay/（2026-10-24）: ナビ・sitemap に載せず noindex・受付中かつ live token のときだけ Paddle.js を読む', async () => {
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
  const { SUBSCRIPTION_PAYMENTS_AVAILABLE } = await import('../../../../ops/checkout-site/site.mjs');
  if (CARD_PAYMENTS_AVAILABLE || SUBSCRIPTION_PAYMENTS_AVAILABLE) {
    assert.match(live, /cdn\.paddle\.com\/paddle\/v2\/paddle\.js/);
    assert.match(live, /successUrl: location\.origin \+ done \+ '\?provider=paddle&order='/);
    assert.doesNotMatch(live, /Environment\.set\('sandbox'\)/);
  } else {
    // 受付を閉じている間は token があっても開かない
    assert.doesNotMatch(live, /paddle\.js/);
    assert.match(live, /not available yet/);
  }
});

test('Paddle の定期課金（2026-11-02 MK 確定）: 受付の切替と同時に、料金・請求・規約・返金を自動更新の版にする（実際の販売と説明を一致させる）', async () => {
  const { SUBSCRIPTION_PAYMENTS_AVAILABLE, SUBSCRIPTION_SITE_PLANS } = await import('../../../../ops/checkout-site/site.mjs');
  const { SUBSCRIPTION_SALES_OPEN, ACTIVE_SUBSCRIPTION_PROVIDER } = await import('./cardSales.js');
  assert.equal(SUBSCRIPTION_PAYMENTS_AVAILABLE, SUBSCRIPTION_SALES_OPEN.paddle === true && ACTIVE_SUBSCRIPTION_PROVIDER === 'paddle', 'サイトで別に開け閉めしない');
  const sub = buildFiles({ subscriptions: true });
  const all = PAGE_PATHS.map((p) => renderPage(p, { subscriptions: true })).join('\n');
  // 自動更新の販売中に「自動更新しない・定期課金は無い」とは書かない
  assert.doesNotMatch(all, /no subscriptions that renew|does not renew\s+automatically|Plans do not renew|not available yet/i);
  // 料金: 月額 3・年額・Light 会員の年額（名前は決済会社へ渡す許可リスト・金額は商品表）・買い切りは銀行振込だけ
  assert.deepEqual(SUBSCRIPTION_SITE_PLANS.map((p) => [p.name, p.priceYen, p.period]), [
    ['Analytics Premium', 4980, 'month'], ['Analytics Premium J', 2980, 'month'], ['Analytics Premium N', 2980, 'month'], ['Analytics Premium Annual', 49800, 'year'],
  ]);
  const pricing = sub['pricing/index.html'];
  for (const s of ['¥4,980', '¥2,980', '¥49,800', '¥44,820', 'renew automatically', 'bank transfer only']) assert.ok(pricing.includes(s), s);
  // 解約: マイページ＝即時終了／決済会社のメールのリンク＝支払い済み期間の終わりまで（実装どおり）
  assert.match(sub['refund/index.html'], /Paid access ends immediately, even if days remain until the expiry date, and no refund is\s+made for the remaining period/);
  assert.match(sub['refund/index.html'], /until the end of the period you have already paid for/);
  assert.match(sub['terms/index.html'], /renew automatically/);
  assert.match(sub['billing/index.html'], /Paddle\.com/);
  for (const p of PAGE_PATHS) assert.doesNotMatch(visible(renderPage(p, { subscriptions: true })), BANNED, p);
  assert.doesNotMatch(all, /[぀-ヿ一-鿿]/);
  // 受付前（いま）の版は従来どおり
  assert.match(buildFiles({ subscriptions: false })['pricing/index.html'], /There are no subscriptions that renew automatically/);
});

test('決済ページ /pay/: 定期課金の申込（ak=s）は定期課金の戻り先へ・それ以外は一回払いの完了画面・受付前は Paddle.js を読まない', () => {
  const TOKEN = 'live_0123456789abcdef0123456789a';
  const open = renderPayPage({ paddleClientToken: TOKEN, subscriptions: true });
  assert.match(open, /paddle\.js/);
  assert.match(open, /q\.get\("ak"\) === "s" \? '\/r\/paddle\/subscription-complete' : '\/r\/paddle\/complete'/);
  assert.match(open, /\?provider=paddle&order=/);
  assert.doesNotMatch(renderPayPage({ paddleClientToken: TOKEN, subscriptions: false }), /paddle\.js/);
  assert.doesNotMatch(renderPayPage({ paddleClientToken: 'test_abc', subscriptions: true }), /paddle\.js/, 'live の token のときだけ');
});
