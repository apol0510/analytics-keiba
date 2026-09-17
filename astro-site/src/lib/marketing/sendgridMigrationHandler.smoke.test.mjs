/**
 * sendgridMigrationHandler.smoke.test.mjs — 管理 API を**実際に起動する**煙試験
 *
 * ソース文字列の guard は import 漏れ・引数不一致を見つけられない（本番 500 の前例あり）。
 * `fetch` を差し替えてネットワーク無しで `handler()` を呼び、
 *   - 200 が返ること
 *   - 応答に**アドレスを載せない**こと
 *   - 書き込み系が**下見では 1 リクエストも出さない**こと
 *   - ゲートが閉じていれば **SendGrid へ 1 リクエストも出ない**こと
 * を固定する。
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../../../netlify/functions/admin-sendgrid-migration.js';
import { emailHash, ACTIVE_INDEX, prospectKey } from './prospectStore.js';
import { PROSPECT_STATE } from './prospectPolicy.js';
import { containsEmailLike } from './sendgridNextMessage.js';
import { WRITE_GATE_ENV } from './sendgridMarketingApi.js';

const SECRET = 'seed-admin-secret';
const REDIS_URL = 'https://fake-upstash.test';
const SEED_EMAIL = 'smoke@example.test';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
let sendgridCalls = [];

function stubFetch() {
  const hash = emailHash(SEED_EMAIL);
  const record = JSON.stringify({ email: SEED_EMAIL, state: PROSPECT_STATE.SENDING, delivered: 0 });
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target.startsWith(REDIS_URL)) {
      const args = JSON.parse((init && init.body) || '[]');
      const op = String(args[0] || '').toUpperCase();
      const result = (() => {
        if (op === 'SMEMBERS') return args[1] === ACTIVE_INDEX ? [hash] : [];
        if (op === 'MGET') return args.slice(1).map((k) => (k === prospectKey(hash) ? record : null));
        if (op === 'SMISMEMBER') return args.slice(2).map(() => 0);
        if (op === 'SCARD') return args[1] === ACTIVE_INDEX ? 1 : 0;
        if (op === 'GET') return null;
        return 0;
      })();
      return { ok: true, status: 200, json: async () => ({ result }) };
    }
    sendgridCalls.push(target);
    return { ok: true, status: 200, json: async () => ({}) };
  };
}

const call = (body, headers = { 'x-admin-secret': SECRET }) => handler({
  httpMethod: 'POST', headers, body: JSON.stringify(body),
});

beforeEach(() => {
  sendgridCalls = [];
  process.env.MARKETING_ADMIN_SECRET = SECRET;
  process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'seed-token';
  delete process.env[WRITE_GATE_ENV];
  delete process.env.MARKETING_PROSPECT_ENGINE;
  stubFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

test('secret が違えば 403', async () => {
  const res = await call({ action: 'scan' }, { 'x-admin-secret': 'wrong' });
  assert.equal(res.statusCode, 403);
});

test('scan は 200 で、アドレスを 1 つも返さない', async () => {
  const res = await call({ action: 'scan', limit: 10 });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.sideEffects, 'none');
  assert.equal(body.engine, 'ak', '既定は従来どおり AK');
  assert.equal(body.window.indexSize, 1);
  assert.equal(body.summary['移行対象'], 1);
  assert.equal(body.summary['次に送る番号別']['1'], 1);
  assert.equal(containsEmailLike(body), false, '応答にアドレスが混ざってはいけない');
  assert.equal(sendgridCalls.length, 0, 'scan は SendGrid を呼ばない');
});

test('content は 10 通の件名を返す（本文は既定で返さない）', async () => {
  const res = await call({ action: 'content' });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.summary['通数'], 10);
  assert.equal(body.messages, undefined);
  assert.equal(sendgridCalls.length, 0);
});

test('plan は通し番号別件数から Automation 計画を返す', async () => {
  const res = await call({ action: 'plan', countsByNextMessage: { 1: 10, 5: 3 } });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.totals['対象contact数'], 13);
  assert.equal(body.totals['作るAutomation数'], 2);
  assert.equal(containsEmailLike(body), false);
});

test('import は apply が無ければ下見で、SendGrid へ 1 リクエストも出さない', async () => {
  const res = await call({ action: 'import', limit: 10 });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.dryRun, true);
  assert.equal(body.sideEffects, 'none');
  assert.equal(body.gate, 'closed');
  assert.equal(body['投入予定'], 1);
  assert.equal(containsEmailLike(body), false);
  assert.equal(sendgridCalls.length, 0);
});

test('ゲートが閉じたまま apply しても 403 で、SendGrid を呼ばない', async () => {
  const res = await call({ action: 'import', apply: true, confirm: 'MIGRATE PROSPECTS TO SENDGRID' });
  assert.equal(res.statusCode, 403);
  assert.equal(JSON.parse(res.body).reason, 'write_gate_closed');
  assert.equal(sendgridCalls.length, 0);
});

test('ゲートが開いていても合言葉が違えば書かない', async () => {
  process.env[WRITE_GATE_ENV] = 'true';
  const res = await call({ action: 'import', apply: true, confirm: 'nope' });
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).reason, 'confirm_mismatch');
  assert.equal(sendgridCalls.length, 0);
});

test('AK がまだ prospect を送る設定なら import を拒否する（二重稼働の防止）', async () => {
  process.env[WRITE_GATE_ENV] = 'true';
  process.env.SENDGRID_API_KEY = 'seed-sendgrid-key';
  const res = await call({
    action: 'import',
    apply: true,
    confirm: 'MIGRATE PROSPECTS TO SENDGRID',
    automationLive: true,
  });
  assert.equal(res.statusCode, 409);
  assert.equal(JSON.parse(res.body).reason, 'both_engines_live');
  assert.equal(sendgridCalls.length, 0, '判定より先に SendGrid を呼ばない');
});

test('未知の action は 400', async () => {
  const res = await call({ action: 'nope' });
  assert.equal(res.statusCode, 400);
});
