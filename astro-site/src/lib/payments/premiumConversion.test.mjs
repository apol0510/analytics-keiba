/**
 * premiumConversion.test.mjs — Light → Premium 転換履歴（2026-09-28 MK 確定）を固定する
 *
 * | ケース | 期待 |
 * |---|---|
 * | 既存 Light 会員（有効中）→ Premium 入金確認 | `PremiumConvertedFrom=Light/Monthly`・`PremiumConvertedAt=確定日時` |
 * | 期限切れの Light → Premium | `Light/Monthly（期限切れ）` |
 * | 同じ確定の再実行（Requested* はクリア済み）| 何も書かない・既存値を変えない |
 * | 既に転換履歴がある（再購入・再昇格）| 上書きしない（最初の転換だけ）|
 * | Premium の更新・Free→Premium・Light→三連複 | 書かない |
 * | 履歴の PATCH が失敗 | 昇格は巻き戻さない（プラン Premium のまま・200）|
 * | 顧客レコードの他の項目 | 変えない（履歴の PATCH は 2 項目だけ）|
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  buildPremiumConversionFields, assertOnlyConversionFields,
  PREMIUM_CONVERTED_FROM_FIELD as FROM, PREMIUM_CONVERTED_AT_FIELD as AT,
} from './premiumConversion.js';

const T = new Date('2026-10-01T03:00:00.000Z');
const LIGHT = { 'プラン': 'Light', 'PlanType': 'Monthly', 'Status': 'active', '有効期限': '2026-10-20' };
const toPremium = { 'プラン': 'Premium', 'PlanType': 'Annual' };

// ── 純粋関数 ──────────────────────────────────────────────
test('既存 Light 会員 → Premium: 元プランと転換日時を残す', () => {
  assert.deepEqual(buildPremiumConversionFields({ previousFields: LIGHT, confirmationFields: toPremium, confirmedAt: T }),
    { [FROM]: 'Light/Monthly', [AT]: T.toISOString() });
});

test('期限切れの Light → Premium は（期限切れ）を付ける・旧 Standard も Light 扱い', () => {
  const r = buildPremiumConversionFields({ previousFields: { ...LIGHT, '有効期限': '2026-09-10' }, confirmationFields: toPremium, confirmedAt: T });
  assert.equal(r[FROM], 'Light/Monthly（期限切れ）');
  const s = buildPremiumConversionFields({ previousFields: { ...LIGHT, 'プラン': 'Standard' }, confirmationFields: toPremium, confirmedAt: T });
  assert.equal(s[FROM], 'Light/Monthly');
});

test('書かないケース: 既に履歴あり・Premium 更新・Free→Premium・Light→三連複・Light 更新・日時不正', () => {
  const none = (prev, next = toPremium, at = T) => buildPremiumConversionFields({ previousFields: prev, confirmationFields: next, confirmedAt: at });
  assert.equal(none({ ...LIGHT, [AT]: '2026-09-01T00:00:00.000Z' }), null, '最初の転換だけ残す');
  assert.equal(none({ 'プラン': 'Premium', 'PlanType': 'Annual' }), null);
  assert.equal(none({ 'プラン': 'Free' }), null);
  assert.equal(none({}), null);
  assert.equal(none(LIGHT, { 'プラン': 'Premium Sanrenpuku' }), null);
  assert.equal(none(LIGHT, { 'LifetimeSanrenpuku': true }), null);
  assert.equal(none(LIGHT, { 'プラン': 'Light', 'PlanType': 'Monthly' }), null);
  assert.equal(none(LIGHT, toPremium, new Date('x')), null);
});

test('別 PATCH に載せてよいのは転換履歴の 2 項目だけ', () => {
  assert.equal(assertOnlyConversionFields({ [FROM]: 'Light/Monthly', [AT]: T.toISOString() }), true);
  assert.equal(assertOnlyConversionFields({ [FROM]: 'x', 'プラン': 'Premium' }), false);
  assert.equal(assertOnlyConversionFields({}), false);
});

// ── 実ハンドラ（confirm-bank-payment）で固定 ─────────────────
const CONFIRM_FN = fileURLToPath(new URL('../../../netlify/functions/confirm-bank-payment.js', import.meta.url));
const REC = 'recSYNTHCONV0001';
let customers; let patches; let failConversionPatch; let realFetch; let realEnv;

const MEMBER = {
  'Email': 'synthetic-conv@example.invalid', '氏名': 'テスト', 'Source': 'nankan-analytics',
  ...LIGHT,
  'PaymentConfirmed': true, 'RequestedPlan': 'Premium', 'RequestedPlanType': 'Annual', 'RequestedAmount': 44820,
};

function stub() {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const m = (init.method || 'GET').toUpperCase();
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('sendgrid')) return json({}, 202);
    if (u.includes('api.airtable.com') && u.includes('/Customers')) {
      if (m === 'GET') return u.includes(REC) ? json({ id: REC, fields: customers }) : json({ records: [{ id: REC, fields: customers }] });
      if (m === 'PATCH') {
        const f = JSON.parse(init.body || '{}').fields || {};
        patches.push(Object.keys(f));
        if (failConversionPatch && FROM in f) return new Response('{"error":"UNKNOWN_FIELD_NAME"}', { status: 422 });
        Object.assign(customers, f);
        return json({ id: REC, fields: customers });
      }
    }
    if (u.includes('api.airtable.com')) return m === 'GET' ? json({ records: [] }) : json({ records: [] });
    return json({ result: null });
  };
}

async function confirm() {
  const saved = { log: console.log, warn: console.warn, info: console.info };
  console.log = console.warn = console.info = (...a) => console.error(...a);
  try {
    globalThis.exports = {}; globalThis.module = { exports: globalThis.exports };
    await import(`${CONFIRM_FN}?t=${Math.random()}`);
    const res = await globalThis.exports.handler({
      httpMethod: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ airtableRecordId: REC }),
    }, {});
    return res.statusCode;
  } finally { Object.assign(console, saved); }
}

beforeEach(() => {
  customers = { ...MEMBER }; patches = []; failConversionPatch = false;
  realFetch = globalThis.fetch; realEnv = { ...process.env };
  process.env.AIRTABLE_API_KEY = 'stub'; process.env.AIRTABLE_BASE_ID = 'stub'; process.env.SENDGRID_API_KEY = 'stub';
  delete process.env.PAYMENT_CONFIRM_SECRET;
  stub();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in realEnv)) delete process.env[k];
  Object.assign(process.env, realEnv);
});

test('実ハンドラ: Light → Premium 入金確認で転換履歴が残り、他の項目は変えない', async () => {
  const before = { ...customers };
  assert.equal(await confirm(), 200);
  assert.equal(customers['プラン'], 'Premium');
  assert.equal(customers[FROM], 'Light/Monthly');
  assert.ok(!Number.isNaN(Date.parse(customers[AT])));
  const conv = patches.find((k) => k.includes(FROM));
  assert.deepEqual(conv.sort(), [AT, FROM].sort(), '履歴の PATCH は 2 項目だけ');
  for (const k of ['Email', '氏名', 'Source']) assert.equal(customers[k], before[k], `${k} が変わった`);
});

test('実ハンドラ: 再実行しても転換日時は変わらない（冪等）', async () => {
  await confirm();
  const first = customers[AT];
  assert.equal(await confirm(), 200); // Requested* はクリア済み → 昇格スキップ
  assert.equal(customers[AT], first);
  assert.equal(patches.filter((k) => k.includes(FROM)).length, 1);
});

test('実ハンドラ: 履歴の書き込みが失敗しても昇格は巻き戻さない', async () => {
  failConversionPatch = true;
  assert.equal(await confirm(), 200);
  assert.equal(customers['プラン'], 'Premium');
  assert.equal(customers[FROM], undefined);
});

test('実ハンドラ: Premium 会員の更新では書かない', async () => {
  customers = { ...MEMBER, 'プラン': 'Premium', 'PlanType': 'Annual' };
  assert.equal(await confirm(), 200);
  assert.equal(patches.some((k) => k.includes(FROM)), false);
});
