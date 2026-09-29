/**
 * Premium Plus は三連複の権利を持つ会員にだけ表示・販売する（2026-09-29 MK 決定 A / CLAUDE.md 正本）
 *
 * 2026-09-29 本番実測: 三連複を持たない Premium 買い切り会員が「購入可能」になっていた
 * （ROUTE B / C が三連複なしでも開いていた）。さらに申込 Function に購入可否のゲートが無く、
 * 画面を経ずに直接 POST すれば誰でも Plus の申込を作れた。
 *
 * ここで固定する:
 *   - 顧客側の単一源（resolveUpsellForCustomer）: 三連複なしは表示・商品ページ・CTA・申込すべて不可
 *   - 三連複保有者は従来どおり（今回送信済みの 5 名の形は購入可能のまま）
 *   - 管理一覧・案内メールの対象判定も同じ結論
 *   - 申込 Function（bank-transfer-application）が同じ単一源で副作用の前に拒否する
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveUpsellForCustomer } from '../upsell/upsellTarget.js';
import { resolvePlusMemberFromFields } from './premiumPlusMember.js';
import { resolvePremiumPlusRelease } from './premiumPlusRelease.js';
import { resolveAdminCandidate } from './premiumPlusAdminAudience.js';

const NOW = Date.parse('2026-10-01T01:00:00.000Z'); // JST 10:00
const iso = (d) => new Date(NOW - d * 86400000).toISOString();

/** 本番で見つかった形: Premium 買い切り・三連複なし・管理者が eligible＋今すぐ販売可 */
const premiumLifetimeNoSanrenpuku = {
  'プラン': 'Premium', PlanType: 'Lifetime', Status: 'active', '有効期限': '2099-12-31',
  PaidAt: iso(60), PremiumPlusEligibility: 'eligible', PremiumPlusEligibleAt: iso(30),
  PremiumPlusReleaseOverride: 'phase4',
};
/** 今回案内を送った 5 名の形: 三連複保有・eligible・今すぐ販売可 */
const sanrenpukuHolder = {
  'プラン': 'Premium Sanrenpuku', PlanType: 'Lifetime', Status: 'active', '有効期限': '2099-12-31',
  PaidAt: iso(60), PremiumPlusEligibility: 'eligible', PremiumPlusEligibleAt: iso(30),
  PremiumPlusReleaseOverride: 'phase4',
};
/** 馬単は年払い・三連複は買い切りフラグ（LifetimeSanrenpuku） */
const lifetimeFlagHolder = {
  'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2027-06-30',
  LifetimeSanrenpuku: true, PaidAt: iso(60), PremiumPlusEligibility: 'eligible',
  PremiumPlusEligibleAt: iso(30), PremiumPlusReleaseOverride: 'phase4',
};

test('【重要】三連複なしの Premium は eligible・今すぐ販売可・UpsellTarget=plus でも表示も購入もできない', () => {
  for (const extra of [{}, { UpsellTarget: 'plus' }]) {
    const v = resolveUpsellForCustomer({ fields: { ...premiumLifetimeNoSanrenpuku, ...extra }, nowMs: NOW });
    assert.equal(v.plus.purchaseEnabled, false);
    assert.equal(v.plus.showProductPage, false);
    assert.equal(v.plus.showPurchaseCta, false);
    assert.equal(v.plus.showTeaser, false);
    assert.equal(v.plusRelease.route, 'none');
  }
});

test('【重要】三連複保有者（プラン / 買い切りフラグのどちらでも）は従来どおり購入できる', () => {
  for (const f of [sanrenpukuHolder, lifetimeFlagHolder]) {
    const v = resolveUpsellForCustomer({ fields: f, nowMs: NOW });
    assert.equal(v.plusRelease.route, 'sanrenpuku');
    assert.equal(v.plus.purchaseEnabled, true, f['プラン']);
  }
});

test('管理一覧でも三連複なしは「売れない理由」付き・保有者は ROUTE A', () => {
  const cand = (f) => {
    const member = resolvePlusMemberFromFields(f, { nowMs: NOW });
    const release = resolvePremiumPlusRelease({ ...member, nowMs: NOW });
    return resolveAdminCandidate({ fields: f, member, release });
  };
  assert.equal(cand(premiumLifetimeNoSanrenpuku).releaseBlockedBy, 'no_sanrenpuku');
  assert.equal(cand(sanrenpukuHolder).kind, 'route_a');
});

const fn = readFileSync(new URL('../../../netlify/functions/bank-transfer-application.js', import.meta.url), 'utf8');

test('【重要】申込 Function: Plus は購入可否を単一源で確かめ、副作用の前に 403 で止める', () => {
  const gate = fn.indexOf("code: 'plus_not_purchasable'");
  assert.ok(gate > 0, '購入可否ゲートが無い');
  const block = fn.slice(fn.lastIndexOf('if (isPremiumPlusOrder) {', gate), gate);
  assert.match(block, /resolveUpsellForCustomer\(/);
  assert.match(block, /up\.plus\.purchaseEnabled === true/);
  // 会員を読めないときは通さない（fail closed）
  assert.match(block, /let plusPurchasable = false/);
  // ゲートはメール送信・Airtable 書き込み・注文台帳・クーポン予約・計測より前
  for (const later of [
    "fetch('https://api.sendgrid.com/v3/mail/send'",
    'await recordOrderOnApplication(',
    'await createReservation(',
    'await recordPlusCheckoutStart(',
    'await recordPaymentApplication(',
  ]) {
    const at = fn.indexOf(later);
    assert.ok(at > gate, `${later} がゲートより前にある`);
  }
});

test('申込 Function のゲートは画面と同じ引数で判定する（条件を書き足さない）', () => {
  const page = readFileSync(new URL('../../pages/premium-plus-v2.astro', import.meta.url), 'utf8');
  assert.match(page, /resolveUpsellForCustomer\(\{\s*fields: ppFields,\s*nowMs: ppNow,\s*fallbackAnchor: process\.env\.PREMIUM_PLUS_FUNNEL_ANCHOR,\s*\}\)/);
  assert.match(fn, /resolveUpsellForCustomer\(\{\s*fields: plusCustomerFields,\s*nowMs: Date\.now\(\),\s*fallbackAnchor: process\.env\.PREMIUM_PLUS_FUNNEL_ANCHOR,\s*\}\)/);
});
