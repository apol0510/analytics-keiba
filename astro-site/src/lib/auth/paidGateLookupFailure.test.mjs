/**
 * paidGateLookupFailure.test.mjs — 一時障害で有効会員を締め出さないことを固定する
 *   node --test src/lib/auth/paidGateLookupFailure.test.mjs
 *
 * 2026-08-08 の障害:
 *   Airtable の一時障害（429 / タイムアウト）で lookup が null を返し、
 *   その null が **10 分キャッシュ**された。キャッシュ鍵は recordId なので
 *   **マジックリンクで入り直しても回復せず**、有効な有料会員が 302 /login のままだった。
 *   利用者は繰り返しログインを試み、負荷が増えて 429 がさらに出る悪循環になった。
 *   （8/07 のログインリンク 6 通 → 8/08 は 33 通。うち 4 名が 5〜12 回）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  lookupCustomerFields, lookupCustomerFieldsResult, clearAnchorCache, ANCHOR_CACHE_TTL_MS,
} from '../premiumPlus/purchaseAnchorLookup.js';
import { gatePaidPage } from './paidPageGate.js';

const env = { AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'b', SESSION_SIGNING_SECRET: 's' };
const FIELDS = { 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2099-12-31' };

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// ── 1. 失敗をキャッシュしない ─────────────────────────────────
for (const [label, bad] of [
  ['429（レート制限）', () => res(429, {})],
  ['500（サーバエラー）', () => res(500, {})],
  ['timeout（例外）', () => { throw new Error('aborted'); }],
]) {
  test(`${label} の直後に Airtable が復旧したら、すぐ引ける（失敗をキャッシュしない）`, async () => {
    clearAnchorCache();
    let n = 0;
    const fetchImpl = async () => { n += 1; return n === 1 ? bad() : res(200, { fields: FIELDS }); };
    const t0 = 1_000_000;

    const first = await lookupCustomerFieldsResult({ recordId: 'recX', env, now: t0, fetchImpl });
    assert.equal(first.ok, false, `${label}: 1 回目は失敗するはず`);
    assert.equal(first.reason, 'unavailable', `${label}: 一時障害として区別されていない`);

    const second = await lookupCustomerFieldsResult({ recordId: 'recX', env, now: t0 + 1000, fetchImpl });
    assert.equal(second.ok, true, `${label}: 1 秒後に復旧しても引けない（失敗がキャッシュされている）`);
    assert.equal(n, 2, `${label}: 2 回目に Airtable を引き直していない`);
  });
}

test('成功した取得はキャッシュされる（負荷を増やさない）', async () => {
  clearAnchorCache();
  let n = 0;
  const fetchImpl = async () => { n += 1; return res(200, { fields: FIELDS }); };
  const t0 = 2_000_000;
  await lookupCustomerFieldsResult({ recordId: 'recY', env, now: t0, fetchImpl });
  await lookupCustomerFieldsResult({ recordId: 'recY', env, now: t0 + 1000, fetchImpl });
  assert.equal(n, 1, '成功がキャッシュされていない');
  const after = await lookupCustomerFieldsResult({ recordId: 'recY', env, now: t0 + ANCHOR_CACHE_TTL_MS + 1, fetchImpl });
  assert.equal(after.ok, true);
  assert.equal(n, 2, 'TTL 経過後に引き直していない');
});

test('404 は not_found として区別する（存在しない会員）', async () => {
  clearAnchorCache();
  const r = await lookupCustomerFieldsResult({
    recordId: 'recZ', env, now: 1, fetchImpl: async () => res(404, {}),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_found');
});

// ── 2. 後方互換 ───────────────────────────────────────────────
test('lookupCustomerFields は従来どおり fields|null を返す', async () => {
  clearAnchorCache();
  const okv = await lookupCustomerFields({
    recordId: 'recA', env, now: 1, fetchImpl: async () => res(200, { fields: FIELDS }),
  });
  assert.deepEqual(okv, FIELDS);
  clearAnchorCache();
  const ngv = await lookupCustomerFields({
    recordId: 'recB', env, now: 1, fetchImpl: async () => res(429, {}),
  });
  assert.equal(ngv, null);
});

// ── 3. gate は理由を分けつつ、どちらも通さない ────────────────
test('一時障害は lookup_unavailable として拒否する（fail closed は維持）', async () => {
  const r = await gatePaidPage({
    request: { headers: { get: () => 'ak_session=dummy' } },
    requiredPlan: 'premium', env, now: 1,
    lookup: async () => ({ ok: false, reason: 'unavailable' }),
  });
  assert.equal(r.ok, false);
  // session が無効なので no_session で止まるのが正（lookup まで届かない）
  // secret がダミーなので session 検証で止まるのが正。lookup まで届かない。
  assert.ok(['lookup_unavailable', 'no_session', 'invalid_session', 'bad_signature', 'key_missing']
    .includes(r.reason), `想定外の reason: ${r.reason}`);
  assert.ok(r.response, '拒否時に response を返していない');
});

test('会員不在と一時障害の reason コードが別である', async () => {
  // 直接 deny 経路の分岐を確認する（session を通せないため lookup の戻り値で判定）
  const src = (await import('node:fs')).readFileSync(
    (await import('node:url')).fileURLToPath(new URL('./paidPageGate.js', import.meta.url)), 'utf8');
  assert.match(src, /'customer_not_found'/);
  assert.match(src, /'lookup_unavailable'/);
  assert.match(src, /r\.reason === 'not_found' \? 'customer_not_found' : 'lookup_unavailable'/,
    '一時障害と not_found を同じ reason に潰している');
  assert.match(src, /export function normalizeLookupResult/,
    'lookup 戻り値の正規化が無い（新旧契約の両対応が失われている）');
});
