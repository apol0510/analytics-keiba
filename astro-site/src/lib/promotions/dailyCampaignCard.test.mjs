/**
 * 無料予想の特別価格の案内カード（2026-11-11 MK）: 1 日 1 回（JST）・有料会員と決済中には出さない・閲覧に合わせたプラン・比較群。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  decideCampaignCard, markShown, jstDay, isPaidViewer, assignGroup, recordVenueDay, pickCampaignPlan,
  DELAY_MS, HOLDOUT_RATE,
} from './dailyCampaignCard.js';

const T = Date.parse('2026-11-11T03:00:00Z'); // JST 12:00

test('1 日 1 回: 出した（閉じた）日は再表示しない・JST 0 時で切り替わる', () => {
  assert.equal(decideCampaignCard({ nowMs: T }).show, true);
  const st = markShown(T);
  assert.deepEqual(decideCampaignCard({ nowMs: T + 60_000, stateRaw: st }), { show: false, reason: 'already_today' }, '再読み込み・ページ移動');
  assert.equal(decideCampaignCard({ nowMs: T, stateRaw: markShown(T, { dismissed: true }) }).show, false, '閉じた日');
  const beforeMidnight = Date.parse('2026-11-11T14:59:00Z'); // JST 23:59
  const afterMidnight = Date.parse('2026-11-11T15:00:00Z'); // JST 翌 0:00
  assert.equal(decideCampaignCard({ nowMs: beforeMidnight, stateRaw: markShown(T) }).show, false);
  assert.equal(decideCampaignCard({ nowMs: afterMidnight, stateRaw: markShown(T) }).show, true, '翌日（JST）はまた 1 回');
  assert.equal(jstDay(afterMidnight), '2026-11-12');
  assert.equal(decideCampaignCard({ nowMs: T, stateRaw: '{壊れた' }).show, true, '壊れた記録は無視');
});

test('有料会員・決済中・受付終了には出さない（期限切れは有料として扱わない）', () => {
  const paid = JSON.stringify({ plan: 'Premium', validUntil: '2026-12-31' });
  assert.equal(decideCampaignCard({ nowMs: T, userPlanRaw: paid }).reason, 'paid');
  assert.equal(decideCampaignCard({ nowMs: T, userPlanRaw: JSON.stringify({ plan: 'Light' }) }).reason, 'paid');
  assert.equal(decideCampaignCard({ nowMs: T, userPlanRaw: JSON.stringify({ plan: 'free' }) }).show, true);
  assert.equal(isPaidViewer(JSON.stringify({ plan: 'Premium', validUntil: '2026-11-01' }), T), false);
  assert.equal(isPaidViewer(JSON.stringify({ plan: 'Premium', isExpired: true }), T), false);
  assert.equal(decideCampaignCard({ nowMs: T, inCheckout: true }).reason, 'checkout');
  assert.equal(decideCampaignCard({ nowMs: T, campaignOpen: false }).reason, 'closed');
});

test('閲覧に合わせた主力プラン: 中央 → 中央版・南関 → 南関版・両方 → セット', () => {
  assert.equal(pickCampaignPlan({ pageVenue: 'jra', venueDays: { jra: ['2026-11-11'] } }), 'premium-jra');
  assert.equal(pickCampaignPlan({ pageVenue: 'nankan', venueDays: {} }), 'premium-nankan');
  assert.equal(pickCampaignPlan({ pageVenue: 'nankan', venueDays: { jra: ['2026-11-08'], nankan: ['2026-11-11'] } }), 'premium');
  assert.equal(pickCampaignPlan({ pageVenue: 'all', venueDays: { jra: ['2026-11-08'] } }), 'premium-jra');
  assert.equal(pickCampaignPlan({ pageVenue: 'all', venueDays: null }), 'premium');
});

test('閲覧日の記録: 会場別・重複なし・14 日より古いものは捨てる', () => {
  let d = recordVenueDay(null, 'nankan', T);
  d = recordVenueDay(JSON.stringify(d), 'nankan', T + 3600e3);
  assert.deepEqual(d, { jra: [], nankan: ['2026-11-11'] });
  d = recordVenueDay(JSON.stringify({ jra: ['2026-10-01', '2026-11-08', 'x'], nankan: ['2026-11-11'] }), 'jra', T);
  assert.deepEqual(d, { jra: ['2026-11-08', '2026-11-11'], nankan: ['2026-11-11'] });
});

test('比較群は端末ごとに固定・割合は HOLDOUT_RATE', () => {
  assert.equal(assignGroup(null, 0.05), 'holdout');
  assert.equal(assignGroup(null, 0.5), 'show');
  assert.equal(assignGroup('holdout', 0.9), 'holdout', '一度決めた群は変えない');
  assert.equal(assignGroup('evil', 0.9), 'show');
  assert.ok(HOLDOUT_RATE > 0 && HOLDOUT_RATE <= 0.2);
  assert.ok(DELAY_MS >= 15_000 && DELAY_MS <= 20_000, 'MK: 閲覧開始 15〜20 秒後');
});

test('カード部品: 開いた瞬間に出さない・1 案だけ・初回限定を強調しない・価格はサーバー側の単一源・有料ページと決済ページに置かない', () => {
  const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  const comp = read('../../components/PremiumCampaignCard.astro');
  assert.match(comp, /campaignPriceFor/);
  assert.doesNotMatch(comp, /初回限定|初月限定|残りわずか|今だけ|急いで/);
  assert.match(comp, /DELAY_MS/);
  assert.match(comp, /ほかのプランを見る/);
  assert.match(comp, /自動更新/, '更新後の料金をカードでも示す');
  assert.doesNotMatch(comp, /¥\s?\d|\d,\d{3}円/, '金額を直書きしない');
  assert.doesNotMatch(comp, /\?plan=/, '料金ページの自動申込（?plan=）を使わない');
  for (const p of ['free/index.astro', 'free/jra.astro', 'free/nankan.astro', 'free-prediction/jra.astro', 'free-prediction/nankan.astro']) {
    assert.match(read(`../../pages/${p}`), /<PremiumCampaignCard /, p);
  }
  for (const p of ['pricing.astro', 'checkout/paypal-subscription-return.astro', 'predictions/view.astro', 'dashboard.astro']) {
    assert.doesNotMatch(read(`../../pages/${p}`), /PremiumCampaignCard/, p);
  }
});
