/**
 * comebackPolicy.test.mjs — 施策は**カタログの宣言**だけで決まる
 *   node --test src/lib/entitlements/comebackPolicy.test.mjs
 *
 * ここが守れないと「施策を 1 つ増やすたびにコード修正 → PR → deploy」に戻る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CB_SEGMENT, CB_SEGMENT_LABEL, CB_SEGMENT_NOTE, CB_ENTITLEMENT,
  CB_POLICY_INVALID, CB_MAX_POLICY_DAYS, CB_HONOR_BLOCK,
  resolveComebackPolicy, listComebackPolicies, getComebackPolicyByOfferId,
  isWithdrawnAllowedForOffer, describeWithdrawnAvailability,
  policyCoversSegment, campaignForOfferId, honorsGrantDespiteWithdrawal,
} from './comebackPolicy.js';
import { resolveOffer, getOfferDefinition, OFFER_KIND } from '../promotions/promotionOfferCatalog.js';
import { GRANT_CAMPAIGN_BY_OFFER } from '../comeback/comebackGrantCampaign.js';
import { getCampaign } from '../marketing/campaignCatalog.js';

const NOW = Date.UTC(2026, 7, 4, 3, 0, 0);
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

/** 宣言のひな型（テストで一部だけ壊して境界を確かめる） */
const decl = (over = {}) => ({
  offerId: 'x-test-free',
  kind: OFFER_KIND.GRANT,
  targetTier: 'light',
  duration: 30,
  isLifetime: false,
  comeback: {
    audienceSegments: ['expired', 'withdrawn'],
    allowWithdrawn: true,
    grantTier: 'light',
    durationDays: 30,
    campaignId: 'x-campaign',
    campaignVersion: 1,
    requiresSuccessfulGrant: true,
    restoresPaidContract: false,
    preserveWithdrawalRequested: true,
    allowedEntitlements: ['light'],
    forbiddenEntitlements: ['premium', 'sanrenpuku', 'purchase'],
    ...(over.comeback || {}),
  },
  ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'comeback')),
});

// ── 今回の施策が宣言どおりであること ──────────────────────────

test('Light 30日無料が指定どおりの定義になっている', () => {
  const p = getComebackPolicyByOfferId('light-30d-free');
  assert.ok(p, '施策として宣言されていない');
  assert.deepEqual([...p.audienceSegments], ['expired', 'withdrawn']);
  assert.equal(p.allowWithdrawn, true);
  assert.equal(p.grantTier, 'light');
  assert.equal(p.durationDays, 30);
  assert.equal(p.campaignId, 'comeback-light-30d-granted');
  assert.equal(p.campaignVersion, 2);
  assert.equal(p.requiresSuccessfulGrant, true);
  assert.equal(p.restoresPaidContract, false);
  assert.equal(p.preserveWithdrawalRequested, true);
  assert.deepEqual([...p.allowedEntitlements], ['light']);
  assert.deepEqual([...p.forbiddenEntitlements], ['premium', 'sanrenpuku', 'purchase']);
});

test('宣言した campaignVersion が実在するキャンペーンと一致する', () => {
  const p = getComebackPolicyByOfferId('light-30d-free');
  const c = getCampaign(p.campaignId);
  assert.ok(c, '宣言したキャンペーンがカタログに無い');
  assert.equal(c.version, p.campaignVersion, '宣言と実際の version がズレている');
});

test('案内キャンペーンの対応表は宣言から作られる（手書きしない）', () => {
  assert.equal(GRANT_CAMPAIGN_BY_OFFER['light-30d-free'], 'comeback-light-30d-granted');
  for (const p of listComebackPolicies()) {
    assert.equal(GRANT_CAMPAIGN_BY_OFFER[p.offerId], p.campaignId, `${p.offerId} の対応が宣言と違う`);
  }
  assert.equal(campaignForOfferId('light-30d-free').campaignVersion, 2);
  assert.equal(campaignForOfferId('light-lifetime-free'), null);
});

// ── 宣言が無い / 壊れていれば使えない（fail closed）──────────────

test('宣言が無い特典は退会者へ配れない', () => {
  for (const id of ['light-lifetime-free', 'light-90d-free', 'premium-30d-free', 'premium-lifetime-free']) {
    const r = resolveOffer(id, {});
    if (!r.ok) continue;
    assert.equal(isWithdrawnAllowedForOffer(r.offer), false, `${id} が配れてしまう`);
    assert.equal(resolveComebackPolicy(r.offer).reason, CB_POLICY_INVALID.MISSING);
  }
});

test('壊れた宣言は 1 つ残らず弾く', () => {
  const cases = [
    [{ comeback: { audienceSegments: [] } }, CB_POLICY_INVALID.BAD_SEGMENTS],
    [{ comeback: { audienceSegments: ['nope'] } }, CB_POLICY_INVALID.BAD_SEGMENTS],
    [{ comeback: { grantTier: 'sanrenpuku' } }, CB_POLICY_INVALID.BAD_TIER],
    [{ comeback: { durationDays: 0 } }, CB_POLICY_INVALID.BAD_DURATION],
    [{ comeback: { durationDays: CB_MAX_POLICY_DAYS + 1 } }, CB_POLICY_INVALID.BAD_DURATION],
    [{ comeback: { campaignId: '' } }, CB_POLICY_INVALID.BAD_CAMPAIGN],
    [{ comeback: { campaignVersion: 0 } }, CB_POLICY_INVALID.BAD_CAMPAIGN],
    [{ comeback: { restoresPaidContract: true } }, CB_POLICY_INVALID.RESTORES_PAID],
    [{ comeback: { preserveWithdrawalRequested: false } }, CB_POLICY_INVALID.CLEARS_WITHDRAWAL],
    [{ comeback: { allowedEntitlements: [] } }, CB_POLICY_INVALID.BAD_ENTITLEMENTS],
    [{ comeback: { allowedEntitlements: ['premium'] } }, CB_POLICY_INVALID.TIER_NOT_ALLOWED],
    [{ comeback: { forbiddenEntitlements: ['light'] } }, CB_POLICY_INVALID.TIER_FORBIDDEN],
    // 定義本体と宣言が食い違うもの
    [{ isLifetime: true }, CB_POLICY_INVALID.BAD_DURATION],
    [{ duration: 90 }, CB_POLICY_INVALID.BAD_DURATION],
    [{ targetTier: 'premium' }, CB_POLICY_INVALID.BAD_TIER],
  ];
  for (const [over, reason] of cases) {
    const r = resolveComebackPolicy(decl(over));
    assert.equal(r.ok, false, `${JSON.stringify(over)} が通ってしまう`);
    assert.equal(r.reason, reason, `${JSON.stringify(over)} の理由が違う`);
  }
});

test('宣言が正しければ通る（ひな型が壊れていないことの確認）', () => {
  const r = resolveComebackPolicy(decl());
  assert.equal(r.ok, true);
  assert.equal(r.policy.allowWithdrawn, true);
});

// ── 管理画面へ出す表示 ────────────────────────────────────────

test('区分名は「退会・課金停止」で、配信停止と別だと説明する', () => {
  assert.equal(CB_SEGMENT_LABEL[CB_SEGMENT.WITHDRAWN], '退会・課金停止');
  assert.match(CB_SEGMENT_NOTE[CB_SEGMENT.WITHDRAWN], /メール配信停止とは別/);
});

test('特典ごとに退会者への可否を文言で返す', () => {
  const ok = describeWithdrawnAvailability(resolveOffer('light-30d-free', {}).offer);
  assert.equal(ok.allowed, true);
  assert.match(ok.label, /配れます/);
  assert.match(ok.note, /30 日/);
  assert.match(ok.note, /変更しません/);

  const ng = describeWithdrawnAvailability(resolveOffer('light-lifetime-free', {}).offer);
  assert.equal(ng.allowed, false);
  assert.match(ng.label, /配れません/);
  assert.equal(ng.policy, null);
});

test('施策が想定する区分かどうかを答えられる', () => {
  const p = getComebackPolicyByOfferId('light-30d-free');
  assert.equal(policyCoversSegment(p, CB_SEGMENT.WITHDRAWN), true);
  assert.equal(policyCoversSegment(p, CB_SEGMENT.EXPIRED), true);
  assert.equal(policyCoversSegment(p, CB_SEGMENT.DORMANT), false);
  assert.equal(policyCoversSegment(null, CB_SEGMENT.WITHDRAWN), false);
});

// ── 権限側（ログインで認めるか）も宣言から決まる ────────────────

const granted = (over = {}) => ({
  LightGrantUntil: iso(NOW + 30 * DAY),
  LightGrantedAt: iso(NOW),
  LightGrantOp: 'cb-light-30d-free-2026-08-04-abcdef01',
  ...over,
});

test('宣言どおりの付与は退会者でも認める', () => {
  const r = honorsGrantDespiteWithdrawal({ fields: granted(), nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.tier, 'light');
  assert.equal(r.policyOfferId, 'light-30d-free');
  assert.deepEqual(r.allowedEntitlements, ['light']);
});

test('宣言した期間を超える付与は認めない', () => {
  const r = honorsGrantDespiteWithdrawal({
    fields: granted({ LightGrantUntil: iso(NOW + 200 * DAY) }), nowMs: NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, CB_HONOR_BLOCK.OUT_OF_POLICY);
});

test('永久無料・取消済み・操作記録なし・期限切れは認めない', () => {
  const cases = [
    [granted({ LightGrantLifetime: true, LightGrantUntil: '' }), CB_HONOR_BLOCK.LIFETIME],
    [granted({ LightGrantRevokedAt: iso(NOW + DAY) }), CB_HONOR_BLOCK.INCONSISTENT],
    [granted({ LightGrantOp: '' }), CB_HONOR_BLOCK.NO_OPERATION],
  ];
  for (const [fields, reason] of cases) {
    const r = honorsGrantDespiteWithdrawal({ fields, nowMs: NOW });
    assert.equal(r.ok, false);
    assert.equal(r.reason, reason);
  }
  assert.equal(honorsGrantDespiteWithdrawal({ fields: granted(), nowMs: NOW + 31 * DAY }).ok, false);
});

test('ForceLogout は宣言では緩められない', () => {
  const r = honorsGrantDespiteWithdrawal({ fields: granted({ ForceLogout: true }), nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, CB_HONOR_BLOCK.FORCE_LOGOUT);
});

test('Premium の特典は退会者へ認めない（宣言が無いので一致しない）', () => {
  const r = honorsGrantDespiteWithdrawal({
    fields: {
      PremiumGrantUntil: iso(NOW + 30 * DAY),
      PremiumGrantedAt: iso(NOW),
      PremiumGrantOp: 'op',
    },
    nowMs: NOW,
  });
  assert.equal(r.ok, false);
});

// ── 施策を増やすのはカタログだけで足りる ──────────────────────

test('カタログに宣言を足すだけで施策が増える（コードは触らない）', () => {
  // 実カタログを汚さずに「宣言だけ足した特典」を作って評価する
  const added = decl({ offerId: 'light-14d-free', duration: 14, comeback: { durationDays: 14, campaignId: 'x', campaignVersion: 3 } });
  const r = resolveComebackPolicy(added);
  assert.equal(r.ok, true, '宣言を足しても施策として認識されない');
  assert.equal(r.policy.durationDays, 14);
  assert.equal(isWithdrawnAllowedForOffer(added), true);

  // 現行カタログ側は 1 件のまま（この足し込みが実データを汚していない）
  assert.equal(listComebackPolicies().length, 1);
  assert.equal(getOfferDefinition('light-30d-free').comeback.campaignId, 'comeback-light-30d-granted');
});
