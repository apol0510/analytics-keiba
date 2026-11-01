/**
 * functionBudget.test.mjs — 全ページの「お知らせ」取得が、意味の無い Function 起動をしないことを固定する
 *
 * ## なぜ要るか（2026-11-01 実測）
 *
 * ナビの赤い点（BaseLayout）は**全ページ・未ログインの方にも**載り、表示のたびに
 *   1. `/api/upsell.json`（ログインの手がかりが無い端末では必ず 404）
 *   2. `/api/campaign.json`（キャンペーン期間外は必ず `active: false`）
 * を叩いていた。CDN から返る静的ページでも 1 表示 = SSR Function 2 回の起動になり、
 * AK の Function 起動（1 日 約 9,100 回）の主因の 1 つだった。
 *
 * 画面に出る結果は変えずに通信だけを省く。ログイン済みの方・期間内は従来どおり通信する。
 * 正本: docs/SAFETY_CHECKS.md ルール 9
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAMPAIGN_WINDOW } from '../promotions/campaignOffers.js';

const MODULE = new URL('./upsellClient.js', import.meta.url).href;
let caseId = 0;
const loadFresh = () => import(`${MODULE}?budget=${++caseId}`);

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const key = Object.keys(routes).find((p) => u.startsWith(p));
    const r = key ? routes[key] : { status: 404, body: {} };
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  return calls;
}

const START = Date.parse(CAMPAIGN_WINDOW.startsAtIso);
const END = Date.parse(CAMPAIGN_WINDOW.endsAtIso);
const DAY = 24 * 60 * 60 * 1000;

let realFetch; let realStorage; let realNow;
test.beforeEach(() => {
  realFetch = globalThis.fetch;
  realStorage = globalThis.localStorage;
  realNow = Date.now;
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
  if (realStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = realStorage;
  Date.now = realNow;
});

const ACTIVE_CAMPAIGN = {
  active: true,
  offers: [{ name: 'Light 月額 500円OFF' }],
  deadlineText: '2026年9月23日まで',
  signature: 'campaign:test',
};

test('未ログイン端末 × 期間外: お知らせ取得で Function を 1 回も起動しない', async () => {
  globalThis.localStorage = memStorage();
  Date.now = () => END + 30 * DAY;
  const calls = stubFetch({});
  const m = await loadFresh();
  const n = await m.getCouponNotice();
  assert.deepEqual(calls, []);
  assert.equal(n.total, 0);
  assert.equal(n.count, 0);
});

test('未ログイン端末 × 期間内: /api/upsell.json は叩かず、公開 API でキャンペーンを届ける（従来の表示と同じ）', async () => {
  globalThis.localStorage = memStorage();
  Date.now = () => START + DAY * 3;
  const calls = stubFetch({ '/api/campaign.json': { status: 200, body: ACTIVE_CAMPAIGN } });
  const m = await loadFresh();
  const n = await m.getCouponNotice();
  assert.equal(calls.filter((u) => u.startsWith('/api/upsell.json')).length, 0);
  assert.equal(calls.filter((u) => u.startsWith('/api/campaign.json')).length, 1);
  assert.equal(n.total, 1, '期間内のキャンペーンは未ログインでも従来どおり届く');
});

test('ログイン端末（user-plan あり）: 従来どおり /api/upsell.json を 1 回だけ叩く', async () => {
  globalThis.localStorage = memStorage({ 'user-plan': JSON.stringify({ plan: 'Premium', email: 'a@example.com' }) });
  Date.now = () => END + 30 * DAY;
  const calls = stubFetch({
    '/api/upsell.json': {
      status: 200,
      body: { channel: 'none', sanrenpuku: { allowed: false }, plus: { allowed: false },
        coupon: { claimed: false }, rankNotice: null },
    },
  });
  const m = await loadFresh();
  await m.getCouponNotice();
  await m.getCouponNotice();
  assert.deepEqual(calls, ['/api/upsell.json']);
});

test('旧キー（isLoggedIn）だけのログイン端末も従来どおり通信する', async () => {
  globalThis.localStorage = memStorage({ isLoggedIn: 'true' });
  Date.now = () => END + 30 * DAY;
  const calls = stubFetch({});
  const m = await loadFresh();
  await m.getCouponNotice();
  assert.deepEqual(calls, ['/api/upsell.json']);
});

test('ナビが先に省略しても、同じページのマイページ等の getUpsellDecision() は従来どおり通信する（判定を毒さない）', async () => {
  globalThis.localStorage = memStorage();
  Date.now = () => END + 30 * DAY;
  const calls = stubFetch({
    '/api/upsell.json': { status: 200, body: { channel: 'plus', sanrenpuku: { allowed: false }, plus: { allowed: true } } },
  });
  const m = await loadFresh();
  await m.getCouponNotice();
  assert.deepEqual(calls, []);
  const d = await m.getUpsellDecision();
  assert.equal(d.channel, 'plus');
  assert.deepEqual(calls, ['/api/upsell.json']);
});

test('localStorage が読めない・無い端末は従来どおり通信する（省略は「確実に 404」のときだけ）', async () => {
  const m = await loadFresh();
  assert.equal(m.hasLoginHint({ getItem: () => { throw new Error('denied'); } }), true);
  delete globalThis.localStorage;
  assert.equal(m.hasLoginHint(), true);
  assert.equal(m.hasLoginHint(memStorage()), false);
  assert.equal(m.hasLoginHint(memStorage({ 'user-plan': JSON.stringify({ plan: 'Light' }) })), true);
});

test('期間判定は前後 1 日の余裕を持つ（端末の時計ずれで案内を落とさない）', async () => {
  const m = await loadFresh();
  assert.equal(m.isOutsideCampaignWindow(START + DAY), false);
  assert.equal(m.isOutsideCampaignWindow(END - 1), false);
  assert.equal(m.isOutsideCampaignWindow(END + DAY / 2), false, '終了直後 1 日は従来どおり通信');
  assert.equal(m.isOutsideCampaignWindow(START - DAY / 2), false, '開始直前 1 日は従来どおり通信');
  assert.equal(m.isOutsideCampaignWindow(END + DAY + 1), true);
  assert.equal(m.isOutsideCampaignWindow(START - DAY - 1), true);
  assert.equal(m.isOutsideCampaignWindow(Number.NaN), false, '壊れた時刻は通信側へ倒す');
});

// ── 静的に返す 404 / 転送（public/_redirects）───────────────────────────
//
// 存在しないパスは SSR 関数（/*）が 404 を返すため、1 回ごとに Function が起動する。
// AK 自身が参照していた旧ファイル・明らかなボットの探索だけを `_redirects` で静的に返す。
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SITE = fileURLToPath(new URL('../../../', import.meta.url));
const PUBLIC = join(SITE, 'public');
const PAGES = join(SITE, 'src', 'pages');
const redirectsText = readFileSync(join(PUBLIC, '_redirects'), 'utf8');
const rules = redirectsText.split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => l.split(/\s+/))
  .map(([from, to, status]) => ({ from, to, status }));
const STATIC_404 = rules.filter((r) => r.to === '/static-404.html');

function walk(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p)); else out.push(p);
  }
  return out;
}

test('静的 404 の行き先 public/static-404.html が存在し、noindex である', () => {
  assert.ok(STATIC_404.length > 0);
  const html = readFileSync(join(PUBLIC, 'static-404.html'), 'utf8');
  assert.match(html, /name="robots" content="noindex"/);
  for (const r of STATIC_404) assert.equal(r.status, '404', `${r.from} は 404 で返す`);
});

test('静的 404 / 転送の対象は AK の実ルート（src/pages・public）と重ならない', () => {
  const pageRoutes = walk(PAGES)
    .map((p) => '/' + p.slice(PAGES.length + 1).replace(/\.(astro|js|ts|md|mdx)$/, '').replace(/\/index$/, '').replace(/^index$/, ''));
  const publicFiles = walk(PUBLIC).map((p) => '/' + p.slice(PUBLIC.length + 1));
  const ours = rules.filter((r) => r.to === '/static-404.html' || ['/sitemap-index.xml', '/site.webmanifest'].includes(r.to));
  for (const r of ours) {
    const base = r.from.replace(/\/\*$/, '');
    for (const route of pageRoutes) {
      assert.ok(!(route === base || route.startsWith(base + '/')), `${r.from} が実ルート ${route} を隠す`);
    }
    for (const f of publicFiles) {
      assert.ok(!(f === base || f.startsWith(base + '/')), `${r.from} が public の実ファイル ${f} を隠す`);
    }
  }
});

test('転送先（sitemap-index / site.webmanifest）は実在する', () => {
  assert.ok(existsSync(join(PUBLIC, 'site.webmanifest')));
  // sitemap-index.xml は @astrojs/sitemap がビルド時に生成する（robots.txt が指す正規の場所）
  assert.match(readFileSync(join(PUBLIC, 'robots.txt'), 'utf8'), /Sitemap: https:\/\/analytics\.keiba\.link\/sitemap-index\.xml/);
  assert.ok(rules.some((r) => r.from === '/sitemap.xml' && r.to === '/sitemap-index.xml' && r.status === '301'));
});

test('site.webmanifest が参照するファイルはすべて public に実在する（存在しない画像で 404 を起こさない）', () => {
  const mf = JSON.parse(readFileSync(join(PUBLIC, 'site.webmanifest'), 'utf8'));
  const srcs = [];
  const visit = (v) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (k === 'src' ? srcs.push(x) : visit(x));
  };
  visit(mf);
  assert.ok(srcs.length > 0);
  for (const s of srcs) assert.ok(existsSync(join(PUBLIC, s)), `manifest の ${s} が public に無い`);
});

test('apple-touch-icon は PNG の実ファイルを指す（iOS は SVG を使わず /apple-touch-icon.png を取りに来る）', () => {
  const layout = readFileSync(join(SITE, 'src', 'layouts', 'BaseLayout.astro'), 'utf8');
  const m = layout.match(/<link rel="apple-touch-icon"[^>]*href="([^"]+)"/);
  assert.ok(m, 'apple-touch-icon の link がある');
  assert.match(m[1], /\.png$/);
  for (const f of [m[1], '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']) {
    const buf = readFileSync(join(PUBLIC, f));
    assert.equal(buf.subarray(1, 4).toString('latin1'), 'PNG', `${f} は PNG`);
  }
});

test('BaseLayout のお知らせ取得は upsellClient の getCouponNotice 経由だけ（ページ側で API を直接叩かない）', () => {
  const layout = readFileSync(join(SITE, 'src', 'layouts', 'BaseLayout.astro'), 'utf8');
  assert.match(layout, /import \{ getCouponNotice \} from '\.\.\/lib\/upsell\/upsellClient\.js'/);
  assert.doesNotMatch(layout, /fetch\(\s*['"`]\/api\/(upsell|campaign)\.json/);
});
