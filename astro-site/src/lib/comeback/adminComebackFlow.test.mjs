/**
 * adminComebackFlow.test.mjs — 一覧 → dry-run → 付与 → 取り消し の統合テスト
 *   node --test src/lib/comeback/adminComebackFlow.test.mjs
 *
 * fetch を差し替えた偽 Airtable に対して Function ハンドラを直接呼ぶ。
 * ネットワーク・SendGrid・本番 Airtable には一切触れない。
 *
 * 確認する性質:
 *   - 認可（secret 不一致で 403）
 *   - dry-run は 1 バイトも書かない
 *   - gate（フィールド未作成 / 実行無効）では書き込みゼロで 503
 *   - 有効化しても **特典フィールド以外を 1 つも書かない**
 *   - 同じ operationId の再実行で二重付与しない
 *   - dry-run 後に対象が変わったら 409 で全体停止
 *   - メールを 1 通も送らない
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../../../netlify/functions/admin-comeback-grants.js';
import { PROMO_FIELDS, PROMO_FORBIDDEN_FIELDS } from '../entitlements/promotionalGrants.js';

const L = PROMO_FIELDS.light;
const P = PROMO_FIELDS.premium;

const SECRET = 'test-secret';
const ENV_KEYS = ['PREMIUM_PLUS_ADMIN_SECRET', 'COMEBACK_ADMIN_SECRET', 'AIRTABLE_API_KEY',
  'AIRTABLE_BASE_ID', 'COMEBACK_GRANT_FIELDS_READY', 'COMEBACK_GRANT_ENABLED',
  'COMEBACK_OFFER_TABLE_READY', 'PROMO_OFFER_SECRET'];
const savedEnv = {};
let realFetch;
let store;

/** 偽 Customers（期限切れ / 有効 Premium / Light / Free / 退会 / 停止 / 三連複保有） */
const BASE_CUSTOMERS = [
  { id: 'rec1', fields: { Email: 'ex1@example.com', 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2026-03-01', '氏名': '山田' } },
  { id: 'rec2', fields: { Email: 'ex2@example.com', 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2026-02-01' } },
  { id: 'rec3', fields: { Email: 'active@example.com', 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2099-01-01' } },
  { id: 'rec4', fields: { Email: 'light@example.com', 'プラン': 'Light', Status: 'active', '有効期限': '2099-01-01' } },
  { id: 'rec5', fields: { Email: 'free@example.com', 'プラン': 'Free', Status: 'active' } },
  { id: 'rec6', fields: { Email: 'gone@example.com', 'プラン': 'Premium', Status: 'active', '有効期限': '2026-01-01', WithdrawalRequested: true } },
  { id: 'rec7', fields: { Email: 'stop@example.com', 'プラン': 'Premium', Status: 'suspended', '有効期限': '2026-01-01' } },
  { id: 'rec8', fields: { Email: 'srp@example.com', 'プラン': 'Premium', Status: 'active', '有効期限': '2026-01-01', LifetimeSanrenpuku: true, PaymentConfirmed: true, PaidAt: '2025-01-01' } },
];

function makeResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function installFakeAirtable() {
  store = {
    customers: BASE_CUSTOMERS.map((r) => ({ id: r.id, fields: { ...r.fields } })),
    offers: [],
    writes: [],
    offerWrites: [],
    mailCalls: 0,
    failNextPatch: false,
  };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();

    // メール送信経路に触れたら事故。必ず検出する。
    if (u.includes('sendgrid') || u.includes('mail/send')) {
      store.mailCalls += 1;
      throw new Error('メール送信 API が呼ばれた');
    }
    if (!u.includes('api.airtable.com')) throw new Error(`想定外の外部通信: ${u}`);

    if (u.includes('/Customers')) {
      if (method === 'GET') return makeResponse({ records: store.customers });
      if (method === 'PATCH') {
        const body = JSON.parse(init.body);
        store.writes.push({ table: 'Customers', method, records: body.records });
        if (store.failNextPatch) { store.failNextPatch = false; return makeResponse({ error: 'boom' }, 422); }
        for (const rec of body.records) {
          const hit = store.customers.find((c) => c.id === rec.id);
          if (hit) Object.assign(hit.fields, rec.fields);
        }
        return makeResponse({ records: body.records });
      }
      store.writes.push({ table: 'Customers', method });
      return makeResponse({ error: 'unexpected write' }, 403);
    }
    if (u.includes('/PromotionalOffers')) {
      if (method === 'GET') return makeResponse({ records: store.offers });
      if (method === 'PATCH') {
        const body = JSON.parse(init.body);
        store.writes.push({ table: 'PromotionalOffers', method, records: body.records });
        store.offerWrites.push(...body.records);
        // OfferKey で upsert（同じ key は 1 行のまま）
        for (const rec of body.records) {
          const key = rec.fields.OfferKey;
          const hit = store.offers.find((o) => o.fields.OfferKey === key);
          if (hit) Object.assign(hit.fields, rec.fields);
          else store.offers.push({ id: `off${store.offers.length + 1}`, fields: { ...rec.fields } });
        }
        return makeResponse({ records: body.records });
      }
      store.writes.push({ table: 'PromotionalOffers', method });
      return makeResponse({ error: 'unexpected write' }, 403);
    }
    throw new Error(`想定外のテーブル: ${u}`);
  };
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.PREMIUM_PLUS_ADMIN_SECRET = SECRET;
  delete process.env.COMEBACK_ADMIN_SECRET;
  process.env.AIRTABLE_API_KEY = 'key';
  process.env.AIRTABLE_BASE_ID = 'base';
  delete process.env.COMEBACK_GRANT_FIELDS_READY;
  delete process.env.COMEBACK_GRANT_ENABLED;
  delete process.env.COMEBACK_OFFER_TABLE_READY;
  process.env.PROMO_OFFER_SECRET = 'test-offer-secret-0123456789';
  realFetch = globalThis.fetch;
  installFakeAirtable();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const call = (payload, secret = SECRET) => handler({
  httpMethod: 'POST', headers: { 'x-admin-secret': secret }, body: JSON.stringify(payload),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body) });
const enableWrites = () => {
  process.env.COMEBACK_GRANT_FIELDS_READY = '1';
  process.env.COMEBACK_OFFER_TABLE_READY = '1';
  process.env.COMEBACK_GRANT_ENABLED = 'true';
};
/** 主要施策（Light 永久無料 ＋ Premium 30日無料） */
const FULL = { lightOfferId: 'light-lifetime-free', premiumOfferId: 'premium-30d-free' };

// ═══ 認可 ════════════════════════════════════════════════════════════

test('secret 不一致は 403（Airtable へ触れない）', async () => {
  const { status } = parse(await call({ action: 'customers' }, 'wrong'));
  assert.equal(status, 403);
  assert.equal(store.writes.length, 0);
});

test('secret 未設定なら機能ごと無効（503）', async () => {
  delete process.env.PREMIUM_PLUS_ADMIN_SECRET;
  assert.equal(parse(await call({ action: 'offers' })).status, 503);
});

// ═══ 特典カタログ / 一覧 ══════════════════════════════════════════════

test('offers は Light / Premium無料 / Premium割引 を分けて返す（既定は書き込み無効）', async () => {
  const { status, body } = parse(await call({ action: 'offers' }));
  assert.equal(status, 200);
  assert.ok(body.lightOffers.some((o) => o.offerId === 'light-lifetime-free'));
  assert.ok(body.premiumGrantOffers.some((o) => o.offerId === 'premium-30d-free'));
  assert.ok(body.premiumPurchaseOffers.some((o) => o.offerId === 'premium-annual-half'));
  assert.equal(body.premiumPurchaseOffers.every((o) => o.kind === 'purchase_offer'), true);
  assert.equal(body.fieldsReady, false);
  assert.equal(body.offerTableReady, false);
  assert.equal(body.writeEnabled, false);
  assert.equal(body.regularPrice.premium_annual, 49800);
});

test('一覧は特典状態と付与可否を返し、退会は付与不可・オファーは可として出る', async () => {
  const { status, body } = parse(await call({ action: 'customers' }));
  assert.equal(status, 200);
  assert.equal(body.totalCustomers, BASE_CUSTOMERS.length);
  const byId = Object.fromEntries(body.rows.map((r) => [r.recordId, r]));
  assert.equal(byId.rec1.grantable, true);
  assert.equal(byId.rec6.grantable, false, '退会者へ無料付与できることになっている');
  assert.equal(byId.rec6.grantBlockedReason, 'withdrawal_blocked');
  assert.equal(byId.rec6.offerable, true, '退会者へ割引オファーも出せなくなっている');
  assert.equal(byId.rec7.grantable, false);
  assert.equal(byId.rec7.offerable, false, '停止アカウントへオファーを出せてしまう');
  assert.equal(byId.rec1.promoText, '特典なし');
  assert.equal(store.writes.length, 0, '一覧で書き込みが発生した');
});

test('特典の有無で絞り込める', async () => {
  assert.equal(parse(await call({ action: 'customers', promo: 'none' })).body.matchedCount, BASE_CUSTOMERS.length);
  assert.equal(parse(await call({ action: 'customers', promo: 'any' })).body.matchedCount, 0);
  assert.ok(parse(await call({ action: 'customers', contract: 'expired' })).body.matchedCount >= 2);
});

// ═══ 文面プレビュー（送信しない）══════════════════════════════════════

test('preview は選んだ特典から文面を生成し、送信しない', async () => {
  const { status, body } = parse(await call({
    action: 'preview', ...FULL,
  }));
  assert.equal(status, 200);
  assert.match(body.body, /Light プランを無期限で無料/);
  assert.match(body.body, /Premium プランを30日間 無料/);
  assert.match(body.notice, /送信しません/);
  assert.equal(store.mailCalls, 0);
  assert.equal(store.writes.length, 0);
});

test('preview は割引の金額を本文に入れる', async () => {
  const { body } = parse(await call({
    action: 'preview', lightOfferId: 'light-lifetime-free', premiumOfferId: 'premium-annual-half',
  }));
  assert.match(body.body, /通常 ¥49,800 のところ/);
  assert.match(body.body, /¥24,900/);
});

// ═══ dry-run ═════════════════════════════════════════════════════════

test('dry-run は書き込みゼロ。理由別内訳と before/after を返す', async () => {
  const { status, body } = parse(await call({
    action: 'dryRun', ...FULL,
    recordIds: ['rec1', 'rec2', 'rec3', 'rec6', 'rec7'],
  }));
  assert.equal(status, 200);
  assert.equal(body.mode, 'dry-run');
  assert.equal(body.sideEffects, 'none');
  assert.equal(store.writes.length, 0);
  assert.equal(body.selected, 5);
  assert.equal(body.willGrant, 3, '期限切れ2 + 有効Premium(Lightのみ)');
  assert.equal(body.skipped, 2);
  assert.ok(body.operationId);
  assert.ok(body.planFingerprint);
  const reasons = Object.fromEntries(body.skippedDetail.map((d) => [d.reason, d.count]));
  assert.equal(reasons.withdrawal_blocked, 1);
  assert.equal(reasons.account_suspended, 1);
  // 顧客ごとの before/after
  const p1 = body.preview.find((p) => p.recordId === 'rec1');
  assert.match(p1.before, /期限切れ/);
  assert.match(p1.after, /Premium 無料/);
  assert.match(p1.after, /Light 永久無料/);
  // 有効 Premium は Premium 部分だけ「変更不要」
  const p3 = body.preview.find((p) => p.recordId === 'rec3');
  assert.equal(p3.partial[0].label, '有料契約が優先で変更不要');
  // パート別の内訳が出る（Light 何件 / Premium 何件 / offer 何件）
  assert.equal(body.parts.lightGrant, 3);
  assert.equal(body.parts.premiumGrant, 2);
  assert.equal(body.parts.purchaseOffer, 0);
});

test('dry-run: Light 無料 ＋ Premium 割引（件数が別々に出る）', async () => {
  const { body } = parse(await call({
    action: 'dryRun', lightOfferId: 'light-lifetime-free', premiumOfferId: 'premium-annual-half',
    recordIds: ['rec1', 'rec2', 'rec6'],
  }));
  assert.equal(body.willGrant, 2, '退会者へ無料付与している');
  assert.equal(body.willOffer, 3, '退会者へ割引オファーを出していない');
  assert.equal(body.purchaseOffer.regularPrice, 49800);
  assert.equal(body.purchaseOffer.offerPrice, 24900);
  assert.equal(body.purchaseOffer.planType, 'Annual');
  assert.equal(store.writes.length, 0);
});

test('dry-run: 任意期限・任意価格を検証する', async () => {
  const ok = parse(await call({
    action: 'dryRun', lightOfferId: 'light-custom-free', lightCustomDays: 45,
    premiumOfferId: 'premium-annual-custom', premiumCustomPrice: 19800,
    recordIds: ['rec1'],
  }));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.purchaseOffer.offerPrice, 19800);
  assert.match(ok.body.selection, /45日間 無料/);

  // 通常価格以上・安すぎ・日数不正はすべて 400（書き込みゼロ）
  for (const bad of [
    { lightOfferId: 'light-custom-free', lightCustomDays: 0 },
    { lightOfferId: 'light-custom-free', lightCustomDays: 99999 },
    { premiumOfferId: 'premium-annual-custom', premiumCustomPrice: 60000 },
    { premiumOfferId: 'premium-annual-custom', premiumCustomPrice: 100 },
    { premiumOfferId: 'premium-annual-custom' },
  ]) {
    const r = parse(await call({ action: 'dryRun', ...bad, recordIds: ['rec1'] }));
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal(store.writes.length, 0);
});

test('dry-run は gate が閉じていても使える（確認だけ）', async () => {
  const { status, body } = parse(await call({ action: 'dryRun', lightOfferId: 'light-lifetime-free', recordIds: ['rec1'] }));
  assert.equal(status, 200);
  assert.equal(body.writeEnabled, false);
  assert.equal(store.writes.length, 0);
});

// ═══ gate ════════════════════════════════════════════════════════════

test('特典フィールド未作成なら無料付与は 503 で書き込みゼロ', async () => {
  const dry = parse(await call({ action: 'dryRun', ...FULL, recordIds: ['rec1'] }));
  const { status, body } = parse(await call({
    action: 'apply', ...FULL, recordIds: ['rec1'],
    operationId: dry.body.operationId, planFingerprint: dry.body.planFingerprint,
  }));
  assert.equal(status, 503);
  assert.equal(body.flag, 'COMEBACK_GRANT_FIELDS_READY');
  assert.equal(body.sideEffects, 'none');
  assert.equal(store.writes.length, 0);
});

test('オファー台帳未作成なら割引の実行は 503 で書き込みゼロ', async () => {
  process.env.COMEBACK_GRANT_FIELDS_READY = '1';
  process.env.COMEBACK_GRANT_ENABLED = 'true';
  const sel = { lightOfferId: 'light-lifetime-free', premiumOfferId: 'premium-annual-half' };
  const dry = parse(await call({ action: 'dryRun', ...sel, recordIds: ['rec1'] }));
  const { status, body } = parse(await call({
    action: 'apply', ...sel, recordIds: ['rec1'],
    operationId: dry.body.operationId, planFingerprint: dry.body.planFingerprint,
  }));
  assert.equal(status, 503);
  assert.equal(body.flag, 'COMEBACK_OFFER_TABLE_READY');
  assert.equal(store.writes.length, 0);
});

test('フィールドが有効でも COMEBACK_GRANT_ENABLED 未設定なら 503', async () => {
  process.env.COMEBACK_GRANT_FIELDS_READY = '1';
  const dry = parse(await call({ action: 'dryRun', ...FULL, recordIds: ['rec1'] }));
  const { status, body } = parse(await call({
    action: 'apply', ...FULL, recordIds: ['rec1'],
    operationId: dry.body.operationId, planFingerprint: dry.body.planFingerprint,
  }));
  assert.equal(status, 503);
  assert.equal(body.flag, 'COMEBACK_GRANT_ENABLED');
  assert.equal(store.writes.length, 0);
});

// ═══ 実行（無料付与）═════════════════════════════════════════════════

test('有効化すると特典フィールドだけを書く（課金・契約・三連複は不変）', async () => {
  enableWrites();
  const before = JSON.parse(JSON.stringify(store.customers.find((c) => c.id === 'rec8').fields));
  const dry = parse(await call({ action: 'dryRun', ...FULL, recordIds: ['rec1', 'rec8'] }));
  const { status, body } = parse(await call({
    action: 'apply', ...FULL, recordIds: ['rec1', 'rec8'],
    operationId: dry.body.operationId, planFingerprint: dry.body.planFingerprint,
  }));
  assert.equal(status, 200);
  assert.equal(body.mode, 'applied');
  assert.equal(body.granted, 2);
  assert.equal(body.offersIssued, 0);
  assert.equal(body.emailSent, false);
  assert.equal(store.mailCalls, 0);

  const written = new Set();
  for (const w of store.writes) for (const r of (w.records || [])) for (const k of Object.keys(r.fields)) written.add(k);
  for (const forbidden of PROMO_FORBIDDEN_FIELDS) {
    assert.equal(written.has(forbidden), false, `${forbidden} を書いた`);
  }
  const after = store.customers.find((c) => c.id === 'rec8').fields;
  for (const k of ['プラン', 'PlanType', 'Status', '有効期限', 'PaidAt', 'PaymentConfirmed', 'LifetimeSanrenpuku']) {
    assert.deepEqual(after[k], before[k], `${k} が書き換わった`);
  }
  assert.equal(after[L.LIFETIME], true);
  assert.ok(after[P.UNTIL]);
});

test('Light と Premium は 1 顧客 1 PATCH で同時に入る', async () => {
  enableWrites();
  const dry = parse(await call({ action: 'dryRun', ...FULL, recordIds: ['rec1'] }));
  await call({ action: 'apply', ...FULL, recordIds: ['rec1'], operationId: dry.body.operationId, planFingerprint: dry.body.planFingerprint });
  const patched = store.writes.filter((w) => w.table === 'Customers' && w.method === 'PATCH');
  assert.equal(patched.length, 1);
  assert.equal(patched[0].records.length, 1);
  const f = patched[0].records[0].fields;
  assert.ok(f[L.LIFETIME]);
  assert.ok(f[P.UNTIL]);
});

test('任意期限の無料付与が実際に反映される', async () => {
  enableWrites();
  const sel = { lightOfferId: 'light-custom-free', lightCustomDays: 45 };
  const dry = parse(await call({ action: 'dryRun', ...sel, recordIds: ['rec1'] }));
  await call({ action: 'apply', ...sel, recordIds: ['rec1'], operationId: dry.body.operationId, planFingerprint: dry.body.planFingerprint });
  const f = store.customers.find((c) => c.id === 'rec1').fields;
  assert.equal(f[L.LIFETIME], false);
  const days = Math.round((Date.parse(f[L.UNTIL]) - Date.now()) / 86400000);
  assert.equal(days, 45);
});

// ═══ 実行（割引オファー）═════════════════════════════════════════════

test('割引オファーは台帳にだけ書き、Customers を 1 バイトも触らない', async () => {
  enableWrites();
  const sel = { premiumOfferId: 'premium-annual-half' };
  const before = JSON.parse(JSON.stringify(store.customers.find((c) => c.id === 'rec1').fields));
  const dry = parse(await call({ action: 'dryRun', ...sel, recordIds: ['rec1'] }));
  const { status, body } = parse(await call({
    action: 'apply', ...sel, recordIds: ['rec1'],
    operationId: dry.body.operationId, planFingerprint: dry.body.planFingerprint,
  }));
  assert.equal(status, 200);
  assert.equal(body.granted, 0);
  assert.equal(body.offersIssued, 1);
  assert.deepEqual(store.customers.find((c) => c.id === 'rec1').fields, before, 'Customers が書き換わった');
  assert.equal(store.writes.filter((w) => w.table === 'Customers' && w.method === 'PATCH').length, 0);

  const row = store.offers[0].fields;
  assert.equal(row.OfferPrice, 24900);
  assert.equal(row.RegularPrice, 49800);
  assert.equal(row.Status, 'issued');
  assert.equal(row.PlanType, 'Annual');
  // 生トークンは応答にだけ現れ、台帳にはハッシュしか無い
  assert.ok(body.offerTokens[0].url.includes('?t='));
  assert.equal(JSON.stringify(row).includes(body.offerTokens[0].url.split('?t=')[1]), false);
  assert.ok(row.TokenHash);
});

test('同じ operationId の再実行で二重付与・二重発行しない', async () => {
  enableWrites();
  const sel = { lightOfferId: 'light-lifetime-free', premiumOfferId: 'premium-annual-half' };
  const dry = parse(await call({ action: 'dryRun', ...sel, recordIds: ['rec1', 'rec2'] }));
  const op = dry.body.operationId;
  await call({ action: 'apply', ...sel, recordIds: ['rec1', 'rec2'], operationId: op, planFingerprint: dry.body.planFingerprint });
  const offersAfterFirst = store.offers.length;
  const writesAfterFirst = store.writes.length;

  const dry2 = parse(await call({ action: 'dryRun', ...sel, recordIds: ['rec1', 'rec2'], operationId: op }));
  assert.equal(dry2.body.willGrant, 0);
  assert.equal(dry2.body.willOffer, 0);
  const again = parse(await call({
    action: 'apply', ...sel, recordIds: ['rec1', 'rec2'], operationId: op, planFingerprint: dry2.body.planFingerprint,
  }));
  assert.equal(again.status, 400, '0 件でも書き込もうとしている');
  assert.equal(store.offers.length, offersAfterFirst, 'オファー行が増えた');
  assert.equal(store.writes.length, writesAfterFirst, '再実行で追加の書き込みが発生した');
});

// ═══ TOCTOU / 入力検証 ═══════════════════════════════════════════════

test('dry-run 後に対象状態が変わったら 409 で全体停止（書き込みゼロ）', async () => {
  enableWrites();
  const dry = parse(await call({ action: 'dryRun', ...FULL, recordIds: ['rec1', 'rec2'] }));
  store.customers.find((c) => c.id === 'rec2').fields[L.LIFETIME] = true;
  store.customers.find((c) => c.id === 'rec2').fields[P.UNTIL] = new Date(Date.now() + 86400000).toISOString();
  const writesBefore = store.writes.length;
  const { status, body } = parse(await call({
    action: 'apply', ...FULL, recordIds: ['rec1', 'rec2'],
    operationId: dry.body.operationId, planFingerprint: dry.body.planFingerprint,
  }));
  assert.equal(status, 409);
  assert.equal(body.sideEffects, 'none');
  assert.equal(store.writes.length, writesBefore, '409 なのに書き込みが起きた');
});

test('operationId / planFingerprint が無い実行要求は拒否', async () => {
  enableWrites();
  assert.equal(parse(await call({ action: 'apply', ...FULL, recordIds: ['rec1'] })).status, 400);
  assert.equal(parse(await call({ action: 'apply', ...FULL, recordIds: ['rec1'], operationId: 'op-x' })).status, 400);
  assert.equal(store.writes.length, 0);
});

test('上限超過・未知オファー・空選択は拒否', async () => {
  enableWrites();
  assert.equal(parse(await call({ action: 'dryRun', lightOfferId: 'nope', recordIds: ['rec1'] })).status, 400);
  assert.equal(parse(await call({ action: 'dryRun', ...FULL, recordIds: [] })).status, 400);
  assert.equal(parse(await call({ action: 'dryRun', recordIds: ['rec1'] })).status, 400);
  const many = Array.from({ length: 201 }, (_, i) => `rec${i}`);
  assert.equal(parse(await call({ action: 'dryRun', ...FULL, recordIds: many })).status, 400);
});

// ═══ 部分失敗と再開 ═══════════════════════════════════════════════════

test('書き込み失敗は途中で止め、適用済み件数と復旧手順を返す', async () => {
  enableWrites();
  const sel = { lightOfferId: 'light-lifetime-free' };
  const dry = parse(await call({ action: 'dryRun', ...sel, recordIds: ['rec1', 'rec2'] }));
  store.failNextPatch = true;
  const { status, body } = parse(await call({
    action: 'apply', ...sel, recordIds: ['rec1', 'rec2'],
    operationId: dry.body.operationId, planFingerprint: dry.body.planFingerprint,
  }));
  assert.equal(status, 502);
  assert.equal(body.granted, 0);
  assert.equal(body.offersIssued, 0, '付与が落ちたのにオファーを発行している');
  assert.equal(body.sideEffects, 'none');
  assert.match(body.howToRecover, /同じ operationId/);

  const dry2 = parse(await call({ action: 'dryRun', ...sel, recordIds: ['rec1', 'rec2'], operationId: dry.body.operationId }));
  const retry = parse(await call({
    action: 'apply', ...sel, recordIds: ['rec1', 'rec2'],
    operationId: dry.body.operationId, planFingerprint: dry2.body.planFingerprint,
  }));
  assert.equal(retry.status, 200);
  assert.equal(retry.body.granted, 2);
});

test('reconcile は grant と offer の適用状況を read-only で返す', async () => {
  enableWrites();
  const sel = { lightOfferId: 'light-lifetime-free', premiumOfferId: 'premium-annual-half' };
  const dry = parse(await call({ action: 'dryRun', ...sel, recordIds: ['rec1'] }));
  const op = dry.body.operationId;
  await call({ action: 'apply', ...sel, recordIds: ['rec1'], operationId: op, planFingerprint: dry.body.planFingerprint });

  const writes = store.writes.length;
  const rc = parse(await call({ action: 'reconcile', operationId: op, recordIds: ['rec1', 'rec2'] }));
  assert.equal(rc.status, 200);
  assert.equal(rc.body.sideEffects, 'none');
  assert.equal(rc.body.applied, 1);
  assert.equal(rc.body.missing, 1);
  assert.equal(rc.body.offersIssued, 1);
  assert.equal(store.writes.length, writes, 'reconcile が書き込んだ');
});

// ═══ 取り消し ════════════════════════════════════════════════════════

test('取り消しは無料権利だけを消す（有料契約・三連複・発行済みオファーは不変）', async () => {
  enableWrites();
  const sel = { lightOfferId: 'light-lifetime-free', premiumOfferId: 'premium-annual-half' };
  const dry = parse(await call({ action: 'dryRun', ...sel, recordIds: ['rec8'] }));
  await call({ action: 'apply', ...sel, recordIds: ['rec8'], operationId: dry.body.operationId, planFingerprint: dry.body.planFingerprint });
  const before = { ...store.customers.find((c) => c.id === 'rec8').fields };
  const offersBefore = JSON.parse(JSON.stringify(store.offers));

  const rdry = parse(await call({ action: 'revokeDryRun', tiers: ['light', 'premium'], recordIds: ['rec8'] }));
  assert.equal(rdry.body.sideEffects, 'none');
  assert.equal(rdry.body.willRevoke, 1);

  const out = parse(await call({
    action: 'revoke', tiers: ['light', 'premium'], recordIds: ['rec8'],
    planFingerprint: rdry.body.planFingerprint, reason: '誤付与',
  }));
  assert.equal(out.status, 200);
  assert.equal(out.body.revoked, 1);
  const after = store.customers.find((c) => c.id === 'rec8').fields;
  assert.equal(after[L.LIFETIME], false);
  // Premium は割引オファーだったので無料権利を持っていない（取り消し対象外）
  assert.ok(!after[P.LIFETIME] && !after[P.UNTIL]);
  for (const k of ['プラン', 'Status', '有効期限', 'PaidAt', 'PaymentConfirmed', 'LifetimeSanrenpuku']) {
    assert.deepEqual(after[k], before[k], `取り消しで ${k} が変わった`);
  }
  assert.deepEqual(store.offers, offersBefore, '取り消しで発行済みオファーが変わった');
});

test('取り消しも gate が閉じていれば 503（書き込みゼロ）', async () => {
  const rdry = parse(await call({ action: 'revokeDryRun', tiers: ['light'], recordIds: ['rec1'] }));
  assert.equal(rdry.status, 200);
  const out = parse(await call({
    action: 'revoke', tiers: ['light'], recordIds: ['rec1'], planFingerprint: rdry.body.planFingerprint,
  }));
  assert.equal(out.status, 503);
  assert.equal(store.writes.length, 0);
});

// ═══ メール ══════════════════════════════════════════════════════════

test('どの action でもメールを 1 通も送らない', async () => {
  enableWrites();
  const sel = { lightOfferId: 'light-lifetime-free', premiumOfferId: 'premium-annual-half' };
  const dry = parse(await call({ action: 'dryRun', ...sel, recordIds: ['rec1'] }));
  await call({ action: 'apply', ...sel, recordIds: ['rec1'], operationId: dry.body.operationId, planFingerprint: dry.body.planFingerprint });
  await call({ action: 'preview', ...sel });
  await call({ action: 'customers' });
  await call({ action: 'offers' });
  assert.equal(store.mailCalls, 0);
  // 触ったテーブルは Customers と PromotionalOffers だけ
  assert.equal(store.writes.every((w) => ['Customers', 'PromotionalOffers'].includes(w.table)), true);
});
