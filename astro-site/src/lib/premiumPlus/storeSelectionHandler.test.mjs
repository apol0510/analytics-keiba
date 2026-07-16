/**
 * storeSelectionHandler.test.mjs — Function 最上流順序の決定的検証（実 Netlify Blobs 非接続）
 *   node --test src/lib/premiumPlus/storeSelectionHandler.test.mjs
 *
 * 順序: a. kill-switch(!=='true') → 404 / b. resolve canary / c. 不正 → 503 / d. のみ getStore。
 * runHandler へ blobStore factory をスパイ注入し、getStore（＝factory）到達有無と渡す store 名を固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHandler, PREMIUM_PLUS_STORAGE_SAFE } from '../../../netlify/functions/premium-plus-media.js';
import { createMemoryStore } from './mediaKeys.js';

const ADMIN = 'canary-handler-test-secret-32chars!!';
const ENV_KEYS = ['PREMIUM_PLUS_ENABLED', 'PREMIUM_PLUS_CANARY', 'CONTEXT', 'PREMIUM_PLUS_ADMIN_SECRET'];
const instant = () => Promise.resolve(); // 収束読取の backoff をテストでは待たない

function snapshotEnv() { const s = {}; for (const k of ENV_KEYS) s[k] = process.env[k]; return s; }
function restoreEnv(s) { for (const k of ENV_KEYS) { if (s[k] === undefined) delete process.env[k]; else process.env[k] = s[k]; } }
function spyFactory() { const calls = []; return { calls, factory: (name) => { calls.push(name); return createMemoryStore(); } }; }
function adminPost(action = 'status', extraHeaders = {}) {
  return { httpMethod: 'POST', headers: { 'x-admin-secret': ADMIN, origin: 'https://analytics.keiba.link', ...extraHeaders }, body: JSON.stringify({ action }) };
}

test('9 kill-switch OFF → resolver/getStore 未到達・404（不正 canary 値でも 404 優先）', async () => {
  const snap = snapshotEnv();
  const { calls, factory } = spyFactory();
  try {
    delete process.env.PREMIUM_PLUS_ENABLED; // !== 'true'
    process.env.PREMIUM_PLUS_CANARY = 'garbage-value'; // 不正でも kill-switch が優先
    const res = await runHandler(adminPost(), { blobStore: factory, waiter: instant, __storageSafe: true });
    assert.equal(res.statusCode, 404);
    assert.equal(calls.length, 0); // store factory（=getStore）未到達
    assert.equal(res.body.includes('garbage-value'), false);
  } finally { restoreEnv(snap); }
});

test('10 kill-switch ON + 不正 canary → getStore 未到達・503', async () => {
  const snap = snapshotEnv();
  const { calls, factory } = spyFactory();
  try {
    process.env.PREMIUM_PLUS_ENABLED = 'true';
    process.env.PREMIUM_PLUS_CANARY = 'weird-value-xyz';
    process.env.CONTEXT = 'production';
    process.env.PREMIUM_PLUS_ADMIN_SECRET = ADMIN;
    const res = await runHandler(adminPost(), { blobStore: factory, waiter: instant, __storageSafe: true });
    assert.equal(res.statusCode, 503);
    assert.equal(calls.length, 0); // getStore 未到達（認証処理へも進まない）
    assert.equal(res.body.includes('weird-value-xyz'), false); // 生値を含めない
    assert.equal(res.body.includes(ADMIN), false);
  } finally { restoreEnv(snap); }
});

test('11 kill-switch ON + "true" → getStore へ premium-plus-canary を渡す', async () => {
  const snap = snapshotEnv();
  const { calls, factory } = spyFactory();
  try {
    process.env.PREMIUM_PLUS_ENABLED = 'true';
    process.env.PREMIUM_PLUS_CANARY = 'true';
    process.env.CONTEXT = 'production';
    process.env.PREMIUM_PLUS_ADMIN_SECRET = ADMIN;
    const res = await runHandler(adminPost('status'), { blobStore: factory, waiter: instant, __storageSafe: true });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, ['premium-plus-canary']);
  } finally { restoreEnv(snap); }
});

test('12 kill-switch ON + "false"/未設定 → getStore へ premium-plus を渡す', async () => {
  for (const canary of ['false', undefined]) {
    const snap = snapshotEnv();
    const { calls, factory } = spyFactory();
    try {
      process.env.PREMIUM_PLUS_ENABLED = 'true';
      if (canary === undefined) delete process.env.PREMIUM_PLUS_CANARY; else process.env.PREMIUM_PLUS_CANARY = canary;
      process.env.CONTEXT = 'production';
      process.env.PREMIUM_PLUS_ADMIN_SECRET = ADMIN;
      const res = await runHandler(adminPost('status'), { blobStore: factory, waiter: instant, __storageSafe: true });
      assert.equal(res.statusCode, 200, `canary=${canary}`);
      assert.deepEqual(calls, ['premium-plus'], `canary=${canary}`);
    } finally { restoreEnv(snap); }
  }
});

test('14 env ADMIN_SECRET に末尾改行が混入していても、clean な x-admin-secret で 200（本番 403 症状の回帰・正規化）', async () => {
  const snap = snapshotEnv();
  const { calls, factory } = spyFactory();
  try {
    process.env.PREMIUM_PLUS_ENABLED = 'true';
    process.env.PREMIUM_PLUS_CANARY = 'true';
    process.env.CONTEXT = 'production';
    process.env.PREMIUM_PLUS_ADMIN_SECRET = `${ADMIN}\n`; // env storage 由来の末尾改行を模擬
    // ヘッダは clean（runner が送出する値）。正規化前は byte 不一致で 403 になっていた。
    const res = await runHandler(adminPost('status'), { blobStore: factory, waiter: instant, __storageSafe: true });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, ['premium-plus-canary']);
  } finally { restoreEnv(snap); }
});

test('15 env ADMIN_SECRET が clean・ヘッダに前後空白でも 200（HTTP OWS 相当の正規化）', async () => {
  const snap = snapshotEnv();
  const { calls, factory } = spyFactory();
  try {
    process.env.PREMIUM_PLUS_ENABLED = 'true';
    process.env.PREMIUM_PLUS_CANARY = 'true';
    process.env.CONTEXT = 'production';
    process.env.PREMIUM_PLUS_ADMIN_SECRET = ADMIN;
    const res = await runHandler(adminPost('status', { 'x-admin-secret': ` ${ADMIN} ` }), { blobStore: factory, waiter: instant, __storageSafe: true });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, ['premium-plus-canary']);
  } finally { restoreEnv(snap); }
});

test('16 正規化しても本質的に異なる secret は 403（マスクしない・store 未到達）', async () => {
  const snap = snapshotEnv();
  const { calls, factory } = spyFactory();
  try {
    process.env.PREMIUM_PLUS_ENABLED = 'true';
    process.env.PREMIUM_PLUS_CANARY = 'true';
    process.env.CONTEXT = 'production';
    process.env.PREMIUM_PLUS_ADMIN_SECRET = ADMIN;
    const res = await runHandler(adminPost('status', { 'x-admin-secret': `${ADMIN}-tampered` }), { blobStore: factory, waiter: instant, __storageSafe: true });
    assert.equal(res.statusCode, 403);
    assert.equal(calls.length, 0); // 認証失敗で getStore 未到達
  } finally { restoreEnv(snap); }
});

test('17 CONTEXT 未設定（Functions ランタイム欠落を模擬）でも valid secret+Origin で 200（本番 403 仮説の回帰）', async () => {
  const snap = snapshotEnv();
  const { calls, factory } = spyFactory();
  try {
    process.env.PREMIUM_PLUS_ENABLED = 'true';
    process.env.PREMIUM_PLUS_CANARY = 'true';
    delete process.env.CONTEXT; // ランタイムで CONTEXT が欠落するケース
    process.env.PREMIUM_PLUS_ADMIN_SECRET = ADMIN;
    const res = await runHandler(adminPost('status'), { blobStore: factory, waiter: instant, __storageSafe: true });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, ['premium-plus-canary']);
  } finally { restoreEnv(snap); }
});

test('18 既知の非本番 context（deploy-preview）は valid secret+Origin でも 403・store 未到達', async () => {
  const snap = snapshotEnv();
  const { calls, factory } = spyFactory();
  try {
    process.env.PREMIUM_PLUS_ENABLED = 'true';
    process.env.PREMIUM_PLUS_CANARY = 'true';
    process.env.CONTEXT = 'deploy-preview';
    process.env.PREMIUM_PLUS_ADMIN_SECRET = ADMIN;
    const res = await runHandler(adminPost('status'), { blobStore: factory, waiter: instant, __storageSafe: true });
    assert.equal(res.statusCode, 403);
    assert.equal(calls.length, 0);
  } finally { restoreEnv(snap); }
});

test('13 不正設定のレスポンス・console に env 生値/secret/cookie を含めない', async () => {
  const snap = snapshotEnv();
  const errCalls = [];
  const origErr = console.error;
  console.error = (...a) => errCalls.push(a.map(String).join(' '));
  try {
    process.env.PREMIUM_PLUS_ENABLED = 'true';
    process.env.PREMIUM_PLUS_CANARY = 'SUPER-secret-raw-canary';
    process.env.CONTEXT = 'production';
    process.env.PREMIUM_PLUS_ADMIN_SECRET = ADMIN;
    const res = await runHandler(
      adminPost('status', { cookie: 'ak_session=SECRETCOOKIEVALUE' }),
      { blobStore: () => createMemoryStore(), waiter: instant, __storageSafe: true },
    );
    assert.equal(res.statusCode, 503); // 不正 canary で fail-closed
    const needles = ['SUPER-secret-raw-canary', ADMIN, 'SECRETCOOKIEVALUE'];
    for (const n of needles) assert.equal(res.body.includes(n), false, `body leak: ${n}`);
    const joined = errCalls.join(' | ');
    for (const n of needles) assert.equal(joined.includes(n), false, `console leak: ${n}`);
  } finally { console.error = origErr; restoreEnv(snap); }
});

// ── Phase 5 hard block（本番 default で書込み経路を封じる・env で有効化できない）──
test('19 PREMIUM_PLUS_STORAGE_SAFE は false 固定（Blobs 単独の lost-update 未解決のため）', () => {
  assert.equal(PREMIUM_PLUS_STORAGE_SAFE, false);
});

test('20 本番 default（override 無し）: ENABLED=true + valid canary/context/secret でも POST 404・store 未到達', async () => {
  const snap = snapshotEnv();
  const { calls, factory } = spyFactory();
  try {
    process.env.PREMIUM_PLUS_ENABLED = 'true';
    process.env.PREMIUM_PLUS_CANARY = 'true';
    process.env.CONTEXT = 'production';
    process.env.PREMIUM_PLUS_ADMIN_SECRET = ADMIN;
    // __storageSafe を渡さない＝本番と同じ経路。定数 false が env より優先し 404。
    const res = await runHandler(adminPost('status'), { blobStore: factory, waiter: instant });
    assert.equal(res.statusCode, 404);
    assert.equal(calls.length, 0); // getStore・認証・Blobs へ一切到達しない
  } finally { restoreEnv(snap); }
});

test('21 本番 default（override 無し）: GET も 404・store 未到達（会員閲覧経路も封じる）', async () => {
  const snap = snapshotEnv();
  const { calls, factory } = spyFactory();
  try {
    process.env.PREMIUM_PLUS_ENABLED = 'true';
    process.env.PREMIUM_PLUS_CANARY = 'true';
    process.env.CONTEXT = 'production';
    const res = await runHandler({ httpMethod: 'GET', headers: {}, queryStringParameters: { limit: '1' } }, { blobStore: factory, waiter: instant });
    assert.equal(res.statusCode, 404);
    assert.equal(calls.length, 0);
  } finally { restoreEnv(snap); }
});
