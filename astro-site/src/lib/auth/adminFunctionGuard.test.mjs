/**
 * adminFunctionGuard.test.mjs — 管理者専用 Function が認証なしで動かないことを固定する
 *   node --test src/lib/auth/adminFunctionGuard.test.mjs
 *
 * 2026-11-05: 配信先メールを返す get-scheduled-jobs、全顧客の PlanType を消す reset-all-plantype などが
 * 認証なしで公開されていた。/.netlify/functions/* は Edge の対象外なので関数の入口で止める。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adminDenialResponse, adminDenialResult } from './adminFunctionGuard.js';

const read = (p) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');
const ENV = { ADMIN_BASIC_AUTH_USER: 'u', ADMIN_BASIC_AUTH_PASSWORD: 'p:w' };
const basic = (s) => `Basic ${Buffer.from(s).toString('base64')}`;
const req = (auth, method = 'GET') => new Request('https://x.test/f', { method, headers: auth ? { authorization: auth } : {} });

const GUARDED = {
  adminDenialResponse: ['get-scheduled-jobs', 'get-newsletter-history', 'get-newsletter-status', 'get-customer-stats', 'domain-protection'],
  adminDenialResult: ['reset-all-plantype', 'migrate-customers-plantype', 'fix-free-plantype', 'test-all-customers', 'test-env', 'test-expiry-warning', 'get-point-exchange-requests', 'update-betting-data', 'update-complete-data'],
};

test('Request 形式: 正しい認証だけ通す', async () => {
  assert.equal(adminDenialResponse(req(basic('u:p:w')), ENV), null);
  for (const r of [req(null), req(basic('u:x')), req('Basic'), req('Bearer t'), req(null, 'OPTIONS')]) {
    const d = adminDenialResponse(r, ENV);
    assert.equal(d.status, 401);
    assert.match(d.headers.get('www-authenticate'), /^Basic /);
    assert.doesNotMatch(await d.text(), /p:w/);
  }
});

test('event 形式: ヘッダ名の大小どちらでも判定し、誤りは 401', () => {
  assert.equal(adminDenialResult({ headers: { authorization: basic('u:p:w') } }, ENV), null);
  assert.equal(adminDenialResult({ headers: { Authorization: basic('u:p:w') } }, ENV), null);
  assert.equal(adminDenialResult({ headers: {} }, ENV).statusCode, 401);
  assert.equal(adminDenialResult({}, ENV).statusCode, 401);
  assert.equal(adminDenialResult({ httpMethod: 'OPTIONS', headers: {} }, ENV).statusCode, 401);
});

test('env が無ければ誰も通さない', () => {
  assert.equal(adminDenialResponse(req(basic('u:p:w')), {}).status, 401);
  assert.equal(adminDenialResult({ headers: { authorization: basic(':') } }, {}).statusCode, 401);
});

test('対象の関数は本体より先に認証を確認する', () => {
  for (const [guard, names] of Object.entries(GUARDED)) {
    for (const n of names) {
      const s = read(`netlify/functions/${n}.js`);
      const start = s.search(/(export default async function handler\(|exports\.handler = async \(|export async function handler\()/);
      assert.ok(start >= 0, n);
      const body = s.slice(start);
      const call = body.indexOf(`${guard}(`);
      assert.ok(call >= 0 && call < 120, `${n}: 入口で ${guard} を呼ぶ`);
      assert.ok(body.indexOf('if (denied) return denied;') > call, n);
    }
  }
});

test('顧客情報を出す管理画面は Edge の認証対象で、サイトマップに載らない', async () => {
  const toml = read('netlify.toml');
  assert.match(toml, /path = "\/admin-newsletter-simple"/);
  assert.match(toml, /path = "\/admin-newsletter-simple\/\*"/);
  assert.match(read('netlify/edge-functions/admin-auth.ts'), /'\/admin-newsletter-simple\/\*'/);
  const { isSitemapExcluded } = await import('../seo/sitemapPolicy.mjs');
  assert.equal(isSitemapExcluded('https://analytics.keiba.link/admin-newsletter-simple/'), true);
  assert.equal(isSitemapExcluded('https://analytics.keiba.link/checkout/paddle/'), true);
  assert.equal(isSitemapExcluded('https://analytics.keiba.link/withdrawal-complete/'), true);
});
