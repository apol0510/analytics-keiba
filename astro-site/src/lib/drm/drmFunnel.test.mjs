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
import { isSequenceCampaign } from '../marketing/campaignSequence.js';

/** その段が担当する campaign（育成 ＋ オファー） */
const stageCampaignIds = (s) => [
  ...(s.nurtureCampaignId ? [s.nurtureCampaignId] : []), ...(s.offerCampaignIds || []),
];
import { getSequenceSteps, resolveAutoStart } from '../marketing/campaignSequence.js';
import { campaignDeclaresRoutes } from './drmResponseInputs.js';
import {
  FUNNEL_STAGES, FUNNEL_STAGE, FUNNEL_GAP, AUTO_START, canBranch,
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
    for (const id of stageCampaignIds(s)) {
      const c = CAMPAIGNS.find((x) => x.campaignId === id);
      assert.ok(c, `${id} がカタログに無い`);
      if (!isSequenceCampaign(c)) continue;   // 単発は sequenceProgress を通らない
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
    for (const id of stageCampaignIds(s)) {
      const c = CAMPAIGNS.find((x) => x.campaignId === id);
      if (!isSequenceCampaign(c)) continue;
      const signals = resolvePurchaseStopSignals(c);
      assert.ok(s.goal.some((g) => signals.includes(g)),
        `${id}: 到達目標（${s.goal.join('/')}）のどれも停止条件に入っていない`);
    }
  }
});

test('【検査】宛先条件と停止条件が一致する宣言を欠けとして検出する', () => {
  // 合成: 宛先 Light なのに light で止める（＝ 2026-09-08 の形）
  const broken = { campaignId: 'campaign-discount-light', sequence: { maxSends: 2, steps: [{}, {}] }, stopOnPurchase: { signals: ['light'] } };
  const r = assessFunnelStage(FUNNEL_STAGES[1], [broken]);
  assert.ok(r.gaps.includes(FUNNEL_GAP.PURCHASE_STOP_BLOCKS_ENTRY), '入口を塞ぐ宣言を見逃している');
  assert.ok(r.gaps.includes(FUNNEL_GAP.PURCHASE_STOP_MISSES_GOAL), '到達目標の欠落を見逃している');
  assert.equal(r.ready, false);
});

// ══════════════════════════════════════════════════════════════════
//  ③ 実カタログに対する実装状況（**欠けを隠さない**）
// ══════════════════════════════════════════════════════════════════

test('【定義】全段に担当 campaign が宣言され、実在する', () => {
  for (const s of FUNNEL_STAGES) {
    assert.ok(stageCampaignIds(s).length > 0, `${s.stage}: 担当 campaign が無い`);
    for (const id of stageCampaignIds(s)) {
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
 * 2026-09-14: 3 段すべてに**分岐する育成**が揃った（宣言と実装の整合は達成）。
 *
 * ⚠️ ここから先は**コードでは埋められない**。完成条件は
 *    「**実 campaign で反応に応じて次の訴求が分岐すること**」を
 *    **実配信で確認**すること（`docs/spec.md`）。
 *    `declarationsReady === true` を「DRM 完成」と書かないこと。
 */
test('【ラチェット】3 段すべてに分岐する育成が宣言されている', () => {
  const f = assessFunnel(CAMPAIGNS);
  for (const s of f.stages) {
    assert.ok(s.nurtureCampaignId, `${s.stage}: 育成 campaign が外れている`);
    assert.deepEqual(s.gaps, [], `${s.stage}: 欠けが戻っている（${s.gaps.join(',')}）`);
  }
  assert.equal(f.declarationsReady, true, '宣言と実装の整合が崩れている');
});

test('【重要】育成はすべて「反応で分岐できる」構造を持つ', () => {
  for (const s of FUNNEL_STAGES) {
    const c = CAMPAIGNS.find((x) => x.campaignId === s.nurtureCampaignId);
    assert.ok(c, `${s.stage}: 育成 campaign が実在しない`);
    const b = canBranch(c);
    assert.equal(b.ok, true, `${s.stage}: 分岐できない（${b.reason}）`);
  }
});

test('【契約】通数そのものを要件にしていない（分岐可能性だけを見る）', () => {
  // 3 通でも宣言があれば分岐できる（「4 通以上」のような閾値を仕様にしない）
  const three = {
    campaignId: 'x',
    sequence: {
      maxSends: 3, steps: [{ stepNumber: 1 }, { stepNumber: 2 }, { stepNumber: 3 }],
      responseRoutes: [{ when: 'opened', step: 3 }],
    },
  };
  assert.equal(canBranch(three).ok, true, '通数の閾値で落としている');
  // 2 通は**構造的に**分岐できない（行き先が線形の次と必ず一致する）
  const two = {
    campaignId: 'y',
    sequence: {
      maxSends: 2, steps: [{ stepNumber: 1 }, { stepNumber: 2 }],
      responseRoutes: [{ when: 'opened', step: 2 }],
    },
  };
  assert.equal(canBranch(two).ok, false);
  assert.equal(canBranch(two).reason, 'branch_impossible');
});

test('【重要】入口の自動開始を要件にするのは入口の段だけ', () => {
  const entry = FUNNEL_STAGES.find((s) => s.stage === FUNNEL_STAGE.FREE_TO_PAID);
  assert.equal(entry.requiresAutoStart, true, '入口の段で自動開始が要件から外れている');
  for (const s of FUNNEL_STAGES.filter((x) => x.stage !== FUNNEL_STAGE.FREE_TO_PAID)) {
    assert.notEqual(s.requiresAutoStart, true,
      `${s.stage}: 後段に自動開始を要件として足している（新仕様を勝手に固定しない）`);
  }
});

test('【定義】入口の段の育成だけが自動開始を宣言する', () => {
  for (const s of FUNNEL_STAGES) {
    const c = CAMPAIGNS.find((x) => x.campaignId === s.nurtureCampaignId);
    if (!c) continue;
    const declared = Boolean(resolveAutoStart(c));
    assert.equal(declared, s.requiresAutoStart === true,
      `${s.stage}: 自動開始の宣言と要件が食い違っている`);
    assert.ok(campaignDeclaresRoutes(c), `${s.stage}: 反応別 routing が宣言されていない`);
  }
});

test('【安全】オファー（期間限定）を育成の代わりに数えない', () => {
  for (const s of FUNNEL_STAGES) {
    for (const id of s.offerCampaignIds || []) {
      assert.notEqual(id, s.nurtureCampaignId, `${s.stage}: 同じ campaign を両方に数えている`);
    }
  }
  // 合成: オファーしか無い段は ready にならない
  const offerOnly = { ...FUNNEL_STAGES[1], nurtureCampaignId: null };
  const r = assessFunnelStage(offerOnly, CAMPAIGNS);
  assert.ok(r.offerCampaignIds.length > 0);
  assert.equal(r.ready, false, 'オファーだけで ready になっている');
  assert.ok(r.gaps.includes(FUNNEL_GAP.NO_NURTURE_CAMPAIGN));
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
