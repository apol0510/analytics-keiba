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
function stub({ scheduled = [], deliveries = [], customers = [], suppression = true } = {}) {
  const calls = { sendgridSend: 0, airtableWrites: 0, urls: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    calls.urls.push(method + ' ' + u.split('?')[0]);
    if (u.includes('api.sendgrid.com/v3/mail/send')) { calls.sendgridSend += 1; return { ok: true, status: 202 }; }
    if (u.includes('api.sendgrid.com/v3/suppression')) {
      return suppression ? { ok: true, status: 200, json: async () => [] } : { ok: false, status: 401, json: async () => ({}) };
    }
    if (u.includes('api.sendgrid.com')) return { ok: true, status: 200, json: async () => [] };
    if (u.includes('api.airtable.com')) {
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
    Notes: 'marketing campaign expired-comeback v2', ...over,
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
