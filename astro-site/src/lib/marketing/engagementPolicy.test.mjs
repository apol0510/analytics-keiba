import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ENGAGEMENT, DEFAULT_THRESHOLDS, resolveThresholds, classifyEngagement,
  isBlockedByEngagement, hasMeaningfulAction, hasAnySignal,
  appliesToEmailType, ENGAGEMENT_EXEMPT_EMAIL_TYPES, summarizeEngagement,
} from './engagementPolicy.js';

test('閾値は 1 か所に置き、既定は 5 / 10 / 20', () => {
  assert.deepEqual(DEFAULT_THRESHOLDS, {
    lowEngagementSends: 5, inactiveDelivered: 10, hardInactiveDelivered: 20,
  });
  assert.deepEqual(resolveThresholds({}), DEFAULT_THRESHOLDS);
});

test('env で上書きできる', () => {
  assert.deepEqual(resolveThresholds({
    MARKETING_LOW_ENGAGEMENT_SENDS: '3',
    MARKETING_INACTIVE_DELIVERED: '6',
    MARKETING_HARD_INACTIVE_DELIVERED: '12',
  }), { lowEngagementSends: 3, inactiveDelivered: 6, hardInactiveDelivered: 12 });
});

test('壊れた値・大小関係が逆なら既定へ倒す（勝手に緩めない）', () => {
  assert.deepEqual(resolveThresholds({ MARKETING_INACTIVE_DELIVERED: 'abc' }), DEFAULT_THRESHOLDS);
  assert.deepEqual(resolveThresholds({ MARKETING_INACTIVE_DELIVERED: '-5' }), DEFAULT_THRESHOLDS);
  // inactive < low は矛盾 → 既定へ
  assert.deepEqual(resolveThresholds({
    MARKETING_LOW_ENGAGEMENT_SENDS: '10', MARKETING_INACTIVE_DELIVERED: '5',
  }), DEFAULT_THRESHOLDS);
});

// ── シグナルの強弱 ─────────────────────────────────────────────
test('click / 購入 / ログインは「意味のある行動」。open は含まない', () => {
  assert.equal(hasMeaningfulAction({ click: 1 }), true);
  assert.equal(hasMeaningfulAction({ purchases: 1 }), true);
  assert.equal(hasMeaningfulAction({ logins: 1 }), true);
  assert.equal(hasMeaningfulAction({ open: 99 }), false, 'open を強いシグナル扱いしている');
  assert.equal(hasAnySignal({ open: 1 }), true);
});

test('open だけでも ACTIVE（反応ありへは倒す）', () => {
  const r = classifyEngagement({ delivered: 30, open: 1 });
  assert.equal(r.state, ENGAGEMENT.ACTIVE);
  assert.equal(r.reason, 'open');
  assert.equal(r.blocked, false);
});

test('意味のある行動があれば delivered が何回でも ACTIVE', () => {
  const r = classifyEngagement({ delivered: 100, open: 0, purchases: 1 });
  assert.equal(r.state, ENGAGEMENT.ACTIVE);
  assert.equal(r.reason, 'meaningful_action');
});

// ── 段階 ───────────────────────────────────────────────────────
test('送信が閾値未満なら UNKNOWN（判断材料不足で切らない）', () => {
  const r = classifyEngagement({ sent: 4, delivered: 4, open: 0 });
  assert.equal(r.state, ENGAGEMENT.UNKNOWN);
  assert.equal(r.blocked, false);
});

test('5 回送って無反応 = LOW_ENGAGEMENT。**まだ止めない**', () => {
  const r = classifyEngagement({ sent: 5, delivered: 5, open: 0 });
  assert.equal(r.state, ENGAGEMENT.LOW_ENGAGEMENT);
  assert.equal(r.blocked, false, 'LOW で止めている（復帰の機会も消える）');
});

test('10 回 delivered で無反応 = INACTIVE（除外）', () => {
  const r = classifyEngagement({ sent: 10, delivered: 10, open: 0 });
  assert.equal(r.state, ENGAGEMENT.INACTIVE);
  assert.equal(r.blocked, true);
});

test('20 回 delivered で無反応 = HARD_INACTIVE（除外）', () => {
  const r = classifyEngagement({ sent: 25, delivered: 20, open: 0 });
  assert.equal(r.state, ENGAGEMENT.HARD_INACTIVE);
  assert.equal(r.blocked, true);
});

test('判定は delivered 基準（送っても届いていない分で切らない）', () => {
  const r = classifyEngagement({ sent: 30, delivered: 9, open: 0 });
  assert.notEqual(r.state, ENGAGEMENT.INACTIVE);
  assert.equal(r.blocked, false);
});

test('購入・ログインで ACTIVE へ復帰できる', () => {
  const before = classifyEngagement({ sent: 25, delivered: 25, open: 0 });
  assert.equal(before.state, ENGAGEMENT.HARD_INACTIVE);
  const after = classifyEngagement({ sent: 25, delivered: 25, open: 0, purchases: 1 });
  assert.equal(after.state, ENGAGEMENT.ACTIVE);
  assert.equal(after.blocked, false);
});

test('止めるのは INACTIVE と HARD_INACTIVE だけ', () => {
  assert.equal(isBlockedByEngagement(ENGAGEMENT.ACTIVE), false);
  assert.equal(isBlockedByEngagement(ENGAGEMENT.UNKNOWN), false);
  assert.equal(isBlockedByEngagement(ENGAGEMENT.LOW_ENGAGEMENT), false);
  assert.equal(isBlockedByEngagement(ENGAGEMENT.INACTIVE), true);
  assert.equal(isBlockedByEngagement(ENGAGEMENT.HARD_INACTIVE), true);
});

// ── 取引メールには適用しない ────────────────────────────────────
test('【重要】決済・認証・サポート・期限通知には適用しない', () => {
  for (const t of ENGAGEMENT_EXEMPT_EMAIL_TYPES) {
    assert.equal(appliesToEmailType(t), false, `${t} に適用してしまっている`);
  }
  assert.equal(appliesToEmailType('campaign'), true);
  assert.equal(appliesToEmailType(''), false, '種別不明にも適用しない（安全側）');
});

test('集計は 5 区分すべてを返す', () => {
  const s = summarizeEngagement([
    { open: 1 }, { purchases: 1 },
    { sent: 5, delivered: 5 },
    { delivered: 10 }, { delivered: 20 },
    { sent: 1, delivered: 1 },
  ]);
  assert.equal(s[ENGAGEMENT.ACTIVE], 2);
  assert.equal(s[ENGAGEMENT.LOW_ENGAGEMENT], 1);
  assert.equal(s[ENGAGEMENT.INACTIVE], 1);
  assert.equal(s[ENGAGEMENT.HARD_INACTIVE], 1);
  assert.equal(s[ENGAGEMENT.UNKNOWN], 1);
});

// ── 送信計画への配線 ────────────────────────────────────────────
const SEND = readFileSync(new URL('./campaignSend.js', import.meta.url), 'utf8');

test('guard: 送信計画がエンゲージメント判定を通す', () => {
  assert.match(SEND, /classifyEngagement\(/);
  assert.match(SEND, /isBlockedByEngagement\(/);
  assert.match(SEND, /MK_EXCLUSION\.ENGAGEMENT_BLOCKED/);
});

test('guard: 閾値をコードへ直書きしない（単一源から取る）', () => {
  const body = SEND.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.equal(/delivered\s*>=\s*\d+/.test(body), false, '閾値が campaignSend へ直書きされている');
  assert.equal(/sent\s*>=\s*\d+/.test(body), false, '閾値が campaignSend へ直書きされている');
});

test('Map を渡さなければ従来どおり素通り（既存呼び出しを壊さない）', () => {
  assert.match(SEND, /if \(engagementByEmail instanceof Map\)/);
});
