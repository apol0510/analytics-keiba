/**
 * promotionalGrants.test.mjs — 無料権利（promotional grant）の組み立て・解釈
 *   node --test src/lib/entitlements/promotionalGrants.test.mjs
 *
 * 守る性質:
 *   - 課金・契約・三連複・Premium Plus のフィールドを**構造的に書けない**
 *   - ティア × 期間の汎用モデル（30日 / 90日 / 任意日数 / 無期限）が全部表現できる
 *   - 同じ operationId の再実行で二重付与しない
 *   - 弱い付与で既存の権利を縮めない（強い方を採用する）
 *   - 取り消しは promotional grant だけを消す
 *   - 壊れたデータ（取り消し済みなのに値が残る）は権利なし側へ倒す
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROMO_TIER,
  PROMO_FIELDS,
  PROMO_WRITABLE_FIELDS,
  PROMO_FORBIDDEN_FIELDS,
  MAX_GRANT_DAYS,
  resolvePromotionalGrants,
  buildGrantFields,
  buildRevokeFields,
  assertOnlyGrantFields,
  computeGrantUntilMs,
  isStrongerGrant,
  isGrantFieldsEnabled,
  isGrantWriteEnabled,
  describeGrantState,
} from './promotionalGrants.js';

const NOW = Date.parse('2026-07-30T12:00:00Z');
const OP = 'cb-light-lifetime-free-2026-07-30-abc12345';
const DAY = 24 * 60 * 60 * 1000;
const L = PROMO_FIELDS.light;
const P = PROMO_FIELDS.premium;
const iso = (ms) => new Date(ms).toISOString();

// ═══ allowlist ═══════════════════════════════════════════════════════

test('書き込み許可フィールドに課金・契約・三連複・Plus が 1 つも含まれない', () => {
  for (const forbidden of PROMO_FORBIDDEN_FIELDS) {
    assert.equal(PROMO_WRITABLE_FIELDS.includes(forbidden), false, `${forbidden} が許可リストにある`);
  }
  for (const f of ['プラン', '有効期限', 'Status', 'PlanType', 'PaidAt', 'PaymentConfirmed',
    'PaymentEmailSent', 'LifetimeSanrenpuku', 'PremiumPlusEligibility', 'WithdrawalRequested']) {
    assert.equal(PROMO_WRITABLE_FIELDS.includes(f), false, `${f} を書けてしまう`);
  }
  // 15 フィールド（ティア 7 × 2 + 施策名）
  assert.equal(PROMO_WRITABLE_FIELDS.length, 15);
});

test('assertOnlyGrantFields は許可外を 1 つでも含めば false', () => {
  assert.equal(assertOnlyGrantFields({ [L.LIFETIME]: true }), true);
  assert.equal(assertOnlyGrantFields({ [L.LIFETIME]: true, 'プラン': 'Premium' }), false);
  assert.equal(assertOnlyGrantFields({ '有効期限': '2027-01-01' }), false);
  assert.equal(assertOnlyGrantFields({}), false);
  assert.equal(assertOnlyGrantFields(null), false);
});

// ═══ gate ════════════════════════════════════════════════════════════

test('env gate は二段。既定は両方 false（fail closed）', () => {
  assert.equal(isGrantFieldsEnabled({}), false);
  assert.equal(isGrantWriteEnabled({}), false);
  assert.equal(isGrantFieldsEnabled({ COMEBACK_GRANT_FIELDS_READY: '1' }), true);
  assert.equal(isGrantWriteEnabled({ COMEBACK_GRANT_FIELDS_READY: '1' }), false);
  assert.equal(isGrantWriteEnabled({ COMEBACK_GRANT_ENABLED: 'true' }), false);
  assert.equal(isGrantWriteEnabled({ COMEBACK_GRANT_FIELDS_READY: '1', COMEBACK_GRANT_ENABLED: 'true' }), true);
  assert.equal(isGrantWriteEnabled({ COMEBACK_GRANT_FIELDS_READY: '1', COMEBACK_GRANT_ENABLED: '1' }), false);
});

// ═══ resolve ═════════════════════════════════════════════════════════

test('フィールドが無いレコードは権利なし', () => {
  const g = resolvePromotionalGrants({}, NOW);
  assert.equal(g.hasAny, false);
  assert.equal(g.light.active, false);
  assert.equal(g.premium.active, false);
  assert.equal(resolvePromotionalGrants(null, NOW).hasAny, false);
});

test('無期限の権利は期限を持たない（何年経っても有効）', () => {
  const g = resolvePromotionalGrants({
    [L.LIFETIME]: true, [L.GRANTED_AT]: iso(NOW - 1200 * DAY),
  }, NOW);
  assert.equal(g.light.active, true);
  assert.equal(g.light.lifetime, true);
  assert.equal(g.light.untilMs, null);
});

test('期限付きの権利は untilMs を過ぎると expired（active ではない）', () => {
  const base = { [P.GRANTED_AT]: iso(NOW - 10 * DAY) };
  const active = resolvePromotionalGrants({ ...base, [P.UNTIL]: iso(NOW + 20 * DAY) }, NOW);
  assert.equal(active.premium.active, true);
  assert.equal(active.premium.daysRemaining, 20);

  const done = resolvePromotionalGrants({ ...base, [P.UNTIL]: iso(NOW - 1) }, NOW);
  assert.equal(done.premium.active, false);
  assert.equal(done.premium.expired, true);
});

test('Light と Premium は独立に持てる（Light は Premium の fallback ではない）', () => {
  const g = resolvePromotionalGrants({
    [L.LIFETIME]: true,
    [P.UNTIL]: iso(NOW + 30 * DAY),
  }, NOW);
  assert.equal(g.light.active, true);
  assert.equal(g.premium.active, true);
  // Premium だけ終わっても Light は残る（書き込み無しで自然に切り替わる）
  const later = resolvePromotionalGrants({
    [L.LIFETIME]: true, [P.UNTIL]: iso(NOW + 30 * DAY),
  }, NOW + 31 * DAY);
  assert.equal(later.premium.active, false);
  assert.equal(later.light.active, true);
});

test('取り消し済みなのに値が残っている壊れたデータは権利なし（fail closed）', () => {
  const g = resolvePromotionalGrants({
    [L.LIFETIME]: true,
    [L.GRANTED_AT]: iso(NOW - 10 * DAY),
    [L.REVOKED_AT]: iso(NOW - DAY),
  }, NOW);
  assert.equal(g.light.active, false);
  assert.equal(g.light.inconsistent, true);
  assert.equal(g.inconsistent, true);
});

test('取り消し後の再付与は有効（GrantedAt > RevokedAt）', () => {
  const g = resolvePromotionalGrants({
    [L.LIFETIME]: true,
    [L.REVOKED_AT]: iso(NOW - 10 * DAY),
    [L.GRANTED_AT]: iso(NOW - DAY),
  }, NOW);
  assert.equal(g.light.active, true);
  assert.equal(g.light.inconsistent, false);
});

// ═══ 付与（ティア × 期間の汎用モデル）════════════════════════════════

test('Light 永久無料', () => {
  const r = buildGrantFields({
    tier: PROMO_TIER.LIGHT, lifetime: true, fields: {}, now: NOW,
    operationId: OP, actor: 'MK', source: 'comeback-2026-07',
  });
  assert.equal(r.fields[L.LIFETIME], true);
  assert.equal(r.fields[L.UNTIL], '', '無期限なのに終了時刻を持っている');
  assert.equal(r.fields[L.OP], OP);
  assert.equal(r.fields[PROMO_FIELDS.SOURCE], 'comeback-2026-07');
  assert.equal(assertOnlyGrantFields(r.fields), true);
  assert.equal(r.effect.untilMs, null);
});

test('任意日数の無料（30 / 90 / 365 / 任意）', () => {
  for (const days of [1, 30, 90, 365, MAX_GRANT_DAYS]) {
    const r = buildGrantFields({
      tier: PROMO_TIER.PREMIUM, durationDays: days, fields: {}, now: NOW, operationId: `${OP}-${days}`,
    });
    assert.equal(r.effect.untilMs, NOW + days * DAY, `${days}日が正しくない`);
    assert.equal(r.fields[P.UNTIL], iso(NOW + days * DAY));
    assert.equal(r.fields[P.LIFETIME], false);
  }
  assert.equal(computeGrantUntilMs(NOW, 30), NOW + 30 * DAY);
});

test('日数が不正なら組み立てない（fail closed）', () => {
  for (const bad of [0, -1, 1.5, NaN, undefined, MAX_GRANT_DAYS + 1, '30']) {
    assert.equal(
      buildGrantFields({ tier: PROMO_TIER.PREMIUM, durationDays: bad, fields: {}, now: NOW, operationId: OP }),
      null, `${bad} を受け付けてしまう`);
  }
});

test('未知のティア / operationId 欠落は null（丸めない）', () => {
  assert.equal(buildGrantFields({ tier: 'sanrenpuku', lifetime: true, fields: {}, now: NOW, operationId: OP }), null);
  assert.equal(buildGrantFields({ tier: PROMO_TIER.LIGHT, lifetime: true, fields: {}, now: NOW, operationId: '' }), null);
  assert.equal(buildGrantFields({ tier: PROMO_TIER.LIGHT, lifetime: true, fields: {}, now: 'x', operationId: OP }), null);
});

// ═══ 冪等性・強い方を採用 ════════════════════════════════════════════

test('同じ operationId の再実行は already_applied（二重付与しない）', () => {
  const first = buildGrantFields({ tier: PROMO_TIER.LIGHT, lifetime: true, fields: {}, now: NOW, operationId: OP });
  const second = buildGrantFields({
    tier: PROMO_TIER.LIGHT, lifetime: true, fields: { ...first.fields }, now: NOW + DAY, operationId: OP,
  });
  assert.equal(second.skipped, 'already_applied');
  assert.equal(second.fields, undefined);
});

test('弱い付与は既存の権利を縮めない（already_granted）', () => {
  const lifetimeFields = buildGrantFields({
    tier: PROMO_TIER.LIGHT, lifetime: true, fields: {}, now: NOW, operationId: OP,
  }).fields;
  // 無期限を持っている人へ 30 日を付けても上書きしない
  const weaker = buildGrantFields({
    tier: PROMO_TIER.LIGHT, durationDays: 30, fields: lifetimeFields, now: NOW, operationId: 'other-op',
  });
  assert.equal(weaker.skipped, 'already_granted');

  // 90 日を持っている人へ 30 日も上書きしない
  const d90 = buildGrantFields({
    tier: PROMO_TIER.PREMIUM, durationDays: 90, fields: {}, now: NOW, operationId: 'op-90',
  }).fields;
  assert.equal(buildGrantFields({
    tier: PROMO_TIER.PREMIUM, durationDays: 30, fields: d90, now: NOW, operationId: 'op-30',
  }).skipped, 'already_granted');
});

test('強い付与は上書きする（30日 → 無期限 / 30日 → 90日）', () => {
  const d30 = buildGrantFields({
    tier: PROMO_TIER.PREMIUM, durationDays: 30, fields: {}, now: NOW, operationId: 'op-30',
  }).fields;
  const toLifetime = buildGrantFields({
    tier: PROMO_TIER.PREMIUM, lifetime: true, fields: d30, now: NOW, operationId: 'op-inf',
  });
  assert.ok(toLifetime.fields, '無期限へ強化できない');
  assert.equal(toLifetime.effect.upgrade, true);

  const to90 = buildGrantFields({
    tier: PROMO_TIER.PREMIUM, durationDays: 90, fields: d30, now: NOW, operationId: 'op-90',
  });
  assert.ok(to90.fields, '期間の延長ができない');
});

test('isStrongerGrant の順序（無期限 > 長い期限 > 短い期限 > 権利なし）', () => {
  const none = { active: false };
  const d30 = { active: true, lifetime: false, untilMs: NOW + 30 * DAY };
  const d90 = { active: true, lifetime: false, untilMs: NOW + 90 * DAY };
  const inf = { active: true, lifetime: true, untilMs: null };
  assert.equal(isStrongerGrant(none, { lifetime: false, untilMs: NOW + DAY }), true);
  assert.equal(isStrongerGrant(d30, { lifetime: false, untilMs: NOW + 90 * DAY }), true);
  assert.equal(isStrongerGrant(d90, { lifetime: false, untilMs: NOW + 30 * DAY }), false);
  assert.equal(isStrongerGrant(d30, { lifetime: true, untilMs: null }), true);
  assert.equal(isStrongerGrant(inf, { lifetime: true, untilMs: null }), false);
  assert.equal(isStrongerGrant(inf, { lifetime: false, untilMs: NOW + 9999 * DAY }), false);
});

test('終了した権利は新しい operationId で再付与できる', () => {
  const expiredFields = {
    [P.UNTIL]: iso(NOW - DAY), [P.GRANTED_AT]: iso(NOW - 31 * DAY), [P.OP]: 'old-op',
  };
  const again = buildGrantFields({
    tier: PROMO_TIER.PREMIUM, durationDays: 30, fields: expiredFields, now: NOW, operationId: 'new-op',
  });
  assert.ok(again.fields, '終了後の再付与ができない');
  assert.equal(again.effect.untilMs, NOW + 30 * DAY);
});

// ═══ 取り消し ════════════════════════════════════════════════════════

test('取り消しは特典フィールドだけを書く', () => {
  const r = buildRevokeFields({
    tier: PROMO_TIER.LIGHT,
    fields: { [L.LIFETIME]: true, 'プラン': 'Premium', LifetimeSanrenpuku: true },
    now: NOW, actor: 'MK', reason: '誤付与',
  });
  assert.equal(r.fields[L.LIFETIME], false);
  assert.equal(r.fields[L.UNTIL], '');
  assert.ok(String(r.fields[L.REVOKE_REASON]).includes('誤付与'));
  assert.equal(assertOnlyGrantFields(r.fields), true);
  assert.equal('プラン' in r.fields, false);
  assert.equal('LifetimeSanrenpuku' in r.fields, false);
});

test('権利を持っていない相手の取り消しは not_granted（空 PATCH を投げない）', () => {
  assert.equal(buildRevokeFields({ tier: PROMO_TIER.LIGHT, fields: {}, now: NOW }).skipped, 'not_granted');
});

test('取り消し後に resolve すると権利が消えている（不整合にもならない）', () => {
  const granted = buildGrantFields({
    tier: PROMO_TIER.PREMIUM, durationDays: 30, fields: {}, now: NOW, operationId: OP,
  }).fields;
  const revoked = buildRevokeFields({
    tier: PROMO_TIER.PREMIUM, fields: granted, now: NOW + DAY, actor: 'MK',
  }).fields;
  const after = resolvePromotionalGrants({ ...granted, ...revoked }, NOW + 2 * DAY);
  assert.equal(after.premium.active, false);
  assert.equal(after.premium.inconsistent, false);
});

test('片方のティアの取り消しは他方に影響しない', () => {
  const both = {
    ...buildGrantFields({ tier: PROMO_TIER.LIGHT, lifetime: true, fields: {}, now: NOW, operationId: OP }).fields,
    ...buildGrantFields({ tier: PROMO_TIER.PREMIUM, durationDays: 30, fields: {}, now: NOW, operationId: OP }).fields,
  };
  const revokePremium = buildRevokeFields({ tier: PROMO_TIER.PREMIUM, fields: both, now: NOW + DAY }).fields;
  const after = resolvePromotionalGrants({ ...both, ...revokePremium }, NOW + 2 * DAY);
  assert.equal(after.premium.active, false);
  assert.equal(after.light.active, true, 'Light まで巻き添えで消えた');
});

test('describeGrantState は状態を人が読める形で返す', () => {
  assert.equal(describeGrantState(resolvePromotionalGrants({}, NOW)), '特典なし');
  const both = resolvePromotionalGrants({
    [L.LIFETIME]: true, [P.UNTIL]: iso(NOW + 10 * DAY),
  }, NOW);
  const t = describeGrantState(both);
  assert.match(t, /Premium 無料/);
  assert.match(t, /Light 永久無料/);
});
