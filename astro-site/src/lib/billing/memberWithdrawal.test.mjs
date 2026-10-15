// memberWithdrawal — AK の退会仕様（2026-10-15 MK 確定）を固定する。Airtable / Redis / 各社 API は差し替え（本番非接触）。
//
// 固定する仕様:
//   入口はマイページ（セッション必須）だけ・メールアドレスでは退会できない / 確認を経た送信だけ /
//   月額は各社の購読解約へ / 期限が残っていても契約由来の権限は即時停止 / 退会後もログイン・無料は使える /
//   退会直後の有料ページ・API・直 URL は拒否（古いセッション・キャッシュでも）/ 二重退会 / 別会員へ影響しない /
//   買い切り（Premium 買い切り・三連複の買い切り）は消さない / 無料会員は退会不要
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyMemberWithdrawal, memberWithdrawalFields, withdrawPlainMember,
  MEMBER_WITHDRAWAL_KIND as KIND, MEMBER_WITHDRAWAL_RESULT as RESULT,
} from './memberWithdrawal.js';
import { handleWithdrawRequest } from './memberWithdrawServer.js';
import { markSessionRevoked, isSessionRevoked, SESSION_REVOKED_PREFIX } from '../auth/sessionRevocation.js';
import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import { resolveMembership, MEMBER_TYPE, MEMBER_REASON } from '../auth/memberResolution.js';
import { gatePaidPage } from '../auth/paidPageGate.js';
import { issuePaidSessionCookie } from '../auth/sessionIssuance.js';
import { decideFreeLogin, FREE_LOGIN_OUTCOME } from '../auth/authPolicies.js';

const NOW = new Date('2026-10-15T03:00:00Z'); // 12:00 JST
const REC_A = 'recAAAAAAAAAAAAAA';
const REC_B = 'recBBBBBBBBBBBBBB';
const ORIGIN = 'https://analytics.keiba.link';
const SECRET = 'test-only-fixed-hmac-secret-DO-NOT-USE-IN-PROD-0123456789';
const ENV = { AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'appX', SESSION_SIGNING_SECRET: SECRET };

// 会員の種類（Airtable Customers の fields）
const annualPremium = (email = 'a@example.com') => ({
  Email: email, 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2027-06-01', PaymentMethod: 'Bank Transfer',
});
const annualLight = () => ({ Email: 'l@example.com', 'プラン': 'Light', PlanType: 'Annual', Status: 'active', '有効期限': '2027-03-01' });
const lifetimePremium = () => ({ Email: 'p@example.com', 'プラン': 'Premium', PlanType: 'Lifetime', Status: 'active', '有効期限': '2099-12-31' });
const sanrenpukuOnly = () => ({ Email: 's@example.com', 'プラン': 'Free', Status: 'active', LifetimeSanrenpuku: true });
const annualWithSanrenpuku = () => ({ ...annualPremium('as@example.com'), LifetimeSanrenpuku: true });
const free = () => ({ Email: 'f@example.com', 'プラン': 'Free', Status: 'active' });
const expired = () => ({ ...annualPremium('e@example.com'), '有効期限': '2026-09-01' });
const stripeMonthly = () => ({
  Email: 'st@example.com', 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', '有効期限': '2026-11-01',
  PaymentMethod: 'Stripe', StripeCustomerId: 'cus_A', StripeSubscriptionId: 'sub_A',
});
const paypalMonthly = () => ({
  Email: 'pp@example.com', 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', '有効期限': '2026-11-17', PaymentMethod: 'PayPal',
});

function fakeAirtable(initial) {
  const rows = new Map(initial.map((r) => [r.id, { id: r.id, fields: { ...r.fields } }]));
  const patches = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const id = decodeURIComponent(u.pathname.split('/').filter(Boolean)[3] || '');
    const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
    if (method === 'GET' && id) {
      const r = rows.get(id);
      return r ? ok(r) : { ok: false, status: 404, text: async () => '{"error":"NOT_FOUND"}' };
    }
    if (method === 'PATCH') {
      const r = rows.get(id);
      const fields = JSON.parse(init.body).fields;
      patches.push([id, fields]);
      Object.assign(r.fields, fields);
      return ok(r);
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  return { rows, patches, fetchImpl };
}

function fakeRedis() {
  const m = new Map();
  const cmd = async ([op, k, v, ...rest]) => {
    if (op === 'GET') return m.has(k) ? m.get(k) : null;
    if (op === 'DEL') { m.delete(k); return 1; }
    if (op === 'SET') {
      if (rest.includes('NX') && m.has(k)) return null;
      m.set(k, v);
      return 'OK';
    }
    throw new Error(`unexpected redis ${op}`);
  };
  return Object.assign(cmd, { map: m });
}

const event = ({ cookie = '', body = { confirm: true }, origin = ORIGIN, method = 'POST' } = {}) => ({
  httpMethod: method,
  headers: { origin, host: 'analytics.keiba.link', ...(cookie ? { cookie } : {}) },
  body: JSON.stringify(body),
});
async function sessionCookie(recordId, plan = 'premium') {
  const issued = await issuePaidSessionCookie({
    membership: { memberType: MEMBER_TYPE.PAID, normalizedPlan: plan, venueAccess: ['jra', 'nankan'], sessionVersion: 0, recordId },
    secret: SECRET, now: NOW.getTime(), subtle: globalThis.crypto.subtle,
  });
  assert.ok(issued.ok);
  return issued.cookie.split(';')[0];
}
const quiet = { adminNotice: async () => {}, sendMail: async () => {} };

// ── 種類 ─────────────────────────────────────────────────────
test('種類: 月額は各社・銀行振込の有料は contract・買い切りだけは lifetime_only・無料と期限切れは退会不要', () => {
  const k = (f) => classifyMemberWithdrawal(f, NOW.getTime()).kind;
  assert.equal(k(stripeMonthly()), KIND.STRIPE);
  assert.equal(k(paypalMonthly()), KIND.PAYPAL);
  assert.equal(k(annualPremium()), KIND.CONTRACT);
  assert.equal(k(annualLight()), KIND.CONTRACT);
  assert.equal(k(annualWithSanrenpuku()), KIND.CONTRACT);
  assert.equal(k(lifetimePremium()), KIND.LIFETIME_ONLY);
  assert.equal(k(sanrenpukuOnly()), KIND.LIFETIME_ONLY);
  assert.equal(k(free()), KIND.NONE);
  assert.equal(k(expired()), KIND.NONE);
  assert.equal(k({ ...annualPremium(), Status: 'pending' }), KIND.NONE, '入金待ちは契約が無い');
  assert.equal(k({ ...annualPremium(), WithdrawalRequested: true }), KIND.ALREADY_WITHDRAWN);
  const keeps = classifyMemberWithdrawal(annualWithSanrenpuku(), NOW.getTime()).keeps;
  assert.deepEqual(keeps, { premiumLifetime: false, sanrenpukuLifetime: true });
  assert.equal(classifyMemberWithdrawal(lifetimePremium(), NOW.getTime()).keeps.premiumLifetime, true);
});

test('書く値: 期間のある契約は期限を前日へ＋退会フラグ・買い切りは期限を書き換えない・三連複の列に触らない', () => {
  const a = memberWithdrawalFields({ fields: annualWithSanrenpuku(), now: NOW, reason: 'r' });
  assert.equal(a['有効期限'], '2026-10-14', '期限が残っていても前日へ縮める（即時停止）');
  assert.equal(a.WithdrawalRequested, true);
  assert.equal(a.WithdrawalDate, '2026-10-15');
  assert.equal('LifetimeSanrenpuku' in a, false, '三連複の買い切りの列を書いている');
  assert.equal('プラン' in a, false, 'プランを書き換えている（退会 ≠ 削除）');
  const l = memberWithdrawalFields({ fields: lifetimePremium(), now: NOW });
  assert.equal('有効期限' in l, false, 'Premium 買い切りの期限を書き換えている');
  assert.equal(l.WithdrawalRequested, true);
});

// ── 退会後: ログイン可・無料可・有料は即時停止・買い切りは残る ─────────────────
test('退会後: 同じアカウントでログインでき、無料は使える。期限が残っていても有料の閲覧は止まる', () => {
  const after = { ...annualPremium(), ...memberWithdrawalFields({ fields: annualPremium(), now: NOW }) };
  const m = resolveMembership({ fields: after, recordId: REC_A, now: NOW.getTime() });
  assert.equal(m.memberType, MEMBER_TYPE.FREE, '退会者がログインできない（denied）／有料のまま');
  assert.equal(m.reason, MEMBER_REASON.WITHDRAWAL_REQUESTED);
  assert.equal(decideFreeLogin(m).outcome, FREE_LOGIN_OUTCOME.FREE, '無料会員としてすぐログインできない');
  const e = resolveEntitlements(fromAirtableFields(after), NOW.getTime());
  assert.equal(e.canLogin, true);
  assert.equal(e.canViewFree, true);
  for (const f of ['canViewPremium', 'canViewPremiumJra', 'canViewPremiumNankan', 'canViewLight', 'canViewSanrenpuku', 'paidPremiumActive']) {
    assert.equal(e[f], false, `${f} が退会後も true`);
  }
  // 期限を縮めなくても（書き込みが一部しか反映されていなくても）退会フラグだけで止まる
  const flagOnly = { ...annualPremium(), WithdrawalRequested: true };
  assert.equal(resolveEntitlements(fromAirtableFields(flagOnly), NOW.getTime()).canViewPremium, false);
});

test('退会後も買い切りは残る: Premium 買い切りは Premium のまま・三連複の買い切りは三連複が見える', () => {
  const life = { ...lifetimePremium(), ...memberWithdrawalFields({ fields: lifetimePremium(), now: NOW }) };
  assert.equal(resolveEntitlements(fromAirtableFields(life), NOW.getTime()).canViewPremium, true);
  const ml = resolveMembership({ fields: life, recordId: REC_A, now: NOW.getTime() });
  assert.equal(ml.memberType, MEMBER_TYPE.PAID);
  assert.equal(ml.reason, MEMBER_REASON.WITHDRAWN_LIFETIME_KEPT);

  const srp = { ...annualWithSanrenpuku(), ...memberWithdrawalFields({ fields: annualWithSanrenpuku(), now: NOW }) };
  const e = resolveEntitlements(fromAirtableFields(srp), NOW.getTime());
  assert.equal(e.canViewSanrenpuku, true, '年払いの退会で三連複の買い切りが消えた');
  assert.equal(e.canViewPremium, false, '年払いの Premium が退会後も見える');
  assert.equal(resolveMembership({ fields: srp, recordId: REC_A, now: NOW.getTime() }).normalizedPlan, 'premium-sanrenpuku');
});

// ── 退会直後の有料ページ・API・直 URL ─────────────────────────────
test('退会直後: 退会前のセッションで有料ページ・API・直 URL を開いても拒否（キャッシュが古くても印で読み直す）', async () => {
  const cookie = await sessionCookie(REC_A);
  const before = annualPremium();
  const after = { ...before, ...memberWithdrawalFields({ fields: before, now: NOW }) };
  // 権利判定のキャッシュは退会前の値を持っている。鮮度を指定したときだけ最新（退会後）を返す
  const lookup = async ({ maxAgeMs }) => ({ ok: true, fields: maxAgeMs === 0 ? after : before });
  const requests = [
    new Request('https://analytics.keiba.link/premium-prediction/jra/', { headers: { cookie } }),
    new Request('https://analytics.keiba.link/api/ailab/view?market=jra', { headers: { cookie } }),
    new Request('https://analytics.keiba.link/premium-sanrenpuku/', { headers: { cookie } }),
  ];
  for (const request of requests) {
    for (const requiredPlan of ['premium', 'premium-jra', 'premium-nankan', 'light', 'Premium Sanrenpuku']) {
      const g = await gatePaidPage({
        request, requiredPlan, env: ENV, now: NOW.getTime() + 1000, lookup, revoked: async ({ recordId }) => recordId === REC_A,
      });
      assert.equal(g.ok, false, `${request.url} ${requiredPlan}: 退会直後に開けてしまう`);
    }
  }
  // 印が無い別会員は、同じキャッシュの仕組みでも従来どおり（印は退会した本人だけ）
  const g = await gatePaidPage({
    request: requests[0], requiredPlan: 'premium', env: ENV, now: NOW.getTime() + 1000,
    lookup: async () => ({ ok: true, fields: before }), revoked: async () => false,
  });
  assert.equal(g.ok, true);
});

test('印: 退会の確定で置き、本人だけが読み直し対象になる。Redis 障害は通常判定に任せる', async () => {
  const redis = fakeRedis();
  assert.equal(await markSessionRevoked(redis, REC_A, NOW.getTime()), true);
  assert.equal(await isSessionRevoked(redis, REC_A), true);
  assert.equal(await isSessionRevoked(redis, REC_B), false);
  assert.ok(redis.map.has(`${SESSION_REVOKED_PREFIX}${REC_A}`));
  const broken = async () => { throw new Error('down'); };
  assert.equal(await isSessionRevoked(broken, REC_A), false);
  assert.equal(await markSessionRevoked(null, REC_A), false);
});

// ── 入口: マイページ（セッション）だけ ──────────────────────────────
test('入口: セッションが無ければ 401。メールアドレス・recordId を送っても退会できない', async () => {
  const at = fakeAirtable([{ id: REC_A, fields: annualPremium() }]);
  for (const body of [
    { confirm: true, email: 'a@example.com' },
    { confirm: true, recordId: REC_A },
    { confirm: true, e2eRecordId: REC_A },
  ]) {
    const r = await handleWithdrawRequest(event({ body }), ENV, { deps: { fetchImpl: at.fetchImpl, redis: fakeRedis(), ...quiet } });
    assert.equal(r.statusCode, 401, JSON.stringify(body));
  }
  assert.equal(at.patches.length, 0, 'セッション無しで書いた');
});

test('入口: 確認を経ない送信・他サイト・GET は受けない', async () => {
  const cookie = await sessionCookie(REC_A);
  const at = fakeAirtable([{ id: REC_A, fields: annualPremium() }]);
  const deps = { fetchImpl: at.fetchImpl, redis: fakeRedis(), ...quiet };
  assert.equal((await handleWithdrawRequest(event({ cookie, body: {} }), ENV, { deps })).statusCode, 400);
  assert.equal((await handleWithdrawRequest(event({ cookie, body: { confirm: 'yes' } }), ENV, { deps })).statusCode, 400);
  assert.equal((await handleWithdrawRequest(event({ cookie, origin: 'https://evil.example' }), ENV, { deps })).statusCode, 403);
  assert.equal((await handleWithdrawRequest(event({ cookie, method: 'GET' }), ENV, { deps })).statusCode, 405);
  assert.equal(at.patches.length, 0);
});

test('退会: 年払いの会員はマイページから退会でき、即時停止・セッション削除・印・完了メール。二重退会は 409', async () => {
  const cookie = await sessionCookie(REC_A);
  const at = fakeAirtable([{ id: REC_A, fields: annualPremium() }, { id: REC_B, fields: annualPremium('b@example.com') }]);
  const redis = fakeRedis();
  const mails = [];
  const notices = [];
  const deps = {
    fetchImpl: at.fetchImpl, redis, now: NOW,
    sendMail: async (email, o) => { mails.push([email, o]); },
    adminNotice: async (d) => { notices.push(d); },
  };
  const r = await handleWithdrawRequest(event({ cookie, body: { confirm: true, reason: '使わなくなった' } }), ENV, { deps });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true, kind: KIND.CONTRACT });
  assert.match(r.headers['Set-Cookie'], /Max-Age=0|Expires=Thu, 01 Jan 1970/i, 'セッション Cookie を消していない');
  assert.equal(at.rows.get(REC_A).fields.WithdrawalRequested, true);
  assert.equal(at.rows.get(REC_A).fields['有効期限'], '2026-10-14');
  assert.equal(await isSessionRevoked(redis, REC_A), true, '退会直後の印を置いていない');
  assert.equal(mails.length, 1);
  assert.equal(mails[0][0], 'a@example.com');
  assert.equal(notices.length, 1);
  assert.equal(JSON.stringify(notices).includes('@'), false, '管理者通知にメールアドレスを載せている');
  // 他の会員には何もしていない
  assert.deepEqual(at.patches.map(([id]) => id), [REC_A]);
  assert.equal(at.rows.get(REC_B).fields.WithdrawalRequested, undefined);
  assert.equal(await isSessionRevoked(redis, REC_B), false);

  // 二重退会（2 回目・別タブ）: 409・書かない・メールを送らない
  const again = await handleWithdrawRequest(event({ cookie }), ENV, { deps });
  assert.equal(again.statusCode, 409);
  assert.equal(JSON.parse(again.body).error, 'already_withdrawn');
  assert.equal(at.patches.length, 1);
  assert.equal(mails.length, 1);
});

test('二重退会（同時に 2 本）: ロックの中で読み直すので書くのは 1 回', async () => {
  const at = fakeAirtable([{ id: REC_A, fields: annualPremium() }]);
  const redis = fakeRedis();
  const [x, y] = await Promise.all([
    withdrawPlainMember({ env: ENV, recordId: REC_A, now: NOW, fetchImpl: at.fetchImpl, redis }),
    withdrawPlainMember({ env: ENV, recordId: REC_A, now: NOW, fetchImpl: at.fetchImpl, redis }),
  ]);
  assert.deepEqual([x.result, y.result].sort(), [RESULT.ALREADY_WITHDRAWN, RESULT.WITHDRAWN].sort());
  assert.equal(at.patches.length, 1);
});

test('無料会員・期限切れは止める契約が無い（409 no_contract・何も書かない）', async () => {
  for (const fields of [free(), expired()]) {
    const at = fakeAirtable([{ id: REC_A, fields }]);
    const r = await handleWithdrawRequest(event({ cookie: await sessionCookie(REC_A) }), ENV, { deps: { fetchImpl: at.fetchImpl, redis: fakeRedis(), now: NOW, ...quiet } });
    assert.equal(r.statusCode, 409);
    assert.equal(JSON.parse(r.body).error, 'no_contract');
    assert.equal(at.patches.length, 0);
  }
});

test('買い切りだけの会員: 退会しても期限を書き換えず、権利は残る', async () => {
  const at = fakeAirtable([{ id: REC_A, fields: lifetimePremium() }]);
  const r = await handleWithdrawRequest(event({ cookie: await sessionCookie(REC_A) }), ENV, { deps: { fetchImpl: at.fetchImpl, redis: fakeRedis(), now: NOW, ...quiet } });
  assert.equal(r.statusCode, 200);
  assert.equal(at.rows.get(REC_A).fields['有効期限'], '2099-12-31');
  assert.equal(resolveEntitlements(fromAirtableFields(at.rows.get(REC_A).fields), NOW.getTime()).canViewPremium, true);
});

test('月額は各社の購読解約へ渡す（PayPal・Stripe）。互換の入口は自分の種類だけ受ける', async () => {
  const cookie = await sessionCookie(REC_A);
  for (const [fields, key] of [[stripeMonthly(), 'withdrawStripe'], [paypalMonthly(), 'withdrawPaypal']]) {
    const at = fakeAirtable([{ id: REC_A, fields }]);
    const called = [];
    const stub = async (input) => { called.push([key, input.recordId]); return { ok: true, result: 'withdrawn', email: fields.Email }; };
    const deps = { fetchImpl: at.fetchImpl, redis: fakeRedis(), now: NOW, stripe: {}, ...quiet, [key]: stub };
    const r = await handleWithdrawRequest(event({ cookie }), ENV, { deps });
    assert.equal(r.statusCode, 200, key);
    assert.deepEqual(called, [[key, REC_A]], `${key} を本人のレコードで呼んでいない`);
    assert.equal(at.patches.length, 0, '月額の会員に退会フラグだけ立てた（課金が続く）');
  }
  // 互換の入口: stripe-withdraw に PayPal 会員が来たら 404（操作しない）
  const at = fakeAirtable([{ id: REC_A, fields: paypalMonthly() }]);
  const r = await handleWithdrawRequest(event({ cookie }), ENV, {
    only: 'stripe', deps: { fetchImpl: at.fetchImpl, redis: fakeRedis(), now: NOW, ...quiet, withdrawPaypal: async () => assert.fail('呼ばない') },
  });
  assert.equal(r.statusCode, 404);
});

test('月額の購読解約に失敗したら何も書かず 502（退会フラグだけ立てて課金を残さない）', async () => {
  const at = fakeAirtable([{ id: REC_A, fields: paypalMonthly() }]);
  const redis = fakeRedis();
  const r = await handleWithdrawRequest(event({ cookie: await sessionCookie(REC_A) }), ENV, {
    deps: { fetchImpl: at.fetchImpl, redis, now: NOW, ...quiet, withdrawPaypal: async () => ({ ok: false, result: 'cancel_failed' }) },
  });
  assert.equal(r.statusCode, 502);
  assert.equal(at.patches.length, 0);
  assert.equal(await isSessionRevoked(redis, REC_A), false);
});

test('旧入口 process-withdrawal は廃止（メールアドレスで呼んでも 410・何もしない）', async () => {
  const { handler } = await import('../../../netlify/functions/process-withdrawal.js');
  const r = await handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ email: 'a@example.com', reason: 'x' }) });
  assert.equal(r.statusCode, 410);
  assert.equal(JSON.parse(r.body).error, 'moved_to_mypage');
});
