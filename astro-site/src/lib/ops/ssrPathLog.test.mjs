/**
 * ssrPathLog.test.mjs — SSR 起動パスの記録が、個人情報・クエリを残さず 1 行に収まることを固定する
 * 正本: docs/SAFETY_CHECKS.md ルール 9
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeSsrRequest, normalizeSsrPath, classifyAgent, SSR_PATH_LOG_TAG } from './ssrPathLog.js';

const req = (url, headers = {}) => new Request(url, { headers });

test('クエリの値・Cookie・UA 本文は 1 文字も残さない', () => {
  const line = describeSsrRequest(
    req('https://analytics.keiba.link/free-prediction/view/?key=secret-key-123&email=a%40b.jp', {
      cookie: 'ak_session=TOPSECRET',
      'user-agent': 'Mozilla/5.0 (iPhone) UniqueAgentString',
    }),
    200,
  );
  assert.equal(line, `${SSR_PATH_LOG_TAG} GET 200 ua - q /free-prediction/view/`);
  for (const leak of ['secret-key', 'a%40b', 'TOPSECRET', 'UniqueAgentString', 'iPhone']) {
    assert.ok(!line.includes(leak), leak);
  }
});

test('パス中のメール・長い ID・トークンは :id に置き換える', () => {
  assert.equal(normalizeSsrPath('/u/someone@example.com/'), '/u/:id/');
  assert.equal(normalizeSsrPath('/u/someone%40example.com/'), '/u/:id/');
  assert.equal(normalizeSsrPath('/x/0123456789abcdef0123/'), '/x/:id/');
  assert.equal(normalizeSsrPath('/t/AbC123dEf456GhI789/'), '/t/:id/');
  assert.equal(normalizeSsrPath('/archive/nankan/2026/10/'), '/archive/nankan/2026/10/');
  assert.equal(normalizeSsrPath('/free-prediction/jra/'), '/free-prediction/jra/');
  assert.ok(normalizeSsrPath(`/${'a/'.repeat(200)}`).length <= 121);
});

test('ボット・UA なし・先読みを区別する', () => {
  assert.equal(classifyAgent('Mozilla/5.0 (compatible; Googlebot/2.1)'), 'bot');
  assert.equal(classifyAgent('python-requests/2.31'), 'bot');
  assert.equal(classifyAgent(''), 'noua');
  assert.equal(classifyAgent('Mozilla/5.0 (Macintosh) Safari/605'), 'ua');
  const pf = describeSsrRequest(req('https://analytics.keiba.link/free/', { 'sec-purpose': 'prefetch', 'user-agent': 'Mozilla/5.0' }), 200);
  assert.equal(pf, `${SSR_PATH_LOG_TAG} GET 200 ua pf - /free/`);
});

test('middleware は応答をそのまま返し、記録の失敗で応答を変えない', async () => {
  const src = readFileSync(new URL('../../middleware.js', import.meta.url), 'utf8');
  assert.match(src, /isPrerendered/);
  assert.match(src, /try\s*\{\s*console\.log\(describeSsrRequest/);
  assert.match(src, /return response;/);
  // Redis 等の外部書込を 1 起動ごとに増やさない
  const lib = readFileSync(new URL('./ssrPathLog.js', import.meta.url), 'utf8');
  assert.doesNotMatch(lib.replace(/\/\*[\s\S]*?\*\//g, ''), /\bfetch\(|UPSTASH|HINCRBY/);
});
