/**
 * customerTimeline.test.mjs — 1 顧客の時系列履歴
 *   node --test src/lib/marketing/customerTimeline.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCustomerTimeline,
  summarizeEngagement,
  TL_TYPE,
  TL_SOURCE,
} from './customerTimeline.js';

const NOW = Date.parse('2026-08-01T06:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const rec = (fields) => ({ id: 'recX', fields, createdTime: '2025-09-23T02:41:41.000Z' });
const build = (fields, extra = {}) => buildCustomerTimeline({ record: rec(fields), nowMs: NOW, ...extra });

test('新しい順に並ぶ / 各行に出所が付く', () => {
  const t = build({
    Email: 'x@example.com', '登録日': iso(NOW - 300 * DAY), '最終ログイン': iso(NOW - DAY),
    PaidAt: iso(NOW - 200 * DAY), '有効期限': '2026-04-19', 'プラン': 'Light',
  });
  const times = t.events.map((e) => e.atMs);
  assert.deepEqual([...times].sort((a, b) => b - a), times, '降順になっていない');
  assert.ok(t.events.every((e) => e.source), '出所の無い行がある');
  assert.ok(t.events.every((e) => e.label), 'ラベルの無い行がある');
  assert.equal(t.events[0].type, TL_TYPE.LOGIN, '最新がログインでない');
});

test('登録・入金・契約終了・退会が Customers 由来として出る', () => {
  const t = build({
    Email: 'x@example.com', '登録日': iso(NOW - 300 * DAY), PaidAt: iso(NOW - 200 * DAY),
    '有効期限': '2026-04-19', 'プラン': 'Premium', PlanType: 'Annual',
    WithdrawalRequested: true, WithdrawalDate: iso(NOW - 10 * DAY), WithdrawalReason: 'テスト理由',
  });
  const types = t.events.map((e) => e.type);
  for (const k of [TL_TYPE.REGISTERED, TL_TYPE.PAYMENT_CONFIRMED, TL_TYPE.CONTRACT_EXPIRES, TL_TYPE.WITHDRAWAL]) {
    assert.ok(types.includes(k), `${k} が出ていない`);
  }
  assert.ok(t.events.filter((e) => e.source === TL_SOURCE.CUSTOMERS).length >= 4);
  const paid = t.events.find((e) => e.type === TL_TYPE.PAYMENT_CONFIRMED);
  assert.match(paid.detail, /Premium/);
  assert.equal(paid.field, 'PaidAt', 'どの列由来か分からない');
});

test('無料特典は 付与 / 取消 / 終了 を区別する（取消済みなら終了予定を出さない）', () => {
  const active = build({
    Email: 'x@example.com', LightGrantedAt: iso(NOW - 2 * DAY), LightGrantUntil: iso(NOW + 28 * DAY),
    LightGrantedBy: 'support',
  });
  const at = active.events.map((e) => e.type);
  assert.ok(at.includes(TL_TYPE.GRANT_GIVEN));
  assert.ok(at.includes(TL_TYPE.GRANT_ENDS));

  const revoked = build({
    Email: 'x@example.com', LightGrantedAt: iso(NOW - 20 * DAY), LightGrantUntil: iso(NOW + 10 * DAY),
    LightGrantRevokedAt: iso(NOW - DAY), LightGrantRevokeReason: '誤付与',
  });
  const rt = revoked.events.map((e) => e.type);
  assert.ok(rt.includes(TL_TYPE.GRANT_REVOKED));
  assert.equal(rt.includes(TL_TYPE.GRANT_ENDS), false, '取消済みなのに終了予定を出している');
});

test('オファーは 発行 / 期限 / 申込 を出し、取消は日時不明として分離する', () => {
  const offers = [
    { fields: { CustomerRecordId: 'recX', OfferId: 'premium-annual-half', Status: 'issued', StartsAt: iso(NOW - 2 * DAY), ExpiresAt: iso(NOW + 12 * DAY), RegularPrice: 49800, OfferPrice: 24900 } },
    { fields: { CustomerRecordId: 'recX', OfferId: 'premium-30d-half', Status: 'revoked', StartsAt: iso(NOW - 30 * DAY), ExpiresAt: iso(NOW - 16 * DAY) } },
    { fields: { CustomerRecordId: 'recX', OfferId: 'light-lifetime-free', Status: 'redeemed', StartsAt: iso(NOW - 50 * DAY), ExpiresAt: iso(NOW - 36 * DAY), RedeemedAt: iso(NOW - 40 * DAY) } },
  ];
  const t = build({ Email: 'x@example.com' }, { offerRecords: offers });
  const types = t.events.map((e) => e.type);
  assert.ok(types.includes(TL_TYPE.OFFER_ISSUED));
  assert.ok(types.includes(TL_TYPE.OFFER_EXPIRES));
  assert.ok(types.includes(TL_TYPE.OFFER_REDEEMED));
  // 取消は日時が台帳に無いので unknownDateEvents 側へ
  assert.equal(types.includes(TL_TYPE.OFFER_REVOKED), false, '取消に日時をでっち上げている');
  assert.equal(t.unknownDateEvents.length, 1);
  assert.equal(t.unknownDateEvents[0].type, TL_TYPE.OFFER_REVOKED);
  assert.equal(t.unknownDateEvents[0].atMs, null);
  assert.equal(t.limits.offerRevokeHasNoTimestamp, true);
  // 申込済み・取消済みには「期限」行を出さない（終わった話なので）
  assert.equal(t.events.filter((e) => e.type === TL_TYPE.OFFER_EXPIRES).length, 1);
});

test('キャンペーン送信は sent と skipped を区別する', () => {
  const deliveries = [
    { fields: { RecipientEmail: 'x@example.com', CampaignType: 'comeback-offer:v2', Status: 'sent', SentAt: iso(NOW - 3 * DAY) } },
    { fields: { RecipientEmail: 'x@example.com', CampaignType: 'marketing-canary:v1', Status: 'skipped-duplicate', QueuedAt: iso(NOW - 5 * DAY), Metadata: 'offer_missing' } },
    { fields: { RecipientEmail: 'other@example.com', CampaignType: 'x:v1', Status: 'sent', SentAt: iso(NOW) } },
  ];
  const t = build({ Email: 'x@example.com' }, { deliveryRecords: deliveries });
  const mine = t.events.filter((e) => e.source === TL_SOURCE.DELIVERIES);
  assert.equal(mine.length, 2, '他人の配信が混ざっている / 自分の配信が落ちている');
  assert.ok(mine.some((e) => e.type === TL_TYPE.CAMPAIGN_SENT));
  const skipped = mine.find((e) => e.type === TL_TYPE.CAMPAIGN_SKIPPED);
  assert.match(skipped.detail, /skipped-duplicate/);
});

test('AuthTokens は使用済みだけをログインとして出す', () => {
  const tokens = [
    { fields: { Email: 'x@example.com', Used: true, CreatedAt: iso(NOW - 7 * DAY) } },
    { fields: { Email: 'x@example.com', Used: false, CreatedAt: iso(NOW - DAY) } },
    { fields: { Email: 'other@example.com', Used: true, CreatedAt: iso(NOW) } },
  ];
  const t = build({ Email: 'x@example.com' }, { tokenRecords: tokens });
  const logins = t.events.filter((e) => e.source === TL_SOURCE.AUTH_TOKENS);
  assert.equal(logins.length, 1, '未使用トークン・他人のトークンを数えている');
});

test('開封・クリックは渡された分だけ出す（取得できないときは 0 と言わない）', () => {
  const none = build({ Email: 'x@example.com' });
  assert.equal(none.limits.engagementAvailable, false);
  const s1 = summarizeEngagement({ events: none.events, available: none.limits.engagementAvailable });
  assert.equal(s1.available, false);
  assert.equal(s1.opened, null, '取得できていないのに 0 と表示しようとしている');
  assert.equal(s1.clicked, null);

  const withActivity = build({ Email: 'x@example.com' }, {
    activityAvailable: true,
    activityEvents: [
      { atMs: NOW - 2 * DAY, kind: 'delivered', detail: '配信テスト' },
      { atMs: NOW - DAY, kind: 'open', detail: '配信テスト' },
    ],
  });
  assert.equal(withActivity.limits.engagementAvailable, true);
  const s2 = summarizeEngagement({ events: withActivity.events, available: true });
  assert.equal(s2.opened, 1);
  assert.equal(s2.clicked, 0);
  assert.equal(s2.lastOpenAt, iso(NOW - DAY));
});

test('取得できない情報を limits で明示する（問い合わせ台帳・契約履歴）', () => {
  const t = build({ Email: 'x@example.com' });
  assert.equal(t.limits.inquiriesAvailable, false, '問い合わせ台帳が無いのに「ある」と言っている');
  assert.equal(t.limits.contractHistoryIsSnapshotOnly, true);
});

test('日時の無い値から出来事を作らない（欠損は行ごと出さない）', () => {
  const t = build({ Email: 'x@example.com', 'プラン': 'Free' });
  // 登録日が無くても createdTime があるので 1 行だけ。捏造した行が無いこと
  assert.ok(t.events.length <= 1);
  assert.ok(t.events.every((e) => e.atMs != null));
});
