/**
 * rankNotice.test.mjs — お知らせが 0 件にならないことを固定する
 *
 * MK 指示（2026-09-08）「期限が切れたら自動で新しい通知にしたい　会員ランクに応じたお知らせ」。
 * Premium Plus クーポンが期限切れになると通知が消え、三連複会員はキャンペーン割引の
 * 対象外なので**ベルが空になっていた**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { describeRankNotice, RANK_NOTICE_HREF } from './rankNotice.js';
import { describeAllNotices } from '../premiumPlus/couponNotice.js';

const ent = (over = {}) => ({
  canViewLight: false, canViewPremium: false, canViewSanrenpuku: false, ...over,
});

// ── ランクごとの出し分け ────────────────────────────────────
test('無料の方には有料プランのご案内', () => {
  const n = describeRankNotice({ entitlements: ent() });
  assert.equal(n.show, true);
  assert.equal(n.href, RANK_NOTICE_HREF.PRICING);
});

test('Light の方に Light は勧めない（Premium のご案内）', () => {
  const n = describeRankNotice({ entitlements: ent({ canViewLight: true }) });
  assert.equal(n.show, true);
  assert.match(n.label, /Premium/);
  assert.doesNotMatch(n.label, /Light/, 'すでに持っている Light を勧めている');
});

test('Premium の方には三連複のご案内', () => {
  const n = describeRankNotice({ entitlements: ent({ canViewLight: true, canViewPremium: true }) });
  assert.equal(n.show, true);
  assert.equal(n.href, RANK_NOTICE_HREF.SANRENPUKU);
});

test('三連複の方には Premium Plus（販売中／停止中で文言が変わる）', () => {
  const base = { entitlements: ent({ canViewLight: true, canViewPremium: true, canViewSanrenpuku: true }), plusAllowed: true };
  const onSale = describeRankNotice({ ...base, plusPurchasable: true });
  const paused = describeRankNotice({ ...base, plusPurchasable: false });
  assert.equal(onSale.show, true);
  assert.equal(paused.show, true);
  assert.notEqual(onSale.label, paused.label, '販売中と停止中で同じ文言になっている');
  assert.equal(paused.href, RANK_NOTICE_HREF.PLUS);
});

// ── 存在秘匿 ────────────────────────────────────────────────
test('【重要】Plus 対象外の三連複会員には Premium Plus を出さない（存在秘匿）', () => {
  const n = describeRankNotice({
    entitlements: ent({ canViewLight: true, canViewPremium: true, canViewSanrenpuku: true }),
    plusAllowed: false, plusPurchasable: false,
  });
  assert.equal(n.show, false, '管理画面で対象外にした会員に商品名を出している');
  assert.equal(n.label, '');
});

// ── まとめ役でのフォールバック ────────────────────────────────
const usableCoupon = { claimed: true, claimedAt: '2026-08-22T23:10:37.041Z', usage: { known: true, used: false, reserved: false } };
const expiredCoupon = { claimed: true, claimedAt: '2026-08-22T23:10:37.041Z', usage: { known: true, used: false, reserved: false, expired: true } };
const plusRank = describeRankNotice({
  entitlements: ent({ canViewLight: true, canViewPremium: true, canViewSanrenpuku: true }),
  plusAllowed: true, plusPurchasable: false,
});

test('【本件の要件】クーポンが期限切れになったら、自動でランク別のお知らせに入れ替わる', () => {
  const before = describeAllNotices({ coupon: usableCoupon, rankNotice: plusRank, seen: {} });
  assert.equal(before.total, 1);
  assert.equal(before.all[0].kind, 'usable', '期限内はクーポンのお知らせが出る');

  const after = describeAllNotices({ coupon: expiredCoupon, rankNotice: plusRank, seen: {} });
  assert.equal(after.total, 1, '期限切れ後にお知らせが 0 件になっている');
  assert.equal(after.all[0].kind, 'rank');
  assert.equal(after.all[0].href, RANK_NOTICE_HREF.PLUS);
});

test('行動があるお知らせがあるときは、ランク別の土台を並べない', () => {
  const r = describeAllNotices({ coupon: usableCoupon, rankNotice: plusRank, seen: {} });
  assert.equal(r.total, 1, 'クーポンとランク別が二重に出ている');
});

test('ランク別だけのときは一度見たら赤い点が消える（ナビには残る）', () => {
  const first = describeAllNotices({ coupon: null, rankNotice: plusRank, seen: {} });
  assert.equal(first.count, 1, '未読として出ない');
  const seen = { [first.all[0].kind]: first.all[0].signature };
  const again = describeAllNotices({ coupon: null, rankNotice: plusRank, seen });
  assert.equal(again.count, 0, '既読なのに赤い点が出続ける');
  assert.equal(again.total, 1, 'ナビからお知らせごと消えている');
});

test('rankNotice を渡さない呼び出しでも壊れない（後方互換）', () => {
  const r = describeAllNotices({ coupon: expiredCoupon, seen: {} });
  assert.equal(r.total, 0);
});
