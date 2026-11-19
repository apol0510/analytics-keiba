import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  handlePointExchangeRequest,
  resolveReward,
  escapeHtml,
  buildExchangeEmails,
  duplicateFormula,
  jstDate,
  REWARDS,
} from './pointExchangeServer.js';

const ORIGIN = 'https://analytics.keiba.link';
const ENV = { AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'b' };
const REC = 'recAAAAAAAAAAAAAA';
const NOW = new Date('2026-11-19T15:30:00Z'); // JST 11-20 00:30

function ev(body, { method = 'POST', origin = ORIGIN } = {}) {
  return { httpMethod: method, headers: { origin, host: 'analytics.keiba.link' }, body: JSON.stringify(body) };
}

function setup({ session = REC, fields = { Email: 'member@example.com', 氏名: '会員', プラン: 'premium', ポイント: 1500 }, existing = [], selectThrows = false } = {}) {
  const mails = [];
  const created = [];
  const selects = [];
  const deps = {
    now: NOW,
    adminEmail: 'admin@example.test',
    fromEmail: 'from@example.test',
    readSession: async () => session,
    readCustomer: async (id) => (id === REC ? { id, fields } : null),
    requests: {
      async select(formula) { selects.push(formula); if (selectThrows) throw new Error('airtable_503'); return existing; },
      async create(f) { created.push(f); return { id: 'recREQ0000000000A' }; },
    },
    sendMail: async (m) => { mails.push(m); },
  };
  return { deps, mails, created, selects };
}

const REWARD1 = REWARDS[0];

test('ログインしていなければ 401・保存もメールもしない', async () => {
  const s = setup({ session: null });
  const r = await handlePointExchangeRequest(ev({ rewardName: REWARD1.name, requiredPoints: 1000 }), ENV, { deps: s.deps });
  assert.equal(r.statusCode, 401);
  assert.equal(s.created.length, 0);
  assert.equal(s.mails.length, 0);
});

test('リクエストの userEmail / currentPoints は使わない（宛先はセッションの本人）', async () => {
  const s = setup();
  const r = await handlePointExchangeRequest(ev({
    userEmail: 'victim@example.org', userName: '<b>x</b>', currentPoints: 999999, userPlan: 'vip',
    rewardName: REWARD1.name, requiredPoints: 1000,
  }), ENV, { deps: s.deps });
  assert.equal(r.statusCode, 200);
  assert.equal(s.created[0].Email, 'member@example.com');
  assert.equal(s.created[0].CurrentPoints, 1500);
  assert.equal(s.created[0].Plan, 'Premium');
  assert.equal(s.created[0].Name, '会員');
  const to = s.mails.map((m) => m.to);
  assert.deepEqual(to, ['admin@example.test', 'member@example.com']);
  assert.ok(!JSON.stringify(s.mails).includes('victim@example.org'));
});

test('保有ポイントはサーバー側の値で判定する（本文で多く申告しても不足なら 400）', async () => {
  const s = setup({ fields: { Email: 'member@example.com', ポイント: 500 } });
  const r = await handlePointExchangeRequest(ev({ rewardName: REWARD1.name, requiredPoints: 1000, currentPoints: 5000 }), ENV, { deps: s.deps });
  assert.equal(r.statusCode, 400);
  assert.equal(JSON.parse(r.body).error, 'ポイント不足');
  assert.equal(s.created.length, 0);
});

test('ポイント列が無ければ 0pt として扱う', async () => {
  const s = setup({ fields: { Email: 'member@example.com' } });
  const r = await handlePointExchangeRequest(ev({ rewardName: REWARD1.name }), ENV, { deps: s.deps });
  assert.equal(r.statusCode, 400);
});

test('一覧に無い特典・必要ポイントの不一致は 400', async () => {
  const s = setup();
  for (const body of [
    { rewardName: '<script>alert(1)</script>', requiredPoints: 1 },
    { rewardName: REWARD1.name, requiredPoints: 1 },
    { rewardName: '' },
    {},
  ]) {
    const r = await handlePointExchangeRequest(ev(body), ENV, { deps: s.deps });
    assert.equal(r.statusCode, 400);
  }
  assert.equal(s.created.length, 0);
  assert.equal(resolveReward(REWARD1.name).points, 1000);
  assert.equal(resolveReward(REWARD1.name, '1000').points, 1000);
});

test('必要ポイントはサーバーの一覧の値で保存する', async () => {
  const s = setup({ fields: { Email: 'member@example.com', ポイント: 3500 } });
  const r = await handlePointExchangeRequest(ev({ rewardName: REWARDS[2].name }), ENV, { deps: s.deps });
  assert.equal(r.statusCode, 200);
  assert.equal(s.created[0].RequiredPoints, 3000);
  assert.equal(s.created[0].RewardName, REWARDS[2].name);
  assert.equal(s.created[0].Status, 'Pending');
});

test('同じ日・同じ特典の申請があれば 409（二重申請を止める）', async () => {
  const s = setup({ existing: [{ id: 'recOLD0000000000A' }] });
  const r = await handlePointExchangeRequest(ev({ rewardName: REWARD1.name }), ENV, { deps: s.deps });
  assert.equal(r.statusCode, 409);
  assert.equal(JSON.parse(r.body).code, 'already_requested');
  assert.equal(s.created.length, 0);
  assert.equal(s.mails.length, 0);
  assert.match(s.selects[0], /'2026-11-20'/, '日付は JST');
});

test('重複を確認できなければ保存しない（fail-closed・503）', async () => {
  const s = setup({ selectThrows: true });
  const r = await handlePointExchangeRequest(ev({ rewardName: REWARD1.name }), ENV, { deps: s.deps });
  assert.equal(r.statusCode, 503);
  assert.equal(s.created.length, 0);
});

test('他サイトからの送信は 403・GET は 405・OPTIONS は 204', async () => {
  const s = setup();
  assert.equal((await handlePointExchangeRequest(ev({ rewardName: REWARD1.name }, { origin: 'https://evil.example' }), ENV, { deps: s.deps })).statusCode, 403);
  assert.equal((await handlePointExchangeRequest(ev({}, { origin: '' }), ENV, { deps: s.deps })).statusCode, 403);
  assert.equal((await handlePointExchangeRequest(ev({}, { method: 'GET' }), ENV, { deps: s.deps })).statusCode, 405);
  assert.equal((await handlePointExchangeRequest(ev({}, { method: 'OPTIONS' }), ENV, { deps: s.deps })).statusCode, 204);
  assert.equal(s.created.length, 0);
});

test('会員レコードが読めなければ 401', async () => {
  const s = setup({ session: 'recBBBBBBBBBBBBBB' });
  const r = await handlePointExchangeRequest(ev({ rewardName: REWARD1.name }), ENV, { deps: s.deps });
  assert.equal(r.statusCode, 401);
});

test('メールの HTML に入る値はエスケープされる・件名に改行が入らない', () => {
  const { admin, user } = buildExchangeEmails({
    requestId: 'rec<1>', email: 'a"b@example.com\r\nBcc: x@y', name: '<img src=x onerror=alert(1)>', plan: 'Free',
    reward: REWARD1, currentPoints: 1200, requestedAt: '2026/11/19', adminEmail: 'a@t', fromEmail: 'f@t',
  });
  for (const html of [admin.html, user.html]) {
    assert.ok(!html.includes('<img'), 'タグがそのまま入っている');
    assert.ok(!html.includes('rec<1>'));
  }
  assert.ok(user.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!/[\r\n]/.test(admin.subject));
  assert.equal(escapeHtml(`<&"'>`), '&lt;&amp;&quot;&#39;&gt;');
});

test('メール送信に失敗しても申請は保存済みとして 200', async () => {
  const s = setup();
  s.deps.sendMail = async () => { throw new Error('sendgrid_down'); };
  const r = await handlePointExchangeRequest(ev({ rewardName: REWARD1.name }), ENV, { deps: s.deps });
  assert.equal(r.statusCode, 200);
  assert.equal(s.created.length, 1);
});

test('重複検索の式は値の引用符をエスケープする', () => {
  const f = duplicateFormula({ email: "o'neil@example.com", rewardName: REWARD1.name, date: '2026-11-20' });
  assert.ok(f.includes("o\\'neil@example.com"));
  assert.equal(jstDate(NOW), '2026-11-20');
});

test('Function 本体はリクエストの userEmail を使わず、ログに個人情報を出さない', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fn = readFileSync(path.join(here, '../../../netlify/functions/point-exchange.js'), 'utf8');
  const lib = readFileSync(path.join(here, 'pointExchangeServer.js'), 'utf8');
  assert.match(fn, /handlePointExchangeRequest/);
  assert.ok(!/userEmail/.test(fn));
  assert.ok(!/body\.userEmail|body\.currentPoints/.test(lib));
  assert.ok(!/details:\s*\w+\.message/.test(fn + lib), 'エラー本文に内部の文言を返さない');
  for (const m of lib.matchAll(/console\.(?:log|error|warn)\(([^;]*)\);/g)) {
    assert.ok(!/\bemail\b|\bname\b/.test(m[1]), `ログに個人情報: ${m[1].slice(0, 80)}`);
  }
});
