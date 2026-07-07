/**
 * verifyMagicLinkFlow.test.mjs — マジックリンク検証フロー（依存注入）のテスト
 *   node --test src/lib/auth/verifyMagicLinkFlow.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runVerifyMagicLink, VERIFY_FLOW } from './verifyMagicLinkFlow.js';
import { verifySession } from './session.js';
import { readSessionCookie } from './sessionCookie.js';

const NOW = 1_750_000_000_000;
const TEST_SECRET = 'test-only-fixed-hmac-secret-DO-NOT-USE-IN-PROD-0123456789';
const subtle = globalThis.crypto.subtle;

const paidFields = (over = {}) => ({ Email: 'p@x.jp', 'プラン': 'Premium', Status: 'active', ...over });
const freshToken = (over = {}) => ({
  id: 'tokREC',
  fields: { Used: false, ExpiresAt: new Date(NOW + 5 * 60 * 1000).toISOString(), Email: 'p@x.jp', ...over },
});

// 呼び出し順を記録しつつ、token/customer/markUsed を注入する。
function harness(over = {}) {
  const calls = [];
  const state = {
    token: over.tokenRecord === null ? null : (over.tokenRecord ?? freshToken()),
    customer: over.customer === null ? null : (over.customer ?? { id: 'recP', fields: paidFields() }),
    usedOnRecheck: over.usedOnRecheck ?? false,
    markUsedThrows: over.markUsedThrows ?? false,
  };
  let findTokenCount = 0;
  const deps = {
    token: 'tok-abc' in over ? over['tok-abc'] : 'tok-abc',
    secret: 'secret' in over ? over.secret : TEST_SECRET,
    now: over.now ?? NOW,
    subtle,
    findToken: async () => {
      findTokenCount += 1;
      calls.push(`findToken#${findTokenCount}`);
      if (state.token === null) return null;
      // 2 回目（使用済み更新直前の再確認）で used を差し込めるように
      if (findTokenCount >= 2 && state.usedOnRecheck) {
        return { id: state.token.id, fields: { ...state.token.fields, Used: true } };
      }
      return { id: state.token.id, fields: { ...state.token.fields } };
    },
    findCustomer: async () => {
      calls.push('findCustomer');
      return state.customer;
    },
    markUsed: async () => {
      calls.push('markUsed');
      if (state.markUsedThrows) throw new Error('airtable update failed');
    },
  };
  if ('token' in over) deps.token = over.token;
  return { deps, calls };
}

// =========================================================================
// 正常系
// =========================================================================

test('正常 token + paid → OK + Cookie（20分, 検証可能）', async () => {
  const { deps, calls } = harness();
  const r = await runVerifyMagicLink(deps);
  assert.equal(r.outcome, VERIFY_FLOW.OK);
  assert.match(r.cookie, /^ak_session=/);
  assert.match(r.cookie, /Max-Age=1200/);
  // Cookie は markUsed の後に確定している（使用済み更新前に Cookie を返さない）
  assert.ok(calls.indexOf('markUsed') !== -1);
  assert.ok(calls.indexOf('markUsed') < calls.length);
  // 往復検証
  const val = readSessionCookie(r.cookie.split(';')[0]);
  const v = await verifySession({ token: val, secret: TEST_SECRET, now: NOW, subtle });
  assert.equal(v.ok, true);
  assert.equal(v.payload.plan, 'premium');
  assert.equal(v.payload.expiresAt - v.payload.issuedAt, 20 * 60 * 1000);
});

test('SessionVersion 欠落 → payload は 0', async () => {
  const { deps } = harness();
  const r = await runVerifyMagicLink(deps);
  assert.equal(r.payload.sessionVersion, 0);
});

test('SessionVersion 保持', async () => {
  const { deps } = harness({ customer: { id: 'recP', fields: paidFields({ SessionVersion: 4 }) } });
  const r = await runVerifyMagicLink(deps);
  assert.equal(r.payload.sessionVersion, 4);
});

// =========================================================================
// token 検証
// =========================================================================

test('token 無し → missing_token', async () => {
  const { deps } = harness({ token: '' });
  assert.equal((await runVerifyMagicLink(deps)).outcome, VERIFY_FLOW.MISSING_TOKEN);
});
test('token 見つからない → token_not_found', async () => {
  const { deps } = harness({ tokenRecord: null });
  assert.equal((await runVerifyMagicLink(deps)).outcome, VERIFY_FLOW.TOKEN_NOT_FOUND);
});
test('token 使用済み → token_used', async () => {
  const { deps } = harness({ tokenRecord: freshToken({ Used: true }) });
  assert.equal((await runVerifyMagicLink(deps)).outcome, VERIFY_FLOW.TOKEN_USED);
});
test('token 期限切れ → token_expired', async () => {
  const { deps } = harness({ tokenRecord: freshToken({ ExpiresAt: new Date(NOW - 60 * 1000).toISOString() }) });
  assert.equal((await runVerifyMagicLink(deps)).outcome, VERIFY_FLOW.TOKEN_EXPIRED);
});
test('token 再利用（更新直前に使用済み検出）→ token_used・Cookie 発行しない', async () => {
  const { deps, calls } = harness({ usedOnRecheck: true });
  const r = await runVerifyMagicLink(deps);
  assert.equal(r.outcome, VERIFY_FLOW.TOKEN_USED);
  assert.equal(r.cookie, undefined);
  assert.equal(calls.includes('markUsed'), false);
});

// =========================================================================
// 会員判定
// =========================================================================

test('customer 見つからない → customer_not_found', async () => {
  const { deps } = harness({ customer: null });
  assert.equal((await runVerifyMagicLink(deps)).outcome, VERIFY_FLOW.CUSTOMER_NOT_FOUND);
});
test('Free へ変更済み → not_paid・Cookie 発行不可・token 消費しない', async () => {
  const { deps, calls } = harness({ customer: { id: 'recF', fields: { Email: 'p@x.jp', 'プラン': 'Free' } } });
  const r = await runVerifyMagicLink(deps);
  assert.equal(r.outcome, VERIFY_FLOW.NOT_PAID);
  assert.equal(r.cookie, undefined);
  assert.equal(calls.includes('markUsed'), false);
});
test('期限切れ会員 → not_paid', async () => {
  const past = new Date(NOW - 24 * 60 * 60 * 1000).toISOString();
  const { deps } = harness({ customer: { id: 'recE', fields: paidFields({ '有効期限': past }) } });
  assert.equal((await runVerifyMagicLink(deps)).outcome, VERIFY_FLOW.NOT_PAID);
});
test('退会申請 → not_paid', async () => {
  const { deps } = harness({ customer: { id: 'recW', fields: paidFields({ WithdrawalRequested: true }) } });
  assert.equal((await runVerifyMagicLink(deps)).outcome, VERIFY_FLOW.NOT_PAID);
});
test('停止 → not_paid', async () => {
  const { deps } = harness({ customer: { id: 'recS', fields: paidFields({ Status: 'suspended' }) } });
  assert.equal((await runVerifyMagicLink(deps)).outcome, VERIFY_FLOW.NOT_PAID);
});

// =========================================================================
// 秘密鍵 / 更新失敗
// =========================================================================

test('秘密鍵 未設定 → secret_unavailable（token に触れない）', async () => {
  const { deps, calls } = harness({ secret: undefined });
  const r = await runVerifyMagicLink(deps);
  assert.equal(r.outcome, VERIFY_FLOW.SECRET_UNAVAILABLE);
  assert.equal(calls.length, 0);
});
test('秘密鍵 短すぎ → secret_unavailable', async () => {
  const { deps } = harness({ secret: 'short' });
  assert.equal((await runVerifyMagicLink(deps)).outcome, VERIFY_FLOW.SECRET_UNAVAILABLE);
});
test('Airtable 使用済み更新失敗 → consume_failed・Cookie を返さない', async () => {
  const { deps } = harness({ markUsedThrows: true });
  const r = await runVerifyMagicLink(deps);
  assert.equal(r.outcome, VERIFY_FLOW.CONSUME_FAILED);
  assert.equal(r.cookie, undefined);
});
