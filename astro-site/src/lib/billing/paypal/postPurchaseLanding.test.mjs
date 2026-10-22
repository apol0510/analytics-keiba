/**
 * 決済完了 → Premium への自動遷移（2026-10-22 MK 確定）。判定（純粋）と配線（戻り先・ログイン・マイページ）を固定する。
 * 流れ全体（申込 → 支払い → 戻り先 → 印 → ログイン）は subscriptionReturnToken.test.mjs の偽の PayPal / Airtable / Redis で通している。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SUBSCRIPTION_PLANS } from './paypalSubscriptionCore.js';
import {
  destinationForPlan, destinationForPurchase, destinationForVenues, markPostPurchase, takePostPurchase,
  postPurchaseKey, POST_PURCHASE_DESTINATIONS, POST_PURCHASE_TTL_SECONDS, BOTH_VENUES_DESTINATION,
} from './postPurchaseLanding.js';
import { SUBSCRIPTION_RETURN_GUEST } from './subscriptionReturnCopy.js';

const REC = 'recBUYERAAAAAAAAA';
const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const memRedis = () => {
  const m = new Map();
  const calls = [];
  const cmd = async (args) => {
    calls.push(args);
    const [c, k, v] = args;
    if (c === 'SET') { m.set(k, v); return 'OK'; }
    if (c === 'GETDEL') { const x = m.get(k) ?? null; m.delete(k); return x; }
    if (c === 'GET') return m.get(k) ?? null;
    if (c === 'DEL') { m.delete(k); return 1; }
    return null;
  };
  return { cmd, m, calls };
};

test('遷移先: 全商品に必ずあり、許可リストの 3 つだけ（月額 3・年額 2）', () => {
  const want = {
    'premium': BOTH_VENUES_DESTINATION,
    'premium-jra': '/premium-prediction/jra/',
    'premium-nankan': '/premium-prediction/nankan/',
    'premium-annual': BOTH_VENUES_DESTINATION,
    'premium-annual-light': BOTH_VENUES_DESTINATION,
  };
  assert.deepEqual(SUBSCRIPTION_PLANS.map((p) => p.id).sort(), Object.keys(want).sort(), '商品が増えたら遷移先も決める');
  for (const [id, d] of Object.entries(want)) {
    assert.equal(destinationForPlan(id), d, id);
    assert.ok(POST_PURCHASE_DESTINATIONS.includes(d));
  }
  assert.equal(BOTH_VENUES_DESTINATION, '/dashboard/?from=purchase#premium-predictions', '両会場は中央／南関を選べるマイページの Premium 枠（読み直しの合図つき）');
  for (const bad of ['', 'lifetime', 'premium-plus', 'https://evil.example/', null]) assert.equal(destinationForPlan(bad), null);
  assert.equal(destinationForVenues([]), null);
  assert.equal(destinationForVenues(['jra', 'other']), null);
});

test('買った会場がすべていまの権限で見られるときだけ（片方でも欠ければ従来のマイページ）', () => {
  const both = { canViewPremiumJra: true, canViewPremiumNankan: true };
  assert.equal(destinationForPurchase('premium', both), BOTH_VENUES_DESTINATION);
  assert.equal(destinationForPurchase('premium', { canViewPremiumJra: true, canViewPremiumNankan: false }), null);
  assert.equal(destinationForPurchase('premium-jra', { canViewPremiumJra: true }), '/premium-prediction/jra/');
  assert.equal(destinationForPurchase('premium-jra', { canViewPremiumNankan: true }), null);
  assert.equal(destinationForPurchase('premium-nankan', { canViewPremiumNankan: true }), '/premium-prediction/nankan/');
  assert.equal(destinationForPurchase('premium', null), null);
  assert.equal(destinationForPurchase('unknown', both), null);
});

test('印: 会員単位・24 時間・知らない商品や不正な会員 ID は置かない・取り出しは 1 回だけ', async () => {
  const r = memRedis();
  assert.equal(await markPostPurchase(r.cmd, { recordId: REC, planId: 'premium-jra', subscriptionId: 'I-ABCDEFGHIJ12' }), true);
  assert.deepEqual(r.calls[0].slice(0, 2), ['SET', postPurchaseKey(REC)]);
  assert.deepEqual(r.calls[0].slice(3), ['EX', POST_PURCHASE_TTL_SECONDS]);
  assert.equal(POST_PURCHASE_TTL_SECONDS, 86400);
  assert.doesNotMatch(r.calls[0][2], /@/, '印にメールアドレスを入れない');
  assert.deepEqual(await takePostPurchase(r.cmd, REC), { planId: 'premium-jra', subscriptionId: 'I-ABCDEFGHIJ12' });
  assert.equal(await takePostPurchase(r.cmd, REC), null);
  assert.equal(await markPostPurchase(r.cmd, { recordId: REC, planId: 'lifetime' }), false);
  assert.equal(await markPostPurchase(r.cmd, { recordId: 'rec1', planId: 'premium' }), false);
  assert.equal(await markPostPurchase(null, { recordId: REC, planId: 'premium' }), false);
  r.m.set(postPurchaseKey(REC), 'not json');
  assert.equal(await takePostPurchase(r.cmd, REC), null);
  r.m.set(postPurchaseKey(REC), JSON.stringify({ planId: 'https://evil.example/' }));
  assert.equal(await takePostPurchase(r.cmd, REC), null, '知らない商品の印は使わない');
});

test('印: GETDEL が使えない Redis でも GET → DEL で 1 回だけ', async () => {
  const m = new Map([[postPurchaseKey(REC), JSON.stringify({ planId: 'premium' })]]);
  const cmd = async ([c, k]) => {
    if (c === 'GETDEL') throw new Error('unknown command');
    if (c === 'GET') return m.get(k) ?? null;
    if (c === 'DEL') { m.delete(k); return 1; }
    return null;
  };
  assert.equal((await takePostPurchase(cmd, REC)).planId, 'premium');
  assert.equal(await takePostPurchase(cmd, REC), null);
});

test('配線（反映）: 印は購読が新たに会員へ結び付いたときだけ（更新・再送・競合では置かない）', () => {
  const src = read('./paypalSubscriptionServer.js');
  const at = src.indexOf('await markPostPurchase(redis,');
  assert.ok(at > 0);
  assert.equal(src.split('markPostPurchase(').length - 1, 1, '呼び出しは 1 か所');
  const block = src.lastIndexOf('if (decision.newlyAttached) {', at);
  assert.ok(block > 0 && src.indexOf('return { ok: true, action: \'write\'', block) > at, 'newlyAttached の中');
  assert.ok(src.indexOf('await at.patch(sub.recordId, decision.fields);') < at, 'Customers へ反映した後');
  assert.match(src, /const destination = status === 'active' \? destinationForPlan\(sub\.planId\) : null;/, '戻り先へ遷移先を返すのは active だけ');
});

test('配線（ログイン）: verify-magic-link は購入直後の印＋いまの権限で遷移先を決め、無ければ従来の /dashboard/', () => {
  const fn = read('../../../../netlify/functions/verify-magic-link.js');
  assert.match(fn, /const redirectTo = \(await postPurchaseRedirect\(m\.recordId, lastCustomerFields\)\) \|\| '\/dashboard\/';/);
  assert.match(fn, /resolveEntitlements\(fromAirtableFields\(fields\)\)/);
  assert.match(fn, /resolvePostLoginDestination\(\{ redis, recordId, entitlements \}\)/);
  // 有料セッションを発行した成功（OK）の分岐の中だけ
  assert.ok(fn.indexOf('case VERIFY_FLOW.OK: {') < fn.indexOf('await postPurchaseRedirect('));
  const page = read('../../../pages/auth/verify.astro');
  assert.match(page, /const serverDest = data\.redirectTo && data\.redirectTo !== '\/dashboard\/' \? data\.redirectTo : null;/);
  assert.match(page, /ok\(serverDest \|\| nextPath \|\| data\.redirectTo \|\| '\/dashboard\/'\);/);
});

test('配線（戻り先ページ）: 自動遷移は active の分岐だけ・行き先は許可リストの完全一致・未ログインはログイン画面へ', () => {
  const page = read('../../../pages/checkout/paypal-subscription-return.astro');
  const active = page.indexOf("if (st === 'active') {");
  const end = page.indexOf("if (st === 'needs_support')");
  const replaces = [...page.matchAll(/window\.location\.replace\(/g)].map((m) => m.index);
  assert.equal(replaces.length, 2, '自動遷移は 2 か所（未ログイン→ログイン・ログイン中→Premium）だけ');
  for (const i of replaces) assert.ok(i > active && i < end, 'active の分岐の中だけ（確認中・失敗・401・404 では遷移しない）');
  assert.match(page, /destinations\.indexOf\(x\.d\.destination\) !== -1 \? x\.d\.destination : null/);
  assert.match(page, /window\.location\.replace\(guest\.activeRedirect\)/);
  assert.equal(SUBSCRIPTION_RETURN_GUEST.activeRedirect, '/login/?from=paypal');
  assert.doesNotMatch(page.slice(end), /再度お支払い|もう一度お支払いください|再決済/, '失敗時に再決済を促さない');
});

test('配線（ログイン画面・マイページ）: 購入直後の案内は固定文言・Premium 枠は権限で表示されたときだけ強調', () => {
  const login = read('../../../pages/login.astro');
  assert.match(login, /get\('from'\) !== 'paypal'\) return;/);
  assert.match(login, /'お申し込みありがとうございます'/);
  const dash = read('../../../pages/dashboard.astro');
  assert.match(dash, /if \(window\.location\.hash === '#premium-predictions'\) \{/);
  assert.match(dash, /if \(_pp && _pp\.style\.display === 'block'\) \{/);
});

test('マイページ: 購入直後（?from=purchase）だけ会員レコードを読み直す（10 分キャッシュの古い Light を出さない）', async () => {
  const dash = read('../../../pages/dashboard.astro');
  assert.match(dash, /resolveViewer\(\{ request: Astro\.request, env: process\.env, forceFresh: Astro\.url\.searchParams\.get\('from'\) === 'purchase' \}\)/);
  const { resolveViewer } = await import('../../auth/viewerEntitlements.js');
  const { createSessionV2 } = await import('../../auth/index.js');
  const { SESSION_COOKIE_NAME } = await import('../../auth/constants.js');
  const secret = 'test-signing-secret-0123456789abcdef-XYZ';
  const env = { SESSION_SIGNING_SECRET: secret };
  const s = await createSessionV2({ secret, sub: 'recBUYERAAAAAAAAA', plan: 'light', venueAccess: ['jra', 'nankan'], sessionVersion: 1, now: Date.now(), ttlMs: 20 * 60 * 1000 });
  const cookie = `${SESSION_COOKIE_NAME}=${s.token}`;
  const request = new Request('https://analytics.keiba.link/dashboard/?from=purchase', { headers: { cookie } });
  const seen = [];
  const lookup = async (q) => { seen.push(q.maxAgeMs); return { ok: true, fields: { 'プラン': 'Premium', Status: 'active', PlanType: 'Monthly', '有効期限': '2099-01-01' } }; };
  const revoked = async () => false;
  await resolveViewer({ request, env, lookup, revoked, forceFresh: true });
  await resolveViewer({ request, env, lookup, revoked });
  assert.deepEqual(seen, [0, undefined], '購入直後は鮮度 0・通常はキャッシュ可');
});
