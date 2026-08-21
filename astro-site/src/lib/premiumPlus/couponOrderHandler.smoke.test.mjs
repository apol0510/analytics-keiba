/**
 * couponOrderHandler.smoke.test.mjs — 申込 Function を**実際に動かして**クーポンの扱いを固定する
 *
 * Airtable / SendGrid は fetch をスタブし、**送られた副作用をそのまま数える**。
 *
 * 固定する仕様:
 *   - クーポン未選択 → 通常価格 68,000円で従来どおり進む
 *   - 正常なクーポン選択 → 58,000円
 *   - 選択したのに未所持 / 不明 id / 判定不能 → **申込ごと停止・副作用ゼロ**
 *   - 58,000円のつもりの申込が 68,000円へ黙って化けない
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const FN = fileURLToPath(new URL('../../../netlify/functions/bank-transfer-application.js', import.meta.url));
const { couponIdWithVersion, PP_REOPEN_COUPON_FIELDS } = await import('./premiumPlusReopenCoupon.js');
const ID = couponIdWithVersion();

const PAUSED_HELD = {
  'Email': 'synthetic@example.invalid', '氏名': 'テスト',
  'プラン': 'Premium Sanrenpuku', 'Status': 'active', '有効期限': '2099-12-31',
  'SanrenpukuPaidAt': '2020-01-01T00:00:00.000Z',
  'PremiumPlusEligibility': 'eligible', 'PremiumPlusReleaseOverride': 'phase4',
  // 販売を一時停止している会員（クーポンは取得済み）
  'PremiumPlusSalePaused': true,
  [PP_REOPEN_COUPON_FIELDS.CLAIMED_AT]: '2026-08-18T22:07:54.803Z',
};

let calls;
let realFetch;
let realEnv;

function stub(fields) {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const m = (init.method || 'GET').toUpperCase();
    if (u.includes('api.airtable.com')) {
      if (m !== 'GET') { calls.push('AIRTABLE_' + m); return new Response('{}', { status: 200 }); }
      return new Response(JSON.stringify({ records: [{ id: 'recSYNTH00000001', fields }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('sendgrid')) { calls.push('SENDGRID'); return new Response('{}', { status: 202 }); }
    calls.push('EXTERNAL');
    return new Response('blocked', { status: 403 });
  };
}

/**
 * Function の標準出力を stderr へ逃がす（Node 20 の node --test 対策）。
 *
 * Node 20 のテストランナーは、子プロセスの **標準出力** にテスト結果を枠付きで流し、
 * 親がそれを v8 デシリアライズして読む（#proccessRawBuffer / FileTest.parseMessage）。
 * そこへ被テストコードの生の出力が割り込むと枠がずれ、親が
 * `Unable to deserialize cloned data due to invalid or unsupported version.` で落ちる。
 *
 * このファイルは premiumPlus のテスト 57 本の中で **唯一 Netlify Function を実行**し、
 * その Function は 43 箇所で console 出力する（絵文字・日本語・複数行のオブジェクト）。
 * そのため並列実行時にこのファイルだけが落ちていた（Node 20 で 60 回中 8 回 = 13.3%）。
 * 単独実行では起きない。テスト自体は毎回すべて合格しており、壊れるのは結果の通信路だけ。
 *
 * ⚠️ 握り潰さないこと。stdout を避けて **stderr へ回すだけ**にする。
 *    stderr は結果の通信路ではないので枠を壊さず、ログは親が診断として拾い直すため
 *    **出力は 16 行のまま欠けない**（実測で修正前後とも 16 行）。
 *
 * 実測: Node 20 で 60 回中 0 回。Node 22 / 24 は元から 0 回。
 *       CI の node-version を 22 以上へ上げればこの対処は不要になる。
 */
function routeStdoutToStderr() {
  const saved = { log: console.log, info: console.info, debug: console.debug };
  console.log = console.info = console.debug = (...args) => console.error(...args);
  return () => Object.assign(console, saved);
}

async function post(body) {
  const restoreConsole = routeStdoutToStderr();
  try {
    globalThis.exports = {};
    globalThis.module = { exports: globalThis.exports };
    // ESM import + exports.handler の混在（Netlify の bundler と同じ扱い）
    await import(`${FN}?t=${Math.random()}`);
    const handler = globalThis.exports.handler;
    const res = await handler({
      httpMethod: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fullName: 'テスト', email: 'synthetic@example.invalid',
        transferDate: '2026-08-19', transferTime: '10:00',
        transferName: 'テスト', productName: 'Premium Plus',
        paymentCompletedConfirm: true,
        ...body,
      }),
    }, {});
    let parsed = {};
    try { parsed = JSON.parse(res.body); } catch { parsed = {}; }
    return { status: res.statusCode, body: parsed };
  } finally {
    restoreConsole();
  }
}

beforeEach(() => {
  calls = [];
  realFetch = globalThis.fetch;
  realEnv = { ...process.env };
  process.env.AIRTABLE_API_KEY = 'stub';
  process.env.AIRTABLE_BASE_ID = 'stub';
  process.env.SENDGRID_API_KEY = 'stub';
  process.env.PREMIUM_PLUS_FIELDS_READY = '1';
  process.env.PREMIUM_PLUS_REOPEN_COUPON_READY = '1';
  process.env.PREMIUM_PLUS_SALE_PAUSE_READY = '1';
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in realEnv)) delete process.env[k];
  Object.assign(process.env, realEnv);
});

/** 販売中（停止していない）会員 */
const SELLING = (over = {}) => ({ ...PAUSED_HELD, PremiumPlusSalePaused: false, ...over });

// ── 未選択 ──────────────────────────────────────────────────
test('クーポン未選択なら通常価格 68,000円で従来どおり進む', async () => {
  stub(SELLING());
  const r = await post({ transferAmount: 68000 });
  assert.notEqual(r.status, 409, 'クーポン未選択で止めてはいけない');
  assert.notEqual(r.body.code, 'coupon_unavailable');
});

// ── 正常 ────────────────────────────────────────────────────
test('正常なクーポン選択は 58,000円で受理される', async () => {
  stub(SELLING());
  const r = await post({ transferAmount: 58000, couponId: ID });
  assert.notEqual(r.status, 409);
  assert.notEqual(r.body.code, 'coupon_unavailable');
});

// ── 検証失敗 → 申込停止・副作用ゼロ ─────────────────────────
test('選択したクーポンを所持していない → 申込拒否・副作用ゼロ', async () => {
  const noCoupon = SELLING();
  delete noCoupon[PP_REOPEN_COUPON_FIELDS.CLAIMED_AT];
  stub(noCoupon);
  const r = await post({ transferAmount: 58000, couponId: ID });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'coupon_unavailable');
  assert.equal(r.body.sideEffects, 'none');
  assert.deepEqual(calls, [], `副作用が出ている: ${calls.join(',')}`);
});

test('不明な couponId → 申込拒否・副作用ゼロ', async () => {
  stub(SELLING());
  const r = await post({ transferAmount: 58000, couponId: 'evil@v9' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'coupon_unavailable');
  assert.deepEqual(calls, [], `副作用が出ている: ${calls.join(',')}`);
});

test('会員レコードを引けず判定不能 → 申込拒否・副作用ゼロ', async () => {
  // Airtable が読めない状態（レコード無し）
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const m = (init.method || 'GET').toUpperCase();
    if (u.includes('api.airtable.com')) {
      if (m !== 'GET') { calls.push('AIRTABLE_' + m); return new Response('{}', { status: 200 }); }
      return new Response(JSON.stringify({ records: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (u.includes('sendgrid')) { calls.push('SENDGRID'); return new Response('{}', { status: 202 }); }
    calls.push('EXTERNAL');
    return new Response('blocked', { status: 403 });
  };
  const r = await post({ transferAmount: 58000, couponId: ID });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'coupon_unavailable');
  assert.deepEqual(calls, [], `副作用が出ている: ${calls.join(',')}`);
});

// ── 58,000 → 68,000 へ化けない ──────────────────────────────
test('58,000円で申し込んだのに 68,000円の申込へ黙って化けない', async () => {
  const noCoupon = SELLING();
  delete noCoupon[PP_REOPEN_COUPON_FIELDS.CLAIMED_AT];
  stub(noCoupon);
  const r = await post({ transferAmount: 58000, couponId: ID });
  // 受理されない＝ 68,000 円の申込レコードが作られない
  assert.equal(r.status, 409);
  assert.deepEqual(calls, []);
});

// ── 販売停止は従来どおり優先 ────────────────────────────────
test('販売停止中はクーポンの有無に関わらず 403 sale_paused のまま', async () => {
  stub(PAUSED_HELD);  // salePaused=true 相当（既定で停止中）
  const withCoupon = await post({ transferAmount: 58000, couponId: ID });
  assert.equal(withCoupon.status, 403);
  assert.equal(withCoupon.body.code, 'sale_paused');
  assert.deepEqual(calls, []);
});

// ── まだ redeem しない ──────────────────────────────────────
test('申込では PromotionalOffers を作らない・使用済みにしない（タイミング未決定）', async () => {
  stub(SELLING());
  await post({ transferAmount: 58000, couponId: ID });
  assert.equal(calls.filter((c) => c.startsWith('AIRTABLE_')).some((c) => c === 'AIRTABLE_POST'), false,
    'offer 台帳へ行を作っている');
});
