/**
 * sequencePolicy.test.mjs — 数十通シーケンスの判断
 *   node --test src/lib/marketing/sequencePolicy.test.mjs
 *
 * 守る性質:
 *   - 購入・配信停止・ハードバウンス・苦情・suppression は**即停止**
 *   - 最大回数に達したら自動終了（数十通へ伸ばせる）
 *   - 短期間の過剰配信を頻度上限で止める
 *   - 無反応が続けば間隔を空け、閾値で打ち切る
 *   - 同じ訴求角度を連投しない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideNext, resolveStop, resolveIntervalDays, checkFrequencyCap, pickAngle,
  countConsecutiveNoEngagement, normalizePolicy, describePolicy,
  NEXT_ACTION, STOP_REASON, WAIT_REASON, DEFAULT_POLICY,
} from './sequencePolicy.js';

const DAY = 24 * 3600_000;
const NOW = Date.parse('2026-08-16T00:00:00Z');

const base = (over = {}) => ({
  campaignEnabled: true, purchased: false, unsubscribed: false, hardBounced: false,
  complained: false, providerSuppressed: false, eligible: true,
  sentCount: 1, lastSentAtMs: NOW - 10 * DAY, recentSendAtMs: [NOW - 10 * DAY],
  consecutiveNoEngagement: 0, ...over,
});

// ── 止める条件（強い順）────────────────────────────────────────

test('【重要】購入したら以後の販促を止める', () => {
  const r = decideNext({ policy: DEFAULT_POLICY, state: base({ purchased: true }), nowMs: NOW });
  assert.equal(r.action, NEXT_ACTION.STOP);
  assert.equal(r.reason, STOP_REASON.PURCHASED);
});

test('【重要】配信停止・ハードバウンス・苦情・suppression は即停止', () => {
  for (const [k, reason] of [
    ['unsubscribed', STOP_REASON.UNSUBSCRIBED],
    ['hardBounced', STOP_REASON.HARD_BOUNCE],
    ['complained', STOP_REASON.COMPLAINT],
    ['providerSuppressed', STOP_REASON.SUPPRESSED],
  ]) {
    const r = decideNext({ policy: DEFAULT_POLICY, state: base({ [k]: true }), nowMs: NOW });
    assert.equal(r.action, NEXT_ACTION.STOP, `${k} で止まらない`);
    assert.equal(r.reason, reason);
  }
});

test('購入は配信停止より優先して報告される（目的達成が最上位）', () => {
  const r = resolveStop({ policy: DEFAULT_POLICY, state: base({ purchased: true, unsubscribed: true }) });
  assert.equal(r.reason, STOP_REASON.PURCHASED);
});

test('キャンペーン停止中・対象外は止める', () => {
  assert.equal(decideNext({ policy: DEFAULT_POLICY, state: base({ campaignEnabled: false }), nowMs: NOW }).reason,
    STOP_REASON.CAMPAIGN_DISABLED);
  assert.equal(decideNext({ policy: DEFAULT_POLICY, state: base({ eligible: false }), nowMs: NOW }).reason,
    STOP_REASON.NOT_ELIGIBLE);
});

// ── 最大回数（数十通へ伸ばせる）────────────────────────────────

test('【重要】最大回数に達したら自動終了', () => {
  const r = decideNext({ policy: { maxSends: 4 }, state: base({ sentCount: 4 }), nowMs: NOW });
  assert.equal(r.action, NEXT_ACTION.STOP);
  assert.equal(r.reason, STOP_REASON.MAX_SENDS);
});

test('【重要】最大回数は数十通へ設定できる（4 通で終わらせない）', () => {
  const policy = { maxSends: 36, minIntervalDays: 3, frequencyCap: { windowDays: 7, maxSends: 2 } };
  // 35 通目まで送り終えていれば 36 通目は送れる
  const r = decideNext({
    policy, state: base({ sentCount: 35, lastSentAtMs: NOW - 30 * DAY, recentSendAtMs: [] }), nowMs: NOW,
  });
  assert.equal(r.action, NEXT_ACTION.SEND);
  assert.equal(r.nextStep, 36);
  // 36 通目を送り終えたら終了
  const done = decideNext({ policy, state: base({ sentCount: 36 }), nowMs: NOW });
  assert.equal(done.reason, STOP_REASON.MAX_SENDS);
});

test('normalizePolicy は壊れた maxSends を既定へ倒す', () => {
  assert.equal(normalizePolicy({ maxSends: 0 }).maxSends, DEFAULT_POLICY.maxSends);
  assert.equal(normalizePolicy({ maxSends: -3 }).maxSends, DEFAULT_POLICY.maxSends);
  assert.equal(normalizePolicy({ maxSends: 'たくさん' }).maxSends, DEFAULT_POLICY.maxSends);
  assert.equal(normalizePolicy({ maxSends: 50 }).maxSends, 50);
});

// ── 間隔と頻度上限 ───────────────────────────────────────────

test('1 通目は間隔を待たない（初回接触）', () => {
  const r = decideNext({
    policy: DEFAULT_POLICY,
    state: base({ sentCount: 0, lastSentAtMs: null, recentSendAtMs: [] }), nowMs: NOW,
  });
  assert.equal(r.action, NEXT_ACTION.SEND);
  assert.equal(r.nextStep, 1);
});

test('【重要】最小間隔より前なら待つ', () => {
  const r = decideNext({
    policy: { minIntervalDays: 3 },
    state: base({ lastSentAtMs: NOW - 1 * DAY, recentSendAtMs: [NOW - 1 * DAY] }), nowMs: NOW,
  });
  assert.equal(r.action, NEXT_ACTION.WAIT);
  assert.equal(r.reason, WAIT_REASON.INTERVAL);
  assert.equal(r.nextAtMs, NOW - 1 * DAY + 3 * DAY);
});

test('ステップの delayDays が最小間隔を下回っても、最小間隔は割らない', () => {
  assert.equal(resolveIntervalDays({ policy: { minIntervalDays: 3 }, state: base(), stepDelayDays: 1 }), 3);
  assert.equal(resolveIntervalDays({ policy: { minIntervalDays: 3 }, state: base(), stepDelayDays: 10 }), 10);
});

test('【重要】短期間の過剰配信を頻度上限で止める', () => {
  const policy = { minIntervalDays: 1, frequencyCap: { windowDays: 7, maxSends: 2 } };
  const recent = [NOW - 2 * DAY, NOW - 5 * DAY];
  const r = decideNext({
    policy, state: base({ lastSentAtMs: NOW - 2 * DAY, recentSendAtMs: recent }), nowMs: NOW,
  });
  assert.equal(r.action, NEXT_ACTION.WAIT);
  assert.equal(r.reason, WAIT_REASON.FREQUENCY_CAP);
});

test('窓の外の送信は頻度上限に数えない', () => {
  const policy = { windowDays: 7, maxSends: 2 };
  const r = checkFrequencyCap({
    policy: { frequencyCap: policy },
    recentSendAtMs: [NOW - 10 * DAY, NOW - 20 * DAY], nowMs: NOW,
  });
  assert.equal(r.ok, true);
  assert.equal(r.recent, 0);
});

test('【重要】現在時刻が読めなければ送らない（fail closed）', () => {
  const r = checkFrequencyCap({ policy: DEFAULT_POLICY, recentSendAtMs: [], nowMs: null });
  assert.equal(r.ok, false);
  const d = decideNext({ policy: DEFAULT_POLICY, state: base(), nowMs: null });
  assert.equal(d.action, NEXT_ACTION.WAIT);
});

// ── 反応で変える ─────────────────────────────────────────────

test('【重要】無反応が続いたら間隔を空ける', () => {
  const policy = { minIntervalDays: 3, slowdownAfterNoEngagement: 3, slowdownFactor: 2 };
  assert.equal(resolveIntervalDays({ policy, state: base({ consecutiveNoEngagement: 2 }) }), 3);
  assert.equal(resolveIntervalDays({ policy, state: base({ consecutiveNoEngagement: 3 }) }), 6);
});

test('【重要】無反応が閾値を超えたら打ち切る', () => {
  const policy = { stopAfterNoEngagement: 8 };
  const r = decideNext({ policy, state: base({ consecutiveNoEngagement: 8 }), nowMs: NOW });
  assert.equal(r.action, NEXT_ACTION.STOP);
  assert.equal(r.reason, STOP_REASON.NO_ENGAGEMENT);
});

test('打ち切らない設定にもできる', () => {
  const policy = { stopAfterNoEngagement: null, maxSends: 30 };
  const r = decideNext({
    policy, state: base({ consecutiveNoEngagement: 20, lastSentAtMs: NOW - 30 * DAY, recentSendAtMs: [] }),
    nowMs: NOW,
  });
  assert.notEqual(r.reason, STOP_REASON.NO_ENGAGEMENT);
});

test('連続無反応の数え方（開封・クリックがあれば途切れる）', () => {
  // 古い順: 開封あり → 無 → 無
  assert.equal(countConsecutiveNoEngagement([{ opened: true }, {}, {}]), 2);
  // 全部無反応
  assert.equal(countConsecutiveNoEngagement([{}, {}, {}, {}]), 4);
  // 直近がクリックあり
  assert.equal(countConsecutiveNoEngagement([{}, {}, { clicked: true }]), 0);
  assert.equal(countConsecutiveNoEngagement([]), 0);
  assert.equal(countConsecutiveNoEngagement(null), 0);
});

// ── 訴求角度 ────────────────────────────────────────────────

test('【重要】訴求角度を順に使い、同じ角度を連投しない', () => {
  const angles = ['実績', '使い方', '期限', '声'];
  assert.equal(pickAngle({ angles, stepNumber: 1 }), '実績');
  assert.equal(pickAngle({ angles, stepNumber: 2 }), '使い方');
  assert.equal(pickAngle({ angles, stepNumber: 5 }), '実績', '一巡したら先頭へ戻る');
  // 直前と同じになりそうなら 1 つずらす
  assert.equal(pickAngle({ angles, stepNumber: 5, lastAngle: '実績' }), '使い方');
});

test('角度が 1 つしかないときは連投を避けようがない（例外にしない）', () => {
  assert.equal(pickAngle({ angles: ['単一'], stepNumber: 3, lastAngle: '単一' }), '単一');
});

test('角度が無ければ null（呼び出し側が既定文面を使う）', () => {
  assert.equal(pickAngle({ angles: [], stepNumber: 1 }), null);
  assert.equal(pickAngle({ angles: null, stepNumber: 1 }), null);
});

// ── 画面表示 ────────────────────────────────────────────────

test('ポリシーの要約は人が読める形で、PII を含めない', () => {
  const d = describePolicy({ maxSends: 36, minIntervalDays: 4, frequencyCap: { windowDays: 14, maxSends: 3 } });
  assert.equal(d.maxSends, 36);
  assert.match(d.frequencyCap, /14 日で最大 3 通/);
  assert.equal(JSON.stringify(d).includes('@'), false);
});

// ── 数十通を通しで回す（積分テスト）────────────────────────────

test('【重要】数十通を通しで回しても、頻度上限と最大回数で必ず終わる', () => {
  const policy = {
    maxSends: 24, minIntervalDays: 3,
    frequencyCap: { windowDays: 7, maxSends: 2 },
    slowdownAfterNoEngagement: 3, slowdownFactor: 2, stopAfterNoEngagement: null,
  };
  let now = NOW;
  let sent = 0;
  const history = [];
  let guard = 0;
  let lastStop = null;
  while (guard < 1000) {
    guard += 1;
    const r = decideNext({
      policy,
      state: {
        campaignEnabled: true, purchased: false, unsubscribed: false, hardBounced: false,
        complained: false, providerSuppressed: false, eligible: true,
        sentCount: sent,
        lastSentAtMs: history.length ? history[history.length - 1] : null,
        recentSendAtMs: history,
        consecutiveNoEngagement: 0,
      },
      nowMs: now,
    });
    if (r.action === NEXT_ACTION.STOP) { lastStop = r.reason; break; }
    if (r.action === NEXT_ACTION.WAIT) { now += DAY; continue; }
    sent += 1;
    history.push(now);
    now += DAY;
  }
  assert.equal(lastStop, STOP_REASON.MAX_SENDS, '最大回数で終わっていない');
  assert.equal(sent, 24, `送信回数が ${sent}（24 のはず）`);
  // 頻度上限を守れているか（どの 7 日窓でも 2 通以下）
  for (let i = 0; i < history.length; i += 1) {
    const windowStart = history[i] - 7 * DAY;
    const inWindow = history.filter((t) => t > windowStart && t <= history[i]).length;
    assert.ok(inWindow <= 2, `7 日窓に ${inWindow} 通入っている`);
  }
});

test('【重要】途中で購入したらそこで止まる（残りは送らない）', () => {
  const policy = { maxSends: 24, minIntervalDays: 3, frequencyCap: { windowDays: 7, maxSends: 2 } };
  let now = NOW; let sent = 0; const history = [];
  let stop = null;
  for (let i = 0; i < 500; i += 1) {
    const purchased = sent >= 5;
    const r = decideNext({
      policy,
      state: {
        campaignEnabled: true, purchased, unsubscribed: false, hardBounced: false,
        complained: false, providerSuppressed: false, eligible: true,
        sentCount: sent, lastSentAtMs: history[history.length - 1] ?? null,
        recentSendAtMs: history, consecutiveNoEngagement: 0,
      },
      nowMs: now,
    });
    if (r.action === NEXT_ACTION.STOP) { stop = r.reason; break; }
    if (r.action === NEXT_ACTION.WAIT) { now += DAY; continue; }
    sent += 1; history.push(now); now += DAY;
  }
  assert.equal(stop, STOP_REASON.PURCHASED);
  assert.equal(sent, 5, '購入後も送っている');
});
