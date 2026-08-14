/**
 * premiumPlusFunnelExclusion.test.mjs —
 * **管理者プレビューだけを除外し、運営者本人の通常閲覧を誤除外しない**こと
 *   node --test src/lib/premiumPlus/premiumPlusFunnelExclusion.test.mjs
 *
 * ## なぜこのテストが要るのか
 *
 * 「管理者の確認は数に入れたくない」を素朴に実装すると、
 * **運営者本人の会員アカウント（0510apolone）を丸ごと除外**しがちになる。
 * すると本人が顧客として画面を見ても記録されず、「見ていない」と読まれる。
 * 逆に管理者プレビューを数えると「見た」と読まれる。どちらも判断を誤らせる。
 *
 * 除外してよいのは **`action='preview'` 相当の明示された管理者プレビューだけ**。
 * ここでその線引きを固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFunnelStore, shouldRecordFunnelEvent, FUNNEL_EVENT, DEDUPE_MS,
} from './premiumPlusFunnelStore.js';
import { isAdminPreviewRequest, recordPlusPageView } from './premiumPlusFunnelServer.js';

/** 運営者本人の会員レコード（管理者でもあり、顧客でもある人） */
const OPERATOR = 'recOPERATOR012345';
const UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const T0 = Date.parse('2026-08-13T04:00:00Z');

function fakeRedis() {
  const store = new Map();
  return async (args) => {
    const [op, key, field, value] = args;
    const h = () => store.get(key) || store.set(key, new Map()).get(key);
    if (op === 'HSET') { h().set(field, value); return 1; }
    if (op === 'HSETNX') { if (h().has(field)) return 0; h().set(field, value); return 1; }
    if (op === 'HGET') { const m = store.get(key); return m ? (m.get(field) ?? null) : null; }
    if (op === 'HMGET') return args.slice(2).map((f) => (store.get(key)?.get(f) ?? null));
    throw new Error(`unexpected op ${op}`);
  };
}

const base = (over = {}) => ({
  recordId: OPERATOR, event: FUNNEL_EVENT.CTA_VIEW, userAgent: UA, authenticated: true, ...over,
});

// ── 除外してよいもの ────────────────────────────────────────
test('管理者プレビューは数えない', () => {
  assert.equal(shouldRecordFunnelEvent(base({ adminPreview: true })).reason, 'admin_preview');
});

test('preview の印（body / ヘッダ）を管理者プレビューと認める', () => {
  assert.equal(isAdminPreviewRequest({ body: { preview: '1' } }), true);
  assert.equal(isAdminPreviewRequest({ body: { preview: true } }), true);
  assert.equal(isAdminPreviewRequest({ header: '1' }), true);
});

// ── 誤除外してはいけないもの（本題）───────────────────────
test('【重要】運営者本人でも、通常の顧客画面閲覧なら数える', () => {
  const g = shouldRecordFunnelEvent(base());
  assert.equal(g.ok, true, '運営者の recordId というだけで除外されている');
});

test('【重要】recordId の値そのものは除外条件にしない（管理者リストを持たない）', () => {
  // 形式さえ合っていれば、誰の recordId でも同じ判定になること
  for (const id of [OPERATOR, 'recCUSTOMER012345', 'recDANIEL01234567']) {
    assert.equal(shouldRecordFunnelEvent(base({ recordId: id })).ok, true, `除外された: ${id}`);
  }
});

test('【重要】管理画面から遷移しただけでは除外しない（Referer で消さない）', () => {
  assert.equal(isAdminPreviewRequest({
    body: { event: 'cta_view', referer: 'https://analytics.keiba.link/admin/premium-plus-eligibility' },
  }), false);
});

test('【重要】管理シークレットが付いていても除外しない', () => {
  assert.equal(isAdminPreviewRequest({ body: { event: 'cta_view' }, header: undefined }), false);
  // 別ヘッダ（x-admin-secret 相当）の値を渡しても preview 扱いにしない
  assert.equal(isAdminPreviewRequest({ body: {}, header: 'some-admin-secret-value' }), false);
});

test('preview 以外の任意値は preview 扱いしない', () => {
  for (const v of [undefined, null, '', '0', 'false', 0, 'yes', 2]) {
    assert.equal(isAdminPreviewRequest({ body: { preview: v } }), false, `preview 扱いされた: ${String(v)}`);
  }
});

// ── 実際に記録されるところまで通す ──────────────────────────
test('【重要】プレビューで確認した後、本人が顧客として見たら記録される', async () => {
  const cmd = fakeRedis();
  const store = createFunnelStore({ redisCmd: cmd });

  // 1) 管理者プレビュー → 記録されない
  const preview = await store.record(base({ nowMs: T0, adminPreview: true }));
  assert.equal(preview.counted, false);
  assert.equal(preview.reason, 'admin_preview');

  let read = await store.read({ recordId: OPERATOR });
  assert.equal(read.row.cta.count, null, 'プレビューが記録されている');

  // 2) 同じ人が通常の顧客画面を見た → 記録される（プレビューが尾を引かない）
  const real = await store.record(base({ nowMs: T0 + 1000 }));
  assert.equal(real.counted, true, 'プレビュー済みを理由に本人の閲覧まで落としている');

  read = await store.read({ recordId: OPERATOR });
  assert.equal(read.row.cta.count, 1);
});

test('【重要】商品ページ到達も同じ線引き（プレビューは除外・本人の閲覧は計上）', async () => {
  const redisCmd = fakeRedis();
  const args = { recordId: OPERATOR, userAgent: UA, redisCmd };

  assert.equal((await recordPlusPageView({ ...args, nowMs: T0, adminPreview: true })).counted, false);
  assert.equal((await recordPlusPageView({ ...args, nowMs: T0 + 1 })).counted, true);
  // 短時間の再読み込みは数えない（過剰計上の防止はプレビュー除外とは別の話）
  assert.equal((await recordPlusPageView({ ...args, nowMs: T0 + 2 })).counted, false);
  assert.equal((await recordPlusPageView({ ...args, nowMs: T0 + DEDUPE_MS + 2 })).counted, true);
});

test('Redis 未設定でも例外を投げず、記録しないことを名指しで返す', async () => {
  const out = await recordPlusPageView({ recordId: OPERATOR, env: {}, userAgent: UA });
  assert.equal(out.counted, false);
  assert.equal(out.reason, 'measurement_unavailable');
});

test('Redis が遅くてもページ描画を止めない（打ち切って返す）', async () => {
  const out = await recordPlusPageView({
    recordId: OPERATOR, userAgent: UA, nowMs: T0, timeoutMs: 10,
    redisCmd: () => new Promise(() => {}), // 永久に返らない
  });
  assert.equal(out.counted, false);
  assert.equal(out.reason, 'timeout');
});
