/**
 * dispatcherHandler.smoke.test.mjs — dispatcher の**ハンドラを実際に起動する**煙試験。
 *
 * 送信経路はここ 1 本しかない。ソース検査だけでは import 漏れ・引数不一致で
 * 本番 500 になる欠陥を検知できない（2026-08-02 に admin の `jobs` で実際に起きた）。
 * ネットワークを差し替えて起動し、**gate・PENDING 限定・jobId 限定・送信 0** を固定する。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearProviderSuppressionCache } from './providerSuppression.js';

const SECRET = 'test-admin-secret';
const JOB_ID = 'mkt-expired-comeback-v2-abc12345-1';

/** Airtable / SendGrid を差し替える。**送信 API を叩いたら記録する** */
/**
 * 偽 Redis（Upstash REST）。**排他の意味を保ったまま**振る舞わせる:
 * `INCR` は単調増加、`SET NX` は既存キーがあれば null、
 * `EVAL`（verify / release）は token 一致のときだけ OK。
 */
function makeFakeRedis(store = new Map(), counters = { fence: 0 }) {
  return (args) => {
    const op = String(args[0] || '').toUpperCase();
    if (op === 'INCR') { counters.fence += 1; return String(counters.fence); }
    if (op === 'SET') {
      const [, key, val, ...rest] = args;
      const nx = rest.map((x) => String(x).toUpperCase()).includes('NX');
      if (nx && store.has(key)) return null;
      store.set(key, String(val));
      return 'OK';
    }
    if (op === 'EVAL') {
      const script = String(args[1] || '');
      const key = args[3];
      const token = String(args[4]);
      const cur = store.get(key);
      if (cur === undefined) return 'LOST';
      if (cur !== token) return 'STOLEN';
      if (script.includes("redis.call('DEL'")) store.delete(key);
      return 'OK';
    }
    if (op === 'GET') return store.get(args[1]) ?? null;
    if (op === 'DEL') { store.delete(args[1]); return 1; }
    return null;
  };
}

function stub({
  scheduled = [], deliveries = [], customers = [], suppression = true,
  redis = null, onSend = null,
} = {}) {
  const calls = { sendgridSend: 0, airtableWrites: 0, urls: [], redisOps: [] };
  const redisCmd = redis || makeFakeRedis();
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    calls.urls.push(method + ' ' + u.split('?')[0]);
    if (u.includes('fake-redis.local')) {
      const args = JSON.parse(init.body || '[]');
      calls.redisOps.push(String(args[0]).toUpperCase());
      const result = await redisCmd(args);
      return { ok: true, status: 200, json: async () => ({ result }) };
    }
    if (u.includes('api.sendgrid.com/v3/mail/send')) {
      calls.sendgridSend += 1;
      if (onSend) await onSend();
      return { ok: true, status: 202 };
    }
    if (u.includes('api.sendgrid.com/v3/suppression')) {
      return suppression ? { ok: true, status: 200, json: async () => [] } : { ok: false, status: 401, json: async () => ({}) };
    }
    if (u.includes('api.sendgrid.com')) return { ok: true, status: 200, json: async () => [] };
    if (u.includes('api.airtable.com')) {
      // `POST /{table}/listRecords` は Airtable の **読み取り** API（長い formula 用）。
      // 書き込みと数えず、formula の絞り込みを実挙動どおり再現する。
      if (u.includes('/listRecords')) {
        const formula = String(JSON.parse(init.body || '{}').filterByFormula || '');
        const pick = (re) => new Set([...formula.matchAll(re)].map((m) => m[1]));
        if (u.includes('Customers')) {
          const want = pick(/LOWER\(\{Email\}\)='([^']*)'/g);
          const rows = customers.filter((r) => want.has(String(r.fields?.Email || '').toLowerCase()));
          return { ok: true, status: 200, json: async () => ({ records: rows }) };
        }
        if (u.includes('CampaignDeliveries')) {
          const want = pick(/LOWER\(\{RecipientEmail\}\)='([^']*)'/g);
          const rows = deliveries.filter((r) => want.size === 0
            || want.has(String(r.fields?.RecipientEmail || '').toLowerCase()));
          return { ok: true, status: 200, json: async () => ({ records: rows }) };
        }
        return { ok: true, status: 200, json: async () => ({ records: [] }) };
      }
      if (method !== 'GET') { calls.airtableWrites += 1; return { ok: true, status: 200, json: async () => ({}) }; }
      if (u.includes('ScheduledEmails')) {
        // 実 API は filterByFormula で絞る。stub でも同じに振る舞わせる
        const wantPending = decodeURIComponent(u).includes("{Status}='PENDING'");
        const rows = wantPending ? scheduled.filter((r) => String(r.fields.Status) === 'PENDING') : scheduled;
        return { ok: true, status: 200, json: async () => ({ records: rows }) };
      }
      if (u.includes('CampaignDeliveries')) return { ok: true, status: 200, json: async () => ({ records: deliveries }) };
      if (u.includes('EmailBlacklist')) return { ok: true, status: 200, json: async () => ({ records: [] }) };
      if (u.includes('Customers')) return { ok: true, status: 200, json: async () => ({ records: customers }) };
      return { ok: true, status: 200, json: async () => ({ records: [] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };
  return calls;
}

async function invoke(body, env = {}) {
  process.env.PREMIUM_PLUS_ADMIN_SECRET = SECRET;
  process.env.AIRTABLE_API_KEY = 'test-key';
  process.env.AIRTABLE_BASE_ID = 'appTEST';
  process.env.SENDGRID_API_KEY = 'SG.test';
  // 排他は Redis が正本。既定で「使える」状態にしておき、
  // 「使えないと送らない」ことは専用の試験で確かめる
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.local';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
  delete process.env.MARKETING_CAMPAIGN_DISPATCH_ENABLED;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const mod = await import('../../../netlify/functions/marketing-campaign-dispatch.js');
  const res = await mod.handler({
    httpMethod: 'POST', headers: { 'x-admin-secret': SECRET }, body: JSON.stringify(body),
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body || '{}') };
}

const job = (over = {}) => ({
  id: 'recJOB0000000001',
  fields: {
    JobId: JOB_ID, Status: 'PENDING', CreatedBy: 'admin-marketing',
    TargetPlan: 'campaign:expired-comeback', Recipients: 'a@example.com',
    Subject: 'テスト', Content: '<p>本文</p>', RecipientCount: 1,
    // dispatcher は「どの組み立て方で作った HTML か」を Notes から読む。
    // 版が合わないジョブは送らないので、正常系の fixture には必ず入れる。
    Notes: 'marketing campaign expired-comeback v2 shell:v1', ...over,
  },
});

test('smoke: gate が閉じていれば live 送信は 503（1 通も送らない）', async () => {
  const calls = stub({ scheduled: [job()] });
  const { statusCode, body } = await invoke({ dryRun: false });
  assert.equal(statusCode, 503);
  assert.equal(body.flag, 'MARKETING_CAMPAIGN_DISPATCH_ENABLED');
  assert.equal(calls.sendgridSend, 0, 'gate 閉鎖なのに送信した');
  assert.equal(calls.airtableWrites, 0, 'gate 閉鎖なのに書き込んだ');
});

test('smoke: dryRun は既定 true（body 無指定で送信しない）', async () => {
  const calls = stub({ scheduled: [job()] });
  const { statusCode, body } = await invoke({});
  assert.equal(statusCode, 200);
  assert.equal(body.mode, 'dry-run');
  assert.equal(calls.sendgridSend, 0);
  assert.equal(calls.airtableWrites, 0, 'dry-run で書き込んでいる');
});

test('smoke: PENDING 以外のジョブは対象にしない', async () => {
  const calls = stub({ scheduled: [job({ Status: 'SENT' })] });
  const { body } = await invoke({ dryRun: true });
  assert.equal(body.jobs, 0, 'SENT のジョブを対象にしている');
  assert.equal(calls.sendgridSend, 0);
});

test('smoke: マーケティング以外のジョブは対象にしない', async () => {
  stub({ scheduled: [job({ JobId: 'newsletter-1', CreatedBy: 'cron-email-scheduler', TargetPlan: 'newsletter' })] });
  const { body } = await invoke({ dryRun: true });
  assert.equal(body.jobs, 0, 'マーケ以外のジョブを処理している');
});

test('smoke: jobId を渡すとそのジョブだけが対象になる（巻き込み送信の防止）', async () => {
  stub({ scheduled: [job(), job({ JobId: 'other-job' })] });
  const both = await invoke({ dryRun: true });
  assert.equal(both.body.jobs, 2, '前提: 2 件ある');
  const one = await invoke({ dryRun: true, jobId: JOB_ID });
  assert.equal(one.body.jobs, 1);
  assert.equal(one.body.jobResults[0].jobId, JOB_ID);
});

test('smoke: provider の配信停止リストを取れなければ中止（1 通も送らない）', async () => {
  // suppression は 5 分キャッシュされる。前の試験の成功結果を引きずらせない
  clearProviderSuppressionCache();
  const calls = stub({ scheduled: [job()], suppression: false });
  const { statusCode, body } = await invoke({ dryRun: true });
  assert.equal(statusCode, 503);
  assert.equal(body.sideEffects, 'none');
  assert.equal(calls.sendgridSend, 0);
});

test('smoke: 認証が無ければ 403', async () => {
  stub({ scheduled: [job()] });
  process.env.PREMIUM_PLUS_ADMIN_SECRET = SECRET;
  const mod = await import('../../../netlify/functions/marketing-campaign-dispatch.js');
  const res = await mod.handler({ httpMethod: 'POST', headers: {}, body: '{}' });
  assert.equal(res.statusCode, 403);
});

test('smoke: 応答にメールアドレスを載せない', async () => {
  stub({ scheduled: [job()] });
  const { body } = await invoke({ dryRun: true });
  assert.equal(/@[a-z0-9.-]+\.[a-z]{2,}/i.test(JSON.stringify(body)), false, '応答にアドレスが含まれる');
});


test('smoke: 組み立て方の版が合わないジョブは送らない（fail closed）', async () => {
  // deploy でシェルが変わったあと、古い版で積まれたジョブが残っている状況
  const calls = stub({ scheduled: [job({ Notes: 'marketing campaign expired-comeback v2 shell:v0' })] });
  const { statusCode, body } = await invoke({ dryRun: true });
  assert.equal(statusCode, 200);
  assert.equal(body.jobs, 0, '版違いのジョブを処理している');
  assert.equal(body.blockedJobs, 1, '版違いとして記録していない');
  assert.equal(body.jobResults[0].blocked, 'shell_version_mismatch');
  assert.equal(body.jobResults[0].willSend, 0);
  assert.equal(calls.airtableWrites, 0, 'Airtable へ書き込んでいる');
  assert.equal(calls.sendgridSend, 0, 'メールを送っている');
});

test('smoke: 版の印が無い（古い形式の）ジョブも送らない', async () => {
  stub({ scheduled: [job({ Notes: 'marketing campaign expired-comeback v2' })] });
  const { body } = await invoke({ dryRun: true });
  assert.equal(body.jobs, 0);
  assert.equal(body.jobResults[0].blocked, 'shell_version_mismatch');
  assert.equal(body.jobResults[0].jobShellVersion, null);
});

// =========================================================================
// ジョブカードからの送信（2026-08-03）
// jobId を固定して 1 回だけ送る。retry・二重クリックで二重送信しない。
// =========================================================================

const GATE_OPEN = { MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true' };

test('smoke: live は jobId 指定が必須（全件送信を許さない）', async () => {
  const calls = stub({ scheduled: [job()] });
  const { statusCode, body } = await invoke({ dryRun: false }, GATE_OPEN);
  assert.equal(statusCode, 400, 'jobId 無しで実送信できてしまう');
  assert.equal(body.sideEffects, 'none');
  assert.equal(calls.sendgridSend, 0, 'メールを送っている');
  assert.equal(calls.airtableWrites, 0, '書き込んでいる');
});

test('smoke: live は確認した人数（expectedWillSend）が必須', async () => {
  const calls = stub({ scheduled: [job()] });
  const { statusCode, body } = await invoke({ dryRun: false, jobId: JOB_ID }, GATE_OPEN);
  assert.equal(statusCode, 400, '人数の確認なしで送れてしまう');
  assert.equal(body.sideEffects, 'none');
  assert.equal(calls.sendgridSend, 0, 'メールを送っている');
  assert.equal(calls.airtableWrites, 0, '書き込んでいる');
});

test('smoke: 確認した人数と実際が違えば送らない（409 / 書き込みゼロ）', async () => {
  const calls = stub({ scheduled: [job()] });
  const { statusCode, body } = await invoke(
    { dryRun: false, jobId: JOB_ID, expectedWillSend: 999 }, GATE_OPEN);
  assert.equal(statusCode, 409, '人数が食い違っても送れてしまう');
  assert.equal(body.sideEffects, 'none');
  assert.equal(calls.sendgridSend, 0, 'メールを送っている');
});

test('smoke: dry-run はジョブ単位の内訳を返す', async () => {
  stub({ scheduled: [job()] });
  const { statusCode, body } = await invoke({ dryRun: true, jobId: JOB_ID });
  assert.equal(statusCode, 200);
  assert.equal(body.requestedJobId, JOB_ID, '対象ジョブをエコーしていない');
  const r = body.jobResults[0];
  for (const k of ['jobId', 'campaignId', 'version', 'shellVersion', 'contentHash',
    'status', 'queued', 'willSend', 'willSkip', 'skipByReason']) {
    assert.ok(k in r, `jobResults に ${k} が無い`);
  }
});

// ══════════════════════════════════════════════════════════════
//  同一ジョブの live 二重起動（2026-08-15 の設計監査）
//
//  `alreadySent` は「読んだ時点の事実」でしかない。読んでから記録するまでの
//  間に同じ jobId の live がもう 1 本走ると、両方が「まだ誰も送っていない」を
//  読み、両方が expectedWillSend を通り、**同じ相手へ 2 通**送れる。
//  逐次再実行の冪等性だけでは塞げないので、同時実行そのものを試験する。
// ══════════════════════════════════════════════════════════════

const LIVE_ENV = { MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true' };

/**
 * 本文には `{{unsubscribeUrl}}` の印が要る。
 * 印が無い本文は **1 通も送らない**（配信停止できないメールを出さない）ので、
 * 正常系の fixture には必ず入れる。
 */
const CONTENT = '<p>本文</p><p><a href="{{unsubscribeUrl}}">配信停止</a></p>';

/** DeliveryKey は sha256 hex 64 桁・recordId は rec+14 文字（実仕様） */
const key64 = (seed) => seed.padEnd(64, '0').slice(0, 64).replace(/[^a-f0-9]/g, 'a');
const recId = (seed) => ('rec' + seed.replace(/[^A-Za-z0-9]/g, '')).padEnd(17, '0').slice(0, 17);

const deliveryRow = ({ email, status = 'queued', n = '1' }) => ({
  id: recId('DEL' + n),
  fields: {
    ScheduledEmailJobId: JOB_ID,
    RecipientEmail: email,
    DeliveryKey: key64('abc' + n),
    CustomerRecordId: recId('CUS' + n),
    CampaignType: 'expired-comeback:v2',
    EmailType: 'campaign',
    Status: status,
  },
});

/** 送信対象 1 名ぶんの正常な fixture（配信行が無いと delivery_not_found で落ちる） */
const oneRecipientFixture = () => ({
  scheduled: [job({ Content: CONTENT })],
  customers: [{ id: recId('CUS1'), fields: { Email: 'a@example.com', 'プラン': 'Free' } }],
  deliveries: [deliveryRow({ email: 'a@example.com', n: '1' })],
});

test('【重要】同一 jobId の live を同時に 2 本開始しても、送信へ入るのは 1 本だけ', async () => {
  // 2 本が同じ Redis を見る（実運用と同じ）
  const store = new Map(); const counters = { fence: 0 };
  const shared = makeFakeRedis(store, counters);

  // 1 本目が送信 API を叩いている**最中に** 2 本目を開始する
  let second = null;
  const calls = stub({
    ...oneRecipientFixture(),
    redis: shared,
    onSend: async () => {
      if (!second) {
        second = invoke({ dryRun: false, jobId: JOB_ID, expectedWillSend: 1 }, LIVE_ENV);
        await second.catch(() => {});
      }
    },
  });

  const first = await invoke({ dryRun: false, jobId: JOB_ID, expectedWillSend: 1 }, LIVE_ENV);
  const other = await second;

  assert.equal(first.statusCode, 200, `1 本目が通っていない: ${JSON.stringify(first.body).slice(0, 200)}`);
  assert.equal(other.statusCode, 409, '2 本目が止まっていない');
  assert.equal(other.body.code, 'busy', `明示的に busy と言っていない: ${JSON.stringify(other.body)}`);
  assert.equal(other.body.sideEffects, 'none');
  // 送信は 1 通だけ（2 本目は 1 通も送っていない）
  assert.equal(calls.sendgridSend, 1, `二重送信している（${calls.sendgridSend} 通）`);
});

test('【重要】2 本目は送信も書き込みもしない', async () => {
  const store = new Map(); const shared = makeFakeRedis(store, { fence: 0 });
  // 先に鍵を埋めておく（＝他実行が処理中の状態）
  store.set('ak:marketing-dispatch:lock:' + JOB_ID, '999');
  const calls = stub({ scheduled: [job()], redis: shared });
  const { statusCode, body } = await invoke({ dryRun: false, jobId: JOB_ID, expectedWillSend: 1 }, LIVE_ENV);
  assert.equal(statusCode, 409);
  assert.equal(body.code, 'busy');
  assert.equal(calls.sendgridSend, 0, '送信している');
  assert.equal(calls.airtableWrites, 0, '書き込んでいる');
});

test('【重要】異なる jobId は互いを塞がない', async () => {
  const store = new Map(); const shared = makeFakeRedis(store, { fence: 0 });
  // 別ジョブの鍵が埋まっていても、こちらは通る
  store.set('ak:marketing-dispatch:lock:mkt-other-v1-zzz-1', '1');
  const calls = stub({ ...oneRecipientFixture(), redis: shared });
  const { statusCode, body } = await invoke({ dryRun: false, jobId: JOB_ID, expectedWillSend: 1 }, LIVE_ENV);
  assert.equal(statusCode, 200, '別ジョブの鍵で塞がれている');
  assert.equal(calls.sendgridSend, 1, `送信していない: ${JSON.stringify(body).slice(0, 400)}`);
});

test('【重要】Redis へ到達できなければ送信 0（fail closed）', async () => {
  const calls = stub({
    scheduled: [job()],
    redis: () => { throw new Error('unreachable'); },
  });
  const { statusCode, body } = await invoke({ dryRun: false, jobId: JOB_ID, expectedWillSend: 1 }, LIVE_ENV);
  assert.equal(statusCode, 503);
  assert.equal(body.sideEffects, 'none');
  assert.equal(calls.sendgridSend, 0, '排他が確認できないのに送信した');
  assert.equal(calls.airtableWrites, 0);
});

test('【重要】Redis が設定されていなければ送信 0（排他できないなら送らない）', async () => {
  const calls = stub(oneRecipientFixture());
  process.env.PREMIUM_PLUS_ADMIN_SECRET = SECRET;
  process.env.AIRTABLE_API_KEY = 'test-key';
  process.env.AIRTABLE_BASE_ID = 'appTEST';
  process.env.SENDGRID_API_KEY = 'SG.test';
  process.env.MARKETING_CAMPAIGN_DISPATCH_ENABLED = 'true';
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const mod = await import('../../../netlify/functions/marketing-campaign-dispatch.js');
  const res = await mod.handler({
    httpMethod: 'POST', headers: { 'x-admin-secret': SECRET },
    body: JSON.stringify({ dryRun: false, jobId: JOB_ID, expectedWillSend: 1 }),
  });
  const body = JSON.parse(res.body || '{}');
  assert.equal(res.statusCode, 503, '排他が無いのに送信へ進んでいる');
  assert.equal(body.sideEffects, 'none');
  assert.equal(calls.sendgridSend, 0);
  assert.equal(calls.airtableWrites, 0);
});

test('【重要】送信直前に鍵を奪われていたら 1 通も送らない', async () => {
  const store = new Map(); const shared = makeFakeRedis(store, { fence: 0 });
  const calls = stub({
    ...oneRecipientFixture(),
    redis: (args) => {
      const op = String(args[0]).toUpperCase();
      // 取得は通すが、verify の直前に別実行の token へ差し替える
      if (op === 'EVAL' && String(args[1]).includes("return 'OK'") && !String(args[1]).includes('DEL')) {
        store.set(args[3], 'stolen-by-another-run');
      }
      return shared(args);
    },
  });
  const { statusCode, body } = await invoke({ dryRun: false, jobId: JOB_ID, expectedWillSend: 1 }, LIVE_ENV);
  assert.equal(statusCode, 409, '奪われているのに送っている');
  assert.equal(body.code, 'stolen');
  assert.equal(calls.sendgridSend, 0, '1 通でも送っている');
});

test('【重要】dryRun は鍵を取らない（副作用なし・何本走ってもよい）', async () => {
  const store = new Map(); const shared = makeFakeRedis(store, { fence: 0 });
  const calls = stub({ scheduled: [job()], redis: shared });
  const a = await invoke({ dryRun: true }, LIVE_ENV);
  const b = await invoke({ dryRun: true }, LIVE_ENV);
  assert.equal(a.statusCode, 200);
  assert.equal(b.statusCode, 200, 'dryRun 同士が塞ぎ合っている');
  assert.equal(a.body.sideEffects, 'none');
  assert.equal(calls.sendgridSend, 0);
  assert.equal(calls.airtableWrites, 0);
  assert.equal(store.size, 0, 'dryRun で鍵を作っている');
});

test('【重要】逐次再実行では既送信者を再送しない（従来の冪等性を維持）', async () => {
  const store = new Map(); const shared = makeFakeRedis(store, { fence: 0 });
  const calls = stub({
    scheduled: [job({ Recipients: 'a@example.com, b@example.com', RecipientCount: 2, Content: CONTENT })],
    customers: [
      { id: recId('CUS1'), fields: { Email: 'a@example.com', 'プラン': 'Free' } },
      { id: recId('CUS2'), fields: { Email: 'b@example.com', 'プラン': 'Free' } },
    ],
    // a は既に送信済み / b はこれから
    deliveries: [
      deliveryRow({ email: 'a@example.com', status: 'sent', n: '1' }),
      deliveryRow({ email: 'b@example.com', status: 'queued', n: '2' }),
    ],
    redis: shared,
  });
  const { statusCode, body } = await invoke({ dryRun: false, jobId: JOB_ID, expectedWillSend: 1 }, LIVE_ENV);
  assert.equal(statusCode, 200, JSON.stringify(body).slice(0, 250));
  assert.equal(calls.sendgridSend, 1, '既送信者へ再送している');
  assert.equal(body.sent, 1);
});

test('【重要】途中失敗のあと再実行すると、残りだけ処理し、鍵は解放される', async () => {
  const store = new Map(); const shared = makeFakeRedis(store, { fence: 0 });
  const calls = stub({
    scheduled: [job({ Recipients: 'a@example.com, b@example.com', RecipientCount: 2, Content: CONTENT })],
    customers: [
      { id: recId('CUS1'), fields: { Email: 'a@example.com', 'プラン': 'Free' } },
      { id: recId('CUS2'), fields: { Email: 'b@example.com', 'プラン': 'Free' } },
    ],
    // 1 通目で落ちた後の状態（a=sent / b=queued のまま）
    deliveries: [
      deliveryRow({ email: 'a@example.com', status: 'sent', n: '1' }),
      deliveryRow({ email: 'b@example.com', status: 'queued', n: '2' }),
    ],
    redis: shared,
  });
  const { statusCode, body } = await invoke({ dryRun: false, jobId: JOB_ID, expectedWillSend: 1 }, LIVE_ENV);
  assert.equal(statusCode, 200, JSON.stringify(body).slice(0, 250));
  assert.equal(calls.sendgridSend, 1, '残り 1 通だけを送っていない');
  assert.equal(body.sent, 1);
  // 実行が終われば鍵は解放されている（次の再実行が塞がれない）
  assert.equal(store.size, 0, '鍵を解放していない');
});

// ══════════════════════════════════════════════════════════════
//  ロック解放の可否を応答へ明示する（2026-08-15）
//
//  ⚠️ **解放の失敗を「送信の失敗」にしてはいけない。** メールは既に出ている。
//     `sent` を 0 へ巻き戻すと運用者は「送れていない」と読んで**もう一度送る**。
//     事実（送信結果）はそのまま返し、解放の可否は別の欄に載せる。
//  ⚠️ 同時に、握り潰すのも駄目。鍵が残っている間は再実行が busy で弾かれるので、
//     **TTL が切れるまで再実行しない**ことを明示する。
// ══════════════════════════════════════════════════════════════

test('【重要】送信成功 + 解放成功 → sent=1 / lockRelease.ok=true', async () => {
  const store = new Map(); const shared = makeFakeRedis(store, { fence: 0 });
  const calls = stub({ ...oneRecipientFixture(), redis: shared });
  const { statusCode, body } = await invoke({ dryRun: false, jobId: JOB_ID, expectedWillSend: 1 }, LIVE_ENV);
  assert.equal(statusCode, 200);
  assert.equal(body.sent, 1);
  assert.equal(calls.sendgridSend, 1);
  assert.deepEqual(body.lockRelease, { ok: true, reason: null });
  assert.equal(body.warning, undefined, '正常時に警告を出している');
  assert.equal(store.size, 0, '鍵が残っている');
});

test('【重要】送信成功 + 解放失敗 → sent は 1 のまま / lockRelease.ok=false / 警告あり', async () => {
  const store = new Map();
  const base = makeFakeRedis(store, { fence: 0 });
  const calls = stub({
    ...oneRecipientFixture(),
    redis: (args) => {
      // 解放（DEL を含む Lua）だけを失敗させる
      if (String(args[0]).toUpperCase() === 'EVAL' && String(args[1]).includes("redis.call('DEL'")) {
        throw new Error('release boom');
      }
      return base(args);
    },
  });
  const { statusCode, body } = await invoke({ dryRun: false, jobId: JOB_ID, expectedWillSend: 1 }, LIVE_ENV);

  // 送信の事実は**巻き戻さない**
  assert.equal(statusCode, 200, '解放失敗を送信失敗にしている');
  assert.equal(body.sent, 1, '送信済み件数を巻き戻している');
  assert.equal(body.failed, 0);
  assert.equal(calls.sendgridSend, 1);

  // 解放の可否は別の欄で明示する
  assert.equal(body.lockRelease.ok, false);
  assert.equal(typeof body.lockRelease.reason, 'string');
  assert.equal(body.lockRelease.retryAfterSec, 300);
  assert.match(body.warning, /1 通の送信処理は完了していますが/);
  assert.match(body.warning, /解放できませんでした/);
  assert.match(body.warning, /自動で再実行しないでください/);
  // 送っていないのに「送信は行われていない」とは書かない
  assert.equal(/メール送信は行われていません/.test(body.warning), false);

  // secret / URL / token を漏らさない
  const dump = JSON.stringify(body);
  assert.equal(/fake-token|fake-redis\.local|UPSTASH/.test(dump), false, '接続情報が応答に出ている');
});

test('【重要】解放失敗のあと即時 2 回目を叩くと busy で送信 0', async () => {
  const store = new Map();
  const base = makeFakeRedis(store, { fence: 0 });
  const redis = (args) => {
    if (String(args[0]).toUpperCase() === 'EVAL' && String(args[1]).includes("redis.call('DEL'")) {
      throw new Error('release boom');
    }
    return base(args);
  };
  const calls = stub({ ...oneRecipientFixture(), redis });
  const first = await invoke({ dryRun: false, jobId: JOB_ID, expectedWillSend: 1 }, LIVE_ENV);
  assert.equal(first.body.sent, 1);
  assert.equal(first.body.lockRelease.ok, false);

  // 鍵が残っているので 2 回目は弾かれる（＝二重送信にならない）
  const second = await invoke({ dryRun: false, jobId: JOB_ID, expectedWillSend: 1 }, LIVE_ENV);
  assert.equal(second.statusCode, 409);
  assert.equal(second.body.code, 'busy');
  assert.equal(calls.sendgridSend, 1, '2 回目が送信している');
});

test('【重要】TTL で鍵が消えた後も、既送信者は再送しない（最後の砦は sent 判定）', async () => {
  const store = new Map(); const shared = makeFakeRedis(store, { fence: 0 });
  const calls = stub({
    ...oneRecipientFixture(),
    // 前回の実行で送信済み（配信行が sent）
    deliveries: [deliveryRow({ email: 'a@example.com', status: 'sent', n: '1' })],
    redis: shared,
  });
  // 鍵は TTL で消えている状態（store が空）＝ロックは取れる
  const { statusCode, body } = await invoke({ dryRun: false, jobId: JOB_ID, expectedWillSend: 0 }, LIVE_ENV);
  assert.equal(statusCode, 200, JSON.stringify(body).slice(0, 200));
  assert.equal(calls.sendgridSend, 0, 'TTL 明けに既送信者へ再送している');
  assert.equal(body.lockRelease.ok, true);
});

test('解放処理そのものが例外でも、送信結果を失わない', async () => {
  const store = new Map(); const base = makeFakeRedis(store, { fence: 0 });
  const calls = stub({
    ...oneRecipientFixture(),
    redis: (args) => {
      if (String(args[0]).toUpperCase() === 'EVAL' && String(args[1]).includes("redis.call('DEL'")) {
        throw new Error('unreachable');
      }
      return base(args);
    },
  });
  const { statusCode, body } = await invoke({ dryRun: false, jobId: JOB_ID, expectedWillSend: 1 }, LIVE_ENV);
  assert.equal(statusCode, 200);
  assert.equal(body.sent, 1);
  assert.equal(calls.sendgridSend, 1);
  assert.equal(body.lockRelease.ok, false);
  assert.ok(body.warning);
});

test('dryRun の応答には lockRelease を足さない（鍵を取っていない）', async () => {
  const calls = stub({ ...oneRecipientFixture() });
  const { statusCode, body } = await invoke({ dryRun: true }, LIVE_ENV);
  assert.equal(statusCode, 200);
  assert.equal(body.lockRelease, undefined);
  assert.equal(calls.sendgridSend, 0);
});

// ── 解放失敗時の文言は「実際に送ったか」に合わせる（2026-08-15）──────
//
// dispatch は送信前に 409（人数不一致・鍵の奪取）や 503 で止まることがある。
// その場合 `sent` は 0 なのに「送信は完了しています」と書くと、運用者は
// 「送れたのに解放だけ失敗した」と誤解する（逆方向の事故）。

/** 解放だけを失敗させる Redis（取得・verify は通す） */
const releaseFailingRedis = (store) => {
  const base = makeFakeRedis(store, { fence: 0 });
  return (args) => {
    if (String(args[0]).toUpperCase() === 'EVAL' && String(args[1]).includes("redis.call('DEL'")) {
      throw new Error('release boom');
    }
    return base(args);
  };
};

test('【重要】送信 0 の 409 + 解放失敗 → 「送信は行われていない」と書く', async () => {
  const store = new Map();
  const calls = stub({ ...oneRecipientFixture(), redis: releaseFailingRedis(store) });
  // 確認した人数と食い違わせて、送信前に 409 で止める
  const { statusCode, body } = await invoke({ dryRun: false, jobId: JOB_ID, expectedWillSend: 99 }, LIVE_ENV);

  assert.equal(statusCode, 409, '前提が崩れている');
  assert.equal(calls.sendgridSend, 0, '止まったのに送信している');
  // 元の結果は書き換えない
  assert.equal(body.sideEffects, 'none', '元の sideEffects を書き換えている');
  assert.equal(body.expected, 99);
  // 文言は事実どおり
  assert.equal(body.lockRelease.ok, false);
  assert.equal(body.lockRelease.retryAfterSec, 300);
  assert.match(body.warning, /メール送信は行われていません/);
  assert.equal(/送信処理は完了していますが/.test(body.warning), false, '送っていないのに完了と書いている');
  assert.match(body.warning, /自動で再実行しないでください/);
});

test('【重要】送信 0 の 503（鍵を奪われた）+ 解放失敗 → 「送信は行われていない」と書く', async () => {
  const store = new Map();
  const base = makeFakeRedis(store, { fence: 0 });
  const calls = stub({
    ...oneRecipientFixture(),
    redis: (args) => {
      const op = String(args[0]).toUpperCase();
      // verify の直前に別実行の token へ差し替える → 送信前に 409 で止まる
      if (op === 'EVAL' && String(args[1]).includes("return 'OK'") && !String(args[1]).includes('DEL')) {
        store.set(args[3], 'stolen-by-another-run');
      }
      // 解放は失敗させる
      if (op === 'EVAL' && String(args[1]).includes("redis.call('DEL'")) throw new Error('release boom');
      return base(args);
    },
  });
  const { statusCode, body } = await invoke({ dryRun: false, jobId: JOB_ID, expectedWillSend: 1 }, LIVE_ENV);

  assert.equal(statusCode, 409);
  assert.equal(body.code, 'stolen');
  assert.equal(calls.sendgridSend, 0);
  assert.equal(body.sideEffects, 'none');
  assert.match(body.warning, /メール送信は行われていません/);
  assert.equal(/送信処理は完了していますが/.test(body.warning), false);
});

test('【重要】解放失敗の文言に接続情報を混ぜない', async () => {
  const store = new Map();
  stub({ ...oneRecipientFixture(), redis: releaseFailingRedis(store) });
  const { body } = await invoke({ dryRun: false, jobId: JOB_ID, expectedWillSend: 1 }, LIVE_ENV);
  const dump = JSON.stringify(body);
  for (const bad of ['fake-token', 'fake-redis.local', 'UPSTASH', 'Bearer']) {
    assert.equal(dump.includes(bad), false, `${bad} が応答に出ている`);
  }
});

test('解放失敗でも元の statusCode / sent / failed / skipped を書き換えない', async () => {
  const store = new Map();
  const calls = stub({ ...oneRecipientFixture(), redis: releaseFailingRedis(store) });
  const { statusCode, body } = await invoke({ dryRun: false, jobId: JOB_ID, expectedWillSend: 1 }, LIVE_ENV);
  assert.equal(statusCode, 200);
  assert.equal(body.sent, 1);
  assert.equal(body.failed, 0);
  assert.equal(body.skipped, 0);
  assert.equal(calls.sendgridSend, 1);
  assert.equal(body.mode, 'live');
});
