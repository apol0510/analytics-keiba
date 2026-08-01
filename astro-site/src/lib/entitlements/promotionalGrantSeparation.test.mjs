/**
 * promotionalGrantSeparation.test.mjs — 無料特典（promotional grant）と
 * 課金契約（paid contract）が**分離されたまま**であることを横断的に固定する。
 *   node --test src/lib/entitlements/promotionalGrantSeparation.test.mjs
 *
 * ── なぜこのファイルが要るか ─────────────────────────────────────
 * 特典は「閲覧できる」を増やすだけで、支払い実績を作らない。
 * ところが判定は複数の面（ログイン / 権限 / Premium Plus 販売資格 / 三連複購入資格 /
 * マーケティングの契約区分）に分かれており、どこか 1 つが
 * 「閲覧できる＝支払済み」と解釈した瞬間に、無料の人へ
 * 販売動線・課金前提の案内・購入資格が開いてしまう。
 *
 * ここでは **1 つの表**として差を固定する。ここが赤くなったら、
 * 無料特典が課金判定に漏れている（またはその逆）。
 *
 * ⚠️ `memberType: 'paid'` は「有料階層のセッションを発行してよい」という認可ラベルで、
 *    支払い実績ではない（`memberResolution.js` の冒頭コメント参照）。
 *    課金実績が要る判定は `entitlementSource` / `paidPremiumActive` を見ること。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveEntitlements, fromAirtableFields, resolveClientView } from './resolveEntitlements.js';
import { PROMO_FIELDS } from './promotionalGrants.js';
import { resolveMembership, MEMBER_TYPE, MEMBER_SOURCE, MEMBER_REASON } from '../auth/memberResolution.js';
import { resolvePlusMemberFromFields } from '../premiumPlus/premiumPlusMember.js';
import { resolveCustomerMarketing } from '../marketing/customerMarketingAudience.js';
import { issuePaidSessionCookie } from '../auth/sessionIssuance.js';

const NOW = Date.parse('2026-08-01T03:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const L = PROMO_FIELDS.light;
const P = PROMO_FIELDS.premium;
const iso = (ms) => new Date(ms).toISOString();

// ── 素材 ────────────────────────────────────────────────────────
/** 有料 Premium が切れた顧客（カムバック施策の主対象） */
const EXPIRED_PREMIUM = Object.freeze({
  Email: 'expired@example.com', 'プラン': 'Premium', PlanType: 'Annual',
  Status: 'active', '有効期限': '2026-01-01',
});
/** 有料 Premium が有効な顧客 */
const PAID_PREMIUM = Object.freeze({
  Email: 'paid@example.com', 'プラン': 'Premium', PlanType: 'Annual',
  Status: 'active', '有効期限': '2099-01-01',
});
/** 三連複買い切り保有（Premium 契約は切れている） */
const LIFETIME_SRP = Object.freeze({ ...EXPIRED_PREMIUM, LifetimeSanrenpuku: true });

/** Light 永久無料の特典 */
const GRANT_LIGHT = Object.freeze({ [L.LIFETIME]: true, [PROMO_FIELDS.SOURCE]: 'comeback-2026-08' });
/** Premium 30日無料の特典 */
const GRANT_PREMIUM = Object.freeze({ [P.UNTIL]: iso(NOW + 30 * DAY) });

const ent = (f) => resolveEntitlements(fromAirtableFields(f), NOW);
const member = (f) => resolveMembership({ fields: f, recordId: 'rec1', now: NOW });

// ══ 1. 権限の表（ここが仕様）══════════════════════════════════════

test('権限マトリクス: 無料特典は閲覧を増やすが、課金実績を作らない', () => {
  const rows = [
    // [ラベル, fields, 期待]
    ['特典なし（期限切れ）', EXPIRED_PREMIUM, {
      tier: 'free', light: false, premium: false, srp: false,
      buySrp: false, paidPremium: false, promoPremium: false, promoLight: false,
    }],
    ['promo Light のみ', { ...EXPIRED_PREMIUM, ...GRANT_LIGHT }, {
      tier: 'light', light: true, premium: false, srp: false,
      buySrp: false, paidPremium: false, promoPremium: false, promoLight: true,
    }],
    ['promo Premium のみ', { ...EXPIRED_PREMIUM, ...GRANT_PREMIUM }, {
      tier: 'premium', light: true, premium: true, srp: false,
      // 🔒 無料 Premium で三連複購入資格を配らない
      buySrp: false, paidPremium: false, promoPremium: true, promoLight: false,
    }],
    ['promo Light + promo Premium', { ...EXPIRED_PREMIUM, ...GRANT_LIGHT, ...GRANT_PREMIUM }, {
      tier: 'premium', light: true, premium: true, srp: false,
      buySrp: false, paidPremium: false, promoPremium: true, promoLight: true,
    }],
    ['paid Premium（特典なし）', PAID_PREMIUM, {
      tier: 'premium', light: true, premium: true, srp: false,
      buySrp: true, paidPremium: true, promoPremium: false, promoLight: false,
    }],
    ['paid Premium + 特典', { ...PAID_PREMIUM, ...GRANT_LIGHT, ...GRANT_PREMIUM }, {
      tier: 'premium', light: true, premium: true, srp: false,
      // 有料側の資格は特典で変わらない
      buySrp: true, paidPremium: true, promoPremium: true, promoLight: true,
    }],
    ['LifetimeSanrenpuku（特典なし）', LIFETIME_SRP, {
      tier: 'premium-sanrenpuku', light: false, premium: false, srp: true,
      buySrp: false, paidPremium: false, promoPremium: false, promoLight: false,
    }],
    ['LifetimeSanrenpuku + promo Premium', { ...LIFETIME_SRP, ...GRANT_PREMIUM }, {
      // 三連複は買い切り権で決まり、特典の影響を受けない
      tier: 'premium-sanrenpuku', light: true, premium: true, srp: true,
      buySrp: false, paidPremium: false, promoPremium: true, promoLight: false,
    }],
    ['退会 + 特典', { ...EXPIRED_PREMIUM, ...GRANT_LIGHT, ...GRANT_PREMIUM, WithdrawalRequested: true }, {
      tier: 'free', light: false, premium: false, srp: false,
      buySrp: false, paidPremium: false, promoPremium: false, promoLight: false,
    }],
    ['停止 + 特典', { ...EXPIRED_PREMIUM, ...GRANT_LIGHT, ...GRANT_PREMIUM, Status: 'suspended' }, {
      tier: 'free', light: false, premium: false, srp: false,
      buySrp: false, paidPremium: false, promoPremium: false, promoLight: false,
    }],
  ];

  for (const [label, fields, want] of rows) {
    const e = ent(fields);
    assert.equal(e.effectiveTier, want.tier, `${label}: effectiveTier`);
    assert.equal(e.canViewLight, want.light, `${label}: canViewLight`);
    assert.equal(e.canViewPremium, want.premium, `${label}: canViewPremium`);
    assert.equal(e.canViewSanrenpuku, want.srp, `${label}: canViewSanrenpuku`);
    assert.equal(e.canPurchaseSanrenpuku, want.buySrp, `${label}: canPurchaseSanrenpuku`);
    assert.equal(e.paidPremiumActive, want.paidPremium, `${label}: paidPremiumActive`);
    assert.equal(e.promo.premiumActive, want.promoPremium, `${label}: promo.premiumActive`);
    assert.equal(e.promo.lightActive, want.promoLight, `${label}: promo.lightActive`);
  }
});

test('特典フィールドが 1 つも無いレコードは従来と完全に同じ判定', () => {
  for (const f of [EXPIRED_PREMIUM, PAID_PREMIUM, LIFETIME_SRP]) {
    const before = resolveEntitlements(fromAirtableFields(f), NOW);
    const withEmptyPromo = resolveEntitlements(
      fromAirtableFields({ ...f, [L.LIFETIME]: false, [L.UNTIL]: null, [P.UNTIL]: null }), NOW,
    );
    for (const k of ['canLogin', 'canViewFree', 'canViewLight', 'canViewPremium',
      'canViewSanrenpuku', 'canPurchaseSanrenpuku', 'paidPremiumActive', 'effectiveTier']) {
      assert.equal(withEmptyPromo[k], before[k], `空の特典フィールドで ${k} が変わった`);
    }
  }
});

// ══ 2. Premium Plus の販売資格（課金実績が前提）════════════════════

test('Premium Plus: 無料 Premium 特典では premiumActive が立たない（ROUTE B が開かない）', () => {
  const promo = resolvePlusMemberFromFields({ ...EXPIRED_PREMIUM, ...GRANT_PREMIUM }, { nowMs: NOW });
  assert.equal(promo.premiumActive, false, '無料特典で Plus の ROUTE B 前提が立っている');
  assert.equal(promo.hasSanrenpuku, false);

  const paid = resolvePlusMemberFromFields(PAID_PREMIUM, { nowMs: NOW });
  assert.equal(paid.premiumActive, true, '有料 Premium で ROUTE B 前提が立たない');

  // 三連複保有（ROUTE A）は特典の有無で変わらない
  assert.equal(resolvePlusMemberFromFields(LIFETIME_SRP, { nowMs: NOW }).hasSanrenpuku, true);
  assert.equal(
    resolvePlusMemberFromFields({ ...LIFETIME_SRP, ...GRANT_PREMIUM }, { nowMs: NOW }).hasSanrenpuku,
    true,
  );
});

// ══ 3. ログイン（memberType は認可ラベル / 根拠は entitlementSource）══

test('memberType と entitlementSource: paid の根拠を区別できる', () => {
  const paid = member(PAID_PREMIUM);
  assert.equal(paid.memberType, MEMBER_TYPE.PAID);
  assert.equal(paid.entitlementSource, MEMBER_SOURCE.PAID_CONTRACT);
  assert.equal(paid.reason, 'active_paid');

  const promoLight = member({ ...EXPIRED_PREMIUM, ...GRANT_LIGHT });
  assert.equal(promoLight.memberType, MEMBER_TYPE.PAID, '特典で有料階層のセッションが出ない');
  assert.equal(promoLight.normalizedPlan, 'light');
  assert.equal(promoLight.entitlementSource, MEMBER_SOURCE.PROMOTIONAL_GRANT, '特典を課金契約と区別できない');
  assert.equal(promoLight.reason, MEMBER_REASON.PROMO_LIGHT_GRANT);

  const promoPremium = member({ ...EXPIRED_PREMIUM, ...GRANT_LIGHT, ...GRANT_PREMIUM });
  assert.equal(promoPremium.normalizedPlan, 'premium', '強い方（Premium）を採用していない');
  assert.equal(promoPremium.entitlementSource, MEMBER_SOURCE.PROMOTIONAL_GRANT);

  // 有料契約が有効なら特典があっても paid_contract 側が勝つ
  const both = member({ ...PAID_PREMIUM, ...GRANT_LIGHT, ...GRANT_PREMIUM });
  assert.equal(both.entitlementSource, MEMBER_SOURCE.PAID_CONTRACT);
  assert.equal(both.normalizedPlan, 'premium');

  // 三連複買い切りは契約側の権利（特典より先に決まる）
  const srp = member({ ...LIFETIME_SRP, ...GRANT_LIGHT });
  assert.equal(srp.normalizedPlan, 'premium-sanrenpuku');
  assert.equal(srp.lifetimeSanrenpuku, true);
  assert.equal(srp.entitlementSource, MEMBER_SOURCE.PAID_CONTRACT);

  // 停止・強制ログアウトは特典より先（ログイン自体が不可）
  for (const f of [
    { ...EXPIRED_PREMIUM, ...GRANT_LIGHT, Status: 'suspended' },
    { ...EXPIRED_PREMIUM, ...GRANT_LIGHT, ForceLogout: true },
  ]) {
    const r = member(f);
    assert.equal(r.memberType, MEMBER_TYPE.DENIED, '停止/強制ログアウトが特典で突破された');
    assert.equal(r.entitlementSource, MEMBER_SOURCE.NONE);
  }

  // 退会申請は「無料会員としてログイン可・有料階層へは戻さない」（2026-08-01）
  const withdrawn = member({ ...EXPIRED_PREMIUM, ...GRANT_LIGHT, WithdrawalRequested: true });
  assert.equal(withdrawn.memberType, MEMBER_TYPE.FREE, '退会者がログインできない');
  assert.equal(withdrawn.normalizedPlan, 'free', '退会者に元のプラン名が漏れている');
  assert.equal(withdrawn.entitlementSource, MEMBER_SOURCE.NONE, '退会者が特典で有料階層へ戻った');

  // free / denied は none
  assert.equal(member({ Email: 'f@example.com', 'プラン': 'Free', Status: 'active' }).entitlementSource,
    MEMBER_SOURCE.NONE);
});

test('entitlementSource はセッション Cookie の payload に混ざらない（既存契約を壊さない）', () => {
  const r = member({ ...EXPIRED_PREMIUM, ...GRANT_LIGHT });
  // 発行側が payload に載せるのはこの 4 つだけ（sessionIssuance.js）
  assert.deepEqual(
    Object.keys(r).sort(),
    ['entitlementSource', 'lifetimeSanrenpuku', 'memberType', 'normalizedPlan',
      'reason', 'recordId', 'sessionVersion', 'venueAccess'].sort(),
    'membership の形が変わった（consumer を確認すること）',
  );
  // 既存 consumer が使う 4 つの値は特典でも従来どおりの型
  assert.equal(typeof r.normalizedPlan, 'string');
  assert.ok(Array.isArray(r.venueAccess));
  assert.equal(typeof r.sessionVersion, 'number');
  assert.equal(typeof r.recordId, 'string');
});

test('実際に発行される Cookie payload の形が特典で変わらない', async () => {
  const secret = 'x'.repeat(48);
  const promo = await issuePaidSessionCookie({
    membership: member({ ...EXPIRED_PREMIUM, ...GRANT_LIGHT }), secret, now: NOW,
  });
  const paid = await issuePaidSessionCookie({ membership: member(PAID_PREMIUM), secret, now: NOW });
  assert.equal(promo.ok, true, '特典会員にセッションが発行されない');
  assert.equal(paid.ok, true);

  const keys = Object.keys(promo.payload).sort();
  assert.deepEqual(keys, Object.keys(paid.payload).sort(), 'payload の形が有料と特典で違う');
  assert.deepEqual(keys,
    ['expiresAt', 'issuedAt', 'plan', 'sessionStart', 'sessionVersion', 'sub', 'v', 'venueAccess'],
    'Cookie payload の形が変わった（既存セッション契約の破壊）');
  // memberType / entitlementSource / reason は Cookie に入らない
  for (const k of ['memberType', 'entitlementSource', 'reason', 'lifetimeSanrenpuku']) {
    assert.equal(k in promo.payload, false, `${k} が Cookie payload に漏れている`);
  }
  assert.equal(promo.payload.plan, 'light');
  assert.equal(paid.payload.plan, 'premium');
});

// ══ 4. マーケティング（契約区分は課金フィールド由来）═══════════════

test('マーケ: contract は課金契約のまま。premiumActive は有料のみ、特典は promo* で別軸', () => {
  const base = resolveCustomerMarketing({ fields: EXPIRED_PREMIUM, nowMs: NOW });
  assert.equal(base.contract, 'expired');
  assert.equal(base.premiumActive, false);
  assert.equal(base.promoPremiumActive, false);

  const granted = resolveCustomerMarketing({
    fields: { ...EXPIRED_PREMIUM, ...GRANT_LIGHT, ...GRANT_PREMIUM }, nowMs: NOW,
  });
  // 🔒 特典を付けても契約は expired のまま（= 期限切れ向けキャンペーンから消えない）
  assert.equal(granted.contract, 'expired', '無料特典で契約状態が active に見えている');
  assert.equal(granted.plan, 'premium', 'plan は購入実績（プラン列）由来のまま');
  // 🔒 「支払済み」に見えない
  assert.equal(granted.premiumActive, false, '無料特典で premiumActive が立っている');
  assert.equal(granted.lightActive, false);
  // 特典は別軸として可視化される
  assert.equal(granted.promoPremiumActive, true);
  assert.equal(granted.promoLightActive, true);

  // 有料が有効なら従来どおり
  const paid = resolveCustomerMarketing({ fields: PAID_PREMIUM, nowMs: NOW });
  assert.equal(paid.contract, 'active');
  assert.equal(paid.premiumActive, true);
  assert.equal(paid.promoPremiumActive, false);

  // 三連複は特典の影響を受けない
  assert.equal(resolveCustomerMarketing({
    fields: { ...LIFETIME_SRP, ...GRANT_PREMIUM }, nowMs: NOW,
  }).hasSanrenpuku, true);
});

// ══ 5. ダッシュボード表示（矛盾したカードを同時に出さない）═════════

test('ダッシュボード: Premium 有効カードと Premium 期限切れカードが同時に出ない', () => {
  const promo = resolveEntitlements(fromAirtableFields({ ...EXPIRED_PREMIUM, ...GRANT_PREMIUM }), NOW);
  const activeCard = promo.canViewPremium;
  const expiredCard = promo.canLogin && promo.premiumExpired && !promo.canViewPremium;
  assert.equal(activeCard, true);
  assert.equal(expiredCard, false, '「Premium 有効」と「Premium 期限切れ」を同時に表示している');

  // 特典が無ければ従来どおり期限切れカードが出る
  const plain = resolveEntitlements(fromAirtableFields(EXPIRED_PREMIUM), NOW);
  assert.equal(plain.canViewPremium, false);
  assert.equal(plain.canLogin && plain.premiumExpired && !plain.canViewPremium, true);

  // クライアント側（localStorage 由来・特典情報を持たない）でも従来と同じ挙動
  const view = resolveClientView({ plan: 'premium' }, { isExpired: true }, NOW);
  assert.equal(view.showPremiumActiveCard, false);
  assert.equal(view.showPremiumExpiredCard, true);
});
