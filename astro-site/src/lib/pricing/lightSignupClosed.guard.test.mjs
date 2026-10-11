/**
 * Light 新規募集停止に伴う CTA 横断監査（2026-10-02 MK 確定・PR #677）の固定。
 *
 * - 新規・無料ユーザーに Light の購入 CTA を出さない（有料 CTA は中央版・南関版・Premium）
 * - Light の新規購入はサーバー側でも成立しない（申込 Function の判定は discontinuedBankProducts.test.mjs）
 * - 既存の有料 Light 会員の更新・再開は残す / 永久無料・無償付与 Light の権利は変えない
 * - Premium 会員に同じプランの購入 CTA を出さず、次段（三連複）へ
 * - 旧 Light キャンペーン URL は新料金導線へ
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import { resolveCampaignOfferIdsFor, CAMPAIGN_OFFER_IDS } from '../promotions/campaignOffers.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (rel) => readFileSync(`${ROOT}${rel}`, 'utf8');
const pricing = read('src/pages/pricing.astro');

test('サイト全体で Light の購入ボタン（openBankModal Light）は /pricing/ の更新用カード 1 か所だけ', () => {
  const out = execFileSync('git', ['grep', '-n', '-E', "openBankModal\\(\\s*'(Light|Standard|ライト)", '--', 'src/pages', 'src/components', 'src/layouts', 'public'], { cwd: ROOT, encoding: 'utf8' })
    .trim().split('\n').filter(Boolean);
  assert.deepEqual(out.map((l) => l.split(':')[0]), ['src/pages/pricing.astro'], out.join('\n'));
});

test('/pricing/ の Light 更新は有料 Light 会員（tier 1）だけの補助導線（プラン一覧には出さない）', () => {
  const i = pricing.indexOf("openBankModal('Light', 4980, 'monthly')");
  const rowStart = pricing.lastIndexOf('<div class="other-plan"', i);
  assert.match(pricing.slice(rowStart, rowStart + 60), /data-only-for="light"/, 'Light 更新が全員に見える');
  assert.ok(rowStart > pricing.indexOf('<details class="other-payments"'), 'Light 更新が控えめな銀行振込欄の外にある');
  assert.match(pricing, /\[data-only-for\]\s*\{\s*display:\s*none !important;/);
  assert.match(pricing, /:root\[data-plan-tier="1"\]\) \.other-plan\[data-only-for="light"\]/);
});

test('有料 Light 会員には Premium 年払い（乗り換え特典 ¥44,820）への変更を主に案内する（Light 継続を勧めない・月払いは出さない）', () => {
  const note = pricing.slice(pricing.indexOf('<p class="pricing-upgrade-note">'), pricing.indexOf('</p>', pricing.indexOf('<p class="pricing-upgrade-note">')));
  assert.match(note, /¥44,820\/年/);
  assert.match(note, /中央＋南関の全レース/);
  assert.equal(/¥4,980\/月/.test(note), false, '月払いを案内している');
  assert.equal(/Light の更新・再開/.test(note), false, '主メッセージで Light 更新を案内している');
  assert.match(pricing, /data-only-for="light">\s*<span>⬆️ Light会員さま乗り換え特典<\/span>/);
  assert.equal(/Lightを続ける|Light を続ける/.test(pricing), false);
});

test('新規・無料向けの有料 CTA は銀行振込の年払い・買い切りだけ（新規の月払いは全面停止・2026-10-11 MK 確定）', () => {
  assert.equal(/data-checkout=/.test(pricing), false, 'Stripe 月額の申込ボタンが残っている');
  assert.equal(/stripe-create-checkout'/.test(pricing.replace(/\/\/.*$/gm, '')), false, 'ブラウザから Checkout を呼んでいる');
  assert.equal(/¥2,980|¥4,980<\/span>\s*<span class="price-period">\/月/.test(pricing), false, '月額の価格カードが残っている');
  assert.match(pricing, /openBankModal\('Premium Annual', 49800, 'annual'\)/);
  assert.match(pricing, /openBankModal\('Premium Lifetime', 78000, 'lifetime'\)/);
});

test('Premium（両会場）をご契約中の方には同じプランの購入 CTA を出さず、三連複へ（期限切れは除く）', () => {
  assert.match(pricing, /data-premium-active/);
  assert.match(pricing, /up\.pricingTier >= 2\s+&& !\(Number\.isFinite\(vuMs\) && vuMs < Date\.now\(\)\)/);
  assert.match(pricing, /:root\[data-premium-active="1"\]\) \.plan-card\[data-stripe-plan\]/);
  assert.match(pricing, /:root\[data-premium-active="1"\]\) \.plan-card\[data-plan-tier="0"\]/, '無料登録カードも出さない');
  const note = pricing.slice(pricing.indexOf('<div class="premium-member-note">'), pricing.indexOf('<div class="premium-member-note">') + 600);
  assert.match(note, /href="\/sanrenpuku-demo\/"/);
});

test('旧 Light キャンペーン URL は削除し、新料金導線（/pricing/）へ 301', () => {
  assert.equal(existsSync(`${ROOT}src/pages/light-campaign.astro`), false);
  const toml = read('netlify.toml');
  for (const from of ['/light-campaign', '/light-campaign/']) {
    assert.match(toml, new RegExp(`from = "${from}"\\s+to = "/pricing/"\\s+status = 301`), from);
  }
});

test('キャンペーン割引でも Light を案内しない（無料・期限切れ・会場限定のいずれでも）', () => {
  for (const e of [{}, { canViewLight: false }, { canViewPremiumJra: true }]) {
    assert.equal(resolveCampaignOfferIdsFor(e).includes(CAMPAIGN_OFFER_IDS.LIGHT_MONTHLY), false, JSON.stringify(e));
  }
});

test('Light 向けページの未加入案内は「有料プラン」として出す（申し込めない Light へ誘導しない）', () => {
  assert.match(read('src/components/AccessControl.astro'), /requiredPlan === 'standard'\) \? '有料プラン（Premium 中央版・南関版・Premium）'/);
});

test('既存の権利は変えない: 永久無料 Light・期限付き無償 Light・有料 Light は閲覧できる', () => {
  const now = Date.parse('2026-10-02T03:00:00Z');
  const lifetime = resolveEntitlements(fromAirtableFields({ 'プラン': 'Free', Status: 'active', LightGrantLifetime: true }), now);
  assert.equal(lifetime.canViewLight, true, '永久無料 Light');
  const until = resolveEntitlements(fromAirtableFields({ 'プラン': 'Free', Status: 'active', LightGrantUntil: '2026-12-31' }), now);
  assert.equal(until.canViewLight, true, '期限付き無償 Light');
  const paid = resolveEntitlements(fromAirtableFields({ 'プラン': 'Light', PlanType: 'Monthly', Status: 'active', '有効期限': '2026-10-20', PaidAt: 'x' }), now);
  assert.equal(paid.canViewLight, true, '有料 Light');
  // Light の権利は Premium（会場別）を開けない＝他プランの権利に波及しない
  assert.equal(lifetime.canViewPremiumJra || lifetime.canViewPremiumNankan, false);
});
