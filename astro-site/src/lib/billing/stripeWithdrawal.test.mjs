// stripeWithdrawal — Stripe 月額会員の即時退会（2026-10-07 MK 確定）の仕様を固定する
// Stripe / Airtable / Redis は差し替え（本番・テストモードとも非接触）。
//
// 固定する仕様:
//   退会確定 → 即時利用不可 / 未来の利用期限があっても利用不可 / 予約停止状態を新規作成しない /
//   解約取消導線なし / Stripe Customer Portal から解約できない / 他会員へ影響しない /
//   二重退会防止 / 直 URL で回避不可 / 再契約可能
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withdrawStripeSubscriber, decideWithdrawal, WITHDRAWAL_RESULT } from './stripeWithdrawal.js';
import {
  decideSubscriptionSync, snapshotSubscription, withdrawalFields, MEMBER_WITHDRAWAL_COMMENT,
} from './stripeSubscriptionSync.js';
import { applySubscription } from './stripeServer.js';
import { resolveEntitlements, fromAirtableFields } from '../entitlements/resolveEntitlements.js';
import { viewerProfile } from '../auth/viewerEntitlements.js';
import { gatePaidPage } from '../auth/paidPageGate.js';
import { issuePaidSessionCookie } from '../auth/sessionIssuance.js';
import { MEMBER_TYPE } from '../auth/memberResolution.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../../../${rel}`, import.meta.url)), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');

const ENV = {
  AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'appX',
  STRIPE_PRICE_PREMIUM: 'price_full', STRIPE_PRICE_PREMIUM_JRA: 'price_jra', STRIPE_PRICE_PREMIUM_NANKAN: 'price_nankan',
};
const NOW = new Date('2026-10-07T03:00:00Z'); // 12:00 JST
const PERIOD_END = Math.floor(Date.parse('2026-10-30T03:00:00Z') / 1000);
const REC_A = 'recAAAAAAAAAAAAAA';
const REC_B = 'recBBBBBBBBBBBBBB';

/** 契約中の Stripe 会員（利用期限は未来） */
const activeMember = (sub = 'sub_A', cus = 'cus_A', email = 'a@example.com') => ({
  Email: email, 'プラン': 'Premium', PlanType: 'Monthly', Status: 'active', '有効期限': '2026-11-01',
  VenueAccess: '', PaymentMethod: 'Stripe', StripeCustomerId: cus, StripeSubscriptionId: sub,
});

const subObj = (id, customer, over = {}) => ({
  id, customer, status: 'active', cancel_at_period_end: false, metadata: {},
  items: { data: [{ price: { id: 'price_full' }, current_period_end: PERIOD_END }] }, ...over,
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
    if (method === 'GET') {
      const f = u.searchParams.get('filterByFormula') || '';
      const m = f.match(/^\{StripeSubscriptionId\} = '(.*)'$/);
      return ok({ records: m ? [...rows.values()].filter((r) => r.fields.StripeSubscriptionId === m[1]) : [] });
    }
    if (method === 'PATCH') {
      const r = rows.get(id);
      const fields = JSON.parse(init.body).fields;
      patches.push([id, fields]);
      Object.assign(r.fields, fields);
      return ok(r);
    }
    throw new Error(`unexpected ${method}`);
  };
  return { rows, patches, fetchImpl };
}

function fakeStripe(subs, { cancelFails = false } = {}) {
  const cancels = [];
  const updates = [];
  return {
    cancels,
    updates,
    invoices: {
      list: async ({ subscription }) => ({ data: [{ status: 'paid', lines: { data: [{ period: { end: subs[subscription]?.items?.data?.[0]?.current_period_end } }] } }] }),
    },
    customers: { retrieve: async () => ({ email: 'a@example.com' }) },
    subscriptions: {
      retrieve: async (id) => {
        if (!subs[id]) throw new Error('No such subscription');
        return subs[id];
      },
      cancel: async (id, params, opts) => {
        cancels.push([id, params, opts]);
        if (cancelFails) throw new Error('stripe_down');
        subs[id] = { ...subs[id], status: 'canceled', ended_at: Math.floor(NOW.getTime() / 1000), cancellation_details: { comment: params?.cancellation_details?.comment || null } };
        return subs[id];
      },
      update: async (id, p) => { updates.push([id, p]); subs[id] = { ...subs[id], ...p }; return subs[id]; },
    },
  };
}

/** Redis SET NX の最小実装（同時実行の検証用） */
function fakeRedis() {
  const kv = new Map();
  return async ([cmd, key, val, ...rest]) => {
    if (cmd === 'SET') {
      if (rest.includes('NX') && kv.has(key)) return null;
      kv.set(key, val);
      return 'OK';
    }
    if (cmd === 'GET') return kv.has(key) ? kv.get(key) : null;
    if (cmd === 'DEL') { kv.delete(key); return 1; }
    return null;
  };
}

const canViewPremium = (fields, at = NOW) => resolveEntitlements(fromAirtableFields(fields), at.getTime()).canViewPremium === true;

// ── 退会確定 → 即時利用不可 / 未来の利用期限があっても利用不可 ──────────────────
test('退会確定で即時に有料権限が止まる（利用期限 2026-11-01 が未来でも残り期間は使えない）', async () => {
  const at = fakeAirtable([{ id: REC_A, fields: activeMember() }]);
  const stripe = fakeStripe({ sub_A: subObj('sub_A', 'cus_A') });
  assert.equal(canViewPremium(at.rows.get(REC_A).fields), true, '退会前は見られる');

  const r = await withdrawStripeSubscriber({ stripe, env: ENV, recordId: REC_A, reason: '使わなくなった', now: NOW, fetchImpl: at.fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.result, WITHDRAWAL_RESULT.WITHDRAWN);
  const f = at.rows.get(REC_A).fields;
  assert.equal(f.WithdrawalRequested, true);
  assert.equal(f['有効期限'], '2026-10-06', '利用期限は昨日（JST）へ縮む');
  assert.equal(f.WithdrawalDate, '2026-10-07');
  assert.equal(f.WithdrawalReason, '使わなくなった');
  // 退会の直後（同じ時刻）から見られない。利用期限の元の日付より前のどの時点でも見られない
  assert.equal(canViewPremium(f, NOW), false);
  assert.equal(canViewPremium(f, new Date(NOW.getTime() + 1000)), false);
  assert.equal(canViewPremium({ ...f, '有効期限': '2026-11-01' }, NOW), false, '期限が未来のままでも退会フラグで止まる');
});

test('Stripe の購読は即時解約（期間末解約にしない・日割り請求なし・idempotency key・退会の印）', async () => {
  const at = fakeAirtable([{ id: REC_A, fields: activeMember() }]);
  const stripe = fakeStripe({ sub_A: subObj('sub_A', 'cus_A') });
  await withdrawStripeSubscriber({ stripe, env: ENV, recordId: REC_A, now: NOW, fetchImpl: at.fetchImpl });
  assert.equal(stripe.cancels.length, 1);
  const [id, params, opts] = stripe.cancels[0];
  assert.equal(id, 'sub_A');
  assert.equal(params.prorate, false);
  assert.equal(params.invoice_now, false);
  assert.equal(params.cancellation_details.comment, MEMBER_WITHDRAWAL_COMMENT);
  assert.equal(opts.idempotencyKey, 'ak-withdraw-sub_A');
  // 予約停止（cancel_at_period_end）を作らない
  assert.equal(stripe.updates.some(([, p]) => 'cancel_at_period_end' in (p || {}) || 'cancel_at' in (p || {})), false);
});

// ── 予約停止状態を新規作成しない / 解約取消導線なし / ポータルで解約できない ─────────
test('予約停止・期間末解約・解約取消を作るコードが無い（サーバー・画面・ポータル設定）', () => {
  const roots = ['netlify/functions', 'src/lib', 'src/pages', 'scripts'];
  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(fileURLToPath(new URL(`../../../${dir}`, import.meta.url)), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) { if (!['node_modules', 'data'].includes(e.name)) walk(rel); } else if (/\.(m?js|astro)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(rel);
    }
  };
  roots.forEach(walk);
  for (const p of files) {
    const code = stripComments(read(p));
    assert.equal(/cancel_at_period_end\s*:\s*(true|false)/.test(code), false, `${p}: 予約停止 / 解約取消の書込み`);
    assert.equal(/mode\s*:\s*['"]at_period_end['"]/.test(code), false, `${p}: 期間末解約の設定`);
    assert.equal(/\bcancel_at\s*:/.test(code), false, `${p}: 解約予約`);
  }
  // ポータルの解約は無効（設定の単一源）
  const setup = stripComments(read('scripts/stripe-setup.mjs'));
  assert.match(setup, /subscription_cancel:\s*\{\s*enabled:\s*false\s*\}/);
  // ポータルを開くとき、AK の設定（解約無効）が無ければ Stripe の既定設定へ落とさず止める
  const portal = stripComments(read('netlify/functions/stripe-portal.js'));
  assert.match(portal, /portal_not_configured/);
  // 解約取消（resume / 継続）の入口がマイページに無い
  const dash = stripComments(read('src/pages/dashboard.astro'));
  assert.equal(/解約(の)?取り?消し|退会(の)?取り?消しボタン|resume/i.test(dash.replace(/退会後の取り消しはできません/g, '')), false);
});

// ── 確認画面 → 確定 の 2 段階 / 必須の説明 ─────────────────────────
test('マイページ: 「退会する」は確認画面を開くだけ。確定ボタンだけが stripe-withdraw を呼ぶ（confirm: true）', () => {
  const dash = read('src/pages/dashboard.astro');
  assert.match(dash, /id="ak-withdraw-open"[^>]*onclick="akOpenWithdraw\(\)"/);
  assert.match(dash, /id="ak-withdraw-confirm"[^>]*onclick="akConfirmWithdraw\(\)"/);
  const open = dash.slice(dash.indexOf('window.akOpenWithdraw'), dash.indexOf('window.akCloseWithdraw'));
  assert.equal(/stripe-withdraw/.test(open), false, '確認画面を開くだけで退会しない');
  const confirm = dash.slice(dash.indexOf('window.akConfirmWithdraw'));
  assert.match(confirm, /\/\.netlify\/functions\/stripe-withdraw/);
  assert.match(confirm, /confirm: true/);
  assert.match(confirm, /if \(akWithdrawInFlight\) return;/, '画面側の二重送信防止');
  // 確認画面の必須の説明
  assert.match(dash, /退会すると、現在の利用期限<span id="ak-withdraw-valid-until"><\/span>を待たずに、すぐにご利用いただけなくなります。/);
  assert.match(dash, /残りの期間のご利用を希望される場合は、退会せずにそのままご利用ください。/);
  // サーバーは confirm が無い送信を受けない・許可オリジンだけ・セッション必須
  const fn = stripComments(read('netlify/functions/stripe-withdraw.js'));
  assert.match(fn, /body\.confirm !== true\) return reply\(400/);
  assert.match(fn, /isAllowedOrigin\(origin\)\) return reply\(403/);
  assert.match(fn, /readSessionRecordId\(/);
  assert.equal(/body\.email|JSON\.parse\([^)]*\)\.email/.test(fn), false, 'メールアドレスで本人を決めない');
});

// ── 他会員へ影響しない / 本人の契約だけ ─────────────────────────────
test('他会員へ影響しない: 退会したレコード以外は書かず、他人の購読は解約しない', async () => {
  const at = fakeAirtable([
    { id: REC_A, fields: activeMember('sub_A', 'cus_A', 'a@example.com') },
    { id: REC_B, fields: activeMember('sub_B', 'cus_B', 'b@example.com') },
  ]);
  const stripe = fakeStripe({ sub_A: subObj('sub_A', 'cus_A'), sub_B: subObj('sub_B', 'cus_B') });
  const before = JSON.stringify(at.rows.get(REC_B).fields);
  await withdrawStripeSubscriber({ stripe, env: ENV, recordId: REC_A, now: NOW, fetchImpl: at.fetchImpl });
  assert.deepEqual(at.patches.map(([id]) => id), [REC_A]);
  assert.deepEqual(stripe.cancels.map(([id]) => id), ['sub_A']);
  assert.equal(JSON.stringify(at.rows.get(REC_B).fields), before);
  assert.equal(canViewPremium(at.rows.get(REC_B).fields), true);
  assert.equal(stripe.subscriptions && (await stripe.subscriptions.retrieve('sub_B')).status, 'active');
});

test('本人の契約だけ: レコードの購読と Stripe の顧客が一致しなければ何もしない', async () => {
  const at = fakeAirtable([{ id: REC_A, fields: activeMember('sub_A', 'cus_A') }]);
  // 購読 sub_A が別の顧客のもの（レコードの取り違え・改ざん）
  const stripe = fakeStripe({ sub_A: subObj('sub_A', 'cus_OTHER') });
  const r = await withdrawStripeSubscriber({ stripe, env: ENV, recordId: REC_A, now: NOW, fetchImpl: at.fetchImpl });
  assert.equal(r.result, WITHDRAWAL_RESULT.SUBSCRIPTION_MISMATCH);
  assert.equal(stripe.cancels.length, 0);
  assert.equal(at.patches.length, 0);
  // Stripe 月額でない会員（銀行振込）はこの経路で退会させない
  assert.equal(decideWithdrawal({ fields: { ...activeMember(), PaymentMethod: 'Bank Transfer' }, sub: snapshotSubscription(subObj('sub_A', 'cus_A')) }).reason, WITHDRAWAL_RESULT.NOT_STRIPE_SUBSCRIBER);
});

// ── 二重退会防止 ─────────────────────────────────────────
test('二重退会防止: 2 回目は already_withdrawn・Stripe の解約も書込みも 1 回だけ', async () => {
  const at = fakeAirtable([{ id: REC_A, fields: activeMember() }]);
  const stripe = fakeStripe({ sub_A: subObj('sub_A', 'cus_A') });
  const first = await withdrawStripeSubscriber({ stripe, env: ENV, recordId: REC_A, now: NOW, fetchImpl: at.fetchImpl });
  const second = await withdrawStripeSubscriber({ stripe, env: ENV, recordId: REC_A, now: new Date(NOW.getTime() + 500), fetchImpl: at.fetchImpl });
  assert.equal(first.result, WITHDRAWAL_RESULT.WITHDRAWN);
  assert.equal(second.result, WITHDRAWAL_RESULT.ALREADY_WITHDRAWN);
  assert.equal(stripe.cancels.length, 1);
  assert.equal(at.patches.length, 1);
});

test('二重退会防止（同時）: 並行した 2 本でも退会は 1 回（購読ごとのロックの中で読み直す）', async () => {
  const at = fakeAirtable([{ id: REC_A, fields: activeMember() }]);
  const stripe = fakeStripe({ sub_A: subObj('sub_A', 'cus_A') });
  const redis = fakeRedis();
  const [a, b] = await Promise.all([
    withdrawStripeSubscriber({ stripe, env: ENV, recordId: REC_A, now: NOW, fetchImpl: at.fetchImpl, redis }),
    withdrawStripeSubscriber({ stripe, env: ENV, recordId: REC_A, now: NOW, fetchImpl: at.fetchImpl, redis }),
  ]);
  assert.deepEqual([a.result, b.result].sort(), [WITHDRAWAL_RESULT.ALREADY_WITHDRAWN, WITHDRAWAL_RESULT.WITHDRAWN].sort());
  assert.equal(stripe.cancels.length, 1);
  assert.equal(at.patches.length, 1);
});

// ── 不整合を起こさない（単一の状態遷移）─────────────────────────────
test('Stripe の解約に失敗したら Customers を書かない（両方とも契約中のまま）', async () => {
  const at = fakeAirtable([{ id: REC_A, fields: activeMember() }]);
  const stripe = fakeStripe({ sub_A: subObj('sub_A', 'cus_A') }, { cancelFails: true });
  const r = await withdrawStripeSubscriber({ stripe, env: ENV, recordId: REC_A, now: NOW, fetchImpl: at.fetchImpl });
  assert.equal(r.result, WITHDRAWAL_RESULT.STRIPE_CANCEL_FAILED);
  assert.equal(at.patches.length, 0);
  assert.equal(canViewPremium(at.rows.get(REC_A).fields), true);
});

test('Customers の書込みが失敗しても、終了イベントが退会の印を見て同じ退会状態へ収束する', async () => {
  const at = fakeAirtable([{ id: REC_A, fields: activeMember() }]);
  const subs = { sub_A: subObj('sub_A', 'cus_A') };
  const stripe = fakeStripe(subs);
  // Stripe の解約は成功したが Customers に書けなかった状況を作る（解約だけ実行）
  await stripe.subscriptions.cancel('sub_A', { prorate: false, invoice_now: false, cancellation_details: { comment: MEMBER_WITHDRAWAL_COMMENT } }, {});
  // 終了イベント（customer.subscription.deleted）の反映
  const r = await applySubscription({ stripe, env: ENV, subscription: 'sub_A', now: NOW, fetchImpl: at.fetchImpl });
  assert.equal(r.reason, 'withdrawn');
  const f = at.rows.get(REC_A).fields;
  assert.equal(f.WithdrawalRequested, true);
  assert.equal(f['有効期限'], '2026-10-06');
  assert.equal(canViewPremium(f), false);
});

test('退会の後に届く終了イベントは退会状態を変えない（期限を延ばさない・理由を上書きしない）', async () => {
  const at = fakeAirtable([{ id: REC_A, fields: activeMember() }]);
  const stripe = fakeStripe({ sub_A: subObj('sub_A', 'cus_A') });
  await withdrawStripeSubscriber({ stripe, env: ENV, recordId: REC_A, reason: '理由A', now: NOW, fetchImpl: at.fetchImpl });
  await applySubscription({ stripe, env: ENV, subscription: 'sub_A', now: new Date(NOW.getTime() + 60_000), fetchImpl: at.fetchImpl });
  const f = at.rows.get(REC_A).fields;
  assert.equal(f['有効期限'], '2026-10-06');
  assert.equal(f.WithdrawalReason, '理由A');
  assert.equal(canViewPremium(f), false);
});

test('退会以外の終了（決済失敗の再試行切れ・管理者の解約）は従来どおり支払い済み期間の終わりまで', () => {
  const sub = snapshotSubscription(subObj('sub_A', 'cus_A', { status: 'canceled' }));
  assert.equal(sub.memberWithdrawal, false);
  const d = decideSubscriptionSync({ fields: activeMember(), sub, env: ENV, now: NOW, paidThrough: PERIOD_END });
  assert.equal(d.reason, 'ended');
  assert.equal(d.fields.WithdrawalRequested, undefined);
  assert.equal(d.expiration, '2026-10-31');
});

test('withdrawalFields は期限を縮めるだけ（既に過去ならそのまま）', () => {
  assert.equal(withdrawalFields({ fields: { '有効期限': '2026-09-01' }, now: NOW })['有効期限'], '2026-09-01');
  // JST 0 時台（UTC 前日）でも「昨日（JST）」になる
  assert.equal(withdrawalFields({ fields: {}, now: new Date('2026-10-06T15:30:00Z') })['有効期限'], '2026-10-06');
});

// ── 直 URL で回避不可 ───────────────────────────────────────
test('直 URL で回避不可: 退会前に発行された有料セッションで有料ページを開いても、退会後のレコードでは拒否', async () => {
  const SECRET = 'test-only-fixed-hmac-secret-DO-NOT-USE-IN-PROD-0123456789';
  const issued = await issuePaidSessionCookie({
    membership: { memberType: MEMBER_TYPE.PAID, normalizedPlan: 'premium', venueAccess: ['jra', 'nankan'], sessionVersion: 0, recordId: REC_A },
    secret: SECRET, now: NOW.getTime(), subtle: globalThis.crypto.subtle,
  });
  assert.ok(issued.ok);
  const request = new Request('https://example.test/premium-prediction/jra/', { headers: { cookie: issued.cookie.split(';')[0] } });
  const withdrawn = { ...activeMember(), ...withdrawalFields({ fields: activeMember(), now: NOW }) };
  for (const requiredPlan of ['premium', 'premium-jra', 'premium-nankan', 'Premium Sanrenpuku']) {
    const g = await gatePaidPage({ request, requiredPlan, env: { SESSION_SIGNING_SECRET: SECRET }, now: NOW.getTime() + 1000, lookup: async () => ({ ok: true, fields: withdrawn }) });
    assert.equal(g.ok, false, `${requiredPlan}: 退会後に開けてしまう`);
  }
  // マイページのアカウント管理（退会ボタン）も退会後は出さない
  assert.equal(viewerProfile(withdrawn).billing, null);
  assert.equal(viewerProfile(activeMember()).billing, 'stripe');
  // 退会の応答でセッション Cookie を消す
  assert.match(stripComments(read('netlify/functions/stripe-withdraw.js')), /'Set-Cookie': buildLogoutCookie\(\)/);
});

// ── 再契約可能 ────────────────────────────────────────────
test('再契約可能: 退会した会員が新しく契約すると、新規契約として有料権限が戻る', async () => {
  const at = fakeAirtable([{ id: REC_A, fields: activeMember() }]);
  const subs = { sub_A: subObj('sub_A', 'cus_A'), sub_NEW: subObj('sub_NEW', 'cus_A', { metadata: { ak_record_id: REC_A } }) };
  const stripe = fakeStripe(subs);
  await withdrawStripeSubscriber({ stripe, env: ENV, recordId: REC_A, now: NOW, fetchImpl: at.fetchImpl });
  assert.equal(canViewPremium(at.rows.get(REC_A).fields), false);

  // 申込前の判定（stripe-create-checkout と同じ probe）で弾かれない
  const probe = decideSubscriptionSync({
    fields: { ...at.rows.get(REC_A).fields, StripeSubscriptionId: '' },
    sub: { id: 'sub_probe', status: 'active', customerId: '', priceId: 'price_full', currentPeriodEnd: PERIOD_END, metadata: {} },
    env: ENV, now: NOW, paidThrough: PERIOD_END,
  });
  assert.notEqual(probe.action, 'conflict');

  // 新しい購読の反映（Webhook）
  const later = new Date(NOW.getTime() + 3600_000);
  const r = await applySubscription({ stripe, env: ENV, subscription: 'sub_NEW', now: later, fetchImpl: at.fetchImpl, allowCreate: true });
  assert.equal(r.reason, 'attached');
  const f = at.rows.get(REC_A).fields;
  assert.equal(f.WithdrawalRequested, false);
  assert.equal(f.StripeSubscriptionId, 'sub_NEW');
  assert.equal(canViewPremium(f, later), true);
  // 古い購読は解約済みのまま（二重課金にならない）
  assert.equal(subs.sub_A.status, 'canceled');
});
