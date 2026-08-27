/**
 * rolloutReadPlan.test.mjs — **読まなくてよい tick では読まない**ことを固定する
 *
 *   node --test src/lib/marketing/rolloutReadPlan.test.mjs
 *
 * ⚠️ ここで守りたいのは 2 つで、**両方**外せない:
 *   ① 読まない tick が増えること（Airtable の月間上限を焼かない）
 *   ② 読まなかったせいで**結論が変わらない**こと（送るべき人へ送り損ねない）
 * ②は「読まなかった事実がどんな値でも `tickRollout` の action が同じ」を
 *   総当たりで確かめる（下の「読み飛ばしても結論が変わらない」）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planTickReads, needsGrantPlan, needsSequenceRead, isSequenceDeferred,
  resolveSequenceDefer, clearSequenceDefer, countPendingHandoffs,
  isGrantPlanDeferred, describeCheapBlock,
  SEQUENCE_MAX_STALE_MS, GRANT_PLAN_MAX_STALE_MS, READ_SKIP,
} from './rolloutReadPlan.js';
import { readStageGates } from './rolloutGates.js';
import { normalizeRolloutState, ROLLOUT_STAGE } from './rolloutPlan.js';
import { tickRollout, TICK_ACTION } from './rolloutOrchestrator.js';

const NOW = Date.parse('2026-09-01T01:00:00Z');

/** 全工程が開いている env（本番では既定で閉じている） */
const OPEN = Object.freeze({
  MARKETING_ROLLOUT_ENABLED: 'true',
  COMEBACK_GRANT_FIELDS_READY: '1',
  COMEBACK_GRANT_ENABLED: 'true',
  LIGHT_TRIAL_AUTOGRANT_ENABLED: 'true',
  MARKETING_CAMPAIGN_ENABLED: 'true',
  MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true',
});

const RUNNING = {
  stage: ROLLOUT_STAGE.STEADY, alwaysArmed: true, dailyLimit: 100,
};

// ── ⓪ env と状態だけで終わる tick ──────────────────────────────

test('工程が全部閉じていれば、Airtable を 1 回も読まない', () => {
  const plan = planTickReads({ state: RUNNING, env: {}, nowMs: NOW });
  assert.equal(plan.skip.reason, READ_SKIP.ALL_GATES_CLOSED);
  assert.equal(plan.reads.jobs, false);
});

test('緊急停止（killed）は事実を読む前に返す', () => {
  const plan = planTickReads({ state: { ...RUNNING, killed: true }, env: OPEN, nowMs: NOW });
  assert.equal(plan.skip.reason, READ_SKIP.KILLED);
  assert.equal(plan.reads.jobs, false);
});

test('送信だけ開いていれば、ジョブ照会はする（積み残しを出すため）', () => {
  const env = { MARKETING_ROLLOUT_ENABLED: 'true', MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true' };
  const plan = planTickReads({ state: RUNNING, env, nowMs: NOW });
  assert.equal(plan.skip, null);
  assert.equal(plan.reads.jobs, true);
});

test('一時停止（paused）でも積み残しは流すので、読みを止めない', () => {
  const plan = planTickReads({
    state: { ...RUNNING, stage: ROLLOUT_STAGE.PAUSED }, env: OPEN, nowMs: NOW,
  });
  assert.equal(plan.skip, null, '停止中に queue 済みの送信まで止めてはいけない');
});

// ── ② 付与計画（重い）─────────────────────────────────────────

test('送信待ちがあるなら、付与計画は読まない', () => {
  const gates = readStageGates(OPEN);
  assert.equal(needsGrantPlan({ pendingJobs: 3, pendingHandoffs: 0, gates }), false);
});

test('引き継ぎが残っているなら、付与計画は読まない（状態だけで queue できる）', () => {
  const gates = readStageGates(OPEN);
  assert.equal(needsGrantPlan({ pendingJobs: 0, pendingHandoffs: 2, gates }), false);
});

test('送信待ちも引き継ぎも無ければ、付与計画を読む', () => {
  const gates = readStageGates(OPEN);
  assert.equal(needsGrantPlan({ pendingJobs: 0, pendingHandoffs: 0, gates }), true);
});

test('付与も queue も閉じていれば、付与計画は読まない', () => {
  const gates = readStageGates({
    MARKETING_ROLLOUT_ENABLED: 'true', MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true',
  });
  assert.equal(needsGrantPlan({ pendingJobs: 0, pendingHandoffs: 0, gates }), false);
});

test('ジョブ照会が失敗（null）なら、付与計画へ進まない（fail closed）', () => {
  const gates = readStageGates(OPEN);
  assert.equal(needsGrantPlan({ pendingJobs: null, pendingHandoffs: 0, gates }), false);
});

// ── 「今日はもう配れない」ときの間引き ───────────────────────────

const gates = readStageGates(OPEN);
const idle = (extra) => ({
  ...RUNNING, dayGrantedCount: 100, lastRunDay: '2026-09-01', grantPlanReadAtMs: NOW, ...extra,
});

test('今日の枠を使い切っていて手元も空なら、付与計画の読みを間引く', () => {
  const state = idle();
  assert.ok(describeCheapBlock({ state, nowMs: NOW }), '前提: 状態だけで配れないと分かる');
  assert.equal(isGrantPlanDeferred({ state, nowMs: NOW + 60_000 }), true);
  assert.equal(needsGrantPlan({
    pendingJobs: 0, pendingHandoffs: 0, gates, state, nowMs: NOW + 60_000,
  }), false);
});

test('間引きの上限を超えたら読み直す（救済を永久に止めない）', () => {
  const state = idle();
  assert.equal(isGrantPlanDeferred({ state, nowMs: NOW + GRANT_PLAN_MAX_STALE_MS - 1 }), true);
  assert.equal(isGrantPlanDeferred({ state, nowMs: NOW + GRANT_PLAN_MAX_STALE_MS }), false);
});

test('「配れるかもしれない」なら間引かない（武装していて枠が残っている）', () => {
  const state = { ...RUNNING, grantPlanReadAtMs: NOW };
  assert.equal(describeCheapBlock({ state, nowMs: NOW }), null);
  assert.equal(isGrantPlanDeferred({ state, nowMs: NOW + 60_000 }), false);
  assert.equal(needsGrantPlan({
    pendingJobs: 0, pendingHandoffs: 0, gates, state, nowMs: NOW + 60_000,
  }), true);
});

test('手元に仕事が残っていれば間引かない（送信待ち・見張り・引き継ぎ）', () => {
  for (const extra of [
    { pendingJobIds: ['mkt-x'] },
    { dispatchWatch: { 'mkt-x': 0 } },
    { pendingHandoffOps: ['op-1'] },
  ]) {
    assert.equal(
      isGrantPlanDeferred({ state: idle(extra), nowMs: NOW + 60_000 }), false,
      `手元に仕事があるのに間引いた: ${JSON.stringify(extra)}`,
    );
  }
});

test('読んだ記録が無ければ間引かない（既定は読む側へ倒す）', () => {
  assert.equal(isGrantPlanDeferred({ state: idle({ grantPlanReadAtMs: null }), nowMs: NOW }), false);
});

// ── ③ 進行読み（最重量）───────────────────────────────────────

const gatesOpen = readStageGates(OPEN);

test('送信待ちがあるなら、進行読みはしない', () => {
  assert.equal(needsSequenceRead({
    pendingJobs: 1, pendingHandoffs: 0, pendingQueue: 0, gates: gatesOpen, state: RUNNING, nowMs: NOW,
  }), false);
});

test('queue が閉じていれば、進行読みはしない（読んでも gate_closed_queue）', () => {
  const gates = readStageGates({
    MARKETING_ROLLOUT_ENABLED: 'true',
    COMEBACK_GRANT_FIELDS_READY: '1',
    COMEBACK_GRANT_ENABLED: 'true',
    LIGHT_TRIAL_AUTOGRANT_ENABLED: 'true',
    MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true',
  });
  assert.equal(needsSequenceRead({
    pendingJobs: 0, pendingHandoffs: 0, pendingQueue: 0, gates, state: RUNNING, nowMs: NOW,
  }), false);
});

test('queue 待ちが居る救済経路は、据え置きに関係なく必ず読む', () => {
  const state = { ...RUNNING, nextDueAtMs: NOW + 3 * 86400_000, sequenceReadAtMs: NOW };
  assert.equal(needsSequenceRead({
    pendingJobs: 0, pendingHandoffs: 0, pendingQueue: 4, gates: gatesOpen, state, nowMs: NOW,
  }), true, '誰を積むかは単一源から取り直す必要がある');
});

test('関所を読んでいない tick では、進行読みもしない', () => {
  assert.equal(needsSequenceRead({
    pendingJobs: 0, pendingHandoffs: 0, pendingQueue: null, gates: gatesOpen, state: RUNNING, nowMs: NOW,
  }), false);
});

test('期日より前なら据え置く。期日が来たら読む', () => {
  const state = { ...RUNNING, nextDueAtMs: NOW + 3600_000, sequenceReadAtMs: NOW };
  assert.equal(isSequenceDeferred(state, NOW + 60_000), true);
  assert.equal(isSequenceDeferred(state, NOW + 3600_000), false, '期日ちょうどは読む');
  assert.equal(needsSequenceRead({
    pendingJobs: 0, pendingHandoffs: 0, pendingQueue: 0, gates: gatesOpen, state, nowMs: NOW + 60_000,
  }), false);
});

test('期日が遠くても、据え置きの上限を超えたら読み直す', () => {
  const state = { ...RUNNING, nextDueAtMs: NOW + 30 * 86400_000, sequenceReadAtMs: NOW };
  assert.equal(isSequenceDeferred(state, NOW + SEQUENCE_MAX_STALE_MS - 1), true);
  assert.equal(isSequenceDeferred(state, NOW + SEQUENCE_MAX_STALE_MS), false);
});

test('据え置きの記録が無ければ読む（既定は読む側へ倒す）', () => {
  assert.equal(isSequenceDeferred(RUNNING, NOW), false);
  assert.equal(isSequenceDeferred({ ...RUNNING, nextDueAtMs: NOW + 1000 }, NOW), false,
    '読んだ時刻が無いのに据え置かない');
});

// ── 据え置きの決め方 ──────────────────────────────────────────

test('全フェーズを読んで、いま期日 0 人なら次の期日まで据え置く', () => {
  const at = new Date(NOW + 86400_000).toISOString();
  const r = resolveSequenceDefer({
    due: { phasesComplete: true, due: 0, nextScheduledAt: at }, nowMs: NOW,
  });
  assert.equal(r.nextDueAtMs, Date.parse(at));
  assert.equal(r.sequenceReadAtMs, NOW);
});

test('フェーズ読みを省いた tick は据え置かない（もう片方を知らない）', () => {
  const r = resolveSequenceDefer({
    due: { phasesComplete: false, due: 0, nextScheduledAt: new Date(NOW + 86400_000).toISOString() },
    nowMs: NOW,
  });
  assert.equal(r.nextDueAtMs, null);
});

test('いま期日の人が居るなら据え置かない', () => {
  const r = resolveSequenceDefer({
    due: { phasesComplete: true, due: 3, nextScheduledAt: new Date(NOW + 86400_000).toISOString() },
    nowMs: NOW,
  });
  assert.equal(r.nextDueAtMs, null);
});

test('進行読みに失敗（null）したら据え置かない', () => {
  assert.equal(resolveSequenceDefer({ due: null, nowMs: NOW }).nextDueAtMs, null);
});

test('積んだら据え置きを解く（次の期日が新しく生まれるため）', () => {
  const cleared = clearSequenceDefer({ ...RUNNING, nextDueAtMs: NOW + 999, sequenceReadAtMs: NOW });
  assert.equal(cleared.nextDueAtMs, null);
  assert.equal(cleared.sequenceReadAtMs, null);
});

test('据え置きは状態として往復する（Redis へ書いて読み直せる）', () => {
  const s = normalizeRolloutState({
    ...RUNNING, nextDueAtMs: 123456, sequenceReadAtMs: 123, grantPlanReadAtMs: 456,
  });
  assert.equal(s.nextDueAtMs, 123456);
  assert.equal(s.sequenceReadAtMs, 123);
  assert.equal(s.grantPlanReadAtMs, 456);
  assert.equal(normalizeRolloutState({}).nextDueAtMs, null);
});

test('引き継ぎの数は Airtable を読まずに分かる', () => {
  assert.equal(countPendingHandoffs({ ...RUNNING, pendingHandoffOps: ['a', 'b'] }), 2);
  assert.equal(countPendingHandoffs({ ...RUNNING, pendingHandoffOp: 'a', pendingHandoffOps: [] }), 1);
  assert.equal(countPendingHandoffs(RUNNING), 0);
});

// ── ②の本丸: 読み飛ばしても結論が変わらない ────────────────────

/**
 * 読まなかった事実に**どんな値**が入っていても `tickRollout` の action が同じであること。
 *
 * これが崩れたら「読まなかったせいで送るべき人へ送らなかった」が起きる。
 * 読み飛ばしの条件を将来ゆるめたときに、ここが真っ先に落ちる。
 */
const DOMAIN = [null, 0, 1, 7, 1000];

function actionFor(facts, state = RUNNING) {
  return tickRollout({
    state, nowMs: NOW, envEnabled: true, env: OPEN, facts,
  }).action;
}

test('【重要】送信待ちがある tick は、関所・候補・期日を何に変えても DISPATCH のまま', () => {
  for (const outstanding of DOMAIN) {
    for (const remaining of DOMAIN) {
      for (const step of DOMAIN) {
        for (const due of DOMAIN) {
          const action = actionFor({
            pendingJobs: 3,
            pendingHandoffs: 0,
            grantedPendingQueue: outstanding === null ? null : 0,
            outstandingStep1: outstanding,
            remainingCandidates: remaining,
            followUpStep: step,
            followUpDue: due,
          });
          assert.equal(action, TICK_ACTION.DISPATCH,
            `読み飛ばした事実で結論が変わった: outstanding=${outstanding} remaining=${remaining} step=${step} due=${due}`);
        }
      }
    }
  }
});

test('【重要】引き継ぎが残る tick は、関所・候補・期日を何に変えても QUEUE のまま', () => {
  for (const outstanding of DOMAIN) {
    for (const remaining of DOMAIN) {
      for (const due of DOMAIN) {
        const action = actionFor({
          pendingJobs: 0,
          pendingHandoffs: 2,
          grantedPendingQueue: outstanding,
          outstandingStep1: outstanding,
          remainingCandidates: remaining,
          followUpStep: 3,
          followUpDue: due,
        });
        assert.equal(action, TICK_ACTION.QUEUE,
          `読み飛ばした事実で結論が変わった: outstanding=${outstanding} remaining=${remaining} due=${due}`);
      }
    }
  }
});

test('【重要】期日を読み飛ばした tick は、付与へ進むか止まるだけ（勝手に送らない）', () => {
  // 期日が null（読み飛ばし）でも FOLLOW_UP にはならない
  for (const remaining of DOMAIN) {
    const action = actionFor({
      pendingJobs: 0, pendingHandoffs: 0,
      grantedPendingQueue: 0, outstandingStep1: 0,
      remainingCandidates: remaining,
      followUpStep: null, followUpDue: null,
    });
    assert.notEqual(action, TICK_ACTION.FOLLOW_UP, '読んでいない期日で送ろうとしている');
  }
});

test('【重要】関所が読めていない tick では、付与も queue もしない（fail closed）', () => {
  const action = actionFor({
    pendingJobs: 0, pendingHandoffs: 0,
    grantedPendingQueue: null, outstandingStep1: null,
    remainingCandidates: null,
    followUpStep: null, followUpDue: null,
  });
  assert.equal(action, TICK_ACTION.SKIP);
});
