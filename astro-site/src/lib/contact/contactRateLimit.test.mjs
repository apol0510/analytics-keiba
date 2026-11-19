/**
 * contactRateLimit.test.mjs — 問い合わせ Function の送信回数の上限と、premium-plus-contact の無害化を固定する
 * 実行: node --test src/lib/contact/contactRateLimit.test.mjs（astro-site 直下）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CONTACT_RATE_LIMITS, CONTACT_RATE_STORE, checkContactRateLimit, clientIp, hashKey, rateLimitedResponse,
} from './contactRateLimit.js';
import { normalizePremiumContactInput, MAX_SUBJECT_LENGTH, MAX_MESSAGE_LENGTH } from './contactForm.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

function memoryStore() {
  const m = new Map();
  return {
    m,
    get: async (k) => (m.has(k) ? structuredClone(m.get(k)) : null),
    set: async (k, v) => { m.set(k, structuredClone(v)); },
  };
}

const T0 = Date.UTC(2026, 10, 19, 12, 0, 0);

test('同じ IP は 1 時間に perIp 件まで・超えたら ip で止める', async () => {
  const store = memoryStore();
  for (let i = 0; i < CONTACT_RATE_LIMITS.perIp; i += 1) {
    const r = await checkContactRateLimit({ store, scope: 'contact-form', ip: '203.0.113.5', email: `u${i}@example.com`, now: T0 + i });
    assert.equal(r.allowed, true, `${i + 1} 件目`);
  }
  const over = await checkContactRateLimit({ store, scope: 'contact-form', ip: '203.0.113.5', email: 'other@example.com', now: T0 + 10 });
  assert.deepEqual(over, { allowed: false, reason: 'ip', degraded: false });
  // 止めた送信は数えない（other@ は増えていない）
  const otherKey = [...store.m.keys()].find((k) => k.startsWith('email/') && k.includes(hashKey('email', 'other@example.com')));
  assert.equal(otherKey, undefined);
});

test('同じ宛先メールは IP が違っても perEmail 件まで（大文字小文字・前後空白は同じ宛先）', async () => {
  const store = memoryStore();
  for (let i = 0; i < CONTACT_RATE_LIMITS.perEmail; i += 1) {
    const r = await checkContactRateLimit({ store, scope: 'contact-form', ip: `198.51.100.${i}`, email: 'Victim@Example.com', now: T0 });
    assert.equal(r.allowed, true);
  }
  const over = await checkContactRateLimit({ store, scope: 'premium-plus-contact', ip: '198.51.100.99', email: '  victim@example.com ', now: T0 });
  assert.equal(over.allowed, false);
  assert.equal(over.reason, 'email', '宛先の上限は 2 つの Function で共有する');
});

test('窓が変われば数え直す', async () => {
  const store = memoryStore();
  for (let i = 0; i < CONTACT_RATE_LIMITS.perEmail; i += 1) {
    await checkContactRateLimit({ store, scope: 'contact-form', ip: `192.0.2.${i}`, email: 'a@example.com', now: T0 });
  }
  assert.equal((await checkContactRateLimit({ store, scope: 'contact-form', ip: '192.0.2.50', email: 'a@example.com', now: T0 })).allowed, false);
  const next = await checkContactRateLimit({ store, scope: 'contact-form', ip: '192.0.2.50', email: 'a@example.com', now: T0 + CONTACT_RATE_LIMITS.windowMs });
  assert.equal(next.allowed, true);
});

test('保存先が無い・壊れているときは送信を止めない（fail-open・degraded）', async () => {
  assert.deepEqual(await checkContactRateLimit({ store: null, scope: 'contact-form', ip: '1.1.1.1', email: 'a@example.com' }),
    { allowed: true, reason: null, degraded: true });
  const broken = { get: async () => { throw new Error('blobs down'); }, set: async () => {} };
  const r = await checkContactRateLimit({ store: broken, scope: 'contact-form', ip: '1.1.1.1', email: 'a@example.com' });
  assert.equal(r.allowed, true);
  assert.equal(r.degraded, true);
});

test('保存キーに生の IP・メールを入れない', async () => {
  const store = memoryStore();
  await checkContactRateLimit({ store, scope: 'contact-form', ip: '203.0.113.7', email: 'secret.person@example.com', now: T0 });
  for (const k of store.m.keys()) {
    assert.equal(k.includes('203.0.113.7'), false);
    assert.equal(k.includes('secret.person'), false);
    assert.equal(k.includes('example.com'), false);
  }
  assert.equal(CONTACT_RATE_STORE, 'ak-contact-rate');
});

test('clientIp: Netlify の接続元 → x-forwarded-for の先頭 → null', () => {
  assert.equal(clientIp({ 'x-nf-client-connection-ip': '203.0.113.1', 'x-forwarded-for': '9.9.9.9' }), '203.0.113.1');
  assert.equal(clientIp({ 'x-forwarded-for': '203.0.113.2, 10.0.0.1' }), '203.0.113.2');
  assert.equal(clientIp({}), null);
  assert.equal(clientIp(undefined), null);
});

test('rateLimitedResponse: 429・Retry-After・案内文だけ（内部情報は返さない）', () => {
  const r = rateLimitedResponse({ 'Content-Type': 'application/json' });
  assert.equal(r.statusCode, 429);
  assert.equal(r.headers['Retry-After'], '3600');
  assert.deepEqual(Object.keys(JSON.parse(r.body)), ['error']);
});

test('normalizePremiumContactInput: 必須・メール形式・長さ', () => {
  const ok = normalizePremiumContactInput({ name: ' 山田 ', email: 'a@example.com', subject: 's', message: 'm', formType: 'premium-plus-contact' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.name, '山田');
  assert.equal(ok.value.formType, 'premium-plus-contact');
  assert.equal(normalizePremiumContactInput({ name: 'a', email: 'a@example.com', subject: 's' }).ok, false);
  assert.equal(normalizePremiumContactInput({ name: 'a', email: 'not-mail', subject: 's', message: 'm' }).ok, false);
  assert.equal(normalizePremiumContactInput({ name: 'a', email: 'a@example.com', subject: 's', message: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }).ok, false);
  const long = normalizePremiumContactInput({ name: 'a', email: 'a@example.com', subject: 's'.repeat(500), message: 'm' });
  assert.equal(long.value.subject.length, MAX_SUBJECT_LENGTH);
  assert.equal(normalizePremiumContactInput({ name: ['x'], email: 'a@example.com', subject: 's', message: 'm' }).ok, false);
  assert.equal(normalizePremiumContactInput(null).ok, false);
});

for (const [file, scope] of [['contact-form.js', 'contact-form'], ['premium-plus-contact.js', 'premium-plus-contact']]) {
  test(`配線: ${file} は送信前に回数の上限を確かめ、超えたら 429 を返す`, () => {
    const fn = read(`../../../netlify/functions/${file}`);
    assert.match(fn, /checkContactRateLimit\(\{/);
    assert.match(fn, new RegExp(`scope: '${scope}'`));
    assert.match(fn, /createBlobsRateStore\(event\)/);
    assert.match(fn, /rateLimitedResponse\(headers\)/);
    const limitAt = fn.indexOf('checkContactRateLimit({');
    const sendAt = fn.search(/sendEmailViaSendGrid\(\{|fetch\('https:\/\/api\.sendgrid\.com/);
    assert.ok(limitAt > 0 && sendAt > limitAt, '上限の確認がメール送信より後にある');
  });
}

test('配線: premium-plus-contact は入力を escapeHtml してから HTML へ入れ、個人情報をログに出さない', () => {
  const fn = read('../../../netlify/functions/premium-plus-contact.js');
  assert.match(fn, /normalizePremiumContactInput\(formData\)/);
  for (const raw of ['${name}', '${email}', '${subject}', '${message}', '${memberHeading}']) {
    assert.equal(fn.includes(raw), false, `生の ${raw} が HTML に入っている`);
  }
  assert.match(fn, /\$\{h\.message\}/);
  assert.match(fn, /console\.log\('\[premium-plus-contact\] accepted', \{ formType \}\)/);
  assert.equal(/details: error\.message/.test(fn), false, '例外の本文を応答へ返している');
});
