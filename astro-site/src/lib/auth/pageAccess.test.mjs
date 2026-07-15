/**
 * pageAccess.test.mjs — Premium Plus 等の SSR プラン認可（存在秘匿・fail closed）
 *   node --test src/lib/auth/pageAccess.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyPlanAccess, PAGE_ACCESS_REJECT, PREMIUM_PLUS_ALLOWED_PLANS } from './pageAccess.js';
import { createSessionV2 } from './session.js';
import { SESSION_COOKIE_NAME, ABSOLUTE_SESSION_TTL_MS } from './constants.js';

const SECRET = 'test-secret-value-at-least-32-characters-long!!';
const NOW = 1_800_000_000_000;

async function mintCookie({ plan, now = NOW, ttlMs = 20 * 60 * 1000, sessionStart = now, sub = 'recABC123' }) {
  const { token } = await createSessionV2({
    sub,
    plan,
    venueAccess: ['jra', 'nankan'],
    sessionVersion: 1,
    now,
    ttlMs,
    sessionStart,
    secret: SECRET,
  });
  return `${SESSION_COOKIE_NAME}=${token}`;
}

// 1. premium-sanrenpuku 会員 → 許可
test('#1 premium-sanrenpuku Cookie → ok', async () => {
  const cookieHeader = await mintCookie({ plan: 'premium-sanrenpuku' });
  const r = await verifyPlanAccess({ cookieHeader, secret: SECRET, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.plan, 'premium-sanrenpuku');
});

// 2. premium-combo 会員 → 許可
test('#2 premium-combo Cookie → ok', async () => {
  const cookieHeader = await mintCookie({ plan: 'premium-combo' });
  const r = await verifyPlanAccess({ cookieHeader, secret: SECRET, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.plan, 'premium-combo');
});

// 3. premium（無印）→ 非該当で拒否（存在秘匿）
test('#3 premium は非該当 → PLAN_NOT_ALLOWED', async () => {
  const cookieHeader = await mintCookie({ plan: 'premium' });
  const r = await verifyPlanAccess({ cookieHeader, secret: SECRET, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, PAGE_ACCESS_REJECT.PLAN_NOT_ALLOWED);
});

// 4. Cookie 無し → NO_COOKIE
test('#4 Cookie 無し → NO_COOKIE', async () => {
  const r = await verifyPlanAccess({ cookieHeader: '', secret: SECRET, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, PAGE_ACCESS_REJECT.NO_COOKIE);
});

// 5. 別 Cookie のみ（ak_session 無し）→ NO_COOKIE
test('#5 無関係な Cookie のみ → NO_COOKIE', async () => {
  const r = await verifyPlanAccess({ cookieHeader: 'foo=bar; baz=qux', secret: SECRET, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, PAGE_ACCESS_REJECT.NO_COOKIE);
});

// 6. 秘密鍵未設定 → KEY_MISSING（fail closed）
test('#6 秘密鍵未設定 → KEY_MISSING', async () => {
  const cookieHeader = await mintCookie({ plan: 'premium-sanrenpuku' });
  for (const secret of [undefined, '', 'short']) {
    const r = await verifyPlanAccess({ cookieHeader, secret, now: NOW });
    assert.equal(r.ok, false, `secret=${JSON.stringify(secret)}`);
    assert.equal(r.reason, PAGE_ACCESS_REJECT.KEY_MISSING);
  }
});

// 7. 署名改竄 → VERIFY_FAILED
test('#7 署名改竄トークン → VERIFY_FAILED', async () => {
  const cookieHeader = (await mintCookie({ plan: 'premium-sanrenpuku' })) + 'TAMPER';
  const r = await verifyPlanAccess({ cookieHeader, secret: SECRET, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, PAGE_ACCESS_REJECT.VERIFY_FAILED);
});

// 8. 別鍵で署名された Cookie → VERIFY_FAILED
test('#8 別鍵署名 → VERIFY_FAILED', async () => {
  const { token } = await createSessionV2({
    sub: 'recX', plan: 'premium-sanrenpuku', venueAccess: ['jra', 'nankan'],
    sessionVersion: 1, now: NOW, ttlMs: 20 * 60 * 1000,
    secret: 'another-secret-at-least-32-characters-long-x!!',
  });
  const r = await verifyPlanAccess({ cookieHeader: `${SESSION_COOKIE_NAME}=${token}`, secret: SECRET, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, PAGE_ACCESS_REJECT.VERIFY_FAILED);
});

// 9. idle 期限切れ → VERIFY_FAILED
test('#9 idle 期限切れ → VERIFY_FAILED', async () => {
  const cookieHeader = await mintCookie({ plan: 'premium-sanrenpuku', ttlMs: 20 * 60 * 1000 });
  const r = await verifyPlanAccess({ cookieHeader, secret: SECRET, now: NOW + 21 * 60 * 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, PAGE_ACCESS_REJECT.VERIFY_FAILED);
});

// 10. 絶対 TTL（12h）超過 → VERIFY_FAILED
test('#10 絶対 TTL 超過 → VERIFY_FAILED', async () => {
  // sessionStart を 12h より前にし、idle は生きているが絶対 TTL 超過
  const sessionStart = NOW - ABSOLUTE_SESSION_TTL_MS - 1000;
  const cookieHeader = await mintCookie({ plan: 'premium-sanrenpuku', now: NOW, sessionStart });
  const r = await verifyPlanAccess({ cookieHeader, secret: SECRET, now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.reason, PAGE_ACCESS_REJECT.VERIFY_FAILED);
});

// 11. allowedPlans を明示上書きできる
test('#11 allowedPlans 明示上書き', async () => {
  const cookieHeader = await mintCookie({ plan: 'premium' });
  // premium を許可リストに入れれば通る
  const ok = await verifyPlanAccess({ cookieHeader, secret: SECRET, now: NOW, allowedPlans: ['premium'] });
  assert.equal(ok.ok, true);
  // premium-sanrenpuku 限定なら premium は落ちる
  const ng = await verifyPlanAccess({ cookieHeader, secret: SECRET, now: NOW, allowedPlans: ['premium-sanrenpuku'] });
  assert.equal(ng.ok, false);
  assert.equal(ng.reason, PAGE_ACCESS_REJECT.PLAN_NOT_ALLOWED);
});

// 12. 他の Cookie に混ざっていても ak_session を拾える
test('#12 複数 Cookie 中の ak_session を検証', async () => {
  const auth = await mintCookie({ plan: 'premium-combo' });
  const cookieHeader = `theme=dark; ${auth.replace(`${SESSION_COOKIE_NAME}=`, `${SESSION_COOKIE_NAME}=`)}; lang=ja`;
  const r = await verifyPlanAccess({ cookieHeader, secret: SECRET, now: NOW });
  assert.equal(r.ok, true);
});

// 13. 既定許可リストは premium-sanrenpuku / premium-combo のみ
test('#13 既定許可リストは 2 プランのみ', () => {
  assert.deepEqual([...PREMIUM_PLUS_ALLOWED_PLANS], ['premium-sanrenpuku', 'premium-combo']);
});
