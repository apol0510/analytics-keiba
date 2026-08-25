/**
 * campaignNotice.test.mjs — キャンペーン割引が**お客様に届く**ことを固定する
 *
 * 案内が出ない割引は、無いのと同じ。逆に、申込で乗らない割引を案内すると行き違いになる。
 * ここでは「お知らせ → マイページのカード → 申込先」が**同じ単一源**から作られることを見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  describeCampaignForMember, CAMPAIGN_WINDOW, CAMPAIGN_OFFER_IDS, isCampaignActive,
} from './campaignOffers.js';
import { describeCampaignNotice, describeAllNotices } from '../premiumPlus/couponNotice.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const IN = Date.parse('2026-08-25T03:00:00Z');
const OUT = Date.parse('2026-10-01T00:00:00Z');

// ── 期間 ────────────────────────────────────────────────────
test('期間内だけ案内する（期間外は 1 件も出さない）', () => {
  assert.equal(isCampaignActive(IN), true);
  assert.equal(isCampaignActive(OUT), false);
  assert.equal(describeCampaignForMember({ entitlements: {}, nowMs: OUT }).offers.length, 0);
  assert.equal(describeCampaignNotice(describeCampaignForMember({ entitlements: {}, nowMs: OUT })).show, false);
});

test('期限の表示は 1 か所から作る（画面ごとにズレない）', () => {
  const v = describeCampaignForMember({ entitlements: {}, nowMs: IN });
  assert.match(v.deadlineText, /\d+年\d+月\d+日まで/);
  // 開始 + 14 日
  const days = (Date.parse(CAMPAIGN_WINDOW.endsAtIso) - Date.parse(CAMPAIGN_WINDOW.startsAtIso)) / 86400000;
  assert.equal(days, 14);
});

// ── 何が届くか ──────────────────────────────────────────────
test('無料の方には 3 件。金額はサーバーが文字列で渡す', () => {
  const v = describeCampaignForMember({ entitlements: {}, nowMs: IN });
  assert.equal(v.offers.length, 3);
  const light = v.offers.find((o) => o.offerId === CAMPAIGN_OFFER_IDS.LIGHT_MONTHLY);
  assert.equal(light.regularPriceText, '¥4,980');
  assert.equal(light.offerPriceText, '¥4,480');
  assert.equal(light.discountText, '500円OFF');
  assert.equal(light.applyHref, '/pricing/');
});

test('Premium の方には三連複（買い切り）だけを案内する', () => {
  const v = describeCampaignForMember({ entitlements: { canViewPremium: true }, nowMs: IN });
  assert.equal(v.offers.length, 1);
  assert.equal(v.offers[0].regularPriceText, '¥78,000');
  assert.equal(v.offers[0].offerPriceText, '¥68,000');
});

// ── 申込先が**実際に開けるか**（2026-08-24 の本番事故）──────────────
//
// ⚠️ 以前のテストは `applyHref === '/premium-sanrenpuku/'` と、
//    **自分が書いた値を自分で確認していただけ**で、そこが開けるかを見ていなかった。
//    実際には会員専用ページで、Premium の方は 302 → ログイン画面へ飛ばされた。
//    ここでは「その行き先が、案内する相手にとって開けるか」を検査する。

/** そのページが会員資格を要求しているか（`AccessControl requiredPlan`）*/
function requiredPlanOf(pathname) {
  const file = pathname.replace(/^\/|\/$/g, '') || 'index';
  let src = '';
  try { src = read(`../../pages/${file}.astro`); } catch { return null; }
  const m = /requiredPlan[=:]\s*["']([^"']+)["']/.exec(src);
  return m ? m[1] : '';
}

test('案内する行き先は、その相手が開けるページだけ', () => {
  const audiences = [
    ['無料の方', {}],
    ['Light の方', { canViewLight: true }],
    ['Premium の方', { canViewPremium: true }],
  ];
  for (const [label, ent] of audiences) {
    for (const o of describeCampaignForMember({ entitlements: ent, nowMs: IN }).offers) {
      if (!o.applyHref) continue;   // 行き先が無いものは下のテストで見る
      const required = requiredPlanOf(o.applyHref);
      assert.notEqual(required, null, `${label}: ${o.applyHref} が存在しない`);
      assert.equal(required, '',
        `${label}: ${o.applyHref} は「${required}」が要る会員ページ。開けない相手へ案内している`);
    }
  }
});

test('三連複を再開するときは行き先を持たせない（開けないページへ送らない）', () => {
  // ⚠️ `/premium-sanrenpuku/` は**すでに持っている人の会員ページ**。購入導線ではない。
  //    リポジトリにも「推測で URL を作らない」と明記されている。
  //    2026-08-24 にここへ送って `/login/?r=not_entitled` に飛ばした。
  assert.equal(requiredPlanOf('/premium-sanrenpuku/'), 'Premium Sanrenpuku',
    '前提が変わった。会員ページでなくなったなら行き先を見直すこと');
  const src = read('./campaignOffers.js');
  assert.doesNotMatch(src, /SANRENPUKU_MONTHLY\]: '\/premium-sanrenpuku\/'/,
    '開けないページを行き先にしている');
});

test('行き先が無いときに既定値で埋めない（開けないページへ送らない）', () => {
  const src = read('./campaignOffers.js');
  assert.doesNotMatch(src, /APPLY_HREF\[o\.offerId\] \|\| '\/pricing\/'/,
    '行き先が無い商品を /pricing/ で埋めている');
  const page = read('../../pages/dashboard.astro');
  const fn = page.slice(page.indexOf('function renderCampaign'));
  const body = fn.slice(0, fn.indexOf('\n      }\n'));
  // 行き先も操作も無ければボタンを出さない
  assert.match(body, /if \(cta\) \{/, '押せないボタンを出している');
  assert.match(body, /premiumPlanModal/, '同じページの購入導線を開いていない');
});

test('三連複をお持ちの方には出さない', () => {
  const v = describeCampaignForMember({ entitlements: { canViewPremium: true, canViewSanrenpuku: true }, nowMs: IN });
  assert.equal(v.offers.length, 0);
  assert.equal(v.signature, '');
});

// ── お知らせの件数 ──────────────────────────────────────────
test('割引が何本あっても、お知らせは 1 件として数える（水増ししない）', () => {
  const n = describeCampaignNotice(describeCampaignForMember({ entitlements: {}, nowMs: IN }));
  assert.equal(n.show, true);
  assert.equal(n.count, 1);
  assert.match(n.label, /3 件/);
});

test('1 本だけのときは商品名をそのまま出す', () => {
  // Light をお持ちの方は Premium 年額・買い切りの 2 本。1 本だけの状況を直接作る
  const one = {
    active: true, deadlineText: '2026年9月6日まで', signature: 'campaign:x:one',
    offers: [{ offerId: 'x', name: 'テスト割引' }],
  };
  const n = describeCampaignNotice(one);
  assert.match(n.label, /テスト割引/);
  assert.match(n.label, /まで/, '期限が入っていない');
});

test('クーポンと割引は別々に数える（片方を見てもう片方が消えない）', () => {
  const campaign = describeCampaignForMember({ entitlements: {}, nowMs: IN });
  const coupon = {
    claimed: true, claimedAt: '2026-08-23T13:06:14.313Z',
    usage: { known: true, used: false, reserved: false },
  };
  const both = describeAllNotices({ coupon, campaign, seen: {} });
  assert.equal(both.count, 2, '2 種類のお知らせが 1 件にまとめられている');

  // 割引だけ既読にしても、クーポンのお知らせは残る
  const campaignNotice = describeCampaignNotice(campaign);
  const after = describeAllNotices({ coupon, campaign, seen: { campaign: campaignNotice.signature } });
  assert.equal(after.count, 1);
  assert.equal(after.items[0].kind, 'usable');
});

test('同じキャンペーンを一度見たら出続けない', () => {
  const campaign = describeCampaignForMember({ entitlements: {}, nowMs: IN });
  const n = describeCampaignNotice(campaign);
  assert.equal(describeAllNotices({ campaign, seen: { campaign: n.signature } }).count, 0);
});

// ── 画面への配線 ────────────────────────────────────────────
test('マイページは金額を組み立てない（サーバーの文字列を出すだけ）', () => {
  const page = read('../../pages/dashboard.astro');
  assert.match(page, /function renderCampaign/, 'キャンペーンを描画していない');
  const fn = page.slice(page.indexOf('function renderCampaign'));
  const body = fn.slice(0, fn.indexOf('\n      }\n'));
  assert.match(body, /o\.regularPriceText/);
  assert.match(body, /o\.offerPriceText/);
  assert.match(body, /o\.applyHref/, '申込先を画面で組み立てている');
  // 金額・割引率を画面で計算しない
  // ⚠️ コメントは除いて見る（説明の日付・年号まで禁止すると正しい実装が落ちる）
  const code = body.replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /[0-9]{3,}/, '金額を直書きしている');
  assert.doesNotMatch(code, /toLocaleString/, '画面で金額を整形している');
  // 対象が無ければ出さない
  assert.match(body, /if \(!offers\.length\)/);
});

test('JS で作る要素にスタイルが当たる（scoped では効かない）', () => {
  // ⚠️ 2026-08-24 の本番不具合: 申込ボタンが**素のリンク**として出ていた。
  //    Astro の scoped style は `[data-astro-cid-…]` へ変換されるため、
  //    JS で生成した要素には一切適用されない。この 2 つのカードは中身を JS で作るので
  //    **`is:global` で書かなければならない**。
  const page = read('../../pages/dashboard.astro');
  const globalStart = page.indexOf('<style is:global>');
  assert.ok(globalStart > 0, 'is:global の style が無い');
  const globalCss = page.slice(globalStart, page.indexOf('</style>', globalStart));

  // JS で作る要素のクラスは**すべて** is:global 側にあること
  for (const cls of [
    '.campaign-apply', '.campaign-name', '.campaign-price',
    '.notice-list a', '.notice-count',
  ]) {
    assert.ok(globalCss.includes(cls), `${cls} が scoped 側に残っている（スタイルが当たらない）`);
  }

  // 申込ボタンは**リンクに見せない**（押せると分かる見た目にする）
  const btn = globalCss.slice(globalCss.indexOf('.campaign-apply {'));
  const rule = btn.slice(0, btn.indexOf('\n      }'));
  assert.match(rule, /background: linear-gradient/, 'ボタンの地色が無い');
  assert.match(rule, /text-decoration: none !important/, '下線が残る');
  assert.match(rule, /color: #fff !important/, '共通のリンク色に負ける');
  // ⚠️ `<a>` と `<button>` の両方で使うので、見た目が揃うよう明示しておく
  assert.match(rule, /font-family: inherit/, 'button だけ別のフォントになる');
  assert.match(rule, /border: 0/, 'button に既定の枠が出る');
  assert.match(rule, /cursor: pointer/, '押せると分からない');
  // 指で押せる大きさ
  const min = /min-height: (\d+)px/.exec(rule);
  assert.ok(min && Number(min[1]) >= 44, `タップ領域が小さい: ${rule}`);
  // 押せないときは押せなく見せる
  assert.match(globalCss, /\.campaign-apply\[disabled\]/, '無効時の見た目が無い');
  assert.match(globalCss, /cursor: not-allowed/, '無効なのに押せそうに見える');
});

test('API がキャンペーンを返す（お知らせと同じ 1 回の通信に相乗り）', () => {
  const api = read('../../pages/api/upsell.json.js');
  assert.match(api, /describeCampaignForMember/);
  assert.match(api, /campaign,/, '応答に載せていない');
  const client = read('../../lib/upsell/upsellClient.js');
  assert.match(client, /d && d\.campaign/, 'クライアントが読んでいない');
  // ⚠️ 有料の方は既存の 1 回に相乗りする（`getUpsellDecision()` の結果を使う）。
  //    追加の通信は**無料の方だけ**（セッションが無く 404 になるため）。
  const fn = client.slice(client.indexOf('export async function getCampaign'));
  assert.match(fn, /const d = await getUpsellDecision\(\)/);
  assert.match(fn, /if \(d && d\.campaign\) return d\.campaign/, '有料の方にも通信を増やしている');
  assert.match(fn, /\/api\/campaign\.json/, '無料の方への経路が無い');
});
