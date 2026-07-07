/**
 * session.test.js — 有料セッション共通ライブラリの単体テスト（PR-A）
 *
 * ⚠️ ここで使う SECRET は「テスト専用の固定鍵」であり本番用途では絶対に使わない。
 *    本番の署名鍵は Netlify 環境変数 SESSION_SIGNING_SECRET を PR-B 以降の
 *    呼び出し側で注入する（このライブラリは鍵を引数でしか受け取らない）。
 *
 * 実行: node src/lib/session/session.test.js （astro-site 直下から）
 */
import assert from 'assert';
import {
  createSession,
  verifySession,
  serializeSessionCookie,
  serializeLogoutCookie,
  MAX_TTL_SECONDS,
} from './index.js';
import { jsonToBase64url, bytesToBase64url, stringToBytes } from './base64url.js';
import { hmacSign } from './crypto.js';

// テスト専用固定鍵（本番禁止・32文字以上）
const SECRET = 'test-only-fixed-secret-key-do-not-use-in-production-0001';
const OTHER_SECRET = 'test-only-different-secret-key-also-not-production-9999';
const NOW = 1_700_000_000; // 固定 epoch 秒
const TTL = 20 * 60; // 20 分

const BASE_INPUT = { sub: 'recABC123DEF456', plan: 'premium', venueAccess: 'all', sessionVersion: 0 };

let pass = 0, fail = 0;
const cases = [];
const t = (name, fn) => cases.push({ name, fn });

// 任意 payload（object/array/null など）を正規署名してトークン化するヘルパ（負テスト用）
async function signRaw(value) {
  const payloadB64 = jsonToBase64url(value);
  const sig = await hmacSign(SECRET, payloadB64);
  return `${payloadB64}.${bytesToBase64url(sig)}`;
}
// 非 JSON 文字列を payload 部にして正規署名（BAD_JSON 用）
async function signRawString(str) {
  const payloadB64 = bytesToBase64url(stringToBytes(str));
  const sig = await hmacSign(SECRET, payloadB64);
  return `${payloadB64}.${bytesToBase64url(sig)}`;
}
const validPayload = (over = {}) => ({
  v: 1, sub: 'recABC123DEF456', plan: 'premium', venueAccess: 'all',
  sessionVersion: 0, issuedAt: NOW, expiresAt: NOW + TTL, ...over,
});

// ───────────── 成功系 ─────────────
t('01 正常payloadを署名・検証できる', async () => {
  const token = await createSession(BASE_INPUT, SECRET, { ttlSeconds: TTL, now: NOW });
  const r = await verifySession(token, SECRET, { now: NOW });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.payload.plan, 'premium');
  assert.strictEqual(r.payload.sub, 'recABC123DEF456');
});

t('02 Node 20のグローバルWeb Cryptoで検証できる（crypto引数なし）', async () => {
  assert.ok(globalThis.crypto && globalThis.crypto.subtle, 'globalThis.crypto.subtle が必要');
  const token = await createSession(BASE_INPUT, SECRET, { ttlSeconds: TTL, now: NOW });
  const r = await verifySession(token, SECRET, { now: NOW });
  assert.strictEqual(r.valid, true);
});

t('03 Unicodeを含まない最小payloadで安定する', async () => {
  const token = await createSession({ sub: 'abc', plan: 'premium', sessionVersion: 0 }, SECRET, { ttlSeconds: 60, now: NOW });
  const r = await verifySession(token, SECRET, { now: NOW });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.payload.venueAccess, 'all'); // 未指定→all
});

t('04 正常なLight', async () => {
  const token = await createSession({ ...BASE_INPUT, plan: 'standard' }, SECRET, { ttlSeconds: TTL, now: NOW });
  const r = await verifySession(token, SECRET, { now: NOW });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.payload.plan, 'light'); // standard→light 正規化
});

t('05 正常なPremium', async () => {
  const token = await createSession({ ...BASE_INPUT, plan: 'プレミアム' }, SECRET, { ttlSeconds: TTL, now: NOW });
  const r = await verifySession(token, SECRET, { now: NOW });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.payload.plan, 'premium');
});

t('06 正常な三連複', async () => {
  const token = await createSession({ ...BASE_INPUT, plan: 'Premium Sanrenpuku' }, SECRET, { ttlSeconds: TTL, now: NOW });
  const r = await verifySession(token, SECRET, { now: NOW });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.payload.plan, 'premium-sanrenpuku');
});

t('07 正常な三連単', async () => {
  const token = await createSession({ ...BASE_INPUT, plan: '三連単' }, SECRET, { ttlSeconds: TTL, now: NOW });
  const r = await verifySession(token, SECRET, { now: NOW });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.payload.plan, 'premium-sanrentan');
});

t('08 VenueAccess別の正常ケース（all/jra/nankan）', async () => {
  for (const [inp, exp] of [['all', 'all'], ['jra', 'jra'], ['nankan', 'nankan'], ['中央', 'jra']]) {
    const token = await createSession({ ...BASE_INPUT, venueAccess: inp }, SECRET, { ttlSeconds: TTL, now: NOW });
    const r = await verifySession(token, SECRET, { now: NOW });
    assert.strictEqual(r.valid, true, `venue ${inp}`);
    assert.strictEqual(r.payload.venueAccess, exp);
  }
});

t('09 Cookie serialize属性が固定', () => {
  const c = serializeSessionCookie('tok.tok', { maxAgeSeconds: 1200 });
  assert.ok(/^ak_session=tok\.tok;/.test(c));
  assert.ok(/Max-Age=1200/.test(c));
  assert.ok(/HttpOnly/.test(c) && /Secure/.test(c) && /SameSite=Lax/.test(c) && /Path=\//.test(c));
});

t('10 logout Cookie属性（Max-Age=0・同一属性）', () => {
  const c = serializeLogoutCookie();
  assert.ok(/^ak_session=;/.test(c));
  assert.ok(/Max-Age=0/.test(c));
  assert.ok(/HttpOnly/.test(c) && /Secure/.test(c) && /SameSite=Lax/.test(c) && /Path=\//.test(c));
});

// ───────────── 拒否系 ─────────────
const expectInvalid = async (token, reason, secret = SECRET) => {
  const r = await verifySession(token, secret, { now: NOW });
  assert.strictEqual(r.valid, false, `expected invalid (${reason})`);
  assert.strictEqual(r.reason, reason, `reason: got ${r.reason}, want ${reason}`);
};

t('11 Cookie無し（null/undefined）→ MISSING', async () => {
  await expectInvalid(undefined, 'MISSING');
  await expectInvalid(null, 'MISSING');
});
t('12 空文字 → MISSING', async () => { await expectInvalid('', 'MISSING'); });
t('13 区切り不足・過剰 → MALFORMED', async () => {
  await expectInvalid('onlyonepart', 'MALFORMED');
  await expectInvalid('a.b.c', 'MALFORMED');
  await expectInvalid('.', 'MALFORMED');
});
t('14 base64url破損（署名部）→ BAD_BASE64', async () => {
  const good = await createSession(BASE_INPUT, SECRET, { ttlSeconds: TTL, now: NOW });
  const payloadB64 = good.split('.')[0];
  await expectInvalid(`${payloadB64}.@@@invalid@@@`, 'BAD_BASE64');
});
t('15 JSON破損（署名は正規）→ BAD_JSON', async () => {
  await expectInvalid(await signRawString('this-is-not-json'), 'BAD_JSON');
});
t('16 payload改ざん → TAMPERED', async () => {
  const good = await createSession(BASE_INPUT, SECRET, { ttlSeconds: TTL, now: NOW });
  const [p, s] = good.split('.');
  const flipped = (p[0] === 'A' ? 'B' : 'A') + p.slice(1);
  await expectInvalid(`${flipped}.${s}`, 'TAMPERED');
});
t('17 signature改ざん → TAMPERED', async () => {
  const good = await createSession(BASE_INPUT, SECRET, { ttlSeconds: TTL, now: NOW });
  const [p, s] = good.split('.');
  const flipped = (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
  await expectInvalid(`${p}.${flipped}`, 'TAMPERED');
});
t('18 別鍵による検証 → TAMPERED', async () => {
  const good = await createSession(BASE_INPUT, SECRET, { ttlSeconds: TTL, now: NOW });
  await expectInvalid(good, 'TAMPERED', OTHER_SECRET);
});
t('19 期限切れ → EXPIRED', async () => {
  const token = await createSession(BASE_INPUT, SECRET, { ttlSeconds: TTL, now: NOW });
  const r = await verifySession(token, SECRET, { now: NOW + TTL + 1 });
  assert.strictEqual(r.valid, false); assert.strictEqual(r.reason, 'EXPIRED');
});
t('20 issuedAt未来異常 → ISSUED_IN_FUTURE', async () => {
  await expectInvalid(await signRaw(validPayload({ issuedAt: NOW + 10000, expiresAt: NOW + 10000 + TTL })), 'ISSUED_IN_FUTURE');
});
t('21 expiresAt <= issuedAt → EXPIRES_BEFORE_ISSUED', async () => {
  await expectInvalid(await signRaw(validPayload({ expiresAt: NOW })), 'EXPIRES_BEFORE_ISSUED');
});
t('22 TTL上限超過 → TTL_EXCEEDED', async () => {
  await expectInvalid(await signRaw(validPayload({ expiresAt: NOW + MAX_TTL_SECONDS + 10 })), 'TTL_EXCEEDED');
});
t('23 version不明 → UNKNOWN_VERSION', async () => {
  await expectInvalid(await signRaw(validPayload({ v: 999 })), 'UNKNOWN_VERSION');
});
t('24 plan不明 → UNKNOWN_PLAN', async () => {
  await expectInvalid(await signRaw(validPayload({ plan: 'gold' })), 'UNKNOWN_PLAN');
});
t('25 free plan（署名は正規でも拒否 / 生成も不可）→ FREE_PLAN', async () => {
  await expectInvalid(await signRaw(validPayload({ plan: 'free' })), 'FREE_PLAN');
  await assert.rejects(() => createSession({ ...BASE_INPUT, plan: 'free' }, SECRET, { ttlSeconds: TTL, now: NOW }),
    (e) => e.message === 'SESSION_CREATE_FREE_PLAN');
});
t('26 venue不明 → UNKNOWN_VENUE', async () => {
  await expectInvalid(await signRaw(validPayload({ venueAccess: 'mars' })), 'UNKNOWN_VENUE');
});
t('27 sessionVersion欠落 → MISSING_KEY', async () => {
  const p = validPayload(); delete p.sessionVersion;
  await expectInvalid(await signRaw(p), 'MISSING_KEY');
});
t('28 sessionVersion負数 → BAD_SESSION_VERSION', async () => {
  await expectInvalid(await signRaw(validPayload({ sessionVersion: -1 })), 'BAD_SESSION_VERSION');
});
t('29 sub欠落 → MISSING_KEY', async () => {
  const p = validPayload(); delete p.sub;
  await expectInvalid(await signRaw(p), 'MISSING_KEY');
});
t('30 鍵欠落 → NO_SECRET（生成は BAD_SECRET）', async () => {
  const token = await createSession(BASE_INPUT, SECRET, { ttlSeconds: TTL, now: NOW });
  // 既定引数を避けるため verifySession を直接呼ぶ（undefined/null を明示的に渡す）
  let r = await verifySession(token, undefined, { now: NOW });
  assert.strictEqual(r.valid, false); assert.strictEqual(r.reason, 'NO_SECRET');
  r = await verifySession(token, null, { now: NOW });
  assert.strictEqual(r.valid, false); assert.strictEqual(r.reason, 'NO_SECRET');
  await assert.rejects(() => createSession(BASE_INPUT, undefined, { ttlSeconds: TTL, now: NOW }),
    (e) => e.message === 'SESSION_CREATE_BAD_SECRET');
});
t('31 鍵が短すぎる → NO_SECRET（生成は BAD_SECRET）', async () => {
  const token = await createSession(BASE_INPUT, SECRET, { ttlSeconds: TTL, now: NOW });
  await expectInvalid(token, 'NO_SECRET', 'short-key');
  await assert.rejects(() => createSession(BASE_INPUT, 'short-key', { ttlSeconds: TTL, now: NOW }),
    (e) => e.message === 'SESSION_CREATE_BAD_SECRET');
});
t('32 配列payload → PAYLOAD_ARRAY', async () => {
  await expectInvalid(await signRaw(['premium']), 'PAYLOAD_ARRAY');
});
t('33 null payload → PAYLOAD_NOT_OBJECT', async () => {
  await expectInvalid(await signRaw(null), 'PAYLOAD_NOT_OBJECT');
});
t('34 生成時に余計な機密フィールドを payload へ含めない', async () => {
  const token = await createSession(
    { ...BASE_INPUT, points: 9999, name: '山田太郎', password: 'secret', recordAll: { a: 1 } },
    SECRET, { ttlSeconds: TTL, now: NOW });
  const r = await verifySession(token, SECRET, { now: NOW });
  assert.strictEqual(r.valid, true);
  assert.deepStrictEqual(
    Object.keys(r.payload).sort(),
    ['expiresAt', 'issuedAt', 'plan', 'sessionVersion', 'sub', 'v', 'venueAccess'],
  );
  assert.ok(!('points' in r.payload) && !('name' in r.payload) && !('password' in r.payload));
});
t('35 失敗時に秘密鍵・payloadがメッセージへ含まれない', async () => {
  // 生成エラーの message に secret/sub が出ない
  let msg = '';
  try { await createSession(BASE_INPUT, 'short', { ttlSeconds: TTL, now: NOW }); } catch (e) { msg = e.message; }
  assert.ok(!msg.includes('short') && !msg.includes(BASE_INPUT.sub), 'error message leaks secret/sub');
  // 検証 reason に secret が出ない（列挙値のみ）
  const good = await createSession(BASE_INPUT, SECRET, { ttlSeconds: TTL, now: NOW });
  const r = await verifySession(good, OTHER_SECRET, { now: NOW });
  assert.ok(!String(r.reason).includes(OTHER_SECRET) && !String(r.reason).includes(SECRET));
});

// runner
(async () => {
  for (const c of cases) {
    try { await c.fn(); pass++; console.log(`  ✅ ${c.name}`); }
    catch (e) { fail++; console.error(`  ❌ ${c.name}\n     ${e.message}`); }
  }
  console.log(`\nsession.test.js: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
