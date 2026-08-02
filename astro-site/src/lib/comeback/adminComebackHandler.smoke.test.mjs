/**
 * adminComebackHandler.smoke.test.mjs — admin-comeback-grants を**実際に呼ぶ**煙試験。
 *
 * ソース検査だけでは import 漏れや検証順の誤りを拾えない（2026-08-02 に
 * admin-marketing で実際に本番 500 を出した）。ここでは fetch を差し替えて
 * ネットワークなしで起動し、**複数選択の配列契約**が守られているかを見る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SECRET = 'test-admin-secret';

function stubFetch() {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET' });
    if (/api\.sendgrid\.com/.test(String(url))) throw new Error('admin must not call SendGrid');
    return { ok: true, status: 200, json: async () => ({ records: [] }) };
  };
  return calls;
}

async function invoke(payload) {
  process.env.PREMIUM_PLUS_ADMIN_SECRET = SECRET;
  process.env.AIRTABLE_API_KEY = 'test-key';
  process.env.AIRTABLE_BASE_ID = 'appTEST';
  const mod = await import('../../../netlify/functions/admin-comeback-grants.js');
  const res = await mod.handler({
    httpMethod: 'POST',
    headers: { 'x-admin-secret': SECRET },
    body: JSON.stringify(payload),
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body || '{}') };
}

test('smoke(cb): customers は配列の条件を受け付ける', async () => {
  stubFetch();
  const { statusCode, body } = await invoke({
    action: 'customers',
    contract: ['expired', 'withdrawn', 'dormant'],
    plan: ['premium', 'light'],
  });
  assert.equal(statusCode, 200, JSON.stringify(body).slice(0, 160));
  assert.equal(Array.isArray(body.rows), true);
});

test('smoke(cb): 許可値以外は 400。検証前に Airtable を読まない', async () => {
  const calls = stubFetch();
  const { statusCode, body } = await invoke({ action: 'customers', contract: ['expired', 'DROP TABLE'] });
  assert.equal(statusCode, 400);
  assert.match(String(body.error || ''), /contract/);
  assert.equal(calls.length, 0, '不正な条件で顧客データを読んでいる');
});

test('smoke(cb): 旧形式（単一文字列）でも動く', async () => {
  stubFetch();
  const { statusCode } = await invoke({ action: 'customers', contract: 'expired' });
  assert.equal(statusCode, 200);
});

test('smoke(cb): 条件なし（空配列）でも 200', async () => {
  stubFetch();
  const { statusCode } = await invoke({ action: 'customers', contract: [], plan: [] });
  assert.equal(statusCode, 200);
});
