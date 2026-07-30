/**
 * campaignAudienceRules.test.mjs — キャンペーン固有の追加絞り込みの検証
 *   node --test src/lib/marketing/campaignAudienceRules.test.mjs
 *
 * 重点: Premium Plus 案内が「商品ページを実際に開ける会員」だけへ送られること。
 *       CTA 先 /premium-plus/ は PHASE 3 未満・非 eligible では 404 になるため、
 *       条件を満たさない相手へ送ると必ずリンク切れになる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { evaluateExtraAudience, EXTRA_AUDIENCE, CAMPAIGN_MISMATCH } from './campaignAudienceRules.js';
import { getCampaign } from './campaignCatalog.js';
import { PP_PHASE_START_DAY, resolvePremiumPlusRelease } from '../premiumPlus/premiumPlusRelease.js';
import { resolvePlusMemberFromFields } from '../premiumPlus/premiumPlusMember.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 3, 1, 0);
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();
const ppCampaign = getCampaign('premium-plus-offer');

/** 三連複保有（ROUTE A）の会員レコード */
const sanrenpuku = (over = {}) => ({
  Email: 'a@example.com', 'プラン': 'Premium', PlanType: 'Annual',
  Status: 'active', '有効期限': '2099-01-01', LifetimeSanrenpuku: true,
  ...over,
});

const evalPP = (fields) => evaluateExtraAudience({ campaign: ppCampaign, fields, nowMs: NOW });

test('Premium Plus 案内は extraAudience が設定されている', () => {
  assert.equal(ppCampaign.extraAudience, EXTRA_AUDIENCE.PREMIUM_PLUS_RELEASE);
});

test('eligible かつ PHASE 3 以上（商品ページ閲覧可）だけ対象になる', () => {
  const fields = sanrenpuku({
    PremiumPlusEligibility: 'eligible',
    PremiumPlusEligibleAt: daysAgo(PP_PHASE_START_DAY.PREVIEW),
  });
  // 単一源の判定でも showProductPage=true であることを確認
  const release = resolvePremiumPlusRelease({ ...resolvePlusMemberFromFields(fields, { nowMs: NOW }), nowMs: NOW });
  assert.equal(release.showProductPage, true);
  assert.equal(evalPP(fields).ok, true);
});

test('PHASE 1 / 2 は除外（商品ページがまだ 404）', () => {
  for (const days of [0, 1, PP_PHASE_START_DAY.TEASER, PP_PHASE_START_DAY.PREVIEW - 1]) {
    const fields = sanrenpuku({
      PremiumPlusEligibility: 'eligible',
      PremiumPlusEligibleAt: daysAgo(days),
    });
    const r = evalPP(fields);
    assert.equal(r.ok, false, `${days} 日目が対象になっている`);
    assert.equal(r.reason, CAMPAIGN_MISMATCH);
    assert.ok(String(r.detail).startsWith('phase_'), `detail=${r.detail}`);
  }
});

test('review / blocked / 未設定は除外', () => {
  for (const eligibility of ['review', 'blocked', undefined, '', 'bogus']) {
    const fields = sanrenpuku({
      PremiumPlusEligibility: eligibility,
      PremiumPlusEligibleAt: daysAgo(30),
    });
    const r = evalPP(fields);
    assert.equal(r.ok, false, `eligibility=${eligibility} が対象になっている`);
    assert.equal(r.reason, CAMPAIGN_MISMATCH);
    assert.ok(String(r.detail).startsWith('eligibility_'), `detail=${r.detail}`);
  }
});

test('route none（三連複を持たない）は eligible でも除外', () => {
  const fields = {
    Email: 'a@example.com', 'プラン': 'Premium', PlanType: 'Annual',
    Status: 'active', '有効期限': '2099-01-01', // LifetimeSanrenpuku なし・PaidAt なし
    PremiumPlusEligibility: 'eligible', PremiumPlusEligibleAt: daysAgo(30),
  };
  const r = evalPP(fields);
  assert.equal(r.ok, false);
  assert.equal(r.detail, 'route_none');
});

test('override（今すぐ販売可）で PHASE 4 の会員は対象になる', () => {
  const fields = sanrenpuku({
    PremiumPlusEligibility: 'eligible',
    PremiumPlusEligibleAt: daysAgo(0), // 本来は PHASE 1
    PremiumPlusReleaseOverride: 'phase4',
  });
  assert.equal(evalPP(fields).ok, true, 'override 済みでも除外されている');
});

test('fields が無い / 壊れている場合は除外（fail closed）', () => {
  for (const bad of [null, undefined, 'x', 123]) {
    const r = evaluateExtraAudience({ campaign: ppCampaign, fields: bad, nowMs: NOW });
    assert.equal(r.ok, false);
  }
});

test('extraAudience が無いキャンペーンは常に通す', () => {
  const r = evaluateExtraAudience({ campaign: { campaignId: 'x' }, fields: {}, nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(evaluateExtraAudience({}).ok, true);
});

test('未知の extraAudience は全員除外（定義ミスで全員へ送らない）', () => {
  const r = evaluateExtraAudience({ campaign: { extraAudience: 'nope' }, fields: {}, nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, CAMPAIGN_MISMATCH);
});

// ── 責務分離の guard ──────────────────────────────────────────
const rulesSrc = readFileSync(fileURLToPath(new URL('./campaignAudienceRules.js', import.meta.url)), 'utf8');
const rulesCode = rulesSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const audienceSrc = readFileSync(fileURLToPath(new URL('./customerMarketingAudience.js', import.meta.url)), 'utf8');
const audienceCode = audienceSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('マーケティング対象判定を Premium Plus 販売判定で汚していない', () => {
  const imports = [...audienceCode.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  for (const i of imports) {
    assert.equal(i.includes('premiumPlus'), false, `customerMarketingAudience が ${i} を import している`);
  }
  assert.equal(/PremiumPlusEligibleAt|showProductPage|PP_PHASE/.test(audienceCode), false,
    'マーケティング判定に Premium Plus の段階公開ロジックが混入している');
});

test('PHASE 判定を複製せず単一源へ委譲している', () => {
  assert.ok(rulesCode.includes('resolvePremiumPlusRelease'), '単一源を使っていない');
  assert.ok(rulesCode.includes('resolvePlusMemberFromFields'));
  // 日数条件・PHASE 定数をここで再計算しない
  assert.equal(/PP_PHASE_START_DAY|jstDayDiff|computePhase|86400000/.test(rulesCode), false,
    'PHASE 計算を複製している');
});

test('Premium Plus の販売資格を書き換えない（読み取りのみ）', () => {
  for (const banned of ['fetch(', 'method:', 'buildAdminActionFields', 'buildEligibilityUpdateFields', 'process.env']) {
    assert.equal(rulesCode.includes(banned), false, `${banned} を含んでいる`);
  }
});
