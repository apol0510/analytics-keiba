/**
 * premiumPlusFunnelStore.test.mjs — 実閲覧の計測が**過剰計上せず・PII を持たず・
 * 未計測を 0 と言わない**こと
 *   node --test src/lib/premiumPlus/premiumPlusFunnelStore.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFunnelStore, shouldRecordFunnelEvent, isLikelyBot, shapeFunnelRow, hasAnyFunnelRecord,
  FUNNEL_EVENT, FUNNEL_KEY, DEDUPE_MS, RECORD_ID_RE, FunnelStoreError,
} from './premiumPlusFunnelStore.js';

const REC = 'recABCDEFGHIJKLMN';
const UA = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const T0 = Date.parse('2026-08-13T04:00:00Z');

/** Redis の偽物（HASH を Map で持つ） */
function fakeRedis() {
  const store = new Map();
  const calls = [];
  const cmd = async (args) => {
    calls.push(args);
    const [op, key, field, value] = args;
    if (op === 'HSET') { (store.get(key) || store.set(key, new Map()).get(key)).set(field, value); return 1; }
    if (op === 'HSETNX') {
      const h = store.get(key) || store.set(key, new Map()).get(key);
      if (h.has(field)) return 0;
      h.set(field, value); return 1;
    }
    if (op === 'HGET') { const h = store.get(key); return h ? (h.get(field) ?? null) : null; }
    throw new Error(`unexpected op ${op}`);
  };
  return { cmd, store, calls };
}

const rec = (s, over = {}) => s.record({
  recordId: REC, event: FUNNEL_EVENT.CTA_VIEW, nowMs: T0, userAgent: UA, authenticated: true, ...over,
});

// ── 除外条件 ────────────────────────────────────────────────
test('未認証は数えない', () => {
  const g = shouldRecordFunnelEvent({ recordId: REC, event: FUNNEL_EVENT.CTA_VIEW, userAgent: UA, authenticated: false });
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'unauthenticated');
});

test('管理者プレビューは数えない', () => {
  const g = shouldRecordFunnelEvent({
    recordId: REC, event: FUNNEL_EVENT.CTA_VIEW, userAgent: UA, authenticated: true, adminPreview: true,
  });
  assert.equal(g.reason, 'admin_preview');
});

test('bot / UA 無しは数えない', () => {
  for (const ua of [
    'Mozilla/5.0 (compatible; Googlebot/2.1)', 'curl/8.4.0', 'python-requests/2.31',
    'HeadlessChrome/120', 'facebookexternalhit/1.1', '',
  ]) assert.equal(isLikelyBot(ua), true, `bot 判定漏れ: ${ua}`);
  assert.equal(isLikelyBot(UA), false, '人間のブラウザを弾いている');
});

test('recordId の形式が違えば数えない（任意文字列を鍵にしない）', () => {
  for (const id of ['', 'abc', 'rec短い', "rec'; DROP", 'x'.repeat(40)]) {
    assert.equal(RECORD_ID_RE.test(id), false);
    assert.equal(shouldRecordFunnelEvent({
      recordId: id, event: FUNNEL_EVENT.CTA_VIEW, userAgent: UA, authenticated: true,
    }).ok, false);
  }
});

test('未知のイベントは数えない', () => {
  // ⚠️ `purchase` / `checkout_start` は 2026-08-13 に**実在するイベント**になった。
  //    未知の例として使わない（通ってしまい検査にならない）。
  for (const unknown of ['refund', 'signup', 'view', '']) {
    assert.equal(shouldRecordFunnelEvent({
      recordId: REC, event: unknown, userAgent: UA, authenticated: true,
    }).reason, 'unknown_event', `${unknown} を未知として弾いていない`);
  }
});

// ── 過剰計上の防止 ──────────────────────────────────────────
test('【重要】再描画で二重計上しない（DEDUPE_MS 内は 1 回）', async () => {
  const r = fakeRedis();
  const s = createFunnelStore({ redisCmd: r.cmd });
  assert.equal((await rec(s)).counted, true);
  assert.equal((await rec(s, { nowMs: T0 + 1000 })).counted, false, '連続描画で増えている');
  assert.equal((await rec(s, { nowMs: T0 + DEDUPE_MS - 1 })).counted, false);
  assert.equal((await rec(s, { nowMs: T0 + DEDUPE_MS + 1 })).counted, true, '時間が経っても増えない');

  const out = await s.read({ recordId: REC });
  assert.equal(out.row.cta.count, 2);
  assert.equal(out.row.cta.firstAtMs, T0, '初回時刻が上書きされている');
  assert.equal(out.row.cta.lastAtMs, T0 + DEDUPE_MS + 1);
});

test('種別ごとに独立して数える', async () => {
  const r = fakeRedis();
  const s = createFunnelStore({ redisCmd: r.cmd });
  await rec(s, { event: FUNNEL_EVENT.CTA_VIEW });
  await rec(s, { event: FUNNEL_EVENT.CTA_CLICK });
  await rec(s, { event: FUNNEL_EVENT.PAGE_VIEW });
  const out = await s.read({ recordId: REC });
  assert.equal(out.row.cta.count, 1);
  assert.equal(out.row.click.count, 1);
  assert.equal(out.row.page.count, 1);
});

// ── 未計測を 0 と言わない ───────────────────────────────────
test('【重要】記録が無い人は count=null（0 と断定しない）', async () => {
  const r = fakeRedis();
  const s = createFunnelStore({ redisCmd: r.cmd });
  const out = await s.read({ recordId: 'recZZZZZZZZZZZZZZ' });
  assert.equal(out.available, true);
  assert.equal(out.row.cta.count, null, '0 と断定している');
  assert.equal(hasAnyFunnelRecord(out.row), false);
});

test('【重要】Redis が読めなければ available:false（0 回にしない）', async () => {
  const s = createFunnelStore({ redisCmd: async () => { throw new Error('down'); } });
  const out = await s.read({ recordId: REC });
  assert.equal(out.available, false);
  assert.equal(out.row, null);
});

test('書き込み失敗でも例外を投げない（画面を壊さない）', async () => {
  const s = createFunnelStore({ redisCmd: async () => { throw new Error('down'); } });
  const out = await rec(s);
  assert.equal(out.ok, false);
  assert.equal(out.counted, false);
});

test('Redis 未設定なら生成時に落とす（黙って無計測にしない）', () => {
  assert.throws(() => createFunnelStore({}), FunnelStoreError);
});

// ── 個人情報を増やさない ────────────────────────────────────
test('【重要】保存するのは recordId だけ（アドレス・氏名を書かない）', async () => {
  const r = fakeRedis();
  const s = createFunnelStore({ redisCmd: r.cmd });
  await rec(s);
  const flat = JSON.stringify(r.calls);
  for (const pii of ['@', '氏名', 'Email', 'example.com']) {
    assert.equal(flat.includes(pii), false, `PII が混入: ${pii}`);
  }
  // 鍵は recordId
  assert.ok(r.store.get(FUNNEL_KEY.CTA).has(REC));
});

test('計測開始時刻は最初の 1 回だけ（後から動かさない）', async () => {
  const r = fakeRedis();
  const s = createFunnelStore({ redisCmd: r.cmd });
  await rec(s);
  await rec(s, { nowMs: T0 + DEDUPE_MS * 3 });
  const out = await s.read({ recordId: REC });
  assert.equal(out.startedAtMs, T0);
});

test('shapeFunnelRow は数値でないものを null にする', () => {
  const row = shapeFunnelRow({ cta_views: 'x', cta_first_at: undefined });
  assert.equal(row.cta.count, null);
  assert.equal(row.cta.firstAtMs, null);
});
