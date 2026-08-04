/**
 * comebackWithdrawnPolicy.test.mjs
 *   node --test src/lib/entitlements/comebackWithdrawnPolicy.test.mjs
 *
 * 退会者への無料付与は**この施策の形だけ**開ける。
 * 「退会者にも付与できるようになった」と読み違えて広がらないよう、境界を固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isWithdrawnGrantAllowed, honorsLightGrantDespiteWithdrawal,
  WITHDRAWN_GRANT_OFFER_ID, WITHDRAWN_GRANT_CAMPAIGN_ID,
  WITHDRAWN_GRANT_MAX_DAYS, WITHDRAWN_HONOR_BLOCK,
} from './comebackWithdrawnPolicy.js';
import { GRANT_CAMPAIGN_BY_OFFER } from '../comeback/comebackGrantCampaign.js';
import { resolveOffer } from '../promotions/promotionOfferCatalog.js';

const NOW = Date.UTC(2026, 7, 4, 3, 0, 0);
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();

// ── 付与側: どの特典なら退会者へ出せるか ────────────────────────────

test('カムバックの Light 30日無料だけが退会者へ出せる', () => {
  const r = resolveOffer(WITHDRAWN_GRANT_OFFER_ID, {});
  assert.equal(r.ok, true);
  assert.equal(isWithdrawnGrantAllowed(r.offer), true);
});

test('offerId と案内キャンペーンの対応が 1 対 1 で保たれている', () => {
  assert.equal(GRANT_CAMPAIGN_BY_OFFER[WITHDRAWN_GRANT_OFFER_ID], WITHDRAWN_GRANT_CAMPAIGN_ID);
});

test('永久無料・Premium・長期の付与は退会者へ出せない', () => {
  for (const id of ['light-lifetime-free', 'light-90d-free', 'premium-30d-free']) {
    const r = resolveOffer(id, {});
    if (!r.ok) continue;
    assert.equal(isWithdrawnGrantAllowed(r.offer), false, `${id} が退会者へ出せてしまう`);
  }
});

test('offerId が合っていても中身が施策と違えば出せない（定義すり替え対策）', () => {
  const base = { offerId: WITHDRAWN_GRANT_OFFER_ID, targetTier: 'light', isLifetime: false, duration: 30 };
  assert.equal(isWithdrawnGrantAllowed(base), true);
  assert.equal(isWithdrawnGrantAllowed({ ...base, isLifetime: true }), false, '無期限が通る');
  assert.equal(isWithdrawnGrantAllowed({ ...base, targetTier: 'premium' }), false, 'Premium が通る');
  assert.equal(isWithdrawnGrantAllowed({ ...base, duration: WITHDRAWN_GRANT_MAX_DAYS + 1 }), false, '31 日が通る');
  assert.equal(isWithdrawnGrantAllowed({ ...base, duration: 0 }), false);
  assert.equal(isWithdrawnGrantAllowed({ ...base, duration: null }), false);
  assert.equal(isWithdrawnGrantAllowed({ ...base, offerId: 'light-30d-free-x' }), false);
  assert.equal(isWithdrawnGrantAllowed(null), false);
  assert.equal(isWithdrawnGrantAllowed(undefined), false);
});

// ── 権限側: 付与した特典を退会者のログインで認めるか ──────────────────

const granted = (over = {}) => ({
  LightGrantUntil: iso(NOW + 30 * DAY),
  LightGrantedAt: iso(NOW),
  LightGrantOp: 'cb-light-30d-free-2026-08-04-abcdef01',
  ...over,
});

test('期間内の Light 特典（操作記録あり）は退会者でも認める', () => {
  const r = honorsLightGrantDespiteWithdrawal({ fields: granted(), nowMs: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
});

test('永久無料は退会者へ認めない（無期限の権利を渡さない）', () => {
  const r = honorsLightGrantDespiteWithdrawal({
    fields: granted({ LightGrantLifetime: true, LightGrantUntil: '' }), nowMs: NOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, WITHDRAWN_HONOR_BLOCK.LIFETIME);
});

test('期限が過ぎた特典は認めない（自動的に無料会員へ戻る）', () => {
  const r = honorsLightGrantDespiteWithdrawal({ fields: granted(), nowMs: NOW + 31 * DAY });
  assert.equal(r.ok, false);
  assert.equal(r.reason, WITHDRAWN_HONOR_BLOCK.NO_GRANT);
});

test('取消済み・不整合は認めない', () => {
  const r = honorsLightGrantDespiteWithdrawal({
    fields: granted({ LightGrantRevokedAt: iso(NOW + DAY) }), nowMs: NOW,
  });
  assert.equal(r.ok, false);
});

test('付与操作の記録が無いものは認めない（手編集を権限の根拠にしない）', () => {
  const r = honorsLightGrantDespiteWithdrawal({ fields: granted({ LightGrantOp: '' }), nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, WITHDRAWN_HONOR_BLOCK.NO_OPERATION);
});

test('ForceLogout は施策に関係なく認めない（安全措置は緩めない）', () => {
  const r = honorsLightGrantDespiteWithdrawal({ fields: granted({ ForceLogout: true }), nowMs: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, WITHDRAWN_HONOR_BLOCK.FORCE_LOGOUT);
});

test('特典が無いレコードは認めない', () => {
  assert.equal(honorsLightGrantDespiteWithdrawal({ fields: {}, nowMs: NOW }).ok, false);
  assert.equal(honorsLightGrantDespiteWithdrawal({ fields: null, nowMs: NOW }).ok, false);
  assert.equal(honorsLightGrantDespiteWithdrawal({}).ok, false);
});
