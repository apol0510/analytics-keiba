/**
 * premiumPlusIntake.test.mjs — PHASE 4 受付時間・表示（2026-07-30 確定仕様）の境界テスト
 *   node --test src/lib/premiumPlus/premiumPlusIntake.test.mjs
 *
 * 確定仕様（JST・毎日共通。開催区分による分岐は廃止）:
 *   00:00〜12:29  本日分 受付中             購入可
 *   12:30〜14:59  本日分 残りわずか          購入可
 *   15:00〜16:29  本日分 まもなく受付終了     購入可
 *   16:30〜23:59  本日分の受付は終了しました  購入不可
 *
 * ⚠️「残りわずか」は時刻のみで決まる。件数・在庫・販売上限とは連動させない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PP_PHASE,
  PP_PHASE_START_DAY,
  PP_INTAKE,
  PP_INTAKE_SCHEDULE,
  PP_ELIGIBILITY,
  PP_RELEASE_COPY,
  computeIntakeStatus,
  intakeCopy,
  resolvePremiumPlusRelease,
} from './premiumPlusRelease.js';

const DAY = 86400000;
/** JST の年月日時分 → ms epoch */
const jst = (y, m, d, h, mi) => Date.UTC(y, m - 1, d, h, mi) - 9 * 60 * 60 * 1000;

// 2026-08-03(月/平日) と 2026-08-08(土/休日) の両方で同じ結果になることを確認する
const WEEKDAY = (h, mi) => jst(2026, 8, 3, h, mi);
const WEEKEND = (h, mi) => jst(2026, 8, 8, h, mi);

/** 通常の PHASE 4（override なし・SALE 日数到達済み） */
const normalSale = (nowMs) => resolvePremiumPlusRelease({
  hasSanrenpuku: true,
  sanrenpukuPaidAtMs: nowMs - PP_PHASE_START_DAY.SALE * DAY,
  eligibleAtMs: nowMs - PP_PHASE_START_DAY.SALE * DAY,
  eligibility: PP_ELIGIBILITY.ELIGIBLE,
  nowMs,
});

/** override による即時 PHASE 4（購入当日） */
const overrideSale = (nowMs) => resolvePremiumPlusRelease({
  hasSanrenpuku: true,
  sanrenpukuPaidAtMs: nowMs,
  eligibleAtMs: nowMs,
  eligibility: PP_ELIGIBILITY.ELIGIBLE,
  releaseOverride: 'phase4',
  nowMs,
});

/** 期待表 [時, 分, 期待ステータス, 期待表示文言, 購入可否] */
const CASES = [
  [0, 0, PP_INTAKE.OPEN, '本日分 受付中', true],
  [12, 29, PP_INTAKE.OPEN, '本日分 受付中', true],
  [12, 30, PP_INTAKE.LIMITED, '本日分 残りわずか', true],
  [14, 59, PP_INTAKE.LIMITED, '本日分 残りわずか', true],
  [15, 0, PP_INTAKE.CLOSING, '本日分 まもなく受付終了', true],
  [16, 29, PP_INTAKE.CLOSING, '本日分 まもなく受付終了', true],
  [16, 30, PP_INTAKE.CLOSED, '本日分の受付は終了しました', false],
  [19, 0, PP_INTAKE.CLOSED, '本日分の受付は終了しました', false],
  [23, 59, PP_INTAKE.CLOSED, '本日分の受付は終了しました', false],
];

// ── 境界（必須ケース）────────────────────────────────────────────
for (const [h, mi, status, label, buyable] of CASES) {
  const hhmm = `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;

  test(`${hhmm} → ${label} / purchaseEnabled=${buyable}`, () => {
    const nowMs = WEEKDAY(h, mi);
    assert.equal(computeIntakeStatus({ nowMs }), status);
    assert.equal(intakeCopy(status).status, label);

    // 通常 PHASE 4 と override による即時 PHASE 4 の両方で同じ結果になること
    for (const [name, r] of [['通常 PHASE 4', normalSale(nowMs)], ['override 即時 PHASE 4', overrideSale(nowMs)]]) {
      assert.equal(r.phase, PP_PHASE.SALE, name);
      assert.equal(r.intake, status, `${name}: intake`);
      assert.equal(r.purchaseEnabled, buyable, `${name}: purchaseEnabled`);
      // CLOSED でも商品・実績の閲覧は維持（404 にしない）
      assert.equal(r.showProductPage, true, `${name}: showProductPage`);
      assert.equal(r.showPurchaseCta, true, `${name}: 受付ブロック自体は表示`);
    }
  });

  test(`${hhmm} は曜日（中央/南関）で結果が変わらない`, () => {
    assert.equal(computeIntakeStatus({ nowMs: WEEKDAY(h, mi) }), computeIntakeStatus({ nowMs: WEEKEND(h, mi) }));
  });
}

test('翌日 00:00 → 本日分 受付中 に戻る（日付跨ぎ）', () => {
  const lastNight = WEEKDAY(23, 59);
  const nextMidnight = jst(2026, 8, 4, 0, 0);
  assert.equal(computeIntakeStatus({ nowMs: lastNight }), PP_INTAKE.CLOSED);
  assert.equal(computeIntakeStatus({ nowMs: nextMidnight }), PP_INTAKE.OPEN);
  assert.equal(nextMidnight - lastNight, 60000, '1 分後であること');
  assert.equal(normalSale(nextMidnight).purchaseEnabled, true);
});

test('JST 境界: UTC 基準ではなく JST の暦時刻で切り替わる', () => {
  // 07:29 UTC = 16:29 JST。UTC の時刻（07:29）で判定していれば OPEN になってしまう
  assert.equal(computeIntakeStatus({ nowMs: Date.UTC(2026, 7, 3, 7, 29) }), PP_INTAKE.CLOSING, 'UTC 時刻で判定している');
  assert.equal(computeIntakeStatus({ nowMs: Date.UTC(2026, 7, 3, 7, 30) }), PP_INTAKE.CLOSED, '07:30 UTC = 16:30 JST');
  assert.equal(computeIntakeStatus({ nowMs: WEEKDAY(16, 29) }), PP_INTAKE.CLOSING);
  assert.equal(computeIntakeStatus({ nowMs: WEEKDAY(16, 30) }), PP_INTAKE.CLOSED);
  // JST 深夜 0:00〜8:59 は UTC では前日。前日扱いにならないこと
  assert.equal(computeIntakeStatus({ nowMs: WEEKDAY(0, 5) }), PP_INTAKE.OPEN);
});

// ── PHASE 1〜3 には影響しない ────────────────────────────────────
test('PHASE 1〜3 では受付ステータスを出さない（時間帯に影響されない）', () => {
  for (const day of [0, PP_PHASE_START_DAY.TEASER, PP_PHASE_START_DAY.PREVIEW]) {
    for (const [h, mi] of [[10, 0], [13, 0], [16, 0], [18, 0]]) {
      const nowMs = WEEKDAY(h, mi);
      const r = resolvePremiumPlusRelease({
        hasSanrenpuku: true,
        sanrenpukuPaidAtMs: nowMs - day * DAY,
        eligibleAtMs: nowMs - day * DAY,
        eligibility: PP_ELIGIBILITY.ELIGIBLE,
        nowMs,
      });
      assert.notEqual(r.phase, PP_PHASE.SALE);
      assert.equal(r.intake, null, `day=${day} ${h}:${mi}`);
      assert.equal(r.purchaseEnabled, false);
    }
  }
});

// ── 仕様の不変条件 ──────────────────────────────────────────────
test('スケジュール定数が確定仕様どおり', () => {
  assert.equal(PP_INTAKE_SCHEDULE.limitedFromMin, 12 * 60 + 30);
  assert.equal(PP_INTAKE_SCHEDULE.closingFromMin, 15 * 60);
  assert.equal(PP_INTAKE_SCHEDULE.closedFromMin, 16 * 60 + 30);
  // 単一スケジュール（サーキット別の枝を持たない）
  assert.equal(PP_INTAKE_SCHEDULE.chuo, undefined);
  assert.equal(PP_INTAKE_SCHEDULE.nankan, undefined);
});

test('購入不可は CLOSED のときだけ', () => {
  for (const [h, mi, status, , buyable] of CASES) {
    assert.equal(buyable, status !== PP_INTAKE.CLOSED, `${h}:${mi}`);
  }
});

test('「残りわずか」に件数・在庫・上限を示唆する文言が無い', () => {
  const limited = JSON.stringify(PP_RELEASE_COPY.intake.limited);
  assert.doesNotMatch(limited, /残り\s*\d|あと\s*\d|在庫|限定|上限|枠|件|名様|完売|sold/i);
  assert.equal(PP_RELEASE_COPY.intake.limited.note, '', '在庫を示唆する注記を置かない');
});

test('受付時刻が不正なら CLOSED（売らない側へ倒す）', () => {
  for (const nowMs of [NaN, undefined, null, Infinity, 'x']) {
    assert.equal(computeIntakeStatus({ nowMs }), PP_INTAKE.CLOSED, String(nowMs));
  }
});

test('intakeCopy: 4 状態すべてに文言があり、未知値は null', () => {
  for (const s of [PP_INTAKE.OPEN, PP_INTAKE.LIMITED, PP_INTAKE.CLOSING, PP_INTAKE.CLOSED]) {
    const c = intakeCopy(s);
    assert.ok(c && typeof c.status === 'string' && c.status.length > 0, s);
  }
  assert.equal(intakeCopy(null), null);
  assert.equal(intakeCopy('limited2'), null);
});
