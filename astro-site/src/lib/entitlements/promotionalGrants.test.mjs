/**
 * promotionalGrants.test.mjs — カムバック特典フィールドの組み立て・解釈
 *   node --test src/lib/entitlements/promotionalGrants.test.mjs
 *
 * 守る性質:
 *   - 課金・契約・三連複・Premium Plus のフィールドを**構造的に書けない**
 *   - 同じ operationId の再実行で二重付与しない
 *   - 取り消しは promotional grant だけを消す
 *   - 壊れたデータ（取り消し済みなのに値が残る）は権利なし側へ倒す
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROMO_GRANT,
  PROMO_FIELDS,
  PROMO_WRITABLE_FIELDS,
  PROMO_FORBIDDEN_FIELDS,
  PREMIUM_TRIAL_DAYS,
  resolvePromotionalGrants,
  buildGrantFields,
  buildRevokeFields,
  assertOnlyGrantFields,
  computeTrialUntilMs,
  isGrantFieldsEnabled,
  isGrantWriteEnabled,
  describeGrantState,
} from './promotionalGrants.js';

const NOW = Date.parse('2026-07-30T12:00:00Z');
const OP = 'cb-comeback_full-2026-07-30-abc12345';
const DAY = 24 * 60 * 60 * 1000;

// ═══ allowlist ═══════════════════════════════════════════════════════

test('書き込み許可フィールドに課金・契約・三連複・Plus が 1 つも含まれない', () => {
  for (const forbidden of PROMO_FORBIDDEN_FIELDS) {
    assert.equal(PROMO_WRITABLE_FIELDS.includes(forbidden), false, `${forbidden} が許可リストにある`);
  }
  // 代表的な事故ケースを明示的に固定
  for (const f of ['プラン', '有効期限', 'Status', 'PlanType', 'PaidAt', 'PaymentConfirmed',
    'PaymentEmailSent', 'LifetimeSanrenpuku', 'PremiumPlusEligibility', 'WithdrawalRequested']) {
    assert.equal(PROMO_WRITABLE_FIELDS.includes(f), false, `${f} を書けてしまう`);
  }
});

test('assertOnlyGrantFields は許可外を 1 つでも含めば false', () => {
  assert.equal(assertOnlyGrantFields({ [PROMO_FIELDS.LIGHT_GRANTED]: true }), true);
  assert.equal(assertOnlyGrantFields({ [PROMO_FIELDS.LIGHT_GRANTED]: true, 'プラン': 'Premium' }), false);
  assert.equal(assertOnlyGrantFields({ '有効期限': '2027-01-01' }), false);
  assert.equal(assertOnlyGrantFields({}), false);
  assert.equal(assertOnlyGrantFields(null), false);
});

// ═══ gate ════════════════════════════════════════════════════════════

test('env gate は二段。既定は両方 false（fail closed）', () => {
  assert.equal(isGrantFieldsEnabled({}), false);
  assert.equal(isGrantWriteEnabled({}), false);
  assert.equal(isGrantFieldsEnabled({ COMEBACK_GRANT_FIELDS_READY: '1' }), true);
  // フィールドだけ有効でも書き込みは無効
  assert.equal(isGrantWriteEnabled({ COMEBACK_GRANT_FIELDS_READY: '1' }), false);
  // 実行 gate だけでも無効（フィールドが無ければ 422 になるため）
  assert.equal(isGrantWriteEnabled({ COMEBACK_GRANT_ENABLED: 'true' }), false);
  assert.equal(isGrantWriteEnabled({ COMEBACK_GRANT_FIELDS_READY: '1', COMEBACK_GRANT_ENABLED: 'true' }), true);
  // 'true' 以外は無効
  assert.equal(isGrantWriteEnabled({ COMEBACK_GRANT_FIELDS_READY: '1', COMEBACK_GRANT_ENABLED: '1' }), false);
});

// ═══ resolve ═════════════════════════════════════════════════════════

test('フィールドが無いレコードは特典なし', () => {
  const g = resolvePromotionalGrants({}, NOW);
  assert.equal(g.hasAny, false);
  assert.equal(g.lightLifetime.active, false);
  assert.equal(g.premiumTrial.active, false);
  assert.equal(resolvePromotionalGrants(null, NOW).hasAny, false);
  assert.equal(resolvePromotionalGrants(undefined, NOW).hasAny, false);
});

test('Light 永久無料は期限を持たない', () => {
  const g = resolvePromotionalGrants({
    [PROMO_FIELDS.LIGHT_GRANTED]: true,
    [PROMO_FIELDS.LIGHT_GRANTED_AT]: new Date(NOW - 400 * DAY).toISOString(),
  }, NOW);
  assert.equal(g.lightLifetime.active, true, '1 年以上経っても有効');
  assert.equal(g.hasAny, true);
});

test('Premium 無料期間は untilMs を過ぎると expired（active ではない）', () => {
  const base = {
    [PROMO_FIELDS.TRIAL_GRANTED_AT]: new Date(NOW - 10 * DAY).toISOString(),
  };
  const active = resolvePromotionalGrants({
    ...base, [PROMO_FIELDS.TRIAL_UNTIL]: new Date(NOW + 20 * DAY).toISOString(),
  }, NOW);
  assert.equal(active.premiumTrial.active, true);
  assert.equal(active.premiumTrial.daysRemaining, 20);

  const done = resolvePromotionalGrants({
    ...base, [PROMO_FIELDS.TRIAL_UNTIL]: new Date(NOW - 1).toISOString(),
  }, NOW);
  assert.equal(done.premiumTrial.active, false);
  assert.equal(done.premiumTrial.expired, true);
});

test('取り消し済みなのに値が残っている壊れたデータは権利なし（fail closed）', () => {
  const g = resolvePromotionalGrants({
    [PROMO_FIELDS.LIGHT_GRANTED]: true,
    [PROMO_FIELDS.LIGHT_GRANTED_AT]: new Date(NOW - 10 * DAY).toISOString(),
    [PROMO_FIELDS.LIGHT_REVOKED_AT]: new Date(NOW - 1 * DAY).toISOString(),
  }, NOW);
  assert.equal(g.lightLifetime.active, false);
  assert.equal(g.lightLifetime.inconsistent, true, '不整合として可視化されない');
});

test('取り消し後の再付与は有効（GrantedAt > RevokedAt）', () => {
  const g = resolvePromotionalGrants({
    [PROMO_FIELDS.LIGHT_GRANTED]: true,
    [PROMO_FIELDS.LIGHT_REVOKED_AT]: new Date(NOW - 10 * DAY).toISOString(),
    [PROMO_FIELDS.LIGHT_GRANTED_AT]: new Date(NOW - 1 * DAY).toISOString(),
  }, NOW);
  assert.equal(g.lightLifetime.active, true);
  assert.equal(g.lightLifetime.inconsistent, false);
});

// ═══ 付与 ════════════════════════════════════════════════════════════

test('Light 永久無料の付与フィールド（課金フィールドを含まない）', () => {
  const r = buildGrantFields({
    grantType: PROMO_GRANT.LIGHT_LIFETIME, fields: {}, now: NOW,
    operationId: OP, actor: 'MK', source: 'comeback-2026-07',
  });
  assert.ok(r.fields);
  assert.equal(r.fields[PROMO_FIELDS.LIGHT_GRANTED], true);
  assert.equal(r.fields[PROMO_FIELDS.LIGHT_GRANT_OP], OP);
  assert.equal(r.fields[PROMO_FIELDS.LIGHT_GRANTED_BY], 'MK');
  assert.equal(r.fields[PROMO_FIELDS.SOURCE], 'comeback-2026-07');
  assert.equal(assertOnlyGrantFields(r.fields), true);
  // 期限は持たない
  assert.equal(r.effect.untilMs, null);
});

test(`Premium 無料は付与時刻 + ${PREMIUM_TRIAL_DAYS} 日`, () => {
  const r = buildGrantFields({
    grantType: PROMO_GRANT.PREMIUM_TRIAL_30D, fields: {}, now: NOW, operationId: OP,
  });
  assert.equal(r.effect.untilMs, NOW + PREMIUM_TRIAL_DAYS * DAY);
  assert.equal(r.fields[PROMO_FIELDS.TRIAL_UNTIL], new Date(NOW + PREMIUM_TRIAL_DAYS * DAY).toISOString());
  assert.equal(computeTrialUntilMs(NOW), NOW + PREMIUM_TRIAL_DAYS * DAY);
});

test('同じ operationId の再実行は already_applied（二重付与しない）', () => {
  const first = buildGrantFields({
    grantType: PROMO_GRANT.LIGHT_LIFETIME, fields: {}, now: NOW, operationId: OP,
  });
  const applied = { ...first.fields };
  const second = buildGrantFields({
    grantType: PROMO_GRANT.LIGHT_LIFETIME, fields: applied, now: NOW + DAY, operationId: OP,
  });
  assert.equal(second.skipped, 'already_applied');
  assert.equal(second.fields, undefined);
});

test('別 operationId でも既に有効なら already_granted（Light は再付与しない）', () => {
  const r = buildGrantFields({
    grantType: PROMO_GRANT.LIGHT_LIFETIME,
    fields: { [PROMO_FIELDS.LIGHT_GRANTED]: true },
    now: NOW, operationId: 'cb-other-2026-07-30-zzz',
  });
  assert.equal(r.skipped, 'already_granted');
});

test('有効な Premium trial は暗黙に延長しない（already_granted）', () => {
  const r = buildGrantFields({
    grantType: PROMO_GRANT.PREMIUM_TRIAL_30D,
    fields: { [PROMO_FIELDS.TRIAL_UNTIL]: new Date(NOW + 5 * DAY).toISOString() },
    now: NOW, operationId: 'cb-new-op',
  });
  assert.equal(r.skipped, 'already_granted');
});

test('終了した trial は新しい operationId で再付与できる', () => {
  const r = buildGrantFields({
    grantType: PROMO_GRANT.PREMIUM_TRIAL_30D,
    fields: {
      [PROMO_FIELDS.TRIAL_UNTIL]: new Date(NOW - DAY).toISOString(),
      [PROMO_FIELDS.TRIAL_GRANT_OP]: 'cb-old-op',
    },
    now: NOW, operationId: 'cb-new-op',
  });
  assert.ok(r.fields, '再付与できない');
  assert.equal(r.effect.untilMs, NOW + PREMIUM_TRIAL_DAYS * DAY);
});

test('未知の grantType / operationId 欠落は null（丸めない）', () => {
  assert.equal(buildGrantFields({ grantType: 'free_forever', fields: {}, now: NOW, operationId: OP }), null);
  assert.equal(buildGrantFields({ grantType: PROMO_GRANT.LIGHT_LIFETIME, fields: {}, now: NOW, operationId: '' }), null);
  assert.equal(buildGrantFields({ grantType: PROMO_GRANT.LIGHT_LIFETIME, fields: {}, now: 'x', operationId: OP }), null);
});

// ═══ 取り消し ════════════════════════════════════════════════════════

test('取り消しは特典フィールドだけを書く', () => {
  const r = buildRevokeFields({
    grantType: PROMO_GRANT.LIGHT_LIFETIME,
    fields: { [PROMO_FIELDS.LIGHT_GRANTED]: true, 'プラン': 'Premium', LifetimeSanrenpuku: true },
    now: NOW, actor: 'MK', reason: '誤付与',
  });
  assert.equal(r.fields[PROMO_FIELDS.LIGHT_GRANTED], false);
  assert.ok(String(r.fields[PROMO_FIELDS.LIGHT_REVOKE_REASON]).includes('誤付与'));
  assert.equal(assertOnlyGrantFields(r.fields), true);
  // 有料契約・三連複は 1 つも含まれない
  assert.equal('プラン' in r.fields, false);
  assert.equal('LifetimeSanrenpuku' in r.fields, false);
});

test('特典を持っていない相手の取り消しは not_granted（空 PATCH を投げない）', () => {
  assert.equal(buildRevokeFields({
    grantType: PROMO_GRANT.LIGHT_LIFETIME, fields: {}, now: NOW,
  }).skipped, 'not_granted');
});

test('取り消し後に resolve すると権利が消えている', () => {
  const granted = buildGrantFields({
    grantType: PROMO_GRANT.PREMIUM_TRIAL_30D, fields: {}, now: NOW, operationId: OP,
  }).fields;
  const revoked = buildRevokeFields({
    grantType: PROMO_GRANT.PREMIUM_TRIAL_30D, fields: granted, now: NOW + DAY, actor: 'MK',
  }).fields;
  const after = resolvePromotionalGrants({ ...granted, ...revoked }, NOW + 2 * DAY);
  assert.equal(after.premiumTrial.active, false);
  assert.equal(after.premiumTrial.inconsistent, false, '取り消し後は不整合にならない');
});

test('describeGrantState は状態を人が読める形で返す', () => {
  assert.equal(describeGrantState(resolvePromotionalGrants({}, NOW)), '特典なし');
  const both = resolvePromotionalGrants({
    [PROMO_FIELDS.LIGHT_GRANTED]: true,
    [PROMO_FIELDS.TRIAL_UNTIL]: new Date(NOW + 10 * DAY).toISOString(),
  }, NOW);
  const text = describeGrantState(both);
  assert.match(text, /Premium 無料/);
  assert.match(text, /Light 永久無料/);
});
