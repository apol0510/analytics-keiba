/**
 * paymentEmailDeps.canary.test.mjs — カナリア専用 deps の分離を固定する。
 *
 * 検証意図（本番 Customers / 本番キーへの混入を構造的に防ぐ）:
 * - 認証キーは **PAYMENT_EMAIL_CANARY_AIRTABLE_API_KEY のみ**。本番 AIRTABLE_API_KEY へ fallback しない。
 * - 専用キー未設定なら makeCanaryWorkerDeps() は throw（fail closed）。
 * - Base/Table も専用 env のみ。未設定なら throw。
 * - 実接続 URL はカナリア専用 Base/Table を指し、Authorization は専用キー由来。本番 Base を指さない。
 * - 例外メッセージに key / Base ID / Table ID の値を載せない（ログ経由の漏洩防止）。
 * - 本番 worker deps は既存の本番 AIRTABLE_API_KEY + Customers を使う（分離の影響を受けない）。
 *
 * 実 Airtable/SendGrid には接続しない（fetch を stub し URL / Authorization のみ検査）。
 * env の値はすべてこのテスト内のダミー（本番・確定テストレコードの実 ID・実キーは使わない）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCanaryWorkerDeps, makeWorkerDeps } from './paymentEmailDeps.js';

const ALL_ENV = [
  'PAYMENT_EMAIL_CANARY_AIRTABLE_API_KEY',
  'PAYMENT_EMAIL_CANARY_AIRTABLE_BASE_ID',
  'PAYMENT_EMAIL_CANARY_AIRTABLE_TABLE_ID',
  'AIRTABLE_API_KEY',
  'AIRTABLE_BASE_ID',
];

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
/** fetch を stub し、呼ばれた {url, auth} を記録する。 */
function stubFetch(seen) {
  return async (url, opts) => {
    seen.push({ url: String(url), auth: (opts && opts.headers && opts.headers.Authorization) || '' });
    return { ok: true, json: async () => ({ id: 'recX', fields: {} }) };
  };
}

test('canary deps: 専用キー未設定（本番 AIRTABLE_API_KEY はある）→ throw（fail closed・本番キーへ fallback しない）', () => {
  const saved = snapshot(ALL_ENV);
  try {
    process.env.AIRTABLE_API_KEY = 'prod_key_dummy'; // 本番キーはあるが使ってはいけない
    process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_BASE_ID = 'appCANARYDUMMY00';
    process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_TABLE_ID = 'tblCANARYDUMMY00';
    delete process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_API_KEY;
    assert.throws(() => makeCanaryWorkerDeps(), /api key not configured/);
  } finally {
    restore(saved);
  }
});

test('canary deps: 専用キーあり + 本番キーなし → canary target 生成成功（本番キーに依存しない）', () => {
  const saved = snapshot(ALL_ENV);
  try {
    delete process.env.AIRTABLE_API_KEY; // 本番キーが無くてもカナリアは生成できる
    process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_API_KEY = 'canary_key_dummy';
    process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_BASE_ID = 'appCANARYDUMMY00';
    process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_TABLE_ID = 'tblCANARYDUMMY00';
    const deps = makeCanaryWorkerDeps();
    assert.equal(typeof deps.getRecord, 'function');
    assert.equal(typeof deps.patchRecord, 'function');
  } finally {
    restore(saved);
  }
});

test('canary deps: Base/Table 未設定なら throw（両方必須・専用キーはある）', () => {
  const saved = snapshot(ALL_ENV);
  try {
    process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_API_KEY = 'canary_key_dummy';
    process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_BASE_ID = 'appCANARYDUMMY00';
    delete process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_TABLE_ID;
    assert.throws(() => makeCanaryWorkerDeps(), /target not configured/);
  } finally {
    restore(saved);
  }
});

test('canary deps: 例外メッセージに key / Base / Table の値を載せない', () => {
  const saved = snapshot(ALL_ENV);
  try {
    // 専用キー未設定のパス
    process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_BASE_ID = 'appSECRETBASE999';
    process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_TABLE_ID = 'tblSECRETTBL999';
    delete process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_API_KEY;
    let msg = '';
    try { makeCanaryWorkerDeps(); } catch (e) { msg = String(e && e.message); }
    assert.ok(!msg.includes('appSECRETBASE999') && !msg.includes('tblSECRETTBL999'), 'Base/Table が例外メッセージに漏れている');
    // Base/Table 未設定のパス
    process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_API_KEY = 'canarySECRETKEY9';
    delete process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_BASE_ID;
    let msg2 = '';
    try { makeCanaryWorkerDeps(); } catch (e) { msg2 = String(e && e.message); }
    assert.ok(!msg2.includes('canarySECRETKEY9'), 'key が例外メッセージに漏れている');
  } finally {
    restore(saved);
  }
});

test('canary deps: 実接続 URL はカナリア専用 Base/Table、Authorization は専用キー由来（本番 Base/キーを使わない）', async () => {
  const saved = snapshot(ALL_ENV);
  const originalFetch = global.fetch;
  const seen = [];
  try {
    process.env.AIRTABLE_API_KEY = 'prod_key_dummy'; // 本番キー（使ってはいけない）
    process.env.AIRTABLE_BASE_ID = 'appPRODDUMMY0000'; // 本番 Base（触れてはいけない）
    process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_API_KEY = 'canary_key_dummy';
    process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_BASE_ID = 'appCANARYDUMMY00';
    process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_TABLE_ID = 'tblCANARYDUMMY00';

    global.fetch = stubFetch(seen);
    const deps = makeCanaryWorkerDeps();
    await deps.getRecord('recX');
    await deps.patchRecord('recX', { PaymentEmailStatus: 'pending' });

    assert.ok(seen.length >= 2, 'fetch が呼ばれていない');
    for (const { url, auth } of seen) {
      assert.ok(url.includes('appCANARYDUMMY00'), `カナリア Base を指していない: ${url}`);
      assert.ok(url.includes('tblCANARYDUMMY00'), `カナリア Table を指していない: ${url}`);
      assert.ok(!url.includes('appPRODDUMMY0000'), `本番 Base に接続している（混入）: ${url}`);
      assert.ok(!url.includes('/Customers'), `本番 Customers テーブル名に接続している: ${url}`);
      assert.equal(auth, 'Bearer canary_key_dummy', `Authorization が専用キー由来でない: ${auth}`);
      assert.ok(!auth.includes('prod_key_dummy'), '本番キーで認証している（混入）');
    }
  } finally {
    global.fetch = originalFetch;
    restore(saved);
  }
});

test('production worker deps: 本番 AIRTABLE_API_KEY + Customers を使う（カナリア分離の影響を受けない）', async () => {
  const saved = snapshot(ALL_ENV);
  const originalFetch = global.fetch;
  const seen = [];
  try {
    process.env.AIRTABLE_API_KEY = 'prod_key_dummy';
    process.env.AIRTABLE_BASE_ID = 'appPRODDUMMY0000';
    // カナリア専用キーを設定しても本番経路には影響しないこと
    process.env.PAYMENT_EMAIL_CANARY_AIRTABLE_API_KEY = 'canary_key_dummy';

    global.fetch = stubFetch(seen);
    const deps = makeWorkerDeps();
    await deps.getRecord('recProd');

    assert.ok(seen.length >= 1, 'fetch が呼ばれていない');
    const { url, auth } = seen[0];
    assert.ok(url.includes('appPRODDUMMY0000'), '本番 Base を指していない');
    assert.ok(url.includes('/Customers'), '本番 Customers テーブルを指していない');
    assert.equal(auth, 'Bearer prod_key_dummy', '本番 worker が本番キーを使っていない');
    assert.ok(!auth.includes('canary_key_dummy'), '本番 worker がカナリアキーで認証している（混入）');
  } finally {
    global.fetch = originalFetch;
    restore(saved);
  }
});
