/**
 * ssrPathLog.test.mjs — SSR 起動の記録が、実際のパス・クエリ・識別子を残さず 1 行に収まることを固定する
 * 正本: docs/SAFETY_CHECKS.md ルール 9
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  describeSsrRequest, routeLabel, unmatchedPathBucket, classifyAgent, SSR_PATH_LOG_TAG,
} from './ssrPathLog.js';

const req = (url, headers = {}) => new Request(url, { headers });

test('ルートに当たった起動はパターンだけを残し、実際の値・クエリ・Cookie・UA 本文を残さない', () => {
  const line = describeSsrRequest(
    req('https://analytics.keiba.link/prediction/abc123/?key=secret-key-123&email=a%40b.jp', {
      cookie: 'ak_session=TOPSECRET',
      'user-agent': 'Mozilla/5.0 (iPhone) UniqueAgentString',
    }),
    200,
    '/prediction/[slug]',
  );
  assert.equal(line, `${SSR_PATH_LOG_TAG} GET 200 ua - q /prediction/[slug]`);
  for (const leak of ['abc123', 'secret-key', 'a%40b', 'TOPSECRET', 'UniqueAgentString', 'iPhone']) {
    assert.ok(!line.includes(leak), leak);
  }
});

test('どのルートにも当たらない 404: 短い識別子・トークン・数字・メールは伏せ、2 段目以降は残さない', () => {
  for (const p of ['/Ab3xK9/', '/abc123/', '/k9Zq/', '/2026/', '/aBcDeF/', '/someone@example.com/', '/a%40b.jp/', `/${'x'.repeat(30)}/`]) {
    assert.equal(unmatchedPathBucket(p).startsWith('404:/:seg'), true, p);
  }
  assert.equal(unmatchedPathBucket('/t/k9Zq/'), '404:/t/*');
  assert.equal(unmatchedPathBucket('/u/someone@example.com/'), '404:/u/*');
  assert.equal(unmatchedPathBucket('/'), '404:/');
  // ありふれた探索名は判別のため残す（_redirects で静的 404 にする判断に使う）
  assert.equal(unmatchedPathBucket('/wp-login.php'), '404:/wp-login.php');
  assert.equal(unmatchedPathBucket('/.env'), '404:/.env');
  assert.equal(unmatchedPathBucket('/wp-admin/setup.php'), '404:/wp-admin/*');
  for (const r of ['/404', '', undefined, '/_not-found']) {
    assert.equal(routeLabel(r, '/Ab3xK9/'), '404:/:seg');
  }
});

test('想定外の文字を含むパターンは伏せる', () => {
  assert.equal(routeLabel('/archive/nankan/[year]/[month]', '/archive/nankan/2026/10/'), '/archive/nankan/[year]/[month]');
  assert.equal(routeLabel('/x/a@b', '/x/a@b'), ':route');
  assert.equal(routeLabel('/x?y=1', '/x'), ':route');
});

test('ボット・UA なし・先読みを区別する', () => {
  assert.equal(classifyAgent('Mozilla/5.0 (compatible; Googlebot/2.1)'), 'bot');
  assert.equal(classifyAgent('python-requests/2.31'), 'bot');
  assert.equal(classifyAgent(''), 'noua');
  assert.equal(classifyAgent('Mozilla/5.0 (Macintosh) Safari/605'), 'ua');
  const pf = describeSsrRequest(req('https://analytics.keiba.link/free/', { 'sec-purpose': 'prefetch', 'user-agent': 'Mozilla/5.0' }), 200, '/free');
  assert.equal(pf, `${SSR_PATH_LOG_TAG} GET 200 ua pf - /free`);
});

test('middleware は応答をそのまま返し、ルートパターンを渡し、記録の失敗で応答を変えない', () => {
  const src = readFileSync(new URL('../../middleware.js', import.meta.url), 'utf8');
  assert.match(src, /isPrerendered/);
  assert.match(src, /try\s*\{\s*console\.log\(describeSsrRequest\(context\.request, response\.status, context\.routePattern\)/);
  assert.match(src, /return response;/);
  // Redis 等の外部書込を 1 起動ごとに増やさない
  const lib = readFileSync(new URL('./ssrPathLog.js', import.meta.url), 'utf8');
  assert.doesNotMatch(lib.replace(/\/\*[\s\S]*?\*\//g, ''), /\bfetch\(|UPSTASH|HINCRBY/);
});
