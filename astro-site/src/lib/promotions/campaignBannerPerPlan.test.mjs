/**
 * campaignBannerPerPlan.test.mjs — **全プラン × 全設置ページ**を機械で確認する
 *
 * MK 指示（2026-08-25）「各プランでテスト検証してください。人間が全部確認できません」。
 *
 * ## 本番で出た 2 件（どちらも人の目でしか気づけなかった）
 *
 * 1. `/free-signup/` で「無料登録する」ボタンが**同じページ**を指していた
 * 2. `/pricing/` で登録済みの方に**文字の無いオレンジのボタン**が出て、押しても何も起きなかった
 *
 * このテストは、**実際の API 応答**をプラン別に作り、
 * **設置している全ページ**でバナーを解決して、次を 1 つ残らず確認する:
 *
 *   - 出すなら見出しがある（枠だけ出さない）
 *   - ボタンを出すなら **href と文言の両方**がある
 *   - ボタンの行き先が **いま見ているページと違う**
 *   - 行き先が **実在し、会員資格を要求しない**
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { resolveBannerView } from './campaignBannerView.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const PAGES_DIR = fileURLToPath(new URL('../../pages/', import.meta.url));

/** バナーを置いているページを**自動で見つける**（置き場所が増えても検査が付いてくる）*/
function findBannerPages() {
  const out = [];
  const walk = (dir, prefix) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { walk(`${dir}${e.name}/`, `${prefix}${e.name}/`); continue; }
      if (!e.name.endsWith('.astro')) continue;
      const src = readFileSync(`${dir}${e.name}`, 'utf8');
      if (!src.includes('<CampaignBanner />')) continue;
      const base = e.name.replace(/\.astro$/, '');
      out.push(base === 'index' ? `/${prefix}` : `/${prefix}${base}/`);
    }
  };
  walk(PAGES_DIR, '');
  return out;
}

/** そのページが会員資格を要求しているか */
function requiredPlanOf(pathname) {
  const file = String(pathname).replace(/^\/|\/$/g, '') || 'index';
  let src = '';
  try { src = read(`../../pages/${file}.astro`); } catch { return null; }
  const m = /requiredPlan[=:]\s*["']([^"']+)["']/.exec(src);
  return m ? m[1] : '';
}

const BANNER_PAGES = findBannerPages();
/** 実在する契約（セッション／localStorage に入る値）*/
const PLANS = ['', 'free', 'free-registered', 'light', 'standard', 'premium',
  'premium-predictions', 'premium-combo', 'premium-sanrenpuku'];

let realFetch;
let realEnv;

/** 本物の API から、そのプラン向けの banner を取る */
async function bannerFor(plan) {
  const mod = await import(`../../pages/api/campaign.json.js?t=${Math.random()}`);
  const res = await mod.GET({
    url: new URL(`https://analytics.keiba.link/api/campaign.json?plan=${encodeURIComponent(plan)}`),
  });
  return (await res.json()).banner;
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  realEnv = { ...process.env };
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
  // 停止していない状態
  globalThis.fetch = async () => new Response(JSON.stringify({ result: null }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in realEnv)) delete process.env[k];
  Object.assign(process.env, realEnv);
});

test('前提: バナーを置いたページを見つけられる', () => {
  assert.ok(BANNER_PAGES.length >= 2, `見つかったページ: ${BANNER_PAGES.join(', ') || 'なし'}`);
});

test('全プラン × 全ページ: 押せないボタン・行き止まりを出さない', async () => {
  for (const plan of PLANS) {
    const banner = await bannerFor(plan);
    for (const page of BANNER_PAGES) {
      const v = resolveBannerView({ banner, currentPath: page });
      const who = `${plan || '(未登録)'} @ ${page}`;

      if (!v.show) continue;               // 出さないのは正常（三連複の方など）
      assert.ok(v.headline, `${who}: 見出しの無い枠が出ている`);

      if (!v.cta.show) continue;           // ボタン無しも正常（自動適用のご案内）
      // ⚠️ ボタンを出すなら、押して意味があること
      assert.ok(v.cta.label, `${who}: 文字の無いボタンが出ている`);
      assert.ok(v.cta.href, `${who}: 行き先の無いボタンが出ている`);
      assert.notEqual(v.cta.href.replace(/\/$/, ''), page.replace(/\/$/, ''),
        `${who}: 同じページへのリンクを出している`);

      const required = requiredPlanOf(v.cta.href);
      assert.notEqual(required, null, `${who}: 行き先 ${v.cta.href} が存在しない`);
      assert.equal(required, '', `${who}: 行き先が「${required}」会員専用ページ`);
    }
  }
});

test('未登録の方には登録ボタンが出る（塞ぎすぎない）', async () => {
  const banner = await bannerFor('');
  const v = resolveBannerView({ banner, currentPath: '/pricing/' });
  assert.equal(v.show, true);
  assert.equal(v.cta.show, true, '未登録の方に登録の導線が無い');
  assert.equal(v.cta.href, '/free-signup/');
});

test('登録ページでは登録ボタンを出さない（同じページ）', async () => {
  const banner = await bannerFor('');
  const v = resolveBannerView({ banner, currentPath: '/free-signup/' });
  assert.equal(v.show, true, 'ご案内自体は出す');
  assert.equal(v.cta.show, false, '同じページへのボタンを出している');
  assert.equal(v.cta.reason, 'same_page');
});

test('そのページで買える方にはボタンを出さない（申込時に自動適用）', async () => {
  // ⚠️ Premium の方は三連複だけで、/pricing/ では買えない。
  //    その場合は「マイページでお申し込み」を出すのが正しい（下の専用テスト）。
  for (const plan of ['free', 'light']) {
    const banner = await bannerFor(plan);
    const v = resolveBannerView({ banner, currentPath: '/pricing/' });
    assert.equal(v.show, true, `${plan}: ご案内が出ない`);
    assert.equal(v.cta.show, false, `${plan}: 不要なボタンが出ている`);
    assert.equal(v.cta.reason, 'no_href');
  }
});

test('三連複をお持ちの方にはご案内自体を出さない', async () => {
  const v = resolveBannerView({ banner: await bannerFor('premium-sanrenpuku'), currentPath: '/pricing/' });
  assert.equal(v.show, false);
});

test('[hidden] が自作スタイルに負けないようにしている', () => {
  // ⚠️ 本番で**文字の無いオレンジのボタン**が出た原因。
  //    `display: inline-flex` の作者スタイルがブラウザ既定の `[hidden]` に勝っていた。
  const c = read('../../components/CampaignBanner.astro');
  assert.match(c, /\.ak-cb-cta\[hidden\] \{ display: none !important; \}/,
    'ボタンが hidden でも消えない');
  assert.match(c, /\.ak-campaign-banner\[hidden\] \{ display: none !important; \}/);
});

test('判定は純粋関数に置く（画面の中だけに条件を書かない）', () => {
  const c = read('../../components/CampaignBanner.astro');
  assert.match(c, /resolveBannerView/, '画面が自前で判定している');
  // 画面側に条件を再実装していない
  assert.doesNotMatch(c, /ctaHref && b\.ctaLabel/, '画面に条件が残っている');
});

// ── 買えない場所で行き止まりにしない（2026-08-25 MK 指摘）──────────
//
// ⚠️ 三連複は `/pricing/` で売っていない。そこに「三連複 10,000円OFF」とだけ出すと、
//    どこで買えるのか分からず行き止まりになる。

test('マイページでしか買えない商品しか無いときは、マイページへ送る', async () => {
  const banner = await bannerFor('premium');   // Premium の方は三連複だけ
  const v = resolveBannerView({ banner, currentPath: '/pricing/' });
  assert.equal(v.show, true);
  assert.equal(v.cta.show, true, '買える場所への導線が無い（行き止まり）');
  assert.equal(v.cta.href, '/dashboard/');
  assert.ok(v.cta.label, 'ボタンの文字が無い');
});

test('そのマイページ自身では出さない（同じページ）', async () => {
  const v = resolveBannerView({ banner: await bannerFor('premium'), currentPath: '/dashboard/' });
  assert.equal(v.cta.show, false);
  assert.equal(v.cta.reason, 'same_page');
});

test('そのページで買える商品があるときはボタンを出さない（自動適用）', async () => {
  // 無料の方の割引は /pricing/ でそのまま買える
  const v = resolveBannerView({ banner: await bannerFor('free'), currentPath: '/pricing/' });
  assert.equal(v.cta.show, false, '不要なボタンを出している');
});

test('説明画面の金額も割引後に揃える（印を付けた場所を差し替える）', () => {
  // ⚠️ 申込モーダルの手前にもう 1 枚あると、そこだけ元の値段が残る（本番で発生）。
  const script = read('../../../public/js/campaign-price.js');
  assert.match(script, /data-ak-price/, '印を付けた金額を差し替えていない');
  assert.match(script, /data-ak-price-strike/, '取り消し線側を扱っていない');
  assert.match(script, /applied !== true[\s\S]{0,80}return/, '割引が無いときに書き換えている');

  const page = read('../../pages/dashboard.astro');
  const marks = page.match(/data-ak-price(-strike)?="Premium Sanrenpuku Lifetime"/g) || [];
  assert.ok(marks.length >= 4, `三連複の金額に印が足りない: ${marks.length}`);
  // ページ側は金額を書き換えるコードを持たない
  assert.doesNotMatch(page, /plan-option-price[^]{0,80}textContent\s*=/, 'ページで金額を書き換えている');
});
