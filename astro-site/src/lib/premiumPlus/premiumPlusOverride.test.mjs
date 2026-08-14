/**
 * premiumPlusOverride.test.mjs — 「今すぐ販売可」（段階公開 override）の検証
 *   node --test src/lib/premiumPlus/premiumPlusOverride.test.mjs
 *
 * 最重要: override は eligibility の代替ではない。
 *   review / blocked / audience 不成立の会員が override だけで販売可能になってはいけない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PP_PHASE,
  PP_PHASE_START_DAY,
  PP_ELIGIBILITY,
  PP_ELIGIBILITY_FIELDS,
  PP_RELEASE_OVERRIDE,
  PP_ROUTE,
  PP_INTAKE,
  PP_INTAKE_SCHEDULE,
  normalizeReleaseOverride,
  describeReleaseState,
  resolvePremiumPlusRelease,
} from './premiumPlusRelease.js';
import { resolvePlusMemberFromFields } from './premiumPlusMember.js';
import {
  PP_ADMIN_ACTION,
  PP_WRITABLE_FIELDS,
  PP_FORBIDDEN_FIELDS,
  SANRENPUKU_PAID_AT_FIELD,
  buildAdminActionFields,
  assertOnlyPlusFields,
  isReleaseOverrideEnabled,
} from './premiumPlusEligibility.js';

const DAY = 86400000;
const jst = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi) - 9 * 60 * 60 * 1000;
const NOW = jst(2026, 8, 3, 10, 0); // 月曜 10:00 JST（南関 = 受付時間内）
const daysAgo = (n) => NOW - n * DAY;
const OVERRIDE_FIELD = PP_ELIGIBILITY_FIELDS.OVERRIDE;
const has = (f, k) => Object.prototype.hasOwnProperty.call(f, k);

/** ROUTE A・eligible・購入 1 日前（通常なら PHASE 1）のベース */
const base = (over = {}) => ({
  hasSanrenpuku: true,
  sanrenpukuPaidAtMs: daysAgo(1),
  eligibleAtMs: daysAgo(1),
  eligibility: PP_ELIGIBILITY.ELIGIBLE,
  nowMs: NOW,
  ...over,
});

// ── 正規化 ────────────────────────────────────────────────────────
test('normalizeReleaseOverride: phase4 のみ受理、それ以外は null（fail closed）', () => {
  assert.equal(normalizeReleaseOverride('phase4'), PP_RELEASE_OVERRIDE.PHASE4);
  assert.equal(normalizeReleaseOverride(' PHASE4 '), PP_RELEASE_OVERRIDE.PHASE4);
  for (const v of [undefined, null, '', 'true', '1', 'phase3', 'immediate', 'sale', {}, 4]) {
    assert.equal(normalizeReleaseOverride(v), null, String(v));
  }
});

// ── phase 判定の優先順位 ─────────────────────────────────────────
test('eligible + override phase4 → PHASE 4（段階公開を飛ばす）', () => {
  const r = resolvePremiumPlusRelease(base({ releaseOverride: 'phase4' }));
  assert.equal(r.allowed, true);
  assert.equal(r.phase, PP_PHASE.SALE);
  assert.equal(r.overrideApplied, true);
  assert.equal(r.showProductPage, true);
  assert.equal(r.showPurchaseCta, true);
});

test('eligible + override なし → 通常の段階公開（PHASE 1）', () => {
  const r = resolvePremiumPlusRelease(base());
  assert.equal(r.phase, PP_PHASE.LOCKED);
  assert.equal(r.overrideApplied, false);
  assert.equal(r.showPurchaseCta, false);
});

test('review + override phase4 → 非公開（override だけでは売らせない）', () => {
  const r = resolvePremiumPlusRelease(base({ eligibility: PP_ELIGIBILITY.REVIEW, releaseOverride: 'phase4' }));
  assert.equal(r.allowed, false);
  assert.equal(r.phase, PP_PHASE.LOCKED);
  assert.equal(r.overrideApplied, false);
  assert.equal(r.showProductPage, false);
  assert.equal(r.showPurchaseCta, false);
  assert.equal(r.purchaseEnabled, false);
});

test('blocked + override phase4 → 非公開', () => {
  const r = resolvePremiumPlusRelease(base({ eligibility: PP_ELIGIBILITY.BLOCKED, releaseOverride: 'phase4' }));
  assert.equal(r.allowed, false);
  assert.equal(r.phase, PP_PHASE.LOCKED);
  assert.equal(r.overrideApplied, false);
  assert.equal(r.showPurchaseCta, false);
});

test('eligibility 未設定 + override phase4 → 非公開（fail closed）', () => {
  const r = resolvePremiumPlusRelease(base({ eligibility: undefined, releaseOverride: 'phase4' }));
  assert.equal(r.allowed, false);
  assert.equal(r.eligibility, PP_ELIGIBILITY.REVIEW);
  assert.equal(r.showPurchaseCta, false);
});

test('audience 不成立 + override phase4 → 非公開', () => {
  // 三連複なし / Premium 無効 → route none
  const r1 = resolvePremiumPlusRelease(base({ hasSanrenpuku: false, premiumActive: false, releaseOverride: 'phase4' }));
  assert.equal(r1.route, PP_ROUTE.NONE);
  assert.equal(r1.allowed, false);
  assert.equal(r1.phase, PP_PHASE.LOCKED);
  // Premium 有効だが 29 日（30 日未満）
  const r2 = resolvePremiumPlusRelease(base({
    hasSanrenpuku: false, premiumActive: true, premiumPaidAtMs: daysAgo(29), releaseOverride: 'phase4',
  }));
  assert.equal(r2.route, PP_ROUTE.NONE);
  assert.equal(r2.showPurchaseCta, false);
});

test('override 解除 → 通常の段階公開へ復帰（anchor は据え置き）', () => {
  const withOverride = resolvePremiumPlusRelease(base({ releaseOverride: 'phase4' }));
  assert.equal(withOverride.phase, PP_PHASE.SALE);
  const cleared = resolvePremiumPlusRelease(base({ releaseOverride: '' }));
  assert.equal(cleared.phase, PP_PHASE.LOCKED, '解除で通常判定に戻る');
  assert.equal(cleared.anchorMs, withOverride.anchorMs, 'anchor は変わらない');
});

test('override 解除後、日数が進んでいれば その時点の PHASE に戻る', () => {
  const r = resolvePremiumPlusRelease(base({
    sanrenpukuPaidAtMs: daysAgo(PP_PHASE_START_DAY.PREVIEW),
    eligibleAtMs: daysAgo(PP_PHASE_START_DAY.PREVIEW),
    releaseOverride: '',
  }));
  assert.equal(r.phase, PP_PHASE.PREVIEW);
});

test('ROUTE B でも override は同じ優先順位で効く', () => {
  const r = resolvePremiumPlusRelease({
    hasSanrenpuku: false, premiumActive: true, premiumPaidAtMs: daysAgo(31),
    eligibility: PP_ELIGIBILITY.ELIGIBLE, eligibleAtMs: daysAgo(0),
    releaseOverride: 'phase4', nowMs: NOW,
  });
  assert.equal(r.route, PP_ROUTE.PREMIUM_30D);
  assert.equal(r.phase, PP_PHASE.SALE);
  assert.equal(r.overrideApplied, true);
});

// ── 受付時間帯（OPEN/CLOSING/CLOSED）との整合 ───────────────────
test('override 経由の PHASE 4 でも受付時間帯ロジックが同じに適用される', () => {
  const at = (h, mi) => resolvePremiumPlusRelease(base({ releaseOverride: 'phase4', nowMs: jst(2026, 8, 3, h, mi) }));
  assert.equal(at(12, 29).intake, PP_INTAKE.OPEN);
  assert.equal(at(12, 29).purchaseEnabled, true);
  assert.equal(at(12, 30).intake, PP_INTAKE.LIMITED);
  assert.equal(at(12, 30).purchaseEnabled, true);
  assert.equal(at(15, 0).intake, PP_INTAKE.CLOSING);
  assert.equal(at(15, 0).purchaseEnabled, true);
  const closed = at(16, 30);
  assert.equal(closed.intake, PP_INTAKE.CLOSED);
  assert.equal(closed.purchaseEnabled, false, '翌日分を売れないのに購入できてしまっている');
  assert.equal(closed.showProductPage, true, 'CLOSED でも商品・実績は閲覧可');
  assert.equal(closed.phase, PP_PHASE.SALE);
});

test('16:30 以降に「今すぐ販売可」でも、翌日分を売れなければ購入不可', () => {
  const r = resolvePremiumPlusRelease(base({ releaseOverride: 'phase4', nowMs: jst(2026, 8, 3, 17, 0) }));
  assert.equal(r.overrideApplied, true);
  assert.equal(r.phase, PP_PHASE.SALE);
  assert.equal(r.purchaseEnabled, false);
});

// ── 管理画面の状態表示 ──────────────────────────────────────────
test('describeReleaseState: 日本語の状態表示', () => {
  assert.equal(describeReleaseState(resolvePremiumPlusRelease(base({ eligibility: PP_ELIGIBILITY.REVIEW }))), '保留');
  assert.equal(describeReleaseState(resolvePremiumPlusRelease(base({ eligibility: PP_ELIGIBILITY.BLOCKED }))), '販売対象外');
  assert.equal(describeReleaseState(resolvePremiumPlusRelease(base())), '段階公開中 PHASE 1');
  assert.equal(describeReleaseState(resolvePremiumPlusRelease(base({
    sanrenpukuPaidAtMs: daysAgo(PP_PHASE_START_DAY.TEASER), eligibleAtMs: daysAgo(PP_PHASE_START_DAY.TEASER),
  }))), '段階公開中 PHASE 2');
  assert.equal(describeReleaseState(resolvePremiumPlusRelease(base({
    sanrenpukuPaidAtMs: daysAgo(PP_PHASE_START_DAY.PREVIEW), eligibleAtMs: daysAgo(PP_PHASE_START_DAY.PREVIEW),
  }))), '段階公開中 PHASE 3');
  assert.equal(describeReleaseState(resolvePremiumPlusRelease(base({
    sanrenpukuPaidAtMs: daysAgo(PP_PHASE_START_DAY.SALE), eligibleAtMs: daysAgo(PP_PHASE_START_DAY.SALE),
  }))), '販売中 PHASE 4');
  assert.equal(describeReleaseState(resolvePremiumPlusRelease(base({ releaseOverride: 'phase4' }))), '即時販売');
});

// ── Airtable fields アダプタ ────────────────────────────────────
test('アダプタ: override フィールドを読む / 未作成なら override なし', () => {
  const f = {
    'プラン': 'Premium', 'Status': 'active', '有効期限': '2099-12-31', 'LifetimeSanrenpuku': true,
    'PremiumPlusEligibility': 'eligible',
    'PremiumPlusEligibleAt': new Date(daysAgo(1)).toISOString(),
  };
  const noOverride = resolvePlusMemberFromFields(f, { nowMs: NOW });
  assert.equal(noOverride.releaseOverride, null);
  assert.equal(resolvePremiumPlusRelease({ ...noOverride, nowMs: NOW }).phase, PP_PHASE.LOCKED);

  const withOverride = resolvePlusMemberFromFields({ ...f, [OVERRIDE_FIELD]: 'phase4' }, { nowMs: NOW });
  assert.equal(withOverride.releaseOverride, 'phase4');
  assert.equal(resolvePremiumPlusRelease({ ...withOverride, nowMs: NOW }).phase, PP_PHASE.SALE);
});

test('アダプタ: blocked + override フィールドありでも非公開', () => {
  const m = resolvePlusMemberFromFields({
    'プラン': 'Premium', 'Status': 'active', '有効期限': '2099-12-31', 'LifetimeSanrenpuku': true,
    'PremiumPlusEligibility': 'blocked', [OVERRIDE_FIELD]: 'phase4',
  }, { nowMs: NOW });
  const r = resolvePremiumPlusRelease({ ...m, nowMs: NOW });
  assert.equal(r.allowed, false);
  assert.equal(r.showPurchaseCta, false);
});

// ── 書き込みフィールド（4 操作）──────────────────────────────
const ACT = (over = {}) => buildAdminActionFields({
  action: PP_ADMIN_ACTION.IMMEDIATE, current: PP_ELIGIBILITY.REVIEW, currentOverride: '',
  now: new Date(NOW), overrideFieldEnabled: true, ...over,
});

test('schema 未準備: override フィールド無効なら「今すぐ販売可」を拒否（fail closed）', () => {
  assert.equal(ACT({ overrideFieldEnabled: false }), null);
  assert.equal(isReleaseOverrideEnabled({}), false);
  assert.equal(isReleaseOverrideEnabled({ PREMIUM_PLUS_OVERRIDE_READY: '1' }), false, 'FIELDS_READY も必要');
  assert.equal(isReleaseOverrideEnabled({ PREMIUM_PLUS_FIELDS_READY: '1' }), false);
  assert.equal(isReleaseOverrideEnabled({ PREMIUM_PLUS_FIELDS_READY: '1', PREMIUM_PLUS_OVERRIDE_READY: '1' }), true);
});

test('schema 未準備でも staged / review / blocked は実行できる（override は PATCH に含めない）', () => {
  for (const action of [PP_ADMIN_ACTION.STAGED, PP_ADMIN_ACTION.REVIEW, PP_ADMIN_ACTION.BLOCKED]) {
    const r = ACT({ action, overrideFieldEnabled: false });
    assert.ok(r, action);
    assert.equal(has(r.fields, OVERRIDE_FIELD), false, `${action}: 未作成フィールドを PATCH に含めている`);
  }
});

test('今すぐ販売可: eligible + override=phase4 を書く', () => {
  const r = ACT();
  assert.equal(r.next, PP_ELIGIBILITY.ELIGIBLE);
  assert.equal(r.override, PP_RELEASE_OVERRIDE.PHASE4);
  assert.equal(r.fields[OVERRIDE_FIELD], 'phase4');
  assert.equal(r.fields[PP_ELIGIBILITY_FIELDS.STATUS], 'eligible');
  assert.equal(r.eligibleAtUpdated, true, 'review → eligible なので anchor を打つ');
  assert.equal(assertOnlyPlusFields(r.fields), true);
});

test('段階公開で販売可: override を解除する', () => {
  const r = ACT({ action: PP_ADMIN_ACTION.STAGED, current: PP_ELIGIBILITY.ELIGIBLE, currentOverride: 'phase4' });
  assert.equal(r.override, null);
  assert.equal(r.fields[OVERRIDE_FIELD], PP_RELEASE_OVERRIDE.NONE);
  assert.equal(r.overrideChanged, true);
});

test('即時販売 → 段階公開: override だけ解除し EligibleAt を書き換えない', () => {
  const r = ACT({ action: PP_ADMIN_ACTION.STAGED, current: PP_ELIGIBILITY.ELIGIBLE, currentOverride: 'phase4' });
  assert.equal(has(r.fields, PP_ELIGIBILITY_FIELDS.ELIGIBLE_AT), false, 'EligibleAt を触っている');
  assert.equal(r.eligibleAtUpdated, false);
});

test('即時販売 → 保留 / 販売対象外: override を必ず解除する', () => {
  for (const action of [PP_ADMIN_ACTION.REVIEW, PP_ADMIN_ACTION.BLOCKED]) {
    const r = ACT({ action, current: PP_ELIGIBILITY.ELIGIBLE, currentOverride: 'phase4' });
    assert.equal(r.fields[OVERRIDE_FIELD], PP_RELEASE_OVERRIDE.NONE, `${action}: override が残ると再 eligible で即時販売が復活する`);
    assert.equal(has(r.fields, PP_ELIGIBILITY_FIELDS.ELIGIBLE_AT), false, `${action}: EligibleAt を触っている`);
  }
});

test('変化しない override は PATCH に含めない（無駄な書き込みをしない）', () => {
  const noChange = ACT({ action: PP_ADMIN_ACTION.STAGED, current: PP_ELIGIBILITY.ELIGIBLE, currentOverride: '' });
  assert.equal(has(noChange.fields, OVERRIDE_FIELD), false);
  assert.equal(noChange.overrideChanged, false);
  const same = ACT({ current: PP_ELIGIBILITY.ELIGIBLE, currentOverride: 'phase4' });
  assert.equal(has(same.fields, OVERRIDE_FIELD), false, 'phase4 → phase4 で書き直さない');
});

test('未知の操作は拒否（丸めない）', () => {
  for (const action of ['', null, undefined, 'eligible', 'phase4', 'sale', 'now', 1, {}]) {
    assert.equal(ACT({ action }), null, String(action));
  }
});

test('どの操作でも Plus 専用フィールド以外を書かない', () => {
  for (const action of Object.values(PP_ADMIN_ACTION)) {
    const r = ACT({ action, current: PP_ELIGIBILITY.ELIGIBLE, currentOverride: 'phase4' });
    assert.ok(r, action);
    assert.equal(assertOnlyPlusFields(r.fields), true, action);
    for (const f of PP_FORBIDDEN_FIELDS) assert.equal(has(r.fields, f), false, `${action}: ${f}`);
    // 購入日時は絶対に触らない（過去日への偽装をしない）
    assert.equal(has(r.fields, SANRENPUKU_PAID_AT_FIELD), false, `${action}: SanrenpukuPaidAt を書いている`);
  }
});

test('override フィールドは書込許可に含まれ、禁止フィールドとは交差しない', () => {
  assert.ok(PP_WRITABLE_FIELDS.includes(OVERRIDE_FIELD));
  for (const f of PP_FORBIDDEN_FIELDS) assert.ok(!PP_WRITABLE_FIELDS.includes(f), f);
});

test('EligibleAt を過去日へ偽装する経路が無い（builder は now しか書かない）', () => {
  const past = new Date(daysAgo(999));
  const r = ACT({ now: past });
  // now に渡した値がそのまま入るだけで、「今より過去へ遡らせる」ための専用入力は存在しない
  assert.equal(r.fields[PP_ELIGIBILITY_FIELDS.ELIGIBLE_AT], past.toISOString());
  assert.equal(Object.keys(r.fields).filter((k) => /paidat/i.test(k)).length, 0);
});
