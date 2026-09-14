/**
 * drmFunnel.test.mjs — DRM の**事業目的（ファネル）**が宣言どおりか
 *   node --test src/lib/drm/drmFunnel.test.mjs
 *
 * ここが守るのは 2 つ:
 *   1. 段の定義そのものの健全さ（排他・順序・購入停止の整合）
 *   2. **実カタログ**に対する実装状況を、欠けたまま「出来ている」と言わないこと
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CAMPAIGNS } from '../marketing/campaignCatalog.js';
import { MK_CONTRACT, MK_PLAN } from '../marketing/customerMarketingAudience.js';
import { resolvePurchaseStopSignals, PURCHASE_SIGNAL } from '../marketing/sequencePurchaseStop.js';
import {
  FUNNEL_STAGES, FUNNEL_STAGE, FUNNEL_GAP, AUTO_START,
  resolveFunnelStage, getFunnelStage, assessFunnelStage, assessFunnel,
} from './drmFunnel.js';

// ══════════════════════════════════════════════════════════════════
//  ① 段の定義
// ══════════════════════════════════════════════════════════════════

test('【定義】段は 1 本道で、順序が 1 から連番', () => {
  const orders = FUNNEL_STAGES.map((s) => s.order);
  assert.deepEqual(orders, [1, 2, 3]);
  for (let i = 0; i < FUNNEL_STAGES.length - 1; i += 1) {
    assert.equal(FUNNEL_STAGES[i].nextStage, FUNNEL_STAGES[i + 1].stage, '段が繋がっていない');
  }
  assert.equal(FUNNEL_STAGES.at(-1).nextStage, FUNNEL_STAGE.COMPLETED, '終点が三連複になっていない');
});

test('【重要】1 人は同時に 1 段にしか居ない（排他）', () => {
  const people = [
    [{ plan: MK_PLAN.FREE, contract: MK_CONTRACT.NONE }, FUNNEL_STAGE.FREE_TO_PAID],
    [{ plan: MK_PLAN.PREMIUM, contract: MK_CONTRACT.EXPIRED }, FUNNEL_STAGE.FREE_TO_PAID],
    [{ plan: MK_PLAN.LIGHT, contract: MK_CONTRACT.ACTIVE }, FUNNEL_STAGE.LIGHT_TO_PREMIUM],
    [{ plan: MK_PLAN.LIGHT, contract: MK_CONTRACT.EXPIRING_SOON }, FUNNEL_STAGE.LIGHT_TO_PREMIUM],
    [{ plan: MK_PLAN.PREMIUM, contract: MK_CONTRACT.ACTIVE }, FUNNEL_STAGE.PREMIUM_TO_SANRENPUKU],
    [{ plan: MK_PLAN.PREMIUM_SANRENPUKU, contract: MK_CONTRACT.ACTIVE }, FUNNEL_STAGE.COMPLETED],
    [{ plan: MK_PLAN.PREMIUM, contract: MK_CONTRACT.ACTIVE, hasSanrenpuku: true }, FUNNEL_STAGE.COMPLETED],
  ];
  for (const [m, expected] of people) {
    assert.equal(resolveFunnelStage(m), expected, `${JSON.stringify(m)} の段が違う`);
  }
});

test('【安全】判定できない人をどこかの段へ押し込まない', () => {
  assert.equal(resolveFunnelStage({ plan: MK_PLAN.PREMIUM, contract: MK_CONTRACT.UNKNOWN }), null);
  assert.equal(resolveFunnelStage(null), null);
  assert.equal(resolveFunnelStage({}), null);
});

test('【安全】三連複保有者は終点（もう売らない）', () => {
  const stage = resolveFunnelStage({ plan: MK_PLAN.PREMIUM, contract: MK_CONTRACT.ACTIVE, hasSanrenpuku: true });
  assert.equal(stage, FUNNEL_STAGE.COMPLETED);
  assert.equal(getFunnelStage(stage), null, '終点に販促の宣言がある');
});

// ══════════════════════════════════════════════════════════════════
//  ② 購入停止の整合（2026-09-08 障害の再発防止）
// ══════════════════════════════════════════════════════════════════

test('【最重要】入口のプランを購入停止シグナルに入れていない（2 通目が出なくなる）', () => {
  for (const s of FUNNEL_STAGES) {
    for (const id of s.campaignIds) {
      const c = CAMPAIGNS.find((x) => x.campaignId === id);
      assert.ok(c, `${id} がカタログに無い`);
      const signals = resolvePurchaseStopSignals(c);
      if (s.entry.plans.includes(MK_PLAN.LIGHT)) {
        assert.equal(signals.includes(PURCHASE_SIGNAL.LIGHT), false,
          `${id}: 宛先が Light なのに light で停止する（1 通目直後に全員停止）`);
      }
      if (s.entry.plans.includes(MK_PLAN.PREMIUM)) {
        assert.equal(signals.includes(PURCHASE_SIGNAL.PREMIUM), false,
          `${id}: 宛先が Premium なのに premium で停止する`);
      }
    }
  }
});

test('【最重要】到達目標を買った人には送り続けない', () => {
  for (const s of FUNNEL_STAGES) {
    for (const id of s.campaignIds) {
      const c = CAMPAIGNS.find((x) => x.campaignId === id);
      const signals = resolvePurchaseStopSignals(c);
      assert.ok(s.goal.some((g) => signals.includes(g)),
        `${id}: 到達目標（${s.goal.join('/')}）のどれも停止条件に入っていない`);
    }
  }
});

test('【検査】宛先条件と停止条件が一致する宣言を欠けとして検出する', () => {
  // 合成: 宛先 Light なのに light で止める（＝ 2026-09-08 の形）
  const broken = { campaignId: 'x', sequence: { maxSends: 2, steps: [{}, {}] }, stopOnPurchase: { signals: ['light'] } };
  const r = assessFunnelStage(FUNNEL_STAGES[1], [broken].map((c) => ({ ...c, campaignId: 'campaign-discount-light' })));
  assert.ok(r.gaps.includes(FUNNEL_GAP.PURCHASE_STOP_BLOCKS_ENTRY), '入口を塞ぐ宣言を見逃している');
  assert.ok(r.gaps.includes(FUNNEL_GAP.PURCHASE_STOP_MISSES_GOAL), '到達目標の欠落を見逃している');
  assert.equal(r.ready, false);
});

// ══════════════════════════════════════════════════════════════════
//  ③ 実カタログに対する実装状況（**欠けを隠さない**）
// ══════════════════════════════════════════════════════════════════

test('【定義】全段に担当 campaign が宣言され、実在する', () => {
  for (const s of FUNNEL_STAGES) {
    assert.ok(s.campaignIds.length > 0, `${s.stage}: 担当 campaign が無い`);
    for (const id of s.campaignIds) {
      assert.ok(CAMPAIGNS.some((c) => c.campaignId === id), `${s.stage}: ${id} が実在しない`);
    }
  }
});

test('【契約】ready は「欠けが 1 つも無い」と同義（緩めない）', () => {
  const f = assessFunnel(CAMPAIGNS);
  for (const s of f.stages) assert.equal(s.ready, s.gaps.length === 0);
  assert.equal(f.declarationsReady, f.blocking.length === 0);
});

/**
 * ⚠️ **ラチェット（現在地の固定）**
 *
 * 2026-09-14 時点で、3 段すべてに次の欠けがある:
 *   - `no_response_routes` … 反応別 routing を宣言していない（線形のまま）
 *   - `window_limited`     … キャンペーン期間中しか動かない
 *   - `no_auto_start`      … 入口で自動開始する経路が無い
 *
 * これが埋まったら、**先に `docs/spec.md` の完成条件と `docs/progress.md` の
 * 現在地を更新してから**このテストを書き換えること。
 * テストだけ通して「完成」にしない。
 */
test('【ラチェット】実運用の欠けが残っている限り ready と言わない', () => {
  const f = assessFunnel(CAMPAIGNS);
  assert.equal(f.declarationsReady, false,
    '欠けが埋まった可能性がある。spec.md の完成条件と progress.md を先に更新すること');
  for (const s of f.stages) {
    assert.ok(s.gaps.includes(FUNNEL_GAP.NO_AUTO_START),
      `${s.stage}: 自動開始が出来たなら spec.md / progress.md を更新すること`);
  }
});

test('【定義】自動開始の宣言は既知の種類だけ', () => {
  const known = new Set(Object.values(AUTO_START));
  for (const s of FUNNEL_STAGES) assert.ok(known.has(s.autoStart), `${s.stage}: 未知の autoStart`);
});

test('【表示】欠けには必ず人間向けの説明が付く', () => {
  const f = assessFunnel(CAMPAIGNS);
  for (const b of f.blocking) {
    assert.ok(typeof b.label === 'string' && b.label.length > 0, `${b.gap} の説明が無い`);
  }
});
