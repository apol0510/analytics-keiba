/**
 * paddleDelegateEntryGate.test.mjs — 入口の早期 503 判定が委譲経路を塞がないことの回帰テスト。
 *
 * 事故: 本番サイト（PADDLE_API_KEY を 4KB 制約で持たない）では、入口 Function の早期判定が
 *   `resolvePaddleMode({ key: undefined })` を直接呼び、鍵が無いだけで paddle_key_missing(503) を返して
 *   createPaddleCheckout の委譲経路へ到達していなかった（本番で委譲が発火せず、接続が未完成だった）。
 * 対策: 入口も createPaddleCheckout も `resolvePaddleModeForEnv`（委譲の有無を同じ基準で判定）だけを使う。
 *   委譲条件（本番・鍵なし・内部 secret あり）では、販売前は card_sales_not_open で止まる（fail closed）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { shouldDelegatePaddle, resolvePaddleModeForEnv } from './paddleServer.js';
import { resolveActiveCardMode } from '../cardCheckout.js';
import { PRODUCTION_ORIGIN } from '../cardSales.js';

const PROD = PRODUCTION_ORIGIN;
const SECRET = 'internal-secret-0123456789abcdef0123456789abcdef';
const LIVE_KEY = 'pdl_live_apikey_TESTONLY';
// 本番サイト = 鍵なし・内部 secret あり（＝委譲元）
const MAIN_ENV = { CARD_GRANT_INTERNAL_SECRET: SECRET };

test('shouldDelegatePaddle: 本番・鍵なし・secret ありだけ true', () => {
  assert.equal(shouldDelegatePaddle({ env: MAIN_ENV, origin: PROD }), true);
  assert.equal(shouldDelegatePaddle({ env: { PADDLE_API_KEY: LIVE_KEY, CARD_GRANT_INTERNAL_SECRET: SECRET }, origin: PROD }), false); // 鍵あり
  assert.equal(shouldDelegatePaddle({ env: MAIN_ENV, origin: 'https://deploy-preview-1--x.netlify.app' }), false); // 本番 origin でない
  assert.equal(shouldDelegatePaddle({ env: {}, origin: PROD }), false); // secret 無し（preview）
});

test('resolvePaddleModeForEnv(委譲): 販売前は card_sales_not_open・開くと live（paddle_key_missing にしない）', () => {
  const closed = resolvePaddleModeForEnv({ env: MAIN_ENV, origin: PROD }); // salesOpen 省略 = CARD_SALES_OPEN(false)
  assert.equal(closed.ok, false);
  assert.equal(closed.reason, 'card_sales_not_open');
  const open = resolvePaddleModeForEnv({ env: MAIN_ENV, origin: PROD, salesOpen: true });
  assert.equal(open.ok, true);
  assert.equal(open.mode, 'live');
});

test('resolvePaddleModeForEnv(非委譲): 鍵なし preview は従来どおり paddle_key_missing', () => {
  // secret 無し（preview）→ 委譲しない → 鍵も無い → paddle_key_missing
  const r = resolvePaddleModeForEnv({ env: {}, origin: PROD, salesOpen: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'paddle_key_missing');
  // secret あっても本番 origin でなければ委譲しない（鍵なし → paddle_key_missing）
  const r2 = resolvePaddleModeForEnv({ env: MAIN_ENV, origin: 'https://deploy-preview-9--x.netlify.app', salesOpen: true });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'paddle_key_missing');
});

test('resolveActiveCardMode(共通カード入口): 委譲元では card_sales_not_open（paddle_key_missing で早期に弾かない）', () => {
  const r = resolveActiveCardMode({ env: MAIN_ENV, origin: PROD });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'card_sales_not_open');
});

// --- 入口 Function（CJS handler）の実挙動: 委譲元・販売前 → 503 card_sales_not_open（旧: paddle_key_missing） ---
const FN_DIR = '../../../../netlify/functions';
async function callHandler(relPath, { origin = PROD, host = 'analytics.keiba.link' } = {}) {
  const fn = fileURLToPath(new URL(`${FN_DIR}/${relPath}`, import.meta.url));
  const savedKey = process.env.PADDLE_API_KEY;
  const savedSecret = process.env.CARD_GRANT_INTERNAL_SECRET;
  const savedLog = { log: console.log, warn: console.warn, info: console.info };
  console.log = console.warn = console.info = (...a) => console.error(...a);
  delete process.env.PADDLE_API_KEY;               // 本番サイト = 鍵なし
  process.env.CARD_GRANT_INTERNAL_SECRET = SECRET;  // 内部 secret あり = 委譲元
  try {
    globalThis.exports = {}; globalThis.module = { exports: globalThis.exports };
    await import(`${fn}?t=${Math.random()}`);
    const res = await globalThis.exports.handler({
      httpMethod: 'POST',
      headers: { 'content-type': 'application/json', origin, host },
      body: JSON.stringify({ product: 'premium-annual' }),
    }, {});
    return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
  } finally {
    if (savedKey === undefined) delete process.env.PADDLE_API_KEY; else process.env.PADDLE_API_KEY = savedKey;
    if (savedSecret === undefined) delete process.env.CARD_GRANT_INTERNAL_SECRET; else process.env.CARD_GRANT_INTERNAL_SECRET = savedSecret;
    Object.assign(console, savedLog);
  }
}

test('paddle-create-checkout.js: 委譲元・販売前 → 503 card_sales_not_open（委譲経路を塞がない）', async () => {
  const r = await callHandler('paddle-create-checkout.js');
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'card_sales_not_open');
});

test('card-create-checkout.js: 委譲元・販売前 → 503 card_sales_not_open（委譲経路を塞がない）', async () => {
  const r = await callHandler('card-create-checkout.js');
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'card_sales_not_open');
});
