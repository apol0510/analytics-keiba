/**
 * paymentEmailDeps.canary.test.mjs — カナリア専用 deps の分離を固定する。
 *
 * 検証意図（本番 Customers への混入を構造的に防ぐ）:
 * - カナリア env 未設定なら makeCanaryWorkerDeps() は throw（fail closed）
 * - 本番 AIRTABLE_BASE_ID が設定されていても、カナリア env が無ければ **fallback しない**
 * - 実接続 URL は必ずカナリア専用 Base/Table を指し、本番 Base を指さない
 * - 例外メッセージに Base ID / Table ID の値を載せない（ログ経由の漏洩防止）
 *
 * 実 Airtable/SendGrid には接続しない（fetch を stub し URL のみ検査）。
 * env の値はすべてこのテスト内のダミー（本番・確定テストレコードの実 ID は使わない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCanaryWorkerDeps } from './paymentEmailDeps.js';

const CANARY_ENV = ['PAYMENT_EMAIL_CANARY_AIRTABLE_BASE_ID', 'PAYMENT_EMAIL_CANARY_AIRTABLE_TABLE_ID'];
const PROD_ENV = ['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID'];

function snapshot(keys) {
  const s = {};
  for (const k of keys) s[k] = process.env[k];
  return s;
}
function restore(s) {
  for (const k of Object.keys(s)) {
    if (s[k] === undefined) delete process.env[k];
    else process.env[k] = s[k];
  }
}

test('canary deps: カナリア Base/Table 未設定なら throw（fail closed・本番 fallback しない）', () => {
  const saved = snapshot([...CANARY_ENV, ...PROD_ENV]);
  try {
    // 本番 env は設定するが、カナリア env は未設定 → fallback せず必ず throw する
    process.env.AIRTABLE_API_KEY = 'key_dummy';
    process.env.AIRTABLE_BASE_ID = 'appPRODDUMMY0000';
    delete process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_BASE_ID;
    delete process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_TABLE_ID;
    assert.throws(() => makeCanaryWorkerDeps(), /not configured/);
  } finally {
    restore(saved);
  }
});

test('canary deps: Base だけ設定・Table 未設定でも throw（両方必須）', () => {
  const saved = snapshot([...CANARY_ENV, ...PROD_ENV]);
  try {
    process.env.AIRTABLE_API_KEY = 'key_dummy';
    process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_BASE_ID = 'appCANARYDUMMY00';
    delete process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_TABLE_ID;
    assert.throws(() => makeCanaryWorkerDeps());
  } finally {
    restore(saved);
  }
});

test('canary deps: 例外メッセージに Base/Table の値を載せない', () => {
  const saved = snapshot([...CANARY_ENV, ...PROD_ENV]);
  try {
    process.env.AIRTABLE_API_KEY = 'key_dummy';
    process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_BASE_ID = 'appSECRETBASE999';
    delete process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_TABLE_ID;
    let msg = '';
    try { makeCanaryWorkerDeps(); } catch (e) { msg = String(e && e.message); }
    assert.ok(!msg.includes('appSECRETBASE999'), 'Base ID が例外メッセージに漏れている');
  } finally {
    restore(saved);
  }
});

test('canary deps: 実接続 URL はカナリア専用 Base/Table を指し、本番 Base を指さない', async () => {
  const saved = snapshot([...CANARY_ENV, ...PROD_ENV]);
  const originalFetch = global.fetch;
  const seen = [];
  try {
    process.env.AIRTABLE_API_KEY = 'key_dummy';
    process.env.AIRTABLE_BASE_ID = 'appPRODDUMMY0000'; // 本番（触れてはいけない）
    process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_BASE_ID = 'appCANARYDUMMY00';
    process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_TABLE_ID = 'tblCANARYDUMMY00';

    global.fetch = async (url) => {
      seen.push(String(url));
      return { ok: true, json: async () => ({ id: 'recX', fields: {} }) };
    };

    const deps = makeCanaryWorkerDeps();
    await deps.getRecord('recX');
    await deps.patchRecord('recX', { PaymentEmailStatus: 'pending' });

    assert.ok(seen.length >= 2, 'fetch が呼ばれていない');
    for (const u of seen) {
      assert.ok(u.includes('appCANARYDUMMY00'), `カナリア Base を指していない: ${u}`);
      assert.ok(u.includes('tblCANARYDUMMY00'), `カナリア Table を指していない: ${u}`);
      assert.ok(!u.includes('appPRODDUMMY0000'), `本番 Base に接続している（混入）: ${u}`);
      assert.ok(!u.includes('/Customers'), `本番 Customers テーブル名に接続している: ${u}`);
    }
  } finally {
    global.fetch = originalFetch;
    restore(saved);
  }
});
