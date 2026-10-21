/**
 * 未ログイン（無料会員・初めての方）の定期課金の申込（2026-10-21 不具合修正）。
 * 無料会員はセッションを持たないため、ログイン必須では月額・年額へ進めなかった（ログイン↔料金ページの往復）。
 * 入力メールで会員を決め、custom_id の recordId に固定する。偽の PayPal・Airtable・Redis で通す（ネットワークに出ない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PAYPAL_PLAN_IDS, SUBSCRIPTION_PLANS, memberKey, LIFETIME_BANK_ONLY } from './paypalSubscriptionCore.js';
import { createPaypalSubscription, applyPaypalSubscription, CHECKOUT_RECORD_SOURCE } from './paypalSubscriptionServer.js';

const PREVIEW = 'https://deploy-preview-1--analytics-keiba.netlify.app';
const ENV = { PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'sec', PAYPAL_ENV: 'sandbox', PAYPAL_WEBHOOK_ID: 'WH-1', AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'appX' };
const NOW = new Date('2026-10-21T03:00:00Z');
const PID = PAYPAL_PLAN_IDS.test;
const FREE_REC = 'recFREEAAAAAAAAAA';

/** Customers を複数レコード持てる偽の世界 */
function world(records = {}) {
  const st = { records: structuredClone(records), subs: {}, redis: new Map(), creates: 0, recCreates: 0, calls: [] };
  const res = (status, body) => ({ ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)), json: async () => body });
  st.fetch = async (url, init = {}) => {
    const u = new URL(url);
    st.calls.push(`${init.method || 'GET'} ${u.host}${u.pathname}`);
    if (u.host === 'api.airtable.com') {
      const id = decodeURIComponent(u.pathname.split('/')[4] || '');
      if (init.method === 'POST') {
        const f = JSON.parse(init.body).records[0].fields;
        st.recCreates += 1;
        const nid = `recNEW${String(st.recCreates).padStart(11, '0')}`;
        st.records[nid] = { ...f };
        await new Promise((r) => setTimeout(r, 5));
        return res(200, { records: [{ id: nid, fields: st.records[nid] }] });
      }
      if (init.method === 'PATCH') { Object.assign(st.records[id], JSON.parse(init.body).fields); return res(200, { id, fields: st.records[id] }); }
      if (id) return st.records[id] ? res(200, { id, fields: st.records[id] }) : res(404, { error: 'NOT_FOUND' });
      const m = String(u.searchParams.get('filterByFormula') || '').match(/^LOWER\(TRIM\(\{Email\}\)\) = '(.*)'$/);
      const email = m ? m[1].replace(/\\'/g, "'") : null;
      const hits = Object.entries(st.records).filter(([, f]) => String(f.Email || '').trim().toLowerCase() === email);
      await new Promise((r) => setTimeout(r, 5)); // 同時の申込で検索と作成が交差するように
      return res(200, { records: hits.map(([rid, f]) => ({ id: rid, fields: f })) });
    }
    if (u.pathname === '/v1/oauth2/token') return res(200, { access_token: 'tok' });
    if (u.pathname === '/v1/billing/subscriptions' && init.method === 'POST') {
      const b = JSON.parse(init.body);
      st.creates += 1;
      const sid = `I-GUESTSUB${String(st.creates).padStart(6, '0')}`;
      st.subs[sid] = { id: sid, status: 'APPROVAL_PENDING', plan_id: b.plan_id, custom_id: b.custom_id, links: [{ rel: 'approve', href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-${sid}` }] };
      return res(201, st.subs[sid]);
    }
    const m = u.pathname.match(/^\/v1\/billing\/subscriptions\/(I-[A-Z0-9]+)$/);
    if (m) return st.subs[m[1]] ? res(200, st.subs[m[1]]) : res(404, { name: 'RESOURCE_NOT_FOUND' });
    throw new Error(`unexpected ${url}`);
  };
  st.redisCmd = async ([cmd, key, val, ...rest]) => {
    if (cmd === 'GET') return st.redis.get(key) ?? null;
    if (cmd === 'SET') { if (rest.includes('NX') && st.redis.has(key)) return null; st.redis.set(key, val); return 'OK'; }
    if (cmd === 'DEL') { st.redis.delete(key); return 1; }
    throw new Error(cmd);
  };
  st.pay = (sid) => {
    const s = st.subs[sid];
    const plan = SUBSCRIPTION_PLANS.find((p) => PID[p.id] === s.plan_id);
    s.status = 'ACTIVE';
    s.billing_info = { last_payment: { amount: { currency_code: 'JPY', value: String(plan.amountYen) }, time: NOW.toISOString() } };
  };
  return st;
}
const guest = (w, extra) => ({ env: ENV, origin: PREVIEW, recordId: null, redis: w.redisCmd, fetchImpl: w.fetch, now: NOW, entry: 'monthly', ...extra });

test('初めての方（レコード無し）: セッション無しでメールだけで承認 URL まで進み、作った無料会員レコードに固定される', async () => {
  const w = world();
  const c = await createPaypalSubscription(guest(w, { email: '  New.Buyer@Example.com ', planId: 'premium' }));
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.match(c.url, /^https:\/\/www\.sandbox\.paypal\.com\//);
  assert.equal(w.recCreates, 1);
  const [rid, f] = Object.entries(w.records)[0];
  assert.deepEqual(f, { Email: 'new.buyer@example.com', 'プラン': 'Free', Source: CHECKOUT_RECORD_SOURCE }, 'ポイント・権限は付けない（無料会員と同じ形）');
  assert.equal(w.subs[c.subscriptionId].custom_id, `${rid}:A`, 'Webhook が信用する custom_id にサーバーが決めた recordId');
  // 支払い後: Webhook と同じ反映で、そのレコードに Premium が付く
  w.pay(c.subscriptionId);
  const r = await applyPaypalSubscription({ env: ENV, origin: PREVIEW, subscriptionId: c.subscriptionId, redis: w.redisCmd, fetchImpl: w.fetch, now: NOW });
  assert.equal(r.action, 'write');
  assert.equal(r.recordId, rid);
  assert.equal(w.records[rid]['プラン'], 'Premium');
  assert.equal(w.records[rid].PaymentMethod, 'PayPal');
  assert.equal(w.redis.get(memberKey(rid)), c.subscriptionId);
});

test('無料会員（既存レコード）: 年額もメールで申込め、新しいレコードは作らずその会員に固定される', async () => {
  const w = world({ [FREE_REC]: { Email: 'free@example.com', 'プラン': 'Free' } });
  const c = await createPaypalSubscription(guest(w, { email: 'FREE@example.com', planId: 'premium-annual' }));
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(w.recCreates, 0);
  assert.equal(w.subs[c.subscriptionId].custom_id, `${FREE_REC}:Y`);
  assert.equal(w.subs[c.subscriptionId].plan_id, PID['premium-annual']);
});

test('セッションは不要・メールが無い／不正なら会員にも PayPal にも触れずに断る', async () => {
  const w = world();
  const none = await createPaypalSubscription(guest(w, { planId: 'premium' }));
  assert.deepEqual([none.status, none.code], [400, 'email_required']);
  for (const bad of ['not-an-email', 'a@b', 'a b@example.com']) {
    const r = await createPaypalSubscription(guest(w, { email: bad, planId: 'premium' }));
    assert.deepEqual([r.status, r.code], [400, 'invalid_email'], bad);
  }
  assert.deepEqual(w.calls, []);
});

test('買い切りは銀行振込だけ: 未ログインでもログイン中でも lifetime_bank_transfer_only（会員にも PayPal にも触れない）', async () => {
  const w = world({ [FREE_REC]: { Email: 'free@example.com', 'プラン': 'Free' } });
  const g = await createPaypalSubscription(guest(w, { email: 'free@example.com', planId: 'premium-lifetime' }));
  assert.deepEqual([g.status, g.code], [409, LIFETIME_BANK_ONLY]);
  const s = await createPaypalSubscription(guest(w, { recordId: FREE_REC, planId: 'premium-lifetime' }));
  assert.equal(s.code, LIFETIME_BANK_ONLY);
  assert.equal((await createPaypalSubscription(guest(w, { email: 'free@example.com', planId: 'nope' }))).code, 'invalid_plan');
  assert.deepEqual(w.calls, []);
  assert.equal(w.recCreates, 0);
});

test('二重契約を作らない: メールの会員に生きている PayPal 購読があれば 409 already_subscribed（新しい購読を作らない）', async () => {
  const w = world({ [FREE_REC]: { Email: 'sub@example.com', 'プラン': 'Free' } });
  const first = await createPaypalSubscription(guest(w, { email: 'sub@example.com', planId: 'premium' }));
  w.pay(first.subscriptionId);
  await applyPaypalSubscription({ env: ENV, origin: PREVIEW, subscriptionId: first.subscriptionId, redis: w.redisCmd, fetchImpl: w.fetch, now: NOW });
  const before = w.creates;
  for (const planId of ['premium-jra', 'premium-annual']) {
    const r = await createPaypalSubscription(guest(w, { email: 'sub@example.com', planId }));
    assert.equal(r.status, 409, planId);
    assert.ok(['already_subscribed', 'already_premium'].includes(r.code), `${planId}: ${r.code}`);
  }
  assert.equal(w.creates, before, 'PayPal に購読を作っていない');
});

test('会員を特定できない・ログインできない会員は断る（複数一致 409・利用停止 403）', async () => {
  const w = world({
    recDUPAAAAAAAAAAA: { Email: 'dup@example.com', 'プラン': 'Free' },
    recDUPBBBBBBBBBBB: { Email: 'DUP@example.com', 'プラン': 'Free' },
    recSUSPAAAAAAAAAA: { Email: 'stop@example.com', 'プラン': 'Free', Status: 'suspended' },
  });
  assert.deepEqual(Object.values(await createPaypalSubscription(guest(w, { email: 'dup@example.com', planId: 'premium' }))).slice(1), [409, 'account_conflict']);
  const s = await createPaypalSubscription(guest(w, { email: 'stop@example.com', planId: 'premium' }));
  assert.deepEqual([s.status, s.code], [403, 'account_unavailable']);
  assert.equal(w.creates, 0);
  assert.equal(w.recCreates, 0);
});

test('Light 会員特典は資格が無い新しい方には作らない（レコードも作らない）', async () => {
  const w = world();
  const r = await createPaypalSubscription(guest(w, { email: 'new@example.com', planId: 'premium-annual-light' }));
  assert.deepEqual([r.status, r.code], [409, 'not_eligible']);
  assert.equal(w.recCreates, 0);
  assert.equal(w.creates, 0);
});

test('同じ新しいメールで同時に押されても、会員レコードは 1 件だけ（メールごとの排他）', async () => {
  const w = world();
  const rs = await Promise.all([1, 2, 3].map(() => createPaypalSubscription(guest(w, { email: 'race@example.com', planId: 'premium' }))));
  assert.equal(rs.every((r) => r.ok), true, JSON.stringify(rs));
  assert.equal(w.recCreates, 1);
  assert.equal(new Set(rs.map((r) => w.subs[r.subscriptionId].custom_id)).size, 1);
  assert.equal([...w.redis.keys()].some((k) => k.includes('race@')), false, 'メールアドレスを Redis の鍵に残さない');
});

test('ログイン中は従来どおりセッションの会員（メールは使わない）', async () => {
  const w = world({ [FREE_REC]: { Email: 'free@example.com', 'プラン': 'Free' }, recOTHERAAAAAAAAA: { Email: 'other@example.com', 'プラン': 'Free' } });
  const c = await createPaypalSubscription(guest(w, { recordId: FREE_REC, email: 'other@example.com', planId: 'premium-nankan' }));
  assert.equal(c.ok, true);
  assert.equal(w.subs[c.subscriptionId].custom_id, `${FREE_REC}:N`);
});

const root = (p) => fileURLToPath(new URL(`../../../../${p}`, import.meta.url));
test('入口と料金ページ: セッションがあればメールを渡さない・未ログインはメール入力で進む（ログインの往復にしない）', () => {
  const fn = readFileSync(root('netlify/functions/monthly-create-checkout.js'), 'utf8');
  assert.match(fn, /const email = recordId \? '' : String\(body\.email \|\| ''\)/);
  const page = readFileSync(root('src/pages/pricing.astro'), 'utf8');
  const i = page.indexOf('function show(html, btn)'); const js = page.slice(i, page.indexOf('})();', i));
  assert.match(js, /err === 'email_required'\) return askEmail\(planId, btn\)/);
  assert.match(js, /JSON\.stringify\(email \? \{ plan: planId, email: email \} : \{ plan: planId \}\)/);
  assert.match(js, /get\('plan'\)/, '?plan= で戻ったら申込を再開する');
  assert.match(page, /<div class="checkout-message" id="monthlyMessage"/, 'フォームを入れるので p ではなく div');
});
