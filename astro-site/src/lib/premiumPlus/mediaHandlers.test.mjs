/**
 * mediaHandlers.test.mjs — GET 会員認可 / POST 管理者認可 / 応答の非漏洩・冪等
 *   node --test src/lib/premiumPlus/mediaHandlers.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMediaGet, handleMediaPost, MAX_BODY_BYTES } from './mediaHandlers.js';
import { createMemoryStore } from './mediaKeys.js';
import { applyUpload } from './manifestStore.js';
import { validateImage } from './imageValidation.js';
import { validateUploadMeta } from './uploadValidation.js';
import { makePng, mintCookieHeader, TEST_SECRET } from './testHelpers.mjs';

const NOW = 1_800_000_000_000;
const ADMIN_SECRET = 'pp-admin-secret-32-characters-minimum!!';
const ORIGIN = 'https://analytics.keiba.link';

async function seededStore() {
  const store = createMemoryStore();
  const image = await validateImage(makePng(200, 150));
  const meta = validateUploadMeta({ date: '2026-07-15', venue: '川崎', raceNumber: 6, stake: 16000, isHit: true, payout: 277000 }).meta;
  await applyUpload({ store, image, meta, operationId: 'seed', expectedVersion: 0, now: NOW });
  return store;
}

function hdr(res, name) {
  const key = Object.keys(res.headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? res.headers[key] : undefined;
}

// ---- GET 会員認可 ----

// #1/#2 Cookie なし → 404
test('#1/#2 Cookie なし manifest / image → 404', async () => {
  const store = await seededStore();
  assert.equal((await handleMediaGet({ params: {}, cookieHeader: '', secret: TEST_SECRET, now: NOW, store })).statusCode, 404);
  assert.equal((await handleMediaGet({ params: { action: 'image', date: '2026-07-15' }, cookieHeader: '', secret: TEST_SECRET, now: NOW, store })).statusCode, 404);
});

// #3 不正 Cookie → 404
test('#3 署名改竄 Cookie → 404', async () => {
  const store = await seededStore();
  const bad = (await mintCookieHeader({ plan: 'premium-sanrenpuku' })) + 'TAMPER';
  assert.equal((await handleMediaGet({ params: {}, cookieHeader: bad, secret: TEST_SECRET, now: NOW, store })).statusCode, 404);
});

// #4 期限切れ → 404
test('#4 期限切れ Cookie → 404', async () => {
  const store = await seededStore();
  const c = await mintCookieHeader({ plan: 'premium-sanrenpuku', now: NOW, ttlMs: 20 * 60 * 1000 });
  assert.equal((await handleMediaGet({ params: {}, cookieHeader: c, secret: TEST_SECRET, now: NOW + 21 * 60 * 1000, store })).statusCode, 404);
});

// #5 free/light/premium → 404
test('#5 非該当プラン（light / premium）→ 404', async () => {
  const store = await seededStore();
  for (const plan of ['light', 'premium']) {
    const c = await mintCookieHeader({ plan });
    assert.equal((await handleMediaGet({ params: {}, cookieHeader: c, secret: TEST_SECRET, now: NOW, store })).statusCode, 404, plan);
  }
});

// #6/#7 premium-sanrenpuku / premium-combo → 許可
test('#6/#7 premium-sanrenpuku / premium-combo → 200', async () => {
  const store = await seededStore();
  for (const plan of ['premium-sanrenpuku', 'premium-combo']) {
    const c = await mintCookieHeader({ plan });
    const res = await handleMediaGet({ params: {}, cookieHeader: c, secret: TEST_SECRET, now: NOW, store });
    assert.equal(res.statusCode, 200, plan);
    const body = JSON.parse(res.body);
    assert.equal(body.entries.length, 1);
  }
});

// #8 secret 未設定 → 404
test('#8 SESSION_SIGNING_SECRET 未設定 → 404', async () => {
  const store = await seededStore();
  const c = await mintCookieHeader({ plan: 'premium-sanrenpuku' });
  assert.equal((await handleMediaGet({ params: {}, cookieHeader: c, secret: undefined, now: NOW, store })).statusCode, 404);
});

// #9 manifest に内部 key を返さない
test('#9 manifest 応答に imageKey/checksum/version/operationId を含めない', async () => {
  const store = await seededStore();
  const c = await mintCookieHeader({ plan: 'premium-sanrenpuku' });
  const res = await handleMediaGet({ params: {}, cookieHeader: c, secret: TEST_SECRET, now: NOW, store });
  assert.doesNotMatch(res.body, /imageKey|checksum|operationId|byteSize|"version"|manifests\/|images\//);
  const e = JSON.parse(res.body).entries[0];
  assert.deepEqual(Object.keys(e).sort(), ['betType', 'date', 'imageUrl', 'isHit', 'legacy', 'payout', 'raceNumber', 'venue']);
});

// #10/#11 image が private,no-store / Vary: Cookie
test('#10/#11 image 応答は private,no-store + Vary: Cookie', async () => {
  const store = await seededStore();
  const c = await mintCookieHeader({ plan: 'premium-sanrenpuku' });
  const res = await handleMediaGet({ params: { action: 'image', date: '2026-07-15' }, cookieHeader: c, secret: TEST_SECRET, now: NOW, store });
  assert.equal(res.statusCode, 200);
  assert.equal(res.isBase64Encoded, true);
  assert.equal(hdr(res, 'Cache-Control'), 'private, no-store');
  assert.equal(hdr(res, 'Vary'), 'Cookie');
  // manifest 側も private,no-store
  const m = await handleMediaGet({ params: {}, cookieHeader: c, secret: TEST_SECRET, now: NOW, store });
  assert.equal(hdr(m, 'Cache-Control'), 'private, no-store');
  assert.equal(hdr(m, 'Vary'), 'Cookie');
});

// #12 公開 Blob URL を返さない
test('#12 imageUrl は Function 経由（公開 Blob URL でない）', async () => {
  const store = await seededStore();
  const c = await mintCookieHeader({ plan: 'premium-sanrenpuku' });
  const res = await handleMediaGet({ params: {}, cookieHeader: c, secret: TEST_SECRET, now: NOW, store });
  const url = JSON.parse(res.body).entries[0].imageUrl;
  assert.ok(url.startsWith('/.netlify/functions/premium-plus-media?action=image'));
  assert.doesNotMatch(url, /blob|blobs\.netlify|https?:\/\//);
});

// ---- POST 管理者認可 ----

// #18 認可拒否時に store（getStore）へ到達しない
test('#18 認可拒否時に store factory を呼ばない', async () => {
  let called = 0;
  const factory = () => { called++; throw new Error('must not reach store'); };
  const res = await handleMediaPost({
    method: 'POST', providedSecret: 'wrong-secret-but-long-enough-1234567890', origin: ORIGIN,
    context: 'production', adminSecret: ADMIN_SECRET, body: JSON.stringify({ action: 'status' }), now: NOW, store: factory,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(called, 0);
});

// #19 認可拒否時に Set-Cookie も秘密値も返さない
test('#19 認可拒否応答に Set-Cookie / secret を含めない', async () => {
  const res = await handleMediaPost({
    method: 'POST', providedSecret: 'wrong-secret-but-long-enough-1234567890', origin: ORIGIN,
    context: 'production', adminSecret: ADMIN_SECRET, body: JSON.stringify({ action: 'status' }), now: NOW,
    store: createMemoryStore(),
  });
  assert.equal(hdr(res, 'Set-Cookie'), undefined);
  assert.doesNotMatch(res.body, new RegExp(ADMIN_SECRET.slice(0, 10)));
  assert.doesNotMatch(res.body, /wrong-secret/);
});

// 認可通過での upload → status → 冪等
test('allow: upload → status → 冪等 upload', async () => {
  const store = createMemoryStore();
  const b64 = 'data:image/png;base64,' + Buffer.from(makePng(200, 150)).toString('base64');
  const allow = { method: 'POST', providedSecret: ADMIN_SECRET, origin: ORIGIN, context: 'production', adminSecret: ADMIN_SECRET, now: NOW, store };

  const up = await handleMediaPost({ ...allow, body: JSON.stringify({ action: 'upload', operationId: 'op1-00000001', expectedVersion: 0, date: '2026-07-15', venue: '川崎', raceNumber: 6, stake: 16000, isHit: true, payout: 277000, imageBase64: b64 }) });
  assert.equal(up.statusCode, 200);
  assert.equal(JSON.parse(up.body).version, 1);

  const st = await handleMediaPost({ ...allow, body: JSON.stringify({ action: 'status' }) });
  assert.equal(st.statusCode, 200);
  assert.equal(JSON.parse(st.body).version, 1);

  const again = await handleMediaPost({ ...allow, body: JSON.stringify({ action: 'upload', operationId: 'op1-00000001', expectedVersion: 1, date: '2026-07-15', venue: '川崎', raceNumber: 6, stake: 16000, isHit: true, payout: 277000, imageBase64: b64 }) });
  assert.equal(JSON.parse(again.body).idempotent, true);
});

// operationId 形式検証（長さ・文字種）
test('不正な operationId → 400', async () => {
  const store = createMemoryStore();
  const b64 = 'data:image/png;base64,' + Buffer.from(makePng(200, 150)).toString('base64');
  const base = { method: 'POST', providedSecret: ADMIN_SECRET, origin: ORIGIN, context: 'production', adminSecret: ADMIN_SECRET, now: NOW, store };
  for (const bad of ['', 'short', 'has space', 'x'.repeat(65), 'bad/slash', '../evil']) {
    const res = await handleMediaPost({ ...base, body: JSON.stringify({ action: 'upload', operationId: bad, expectedVersion: 0, date: '2026-07-15', venue: '川崎', stake: 16000, isHit: true, payout: 277000, imageBase64: b64 }) });
    assert.equal(res.statusCode, 400, `operationId=${JSON.stringify(bad)}`);
  }
  // 正常な UUID 相当は通る
  const ok = await handleMediaPost({ ...base, body: JSON.stringify({ action: 'upload', operationId: '11111111-2222-3333-4444-555555555555', expectedVersion: 0, date: '2026-07-15', venue: '川崎', stake: 16000, isHit: true, payout: 277000, imageBase64: b64 }) });
  assert.equal(ok.statusCode, 200);
});

// 物理 delete は 410
test('action:delete は 410（廃止）', async () => {
  const store = createMemoryStore();
  const res = await handleMediaPost({ method: 'POST', providedSecret: ADMIN_SECRET, origin: ORIGIN, context: 'production', adminSecret: ADMIN_SECRET, now: NOW, store, body: JSON.stringify({ action: 'delete', date: '2026-07-15' }) });
  assert.equal(res.statusCode, 410);
});

// seed request size 上限 → 413
test('body が上限超過 → 413（seed の 1 リクエスト肥大を防ぐ）', async () => {
  const store = createMemoryStore();
  const body = 'a'.repeat(MAX_BODY_BYTES + 1);
  const res = await handleMediaPost({ method: 'POST', providedSecret: ADMIN_SECRET, origin: ORIGIN, context: 'production', adminSecret: ADMIN_SECRET, now: NOW, store, body });
  assert.equal(res.statusCode, 413);
});

// seed-stage → seed-commit（分割ステージ後に 1 度だけ切替）
test('seed-stage → seed-commit で legacy を投入', async () => {
  const store = createMemoryStore();
  const allow = { method: 'POST', providedSecret: ADMIN_SECRET, origin: ORIGIN, context: 'production', adminSecret: ADMIN_SECRET, now: NOW, store };
  const b64a = 'data:image/png;base64,' + Buffer.from(makePng(200, 150)).toString('base64');
  const b64b = 'data:image/png;base64,' + Buffer.from(makePng(220, 150)).toString('base64');

  const st1 = await handleMediaPost({ ...allow, body: JSON.stringify({ action: 'seed-stage', items: [{ date: '2026-06-01', venue: '大井', stake: 16000, isHit: true, payout: 300000, legacy: true, imageBase64: b64a }] }) });
  assert.equal(st1.statusCode, 200);
  const cs1 = JSON.parse(st1.body).staged[0].checksum;
  const st2 = await handleMediaPost({ ...allow, body: JSON.stringify({ action: 'seed-stage', items: [{ date: '2026-06-02', venue: '大井', stake: 16000, isHit: true, payout: 400000, legacy: true, imageBase64: b64b }] }) });
  const cs2 = JSON.parse(st2.body).staged[0].checksum;

  const commit = await handleMediaPost({ ...allow, body: JSON.stringify({ action: 'seed-commit', operationId: 'seedop-0001', expectedVersion: 0, items: [
    { date: '2026-06-01', venue: '大井', stake: 16000, isHit: true, payout: 300000, legacy: true, checksum: cs1 },
    { date: '2026-06-02', venue: '大井', stake: 16000, isHit: true, payout: 400000, legacy: true, checksum: cs2 },
  ] }) });
  assert.equal(commit.statusCode, 200);
  assert.equal(JSON.parse(commit.body).count, 2);
});
