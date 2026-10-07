/**
 * premiumPlusResultsFunction.test.mjs — premium-plus-results Function の list / remove 契約
 *   node --test src/lib/premiumPlus/premiumPlusResultsFunction.test.mjs
 *
 * GitHub contents API は fetch 差し替えで模擬する（本番・GitHub へは一切接続しない）。
 * - list は読むだけ（PUT しない）
 * - remove は台帳に無い日付なら 404 で PUT しない（空コミット防止）
 * - remove は指定日だけを消して PUT する
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
const ADMIN_KEY = 'local-test-value';
const LEDGER = [
  { date: '2026-10-29', venue: '船橋', raceNumber: null, first: [1], second: [2], third: [3], isHit: false, payout: 0 },
  { date: '2026-10-02', venue: '船橋', raceNumber: 10, first: [1], second: [2], third: [3], isHit: true, payout: 45500 },
];

let puts;
beforeEach(() => {
  puts = [];
  // ダミー値のみ（本物の認証情報ではない）
  for (const [k, v] of [
    ['PREMIUM_PLUS_ADMIN_SECRET', ADMIN_KEY], ['GITHUB_TOKEN', 'dummy'],
    ['GITHUB_REPO_OWNER', 'o'], ['GITHUB_REPO_NAME', 'r'], ['GITHUB_BRANCH', 'main'],
  ]) process.env[k] = v;
  globalThis.fetch = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PUT') {
      puts.push(JSON.parse(opts.body));
      return { ok: true, status: 200, json: async () => ({ commit: { sha: 'abc' } }) };
    }
    if (String(url).includes('api.github.com')) {
      const content = Buffer.from(JSON.stringify(LEDGER)).toString('base64');
      return { ok: true, status: 200, json: async () => ({ sha: 's1', content }) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
});

// exports.handler 形式の Function を ESM として読む（adminCouponConsistency.smoke と同じ方式）
globalThis.exports = {};
globalThis.module = { exports: globalThis.exports };
await import('../../../netlify/functions/premium-plus-results.js');
const { handler } = globalThis.exports;
const call = (body, key = ADMIN_KEY) =>
  handler({ httpMethod: 'POST', headers: { 'x-admin-secret': key }, body: JSON.stringify(body) })
    .then((r) => ({ status: r.statusCode, body: JSON.parse(r.body) }));

test('list: 台帳を新しい順で返し、コミットしない', async () => {
  const r = await call({ action: 'list' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.entries.map((e) => e.date), ['2026-10-29', '2026-10-02']);
  assert.equal(puts.length, 0);
});

test('list: secret 不一致は 403', async () => {
  const r = await call({ action: 'list' }, 'wrong');
  assert.equal(r.status, 403);
});

test('remove: 指定日だけ消して PUT する', async () => {
  const r = await call({ action: 'remove', date: '2026-10-29' });
  assert.equal(r.status, 200);
  assert.equal(puts.length, 1);
  const next = JSON.parse(Buffer.from(puts[0].content, 'base64').toString('utf-8'));
  assert.deepEqual(next.map((e) => e.date), ['2026-10-02']);
  assert.equal(puts[0].sha, 's1');
});

test('remove: 台帳に無い日付は 404 で PUT しない', async () => {
  const r = await call({ action: 'remove', date: '2026-09-29' });
  assert.equal(r.status, 404);
  assert.equal(puts.length, 0);
});

test('remove: 日付形式が不正なら 400', async () => {
  const r = await call({ action: 'remove', date: '' });
  assert.equal(r.status, 400);
  assert.equal(puts.length, 0);
});
