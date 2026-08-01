/**
 * customerDossier.test.mjs — 1 顧客カルテの組み立て
 *   node --test src/lib/marketing/customerDossier.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCustomerDossier,
  resolveLastLogin,
  daysSinceLogin,
  loginSegment,
  summarizeMagicLinkLogins,
  LOGIN_SOURCE,
  LOGIN_SEGMENT,
} from './customerDossier.js';

const NOW = Date.parse('2026-08-01T02:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

const rec = (fields, id = 'recX') => ({ id, fields, createdTime: '2025-09-23T02:41:41.000Z' });
const build = (fields, extra = {}) => buildCustomerDossier({ record: rec(fields), nowMs: NOW, ...extra });

// =========================================================================
// 最終ログイン: 3 つの出所と優先順位
// =========================================================================

test('LastLoginAt があれば最優先で採用し、出所を明示する', () => {
  const r = resolveLastLogin({
    fields: { LastLoginAt: iso(NOW - 2 * DAY), '最終ポイント付与日': '2026-06-01' },
    magicLinkAtMs: NOW - 10 * DAY,
  });
  assert.equal(r.source, LOGIN_SOURCE.FIELD);
  assert.equal(r.at, iso(NOW - 2 * DAY));
  // 内訳は全部返す（画面で「どの記録か」を出せる）
  assert.equal(r.sources[LOGIN_SOURCE.MAGIC_LINK], iso(NOW - 10 * DAY));
  assert.ok(r.sources[LOGIN_SOURCE.LEGACY_POINTS]);
});

test('LastLoginAt が無ければマジックリンク → 旧ポイントの順に落ちる', () => {
  const magic = resolveLastLogin({ fields: { '最終ポイント付与日': '2026-06-01' }, magicLinkAtMs: NOW - DAY });
  assert.equal(magic.source, LOGIN_SOURCE.MAGIC_LINK);

  const legacy = resolveLastLogin({ fields: { '最終ポイント付与日': '2026-06-01' } });
  assert.equal(legacy.source, LOGIN_SOURCE.LEGACY_POINTS);
  assert.equal(legacy.at, '2026-06-01T00:00:00.000Z');

  const none = resolveLastLogin({ fields: {} });
  assert.equal(none.source, LOGIN_SOURCE.NONE);
  assert.equal(none.at, null);
  assert.equal(none.atMs, null);
});

test('新しい方ではなく信頼できる順で選ぶ（古い正規記録が新しい旧データに負けない）', () => {
  const r = resolveLastLogin({
    fields: { LastLoginAt: iso(NOW - 100 * DAY), '最終ポイント付与日': '2026-07-31' },
  });
  assert.equal(r.source, LOGIN_SOURCE.FIELD, '旧ポイント日付が正規記録を上書きしている');
});

test('経過日数とセグメント', () => {
  assert.equal(daysSinceLogin(resolveLastLogin({ fields: { LastLoginAt: iso(NOW - 5 * DAY) } }), NOW), 5);
  assert.equal(daysSinceLogin(resolveLastLogin({ fields: {} }), NOW), null);
  assert.equal(loginSegment(0), LOGIN_SEGMENT.D30);
  assert.equal(loginSegment(30), LOGIN_SEGMENT.D30);
  assert.equal(loginSegment(31), LOGIN_SEGMENT.D90);
  assert.equal(loginSegment(365), LOGIN_SEGMENT.D365);
  assert.equal(loginSegment(366), LOGIN_SEGMENT.OVER365);
  assert.equal(loginSegment(null), LOGIN_SEGMENT.NEVER);
});

test('AuthTokens は使用済みだけを最終ログインとして数える', () => {
  const map = summarizeMagicLinkLogins([
    { fields: { Email: 'A@Example.com ', Used: true, CreatedAt: iso(NOW - 3 * DAY) } },
    { fields: { Email: 'a@example.com', Used: true, CreatedAt: iso(NOW - DAY) } },
    { fields: { Email: 'a@example.com', Used: false, CreatedAt: iso(NOW) } }, // 未使用＝ログインしていない
    { fields: { Email: '', Used: true, CreatedAt: iso(NOW) } },
  ]);
  assert.equal(map.size, 1);
  assert.equal(map.get('a@example.com'), NOW - DAY, '未使用トークンを最終ログインにしている');
});

// =========================================================================
// カルテ本体
// =========================================================================

test('期限切れ会員: ログインできる／有料は見えない／理由が読める', () => {
  const d = build({
    Email: 'x@example.com', '氏名': '山田', 'プラン': 'Light', PlanType: 'Monthly',
    Status: 'active', '有効期限': '2026-04-19',
  });
  assert.equal(d.login.memberType, 'free');
  assert.equal(d.login.canLogin, true);
  assert.equal(d.login.loginMethod, 'instant');
  assert.equal(d.login.reason, 'expired');
  assert.equal(d.login.label, '期限切れ → 無料会員としてログインできる');
  assert.equal(d.login.sessionPlan, 'free');
  assert.equal(d.access.canViewLight, false);
  assert.equal(d.access.canViewPremium, false);
  assert.equal(d.contract.contractState, 'expired');
  assert.equal(d.contract.plan, 'Light', '契約欄には実際の契約プランを出す');
});

test('利用停止: ログイン不可として出る', () => {
  const d = build({ Email: 'x@example.com', 'プラン': 'Premium', Status: 'suspended' });
  assert.equal(d.login.canLogin, false);
  assert.equal(d.login.memberType, 'denied');
  assert.equal(d.login.label, '利用停止（ログイン不可）');
});

test('無料特典つき: ログインリンク必須・特典の内訳と残期限が出る', () => {
  const until = iso(NOW + 20 * DAY);
  const d = build({
    Email: 'x@example.com', 'プラン': 'Light', Status: 'active', '有効期限': '2026-04-19',
    LightGrantUntil: until, LightGrantedAt: iso(NOW - DAY),
  });
  assert.equal(d.login.memberType, 'paid');
  assert.equal(d.login.loginMethod, 'link');
  assert.equal(d.login.entitlementSource, 'promotional_grant', '無料特典と課金契約を区別していない');
  assert.equal(d.grantsAndOffers.promoLight.active, true);
  assert.equal(d.grantsAndOffers.promoLight.until, until);
  assert.equal(d.access.canViewLight, true);
  assert.equal(d.access.canViewPremium, false);
  // 契約自体は期限切れのまま（特典で契約を書き換えない）
  assert.equal(d.contract.contractState, 'expired');
});

test('オファーは有効なものを数え、期限切れ・取消は live=false で残す', () => {
  const offers = [
    { fields: { CustomerRecordId: 'recX', OfferId: 'premium-annual-half', Status: 'issued', OfferPrice: 24900, RegularPrice: 49800, ExpiresAt: iso(NOW + 5 * DAY) } },
    { fields: { CustomerRecordId: 'recX', OfferId: 'premium-annual-half', Status: 'issued', OfferPrice: 24900, RegularPrice: 49800, ExpiresAt: iso(NOW - DAY) } },
    { fields: { CustomerRecordId: 'recX', OfferId: 'premium-30d-half', Status: 'revoked', OfferPrice: 9000, RegularPrice: 18000, ExpiresAt: iso(NOW + DAY) } },
    { fields: { CustomerRecordId: 'recOTHER', OfferId: 'premium-annual-half', Status: 'issued', OfferPrice: 24900, RegularPrice: 49800, ExpiresAt: iso(NOW + DAY) } },
  ];
  const d = build({ Email: 'x@example.com', 'プラン': 'Free' }, { offerRecords: offers });
  assert.equal(d.grantsAndOffers.offers.length, 3, '他人のオファーを混ぜている/自分のを落としている');
  assert.equal(d.grantsAndOffers.liveOfferCount, 1);
});

test('到達性: provider を確認できない場合は false ではなく null（不明）で返す', () => {
  const base = { Email: 'x@example.com', 'プラン': 'Free' };
  const unknown = build(base);
  assert.equal(unknown.reachability.providerSuppressed, null, '未確認を「送れる」に倒している');

  const known = build(base, { providerSuppressed: new Set(['x@example.com']) });
  assert.equal(known.reachability.providerSuppressed, true);
});

test('送信履歴は自分宛のみ・新しい順で最大 5 件', () => {
  const deliveries = Array.from({ length: 7 }, (_, i) => ({
    fields: {
      RecipientEmail: 'x@example.com', CampaignType: `c:v${i}`, Status: 'sent',
      SentAt: iso(NOW - i * DAY), ScheduledEmailJobId: `job${i}`,
    },
  }));
  deliveries.push({ fields: { RecipientEmail: 'other@example.com', CampaignType: 'c:v9', Status: 'sent', SentAt: iso(NOW) } });
  const d = build({ Email: 'x@example.com', 'プラン': 'Free' }, { deliveryRecords: deliveries });
  assert.equal(d.delivery.recent.length, 5);
  assert.equal(d.delivery.recent[0].campaign, 'c:v0');
  assert.ok(d.delivery.recent.every((r) => r.jobId !== undefined));
});

test('カルテはトークン等の機微値を持ち出さない', () => {
  const offers = [{
    fields: {
      CustomerRecordId: 'recX', OfferId: 'premium-annual-half', Status: 'issued',
      OfferPrice: 24900, RegularPrice: 49800, ExpiresAt: iso(NOW + DAY),
      OfferKey: 'ok_secret_value', TokenHash: 'hash_secret_value',
    },
  }];
  const d = build({ Email: 'x@example.com', 'プラン': 'Free' }, { offerRecords: offers });
  const dump = JSON.stringify(d);
  assert.equal(/ok_secret_value|hash_secret_value|OfferKey|TokenHash/.test(dump), false,
    'カルテにオファーの鍵素材が含まれている');
});
