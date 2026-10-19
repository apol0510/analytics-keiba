/**
 * checkout.tirol.link — TIROL DATA LABO の英語の決済専用サイト（静的 HTML を生成する単一源・純粋）
 *
 * 2026-10-12/13 MK 確定（docs/decisions.md・CARD_PAYMENT_PROVIDERS.md §7）:
 * - 全面英語・TIROL DATA LABO の中立的な決済専用サイト。公開文言に競馬・ギャンブル関連語を追加しない。
 * - 説明は実際の機能（データ分析・会員制のオンライン情報サービス）に沿った正確な英語で書く。架空の機能・対象は書かない
 *   （表現は AK の既存英文 legal/terms の「statistical analysis ... based on sports data」に合わせる）。
 * - 決済会社への事業内容・商品分類の申告は事実どおり行う（公開サイトのブランド表現とは別。CARD_PAYMENT_PROVIDERS.md §7.1）。
 * - 公開住所は契約済みの新宿バーチャルオフィス（legal.astro と同一表記）。自宅住所は載せない。
 * - 価格・商品は cardOneTime.js の CARD_PRODUCTS と同じ。カードでの受付は CARD_SALES_OPEN が開くまで「準備中」と書く。
 * - 決済会社は冗長化（Paddle 第一・PayPal 予備）。お客様に決済会社を選ばせる表示はしない。
 *
 * 生成: node ops/checkout-site/build.mjs <outDir>
 *
 * 2026-10-15 MK 確定: 決済会社へ渡す戻り先・Webhook の URL に競馬関連語を入れない → このサイトが中継する
 * （`_redirects` の行は astro-site/src/lib/billing/neutralCheckoutHost.js の NEUTRAL_ROUTES が正本。画面には何も足さない）。
 */
import { NEUTRAL_ROUTES } from '../../astro-site/src/lib/billing/neutralCheckoutHost.js';

export const BUSINESS = Object.freeze({
  name: 'TIROL DATA LABO',
  form: 'Sole proprietorship registered in Japan',
  address: 'Park Front Shinjuku 202, 2-8-15 Shinjuku, Shinjuku-ku, Tokyo 160-0022, Japan',
  phone: '050-6863-3742',
  email: 'analytics@tirol.link',
  serviceName: 'Analytics Premium',
  // 会員サイト。リンク先としてだけ使い、ドメイン文字列は画面に表示しない
  memberSignInUrl: 'https://analytics.keiba.link/login/',
});

export const PLANS = Object.freeze([
  { id: 'premium-annual', name: 'Analytics Premium — Annual', priceYen: 49800, term: '12 months of access from the payment confirmation date. One-time payment; it does not renew automatically.' },
  { id: 'premium-lifetime', name: 'Analytics Premium — Lifetime', priceYen: 78000, term: 'Access for as long as the Service is operated. One-time payment; no further charges.' },
]);
export const MEMBER_PLAN = Object.freeze({ id: 'premium-annual-light', name: 'Analytics Premium — Annual (Light member price)', priceYen: 44820 });

/** カードでの受付状況。CARD_SALES_OPEN を開ける PR でこの値も true にする（テストで両者の一致を固定）。 */
export const CARD_PAYMENTS_AVAILABLE = true;

export const LAST_UPDATED = 'October 13, 2026';

const yen = (n) => `¥${Number(n).toLocaleString('en-US')}`;

export const NAV = Object.freeze([
  ['/', 'Home'], ['/features/', 'Features'], ['/pricing/', 'Pricing'], ['/billing/', 'Billing'],
  ['/terms/', 'Terms'], ['/privacy/', 'Privacy'], ['/refund/', 'Refund'], ['/contact/', 'Contact'],
]);

const WHAT_IT_IS = `Analytics Premium is an online, members-only information service. It publishes statistical analysis
  results and reference indicators based on sports data, produced by our own data models and delivered through a member
  dashboard.`;

const WHAT_IT_IS_NOT = `The Service provides information only. The analysis is reference information; it is not investment or
  financial advice and does not guarantee any outcome or result. Any decision made using it is the member's own.`;

const cardNotice = () => CARD_PAYMENTS_AVAILABLE
  ? ''
  : `<p class="notice"><strong>Card payments are being prepared and are not available yet.</strong> Until they open, plans can be
  purchased by bank transfer (Japanese bank accounts) from the member site.</p>`;

const PAGES = {
  '/': {
    title: 'TIROL DATA LABO',
    description: 'TIROL DATA LABO publishes Analytics Premium, a members-only data analysis information service.',
    body: () => `
<section class="hero">
  <h1>Data analysis reports, delivered daily</h1>
  <p class="lead">${WHAT_IT_IS}</p>
  <p><a class="button" href="/pricing/">See plans and prices</a></p>
</section>
<section>
  <h2>About this site</h2>
  <p>This site is the billing and policy site of ${BUSINESS.name}, the operator of ${BUSINESS.serviceName}.
  It explains what members pay for, how billing works, and the terms that apply. The reports themselves are read on the
  <a href="${BUSINESS.memberSignInUrl}">member site</a>.</p>
  <h2>Information only</h2>
  <p>${WHAT_IT_IS_NOT}</p>
</section>`,
  },
  '/features/': {
    title: 'Features',
    description: 'What Analytics Premium members receive.',
    body: () => `
<h1>Features</h1>
<p>${WHAT_IT_IS}</p>
<ul class="cards">
  <li><h3>Daily analysis reports</h3><p>For each covered event day, a report for every event: an evaluation of each
  entrant and a ranking produced by our data models.</p></li>
  <li><h3>Indices and factors</h3><p>A composite index for each entrant and the statistical factors behind it, such as
  recent form and suitability to the conditions, derived from historical data.</p></li>
  <li><h3>Top-rated selections</h3><p>For each event, the selections the analysis rates highest, published as reference
  information.</p></li>
  <li><h3>Published results</h3><p>After each event day the results of the published analysis are recorded and kept in
  an archive, including the cases where the analysis was wrong.</p></li>
  <li><h3>Online delivery</h3><p>Everything is delivered on the member site. Sign-in is by a one-time link sent to the
  member's email address. Nothing is shipped.</p></li>
</ul>
<h2>What the service does not do</h2>
<p>${WHAT_IT_IS_NOT}</p>`,
  },
  '/pricing/': {
    title: 'Pricing',
    description: 'Analytics Premium plans and prices.',
    body: () => `
<h1>Pricing</h1>
${cardNotice()}
<ul class="cards">
${PLANS.map((p) => `  <li><h3>${p.name}</h3><p class="price">${yen(p.priceYen)} <span>JPY, tax included</span></p><p>${p.term}</p></li>`).join('\n')}
</ul>
<p>Existing Light plan members can move to the Annual plan for ${yen(MEMBER_PLAN.priceYen)} (tax included). This price is shown only to
eligible members on the member site.</p>
<ul>
  <li>All prices are in Japanese yen and include Japanese consumption tax.</li>
  <li>There are no subscriptions that renew automatically. Each plan is a single payment.</li>
  <li>Access starts once the payment is confirmed. See <a href="/billing/">Billing</a> for details.</li>
</ul>`,
  },
  '/billing/': {
    title: 'Billing',
    description: 'How payments for Analytics Premium are made and processed.',
    body: () => `
<h1>Billing information</h1>
${cardNotice()}
<h2>How to pay</h2>
<ol>
  <li>Sign in on the <a href="${BUSINESS.memberSignInUrl}">member site</a> with your email address.</li>
  <li>Choose a plan on the pricing page and select <em>Pay by card</em> (when available) or bank transfer.</li>
  <li>When the payment is confirmed, the plan is applied to your account automatically and a confirmation email is sent.</li>
</ol>
<h2>Who processes card payments</h2>
<p>Card payments are processed by our authorised payment provider. We currently intend to use Paddle.com, which acts as
our online reseller and Merchant of Record for card orders it processes; for those orders Paddle's
<a href="https://www.paddle.com/legal/checkout-buyer-terms">Buyer Terms</a> also apply, and the charge, receipt and any
refund are issued by Paddle. We do not receive or store your card number.</p>
<p>You will not be asked to choose a payment company. If we change provider (for example during an outage), payments already
started are completed or refunded with the provider that took them, and you are never charged twice for the same order.</p>
<h2>Product name on receipts</h2>
<p>Receipts show the plan name, such as “${PLANS[0].name.replace(' — ', ' ')}”, and the seller or reseller name.</p>
<h2>Bank transfer</h2>
<p>Bank transfer to a Japanese bank account is available from the member site. Transfer fees are paid by the customer.</p>
<h2>Billing questions</h2>
<p>Email <a href="mailto:${BUSINESS.email}">${BUSINESS.email}</a> from your registered address.</p>`,
  },
  '/terms/': {
    title: 'Terms of Service',
    description: 'Terms of Service for Analytics Premium.',
    body: () => `
<h1>Terms of Service</h1>
<p class="updated">Last updated: ${LAST_UPDATED}</p>
<p>These Terms govern the use of ${BUSINESS.serviceName} (the “Service”) operated by ${BUSINESS.name} (“we”, “us”).
By purchasing a plan or using the Service you agree to these Terms. The Terms are provided in English.</p>
<h2>1. The Service</h2>
<p>${WHAT_IT_IS}</p>
<p>${WHAT_IT_IS_NOT}</p>
<h2>2. Eligibility</h2>
<p>You must be 18 years of age or older. You are responsible for complying with the laws that apply where you live.</p>
<h2>3. Accounts</h2>
<p>Accounts are personal. Do not share your sign-in links or let others use your account. Keep your email address up to date.</p>
<h2>4. Plans and payment</h2>
<p>Plans and prices are listed on the <a href="/pricing/">Pricing</a> page. Each plan is a one-time payment and does not renew
automatically. The Annual plan gives access for 12 months from the payment confirmation date; the Lifetime plan gives
access for as long as the Service is operated. Card orders may be processed by our reseller, Paddle.com, as Merchant of
Record (see <a href="/billing/">Billing</a>).</p>
<h2>5. Refunds</h2>
<p>Refunds are handled under the <a href="/refund/">Refund Policy</a>.</p>
<h2>6. Acceptable use</h2>
<p>You may not copy, resell, republish or redistribute the reports, access the Service with automated tools without our
permission, or interfere with its operation. We may suspend accounts that break these rules.</p>
<h2>7. No guarantee</h2>
<p>The analysis is based on historical data and statistical models. It is reference information only. We do not guarantee
its accuracy or any outcome, and we are not responsible for any decision you make based on it.</p>
<h2>8. Liability</h2>
<p>To the extent permitted by law, we are not liable for indirect, incidental, special or consequential damages, including
loss of profits, arising from the use of or inability to use the Service. Nothing in these Terms limits rights you have
under applicable consumer law.</p>
<h2>9. Changes</h2>
<p>We may change the Service or these Terms. Material changes to these Terms are announced on this site before they take effect.</p>
<h2>10. Governing law</h2>
<p>These Terms are governed by the laws of Japan.</p>
<h2>11. Contact</h2>
<p>${BUSINESS.name}, ${BUSINESS.address}. Email: <a href="mailto:${BUSINESS.email}">${BUSINESS.email}</a>.</p>`,
  },
  '/privacy/': {
    title: 'Privacy Policy',
    description: 'How TIROL DATA LABO handles personal information.',
    body: () => `
<h1>Privacy Policy</h1>
<p class="updated">Last updated: ${LAST_UPDATED}</p>
<p>This policy explains how ${BUSINESS.name} handles personal information for ${BUSINESS.serviceName}.</p>
<h2>1. What we collect</h2>
<ul>
  <li>Your email address and, if you give it, your name</li>
  <li>Your plan, payment status and payment dates</li>
  <li>Technical data such as IP address, browser type and pages viewed</li>
</ul>
<p>Card details are entered on the payment provider's checkout and are not received or stored by us.</p>
<h2>2. How we use it</h2>
<ul>
  <li>To provide the Service and apply the plan you purchased</li>
  <li>To send sign-in links, payment confirmations and service notices</li>
  <li>To send information about the Service, which you can unsubscribe from at any time</li>
  <li>To answer enquiries, prevent fraud and meet legal obligations</li>
</ul>
<h2>3. Who we share it with</h2>
<p>Only with service providers who process it for us (payment processing, hosting, email delivery, customer records,
analytics), and where the law requires it. We do not sell personal information.</p>
<h2>4. Storage and transfers</h2>
<p>Our providers may store data outside Japan. We use providers that protect personal information appropriately.</p>
<h2>5. Retention</h2>
<p>We keep personal information for as long as needed to provide the Service and to meet legal and accounting obligations.</p>
<h2>6. Your rights</h2>
<p>You can ask us to access, correct or delete your personal information, or to stop sending marketing email, by writing to
<a href="mailto:${BUSINESS.email}">${BUSINESS.email}</a>.</p>
<h2>7. Age</h2>
<p>The Service is for people aged 18 and over. We do not knowingly collect information from anyone younger.</p>
<h2>8. Contact</h2>
<p>${BUSINESS.name}, ${BUSINESS.address}. Email: <a href="mailto:${BUSINESS.email}">${BUSINESS.email}</a>.</p>`,
  },
  '/refund/': {
    title: 'Refund Policy',
    description: 'Refund and cancellation policy for Analytics Premium.',
    body: () => `
<h1>Refund Policy</h1>
<p class="updated">Last updated: ${LAST_UPDATED}</p>
<h2>1. Digital content</h2>
<p>Plans give immediate access to digital content. Once a payment is completed it is not refundable, except as set out below.</p>
<h2>2. When we refund</h2>
<ul>
  <li>You were charged twice for the same order, or charged in error by us</li>
  <li>The Service was not provided at all for reasons attributable to us</li>
  <li>A refund is required by applicable law, including consumer protection law in your country</li>
</ul>
<p>For card orders processed by Paddle.com as Merchant of Record, refunds are issued by Paddle to the original payment method.</p>
<h2>3. When a refund is made</h2>
<p>The plan bought with that payment is removed from your account and your account returns to the state it was in before the purchase.</p>
<h2>4. No automatic renewal</h2>
<p>Plans do not renew, so there is nothing to cancel to stop future charges.</p>
<h2>5. How to ask</h2>
<p>Email <a href="mailto:${BUSINESS.email}">${BUSINESS.email}</a> from your registered address with the date and amount of the payment.</p>`,
  },
  '/contact/': {
    title: 'Contact',
    description: 'Contact details for TIROL DATA LABO.',
    body: () => `
<h1>Contact</h1>
<table class="info">
  <tr><th>Business name</th><td>${BUSINESS.name}</td></tr>
  <tr><th>Business type</th><td>${BUSINESS.form}</td></tr>
  <tr><th>Service</th><td>${BUSINESS.serviceName} — members-only data analysis information service (online, digital content)</td></tr>
  <tr><th>Address</th><td>${BUSINESS.address}</td></tr>
  <tr><th>Phone</th><td>${BUSINESS.phone} (support is provided by email)</td></tr>
  <tr><th>Email</th><td><a href="mailto:${BUSINESS.email}">${BUSINESS.email}</a></td></tr>
  <tr><th>Representative</th><td>Disclosed without delay on request</td></tr>
</table>
<p>For questions about an account or a payment, please write from your registered email address.</p>`,
  },
};

const CSS = `
:root{--bg:#ffffff;--fg:#1f2933;--muted:#5b6672;--line:#e3e7eb;--accent:#1d4ed8;--card:#f6f8fa;--notice:#fff7e0}
@media (prefers-color-scheme:dark){:root{--bg:#11161c;--fg:#e6eaee;--muted:#9aa5b1;--line:#29313a;--accent:#7aa2ff;--card:#18202a;--notice:#3a3114}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}header,footer,main{max-width:960px;margin:0 auto;padding:0 16px}
header{display:flex;flex-wrap:wrap;gap:8px 20px;align-items:center;justify-content:space-between;padding-top:16px;padding-bottom:16px;border-bottom:1px solid var(--line)}
.brand{font-weight:700;letter-spacing:.06em;text-decoration:none;color:var(--fg)}nav{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:.95rem}
nav a{text-decoration:none}nav a[aria-current]{font-weight:700;text-decoration:underline}
main{padding-top:24px;padding-bottom:48px}h1{font-size:1.9rem;line-height:1.3}h2{margin-top:2rem}
.lead{font-size:1.1rem}.button{display:inline-block;padding:10px 18px;border-radius:6px;background:var(--accent);color:#fff;text-decoration:none}
.cards{list-style:none;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}
.cards li{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px}.cards h3{margin-top:0}
.price{font-size:1.6rem;font-weight:700;margin:0}.price span{font-size:.85rem;font-weight:400;color:var(--muted)}
.notice{background:var(--notice);border-radius:6px;padding:12px 14px}.updated{color:var(--muted)}
table.info{border-collapse:collapse;width:100%}table.info th,table.info td{border-bottom:1px solid var(--line);padding:10px 8px;text-align:left;vertical-align:top}
table.info th{width:32%;color:var(--muted);font-weight:600}
footer{border-top:1px solid var(--line);padding-top:16px;padding-bottom:32px;color:var(--muted);font-size:.9rem}
@media (max-width:600px){table.info th{width:40%}h1{font-size:1.5rem}}`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

export function renderPage(path) {
  const page = PAGES[path];
  if (!page) throw new Error(`unknown page ${path}`);
  const title = path === '/' ? BUSINESS.name : `${page.title} — ${BUSINESS.name}`;
  const nav = NAV.map(([href, label]) => `<a href="${href}"${href === path ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(page.description)}">
<link rel="canonical" href="${SITE_ORIGIN}${path}">
<link rel="stylesheet" href="/style.css">
</head>
<body>
<header><a class="brand" href="/">${BUSINESS.name}</a><nav>${nav}</nav></header>
<main>${page.body()}
</main>
<footer>
<p>${BUSINESS.name} · ${BUSINESS.address} · <a href="mailto:${BUSINESS.email}">${BUSINESS.email}</a></p>
<p>${BUSINESS.serviceName} provides reference information only and does not guarantee any outcome.</p>
</footer>
</body>
</html>
`;
}

export const PAGE_PATHS = Object.freeze(Object.keys(PAGES));

/** 検索エンジンへの掲載。2026-10-13 checkout.tirol.link の DNS 接続（新宿住所の契約条件確認後に MK が追加する手順）を受けて true。
 *  掲載を止めるときは false に戻して再 deploy（noindex＋robots Disallow に戻る）。 */
export const INDEXABLE = true;
export const SITE_ORIGIN = 'https://checkout.tirol.link';

export function buildFiles() {
  const files = { 'style.css': CSS.trimStart() };
  for (const p of PAGE_PATHS) files[p === '/' ? 'index.html' : `${p.slice(1)}index.html`] = renderPage(p);
  files['_headers'] = `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n${INDEXABLE ? '' : '  X-Robots-Tag: noindex, nofollow\n'}`;
  files['robots.txt'] = INDEXABLE ? `User-agent: *\nAllow: /\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n';
  // Netlify の既定サブドメインは独自ドメインへ寄せる（重複掲載を防ぐ）
  // 決済会社の戻り先 → 会員サイト（302）、Webhook → 会員サイトの Function（200 プロキシ）
  files['_redirects'] = `https://tirol-checkout.netlify.app/* ${SITE_ORIGIN}/:splat 301!\n`
    + NEUTRAL_ROUTES.map((r) => `${r.from}  ${r.to}  ${r.status}\n`).join('');
  if (INDEXABLE) files['sitemap.xml'] = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PAGE_PATHS.map((p) => `  <url><loc>${SITE_ORIGIN}${p}</loc></url>`).join('\n')}\n</urlset>\n`;
  return files;
}
