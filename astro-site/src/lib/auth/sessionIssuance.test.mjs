/**
 * sessionIssuance.test.mjs — ak_session 発行オーケストレータのテスト
 *   node --test src/lib/auth/sessionIssuance.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  issuePaidSessionCookie,
  buildLogoutCookie,
  checkSigningSecret,
  DEFAULT_SESSION_TTL_MS,
  ISSUE_REJECT,
} from './sessionIssuance.js';
import { verifySession } from './session.js';
import { readSessionCookie } from './sessionCookie.js';
import { MEMBER_TYPE } from './memberResolution.js';

const NOW = 1_750_000_000_000;
const TEST_SECRET = 'test-only-fixed-hmac-secret-DO-NOT-USE-IN-PROD-0123456789';
const subtle = globalThis.crypto.subtle;

const paidMember = (over = {}) => ({
  memberType: MEMBER_TYPE.PAID,
  normalizedPlan: 'premium',
  venueAccess: ['jra', 'nankan'],
  sessionVersion: 0,
  recordId: 'recPAID',
  ...over,
});

test('paid 会員 → Cookie 発行 + verifySession で往復検証できる', async () => {
  const res = await issuePaidSessionCookie({ membership: paidMember(), secret: TEST_SECRET, now: NOW, subtle });
  assert.equal(res.ok, true);
  assert.match(res.cookie, /^ak_session=/);
  assert.match(res.cookie, /HttpOnly/);
  assert.match(res.cookie, /Secure/);
  assert.match(res.cookie, /SameSite=Lax/);
  assert.match(res.cookie, /Path=\//);
  // Max-Age は 30 日 = 2592000 秒（DEFAULT_SESSION_TTL_MS）
  assert.match(res.cookie, /Max-Age=2592000/);

  const cookieVal = readSessionCookie(res.cookie.split(';')[0]);
  const v = await verifySession({ token: cookieVal, secret: TEST_SECRET, now: NOW, subtle });
  assert.equal(v.ok, true);
  assert.equal(v.payload.plan, 'premium');
  assert.equal(v.payload.sub, 'recPAID');
  assert.deepEqual(v.payload.venueAccess, ['jra', 'nankan']);
});

test('TTL は既定 20 分（expiresAt - issuedAt）', async () => {
  const res = await issuePaidSessionCookie({ membership: paidMember(), secret: TEST_SECRET, now: NOW, subtle });
  assert.equal(res.payload.expiresAt - res.payload.issuedAt, DEFAULT_SESSION_TTL_MS);
  assert.equal(DEFAULT_SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000); // 30日
});

test('SessionVersion 欠落は 0 として payload に入る', async () => {
  const m = paidMember();
  delete m.sessionVersion;
  const res = await issuePaidSessionCookie({ membership: m, secret: TEST_SECRET, now: NOW, subtle });
  assert.equal(res.ok, true);
  assert.equal(res.payload.sessionVersion, 0);
});

test('SessionVersion 正の整数を payload に保持', async () => {
  const res = await issuePaidSessionCookie({ membership: paidMember({ sessionVersion: 9 }), secret: TEST_SECRET, now: NOW, subtle });
  assert.equal(res.payload.sessionVersion, 9);
});

test('free 会員 → Cookie 発行不可(not_paid)', async () => {
  const res = await issuePaidSessionCookie({
    membership: { memberType: MEMBER_TYPE.FREE, normalizedPlan: 'free', venueAccess: [], sessionVersion: 0, recordId: 'recFREE' },
    secret: TEST_SECRET, now: NOW, subtle,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, ISSUE_REJECT.NOT_PAID);
});

test('denied 会員 → Cookie 発行不可(not_paid)', async () => {
  const res = await issuePaidSessionCookie({
    membership: { memberType: MEMBER_TYPE.DENIED, normalizedPlan: null, venueAccess: [], sessionVersion: 0, recordId: 'recX' },
    secret: TEST_SECRET, now: NOW, subtle,
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, ISSUE_REJECT.NOT_PAID);
});

test('秘密鍵 未設定 → 発行不可(secret_invalid) / fail closed', async () => {
  const res = await issuePaidSessionCookie({ membership: paidMember(), secret: undefined, now: NOW, subtle });
  assert.equal(res.ok, false);
  assert.equal(res.reason, ISSUE_REJECT.SECRET_INVALID);
});

test('秘密鍵 短すぎ → 発行不可(secret_invalid)', async () => {
  const res = await issuePaidSessionCookie({ membership: paidMember(), secret: 'short', now: NOW, subtle });
  assert.equal(res.ok, false);
  assert.equal(res.reason, ISSUE_REJECT.SECRET_INVALID);
});

test('checkSigningSecret: 未設定/短い は false、十分な長さは true', () => {
  assert.equal(checkSigningSecret(undefined).ok, false);
  assert.equal(checkSigningSecret('short').ok, false);
  assert.equal(checkSigningSecret(TEST_SECRET).ok, true);
});

test('logout Cookie は ak_session を Max-Age=0・同一属性で削除', () => {
  const c = buildLogoutCookie();
  assert.match(c, /^ak_session=;/);
  assert.match(c, /Max-Age=0/);
  assert.match(c, /Path=\//);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  // secret / payload が漏れていない
  assert.ok(!c.includes(TEST_SECRET));
});

test('発行結果に secret / payload 本文が混入しない（Cookie は token のみ）', async () => {
  const res = await issuePaidSessionCookie({ membership: paidMember(), secret: TEST_SECRET, now: NOW, subtle });
  assert.ok(!res.cookie.includes(TEST_SECRET));
});
