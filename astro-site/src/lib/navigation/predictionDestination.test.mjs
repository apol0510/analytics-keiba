/**
 * predictionDestination.test.mjs — 「今日の予想」の行き先
 *   node --test src/lib/navigation/predictionDestination.test.mjs
 *
 * 恒久的な回帰条件（2026-09-02）:
 *   1. 行き先は**そのページが要求する権利そのもの**で選ぶ
 *      → `effectiveTier` を使うと、三連複だけ保有し馬単 Premium が期限切れの会員が
 *        `/premium-prediction/nankan/` へ送られ、そこで拒否されて往復する
 *   2. 権利が無い人を有料ページへ送らない（押しても戻される導線を作らない）
 *   3. 判定できないとき（unknown）は権利を主張しない中立な場所へ送る
 *   4. カード表示は**プラン文字列ではなく権利**で決まる（localStorage が消えても出る）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolvePredictionDestination,
  PREDICTION_DESTINATIONS,
  PREDICTION_NAV_HREF,
  PREDICTION_NAV_LABEL,
} from './predictionDestination.js';
import { resolveEntitlements, viewFromEntitlements } from '../entitlements/resolveEntitlements.js';

const NOW = Date.parse('2026-09-02T07:00:00.000Z');
const ent = (customer) => resolveEntitlements(customer, NOW);
const member = (customer) => ({ state: 'member', entitlements: ent(customer) });

const LIGHT = { tier: 'Light', accountStatus: 'active', expiresAt: '2027-07-14' };
const PREMIUM = { tier: 'Premium', accountStatus: 'active', expiresAt: '2027-07-14' };
const EXPIRED_PREMIUM = { tier: 'Premium', accountStatus: 'active', expiresAt: '2026-01-01' };
const SANRENPUKU_ONLY = {
  tier: 'Premium', accountStatus: 'active', expiresAt: '2026-01-01', lifetimeSanrenpuku: true,
};

// ── 1. 権利ごとの行き先 ────────────────────────────────────────
test('Light 会員 → /light-predictions/', () => {
  assert.equal(resolvePredictionDestination(member(LIGHT)), PREDICTION_DESTINATIONS.light);
  assert.equal(PREDICTION_DESTINATIONS.light, '/light-predictions/');
});

test('Premium 会員 → /premium-prediction/nankan/', () => {
  assert.equal(resolvePredictionDestination(member(PREMIUM)), PREDICTION_DESTINATIONS.premium);
});

test('三連複だけ保有・馬単 Premium 期限切れ → 有料馬単へ送らない（往復させない）', () => {
  const v = member(SANRENPUKU_ONLY);
  assert.equal(v.entitlements.canViewSanrenpuku, true, '前提: 三連複は見られる');
  assert.equal(v.entitlements.canViewPremium, false, '前提: 馬単 Premium は見られない');
  assert.notEqual(resolvePredictionDestination(v), PREDICTION_DESTINATIONS.premium);
  assert.equal(resolvePredictionDestination(v), PREDICTION_DESTINATIONS.free);
});

// ── 2. 権利なし ────────────────────────────────────────────────
test('期限切れ会員 → 無料予想（有料ページへ送って拒否させない）', () => {
  assert.equal(resolvePredictionDestination(member(EXPIRED_PREMIUM)), PREDICTION_DESTINATIONS.free);
});

test('未ログイン（URL 直打ち含む）→ 無料予想の索引（会場を勝手に決めない）', () => {
  assert.equal(resolvePredictionDestination({ state: 'anonymous', entitlements: {} }), PREDICTION_DESTINATIONS.free);
  assert.equal(PREDICTION_DESTINATIONS.free, '/free/');
});

test('引数が壊れていても実在するパスを返す（存在しない URL を組み立てない）', () => {
  for (const bad of [null, undefined, {}, 'member', 42, []]) {
    const d = resolvePredictionDestination(bad);
    assert.ok(Object.values(PREDICTION_DESTINATIONS).includes(d), `想定外の行き先: ${d}`);
  }
});

// ── 3. 判定できないとき ────────────────────────────────────────
test('unknown → マイページ（有料/無料どちらの権利も主張しない）', () => {
  assert.equal(
    resolvePredictionDestination({ state: 'unknown', entitlements: {} }),
    PREDICTION_DESTINATIONS.unknown,
  );
  assert.equal(PREDICTION_DESTINATIONS.unknown, '/dashboard/');
});

test('unknown は権利らしき値が混ざっていても有料へ送らない（fail closed）', () => {
  assert.equal(
    resolvePredictionDestination({ state: 'unknown', entitlements: { canViewPremium: true } }),
    PREDICTION_DESTINATIONS.unknown,
  );
});

// ── 4. カード表示は権利で決まる ─────────────────────────────────
test('Light 会員のカードは Light だけ（プラン文字列を見ない）', () => {
  const v = viewFromEntitlements(ent(LIGHT));
  assert.equal(v.showLightCard, true);
  assert.equal(v.showPremiumActiveCard, false);
  assert.equal(v.showFreeCard, false, '有料会員に無料カードを出さない');
});

test('Premium 会員に Light カードを重ねない', () => {
  const v = viewFromEntitlements(ent(PREMIUM));
  assert.equal(v.showPremiumActiveCard, true);
  assert.equal(v.showLightCard, false);
  assert.equal(v.showFreeCard, false);
});

test('権利ゼロ（期限切れ）は無料カードのみ', () => {
  const v = viewFromEntitlements(ent(EXPIRED_PREMIUM));
  assert.equal(v.showLightCard, false);
  assert.equal(v.showPremiumActiveCard, false);
  assert.equal(v.showFreeCard, true);
});

test('三連複買い切り保有者には三連複カードを出し、無料カードは出さない', () => {
  const v = viewFromEntitlements(ent(SANRENPUKU_ONLY));
  assert.equal(v.showSanrenpukuCard, true);
  assert.equal(v.showFreeCard, false, '買い切り保有者を「無料会員」として扱わない');
});

// ── ナビ側の定数 ──────────────────────────────────────────────
test('ナビは行き先を 1 本（/today/）に固定し、文言はプランで変えない', () => {
  assert.equal(PREDICTION_NAV_HREF, '/today/');
  assert.equal(PREDICTION_NAV_LABEL, '今日の予想');
});
