/**
 * premiumPlusRelease.test.mjs — Premium Plus 段階公開ロジックの単体テスト
 *   node --test src/lib/premiumPlus/premiumPlusRelease.test.mjs
 *   （npm run test:premium-plus-media / check:safety に glob で自動包含）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PP_PHASE,
  PP_PHASE_START_DAY,
  PP_INTAKE,
  PP_CIRCUIT,
  PP_INTAKE_SCHEDULE,
  PP_RELEASE_COPY,
  SANRENPUKU_PAID_AT_FIELDS,
  jstParts,
  jstDayDiff,
  circuitForJst,
  toPaidAtMs,
  resolveSanrenpukuPaidAt,
  computePhase,
  computeIntakeStatus,
  resolvePremiumPlusRelease,
  intakeCopy,
} from './premiumPlusRelease.js';

/** JST の年月日時分 → ms epoch */
const jst = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi) - 9 * 60 * 60 * 1000;

// 2026-07-06 は月曜（平日 = 南関）、2026-07-11 は土曜（中央）
const MON = (h, mi) => jst(2026, 7, 6, h, mi);
const SAT = (h, mi) => jst(2026, 7, 11, h, mi);

// ROUTE A（三連複購入者）で販売資格 eligible が済んでいる状態を既定にする。
// eligibility を渡さない場合は review 扱い（fail closed）になることは別テストで固定する。
const release = (over = {}) => resolvePremiumPlusRelease({
  hasSanrenpuku: true,
  paidAtMs: jst(2026, 7, 1, 12, 0),
  eligibility: 'eligible',
  nowMs: MON(10, 0),
  ...over,
});

// ── JST ユーティリティ ────────────────────────────────────────────────
test('jstParts: UTC ではなく JST の暦日・時刻を返す', () => {
  // 2026-07-06 00:30 JST = 2026-07-05 15:30 UTC
  const p = jstParts(jst(2026, 7, 6, 0, 30));
  assert.equal(p.year, 2026);
  assert.equal(p.month, 7);
  assert.equal(p.day, 6);
  assert.equal(p.minutesOfDay, 30);
  assert.equal(p.dayOfWeek, 1); // 月曜
});

test('jstDayDiff: JST 暦日で数える（同日 0 / 翌日 1）', () => {
  assert.equal(jstDayDiff(jst(2026, 7, 1, 23, 59), jst(2026, 7, 1, 0, 0)), 0);
  assert.equal(jstDayDiff(jst(2026, 7, 1, 23, 59), jst(2026, 7, 2, 0, 0)), 1);
  assert.equal(jstDayDiff(jst(2026, 7, 1, 0, 0), jst(2026, 7, 11, 0, 0)), 10);
});

test('JST 境界: 購入 = JST 深夜 0:05 でも当日は 0 日目（UTC 基準で 1 日ズレない）', () => {
  const paid = jst(2026, 7, 1, 0, 5); // UTC では 6/30 15:05
  assert.equal(jstDayDiff(paid, jst(2026, 7, 1, 23, 59)), 0);
  assert.equal(computePhase({ paidAtMs: paid, nowMs: jst(2026, 7, 1, 23, 59) }), PP_PHASE.LOCKED);
});

test('circuitForJst: 土日 = 中央 / 平日 = 南関', () => {
  assert.equal(circuitForJst(SAT(10, 0)), PP_CIRCUIT.CHUO);
  assert.equal(circuitForJst(jst(2026, 7, 12, 10, 0)), PP_CIRCUIT.CHUO); // 日曜
  assert.equal(circuitForJst(MON(10, 0)), PP_CIRCUIT.NANKAN);
});

test('toPaidAtMs: YYYY-MM-DD は JST 0:00 として解釈する', () => {
  assert.equal(toPaidAtMs('2026-07-01'), jst(2026, 7, 1, 0, 0));
  assert.equal(toPaidAtMs('2026-07-01T12:00:00.000Z'), Date.parse('2026-07-01T12:00:00.000Z'));
  assert.equal(toPaidAtMs(''), null);
  assert.equal(toPaidAtMs(null), null);
  assert.equal(toPaidAtMs('not-a-date'), null);
  assert.equal(toPaidAtMs({}), null);
});

// ── 購入確定日時の解決 ────────────────────────────────────────────────
test('resolveSanrenpukuPaidAt: 会員別フィールドが最優先', () => {
  const r = resolveSanrenpukuPaidAt({
    fields: { SanrenpukuPaidAt: '2026-07-01' },
    fallbackAnchor: '2026-01-01',
  });
  assert.equal(r.source, 'field');
  assert.equal(r.paidAtMs, jst(2026, 7, 1, 0, 0));
});

test('resolveSanrenpukuPaidAt: 日本語フィールド名も読む', () => {
  const r = resolveSanrenpukuPaidAt({ fields: { '三連複購入日時': '2026-07-02' } });
  assert.equal(r.source, 'field');
  assert.equal(r.paidAtMs, jst(2026, 7, 2, 0, 0));
});

test('resolveSanrenpukuPaidAt: フィールド無しなら全体アンカーへフォールバック', () => {
  const r = resolveSanrenpukuPaidAt({ fields: {}, fallbackAnchor: '2026-07-01' });
  assert.equal(r.source, 'anchor');
  assert.equal(r.paidAtMs, jst(2026, 7, 1, 0, 0));
});

test('resolveSanrenpukuPaidAt: どちらも無ければ null（fail closed）', () => {
  assert.deepEqual(resolveSanrenpukuPaidAt({}), { paidAtMs: null, source: 'none' });
  assert.deepEqual(resolveSanrenpukuPaidAt({ fields: null, fallbackAnchor: '' }), { paidAtMs: null, source: 'none' });
  // PaidAt（馬単の入金確認日）は候補に入れない＝誤って読み込まない
  assert.equal(resolveSanrenpukuPaidAt({ fields: { PaidAt: '2020-01-01' } }).paidAtMs, null);
  assert.ok(!SANRENPUKU_PAID_AT_FIELDS.includes('PaidAt'));
});

// ── 権限（fail closed）──────────────────────────────────────────────
test('非 Sanrenpuku 会員 → Premium Plus 不可（すべて false）', () => {
  for (const v of [false, undefined, null, 'true', 1, {}]) {
    const r = resolvePremiumPlusRelease({ hasSanrenpuku: v, paidAtMs: jst(2026, 1, 1), nowMs: MON(10, 0) });
    assert.equal(r.allowed, false, `hasSanrenpuku=${String(v)}`);
    assert.equal(r.showTeaser, false);
    assert.equal(r.showProductPage, false);
    assert.equal(r.showPurchaseCta, false);
    assert.equal(r.purchaseEnabled, false);
    assert.equal(r.phase, PP_PHASE.LOCKED);
    assert.equal(r.intake, null);
  }
});

test('fail closed: 購入確定日時が不明・不正・未来なら PHASE 1', () => {
  for (const paidAtMs of [null, undefined, NaN, Infinity, 'x', MON(10, 0) + 5 * 24 * 3600 * 1000]) {
    const r = release({ paidAtMs });
    assert.equal(r.phase, PP_PHASE.LOCKED, `paidAtMs=${String(paidAtMs)}`);
    assert.equal(r.showTeaser, false);
    assert.equal(r.showProductPage, false);
    assert.equal(r.showPurchaseCta, false);
  }
});

test('fail closed: now が不正なら不可', () => {
  const r = resolvePremiumPlusRelease({ hasSanrenpuku: true, paidAtMs: jst(2026, 1, 1), nowMs: NaN });
  assert.equal(r.allowed, false);
});

// ── PHASE 1 / 2 / 3 / 4 ───────────────────────────────────────────────
test('PHASE 1: 三連複購入当日 → 購入 CTA なし・商品ページも出さない', () => {
  const paid = jst(2026, 7, 6, 12, 0);
  const r = release({ paidAtMs: paid, nowMs: jst(2026, 7, 6, 23, 0) });
  assert.equal(r.phase, PP_PHASE.LOCKED);
  assert.equal(r.daysSincePurchase, 0);
  assert.equal(r.showPurchaseCta, false);
  assert.equal(r.showProductPage, false);
  assert.equal(r.showTeaser, false);
});

test('PHASE 1: 購入翌日も販売訴求なし（告知も出さない）', () => {
  const paid = jst(2026, 7, 6, 12, 0);
  const r = release({ paidAtMs: paid, nowMs: jst(2026, 7, 7, 9, 0) });
  assert.equal(r.daysSincePurchase, 1);
  assert.equal(r.phase, PP_PHASE.LOCKED);
  assert.equal(r.showTeaser, false);
  assert.equal(r.showProductPage, false);
  assert.equal(r.showPurchaseCta, false);
});

test('PHASE 2: 告知のみ（商品ページ・購入 CTA は出さない）', () => {
  const paid = jst(2026, 7, 1, 12, 0);
  const now = jst(2026, 7, 1 + PP_PHASE_START_DAY.TEASER, 12, 0);
  const r = release({ paidAtMs: paid, nowMs: now });
  assert.equal(r.phase, PP_PHASE.TEASER);
  assert.equal(r.showTeaser, true);
  assert.equal(r.showProductPage, false);
  assert.equal(r.showPurchaseCta, false);
  assert.equal(r.purchaseEnabled, false);
  assert.equal(r.intake, null);
});

test('PHASE 3: 商品・実績を閲覧可 / 購入 CTA なし', () => {
  const paid = jst(2026, 7, 1, 12, 0);
  const now = jst(2026, 7, 1 + PP_PHASE_START_DAY.PREVIEW, 12, 0);
  const r = release({ paidAtMs: paid, nowMs: now });
  assert.equal(r.phase, PP_PHASE.PREVIEW);
  assert.equal(r.showProductPage, true);
  assert.equal(r.showPurchaseCta, false);
  assert.equal(r.purchaseEnabled, false);
  assert.equal(r.intake, null, 'PHASE 4 未満で受付ステータスを出さない');
});

test('PHASE 4: 購入 CTA あり（受付時間内）', () => {
  const paid = jst(2026, 7, 1, 12, 0);
  const now = jst(2026, 7, 1 + PP_PHASE_START_DAY.SALE, 10, 0);
  const r = release({ paidAtMs: paid, nowMs: now });
  assert.equal(r.phase, PP_PHASE.SALE);
  assert.equal(r.showProductPage, true);
  assert.equal(r.showPurchaseCta, true);
  assert.equal(r.purchaseEnabled, true);
  assert.ok([PP_INTAKE.OPEN, PP_INTAKE.CLOSING, PP_INTAKE.CLOSED].includes(r.intake));
});

test('phase は単調に進む（境界日で 1 段ずつ）', () => {
  const paid = jst(2026, 7, 1, 12, 0);
  const at = (day) => computePhase({ paidAtMs: paid, nowMs: jst(2026, 7, 1 + day, 12, 0) });
  assert.equal(at(PP_PHASE_START_DAY.TEASER - 1), PP_PHASE.LOCKED);
  assert.equal(at(PP_PHASE_START_DAY.TEASER), PP_PHASE.TEASER);
  assert.equal(at(PP_PHASE_START_DAY.PREVIEW - 1), PP_PHASE.TEASER);
  assert.equal(at(PP_PHASE_START_DAY.PREVIEW), PP_PHASE.PREVIEW);
  assert.equal(at(PP_PHASE_START_DAY.SALE - 1), PP_PHASE.PREVIEW);
  assert.equal(at(PP_PHASE_START_DAY.SALE), PP_PHASE.SALE);
  assert.equal(at(PP_PHASE_START_DAY.SALE + 365), PP_PHASE.SALE);
});

// ── 受付ステータス（OPEN / CLOSING / CLOSED）────────────────────────
test('OPEN: 12:29 まで受付中（毎日共通・開催区分に依存しない）', () => {
  assert.equal(computeIntakeStatus({ nowMs: MON(10, 0) }), PP_INTAKE.OPEN);
  assert.equal(computeIntakeStatus({ nowMs: SAT(10, 0) }), PP_INTAKE.OPEN, '土日でも同じ');
});

test('LIMITED: 12:30〜14:59 は残りわずか', () => {
  assert.equal(computeIntakeStatus({ nowMs: MON(12, 30) }), PP_INTAKE.LIMITED);
  assert.equal(computeIntakeStatus({ nowMs: SAT(14, 59) }), PP_INTAKE.LIMITED);
});

test('CLOSING: 15:00〜16:29 はまもなく受付終了', () => {
  assert.equal(computeIntakeStatus({ nowMs: MON(15, 0) }), PP_INTAKE.CLOSING);
  assert.equal(computeIntakeStatus({ nowMs: SAT(16, 29) }), PP_INTAKE.CLOSING);
});

test('CLOSED: 16:30 以降は翌日分の受付へ切り替わる', () => {
  assert.equal(computeIntakeStatus({ nowMs: MON(16, 30) }), PP_INTAKE.CLOSED);
  assert.equal(computeIntakeStatus({ nowMs: MON(23, 59) }), PP_INTAKE.CLOSED);
  assert.equal(computeIntakeStatus({ nowMs: SAT(19, 0) }), PP_INTAKE.CLOSED, '土日でも同じ');
});

test('開催区分（中央 / 南関）で受付時間が変わらない', () => {
  for (const [h, mi] of [[10, 0], [13, 0], [15, 30], [17, 0], [21, 0]]) {
    assert.equal(
      computeIntakeStatus({ nowMs: MON(h, mi) }),
      computeIntakeStatus({ nowMs: SAT(h, mi) }),
      `${h}:${mi} で平日と土日の判定が違う`
    );
  }
  // circuit を明示的に渡しても無視される（分岐は廃止済み）
  assert.equal(computeIntakeStatus({ nowMs: MON(19, 0), circuit: 'nankan' }), PP_INTAKE.CLOSED);
  assert.equal(computeIntakeStatus({ nowMs: MON(19, 0), circuit: 'chuo' }), PP_INTAKE.CLOSED);
});

test('JST 境界: 16:29 は CLOSED でない / 16:30 ちょうどで CLOSED', () => {
  assert.notEqual(computeIntakeStatus({ nowMs: MON(16, 29) }), PP_INTAKE.CLOSED);
  assert.equal(computeIntakeStatus({ nowMs: MON(16, 30) }), PP_INTAKE.CLOSED);
});

test('受付時刻が不正なら CLOSED（売らない側に倒す）', () => {
  assert.equal(computeIntakeStatus({ nowMs: NaN }), PP_INTAKE.CLOSED);
  assert.equal(computeIntakeStatus({ nowMs: undefined }), PP_INTAKE.CLOSED);
});

test('CLOSED（翌日分受付中）: 購入操作は可・商品と実績も閲覧可', () => {
  const paid = jst(2026, 7, 1, 12, 0);
  const saleDay = 1 + PP_PHASE_START_DAY.SALE;
  const now = jst(2026, 7, saleDay, 23, 0);    // 16:30 以降 = 締切後
  const r = release({ paidAtMs: paid, nowMs: now });
  assert.equal(r.phase, PP_PHASE.SALE);
  assert.equal(r.intake, PP_INTAKE.CLOSED);
  assert.equal(r.purchaseEnabled, true, 'CLOSED は翌日分の受付中なので購入可');
  assert.equal(r.showProductPage, true, 'CLOSED でも商品・実績は閲覧可（404 にしない）');
  assert.equal(r.showPurchaseCta, true, 'CTA は残り「翌日分 受付中」を出す');
});

// ── 文言（指定文章の完全維持）──────────────────────────────────────
test('指定文章がそのまま保持されている', () => {
  assert.equal(
    PP_RELEASE_COPY.teaser.body,
    '全レースを広く狙うのではなく、その日の全開催から『1鞍だけ』を選ぶ、新しい予想を準備しています。'
  );
  assert.equal(PP_RELEASE_COPY.preparing.title, 'Premium Plus の受付準備中です');
  assert.equal(PP_RELEASE_COPY.preparing.body, '受付開始時に、このページからお申し込みいただけます。');
  assert.equal(PP_RELEASE_COPY.intake.open.title, '本日のPremium Plus受付');
  assert.equal(PP_RELEASE_COPY.intake.open.status, '本日分 受付中');
  assert.equal(PP_RELEASE_COPY.intake.limited.status, '本日分 残りわずか');
  assert.equal(PP_RELEASE_COPY.intake.closing.title, '本日のPremium Plus受付');
  assert.equal(PP_RELEASE_COPY.intake.closing.status, '本日分 まもなく受付終了');
  // 2026-08-13〜: 締切後は「翌日分の受付」へ切り替わる
  assert.equal(PP_RELEASE_COPY.intake.closed.title, '翌日分のPremium Plus受付');
  assert.equal(PP_RELEASE_COPY.intake.closed.note,
    '本日分の受付は終了しました。いまお申し込みいただくと翌日分をお届けします。');
});

test('予告文言に金額が含まれない（PHASE 2 で価格を出さない）', () => {
  const teaser = JSON.stringify(PP_RELEASE_COPY.teaser);
  assert.doesNotMatch(teaser, /68,?000|98,?000|¥|円/);
});

test('intakeCopy: 状態に対応する文言を返す / それ以外は null', () => {
  assert.equal(intakeCopy(PP_INTAKE.OPEN), PP_RELEASE_COPY.intake.open);
  assert.equal(intakeCopy(PP_INTAKE.LIMITED), PP_RELEASE_COPY.intake.limited);
  assert.equal(intakeCopy(PP_INTAKE.CLOSING), PP_RELEASE_COPY.intake.closing);
  assert.equal(intakeCopy(PP_INTAKE.CLOSED), PP_RELEASE_COPY.intake.closed);
  assert.equal(intakeCopy(null), null);
  assert.equal(intakeCopy('open2'), null);
});
