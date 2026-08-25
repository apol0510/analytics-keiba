/**
 * shownPriceMatchesCharge.test.mjs — **見せた金額 = 請求する金額**を全経路で固定する
 *
 * ## 繰り返した失敗（2026-08-24 / 08-25）
 *
 * これまでのテストは `RequestedAmount`（サーバーが記録する額）しか見ていなかった。
 * その結果、**お客様の画面が元の金額のまま**でも全部 pass していた:
 *
 *   案内「¥78,000 → ¥68,000」／ 申込モーダル「¥78,000」／ 実際の請求 ¥68,000
 *
 * 「サーバーが正しい」と「お客様に正しく見えている」は**別の事実**。
 * ここは後者を検査する。
 *
 * ## どうやって食い違いを防ぐか
 *
 * 1. 商品名の読み替えを**共有の単一源**にする（`payments/productName.js`）
 * 2. 画面が出す金額は**サーバーが返した値だけ**（`/api/campaign.json?product=`）
 * 3. サイト中の購入ボタンを全部集め、1 つ残らず突き合わせる（このテスト）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { derivePlanFromProductName, hasOwnSpecialPrice } from '../payments/productName.js';
import { resolveCampaignPricing, isCampaignActive } from './campaignOffers.js';
import * as catalog from './campaignOffers.js';

const PAGES_DIR = fileURLToPath(new URL('../../pages/', import.meta.url));
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const NOW = Date.parse('2026-08-25T03:00:00Z');
const ALLOWED = { allowed: true };

/** サイト中の購入ボタン（`openBankModal('商品名', 金額, '期間')`）を全部集める */
function collectButtons() {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}${e.name}`;
      if (e.isDirectory()) { walk(`${full}/`); continue; }
      if (!e.name.endsWith('.astro')) continue;
      const src = readFileSync(full, 'utf8');
      const re = /openBankModal\(\s*'([^']+)'\s*,\s*(\d+)\s*,\s*'([^']+)'/g;
      let m;
      while ((m = re.exec(src))) out.push({ productName: m[1], shown: Number(m[2]), file: e.name });
    }
  };
  walk(PAGES_DIR);
  return out;
}

const BUTTONS = collectButtons();
/** 契約ごとの権利（誰がその画面を見るか分からないので全パターン試す）*/
const AUDIENCES = [
  ['無料', {}],
  ['Light', { canViewLight: true }],
  ['Premium', { canViewPremium: true }],
  ['三連複', { canViewPremium: true, canViewSanrenpuku: true }],
];

/** サーバーが請求する額（`/api/campaign.json?product=` と同じ計算）*/
function chargedFor(productName, shown, entitlements, registered = true) {
  const d = derivePlanFromProductName(productName);
  if (hasOwnSpecialPrice(d.fullPlanName)) return shown;
  const p = resolveCampaignPricing({
    planName: d.planName, planType: d.planType, entitlements, nowMs: NOW,
    allowed: ALLOWED, registered,
  });
  return p.applied === true ? p.finalPrice : shown;
}

test('前提: 購入ボタンとキャンペーン期間を取得できる', () => {
  assert.ok(BUTTONS.length >= 4, `購入ボタンが ${BUTTONS.length} 件しか無い`);
  assert.equal(isCampaignActive(NOW), true, '検査時点がキャンペーン期間外');
});

test('割引が乗る商品では、画面の金額をサーバーの額へ差し替える経路がある', () => {
  // ⚠️ ここが無いと「見せた額 ≠ 請求額」に戻る
  const script = read('../../../public/js/campaign-price.js');
  assert.match(script, /\/api\/campaign\.json/, 'サーバーへ聞いていない');
  assert.match(script, /getElementById\('modalAmount'\)/, 'モーダルの金額を書き換えていない');
  assert.match(script, /getElementById\('transferAmount'\)/, '送信値を揃えていない');
  assert.match(script, /getElementById\('modalPlanInfo'\)/, 'プラン欄の金額が古いまま残る');
  // 画面で計算しない
  assert.doesNotMatch(script, /pricing\.regularPrice\s*-\s*/, '画面で割引を計算している');
  assert.doesNotMatch(script, /\b(4980|49800|78000|68000|44800|4480)\b/, '金額を直書きしている');
  // 取れなければ元の金額のまま（勝手に安く見せない）
  assert.match(script, /applied !== true.*return/s, '取得失敗時に元の金額へ戻していない');
});

test('その差し替えが**全ページ**に効く（16 ページを個別に直さない）', () => {
  const layout = read('../../layouts/BaseLayout.astro');
  assert.match(layout, /\/js\/campaign-price\.js/, '共通レイアウトで読み込んでいない');
  const script = read('../../../public/js/campaign-price.js');
  assert.match(script, /window\.openBankModal/, '既存のモーダルを包んでいない');
});

test('商品名の読み替えは 1 か所だけ（画面とサーバーで食い違わせない）', () => {
  const fn = read('../../../netlify/functions/bank-transfer-application.js');
  assert.match(fn, /derivePlanFromProductName/, '申込 Function が共有の単一源を使っていない');
  // 自前の正規化を持ち込んでいない
  assert.doesNotMatch(fn, /replace\(\/\\s\*-\\s\*Campaign\//, '申込 Function が自前で正規化している');
  const api = read('../../pages/api/campaign.json.js');
  assert.match(api, /derivePlanFromProductName/, 'API が共有の単一源を使っていない');
});

test('サイト中のどの購入ボタンでも、請求額が画面の額を上回らない', () => {
  for (const b of BUTTONS) {
    for (const [label, ent] of AUDIENCES) {
      const charged = chargedFor(b.productName, b.shown, ent);
      assert.ok(charged <= b.shown,
        `${b.file} / ${label}: 画面 ¥${b.shown} より高い ¥${charged} を請求しようとしている`);
      assert.ok(charged > 0, `${b.file}: 請求額が 0 円以下`);
    }
  }
});

test('割引が乗る組み合わせが実在する（検査が素通りしていない）', () => {
  const discounted = [];
  for (const b of BUTTONS) {
    for (const [label, ent] of AUDIENCES) {
      const charged = chargedFor(b.productName, b.shown, ent);
      if (charged < b.shown) discounted.push(`${b.productName}/${label}: ${b.shown}→${charged}`);
    }
  }
  assert.ok(discounted.length > 0, '1 つも割引が乗らない＝検査が意味を持っていない');
  // 三連複（買い切り）が Premium の方に乗ること（今回の報告そのもの）
  assert.ok(discounted.some((d) => d.startsWith('Premium Sanrenpuku Lifetime/Premium')),
    `三連複の割引が乗っていない: ${discounted.join(' / ')}`);
});

test('無料登録がまだの方には割り引かない（画面も通常価格のまま）', () => {
  // ⚠️ 無料登録特典（2026-08-25 MK 確定）。未登録の方には 1 円も引かない。
  for (const b of BUTTONS) {
    for (const [label, ent] of AUDIENCES) {
      assert.equal(chargedFor(b.productName, b.shown, ent, false), b.shown,
        `${b.file} / ${label}: 未登録の方に割り引いている`);
    }
  }
});

test('未登録の方には「無料登録で◯◯円OFF」を出す（割引額は出さない）', () => {
  const script = read('../../../public/js/campaign-price.js');
  assert.match(script, /registerPrompt/, '登録のご案内を出していない');
  // 未適用のときは金額を書き換えない
  const fn = script.slice(script.indexOf('function paint('));
  assert.match(fn.slice(0, 600), /applied !== true[\s\S]*?return/, '未適用でも金額を書き換えている');
  const api = read('../../pages/api/campaign.json.js');
  assert.match(api, /describeRegisterPrompt/, '文言をサーバーが持っていない');
  // 対象外の商品には案内を出さない（登録しても安くならないのに期待させない）
  assert.match(api, /yen > 0 \? describeRegisterPrompt/, '対象外の商品にも案内を出している');
});

test('登録のご案内には**行き方**を必ず添える（言うだけにしない）', () => {
  // ⚠️ 2026-08-25 MK 指摘「無料登録してからだと 500円off ならリンクしないと親切じゃない」。
  const api = read('../../pages/api/campaign.json.js');
  assert.match(api, /registerHref: CAMPAIGN_REGISTER_HREF/, 'API が行き先を返していない');
  assert.match(api, /registerLabel/, 'ボタンの文言を返していない');

  const script = read('../../../public/js/campaign-price.js');
  assert.match(script, /pricing\.registerHref/, '画面がリンクを出していない');
  // 行き先を画面で組み立てない
  assert.doesNotMatch(script, /\/free-signup\//, '行き先を画面に直書きしている');

  // 行き先が実在し、会員資格を要求しないこと（未登録の方が開けなければ意味が無い）
  const { CAMPAIGN_REGISTER_HREF } = catalog;
  const file = CAMPAIGN_REGISTER_HREF.replace(/^\/|\/$/g, '');
  let page = '';
  try { page = read(`../../pages/${file}.astro`); } catch { page = ''; }
  assert.ok(page, `登録ページが存在しない: ${CAMPAIGN_REGISTER_HREF}`);
  assert.doesNotMatch(page, /requiredPlan/, '登録ページが会員専用になっている');
});

test('すでに特別価格の商品には重ねない（画面の額を変えない）', () => {
  const special = BUTTONS.filter((b) => hasOwnSpecialPrice(b.productName));
  assert.ok(special.length > 0, '特別価格の商品が見つからない（前提が変わった）');
  for (const b of special) {
    for (const [, ent] of AUDIENCES) {
      assert.equal(chargedFor(b.productName, b.shown, ent), b.shown,
        `${b.productName}: 特別価格を上書きしている`);
    }
  }
});

// ── ページ上部のご案内（2026-08-25 MK「/free-signup/ や /pricing/ にも記載すべき」）──
//
// ⚠️ 文言・金額・期限・行き先を**ページごとに書かない**。
//    3 か所で食い違った事故を 8/24〜25 に繰り返しているため、
//    共通部品 + サーバーの文言に限定する。

test('ご案内はサーバーの文言だけを出す（ページで作らない）', () => {
  const c = read('../../components/CampaignBanner.astro');
  // ⚠️ 2026-08-25: 出し方の判定は純粋関数（campaignBannerView.js）へ移した。
  //    画面はその戻り値をそのまま出すだけ。
  for (const k of ['view.headline', 'view.sub', 'view.cta.href', 'view.cta.label']) {
    assert.ok(c.includes(k), `${k} を使っていない`);
  }
  // 金額・期限・行き先を直書きしない
  assert.doesNotMatch(c, /\b(4980|4480|49800|44800|78000|68000|10,000|500円)\b/, '金額を直書きしている');
  assert.doesNotMatch(c, /\d+年\d+月\d+日/, '期限を直書きしている');
  assert.doesNotMatch(c, /\/free-signup\//, '行き先を直書きしている');
  // 出すかどうかもサーバーが決める / 取れなければ出さない
  assert.match(c, /if \(!view\.show\) return;/, '出す条件を画面で決めている');
  assert.match(c, /catch\(\(\) => \{\}\)/, '取得に失敗しても出してしまう');
});

test('必要なページに置かれている（増やすときは 1 行）', () => {
  for (const [label, rel] of [
    ['料金プラン', '../../pages/pricing.astro'],
    ['無料登録', '../../pages/free-signup.astro'],
  ]) {
    const page = read(rel);
    assert.match(page, /<CampaignBanner \/>/, `${label}: ご案内が置かれていない`);
    assert.match(page, /import CampaignBanner/, `${label}: import が無い`);
    // ページ側に文言・金額を書いていない
    const own = page.slice(0, page.indexOf('<CampaignBanner />'));
    assert.doesNotMatch(own, /円OFF/, `${label}: ページに割引の文言を書いている`);
  }
});

test('ご案内の文言はサーバーが組み立てる', () => {
  const api = read('../../pages/api/campaign.json.js');
  assert.match(api, /const banner = \(\(\) => \{/, 'サーバーが文言を持っていない');
  // 未登録には「登録すると何が得か」、登録済みには「その方が使える割引」
  assert.match(api, /無料登録で最大/, '未登録の方への案内が無い');
  assert.match(api, /describeCampaignDeadline\(\)/, '期限を単一源から出していない');
  // 期間外・対象なしなら出さない
  assert.match(api, /if \(!view\.active\) return \{ show: false \}/, '期間外でも出してしまう');
});
