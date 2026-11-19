// ウェルカムメール: 公開 Function は送らない・auth-user は直接送る・ログにメールアドレスを出さない
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildWelcomeEmail, isValidWelcomeEmail, sendWelcomeEmail } from './welcomeEmail.js';
import handler from '../../../netlify/functions/user-notification.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf-8');
const EMAIL = 'new-member@example.com';

test('公開 Function は POST でも送信せず 410（SendGrid を呼ばない）', async () => {
  const orig = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called++; return new Response('{}'); };
  try {
    const res = await handler(new Request('https://x/.netlify/functions/user-notification', {
      method: 'POST', body: JSON.stringify({ email: EMAIL, isNewUser: true }),
    }));
    assert.equal(res.status, 410);
    assert.equal(called, 0);
    assert.equal((await res.text()).includes(EMAIL), false);
    assert.equal((await handler(new Request('https://x/', { method: 'GET' }))).status, 405);
  } finally { globalThis.fetch = orig; }
});

test('公開 Function は SendGrid の key を参照しない', () => {
  const src = read('../../../netlify/functions/user-notification.js');
  assert.equal(/SENDGRID|api\.sendgrid\.com/.test(src), false);
});

test('auth-user は公開 URL を HTTP で呼ばず sendWelcomeEmail を直接呼ぶ', () => {
  const src = read('../../../netlify/functions/auth-user.js');
  assert.equal(/functions\/user-notification/.test(src), false);
  assert.match(src, /sendWelcomeEmail\(\{\s*email\s*\}\)/);
});

test('送信: 正しい宛先・件名・送信元で 1 回だけ送り、ログにアドレスを出さない', async () => {
  const calls = [];
  const logs = [];
  const ol = console.log, oe = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  try {
    const r = await sendWelcomeEmail({
      email: EMAIL,
      env: { SENDGRID_API_KEY: 'k', SENDGRID_FROM_EMAIL: 'noreply@keiba.link' },
      fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response('', { status: 202 }); },
    });
    assert.deepEqual(r, { sent: true });
  } finally { console.log = ol; console.error = oe; }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.sendgrid.com/v3/mail/send');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.personalizations[0].to, [{ email: EMAIL }]);
  assert.equal(body.personalizations[0].subject, '🎉 KEIBA Analytics 登録完了！');
  assert.equal(body.from.email, 'noreply@keiba.link');
  assert.equal(body.tracking_settings.click_tracking.enable, false);
  assert.match(body.content[0].value, /https:\/\/analytics\.keiba\.link\/dashboard/);
  assert.equal(logs.some((l) => l.includes(EMAIL)), false);
});

test('送信失敗・key 無し・不正アドレスでも例外を投げずに結果を返す', async () => {
  const oe = console.error, ol = console.log;
  console.error = () => {}; console.log = () => {};
  try {
    assert.deepEqual(await sendWelcomeEmail({ email: EMAIL, env: {}, fetchImpl: async () => { throw new Error('x'); } }),
      { sent: false, reason: 'no_api_key' });
    assert.equal((await sendWelcomeEmail({ email: EMAIL, env: { SENDGRID_API_KEY: 'k' },
      fetchImpl: async () => new Response('err', { status: 400 }) })).reason, 'sendgrid_error');
    assert.equal((await sendWelcomeEmail({ email: EMAIL, env: { SENDGRID_API_KEY: 'k' },
      fetchImpl: async () => { throw new Error('net'); } })).reason, 'exception');
    let called = 0;
    const bad = await sendWelcomeEmail({ email: 'a@b.c\r\nBcc: x@y.z', env: { SENDGRID_API_KEY: 'k' },
      fetchImpl: async () => { called++; return new Response(''); } });
    assert.equal(bad.reason, 'invalid_email');
    assert.equal(called, 0);
  } finally { console.error = oe; console.log = ol; }
});

test('アドレス検査', () => {
  assert.equal(isValidWelcomeEmail(EMAIL), true);
  for (const v of ['', 'x', 'a@b', null, 1, 'a b@c.d', `${'a'.repeat(250)}@b.cd`]) assert.equal(isValidWelcomeEmail(v), false);
  assert.equal(buildWelcomeEmail({ email: EMAIL, env: {} }).from.name, 'KEIBA Analytics');
});
