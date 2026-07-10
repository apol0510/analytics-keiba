import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildPlanTierByToken, PLAN_TIER_BY_CANONICAL } from './planTiers.js';
import { CANONICAL_PLANS, normalizePlanToken } from '../auth/planNormalization.js';

const PRICING_ASTRO = fileURLToPath(
  new URL('../../pages/pricing.astro', import.meta.url),
);

test('CANONICAL_PLANS すべてに tier が定義されている', () => {
  for (const plan of CANONICAL_PLANS) {
    assert.equal(typeof PLAN_TIER_BY_CANONICAL[plan], 'number', `tier 未定義: ${plan}`);
  }
});

test('tier の上下関係: free < light < premium 系', () => {
  const map = buildPlanTierByToken();
  assert.ok(map['free'] < map['light']);
  assert.ok(map['light'] < map['premium']);
  assert.ok(map['premium'] <= map['premium-plus']);
});

test('別名も同じ tier に解決される（light の旧表記を取りこぼさない）', () => {
  const map = buildPlanTierByToken();
  for (const alias of ['light', 'standard', 'ライト']) {
    assert.equal(map[normalizePlanToken(alias)], 1, `light tier にならない: ${alias}`);
  }
  for (const alias of ['free', 'expired', '無料', 'free-registered']) {
    assert.equal(map[normalizePlanToken(alias)], 0, `free tier にならない: ${alias}`);
  }
  assert.equal(map[normalizePlanToken('プレミアム')], 2);
  assert.equal(map[normalizePlanToken('pro-plus')], 3);
});

test('未知プランは表に載らない（pricing 側で fail-open になる）', () => {
  const map = buildPlanTierByToken();
  assert.equal(map[normalizePlanToken('vip')], undefined);
  assert.equal(map[normalizePlanToken('')], undefined);
});

// pricing.astro のインライン script は import できないため正規化を再掲している。
// planNormalization.js の recipe と食い違うと Light 会員の出し分けが静かに壊れるので固定する。
test('guard: pricing.astro のインライン正規化が normalizePlanToken と同一 recipe', () => {
  const src = readFileSync(PRICING_ASTRO, 'utf8');
  const recipe = `.normalize('NFKC').trim().toLowerCase().replace(/[\\s_]+/g, '-')`;
  assert.ok(
    src.includes(recipe),
    'pricing.astro のトークン正規化が planNormalization.js と一致しません',
  );
  assert.equal(normalizePlanToken(' Light '), 'light');
  assert.equal(normalizePlanToken('Premium_Plus'), 'premium-plus');
});

// Light 会員に無料/Light カードを出さない CSS ルールが消えていないこと（デザイン修正での事故防止）
test('guard: pricing.astro に Light 会員向けの下位カード非表示ルールがある', () => {
  const src = readFileSync(PRICING_ASTRO, 'utf8');
  for (const tier of ['0', '1']) {
    assert.ok(
      src.includes(`:global(:root[data-plan-tier="1"]) .plan-card[data-plan-tier="${tier}"]`),
      `非表示ルールが無い: .plan-card[data-plan-tier="${tier}"]`,
    );
  }
  assert.ok(/class="plan-card" data-plan-tier="1"/.test(src), 'Light カードに tier 属性が無い');
  assert.ok(/class="plan-card" data-plan-tier="0"/.test(src), '無料カードに tier 属性が無い');
});

// FAQ のプラン別出し分け。only-for はデフォルト非表示 → Light 会員でだけ表示、が両方必要
test('guard: pricing.astro に FAQ のプラン別出し分けルールがある', () => {
  const src = readFileSync(PRICING_ASTRO, 'utf8');
  assert.ok(
    /\.faq-item\[data-faq-only-for\]\s*\{\s*display:\s*none/.test(src),
    'data-faq-only-for のデフォルト非表示ルールが無い（全員に露出する）',
  );
  assert.ok(src.includes(':global(:root[data-plan-tier="1"]) .faq-item[data-faq-hide-for="light"]'));
  assert.ok(src.includes(':global(:root[data-plan-tier="1"]) .faq-item[data-faq-only-for="light"]'));
  assert.ok(src.includes('data-faq-hide-for="light"'), 'hide-for を使う FAQ が無い');
  assert.ok(src.includes('data-faq-only-for="light"'), 'only-for を使う FAQ が無い');
});

// Light → プレミアム年払いの価格比較を FAQ に書いている。カードの価格を直したら破綻するため固定する
test('guard: FAQ の Light 年間換算と差額がカード表示価格と整合する', () => {
  const src = readFileSync(PRICING_ASTRO, 'utf8');
  const lightMonthly = 4980;
  const premiumAnnual = 49800;
  const lightYearly = lightMonthly * 12; // 59760
  assert.equal(lightYearly, 59760);
  assert.equal(lightYearly - premiumAnnual, 9960);
  assert.equal(premiumAnnual / 12, 4150); // カードの「月額換算 ¥4,150」

  assert.ok(src.includes("openBankModal('Light', 4980, 'monthly')"), 'Light の価格が変わった');
  assert.ok(src.includes("openBankModal('Premium Annual', 49800, 'annual')"), 'プレミアム年払いの価格が変わった');
  assert.ok(src.includes('¥59,760'), 'FAQ の Light 年間換算が無い');
  assert.ok(src.includes('¥9,960'), 'FAQ の差額表記が無い');
});
