/**
 * authPolicies.test.mjs — 無料ログイン分岐 / マジックリンク送信判定
 *   node --test src/lib/auth/authPolicies.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideFreeLogin, shouldSendMagicLink, FREE_LOGIN_OUTCOME } from './authPolicies.js';
import { MEMBER_TYPE } from './memberResolution.js';

const free = { memberType: MEMBER_TYPE.FREE };
const paid = { memberType: MEMBER_TYPE.PAID, normalizedPlan: 'premium' };
const denied = { memberType: MEMBER_TYPE.DENIED };

test('decideFreeLogin: free → free', () => {
  assert.equal(decideFreeLogin(free).outcome, FREE_LOGIN_OUTCOME.FREE);
});
test('decideFreeLogin: paid → requires_magic_link（即時ログイン不可）', () => {
  const r = decideFreeLogin(paid);
  assert.equal(r.outcome, FREE_LOGIN_OUTCOME.REQUIRES_MAGIC_LINK);
  // 有料 plan 名を漏らさない（outcome だけ）
  assert.deepEqual(Object.keys(r), ['outcome']);
});
test('decideFreeLogin: denied → denied', () => {
  assert.equal(decideFreeLogin(denied).outcome, FREE_LOGIN_OUTCOME.DENIED);
});
test('decideFreeLogin: 不明入力 → denied（fail closed）', () => {
  assert.equal(decideFreeLogin({}).outcome, FREE_LOGIN_OUTCOME.DENIED);
  assert.equal(decideFreeLogin(null).outcome, FREE_LOGIN_OUTCOME.DENIED);
});

test('shouldSendMagicLink: paid だけ true', () => {
  assert.equal(shouldSendMagicLink(paid), true);
  assert.equal(shouldSendMagicLink(free), false);
  assert.equal(shouldSendMagicLink(denied), false);
  assert.equal(shouldSendMagicLink(null), false);
});
