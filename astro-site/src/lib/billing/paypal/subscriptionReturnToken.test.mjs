/**
 * 未ログインで定期課金を申し込んだ方の戻り先（2026-10-22）。
 * 不具合: 戻り先の確認（paypal-subscription-confirm）が ak_session 必須で、メール入力で申し込んだ方（#820）には
 * 401「ログインしてご確認ください」が出て、完了画面も GA4 purchase（#821）も出なかった（権限は Webhook で付く）。
 * 修正: 申込の直後に、申し込んだブラウザだけへ購読 ID・会員 ID に署名した短命の HttpOnly Cookie を渡し、戻り先はそれで確認する。
 * 偽の PayPal（Sandbox の URL）・Airtable・Redis だけで通す（ネットワークに出ない・実の購読は作らない）。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PAYPAL_PLAN_IDS, SUBSCRIPTION_PLANS } from './paypalSubscriptionCore.js';
import { createPaypalSubscription } from './paypalSubscriptionServer.js';
import {
  issueReturnToken, verifyReturnToken, serializeReturnCookie, readReturnCookie, returnCookieFor, resolveConfirmViewer,
  RETURN_COOKIE_NAME, RETURN_COOKIE_PATH, RETURN_TOKEN_TTL_SECONDS,
} from './subscriptionReturnToken.js';

const SECRET = 'test-signing-secret-0123456789abcdef-XYZ';
const SUB = 'I-RETURNTEST0001';
const REC = 'recGUESTAAAAAAAAA';
const T0 = Date.parse('2026-10-22T03:00:00Z');

// ---- 鍵そのもの -------------------------------------------------------------------------------

test('正しい鍵: 同じ購読・期限内なら会員 ID を返す', () => {
  const token = issueReturnToken({ secret: SECRET, subscriptionId: SUB, recordId: REC, now: T0 });
  assert.ok(token);
  assert.deepEqual(verifyReturnToken({ secret: SECRET, token, subscriptionId: SUB, now: T0 + 60_000 }), { ok: true, recordId: REC });
});

test('別の購読の鍵は通さない（URL の subscription_id を差し替えても他人の購読は見えない）', () => {
  const token = issueReturnToken({ secret: SECRET, subscriptionId: SUB, recordId: REC, now: T0 });
  assert.deepEqual(verifyReturnToken({ secret: SECRET, token, subscriptionId: 'I-RETURNTEST0002', now: T0 }), { ok: false, reason: 'subscription_mismatch' });
});

test('期限切れ（2 時間）は通さない', () => {
  const token = issueReturnToken({ secret: SECRET, subscriptionId: SUB, recordId: REC, now: T0 });
  assert.equal(RETURN_TOKEN_TTL_SECONDS, 7200);
  assert.equal(verifyReturnToken({ secret: SECRET, token, subscriptionId: SUB, now: T0 + 7199_000 }).ok, true);
  assert.deepEqual(verifyReturnToken({ secret: SECRET, token, subscriptionId: SUB, now: T0 + 7200_000 }), { ok: false, reason: 'expired' });
});

test('鍵が無い・署名鍵が未設定／短いなら通さない（発行もしない）', () => {
  assert.deepEqual(verifyReturnToken({ secret: SECRET, token: null, subscriptionId: SUB, now: T0 }), { ok: false, reason: 'missing' });
  const token = issueReturnToken({ secret: SECRET, subscriptionId: SUB, recordId: REC, now: T0 });
  for (const s of [undefined, '', 'short']) {
    assert.equal(issueReturnToken({ secret: s, subscriptionId: SUB, recordId: REC, now: T0 }), null);
    assert.deepEqual(verifyReturnToken({ secret: s, token, subscriptionId: SUB, now: T0 }), { ok: false, reason: 'secret_unset' });
  }
  assert.equal(issueReturnToken({ secret: SECRET, subscriptionId: 'nope', recordId: REC, now: T0 }), null);
  assert.equal(issueReturnToken({ secret: SECRET, subscriptionId: SUB, recordId: 'rec1', now: T0 }), null);
});

test('改ざん・別の鍵・形の違う値・セッション鍵で直接署名した値は通さない', () => {
  const token = issueReturnToken({ secret: SECRET, subscriptionId: SUB, recordId: REC, now: T0 });
  const [v, s, , e, sig] = token.split('.');
  assert.equal(verifyReturnToken({ secret: SECRET, token: [v, s, 'recOTHERAAAAAAAAA', e, sig].join('.'), subscriptionId: SUB, now: T0 }).reason, 'bad_signature', '会員 ID の差し替え');
  assert.equal(verifyReturnToken({ secret: SECRET, token: [v, s, REC, String(Number(e) + 86400), sig].join('.'), subscriptionId: SUB, now: T0 }).reason, 'bad_signature', '期限の延長');
  assert.equal(verifyReturnToken({ secret: `${SECRET}-other`, token, subscriptionId: SUB, now: T0 }).reason, 'bad_signature');
  for (const bad of ['x', 'v1.a.b.c', `v2.${SUB}.${REC}.${e}.${sig}`, `v1.${SUB}.${REC}.soon.${sig}`, `${token}.extra`]) {
    assert.equal(verifyReturnToken({ secret: SECRET, token: bad, subscriptionId: SUB, now: T0 }).ok, false, bad);
  }
  // 用途別に導出した鍵で署名している（ak_session と同じ鍵で署名した値は通らない＝相互に流用できない）
  const body = [v, s, REC, e].join('.');
  const raw = createHmac('sha256', SECRET).update(body).digest('base64url');
  assert.equal(verifyReturnToken({ secret: SECRET, token: `${body}.${raw}`, subscriptionId: SUB, now: T0 }).reason, 'bad_signature');
});

test('Cookie: HttpOnly・Secure・SameSite=Lax・確認の Function だけへ送る・2 時間', () => {
  const c = serializeReturnCookie('v1.tok');
  assert.equal(c, `${RETURN_COOKIE_NAME}=v1.tok; Max-Age=7200; Path=/.netlify/functions/paypal-subscription-confirm; SameSite=Lax; HttpOnly; Secure`);
  assert.equal(RETURN_COOKIE_PATH, '/.netlify/functions/paypal-subscription-confirm');
  assert.equal(readReturnCookie(`a=1; ${RETURN_COOKIE_NAME}=v1.tok; ak_session=s`), 'v1.tok');
  assert.equal(readReturnCookie('ak_session=s'), null);
  assert.equal(returnCookieFor({ env: {}, subscriptionId: SUB, recordId: REC }), null, '署名鍵が無ければ Cookie を出さない');
  assert.match(returnCookieFor({ env: { SESSION_SIGNING_SECRET: SECRET }, subscriptionId: SUB, recordId: REC }), /^ak_pp_return=v1\.I-RETURNTEST0001\.recGUESTAAAAAAAAA\.\d+\./);
});

test('閲覧者の決定: ログイン中は従来どおりセッション（Cookie は見ない）・未ログインは鍵が正しいときだけ', async () => {
  const env = { SESSION_SIGNING_SECRET: SECRET };
  const token = issueReturnToken({ secret: SECRET, subscriptionId: SUB, recordId: REC, now: T0 });
  const cookie = `${RETURN_COOKIE_NAME}=${token}`;
  const member = async () => 'recMEMBERAAAAAAAA';
  const nobody = async () => null;
  assert.deepEqual(await resolveConfirmViewer({ cookieHeader: cookie, env, subscriptionId: SUB, readSession: member, now: T0 }), { recordId: 'recMEMBERAAAAAAAA', viewer: 'member' });
  assert.deepEqual(await resolveConfirmViewer({ cookieHeader: 'ak_pp_return=junk', env, subscriptionId: SUB, readSession: member, now: T0 }), { recordId: 'recMEMBERAAAAAAAA', viewer: 'member' });
  assert.deepEqual(await resolveConfirmViewer({ cookieHeader: cookie, env, subscriptionId: SUB, readSession: nobody, now: T0 }), { recordId: REC, viewer: 'guest' });
  assert.equal((await resolveConfirmViewer({ cookieHeader: cookie, env, subscriptionId: 'I-RETURNTEST0002', readSession: nobody, now: T0 })).recordId, null);
  assert.equal((await resolveConfirmViewer({ cookieHeader: cookie, env, subscriptionId: SUB, readSession: nobody, now: T0 + 7200_000 })).recordId, null);
  assert.equal((await resolveConfirmViewer({ cookieHeader: '', env, subscriptionId: SUB, readSession: nobody, now: T0 })).recordId, null);
  assert.equal((await resolveConfirmViewer({ cookieHeader: cookie, env: {}, subscriptionId: SUB, readSession: nobody, now: T0 })).recordId, null);
});

// ---- Function を通した流れ（申込 → PayPal で承認 → 戻り先）------------------------------------

const PREVIEW = 'https://deploy-preview-1--analytics-keiba.netlify.app';
const HOST = 'deploy-preview-1--analytics-keiba.netlify.app';
const REDIS_URL = 'https://redis.example.invalid';
const ENV = {
  PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'sec', PAYPAL_ENV: 'sandbox', PAYPAL_WEBHOOK_ID: 'WH-1',
  AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'appX', UPSTASH_REDIS_REST_URL: REDIS_URL, UPSTASH_REDIS_REST_TOKEN: 't',
  SESSION_SIGNING_SECRET: SECRET,
};
const PID = PAYPAL_PLAN_IDS.test;
const FN = (name) => fileURLToPath(new URL(`../../../../netlify/functions/${name}.js`, import.meta.url));

/** 偽の外部（Sandbox の PayPal・Airtable・Upstash）。本物の URL へは出ない */
function world() {
  const st = { records: {}, subs: {}, redis: new Map(), external: 0, recCreates: 0 };
  const res = (status, body) => new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  st.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.origin === REDIS_URL) {
      if (u.pathname !== '/') return res(200, []);
      const [cmd, key, val, ...rest] = JSON.parse(init.body);
      if (cmd === 'GET') return res(200, { result: st.redis.get(key) ?? null });
      if (cmd === 'SET') { if (rest.includes('NX') && st.redis.has(key)) return res(200, { result: null }); st.redis.set(key, val); return res(200, { result: 'OK' }); }
      if (cmd === 'DEL') { st.redis.delete(key); return res(200, { result: 1 }); }
      if (cmd === 'GETDEL') { const v = st.redis.get(key) ?? null; st.redis.delete(key); return res(200, { result: v }); }
      return res(200, { result: null });
    }
    if (u.host === 'api.airtable.com') {
      const id = decodeURIComponent(u.pathname.split('/')[4] || '');
      if (init.method === 'POST') {
        const f = JSON.parse(init.body).records[0].fields;
        st.recCreates += 1;
        const nid = `recNEW${String(st.recCreates).padStart(11, '0')}`;
        st.records[nid] = { ...f };
        return res(200, { records: [{ id: nid, fields: st.records[nid] }] });
      }
      if (init.method === 'PATCH') { Object.assign(st.records[id], JSON.parse(init.body).fields); return res(200, { id, fields: st.records[id] }); }
      if (id) return st.records[id] ? res(200, { id, fields: st.records[id] }) : res(404, { error: 'NOT_FOUND' });
      const m = String(u.searchParams.get('filterByFormula') || '').match(/^LOWER\(TRIM\(\{Email\}\)\) = '(.*)'$/);
      const email = m ? m[1] : null;
      const hits = Object.entries(st.records).filter(([, f]) => String(f.Email || '').trim().toLowerCase() === email);
      return res(200, { records: hits.map(([rid, f]) => ({ id: rid, fields: f })) });
    }
    if (u.host !== 'api-m.sandbox.paypal.com') { st.external += 1; return res(403, { error: 'blocked' }); }
    if (u.pathname === '/v1/oauth2/token') return res(200, { access_token: 'tok' });
    if (u.pathname === '/v1/billing/subscriptions' && init.method === 'POST') {
      const b = JSON.parse(init.body);
      const sid = `I-RETURNSUB${String(Object.keys(st.subs).length + 1).padStart(5, '0')}`;
      st.subs[sid] = { id: sid, status: 'APPROVAL_PENDING', plan_id: b.plan_id, custom_id: b.custom_id, links: [{ rel: 'approve', href: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-${sid}` }] };
      return res(201, st.subs[sid]);
    }
    const m = u.pathname.match(/^\/v1\/billing\/subscriptions\/(I-[A-Z0-9]+)$/);
    if (m) return st.subs[m[1]] ? res(200, st.subs[m[1]]) : res(404, { name: 'RESOURCE_NOT_FOUND' });
    st.external += 1;
    return res(404, {});
  };
  st.pay = (sid) => {
    const s = st.subs[sid];
    const plan = SUBSCRIPTION_PLANS.find((p) => PID[p.id] === s.plan_id);
    s.status = 'ACTIVE';
    s.billing_info = { last_payment: { amount: { currency_code: 'JPY', value: String(plan.amountYen) }, time: new Date().toISOString() } };
  };
  return st;
}

let w;
let savedEnv;
let savedFetch;
beforeEach(() => {
  w = world();
  savedEnv = { ...process.env };
  savedFetch = globalThis.fetch;
  Object.assign(process.env, ENV);
  // 課金メーター等が fetch を包んでも、毎回いまの偽の世界へ届くように固定の入口を置く
  globalThis.fetch = (url, init) => w.fetch(url, init);
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  globalThis.fetch = savedFetch;
});

async function runFn(name, event) {
  const saved = { log: console.log, info: console.info, warn: console.warn };
  console.log = console.info = console.warn = (...a) => console.error(...a);
  try {
    globalThis.exports = {};
    globalThis.module = { exports: globalThis.exports };
    await import(`${FN(name)}?t=${Math.random()}`);
    const r = await globalThis.exports.handler(event, {});
    let body = {};
    try { body = JSON.parse(r.body); } catch { body = {}; }
    return { status: r.statusCode, headers: r.headers || {}, body, raw: r.body };
  } finally { Object.assign(console, saved); }
}

const checkout = (body, cookie = '') => runFn('monthly-create-checkout', {
  httpMethod: 'POST', headers: { origin: PREVIEW, host: HOST, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
});
const confirm = (subscription, cookie = '') => runFn('paypal-subscription-confirm', {
  httpMethod: 'GET', headers: { origin: PREVIEW, host: HOST, ...(cookie ? { cookie } : {}) }, queryStringParameters: { subscription },
});
const cookieOf = (setCookie) => String(setCookie || '').split(';')[0];

test('未ログインの購入者: 申込のブラウザだけが戻り先で完了（active・viewer guest）を受け取り、個人情報は返らない', async () => {
  const c = await checkout({ plan: 'premium', email: 'guest.buyer@example.invalid' });
  assert.equal(c.status, 200, c.raw);
  assert.deepEqual(Object.keys(c.body).sort(), ['provider', 'subscription', 'url'], '会員 ID・メールは返さない');
  const setCookie = c.headers['Set-Cookie'];
  assert.match(setCookie, /^ak_pp_return=v1\./);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Path=\/\.netlify\/functions\/paypal-subscription-confirm/);
  const sid = c.body.subscription;

  // 承認前: 処理中（pending）
  const before = await confirm(sid, cookieOf(setCookie));
  assert.deepEqual([before.status, before.body.status, before.body.viewer], [200, 'pending', 'guest']);

  // 支払い後: 完了（active）。権限は従来どおりの反映（Webhook と同じ処理）
  w.pay(sid);
  const after = await confirm(sid, cookieOf(setCookie));
  assert.deepEqual(after.body, { status: 'active', plan: 'premium', destination: '/dashboard/?from=purchase#premium-predictions', viewer: 'guest' });
  assert.doesNotMatch(after.raw, /@|example\.invalid|rec[A-Za-z0-9]{14}/, 'メール・会員 ID を返さない');
  const [rid] = Object.keys(w.records);
  assert.equal(w.records[rid]['プラン'], 'Premium');

  // 再読込・2 回目の確認でも同じ結果（二重に付与しない＝期限も変わらない）
  const exp = w.records[rid]['有効期限'];
  const again = await confirm(sid, cookieOf(setCookie));
  assert.equal(again.body.status, 'active');
  assert.equal(w.records[rid]['有効期限'], exp);
  assert.equal(w.external, 0, '偽の Sandbox 以外へ出ていない');
});

test('URL だけ（Cookie なし）・期限切れ・別の購読の Cookie では何も見えない（401・照会もしない）', async () => {
  const a = await checkout({ plan: 'premium', email: 'buyer.a@example.invalid' });
  const b = await checkout({ plan: 'premium-jra', email: 'buyer.b@example.invalid' });
  w.pay(a.body.subscription);
  w.pay(b.body.subscription);
  const noCookie = await confirm(a.body.subscription);
  assert.deepEqual([noCookie.status, noCookie.body], [401, { error: 'login_required' }]);
  const crossed = await confirm(a.body.subscription, cookieOf(b.headers['Set-Cookie']));
  assert.deepEqual([crossed.status, crossed.body], [401, { error: 'login_required' }], 'B の鍵で A の購読は見えない');
  const old = issueReturnToken({ secret: SECRET, subscriptionId: a.body.subscription, recordId: Object.keys(w.records)[0], now: Date.now() - 7201_000 });
  assert.equal((await confirm(a.body.subscription, `ak_pp_return=${old}`)).status, 401);
  const forged = issueReturnToken({ secret: 'another-secret-0123456789abcdefghij', subscriptionId: a.body.subscription, recordId: Object.keys(w.records)[0] });
  assert.equal((await confirm(a.body.subscription, `ak_pp_return=${forged}`)).status, 401);
  // 401 の間はどちらの会員にも書いていない（Webhook が来るまで Free のまま）
  assert.deepEqual(Object.values(w.records).map((f) => f['プラン']), ['Free', 'Free']);
});

test('鍵の会員 ID と PayPal の custom_id が食い違えば 404（会員の内容を返さない）', async () => {
  const c = await checkout({ plan: 'premium', email: 'mismatch@example.invalid' });
  w.pay(c.body.subscription);
  const wrong = issueReturnToken({ secret: SECRET, subscriptionId: c.body.subscription, recordId: 'recSOMEONEELSEAAA' });
  const r = await confirm(c.body.subscription, `ak_pp_return=${wrong}`);
  assert.deepEqual([r.status, r.body], [404, { status: 'not_found' }]);
});

test('署名鍵が未設定なら Cookie を出さず、申込は止めない（戻り先はログインの案内）', async () => {
  delete process.env.SESSION_SIGNING_SECRET;
  const c = await checkout({ plan: 'premium', email: 'nokey@example.invalid' });
  assert.equal(c.status, 200);
  assert.equal(c.headers['Set-Cookie'], undefined);
  assert.equal((await confirm(c.body.subscription)).status, 401);
});

test('ログイン中の申込は従来どおり（Cookie を出さない・戻り先はセッションで確認する）', async () => {
  const src = readFileSync(FN('monthly-create-checkout'), 'utf8');
  assert.match(src, /const returnCookie = r\.guest && !e2e \? returnCookieFor\(/);
  const fn = readFileSync(FN('paypal-subscription-confirm'), 'utf8');
  assert.match(fn, /resolveConfirmViewer\(\{ cookieHeader: [^}]*readSession: readSessionRecordId \}\)/);
  // サーバー: ログイン中の申込は guest=false（Cookie の対象外）
  w.records.recMEMBERAAAAAAAA = { Email: 'member@example.invalid', 'プラン': 'Free' };
  const r = await createPaypalSubscription({ env: ENV, origin: PREVIEW, recordId: 'recMEMBERAAAAAAAA', planId: 'premium', entry: 'monthly', redis: async ([cmd, k, v]) => (cmd === 'GET' ? w.redis.get(k) ?? null : (w.redis.set(k, v), 'OK')), fetchImpl: w.fetch });
  assert.equal(r.ok, true);
  assert.equal(r.guest, false);
});

// ---- 戻り先の画面と GA4 purchase の配線 --------------------------------------------------------

test('配線: purchase は active の分岐だけ・1 か所・401 / 404 / 処理中 / 要確認では送らない。未ログインには正直な案内', () => {
  const page = readFileSync(fileURLToPath(new URL('../../../pages/checkout/paypal-subscription-return.astro', import.meta.url)), 'utf8');
  assert.equal(page.split('purchaseCompleted(').length - 1, 1, '呼び出しは 1 か所だけ');
  const call = page.indexOf("window.AkFunnel.purchaseCompleted(x.d.plan, subscription, 'paypal')");
  assert.ok(call > 0);
  const activeAt = page.indexOf("if (st === 'active') {");
  assert.ok(activeAt > 0 && activeAt < call, 'active の分岐の中');
  const branchEnd = page.indexOf('}', page.indexOf("return show('✅', 'お申し込みが完了しました', t.text, t.links);"));
  assert.ok(call < branchEnd);
  for (const other of ["if (st === 'needs_support')", 'if (x.s === 401)', 'if (x.s === 404)']) assert.ok(page.indexOf(other) > branchEnd, other);
  assert.match(page, /show\('✅', 'お申し込みが完了しました', t\.text \+ guest\.activeNext, guest\.activeLinks\)/);
  assert.match(page, /if \(x\.s === 401\) return show\('🔑', guest\.loginRequired\.title, guest\.loginRequired\.text, guest\.loginRequired\.links\)/);
  assert.doesNotMatch(page, /'ログインしてご確認ください'/, '払ったかどうか分からない言い方を残さない');
});

// ---- 決済完了 → Premium への自動遷移（2026-10-22 MK 確定・postPurchaseLanding.js）--------------------

const { postPurchaseKey, resolvePostLoginDestination, POST_PURCHASE_DESTINATIONS } = await import('./postPurchaseLanding.js');
const { resolveEntitlements, fromAirtableFields } = await import('../../entitlements/resolveEntitlements.js');
const redisOf = () => async (args) => {
  const r = await w.fetch(REDIS_URL, { method: 'POST', body: JSON.stringify(args) });
  return (await r.json()).result;
};
const entOf = (rid) => resolveEntitlements(fromAirtableFields(w.records[rid]));

for (const [plan, dest] of [
  ['premium', '/dashboard/?from=purchase#premium-predictions'],
  ['premium-jra', '/premium-prediction/jra/'],
  ['premium-nankan', '/premium-prediction/nankan/'],
  ['premium-annual', '/dashboard/?from=purchase#premium-predictions'],
]) {
  test(`自動遷移 ${plan}: 反映済みで戻り先に ${dest}・ログイン後も同じ場所へ 1 回だけ（未ログイン購入）`, async () => {
    const c = await checkout({ plan, email: `auto.${plan}@example.invalid` });
    assert.equal(c.status, 200, c.raw);
    const sid = c.body.subscription;
    const ck = cookieOf(c.headers['Set-Cookie']);
    const [rid] = Object.keys(w.records);

    // 決済前: 遷移先を返さない・印も無い（Premium へ送らない）
    const pending = await confirm(sid, ck);
    assert.equal(pending.body.status, 'pending');
    assert.equal(pending.body.destination, undefined);
    assert.equal(w.redis.has(postPurchaseKey(rid)), false);

    w.pay(sid);
    const done = await confirm(sid, ck);
    assert.deepEqual([done.body.status, done.body.destination, done.body.viewer], ['active', dest, 'guest']);
    assert.ok(POST_PURCHASE_DESTINATIONS.includes(done.body.destination));
    assert.equal(JSON.parse(w.redis.get(postPurchaseKey(rid))).planId, plan, '購入直後の印（会員単位・サーバー側）');

    // ログイン（verify-magic-link）: いまの権限で買った会場が見られる → その画面へ。2 回目は通常のマイページ（印は 1 回で消える）
    assert.equal(await resolvePostLoginDestination({ redis: redisOf(), recordId: rid, entitlements: entOf(rid) }), dest);
    assert.equal(await resolvePostLoginDestination({ redis: redisOf(), recordId: rid, entitlements: entOf(rid) }), null);

    // 再読込・Webhook の再送（反映済み）では印を作り直さない＝二重付与もしない
    const exp = w.records[rid]['有効期限'];
    await confirm(sid, ck);
    assert.equal(w.redis.has(postPurchaseKey(rid)), false);
    assert.equal(w.records[rid]['有効期限'], exp);
    assert.equal(w.external, 0);
  });
}

test('自動遷移: 印があっても、いまの権限で見られなければ従来どおり（期限切れ・別会員の印は使わない）', async () => {
  const c = await checkout({ plan: 'premium', email: 'expired.after@example.invalid' });
  w.pay(c.body.subscription);
  await confirm(c.body.subscription, cookieOf(c.headers['Set-Cookie']));
  const [rid] = Object.keys(w.records);
  // 別の会員 ID では読めない
  assert.equal(await resolvePostLoginDestination({ redis: redisOf(), recordId: 'recSOMEONEELSEAAA', entitlements: entOf(rid) }), null);
  // 権限が外れた（期限切れ等）なら Premium へ送らない
  const noPremium = { ...entOf(rid), canViewPremium: false, canViewPremiumJra: false, canViewPremiumNankan: false };
  assert.equal(await resolvePostLoginDestination({ redis: redisOf(), recordId: rid, entitlements: noPremium }), null);
});

test('自動遷移: Redis が無い・壊れていても付与もログインも止めない（遷移は従来どおり）', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  assert.equal(await resolvePostLoginDestination({ redis: null, recordId: 'recGUESTAAAAAAAAA', entitlements: { canViewPremiumJra: true, canViewPremiumNankan: true } }), null);
  const broken = async () => { throw new Error('redis_500'); };
  assert.equal(await resolvePostLoginDestination({ redis: broken, recordId: 'recGUESTAAAAAAAAA', entitlements: { canViewPremiumJra: true, canViewPremiumNankan: true } }), null);
});
