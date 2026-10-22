/**
 * `node --import` で読み込む fetch の差し替え（E2E 専用）。
 * Airtable・PayPal Sandbox・Upstash・SendGrid への通信はローカルの偽の外部（fakeBackend.mjs）へ書き換え、
 * それ以外の外部への通信は遮断する（ローカルホストだけ通す）。本物の外部へは 1 度も出ない。
 */
const FAKE = process.env.E2E_FAKE_BACKEND;
if (!FAKE) throw new Error('E2E_FAKE_BACKEND is required');
const FAKE_HOSTS = new Set(['api.airtable.com', 'api-m.sandbox.paypal.com', 'redis.e2e.invalid', 'api.sendgrid.com']);
const realFetch = globalThis.fetch;
globalThis.__akE2eBlocked = [];
globalThis.fetch = async (input, init) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(raw);
  if (FAKE_HOSTS.has(u.host)) return realFetch(`${FAKE}/${u.host}${u.pathname}${u.search}`, init);
  if (['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return realFetch(input, init);
  globalThis.__akE2eBlocked.push(u.host);
  return new Response(JSON.stringify({ error: 'blocked_by_e2e' }), { status: 599, headers: { 'Content-Type': 'application/json' } });
};
