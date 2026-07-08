/**
 * sanrenpukuCtaStage.test.mjs — 三連複 段階表示ロジックの単一源テスト
 *   node --test src/lib/sanrenpuku/sanrenpukuCtaStage.test.mjs
 *
 * 固定する仕様（4日目 CTA 解禁 / 初日完全非表示 / 排他性）:
 *   1日目=非表示 / 2日目=予告のみ / 3日目=予告＋結果(南関) or 予告のみ(JRA) / 4日目以降=CTA
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SRP_DAY_MS,
  SRP_STAGE,
  normalizePlanKey,
  isFunnelTarget,
  computeSanrenpukuStage,
  planSanrenpukuDisplay,
} from './sanrenpukuCtaStage.js';

const NOW = 1_700_000_000_000; // 固定基準時刻（Date.now は使わない）
// 「◯日目」の代表経過時刻（各バケットの中央付近）を firstSeen として生成
const firstSeenForDay = (day) => NOW - ((day - 1) * SRP_DAY_MS + SRP_DAY_MS / 2);

test('computeSanrenpukuStage: 日境界（1/2/3日）で段階が変わる', () => {
  assert.equal(computeSanrenpukuStage(0), SRP_STAGE.HIDDEN); // 初日 0
  assert.equal(computeSanrenpukuStage(SRP_DAY_MS - 1), SRP_STAGE.HIDDEN); // 1日目末
  assert.equal(computeSanrenpukuStage(SRP_DAY_MS), SRP_STAGE.TEASER); // 2日目頭
  assert.equal(computeSanrenpukuStage(2 * SRP_DAY_MS - 1), SRP_STAGE.TEASER); // 2日目末
  assert.equal(computeSanrenpukuStage(2 * SRP_DAY_MS), SRP_STAGE.TEASER_RESULT); // 3日目頭
  assert.equal(computeSanrenpukuStage(3 * SRP_DAY_MS - 1), SRP_STAGE.TEASER_RESULT); // 3日目末
  assert.equal(computeSanrenpukuStage(3 * SRP_DAY_MS), SRP_STAGE.CTA); // 4日目頭＝解禁
  assert.equal(computeSanrenpukuStage(30 * SRP_DAY_MS), SRP_STAGE.CTA); // 十分先も CTA
});

test('computeSanrenpukuStage: 負値・非数は安全に 1日目(HIDDEN)', () => {
  assert.equal(computeSanrenpukuStage(-1), SRP_STAGE.HIDDEN);
  assert.equal(computeSanrenpukuStage(NaN), SRP_STAGE.HIDDEN);
  assert.equal(computeSanrenpukuStage(Infinity), SRP_STAGE.HIDDEN);
  assert.equal(computeSanrenpukuStage('x'), SRP_STAGE.HIDDEN);
});

test('isFunnelTarget: 馬単 Premium のみ true。三連複保有・無料・未ログインは false', () => {
  assert.equal(isFunnelTarget('Premium'), true);
  assert.equal(isFunnelTarget('premium'), true);
  assert.equal(isFunnelTarget('Premium Predictions'), true);
  assert.equal(isFunnelTarget('Premium Sanrenpuku'), false); // 既に三連複保有
  assert.equal(isFunnelTarget('Premium Combo'), false);
  assert.equal(isFunnelTarget('Premium Full'), false);
  assert.equal(isFunnelTarget('Free'), false);
  assert.equal(isFunnelTarget('Standard'), false);
  assert.equal(isFunnelTarget(''), false);
  assert.equal(isFunnelTarget(null), false);
  assert.equal(isFunnelTarget(undefined), false);
});

test('normalizePlanKey: trim + 小文字', () => {
  assert.equal(normalizePlanKey('  Premium '), 'premium');
  assert.equal(normalizePlanKey(null), '');
});

// ---- planSanrenpukuDisplay: 南関（hasResultSection: true） ----

test('南関 1日目: 三連複関連は完全非表示', () => {
  const r = planSanrenpukuDisplay({ planRaw: 'Premium', firstSeen: firstSeenForDay(1), now: NOW, hasResultSection: true });
  assert.equal(r.isFunnelTarget, true);
  assert.equal(r.stage, SRP_STAGE.HIDDEN);
  assert.equal(r.teaser, 'none');
  assert.equal(r.showResult, false);
  assert.equal(r.showCta, false);
});

test('南関 2日目: 予告カード(day2)のみ・結果とCTAは出さない', () => {
  const r = planSanrenpukuDisplay({ planRaw: 'Premium', firstSeen: firstSeenForDay(2), now: NOW, hasResultSection: true });
  assert.equal(r.teaser, 'day2');
  assert.equal(r.showResult, false);
  assert.equal(r.showCta, false);
});

test('南関 3日目: 予告(day3)＋結果。通常CTAは出さない', () => {
  const r = planSanrenpukuDisplay({ planRaw: 'Premium', firstSeen: firstSeenForDay(3), now: NOW, hasResultSection: true });
  assert.equal(r.teaser, 'day3');
  assert.equal(r.showResult, true);
  assert.equal(r.showCta, false);
});

test('南関 4日目以降: CTA＋結果。予告は出さない（排他）', () => {
  const r = planSanrenpukuDisplay({ planRaw: 'Premium', firstSeen: firstSeenForDay(4), now: NOW, hasResultSection: true });
  assert.equal(r.teaser, 'none');
  assert.equal(r.showResult, true);
  assert.equal(r.showCta, true);
});

test('南関 4日目以降 dismissed: CTA は出さない。結果は出す', () => {
  const r = planSanrenpukuDisplay({ planRaw: 'Premium', dismissed: true, firstSeen: firstSeenForDay(4), now: NOW, hasResultSection: true });
  assert.equal(r.teaser, 'none');
  assert.equal(r.showResult, true);
  assert.equal(r.showCta, false);
});

// ---- planSanrenpukuDisplay: JRA（hasResultSection: false / 結果セクション新設しない） ----

test('JRA 2日目: 予告(day2)のみ', () => {
  const r = planSanrenpukuDisplay({ planRaw: 'Premium', firstSeen: firstSeenForDay(2), now: NOW, hasResultSection: false });
  assert.equal(r.teaser, 'day2');
  assert.equal(r.showResult, false);
  assert.equal(r.showCta, false);
});

test('JRA 3日目: 予告のみ(day2表記)・結果は出さない（結果セクション新設しない）', () => {
  const r = planSanrenpukuDisplay({ planRaw: 'Premium', firstSeen: firstSeenForDay(3), now: NOW, hasResultSection: false });
  assert.equal(r.teaser, 'day2'); // 結果を約束しない予告文言
  assert.equal(r.showResult, false);
  assert.equal(r.showCta, false);
});

test('JRA 4日目以降: CTA。結果は出さない', () => {
  const r = planSanrenpukuDisplay({ planRaw: 'Premium', firstSeen: firstSeenForDay(4), now: NOW, hasResultSection: false });
  assert.equal(r.teaser, 'none');
  assert.equal(r.showResult, false);
  assert.equal(r.showCta, true);
});

// ---- funnel 対象外は一切触らない ----

for (const plan of ['Premium Sanrenpuku', 'Premium Combo', 'Premium Full', 'Free', 'Standard', '', null]) {
  test(`funnel対象外(${plan}) は全て none/false（既存ゲートに委ねる）`, () => {
    const r = planSanrenpukuDisplay({ planRaw: plan, firstSeen: firstSeenForDay(4), now: NOW, hasResultSection: true });
    assert.equal(r.isFunnelTarget, false);
    assert.equal(r.teaser, 'none');
    assert.equal(r.showResult, false);
    assert.equal(r.showCta, false);
  });
}

test('排他性: teaser 表示中は showCta=false / showCta 中は teaser=none（全日 × 両ページ）', () => {
  for (const hasResultSection of [true, false]) {
    for (let day = 1; day <= 6; day++) {
      const r = planSanrenpukuDisplay({ planRaw: 'Premium', firstSeen: firstSeenForDay(day), now: NOW, hasResultSection });
      if (r.teaser !== 'none') assert.equal(r.showCta, false, `day${day} hasResult=${hasResultSection}: teaserとCTAが同時`);
      if (r.showCta) assert.equal(r.teaser, 'none', `day${day} hasResult=${hasResultSection}: CTAと予告が同時`);
    }
  }
});

test('firstSeen 未設定(0/欠落)は now 扱い＝1日目', () => {
  const r0 = planSanrenpukuDisplay({ planRaw: 'Premium', firstSeen: 0, now: NOW, hasResultSection: true });
  assert.equal(r0.stage, SRP_STAGE.HIDDEN);
  const rU = planSanrenpukuDisplay({ planRaw: 'Premium', now: NOW, hasResultSection: true });
  assert.equal(rU.stage, SRP_STAGE.HIDDEN);
});
