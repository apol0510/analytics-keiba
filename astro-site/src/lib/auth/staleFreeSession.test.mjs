import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  planStaleFreeCheck, shouldLogoutStaleFree, AUTH_LOCALSTORAGE_KEYS, STALE_FREE_CHECK_INTERVAL_MS,
} from './staleFreeSession.js';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const free = JSON.stringify({ email: 'Someone@Example.com', plan: 'free', nonAuthoritative: true });

test('無料ログインの痕跡があるときだけ確かめる（12 時間に 1 回）', () => {
  assert.deepEqual(planStaleFreeCheck({ userPlanRaw: free, lastCheckAt: null, nowMs: NOW }), { check: true, email: 'someone@example.com' });
  assert.equal(planStaleFreeCheck({ userPlanRaw: free, lastCheckAt: String(NOW - 1000), nowMs: NOW }).check, false);
  assert.equal(planStaleFreeCheck({ userPlanRaw: free, lastCheckAt: String(NOW - STALE_FREE_CHECK_INTERVAL_MS - 1), nowMs: NOW }).check, true);
  // 有料・メールなし・壊れた値・未ログインは確かめない
  for (const raw of [JSON.stringify({ email: 'a@b.co', plan: 'Light' }), JSON.stringify({ plan: 'free' }), '{bad', null]) {
    assert.equal(planStaleFreeCheck({ userPlanRaw: raw, lastCheckAt: null, nowMs: NOW }).check, false, String(raw));
  }
});

test('サーバーが「有料（ログインし直しが要る）」と答えたときだけログアウトさせる', () => {
  assert.equal(shouldLogoutStaleFree({ requiresLogin: true }), true);
  assert.equal(shouldLogoutStaleFree({ requiresLogin: false }), false);
  assert.equal(shouldLogoutStaleFree(null), false);
});

test('消すキーはマイページのログアウトと同じ一覧', () => {
  const dash = readFileSync(new URL('../../pages/dashboard.astro', import.meta.url), 'utf8');
  for (const k of AUTH_LOCALSTORAGE_KEYS) assert.ok(dash.includes(`'${k}'`), k);
});

test('guard: plan-status は副作用ゼロで、プラン名・期限を返さない／全ページで確認が動く', () => {
  const api = readFileSync(new URL('../../pages/api/plan-status.json.js', import.meta.url), 'utf8');
  assert.doesNotMatch(api, /method:\s*'(POST|PATCH|PUT|DELETE)'/, 'Airtable へ書き込まない');
  assert.doesNotMatch(api, /markLastLogin|AuthTokens|sendgrid/i);
  assert.match(api, /reply\(200, \{ requiresLogin: shouldSendMagicLink\(membership\) \}\)/);
  assert.match(api, /CUSTOMER_LOOKUP\.SINGLE\) return reply\(200, \{ requiresLogin: false \}\)/, '見つからない・重複はログアウトさせない');
  const layout = readFileSync(new URL('../../layouts/BaseLayout.astro', import.meta.url), 'utf8');
  assert.match(layout, /<StaleFreeSessionCheck \/>/);
});
