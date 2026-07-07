/**
 * session.test.mjs — 有料セッション 署名/検証/payload/cookie のテーブル駆動テスト
 *   node --test src/lib/auth/session.test.mjs
 *
 * ※ TEST_SECRET / OTHER_SECRET は **テスト専用の固定鍵**。本番用途では絶対に使わない。
 *   本番は SESSION_SIGNING_SECRET（PR-B 以降で Netlify 環境変数から注入）を使う。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSession, verifySession, VERIFY_REJECT } from './session.js';
import { validatePayload, buildPayload, PAYLOAD_REJECT } from './sessionPayload.js';
import { serializeSessionCookie, serializeLogoutCookie, readSessionCookie } from './sessionCookie.js';
import { SecretError } from './sessionCrypto.js';
import { signHmac } from './sessionCrypto.js';
import { utf8ToBase64url } from './encoding.js';
import { SESSION_SCHEMA_VERSION, MAX_SESSION_TTL_MS } from './constants.js';

// --- テスト専用固定鍵（NOT for production） -------------------------------
const TEST_SECRET = 'test-only-fixed-hmac-secret-DO-NOT-USE-IN-PROD-0123456789';
const OTHER_SECRET = 'test-only-different-hmac-key-DO-NOT-USE-IN-PROD-zyxwvut987';
const NOW = 1_750_000_000_000; // 固定 ms epoch（決定的テストのため Date.now は使わない）
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DEFAULT_TTL = 20 * MINUTE; // 通常 TTL（絶対上限 30 分の範囲内）
const subtle = globalThis.crypto.subtle;

function validPayload(over = {}) {
  return {
    v: SESSION_SCHEMA_VERSION,
    sub: 'recABC123',
    plan: 'light',
    venueAccess: ['jra'],
    sessionVersion: 0,
    issuedAt: NOW,
    expiresAt: NOW + DEFAULT_TTL,
    ...over,
  };
}

// 任意の payload を正しい鍵で署名してトークン化（validatePayload の全経路を実 verify で叩くため）
async function mintToken(payloadObj, secret = TEST_SECRET) {
  const part = utf8ToBase64url(JSON.stringify(payloadObj));
  const sig = await signHmac({ secret, signingInput: part, subtle });
  return `${part}.${sig}`;
}

async function issue(over = {}, opts = {}) {
  return createSession({
    secret: TEST_SECRET,
    sub: over.sub ?? 'recABC123',
    plan: over.plan ?? 'light',
    venueAccess: over.venueAccess ?? ['jra'],
    sessionVersion: over.sessionVersion,
    now: NOW,
    ttlMs: over.ttlMs ?? DEFAULT_TTL,
    subtle,
    ...opts,
  });
}

// =========================================================================
// 成功系
// =========================================================================

test('1. 正常payloadを署名・検証できる（round-trip）', async () => {
  const { token, payload } = await issue();
  const res = await verifySession({ token, secret: TEST_SECRET, now: NOW, subtle });
  assert.equal(res.ok, true);
  assert.deepEqual(res.payload, payload);
  assert.equal(res.payload.sub, 'recABC123');
});

test('2. Node の Web Crypto (globalThis.crypto.subtle) で検証できる', async () => {
  assert.ok(globalThis.crypto && globalThis.crypto.subtle, 'WebCrypto subtle must exist');
  // subtle を明示注入せず globalThis 経由でも通ること
  const { token } = await createSession({
    secret: TEST_SECRET, sub: 'recX', plan: 'premium', venueAccess: 'all', now: NOW, ttlMs: DEFAULT_TTL,
  });
  const res = await verifySession({ token, secret: TEST_SECRET, now: NOW });
  assert.equal(res.ok, true);
});

test('3. Unicodeを含まない最小payloadで安定する', async () => {
  const { token } = await issue({ sub: 'rec0001', plan: 'light', venueAccess: ['jra'] });
  const res = await verifySession({ token, secret: TEST_SECRET, now: NOW, subtle });
  assert.equal(res.ok, true);
});

const OK_PLANS = [
  ['4. Light', 'light'],
  ['5. Premium', 'premium'],
  ['6. 三連複 premium-sanrenpuku', 'premium-sanrenpuku'],
  ['7. 三連単 premium-sanrentan', 'premium-sanrentan'],
];
for (const [name, plan] of OK_PLANS) {
  test(`${name} を発行・検証できる`, async () => {
    const { token, payload } = await issue({ plan });
    assert.equal(payload.plan, plan);
    const res = await verifySession({ token, secret: TEST_SECRET, now: NOW, subtle });
    assert.equal(res.ok, true);
    assert.equal(res.payload.plan, plan);
  });
}

const OK_VENUES = [
  ['jra のみ', 'jra', ['jra']],
  ['nankan のみ', 'nankan', ['nankan']],
  ['all → jra+nankan 展開', 'all', ['jra', 'nankan']],
  ['配列入力 [nankan,jra] → 正規順', ['nankan', 'jra'], ['jra', 'nankan']],
];
for (const [name, input, expected] of OK_VENUES) {
  test(`8. VenueAccess: ${name}`, async () => {
    const { payload } = await issue({ venueAccess: input });
    assert.deepEqual(payload.venueAccess, expected);
  });
}

test('9. Cookie serialize 属性が固定される', () => {
  const cookie = serializeSessionCookie('tok.tok', { maxAgeSeconds: 3600 });
  assert.match(cookie, /^ak_session=tok\.tok;/);
  assert.match(cookie, /Max-Age=3600/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  // round-trip: readSessionCookie で値を取り戻せる
  assert.equal(readSessionCookie('a=1; ak_session=tok.tok; b=2'), 'tok.tok');
});

test('10. logout Cookie 属性（Max-Age=0・同一属性）', () => {
  const cookie = serializeLogoutCookie();
  assert.match(cookie, /^ak_session=;/);
  assert.match(cookie, /Max-Age=0/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
});

// =========================================================================
// 拒否系（verifySession 経路 / validatePayload 直接）
// =========================================================================

test('11. Cookie 無し → missing_cookie', async () => {
  const res = await verifySession({ secret: TEST_SECRET, now: NOW, subtle });
  assert.equal(res.ok, false);
  assert.equal(res.reason, VERIFY_REJECT.MISSING_COOKIE);
});

test('12. 空文字 → missing_cookie', async () => {
  const res = await verifySession({ token: '', secret: TEST_SECRET, now: NOW, subtle });
  assert.equal(res.ok, false);
  assert.equal(res.reason, VERIFY_REJECT.MISSING_COOKIE);
});

const MALFORMED = [
  ['区切り不足（0個）', 'abcdef'],
  ['区切り過剰（2個）', 'aaa.bbb.ccc'],
  ['payload 部が空', '.bbb'],
  ['signature 部が空', 'aaa.'],
];
for (const [name, token] of MALFORMED) {
  test(`13. ${name} → malformed_token`, async () => {
    const res = await verifySession({ token, secret: TEST_SECRET, now: NOW, subtle });
    assert.equal(res.ok, false);
    assert.equal(res.reason, VERIFY_REJECT.MALFORMED_TOKEN);
  });
}

test('14. base64url 破損（署名は正当だが payload が base64url でない）→ base64url_decode_error', async () => {
  // 署名対象は payloadPart そのもの。base64url 不正文字列を正しい鍵で署名する
  const badPart = '@@@not-base64url@@@';
  const sig = await signHmac({ secret: TEST_SECRET, signingInput: badPart, subtle });
  const res = await verifySession({ token: `${badPart}.${sig}`, secret: TEST_SECRET, now: NOW, subtle });
  assert.equal(res.ok, false);
  assert.equal(res.reason, VERIFY_REJECT.DECODE_ERROR);
});

test('15. JSON 破損 → json_parse_error', async () => {
  const part = utf8ToBase64url('this is not json {{{');
  const sig = await signHmac({ secret: TEST_SECRET, signingInput: part, subtle });
  const res = await verifySession({ token: `${part}.${sig}`, secret: TEST_SECRET, now: NOW, subtle });
  assert.equal(res.ok, false);
  assert.equal(res.reason, VERIFY_REJECT.JSON_ERROR);
});

test('16. payload 改ざん → signature_invalid', async () => {
  const { token } = await issue();
  const [part, sig] = token.split('.');
  const tampered = (part[0] === 'A' ? 'B' : 'A') + part.slice(1);
  const res = await verifySession({ token: `${tampered}.${sig}`, secret: TEST_SECRET, now: NOW, subtle });
  assert.equal(res.ok, false);
  assert.equal(res.reason, VERIFY_REJECT.SIGNATURE_INVALID);
});

test('17. signature 改ざん → signature_invalid', async () => {
  const { token } = await issue();
  const [part, sig] = token.split('.');
  const tampered = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
  const res = await verifySession({ token: `${part}.${tampered}`, secret: TEST_SECRET, now: NOW, subtle });
  assert.equal(res.ok, false);
  assert.equal(res.reason, VERIFY_REJECT.SIGNATURE_INVALID);
});

test('18. 別鍵による検証 → signature_invalid', async () => {
  const { token } = await issue();
  const res = await verifySession({ token, secret: OTHER_SECRET, now: NOW, subtle });
  assert.equal(res.ok, false);
  assert.equal(res.reason, VERIFY_REJECT.SIGNATURE_INVALID);
});

test('19. 期限切れ → expired（skew 猶予を足さない）', async () => {
  const { token } = await issue({ ttlMs: DEFAULT_TTL });
  // expiresAt (NOW+20分) を 1ms でも過ぎたら expired（skew の 5 分猶予は効かない）
  const res = await verifySession({ token, secret: TEST_SECRET, now: NOW + DEFAULT_TTL + 1, subtle });
  assert.equal(res.ok, false);
  assert.equal(res.reason, PAYLOAD_REJECT.EXPIRED);
});

test('20. issuedAt 未来異常 → issued_in_future', async () => {
  // TTL は上限内（20 分）に保ちつつ issuedAt を未来へ（TTL_EXCEEDED と混同しない）
  const token = await mintToken(validPayload({ issuedAt: NOW + 60 * MINUTE, expiresAt: NOW + 60 * MINUTE + DEFAULT_TTL }));
  const res = await verifySession({ token, secret: TEST_SECRET, now: NOW, subtle });
  assert.equal(res.ok, false);
  assert.equal(res.reason, PAYLOAD_REJECT.ISSUED_IN_FUTURE);
});

test('21. expiresAt <= issuedAt → expires_not_after_issued', () => {
  const res = validatePayload(validPayload({ expiresAt: NOW }), { now: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.reason, PAYLOAD_REJECT.EXPIRES_NOT_AFTER_ISSUED);
});

test('22. TTL 上限超過 → ttl_exceeded', () => {
  const res = validatePayload(validPayload({ expiresAt: NOW + MAX_SESSION_TTL_MS + 1 }), { now: NOW });
  assert.equal(res.ok, false);
  assert.equal(res.reason, PAYLOAD_REJECT.TTL_EXCEEDED);
});

// --- TTL 絶対上限（30 分）境界 ------------------------------------------
// 絶対最大 TTL は 30 分。生成側（createSession）・検証側（外部 mintToken）の
// 両経路で、上限内は成功・超過は ttl_exceeded で拒否されること。
assert.equal(MAX_SESSION_TTL_MS, 30 * MINUTE, 'MAX_SESSION_TTL_MS は 30 分であること');

const TTL_BOUNDARY = [
  ['20分', 20 * MINUTE, true],
  ['30分ちょうど', 30 * MINUTE, true],
  ['30分+1ms', 30 * MINUTE + 1, false],
  ['1時間', HOUR, false],
  ['30日', 30 * 24 * HOUR, false],
];

for (const [name, ttlMs, shouldPass] of TTL_BOUNDARY) {
  test(`22-生成側 TTL 境界: ${name} → ${shouldPass ? '成功' : 'ttl_exceeded'}`, async () => {
    if (shouldPass) {
      const { payload } = await issue({ ttlMs });
      assert.equal(payload.expiresAt - payload.issuedAt, ttlMs);
    } else {
      await assert.rejects(() => issue({ ttlMs }), (e) => e.code === PAYLOAD_REJECT.TTL_EXCEEDED);
    }
  });

  test(`22-検証側 外部payload TTL 境界: ${name} → ${shouldPass ? '成功' : 'ttl_exceeded'}`, async () => {
    // 外部から署名した（buildPayload を通らない）payload でも上限を強制する
    const token = await mintToken(validPayload({ issuedAt: NOW, expiresAt: NOW + ttlMs }));
    const res = await verifySession({ token, secret: TEST_SECRET, now: NOW, subtle });
    if (shouldPass) {
      assert.equal(res.ok, true);
    } else {
      assert.equal(res.ok, false);
      assert.equal(res.reason, PAYLOAD_REJECT.TTL_EXCEEDED);
    }
  });
}

test('23. version 不明 → unknown_version', async () => {
  const token = await mintToken(validPayload({ v: 2 }));
  const res = await verifySession({ token, secret: TEST_SECRET, now: NOW, subtle });
  assert.equal(res.ok, false);
  assert.equal(res.reason, PAYLOAD_REJECT.UNKNOWN_VERSION);
});

test('24. plan 不明 → unknown_plan', async () => {
  const token = await mintToken(validPayload({ plan: 'wizard' }));
  const res = await verifySession({ token, secret: TEST_SECRET, now: NOW, subtle });
  assert.equal(res.ok, false);
  assert.equal(res.reason, PAYLOAD_REJECT.UNKNOWN_PLAN);
});

test('25. free plan → free_plan_not_allowed（validate / build / create すべて拒否）', async () => {
  const vres = validatePayload(validPayload({ plan: 'free' }), { now: NOW });
  assert.equal(vres.reason, PAYLOAD_REJECT.FREE_PLAN);

  const bres = buildPayload({ sub: 'r', plan: 'free', venueAccess: ['jra'], issuedAt: NOW, ttlMs: HOUR });
  assert.equal(bres.ok, false);
  assert.equal(bres.reason, PAYLOAD_REJECT.FREE_PLAN);

  await assert.rejects(
    () => issue({ plan: 'free' }),
    (err) => err.code === PAYLOAD_REJECT.FREE_PLAN,
  );
});

test('26. venue 不明 → unknown_venue', async () => {
  const token = await mintToken(validPayload({ venueAccess: ['mars'] }));
  const res = await verifySession({ token, secret: TEST_SECRET, now: NOW, subtle });
  assert.equal(res.ok, false);
  assert.equal(res.reason, PAYLOAD_REJECT.UNKNOWN_VENUE);
});

test('27. sessionVersion 欠落 → missing_session_version', () => {
  const p = validPayload();
  delete p.sessionVersion;
  const res = validatePayload(p, { now: NOW });
  assert.equal(res.reason, PAYLOAD_REJECT.MISSING_SESSION_VERSION);
});

test('28. sessionVersion 負数 → invalid_session_version', () => {
  const res = validatePayload(validPayload({ sessionVersion: -1 }), { now: NOW });
  assert.equal(res.reason, PAYLOAD_REJECT.INVALID_SESSION_VERSION);
});

test('28b. sessionVersion 正の整数を保持できる', async () => {
  const { payload } = await issue({ sessionVersion: 7 });
  assert.equal(payload.sessionVersion, 7);
});

test('29. sub 欠落 → missing_sub', () => {
  const p = validPayload();
  delete p.sub;
  const res = validatePayload(p, { now: NOW });
  assert.equal(res.reason, PAYLOAD_REJECT.MISSING_SUB);
});

test('30. 鍵欠落 → verify は key_missing / create は SecretError', async () => {
  const { token } = await issue();
  const res = await verifySession({ token, secret: '', now: NOW, subtle });
  assert.equal(res.ok, false);
  assert.equal(res.reason, VERIFY_REJECT.KEY_MISSING);

  await assert.rejects(() => issue({}, { secret: '' }), (e) => e instanceof SecretError && e.code === 'empty');
});

test('31. 鍵が短すぎる → key_missing / SecretError(too_short)', async () => {
  const shortKey = 'short';
  await assert.rejects(
    () => createSession({ secret: shortKey, sub: 'r', plan: 'light', venueAccess: ['jra'], now: NOW, ttlMs: HOUR, subtle }),
    (e) => e instanceof SecretError && e.code === 'too_short',
  );
  const { token } = await issue();
  const res = await verifySession({ token, secret: shortKey, now: NOW, subtle });
  assert.equal(res.reason, VERIFY_REJECT.KEY_MISSING);
});

test('32. 配列 payload → payload_is_array', () => {
  const res = validatePayload([1, 2, 3], { now: NOW });
  assert.equal(res.reason, PAYLOAD_REJECT.IS_ARRAY);
});

test('33. null payload → payload_not_object', () => {
  assert.equal(validatePayload(null, { now: NOW }).reason, PAYLOAD_REJECT.NOT_OBJECT);
  assert.equal(validatePayload('x', { now: NOW }).reason, PAYLOAD_REJECT.NOT_OBJECT);
  assert.equal(validatePayload(42, { now: NOW }).reason, PAYLOAD_REJECT.NOT_OBJECT);
});

test('34. 余計な機密フィールドを含む payload → unexpected_field', async () => {
  const withSecretField = validPayload({ points: 5000, email: 'x@y.z', name: '山田' });
  assert.equal(validatePayload(withSecretField, { now: NOW }).reason, PAYLOAD_REJECT.UNEXPECTED_FIELD);
  // 署名済みでも拒否されること
  const token = await mintToken(withSecretField);
  const res = await verifySession({ token, secret: TEST_SECRET, now: NOW, subtle });
  assert.equal(res.reason, PAYLOAD_REJECT.UNEXPECTED_FIELD);
});

test('35. 例外時に秘密鍵・payload がメッセージへ含まれない', async () => {
  // (a) SecretError は鍵の中身（値）を含まず、コードだけを持つ
  const secretVal = 'super-secret-value-should-never-appear-in-any-message-1234';
  try {
    await createSession({ secret: secretVal.slice(0, 5), sub: 'r', plan: 'light', venueAccess: ['jra'], now: NOW, ttlMs: HOUR });
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof SecretError);
    assert.equal(e.message, 'session secret rejected: too_short');
    assert.ok(!e.message.includes(secretVal.slice(0, 5)));
  }

  // (b) subtle が例外を投げても internal_error のみ返し、secret/payload を漏らさない
  const throwingSubtle = {
    importKey: async () => { throw new Error(`boom ${secretVal}`); },
    sign: async () => { throw new Error('x'); },
    verify: async () => { throw new Error('x'); },
  };
  const { token } = await issue();
  const res = await verifySession({ token, secret: TEST_SECRET, now: NOW, subtle: throwingSubtle });
  assert.equal(res.ok, false);
  assert.equal(res.reason, VERIFY_REJECT.INTERNAL_ERROR);
  assert.deepEqual(Object.keys(res).sort(), ['ok', 'reason']); // 余計なフィールドを返さない
  assert.ok(!JSON.stringify(res).includes(secretVal));
  assert.ok(!JSON.stringify(res).includes('recABC123'));
});
