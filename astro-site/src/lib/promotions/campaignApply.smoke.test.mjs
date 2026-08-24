/**
 * campaignApply.smoke.test.mjs — キャンペーン割引が**申込金額に反映される**ことを実ハンドラで固定する
 *
 * ⚠️ 割引はお金そのもの。画面が送ってきた金額は**判定材料にしない**。
 *    申込プランと会員の実データだけで決め、`RequestedAmount` に確定値を書く。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const FN = fileURLToPath(new URL('../../../netlify/functions/bank-transfer-application.js', import.meta.url));
const { CAMPAIGN_WINDOW } = await import('./campaignOffers.js');

/** キャンペーン期間内の時刻に固定できないので、期間内であることを前提にする */
const IN_WINDOW = Date.now() >= Date.parse(CAMPAIGN_WINDOW.startsAtIso)
  && Date.now() < Date.parse(CAMPAIGN_WINDOW.endsAtIso);

const FREE_MEMBER = { Email: 'synthetic@example.invalid', '氏名': 'テスト', 'プラン': 'Free', 'Status': 'active' };
const PREMIUM_MEMBER = {
  Email: 'synthetic@example.invalid', '氏名': 'テスト',
  'プラン': 'Premium', 'Status': 'active', '有効期限': '2099-12-31',
};

/** ⚠️ Airtable の recordId は `rec` + 14 文字。短いと「会員を特定できない」扱いになる */
let patches;
let realFetch;
let realEnv;
let record;

function stub() {
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const m = (init.method || 'GET').toUpperCase();
    const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('sendgrid')) return json({}, 202);
    if (u.includes('redis.example.invalid')) return json({ result: null });
    if (u.includes('PromotionalOffers')) return json({ records: [] });
    if (u.includes('api.airtable.com')) {
      if (m === 'GET') return json({ records: record ? [{ id: 'recSYNTH000000010', fields: record }] : [] });
      patches.push({ method: m, body: JSON.parse(init.body || '{}') });
      return json({ id: 'recSYNTH000000010', fields: record || {} });
    }
    return new Response('blocked', { status: 403 });
  };
}

/** Function の標準出力を stderr へ逃がす（node --test の通信路を壊さない） */
function routeStdout() {
  const saved = { log: console.log, info: console.info, warn: console.warn };
  console.log = console.info = console.warn = (...a) => console.error(...a);
  return () => Object.assign(console, saved);
}

async function apply(over = {}) {
  const restore = routeStdout();
  try {
    globalThis.exports = {};
    globalThis.module = { exports: globalThis.exports };
    await import(`${FN}?t=${patches.length}-${Math.random()}`);
    const res = await globalThis.exports.handler({
      httpMethod: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        fullName: 'テスト', email: 'synthetic@example.invalid',
        transferDate: '2026-08-24', transferTime: '10:00', transferName: 'テスト',
        paymentCompletedConfirm: true, ...over,
      }),
    }, {});
    return { status: res.statusCode };
  } finally { restore(); }
}

/** Requested* を書いた PATCH / POST の中身 */
const requested = () => {
  const p = patches.find((x) => x.body && (x.body.fields || (x.body.records && x.body.records[0])));
  const f = p ? (p.body.fields || p.body.records[0].fields) : null;
  return f || {};
};

beforeEach(() => {
  patches = [];
  record = null;
  realFetch = globalThis.fetch;
  realEnv = { ...process.env };
  process.env.AIRTABLE_API_KEY = 'stub';
  process.env.AIRTABLE_BASE_ID = 'stub';
  process.env.SENDGRID_API_KEY = 'stub';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
  stub();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in realEnv)) delete process.env[k];
  Object.assign(process.env, realEnv);
});

test('無料の方の Premium 年額は 5,000円引きで記録される', { skip: !IN_WINDOW }, async () => {
  record = FREE_MEMBER;
  const res = await apply({ productName: 'Premium Annual (¥49,800)', transferAmount: '49800' });
  assert.equal(res.status, 200);
  assert.equal(requested()['RequestedAmount'], 44800, '割引が乗っていない');
});

test('画面が満額を送ってきてもサーバーの割引価格を採用する', { skip: !IN_WINDOW }, async () => {
  record = FREE_MEMBER;
  await apply({ productName: 'Premium Lifetime (¥78,000)', transferAmount: '78000' });
  assert.equal(requested()['RequestedAmount'], 68000);
});

test('画面が安い金額を送ってきても採用しない（改ざんを通さない）', { skip: !IN_WINDOW }, async () => {
  record = FREE_MEMBER;
  await apply({ productName: 'Premium Lifetime (¥78,000)', transferAmount: '1000' });
  assert.equal(requested()['RequestedAmount'], 68000, 'クライアントの申告を信じている');
});

test('Premium 月額は対象外（通常価格のまま）', { skip: !IN_WINDOW }, async () => {
  record = FREE_MEMBER;
  await apply({ productName: 'Premium Monthly (¥18,000)', transferAmount: '18000' });
  assert.equal(requested()['RequestedAmount'], 18000, '対象外に割引が乗っている');
});

test('Premium の方が Premium を買うときは割引しない（持っているものは勧めない）', { skip: !IN_WINDOW }, async () => {
  record = PREMIUM_MEMBER;
  await apply({ productName: 'Premium Annual (¥49,800)', transferAmount: '49800' });
  assert.equal(requested()['RequestedAmount'], 49800);
});

test('レコードが無い新規の方も無料の方と同じ割引になる', { skip: !IN_WINDOW }, async () => {
  record = null;
  const res = await apply({ productName: 'Premium Annual (¥49,800)', transferAmount: '49800' });
  assert.equal(res.status, 200);
  assert.equal(requested()['RequestedAmount'], 44800);
});

test('権限フィールドは 1 つも書かない（申込は昇格させない）', { skip: !IN_WINDOW }, async () => {
  record = FREE_MEMBER;
  await apply({ productName: 'Premium Annual (¥49,800)', transferAmount: '49800' });
  const f = requested();
  for (const k of ['プラン', '有効期限', 'PaidAt']) {
    assert.ok(!(k in f), `${k} を書いている`);
  }
  // 入金確認は未了のまま（昇格は confirm-bank-payment だけが行う）
  assert.equal(f['PaymentConfirmed'], false);
  // 既存 active 会員の Status は据え置き（pending へ降格させない）
  assert.ok(f['Status'] === undefined || f['Status'] === 'pending', `Status=${f['Status']}`);
});

// ── 運営の停止スイッチ・個別除外（管理画面から操作する）────────────
//
// ⚠️ 案内を見てから申し込むまでに止めたなら、割引は乗らないのが正しい。
//    「案内が出ていたから」は理由にならない（申込のたびにサーバーが見る）。

/** 合成 Redis の応答を差し替える */
let redisReply = () => null;
function stubWithRedis() {
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('redis.example.invalid')) {
      const args = JSON.parse(init.body || '[]');
      return new Response(JSON.stringify({ result: redisReply(args) }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return base(url, init);
  };
}

test('運営が停止していたら割り引かない', { skip: !IN_WINDOW }, async () => {
  record = FREE_MEMBER;
  redisReply = (args) => (args[0] === 'GET' ? '1' : null);   // 停止中
  stubWithRedis();
  await apply({ productName: 'Premium Annual (¥49,800)', transferAmount: '49800' });
  assert.equal(requested()['RequestedAmount'], 49800, '停止中なのに割り引いている');
});

test('個別に対象外にした会員は割り引かない', { skip: !IN_WINDOW }, async () => {
  record = FREE_MEMBER;
  redisReply = (args) => (args[0] === 'HGET' ? '{"actor":"MK"}' : null);   // 除外済み
  stubWithRedis();
  await apply({ productName: 'Premium Annual (¥49,800)', transferAmount: '49800' });
  assert.equal(requested()['RequestedAmount'], 49800, '対象外なのに割り引いている');
});

test('停止スイッチを読めないときは割り引かない（fail closed）', { skip: !IN_WINDOW }, async () => {
  record = FREE_MEMBER;
  const base = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('redis.example.invalid')) return new Response('err', { status: 500 });
    return base(url, init);
  };
  await apply({ productName: 'Premium Annual (¥49,800)', transferAmount: '49800' });
  assert.equal(requested()['RequestedAmount'], 49800, '確認できないのに割り引いている');
});

test('停止していなければ従来どおり割り引く（塞ぎすぎない）', { skip: !IN_WINDOW }, async () => {
  record = FREE_MEMBER;
  redisReply = () => null;
  stubWithRedis();
  await apply({ productName: 'Premium Annual (¥49,800)', transferAmount: '49800' });
  assert.equal(requested()['RequestedAmount'], 44800);
});
