/**
 * sendgridNextMessage.test.mjs — **再送を構造的に禁止する**契約を固定する
 *
 * 移行で最大の事故は「既に受け取った通がもう一度届く」こと。
 * 判定は `highestSent + 1` で、穴は埋めず、読めなければ送らない。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveNextMessage, assertNoResend, summarizeNextMessages, containsEmailLike,
  MIGRATION_STATUS, NEXT_MESSAGE_REASON,
} from './sendgridNextMessage.js';
import { PROSPECT_STATE } from './prospectPolicy.js';

const sending = (over = {}) => ({ email: 'a@example.test', state: PROSPECT_STATE.SENDING, ...over });

test('1 通も届いていない人は 1 通目から', () => {
  const r = resolveNextMessage({ prospect: sending(), deliveredMessageNumbers: new Set() });
  assert.equal(r.status, MIGRATION_STATUS.READY);
  assert.equal(r.nextMessageNumber, 1);
  assert.equal(r.highestSent, 0);
});

test('3 通目まで届いている人は 4 通目から（1 通目からやり直さない）', () => {
  const r = resolveNextMessage({
    prospect: sending(), deliveredMessageNumbers: new Set([1, 2, 3]),
  });
  assert.equal(r.status, MIGRATION_STATUS.READY);
  assert.equal(r.nextMessageNumber, 4);
  assert.equal(r.sentCount, 3);
});

test('穴があっても埋めない（1 と 3 が届いていれば次は 4）', () => {
  const r = resolveNextMessage({
    prospect: sending(), deliveredMessageNumbers: new Set([1, 3]),
  });
  assert.equal(r.nextMessageNumber, 4, '2 通目を送り直さない');
  assert.deepEqual(r.gaps, [2], '穴は記録だけする');
});

test('10 通配り終えた人は対象外（completed）', () => {
  const r = resolveNextMessage({
    prospect: sending(), deliveredMessageNumbers: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
  });
  assert.equal(r.status, MIGRATION_STATUS.COMPLETED);
  assert.equal(r.nextMessageNumber, null);
});

test('台帳を引けなければ unresolved（**未送信と見なさない**）', () => {
  const r = resolveNextMessage({ prospect: sending(), deliveredMessageNumbers: null });
  assert.equal(r.status, MIGRATION_STATUS.UNRESOLVED);
  assert.equal(r.reason, NEXT_MESSAGE_REASON.LEDGER_UNAVAILABLE);
  assert.equal(r.nextMessageNumber, null);
});

test('反応済み・昇格済み・打ち切り・抑止は移行しない', () => {
  const cases = [
    [PROSPECT_STATE.ENGAGED, NEXT_MESSAGE_REASON.ENGAGED],
    [PROSPECT_STATE.PROMOTED, NEXT_MESSAGE_REASON.PROMOTED],
    [PROSPECT_STATE.EXHAUSTED, NEXT_MESSAGE_REASON.EXHAUSTED],
    [PROSPECT_STATE.SUPPRESSED, NEXT_MESSAGE_REASON.SUPPRESSED],
  ];
  for (const [state, reason] of cases) {
    const r = resolveNextMessage({
      prospect: sending({ state }), deliveredMessageNumbers: new Set([1]),
    });
    assert.equal(r.status, MIGRATION_STATUS.EXCLUDED, state);
    assert.equal(r.reason, reason);
    assert.equal(r.nextMessageNumber, null);
  }
});

test('未知の状態は除外側へ倒す（送る側へ倒さない）', () => {
  const r = resolveNextMessage({
    prospect: sending({ state: 'WHATEVER' }), deliveredMessageNumbers: new Set(),
  });
  assert.equal(r.status, MIGRATION_STATUS.EXCLUDED);
  assert.equal(r.reason, NEXT_MESSAGE_REASON.UNKNOWN_STATE);
});

test('アドレスが無ければ判定しない', () => {
  const r = resolveNextMessage({
    prospect: sending({ email: '' }), deliveredMessageNumbers: new Set(),
  });
  assert.equal(r.status, MIGRATION_STATUS.UNRESOLVED);
  assert.equal(r.reason, NEXT_MESSAGE_REASON.NO_EMAIL);
});

test('assertNoResend は送信済み以下の番号を拒否する', () => {
  assert.equal(assertNoResend({ highestSent: 3, nextMessageNumber: 4 }).ok, true);
  assert.equal(assertNoResend({ highestSent: 3, nextMessageNumber: 3 }).reason, 'resend_detected');
  assert.equal(assertNoResend({ highestSent: 3, nextMessageNumber: 1 }).reason, 'resend_detected');
  assert.equal(assertNoResend({ highestSent: 3, nextMessageNumber: 5 }).reason, 'gap_skipped');
  assert.equal(assertNoResend({ highestSent: 0, nextMessageNumber: 0 }).reason, 'next_message_missing');
});

test('集計はアドレスを 1 つも含まない', () => {
  const results = [
    resolveNextMessage({ prospect: sending({ email: 'x@example.test' }), deliveredMessageNumbers: new Set([1]) }),
    resolveNextMessage({ prospect: sending({ email: 'y@example.test' }), deliveredMessageNumbers: new Set([1, 2]) }),
    resolveNextMessage({ prospect: sending({ email: 'z@example.test', state: PROSPECT_STATE.ENGAGED }), deliveredMessageNumbers: new Set() }),
    resolveNextMessage({ prospect: sending({ email: 'w@example.test' }), deliveredMessageNumbers: null }),
  ];
  const s = summarizeNextMessages(results);
  assert.equal(s['総数'], 4);
  assert.equal(s['移行対象'], 2);
  assert.equal(s['次に送る番号別'][2], 1);
  assert.equal(s['次に送る番号別'][3], 1);
  assert.equal(s['除外'], 1);
  assert.equal(s['判定不能'], 1);
  assert.equal(containsEmailLike(s), false, '集計にアドレスが混ざってはいけない');
});
