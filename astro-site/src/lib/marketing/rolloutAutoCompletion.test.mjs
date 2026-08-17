/**
 * rolloutAutoCompletion.test.mjs — **人手なしで最後まで配り切る**運転を固定する
 *   node --test src/lib/marketing/rolloutAutoCompletion.test.mjs
 *
 * 完成条件（運用側の言葉）:
 *   - `dailyLimit=15000 / batchSize=500` で 約15,000 名を**同じ日に**配り切れる
 *   - 論理バッチ 500 名は付与側の上限で **200 + 200 + 100**
 *   - 1 バッチを配り切ってから queue → 送信 → 関所（`outstanding=0`）を確認して次へ
 *   - 候補が尽きたら **completed**（以後 cron が走っても付与 0）
 *   - 異常停止したら**翌日になっても勝手に再開しない**
 *   - cron の重複起動・再試行で**二重付与 0**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  planRolloutTick, applyRolloutRun, defaultRolloutState, resolveObservationWindow,
  resolveBatchRoom, dailyRoomToday, ROLLOUT_STAGE, ROLLOUT_BLOCK, jstDay,
} from './rolloutPlan.js';
import { tickRollout, settleTick, isRolloutComplete, TICK_ACTION } from './rolloutOrchestrator.js';
import { resolveOperationalState, OPERATIONAL_STATE } from './rolloutOperationalState.js';
import { GRANT_OPERATION_MAX, buildTrialOperationId } from '../comeback/lightTrialAutoGrant.js';
import { ROLLOUT_TARGET, describeTargetPlan } from './rolloutTarget.js';

const DAY_MS = 86400_000;
const NOW = Date.UTC(2026, 7, 18, 1, 0, 0);   // JST 2026-08-18 10:00
const DAY = jstDay(NOW);

/** 本番の想定設定（**正本は `rolloutTarget.js`**。ここで数値を書かない） */
const PROD = { dailyLimit: ROLLOUT_TARGET.dailyLimit, batchSize: ROLLOUT_TARGET.batchSize };

const running = (over = {}) => ({
  ...defaultRolloutState(),
  stage: ROLLOUT_STAGE.SCALE,
  ...PROD,
  // 一度の開始で走り続ける（毎日 armedFor を書き換えない）
  alwaysArmed: true,
  armedFor: null,
  ...over,
});

/** 全 env ゲートが開いている体 */
const ENV = {
  COMEBACK_GRANT_FIELDS_READY: '1',
  COMEBACK_GRANT_ENABLED: 'true',
  LIGHT_TRIAL_AUTOGRANT_ENABLED: 'true',
  MARKETING_CAMPAIGN_ENABLED: 'true',
  MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true',
  MARKETING_ROLLOUT_ENABLED: 'true',
};

/**
 * 本番の運転を模す。1 tick 1 段階で
 * 付与 → （バッチを配り切ったら）queue → 送信起動 → 台帳反映 と進む。
 */
function makeWorld({ cohort, state, nowMs = NOW }) {
  return {
    cohort,                 // まだ配っていない候補
    granted: 0,             // 付与できた累計
    queuedPending: 0,       // 付与済みだが queue していない人
    jobsPending: 0,         // queue 済みだが送信起動していないジョブ人数
    sent: 0,                // 送信済み（= Step1 が片付いた）
    grants: [],             // 付与 1 回ごとの人数
    ops: [],                // operationId
    state,
    nowMs,
    /** 関所（Step1 未処理）= 付与済みで送信まで終わっていない人 */
    get outstanding() { return this.queuedPending + this.jobsPending; },
    facts() {
      const observed = Math.min(
        resolveObservationWindow(this.state, this.nowMs, { perCallMax: GRANT_OPERATION_MAX }),
        this.cohort,
      );
      const more = this.cohort > observed;
      return {
        remainingCandidates: more ? Math.max(observed, 1) : observed,
        outstandingStep1: this.outstanding,
        // 送信待ちジョブがあるなら queue 対象は 0（本番の deriveFacts と同じ）
        grantedPendingQueue: this.jobsPending > 0 ? 0 : this.queuedPending,
        pendingJobs: this.jobsPending,
        followUpStep: null,
        followUpDue: null,
      };
    },
    /** 1 tick 進める。戻り値は実行した段階 */
    tick() {
      const facts = this.facts();
      if (isRolloutComplete({ facts }).done && this.state.stage !== ROLLOUT_STAGE.COMPLETED) {
        this.state = { ...this.state, stage: ROLLOUT_STAGE.COMPLETED, alwaysArmed: false };
        return 'completed';
      }
      const d = tickRollout({ state: this.state, nowMs: this.nowMs, envEnabled: true, facts, env: ENV });
      if (d.action === TICK_ACTION.GRANT) {
        const n = Math.min(d.count, this.cohort);
        this.cohort -= n;
        this.granted += n;
        this.queuedPending += n;
        this.grants.push(n);
        this.ops.push(buildTrialOperationId(this.nowMs, d.plan.batchSeq));
        this.state = settleTick({
          state: this.state, nowMs: this.nowMs, granted: n,
          batchSeq: d.plan.batchSeq, startsNewBatch: d.plan.startsNewBatch,
        });
        return 'grant';
      }
      if (d.action === TICK_ACTION.QUEUE) {
        this.jobsPending += this.queuedPending;
        this.queuedPending = 0;
        return 'queue';
      }
      if (d.action === TICK_ACTION.DISPATCH) {
        this.sent += this.jobsPending;
        this.jobsPending = 0;
        return 'dispatch';
      }
      return `skip:${d.reason}`;
    },
    run(maxTicks = 4000) {
      const seq = [];
      for (let i = 0; i < maxTicks; i += 1) {
        const step = this.tick();
        seq.push(step);
        if (step === 'completed') break;
        if (step.startsWith('skip:') && seq.filter((x) => x === step).length > 3) break;
      }
      return seq;
    },
  };
}

// ── 同日完走（これが完成条件）──────────────────────────────────

test('【重要】dailyLimit=15000 / batchSize=500 で 15,000 名を同じ日に配り切る', () => {
  const w = makeWorld({ cohort: ROLLOUT_TARGET.cohortApprox, state: running() });
  const seq = w.run();
  assert.equal(w.granted, ROLLOUT_TARGET.cohortApprox, `${w.granted} 名しか配れていない`);
  assert.equal(w.sent, 15_000, 'Step1 が全員に届いていない');
  assert.equal(w.cohort, 0);
  assert.equal(seq[seq.length - 1], 'completed', `終端に入っていない: ${seq[seq.length - 1]}`);
  assert.equal(w.state.stage, ROLLOUT_STAGE.COMPLETED);
  // 日付は 1 日のまま（`dayGrantedCount` が 15,000 まで積める）
  assert.equal(w.state.dayGrantedCount, 15_000);
});

test('【重要】1 論理バッチ 500 名は 200 + 200 + 100 の付与に分かれる', () => {
  const w = makeWorld({ cohort: 15_000, state: running() });
  w.run();
  assert.deepEqual(w.grants.slice(0, 3), [...ROLLOUT_TARGET.grantSplit], `最初のバッチが ${w.grants.slice(0, 3)}`);
  assert.deepEqual(w.grants.slice(3, 6), [...ROLLOUT_TARGET.grantSplit], '2 バッチ目が同じ形でない');
  const plan = describeTargetPlan();
  assert.equal(w.grants.length, plan.batches * plan.grantsPerBatch,
    `付与回数 ${w.grants.length}（${plan.batches} バッチ × ${plan.grantsPerBatch} 回のはず）`);
  assert.ok(w.grants.every((n) => n <= GRANT_OPERATION_MAX), '付与 1 回が上限を超えている');
  assert.equal(new Set(w.ops).size, w.ops.length, 'operationId が重複している');
});

test('【重要】1 バッチあたり 5 tick で進む（付与 3 + queue 1 + 送信 1）', () => {
  const w = makeWorld({ cohort: 15_000, state: running() });
  const seq = w.run();
  const first5 = seq.slice(0, 5);
  assert.deepEqual(first5, ['grant', 'grant', 'grant', 'queue', 'dispatch'], `順序が違う: ${first5}`);
  // 30 バッチ × 5 tick + 終端 1（数は正本 `rolloutTarget.js` から）
  const plan = describeTargetPlan();
  assert.ok(seq.length <= plan.ticks + 2, `${seq.length} tick かかっている（目安 ${plan.ticks}）`);
});

test('1000 名バッチでも配り切る（200 × 5 + queue + 送信）', () => {
  const w = makeWorld({ cohort: 15_000, state: running({ batchSize: 1000 }) });
  const seq = w.run();
  assert.equal(w.granted, 15_000);
  assert.deepEqual(w.grants.slice(0, 5), [200, 200, 200, 200, 200]);
  assert.deepEqual(seq.slice(0, 7), ['grant', 'grant', 'grant', 'grant', 'grant', 'queue', 'dispatch']);
});

test('最後の端数も配り切る（14,050 名）', () => {
  const w = makeWorld({ cohort: 14_050, state: running() });
  w.run();
  assert.equal(w.granted, 14_050);
  assert.equal(w.grants[w.grants.length - 1], 50, `端数が ${w.grants[w.grants.length - 1]}`);
  assert.equal(w.state.stage, ROLLOUT_STAGE.COMPLETED);
});

// ── 関所（送信が終わるまで次のバッチへ進まない）────────────────────

test('【重要】バッチを配り切ったら送信が終わるまで次の付与へ進まない', () => {
  const w = makeWorld({ cohort: 15_000, state: running() });
  w.tick(); w.tick(); w.tick();              // 200 + 200 + 100
  assert.equal(w.state.batchGrantedCount, 500);
  assert.equal(resolveBatchRoom(w.state), 0, 'バッチに空きが残っている');
  // 送信が終わる前に付与は起きない
  const facts = w.facts();
  const plan = planRolloutTick({
    state: w.state, nowMs: NOW, remainingCandidates: facts.remainingCandidates,
    previousOutstanding: facts.outstandingStep1, envEnabled: true,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, ROLLOUT_BLOCK.WAITING_PREVIOUS);
  // queue → 送信 が済むと次のバッチが始まる
  assert.equal(w.tick(), 'queue');
  assert.equal(w.tick(), 'dispatch');
  assert.equal(w.outstanding, 0);
  assert.equal(w.tick(), 'grant');
  assert.equal(w.state.batchGrantedCount, 200, '新しいバッチとして数え直していない');
});

test('【重要】未処理が「自分が配った数」を超えたら止まる（説明できない状態）', () => {
  const s = applyRolloutRun({ state: running(), nowMs: NOW, granted: 200, batchSeq: 1, startsNewBatch: true });
  const plan = planRolloutTick({
    state: s, nowMs: NOW, remainingCandidates: 14_000, previousOutstanding: 900, envEnabled: true,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, ROLLOUT_BLOCK.OUTSTANDING_MISMATCH);
});

test('【重要】翌日でも未処理が残っていれば新規付与 0', () => {
  const s = applyRolloutRun({ state: running(), nowMs: NOW, granted: 500, batchSeq: 3, startsNewBatch: true });
  const plan = planRolloutTick({
    state: s, nowMs: NOW + DAY_MS, remainingCandidates: 14_000, previousOutstanding: 500, envEnabled: true,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, ROLLOUT_BLOCK.WAITING_PREVIOUS);
});

// ── 日跨ぎの自動継続 ────────────────────────────────────────────

test('【重要】1 日で終わらなくても、翌日に人手なしで続きが進む', () => {
  // 1 日 2,000 名に絞った場合（段階運用）
  const w = makeWorld({ cohort: 5_000, state: running({ dailyLimit: 2_000 }) });
  w.run(200);
  assert.equal(w.state.dayGrantedCount, 2_000, '1 日上限を超えて配っている');
  const facts = w.facts();
  const plan = planRolloutTick({
    state: w.state, nowMs: NOW, remainingCandidates: facts.remainingCandidates,
    previousOutstanding: facts.outstandingStep1, envEnabled: true,
  });
  assert.equal(plan.reason, ROLLOUT_BLOCK.DAILY_LIMIT_REACHED);
  // 上限到達は**異常ではない**（人の操作を要求しない）
  const view = resolveOperationalState({ state: w.state, plan });
  assert.equal(view.state, OPERATIONAL_STATE.DAILY_LIMIT_REACHED);
  assert.equal(view.needsHuman, false, '毎日 resume を人に要求している');
  assert.equal(view.autoContinues, true);

  // 翌日: armedFor を書き換えなくても進む
  w.nowMs = NOW + DAY_MS;
  assert.equal(dailyRoomToday(w.state, w.nowMs), 2_000, '翌日の枠が戻っていない');
  assert.equal(w.tick(), 'grant');
  assert.equal(w.state.dayGrantedCount, 200, '翌日の集計が 0 から始まっていない');
});

test('【重要】alwaysArmed なら毎日 armedFor を書き換えなくてよい', () => {
  const s = applyRolloutRun({ state: running(), nowMs: NOW, granted: 200, batchSeq: 1, startsNewBatch: true });
  const tomorrow = planRolloutTick({
    state: s, nowMs: NOW + DAY_MS, remainingCandidates: 14_000, previousOutstanding: 0, envEnabled: true,
  });
  assert.equal(tomorrow.ok, true, `翌日に止まっている: ${tomorrow.reason}`);
  // one-shot（armedFor 指定）だと翌日は止まる＝毎日の手動操作が要る
  const oneShot = planRolloutTick({
    state: { ...s, alwaysArmed: false, armedFor: DAY }, nowMs: NOW + DAY_MS,
    remainingCandidates: 14_000, previousOutstanding: 0, envEnabled: true,
  });
  assert.equal(oneShot.ok, false);
  assert.equal(oneShot.reason, ROLLOUT_BLOCK.NOT_ARMED);
});

// ── 終端 ────────────────────────────────────────────────────────

test('【重要】候補が尽きたら completed（送信まで片付いてから）', () => {
  assert.equal(isRolloutComplete({ facts: { remainingCandidates: 0, outstandingStep1: 0, grantedPendingQueue: 0, pendingJobs: 0, followUpDue: 0 } }).done, true);
  // 途中で終わらせない
  assert.equal(isRolloutComplete({ facts: { remainingCandidates: 0, outstandingStep1: 200, grantedPendingQueue: 0, pendingJobs: 0 } }).done, false);
  assert.equal(isRolloutComplete({ facts: { remainingCandidates: 0, outstandingStep1: 0, grantedPendingQueue: 0, pendingJobs: 2 } }).done, false);
  assert.equal(isRolloutComplete({ facts: { remainingCandidates: 5, outstandingStep1: 0, grantedPendingQueue: 0, pendingJobs: 0 } }).done, false);
  // 数えられないなら終わらせない
  assert.equal(isRolloutComplete({ facts: { remainingCandidates: null, outstandingStep1: 0, grantedPendingQueue: 0, pendingJobs: 0 } }).done, false);
});

test('【重要】completed 後は cron が走っても付与 0（翌日も）', () => {
  const done = { ...running(), stage: ROLLOUT_STAGE.COMPLETED, alwaysArmed: false };
  for (const t of [NOW, NOW + DAY_MS, NOW + 30 * DAY_MS]) {
    const plan = planRolloutTick({
      state: done, nowMs: t, remainingCandidates: 9_999, previousOutstanding: 0, envEnabled: true,
    });
    assert.equal(plan.ok, false);
    assert.equal(plan.reason, ROLLOUT_BLOCK.COMPLETED);
    assert.equal(plan.allowance, 0);
  }
  const view = resolveOperationalState({ state: done, plan: { ok: false, reason: ROLLOUT_BLOCK.COMPLETED } });
  assert.equal(view.state, OPERATIONAL_STATE.COMPLETED);
  assert.equal(view.autoContinues, false);
});

// ── 異常停止は勝手に再開しない ──────────────────────────────────

test('【重要】auto-stop 後は翌日になっても勝手に再開しない', () => {
  // 自動停止は stage=paused + alwaysArmed=false + autoStopped=true
  const stopped = {
    ...running(), stage: ROLLOUT_STAGE.PAUSED, alwaysArmed: false, armedFor: null,
    autoStopped: true, stopReason: 'too_many_records:400>200',
  };
  for (const t of [NOW, NOW + DAY_MS, NOW + 7 * DAY_MS]) {
    const plan = planRolloutTick({
      state: stopped, nowMs: t, remainingCandidates: 9_999, previousOutstanding: 0, envEnabled: true,
    });
    assert.equal(plan.ok, false, '異常停止から勝手に再開している');
    assert.equal(plan.reason, ROLLOUT_BLOCK.PAUSED);
  }
  const view = resolveOperationalState({ state: stopped, plan: { ok: false, reason: ROLLOUT_BLOCK.PAUSED } });
  assert.equal(view.state, OPERATIONAL_STATE.AUTO_STOPPED);
  assert.equal(view.needsHuman, true, '人の対応が要ることを示していない');
  assert.equal(view.autoContinues, false);
});

test('【重要】「1 日上限」と「異常停止」を同じ意味にしない', () => {
  const limit = resolveOperationalState({
    state: running({ lastRunDay: DAY, dayGrantedCount: 15_000 }),
    plan: { ok: false, reason: ROLLOUT_BLOCK.DAILY_LIMIT_REACHED },
  });
  const stopped = resolveOperationalState({
    state: { ...running(), stage: ROLLOUT_STAGE.PAUSED, autoStopped: true, stopReason: 'queue_failed' },
    plan: { ok: false, reason: ROLLOUT_BLOCK.PAUSED },
  });
  assert.notEqual(limit.state, stopped.state);
  assert.equal(limit.needsHuman, false);
  assert.equal(stopped.needsHuman, true);
  const paused = resolveOperationalState({
    state: { ...running(), stage: ROLLOUT_STAGE.PAUSED, autoStopped: false },
    plan: { ok: false, reason: ROLLOUT_BLOCK.PAUSED },
  });
  assert.equal(paused.state, OPERATIONAL_STATE.PAUSED, '人の停止と異常停止が同じになっている');
});

test('緊急停止は状態に関係なく最優先', () => {
  const killed = { ...running(), killed: true };
  const plan = planRolloutTick({
    state: killed, nowMs: NOW, remainingCandidates: 9_999, previousOutstanding: 0, envEnabled: true,
  });
  assert.equal(plan.reason, ROLLOUT_BLOCK.KILLED);
  assert.equal(resolveOperationalState({ state: killed, plan }).needsHuman, true);
});

// ── 冪等性（重複起動・再試行）─────────────────────────────────────

test('【重要】同じ tick が重複起動しても二重付与しない（関所と operationId）', () => {
  const w = makeWorld({ cohort: 15_000, state: running() });
  w.tick(); w.tick(); w.tick();           // バッチを配り切る
  const before = { granted: w.granted, seq: w.state.batchSeq };
  // 同じ状態でもう一度 tick しても付与にはならない（送信待ちのため）
  const again = w.tick();
  assert.notEqual(again, 'grant', '関所を無視して配っている');
  assert.equal(w.granted, before.granted);

  // 付与 op の識別子は同じバッチ番号なら同じ（＝再実行は冪等）
  assert.equal(buildTrialOperationId(NOW, before.seq), buildTrialOperationId(NOW + 1000, before.seq));
});

test('【重要】queue / 送信を再試行しても二重送信 0（同じ人は 1 回だけ数える）', () => {
  const w = makeWorld({ cohort: 1_000, state: running() });
  const seq = [];
  for (let i = 0; i < 40; i += 1) {
    seq.push(w.tick());
    // queue / dispatch のあとに「同じ tick がもう一度走る」状況を混ぜる
    if (seq[seq.length - 1] === 'queue' || seq[seq.length - 1] === 'dispatch') w.tick();
  }
  assert.equal(w.granted, 1_000);
  assert.equal(w.sent, 1_000, `送信が ${w.sent}（二重に数えている）`);
  assert.equal(w.granted, w.sent);
});

test('付与が 0 の tick で状態を汚さない（空回りしない）', () => {
  const w = makeWorld({ cohort: 0, state: running() });
  const step = w.tick();
  assert.equal(step, 'completed', `候補 0 で ${step} になっている`);
  assert.equal(w.state.batchSeq, 0, 'バッチ番号を無駄に進めている');
  assert.equal(w.state.dayGrantedCount, 0);
});

test('【重要】completed は「新しく配る相手が居ない」だけ（Step2〜24 は止めない）', () => {
  // 期日待ちが残っていても終端に入れる（付与だけを止める）
  assert.equal(isRolloutComplete({
    facts: {
      remainingCandidates: 0, outstandingStep1: 0, grantedPendingQueue: 0,
      pendingJobs: 0, followUpDue: 120, followUpStep: 3,
    },
  }).done, true, '期日待ちを理由に終端へ入れていない');

  // 運転手は completed でも tick を続ける（止めるのは付与だけ）
  const src = readFileSync(
    new URL('../../../netlify/functions/cron-marketing-rollout.js', import.meta.url), 'utf8',
  );
  assert.equal(
    /state\.stage === 'completed'\s*\|\|\s*state\.stage === 'paused'/.test(src), false,
    'completed で tick を止めている（Step2〜24 の案内が届かなくなる）',
  );
  assert.ok(src.includes("state.stage === 'paused'"), '一時停止で早期に抜けていない');
});

// ── 観測 ────────────────────────────────────────────────────────

test('運用状態の一覧に PII も secret も混ぜない', () => {
  const v = resolveOperationalState({
    state: { ...running(), stage: ROLLOUT_STAGE.PAUSED, autoStopped: true, stopReason: 'queue_failed' },
    plan: { ok: false, reason: ROLLOUT_BLOCK.PAUSED },
  });
  const dump = JSON.stringify(v);
  assert.equal(/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(dump), false);
  assert.equal(/rec[A-Za-z0-9]{14}/.test(dump), false);
});
