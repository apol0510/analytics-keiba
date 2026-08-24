/**
 * campaignReachesMembers.smoke.test.mjs — 案内が**その相手に本当に届く**かを API 越しに確かめる
 *
 * ## なぜ要るか（2026-08-24 / MK 報告「無料でログインしたらお知らせがありません」）
 *
 * `/api/upsell.json` は Premium Plus 用に作られたため、**有料プランしか通していなかった**。
 * その結果、無料・Light の方は 404 になり、
 * 「全会員向け」と言いながら**有料の方にしか届いていなかった**。
 *
 * 判定ロジック（`campaignOffers.js`）は正しく 3 件返していたので、
 * 純粋関数のテストだけでは**永久に気づけない**。ここは API を実際に叩いて確かめる。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createSessionV2 } from '../auth/session.js';
import { SESSION_COOKIE_NAME } from '../auth/constants.js';
import { clearAnchorCache } from '../premiumPlus/purchaseAnchorLookup.js';

const SECRET = 'test-secret-value-at-least-32-characters-long!!';
const REC = 'recSYNTH000000010';

/** 契約ごとの Customers レコード */
const MEMBERS = {
  free: { Email: 'a@example.invalid', 'プラン': 'Free', 'Status': 'active' },
  light: { Email: 'a@example.invalid', 'プラン': 'Light', 'Status': 'active', '有効期限': '2099-12-31' },
  premium: { Email: 'a@example.invalid', 'プラン': 'Premium', 'Status': 'active', '有効期限': '2099-12-31' },
  sanrenpuku: {
    Email: 'a@example.invalid', 'プラン': 'Premium Sanrenpuku', 'Status': 'active',
    '有効期限': '2099-12-31', 'LifetimeSanrenpuku': true,
  },
};
/** セッションに載る plan（Airtable の値とは別の語彙）*/
const SESSION_PLAN = {
  free: 'free', light: 'light', premium: 'premium', sanrenpuku: 'premium-sanrenpuku',
};

let realFetch;
let realEnv;
let record;

function stub() {
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('redis.example.invalid')) return json({ result: null });
    if (u.includes('PromotionalOffers')) return json({ records: [] });
    if (u.includes('api.airtable.com')) return json({ id: REC, fields: record });
    return new Response('blocked', { status: 403 });
  };
}

async function upsell(plan) {
  clearAnchorCache();
  const now = Date.now();
  const { token } = await createSessionV2({
    sub: REC, plan, venueAccess: ['jra', 'nankan'], sessionVersion: 1,
    now, ttlMs: 20 * 60 * 1000, sessionStart: now, secret: SECRET,
  });
  const mod = await import(`../../pages/api/upsell.json.js?t=${Math.random()}`);
  const res = await mod.GET({
    request: new Request('https://analytics.keiba.link/api/upsell.json', {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` },
    }),
  });
  let body = {};
  try { body = await res.json(); } catch { body = {}; }
  return { status: res.status, body };
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  realEnv = { ...process.env };
  process.env.SESSION_SIGNING_SECRET = SECRET;
  process.env.AIRTABLE_API_KEY = 'stub';
  process.env.AIRTABLE_BASE_ID = 'stub';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'stub';
  process.env.COMEBACK_OFFER_TABLE_READY = '1';
  stub();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(process.env)) if (!(k in realEnv)) delete process.env[k];
  Object.assign(process.env, realEnv);
});

/** 公開 API（無料の方はこちらを使う）*/
async function campaignApi(plan) {
  const mod = await import(`../../pages/api/campaign.json.js?t=${Math.random()}`);
  const res = await mod.GET({
    url: new URL(`https://analytics.keiba.link/api/campaign.json?plan=${encodeURIComponent(plan)}`),
  });
  return { status: res.status, body: await res.json() };
}

test('無料の方に案内が届く（本番で届いていなかった）', async () => {
  // ⚠️ 無料会員には**サーバーセッションが発行されない**（`free_plan_not_allowed`）。
  //    そのため `/api/upsell.json` では永久に届かない。公開 API で届ける。
  const { status, body } = await campaignApi('free');
  assert.equal(status, 200, '無料の方に案内 API が応答しない');
  assert.equal(body.active, true);
  assert.equal(body.offers.length, 3, '無料の方への案内が 3 件でない');
  assert.ok(body.offers.some((o) => o.name.includes('Light')), 'Light の割引が入っていない');
});

test('無料会員にはセッションが発行されない（この設計は変えない）', async () => {
  // ⚠️ ここが変わったら公開 API は要らなくなる。変化に気づけるようにしておく。
  await assert.rejects(
    () => createSessionV2({
      sub: REC, plan: 'free', venueAccess: ['jra'], sessionVersion: 1,
      now: Date.now(), ttlMs: 1000, sessionStart: Date.now(), secret: SECRET,
    }),
    /payload rejected/,
  );
});

test('公開 API は会員情報を返さない（認証なしで叩けるため）', async () => {
  const { body } = await campaignApi('free');
  const text = JSON.stringify(body);
  for (const w of ['Email', 'recordId', 'プラン', 'Status', 'Premium Plus']) {
    assert.ok(!text.includes(w), `公開 API が ${w} を返している`);
  }
});

test('申告したプランで案内が変わる（表示だけ・お金は動かない）', async () => {
  assert.equal((await campaignApi('light')).body.offers.length, 2);
  assert.equal((await campaignApi('premium')).body.offers.length, 1);
  assert.equal((await campaignApi('premium-sanrenpuku')).body.offers.length, 0);
});

test('Light の方に案内が届く', async () => {
  record = MEMBERS.light;
  const { status, body } = await upsell(SESSION_PLAN.light);
  assert.equal(status, 200);
  assert.equal(body.campaign.offers.length, 2, 'Light の方への案内が 2 件でない');
  assert.ok(!body.campaign.offers.some((o) => o.name.includes('Light')), '持っている Light を勧めている');
});

test('Premium の方に案内が届く', async () => {
  record = MEMBERS.premium;
  const { status, body } = await upsell(SESSION_PLAN.premium);
  assert.equal(status, 200);
  assert.equal(body.campaign.offers.length, 1);
  assert.match(body.campaign.offers[0].name, /三連複/);
});

test('三連複をお持ちの方には出さない', async () => {
  record = MEMBERS.sanrenpuku;
  const { status, body } = await upsell(SESSION_PLAN.sanrenpuku);
  assert.equal(status, 200);
  assert.equal(body.campaign.offers.length, 0);
});

test('未ログインは従来どおり 404（存在を知らせない）', async () => {
  record = MEMBERS.free;
  const mod = await import(`../../pages/api/upsell.json.js?t=${Math.random()}`);
  const res = await mod.GET({ request: new Request('https://analytics.keiba.link/api/upsell.json') });
  assert.equal(res.status, 404);
});

test('Light の方に Premium Plus の存在を漏らさない（入口を広げても秘匿は保つ）', async () => {
  record = MEMBERS.light;
  const { body } = await upsell(SESSION_PLAN.light);
  assert.equal(body.plus.allowed, false, 'Light の方に Plus を出している');
  assert.equal(body.coupon.claimed, false);
  assert.equal(body.coupon.canClaim, false);
  assert.ok(!JSON.stringify(body).includes('Premium Plus'), 'Premium Plus の名前が漏れている');
});
