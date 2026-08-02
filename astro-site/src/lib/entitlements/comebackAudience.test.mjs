/**
 * comebackAudience.test.mjs — カムバック特典の対象区分
 *
 * 「カムバック」は戻ってきてほしい人への施策で、**いま払って使っている会員に配るものではない**。
 * 配った権利を後から取り消すのは不信を招くので、**現有効会員は既定で対象外**にし、
 * 混ざっていたら実行を止める。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEGMENT, EXCLUDE, DEFAULT_TARGET_SEGMENTS, INCLUDE_ACTIVE_WARNING,
  classifyComebackSegment, evaluateComebackTarget, summarizeComebackAudience,
  canApplyComebackGrant, resolveExpiryMs,
} from './comebackAudience.js';

const NOW = Date.parse('2026-08-02T00:00:00Z');
const seg = (fields) => classifyComebackSegment({ fields, nowMs: NOW });

// ── 区分 ────────────────────────────────────────────────────
test('有効期限内の有料会員は「現有効会員」', () => {
  assert.equal(seg({ Status: 'active', プラン: 'Premium', 有効期限: '2027-08-01' }), SEGMENT.ACTIVE_MEMBER);
  assert.equal(seg({ Status: 'active', プラン: 'Light', 有効期限: '2026-09-01' }), SEGMENT.ACTIVE_MEMBER);
  assert.equal(seg({ Status: 'active', プラン: 'Premium', PlanType: 'Lifetime' }), SEGMENT.ACTIVE_MEMBER);
});

test('期限が過ぎていれば「期限切れ」（active のままでも）', () => {
  assert.equal(seg({ Status: 'active', プラン: 'Premium', 有効期限: '2026-07-20' }), SEGMENT.EXPIRED);
  assert.equal(seg({ Status: 'expired', プラン: 'Light' }), SEGMENT.EXPIRED);
});

test('退会は契約状態より優先して「退会」', () => {
  assert.equal(seg({ Status: 'active', プラン: 'Premium', 有効期限: '2027-01-01', WithdrawalRequested: true }), SEGMENT.WITHDRAWN);
  assert.equal(seg({ Status: 'withdrawn', プラン: 'Free' }), SEGMENT.WITHDRAWN);
});

test('無料で長期未ログインは「休眠」、最近ログインは判定不能', () => {
  assert.equal(seg({ Status: 'none', プラン: 'Free', 最終ログイン: '2025-01-01' }), SEGMENT.DORMANT);
  assert.equal(seg({ プラン: 'Free' }), SEGMENT.DORMANT, 'ログイン記録が無い場合は休眠扱い');
  assert.equal(seg({ Status: 'none', プラン: 'Free', 最終ログイン: '2026-07-30' }), SEGMENT.UNKNOWN);
});

test('active なのに期限が読めないものは「状態不明」（推測しない）', () => {
  assert.equal(seg({ Status: 'active', プラン: 'Premium' }), SEGMENT.UNKNOWN);
  assert.equal(seg(null), SEGMENT.UNKNOWN);
});

test('有効期限は JST の終わりで判定する（日付だけの値）', () => {
  const ms = resolveExpiryMs({ 有効期限: '2026-08-02' });
  assert.ok(ms > Date.parse('2026-08-02T00:00:00Z'), '日付だけの期限を当日中として扱っていない');
});

// ── 既定の除外 ──────────────────────────────────────────────
test('現有効会員は既定で対象外', () => {
  const r = evaluateComebackTarget({ fields: { Status: 'active', プラン: 'Premium', 有効期限: '2027-01-01' }, nowMs: NOW });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, EXCLUDE.ACTIVE_MEMBER);
});

test('現有効会員は明示許可があるときだけ対象にできる', () => {
  const r = evaluateComebackTarget({
    fields: { Status: 'active', プラン: 'Premium', 有効期限: '2027-01-01' }, nowMs: NOW, includeActiveMembers: true,
  });
  assert.equal(r.eligible, true);
});

test('期限切れ・退会・休眠は既定で対象', () => {
  for (const fields of [
    { Status: 'expired', プラン: 'Premium' },
    { WithdrawalRequested: true, プラン: 'Light' },
    { プラン: 'Free', 最終ログイン: '2024-01-01' },
  ]) {
    const r = evaluateComebackTarget({ fields, nowMs: NOW });
    assert.equal(r.eligible, true, `${JSON.stringify(fields)} が対象外になっている`);
    assert.ok(DEFAULT_TARGET_SEGMENTS.includes(r.segment));
  }
});

test('状態不明は対象にしない', () => {
  const r = evaluateComebackTarget({ fields: { Status: 'active', プラン: 'Premium' }, nowMs: NOW });
  assert.equal(r.eligible, false);
  assert.equal(r.reason, EXCLUDE.UNKNOWN_STATE);
});

for (const [flag, reason] of [
  ['duplicateEmail', EXCLUDE.DUPLICATE_EMAIL],
  ['blacklisted', EXCLUDE.BLACKLISTED],
  ['unsubscribed', EXCLUDE.UNSUBSCRIBED],
  ['alreadyGranted', EXCLUDE.ALREADY_GRANTED],
  ['alreadyOffered', EXCLUDE.ALREADY_OFFERED],
]) {
  test(`${flag} は対象外（理由つき）`, () => {
    const r = evaluateComebackTarget({ fields: { Status: 'expired', プラン: 'Premium' }, nowMs: NOW, [flag]: true });
    assert.equal(r.eligible, false);
    assert.equal(r.reason, reason);
  });
}

// ── 要約と実行可否 ──────────────────────────────────────────
const evals = () => [
  evaluateComebackTarget({ fields: { Status: 'expired', プラン: 'Premium' }, nowMs: NOW }),
  evaluateComebackTarget({ fields: { WithdrawalRequested: true, プラン: 'Light' }, nowMs: NOW }),
  evaluateComebackTarget({ fields: { Status: 'active', プラン: 'Premium', 有効期限: '2027-01-01' }, nowMs: NOW }),
  evaluateComebackTarget({ fields: { Status: 'active', プラン: 'Premium' }, nowMs: NOW }),
];

test('要約に区分別・除外理由別・現有効会員の混入数を出す', () => {
  const s = summarizeComebackAudience(evals());
  assert.equal(s.total, 4);
  assert.equal(s.eligible, 2);
  assert.equal(s.excluded, 2);
  assert.equal(s.activeMembers, 1);
  assert.equal(s.bySegment[SEGMENT.EXPIRED], 1);
  assert.equal(s.byReason[EXCLUDE.ACTIVE_MEMBER], 1);
  assert.equal(s.byReason[EXCLUDE.UNKNOWN_STATE], 1);
});

test('現有効会員が混ざっていれば既定では実行できない', () => {
  const s = summarizeComebackAudience(evals());
  assert.deepEqual(canApplyComebackGrant({ summary: s }), { allowed: false, reason: EXCLUDE.ACTIVE_MEMBER });
});

test('明示許可だけでは足りず、人数の入力一致を求める', () => {
  const s = summarizeComebackAudience(evals());
  assert.equal(canApplyComebackGrant({ summary: s, includeActiveMembers: true, typedActiveCount: '2' }).reason,
    'active_count_mismatch');
  assert.equal(canApplyComebackGrant({ summary: s, includeActiveMembers: true, typedActiveCount: '1' }).allowed, true);
});

test('現有効会員が 0 名なら普通に実行できる', () => {
  const s = summarizeComebackAudience([evals()[0], evals()[1]]);
  assert.deepEqual(canApplyComebackGrant({ summary: s }), { allowed: true, reason: null });
});

test('対象が 0 名なら実行できない', () => {
  const s = summarizeComebackAudience([evals()[2]]);
  assert.equal(canApplyComebackGrant({ summary: s }).reason, 'no_eligible_targets');
});

test('「現有効会員を含める」には警告文がある', () => {
  assert.match(INCLUDE_ACTIVE_WARNING, /通常のカムバック施策では使用しません/);
});
