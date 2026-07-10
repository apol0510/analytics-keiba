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

// Light 会員に無料/Light を出さない CSS ルールが消えていないこと（デザイン修正での事故防止）
test('guard: pricing.astro に Light 会員向けの下位カード・FAQ 非表示ルールがある', () => {
  const src = readFileSync(PRICING_ASTRO, 'utf8');
  for (const target of ['plan-card', 'faq-item']) {
    for (const tier of ['0', '1']) {
      assert.ok(
        src.includes(`:global(:root[data-plan-tier="1"]) .${target}[data-plan-tier="${tier}"]`),
        `非表示ルールが無い: .${target}[data-plan-tier="${tier}"]`,
      );
    }
  }
  assert.ok(/class="plan-card" data-plan-tier="1"/.test(src), 'Light カードに tier 属性が無い');
  assert.ok(/class="plan-card" data-plan-tier="0"/.test(src), '無料カードに tier 属性が無い');
  assert.ok(/class="faq-item" data-plan-tier="0"/.test(src), '無料プラン FAQ に tier 属性が無い');
});
