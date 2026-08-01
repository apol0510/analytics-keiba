/**
 * authPolicies.test.mjs — 無料ログイン分岐 / マジックリンク送信判定
 *   node --test src/lib/auth/authPolicies.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideFreeLogin, shouldSendMagicLink, FREE_LOGIN_OUTCOME } from './authPolicies.js';
import { MEMBER_TYPE, resolveMembership } from './memberResolution.js';
import { issuePaidSessionCookie, ISSUE_REJECT } from './sessionIssuance.js';
import { runVerifyMagicLink, VERIFY_FLOW } from './verifyMagicLinkFlow.js';

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

// =========================================================================
// 契約終了（期限切れ / 退会申請）→ 無料ログインするが、有料経路はどこも通らない
// 「入口（auth-user）だけ直って有料が漏れる」ことがないよう、判定 → 各経路まで通しで固定する。
// =========================================================================

const NOW = 1_750_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const past = new Date(NOW - DAY).toISOString();
const SECRET = 'x'.repeat(64);

const ENDED = {
  expired: { 'プラン': 'Premium', Status: 'active', '有効期限': past },
  withdrawn: { 'プラン': 'Premium Sanrenpuku', Status: 'active', WithdrawalRequested: true },
};

for (const [label, fields] of Object.entries(ENDED)) {
  test(`${label}: free ログインは可・有料 Cookie / magic link / refresh はすべて拒否`, async () => {
    const membership = resolveMembership({ fields, recordId: 'recEND', now: NOW });

    // 1. 入口: 無料ログインできる
    assert.equal(membership.memberType, MEMBER_TYPE.FREE);
    assert.equal(decideFreeLogin(membership).outcome, FREE_LOGIN_OUTCOME.FREE);
    assert.equal(membership.normalizedPlan, 'free');

    // 2. 有料リンクは送られない
    assert.equal(shouldSendMagicLink(membership), false);

    // 3. 有料 Cookie は発行されない（＝ SSR / Edge の有料ページは開けない）
    const issued = await issuePaidSessionCookie({ membership, secret: SECRET, now: NOW });
    assert.equal(issued.ok, false);
    assert.equal(issued.reason, ISSUE_REJECT.NOT_PAID);
    assert.equal(issued.cookie, undefined);

    // 4. マジックリンクを検証しても paid にならない
    const flow = await runVerifyMagicLink({
      token: 't', secret: SECRET, now: NOW,
      findToken: async () => ({ id: 'tok', fields: { Used: false, ExpiresAt: new Date(NOW + DAY).toISOString(), Email: 'a@example.com' } }),
      findCustomer: async () => ({ id: 'recEND', fields }),
      markUsed: async () => { throw new Error('markUsed を呼んではいけない'); },
    });
    assert.equal(flow.outcome, VERIFY_FLOW.NOT_PAID);
    assert.equal(flow.cookie, undefined);
  });
}
