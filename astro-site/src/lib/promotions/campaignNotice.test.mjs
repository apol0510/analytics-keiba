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

test('Premium の方には三連複だけ。申込先も三連複のページ', () => {
  const v = describeCampaignForMember({ entitlements: { canViewPremium: true }, nowMs: IN });
  assert.equal(v.offers.length, 1);
  assert.equal(v.offers[0].applyHref, '/premium-sanrenpuku/');
  assert.equal(v.offers[0].offerPriceText, '¥14,820');
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
  const n = describeCampaignNotice(describeCampaignForMember({ entitlements: { canViewPremium: true }, nowMs: IN }));
  assert.match(n.label, /Sanrenpuku/);
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
  assert.doesNotMatch(body, /[0-9]{3,}/, '金額を直書きしている');
  assert.doesNotMatch(body, /toLocaleString/, '画面で金額を整形している');
  // 対象が無ければ出さない
  assert.match(body, /if \(!offers\.length\)/);
});

test('API がキャンペーンを返す（お知らせと同じ 1 回の通信に相乗り）', () => {
  const api = read('../../pages/api/upsell.json.js');
  assert.match(api, /describeCampaignForMember/);
  assert.match(api, /campaign,/, '応答に載せていない');
  const client = read('../../lib/upsell/upsellClient.js');
  assert.match(client, /d && d\.campaign/, 'クライアントが読んでいない');
  assert.doesNotMatch(client.slice(client.indexOf('getCouponNotice')), /fetch\(/, '通信を増やしている');
});
