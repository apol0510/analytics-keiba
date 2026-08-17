/**
 * rolloutControl.test.mjs — 展開状態の書き換えで受け付けてよい値
 *   node --test src/lib/marketing/rolloutControl.test.mjs
 *
 * 守る性質:
 *   - 知らない段階・壊れた上限・過去や遠すぎる武装日を**受け付けない**
 *   - `expectedVersion` が無ければ書かない（**CAS 無しの上書きを許さない**）
 *   - one-shot（`alwaysArmed: false`）は**必ず武装日を伴う**
 *   - `start` は緊急停止を勝手に解除しない
 *   - `pause` は新規付与だけ止める / `resume` は段階を上げない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  planRolloutStart, planRolloutPause, planRolloutResume, describeControlResult,
  CONTROL_REJECT, MAX_ARMED_AHEAD_DAYS,
} from './rolloutControl.js';
import { defaultRolloutState, ROLLOUT_STAGE, ABSOLUTE_MAX_PER_DAY, jstDay } from './rolloutPlan.js';

const NOW = Date.parse('2026-08-16T02:00:00Z');   // JST 11:00
const TODAY = jstDay(NOW);
const DAY = 86400_000;

const start = (req, over = {}) => planRolloutStart({
  current: defaultRolloutState(), exists: false, nowMs: NOW,
  req: {
    stage: 'canary', dailyLimit: 100, batchSize: 100,
    alwaysArmed: false, armedFor: TODAY, expectedVersion: null, ...req,
  },
  ...over,
});

// ── 通る形（100 名 one-shot）──────────────────────────────────

test('【重要】100 名 one-shot の指定が通る', () => {
  const r = start({});
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.state.stage, ROLLOUT_STAGE.CANARY);
  assert.equal(r.state.dailyLimit, 100);
  assert.equal(r.state.alwaysArmed, false);
  assert.equal(r.state.armedFor, TODAY);
  assert.equal(r.state.killed, false);
  assert.equal(r.expectedVersion, null, '新規作成の CAS 前提値が null でない');
});

test('翌日を武装日にできる（当日中に翌朝ぶんを仕込む）', () => {
  const r = start({ armedFor: jstDay(NOW + DAY) });
  assert.equal(r.ok, true, r.reason);
});

test('継続運用（alwaysArmed: true）は武装日なしで通る', () => {
  const r = start({ alwaysArmed: true, armedFor: undefined });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.state.alwaysArmed, true);
  assert.equal(r.state.armedFor, null);
});

// ── 断る形 ────────────────────────────────────────────────────

test('【重要】知らない段階は断る（canary10 のような値を書かせない）', () => {
  for (const stage of ['canary10', 'steady100', 'CANARY', '', null, 'running']) {
    const r = start({ stage });
    assert.equal(r.ok, false, `${String(stage)} を受け入れている`);
    assert.equal(r.reason, CONTROL_REJECT.BAD_STAGE);
  }
});

test('【重要】1 日あたりの上限は整数・0 以上・絶対上限以内', () => {
  for (const v of [-1, 1.5, '100', null, undefined, ABSOLUTE_MAX_PER_DAY + 1]) {
    const r = start({ dailyLimit: v, batchSize: 1 });
    assert.equal(r.ok, false, `dailyLimit=${String(v)} を受け入れている`);
    assert.equal(r.reason, CONTROL_REJECT.BAD_DAILY_LIMIT);
  }
  // 1 日上限 0（止める）のときはバッチも 0 しかありえない → batchSize 必須と両立しない
  assert.equal(start({ dailyLimit: 0, batchSize: 1 }).reason, CONTROL_REJECT.BAD_BATCH_SIZE);
  // ⚠️ 1 バッチは付与側の絶対上限（`HARD_MAX_BATCH_SIZE` = 500）を超えられない。
  //    超える値を保存できると、毎 tick 付与側が fail closed になり **1 人も進まない**。
  assert.equal(start({ dailyLimit: ABSOLUTE_MAX_PER_DAY, batchSize: 500 }).ok, true);
  assert.equal(
    start({ dailyLimit: ABSOLUTE_MAX_PER_DAY, batchSize: 1000 }).reason,
    CONTROL_REJECT.BAD_BATCH_SIZE,
    '付与側が必ず断る刻みを保存できてしまう',
  );
});

test('【重要】未指定の上限を「段階の既定でよい」と解釈しない', () => {
  const r = start({ dailyLimit: undefined });
  assert.equal(r.ok, false, '未指定を通している（100 名のつもりが 10 名になる）');
});

test('【重要】1 バッチの人数も必ず明示させる（15,000 名を 1 回で投げない）', () => {
  const r = start({ batchSize: undefined });
  assert.equal(r.ok, false, 'batchSize 未指定を通している');
  assert.equal(r.reason, CONTROL_REJECT.BAD_BATCH_SIZE);
});

test('【重要】1 バッチが 1 日上限を超える指定は断る', () => {
  const r = start({ dailyLimit: 1000, batchSize: 1001 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, CONTROL_REJECT.BAD_BATCH_SIZE);
});

test('【重要】15,000 名を 500 名ずつ配る指定が通る（最終目的の形）', () => {
  const r = start({ stage: 'scale', dailyLimit: 15000, batchSize: 500 });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.state.dailyLimit, 15000);
  assert.equal(r.state.batchSize, 500);
});

test('【重要】絶対上限（20,000）は超えられない', () => {
  const r = start({ stage: 'scale', dailyLimit: ABSOLUTE_MAX_PER_DAY + 1, batchSize: 500 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, CONTROL_REJECT.BAD_DAILY_LIMIT);
});

test('【重要】one-shot なのに武装日が無ければ断る（永久に動かない状態を作らない）', () => {
  const r = start({ alwaysArmed: false, armedFor: undefined });
  assert.equal(r.ok, false);
  assert.equal(r.reason, CONTROL_REJECT.ARMED_FOR_REQUIRED);
});

test('【重要】過去の武装日は断る（武装したつもりで動かない）', () => {
  const r = start({ armedFor: jstDay(NOW - DAY) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, CONTROL_REJECT.ARMED_FOR_PAST);
});

test('【重要】遠すぎる未来の武装日は断る（置きっぱなしの誤爆を防ぐ）', () => {
  const ok = start({ armedFor: jstDay(NOW + MAX_ARMED_AHEAD_DAYS * DAY) });
  assert.equal(ok.ok, true, '上限ちょうどは許す');
  const ng = start({ armedFor: jstDay(NOW + (MAX_ARMED_AHEAD_DAYS + 1) * DAY) });
  assert.equal(ng.ok, false);
  assert.equal(ng.reason, CONTROL_REJECT.ARMED_FOR_TOO_FAR);
});

test('日付の形式が違えば断る', () => {
  for (const v of ['2026/08/16', '20260816', '2026-8-16', 'today']) {
    assert.equal(start({ armedFor: v }).reason, CONTROL_REJECT.BAD_ARMED_FOR, `${v} を受け入れている`);
  }
});

test('alwaysArmed は真偽値のみ', () => {
  for (const v of ['true', 1, null, undefined]) {
    assert.equal(start({ alwaysArmed: v }).reason, CONTROL_REJECT.BAD_ALWAYS_ARMED);
  }
});

// ── CAS（競合検知）─────────────────────────────────────────────

test('【重要】expectedVersion の指定漏れは断る（CAS 無しで上書きさせない）', () => {
  const r = planRolloutStart({
    current: defaultRolloutState(), exists: false, nowMs: NOW,
    req: { stage: 'canary', dailyLimit: 100, batchSize: 100, alwaysArmed: true },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, CONTROL_REJECT.EXPECTED_VERSION_REQUIRED);
});

test('【重要】新規作成のつもりで既存を上書きしない', () => {
  const r = planRolloutStart({
    current: { ...defaultRolloutState(), version: 3 }, exists: true, nowMs: NOW,
    req: { stage: 'canary', dailyLimit: 100, batchSize: 100, alwaysArmed: true, expectedVersion: null },
  });
  assert.equal(r.ok, false, '既存があるのに新規作成として通している');
});

test('【重要】既存が無いのに版を指定したら断る', () => {
  const r = planRolloutStart({
    current: defaultRolloutState(), exists: false, nowMs: NOW,
    req: { stage: 'canary', dailyLimit: 100, batchSize: 100, alwaysArmed: true, expectedVersion: 3 },
  });
  assert.equal(r.ok, false);
});

test('既存キーの更新は版を引き継ぐ', () => {
  const r = planRolloutStart({
    current: { ...defaultRolloutState(), version: 4 }, exists: true, nowMs: NOW,
    req: { stage: 'scale', dailyLimit: 500, batchSize: 500, alwaysArmed: false, armedFor: TODAY, expectedVersion: 4 },
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.expectedVersion, 4);
  assert.equal(r.state.stage, ROLLOUT_STAGE.SCALE);
  assert.equal(r.state.dailyLimit, 500);
});

// ── 緊急停止との関係 ──────────────────────────────────────────

test('【重要】start は緊急停止を勝手に解除しない', () => {
  const r = planRolloutStart({
    current: { ...defaultRolloutState(), killed: true, version: 2 }, exists: true, nowMs: NOW,
    req: { stage: 'canary', dailyLimit: 100, batchSize: 100, alwaysArmed: true, expectedVersion: 2 },
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.state.killed, true, '止めた事実を消している');
});

test('【重要】pause は新規付与だけ止める（killed は触らない）', () => {
  const r = planRolloutPause({ current: { ...defaultRolloutState(), stage: 'steady', alwaysArmed: true }, nowMs: NOW });
  assert.equal(r.state.stage, ROLLOUT_STAGE.PAUSED);
  assert.equal(r.state.killed, false);
  assert.equal(r.state.alwaysArmed, false, '武装が残っている');
  assert.equal(r.state.armedFor, null);
});

test('【重要】resume は段階を上げない・武装も戻さない', () => {
  const r = planRolloutResume({
    current: { ...defaultRolloutState(), stage: 'paused', killed: true, alwaysArmed: true }, nowMs: NOW,
  });
  assert.equal(r.state.killed, false, '停止が解除されていない');
  assert.equal(r.state.stage, ROLLOUT_STAGE.PAUSED, '段階を勝手に上げている');
  assert.equal(r.state.alwaysArmed, false, '再開だけで配り出す状態になっている');
  assert.equal(r.state.armedFor, null);
});

// ── 応答 ──────────────────────────────────────────────────────

test('メモは 200 文字まで', () => {
  assert.equal(start({ note: 'あ'.repeat(201) }).reason, CONTROL_REJECT.BAD_NOTE);
  assert.equal(start({ note: 'あ'.repeat(200) }).ok, true);
});

test('応答に PII も secret も入れない', () => {
  const r = start({ note: 'activation canary 100 (one-shot)' });
  const d = describeControlResult({ op: 'start', state: r.state });
  assert.equal(d.stage, 'canary');
  assert.equal(d.dailyLimit, 100);
  assert.equal(d.armedFor, TODAY);
  assert.equal(/@|rec[A-Za-z0-9]{14}|Bearer/.test(JSON.stringify(d)), false);
});
