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

const sanrenpuku = ent({ canViewLight: true, canViewPremium: true, canViewSanrenpuku: true });

test('【確定仕様】販売停止中は Premium Plus のお知らせを出さない（2026-09-08 MK）', () => {
  const n = describeRankNotice({
    entitlements: sanrenpuku, plusAllowed: true, plusPurchasable: false,
    reopenStartsAt: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(n.show, false, '停止中に「募集再開をお待ちください」を常設表示している');
  assert.equal(n.label, '');
});

test('【確定仕様】募集を再開したら「募集を再開しました」を出す', () => {
  const n = describeRankNotice({
    entitlements: sanrenpuku, plusAllowed: true, plusPurchasable: true,
    reopenStartsAt: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(n.show, true);
  assert.match(n.label, /募集を再開しました/);
  assert.equal(n.href, RANK_NOTICE_HREF.PLUS);
});

test('停止中の文言そのものを持たない（復活させない）', () => {
  const all = [
    describeRankNotice({ entitlements: sanrenpuku, plusAllowed: true, plusPurchasable: false }),
    describeRankNotice({ entitlements: sanrenpuku, plusAllowed: true, plusPurchasable: true }),
  ].map((n) => n.label).join(' ');
  assert.doesNotMatch(all, /お待ちください/, '停止中を待たせる文言が復活している');
});

test('再開のたびに別のお知らせになる（2 回目の再開でも赤い点が出る）', () => {
  const first = describeRankNotice({
    entitlements: sanrenpuku, plusAllowed: true, plusPurchasable: true,
    reopenStartsAt: '2026-09-01T00:00:00.000Z',
  });
  const second = describeRankNotice({
    entitlements: sanrenpuku, plusAllowed: true, plusPurchasable: true,
    reopenStartsAt: '2026-10-01T00:00:00.000Z',
  });
  assert.notEqual(first.signature, second.signature, '2 回目の再開が既読扱いになる');
});

// ── 存在秘匿 ────────────────────────────────────────────────
test('【重要】Plus 対象外の三連複会員には Premium Plus を出さない（存在秘匿・販売中でも）', () => {
  for (const purchasable of [false, true]) {
    const n = describeRankNotice({
      entitlements: sanrenpuku, plusAllowed: false, plusPurchasable: purchasable,
      reopenStartsAt: '2026-09-01T00:00:00.000Z',
    });
    assert.equal(n.show, false, '管理画面で対象外にした会員に商品名を出している');
    assert.equal(n.label, '');
  }
});

// ── まとめ役でのフォールバック ────────────────────────────────
const usableCoupon = { claimed: true, claimedAt: '2026-08-22T23:10:37.041Z', usage: { known: true, used: false, reserved: false } };
const expiredCoupon = { claimed: true, claimedAt: '2026-08-22T23:10:37.041Z', usage: { known: true, used: false, reserved: false, expired: true } };
const plusRank = describeRankNotice({
  entitlements: sanrenpuku, plusAllowed: true, plusPurchasable: true,
  reopenStartsAt: '2026-09-01T00:00:00.000Z',
});

test('【確定仕様】停止中はお知らせが 0 件でよい（無理に埋めない）', () => {
  const paused = describeRankNotice({
    entitlements: sanrenpuku, plusAllowed: true, plusPurchasable: false,
  });
  const r = describeAllNotices({ coupon: expiredCoupon, rankNotice: paused, seen: {} });
  assert.equal(r.total, 0, '停止中なのにお知らせを作っている');
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
