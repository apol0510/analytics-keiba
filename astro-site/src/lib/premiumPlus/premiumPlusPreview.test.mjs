/**
 * premiumPlusPreview.test.mjs — 管理者専用「表示プレビュー」の検証
 *   node --test src/lib/premiumPlus/premiumPlusPreview.test.mjs
 *
 * 最重要:
 *   - 完全 read-only（書き込み用フィールドを一切組み立てない）
 *   - 判定は単一源（resolvePremiumPlusRelease）の結果と一致する
 *   - シミュレーションはプレビュー応答の中だけに閉じ、実データを書き換えない
 *   - PII（Email / 氏名）を含めない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PP_PREVIEW_TIMES,
  PP_PREVIEW_PHASES,
  resolvePreviewNowMs,
  normalizePreviewPhaseDays,
  buildPreviewSnapshot,
  describePreviewVisibility,
} from './premiumPlusPreview.js';
import {
  PP_PHASE,
  PP_INTAKE,
  PP_PHASE_START_DAY,
  resolvePremiumPlusRelease,
} from './premiumPlusRelease.js';
import { resolvePlusMemberFromFields } from './premiumPlusMember.js';

const DAY = 86400000;
const jst = (y, m, d, h, mi) => Date.UTC(y, m - 1, d, h, mi) - 9 * 60 * 60 * 1000;
const NOW = jst(2026, 8, 3, 10, 0); // 月曜 10:00 JST
const iso = (ms) => new Date(ms).toISOString();

/** ROUTE A・eligible・PHASE 4 到達済みの会員 */
const memberFields = (over = {}) => ({
  'Email': 'should-not-appear@example.com',
  '氏名': '出ないはずの氏名',
  'プラン': 'Premium', 'PlanType': 'Annual', 'Status': 'active', '有効期限': '2027-07-14',
  'LifetimeSanrenpuku': true,
  'PremiumPlusEligibility': 'eligible',
  'PremiumPlusEligibleAt': iso(NOW - PP_PHASE_START_DAY.SALE * DAY),
  'SanrenpukuPaidAt': iso(NOW - PP_PHASE_START_DAY.SALE * DAY),
  ...over,
});

const snap = (over = {}, opts = {}) => {
  const r = buildPreviewSnapshot({ fields: memberFields(over), nowMs: NOW, ...opts });
  assert.equal(r.ok, true, `プレビュー生成に失敗: ${r.reason}`);
  return r.preview;
};

// ── 単一源との一致 ────────────────────────────────────────────────
test('プレビュー結果が実ロジック（resolvePremiumPlusRelease）と一致する', () => {
  const fields = memberFields();
  const p = snap();
  const m = resolvePlusMemberFromFields(fields, { nowMs: NOW });
  const truth = resolvePremiumPlusRelease({ ...m, nowMs: NOW });
  for (const k of ['route', 'eligibility', 'releaseOverride', 'overrideApplied', 'phase',
    'intake', 'showTeaser', 'showProductPage', 'showPurchaseCta', 'purchaseEnabled']) {
    assert.deepEqual(p[k], truth[k], `${k} が実ロジックと一致しない`);
  }
});

test('override phase4 が正しく反映される', () => {
  const p = snap({ PremiumPlusReleaseOverride: 'phase4', PremiumPlusEligibleAt: iso(NOW), SanrenpukuPaidAt: iso(NOW) });
  assert.equal(p.releaseOverride, 'phase4');
  assert.equal(p.overrideApplied, true);
  assert.equal(p.phase, PP_PHASE.SALE);
  assert.equal(p.state, '即時販売');
});

test('review / blocked は override があっても非公開のまま反映される', () => {
  for (const e of ['review', 'blocked']) {
    const p = snap({ PremiumPlusEligibility: e, PremiumPlusReleaseOverride: 'phase4' });
    assert.equal(p.showProductPage, false, e);
    assert.equal(p.showPurchaseCta, false, e);
    assert.equal(p.productPageStatus, 404, e);
  }
});

// ── 時刻シミュレーション ─────────────────────────────────────────
test('時刻シミュレーション: 4 状態の境界がプレビューに出る', () => {
  const cases = [
    [12 * 60 + 29, PP_INTAKE.OPEN, '本日分 受付中', true],
    [12 * 60 + 30, PP_INTAKE.LIMITED, '本日分 残りわずか', true],
    [14 * 60 + 59, PP_INTAKE.LIMITED, '本日分 残りわずか', true],
    [15 * 60, PP_INTAKE.CLOSING, '本日分 まもなく受付終了', true],
    [16 * 60 + 29, PP_INTAKE.CLOSING, '本日分 まもなく受付終了', true],
    [16 * 60 + 30, PP_INTAKE.CLOSED, '本日分の受付は終了しました', false],
    [19 * 60, PP_INTAKE.CLOSED, '本日分の受付は終了しました', false],
  ];
  for (const [atMin, intake, label, buyable] of cases) {
    const p = snap({}, { atMin });
    assert.equal(p.intake, intake, `${atMin}`);
    assert.equal(p.intakeStatus, label, `${atMin}`);
    assert.equal(p.purchaseEnabled, buyable, `${atMin}`);
    assert.equal(p.simulated.isSimulatedTime, true);
  }
});

test('16:30 以降・翌日分を売れないときは購入不可（商品閲覧は可）', () => {
  const p = snap({}, { atMin: 16 * 60 + 30 });
  // 開催カレンダー未指定＝翌日分を売れない → 購入不可（fail closed）
  assert.equal(p.purchaseEnabled, false);
  assert.equal(p.showProductPage, true);
  assert.equal(p.canBrowseWhenClosed, true);
  assert.equal(p.productPageStatus, 200);
});

test('atMin 未指定なら現在時刻で解決する', () => {
  const p = snap();
  assert.equal(p.simulated.isSimulatedTime, false);
  assert.equal(p.evaluatedAtJst, '2026-08-03 10:00');
});

test('resolvePreviewNowMs: JST のその日の指定時刻を返す / 不正値は null', () => {
  assert.equal(resolvePreviewNowMs({ nowMs: NOW, atMin: 0 }), jst(2026, 8, 3, 0, 0));
  assert.equal(resolvePreviewNowMs({ nowMs: NOW, atMin: 1439 }), jst(2026, 8, 3, 23, 59));
  assert.equal(resolvePreviewNowMs({ nowMs: NOW }), NOW);
  for (const bad of [-1, 1440, 1.5, 'x', {}, NaN]) {
    assert.equal(resolvePreviewNowMs({ nowMs: NOW, atMin: bad }), null, String(bad));
  }
});

test('JST 深夜でも日付が繰り上がらない（UTC 基準にしない）', () => {
  const lateJst = jst(2026, 8, 3, 0, 30); // UTC では 8/2 15:30
  assert.equal(resolvePreviewNowMs({ nowMs: lateJst, atMin: 16 * 60 + 30 }), jst(2026, 8, 3, 16, 30));
});

test('不正なシミュレーション値は拒否する（fail closed）', () => {
  assert.deepEqual(buildPreviewSnapshot({ fields: memberFields(), nowMs: NOW, atMin: 9999 }), { ok: false, reason: 'invalid_at_min' });
  assert.deepEqual(buildPreviewSnapshot({ fields: memberFields(), nowMs: NOW, phaseDaysAgo: -5 }), { ok: false, reason: 'invalid_phase_days' });
  assert.equal(normalizePreviewPhaseDays('abc'), undefined);
  assert.equal(normalizePreviewPhaseDays(null), null);
  assert.equal(normalizePreviewPhaseDays(3), 3);
});

// ── PHASE シミュレーション ───────────────────────────────────────
test('PHASE シミュレーション: 1/2/3/4 の表示を確認できる', () => {
  const expect = [[0, PP_PHASE.LOCKED], [PP_PHASE_START_DAY.TEASER, PP_PHASE.TEASER],
    [PP_PHASE_START_DAY.PREVIEW, PP_PHASE.PREVIEW], [PP_PHASE_START_DAY.SALE, PP_PHASE.SALE]];
  for (const [daysAgo, phase] of expect) {
    const p = snap({}, { phaseDaysAgo: daysAgo });
    assert.equal(p.phase, phase, `daysAgo=${daysAgo}`);
    assert.equal(p.simulated.phaseDaysAgo, daysAgo);
  }
});

test('PHASE シミュレーションは route を変えない（ROUTE B の 30 日判定に触れない）', () => {
  const routeB = {
    'プラン': 'Premium', 'PlanType': 'Annual', 'Status': 'active', '有効期限': '2027-07-14',
    'PaidAt': iso(NOW - 40 * DAY),
    'PremiumPlusEligibility': 'eligible',
    'PremiumPlusEligibleAt': iso(NOW - 40 * DAY),
  };
  const base = buildPreviewSnapshot({ fields: routeB, nowMs: NOW }).preview;
  assert.equal(base.route, 'premium_30d');
  for (const daysAgo of [0, 3, 6, 10]) {
    const p = buildPreviewSnapshot({ fields: routeB, nowMs: NOW, phaseDaysAgo: daysAgo }).preview;
    assert.equal(p.route, 'premium_30d', `daysAgo=${daysAgo} で route が変わった`);
    assert.equal(p.daysSincePremium, 40, 'Premium 加入経過日数を書き換えていない');
  }
});

test('PHASE シミュレーションは eligibility / override を書き換えない', () => {
  const p = snap({ PremiumPlusReleaseOverride: 'phase4' }, { phaseDaysAgo: 0 });
  assert.equal(p.eligibility, 'eligible');
  assert.equal(p.releaseOverride, 'phase4');
});

// ── read-only / PII ──────────────────────────────────────────────
test('プレビュー結果に PII（Email / 氏名）を含めない', () => {
  const json = JSON.stringify(snap());
  assert.doesNotMatch(json, /should-not-appear@example\.com/);
  assert.doesNotMatch(json, /出ないはずの氏名/);
  assert.doesNotMatch(json, /Email|氏名|Phone/);
});

test('プレビューは書き込み用フィールドを一切返さない（read-only）', () => {
  const json = JSON.stringify(snap());
  for (const f of ['プラン', 'PlanType', 'Status', '有効期限', 'PaidAt', 'LifetimeSanrenpuku',
    'PaymentEmailSent', 'PaymentEmailStatus', 'PaymentConfirmed', 'RequestedPlan']) {
    assert.doesNotMatch(json, new RegExp(`"${f}"`), `${f} を返している`);
  }
});

test('入力の fields オブジェクトを変更しない（副作用なし）', () => {
  const fields = memberFields();
  const before = JSON.stringify(fields);
  buildPreviewSnapshot({ fields, nowMs: NOW, atMin: 16 * 60 + 30, phaseDaysAgo: 0 });
  assert.equal(JSON.stringify(fields), before, 'fields が書き換えられた');
});

test('シミュレーションは実データの解決結果に影響しない（同一入力で再現）', () => {
  const fields = memberFields();
  const real1 = buildPreviewSnapshot({ fields, nowMs: NOW }).preview;
  buildPreviewSnapshot({ fields, nowMs: NOW, atMin: 19 * 60, phaseDaysAgo: 0 }); // シミュレーション実行
  const real2 = buildPreviewSnapshot({ fields, nowMs: NOW }).preview;
  assert.deepEqual(real1, real2, 'シミュレーション後に実データ解決がずれた');
});

// ── 表示説明 / 選択肢 ────────────────────────────────────────────
test('describePreviewVisibility: 状態ごとに説明が変わる', () => {
  assert.match(describePreviewVisibility(snap({ PremiumPlusEligibility: 'review' })), /404/);
  assert.match(describePreviewVisibility(snap({}, { phaseDaysAgo: PP_PHASE_START_DAY.PREVIEW })), /価格・購入 CTA は非表示/);
  assert.match(describePreviewVisibility(snap({}, { atMin: 10 * 60 })), /申し込み操作ができます/);
  assert.match(describePreviewVisibility(snap({}, { atMin: 19 * 60 })), /操作できません/);
});

test('時刻候補に必須の 8 パターンが揃っている', () => {
  const labels = PP_PREVIEW_TIMES.map((t) => t.label);
  for (const l of ['現在時刻', '12:29', '12:30', '14:59', '15:00', '16:29', '16:30', '19:00']) {
    assert.ok(labels.includes(l), `候補が無い: ${l}`);
  }
  assert.equal(PP_PREVIEW_PHASES.length, 5); // 実データ + PHASE 1〜4
});
