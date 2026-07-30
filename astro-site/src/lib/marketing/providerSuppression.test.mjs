/**
 * providerSuppression.test.mjs — SendGrid suppression 読み取りの検証（ネットワーク不使用）
 *   node --test src/lib/marketing/providerSuppression.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  fetchProviderSuppression,
  describeProviderSuppression,
  clearProviderSuppressionCache,
  SUPPRESSION_LISTS,
  PAGE_SIZE,
  CACHE_TTL_MS,
} from './providerSuppression.js';

const KEY = 'fake-key';
const NOW = 1_800_000_000_000;

/** パスごとに返すレコードを決める fake fetch */
function makeFetch(byPath, { failOn = null, throwOn = null } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, auth: init?.headers?.Authorization });
    const hit = Object.keys(byPath).find((p) => u.includes(p));
    if (throwOn && u.includes(throwOn)) throw new Error('network down');
    if (failOn && u.includes(failOn)) return { ok: false, status: 500, json: async () => ({}) };
    const all = hit ? byPath[hit] : [];
    const offset = Number(new URL(u).searchParams.get('offset') || 0);
    return { ok: true, status: 200, json: async () => all.slice(offset, offset + PAGE_SIZE) };
  };
  impl.calls = calls;
  return impl;
}

beforeEach(() => clearProviderSuppressionCache());

test('全 suppression リストを取得して 1 つの Set にまとめる', async () => {
  const f = makeFetch({
    '/bounces': [{ email: 'a@example.com' }, { email: 'b@example.com' }],
    '/blocks': [{ email: 'c@example.com' }],
    '/spam_reports': [{ email: 'd@example.com' }],
    '/invalid_emails': [{ email: 'e@example.com' }],
    '/unsubscribes': [{ email: 'f@example.com' }],
  });
  const r = await fetchProviderSuppression({ apiKey: KEY, fetchImpl: f, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.total, 6);
  assert.equal(r.emails.has('a@example.com'), true);
  assert.equal(r.emails.has('f@example.com'), true);
  assert.equal(Object.keys(r.counts).length, SUPPRESSION_LISTS.length);
});

test('email は正規化して格納する（大小・空白の差で照合漏れしない）', async () => {
  const f = makeFetch({ '/bounces': [{ email: '  A@Example.COM ' }] });
  const r = await fetchProviderSuppression({ apiKey: KEY, fetchImpl: f, now: NOW });
  assert.equal(r.emails.has('a@example.com'), true);
});

test('GET のみを使い、Authorization は付けるが値は戻り値に載せない', async () => {
  const f = makeFetch({ '/bounces': [] });
  const r = await fetchProviderSuppression({ apiKey: KEY, fetchImpl: f, now: NOW });
  for (const c of f.calls) {
    assert.ok(c.auth.startsWith('Bearer '), '認証ヘッダが無い');
  }
  assert.equal(JSON.stringify(r.counts).includes(KEY), false);
  assert.equal(JSON.stringify(describeProviderSuppression(r)).includes(KEY), false);
});

test('【fail closed】1 つでも取得に失敗したら ok:false・Set は空', async () => {
  for (const opts of [{ failOn: '/blocks' }, { throwOn: '/spam_reports' }]) {
    clearProviderSuppressionCache();
    const f = makeFetch({ '/bounces': [{ email: 'a@example.com' }] }, opts);
    const r = await fetchProviderSuppression({ apiKey: KEY, fetchImpl: f, now: NOW });
    assert.equal(r.ok, false, '一部失敗なのに成功扱いしている');
    assert.equal(r.emails.size, 0, '部分的な結果を返している');
    assert.ok(r.error);
  }
});

test('API キーが無ければ取得しない（fail closed）', async () => {
  const r = await fetchProviderSuppression({ apiKey: '', fetchImpl: makeFetch({}), now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'missing_api_key');
});

test('ページングする（PAGE_SIZE ちょうどなら次ページを取りに行く）', async () => {
  const many = Array.from({ length: PAGE_SIZE + 3 }, (_, i) => ({ email: `u${i}@example.com` }));
  const f = makeFetch({ '/bounces': many });
  const r = await fetchProviderSuppression({ apiKey: KEY, fetchImpl: f, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.counts.bounces, PAGE_SIZE + 3);
  assert.ok(f.calls.filter((c) => c.url.includes('/bounces')).length >= 2, 'ページングしていない');
});

test('キャッシュが効き、TTL 経過後は取り直す', async () => {
  const f = makeFetch({ '/bounces': [{ email: 'a@example.com' }] });
  const first = await fetchProviderSuppression({ apiKey: KEY, fetchImpl: f, now: NOW });
  const n1 = f.calls.length;
  const second = await fetchProviderSuppression({ apiKey: KEY, fetchImpl: f, now: NOW + 1000 });
  assert.equal(f.calls.length, n1, 'キャッシュが効いていない');
  assert.equal(second.cached, true);
  assert.equal(second.total, first.total);

  await fetchProviderSuppression({ apiKey: KEY, fetchImpl: f, now: NOW + CACHE_TTL_MS + 1 });
  assert.ok(f.calls.length > n1, 'TTL 経過後に取り直していない');
});

test('失敗結果はキャッシュしない（次回すぐ再試行できる）', async () => {
  const bad = makeFetch({ '/bounces': [] }, { failOn: '/bounces' });
  const r1 = await fetchProviderSuppression({ apiKey: KEY, fetchImpl: bad, now: NOW });
  assert.equal(r1.ok, false);
  const good = makeFetch({ '/bounces': [{ email: 'a@example.com' }] });
  const r2 = await fetchProviderSuppression({ apiKey: KEY, fetchImpl: good, now: NOW });
  assert.equal(r2.ok, true, '失敗をキャッシュして復旧できなくなっている');
});

test('describeProviderSuppression は PII を含まない要約を返す', () => {
  const r = { ok: true, total: 3, counts: { bounces: 3 }, emails: new Set(['a@example.com']), cached: false };
  const d = describeProviderSuppression(r);
  assert.deepEqual(d, { available: true, error: null, total: 3, counts: { bounces: 3 }, cached: false });
  assert.equal(JSON.stringify(d).includes('@'), false);
  assert.deepEqual(describeProviderSuppression(null), { available: false, error: 'unknown', total: 0, counts: {} });
});

// ── ソース guard ──────────────────────────────────────────────
const src = readFileSync(fileURLToPath(new URL('./providerSuppression.js', import.meta.url)), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('provider へ書き込まない（GET のみ）', () => {
  assert.equal(/method:\s*'(POST|PATCH|DELETE|PUT)'/.test(code), false, 'provider へ write している');
  assert.ok(code.includes("method: 'GET'"));
  assert.equal(code.includes('/mail/send'), false, '送信 API を持っている');
});

test('鍵やレスポンス本文をログへ出さない', () => {
  assert.equal(/console\./.test(code), false, 'ログ出力を持っている（鍵・アドレス漏洩の経路になる）');
});
