/**
 * adminMarketingHandler.smoke.test.mjs — admin-marketing の**ハンドラを実際に呼ぶ**煙試験。
 *
 * ── なぜ要るか ────────────────────────────────────────────────
 * ソース検査の guard は「何が書かれているか」しか見ない。
 * import 漏れのような**実行して初めて落ちる欠陥**は素通りし、本番で 500 になる。
 * 実際に 2026-08-02、`isMarketingJob` の import 漏れで `jobs` が本番 500 になった。
 * ここでは fetch を差し替えて**ネットワークなしでハンドラを起動**し、
 * 主要 action が 200 を返すことを確かめる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const SECRET = 'test-admin-secret';

/** Airtable / SendGrid への呼び出しを差し替える（**実 I/O を一切行わない**） */
function stubFetch(routes = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET' });
    if (/api\.sendgrid\.com/.test(u)) {
      // 送信 API を叩いたら試験を落とす（admin は送信経路を持たない）
      throw new Error('admin must not call SendGrid');
    }
    for (const [pattern, body] of Object.entries(routes)) {
      if (u.includes(pattern)) {
        return { ok: true, status: 200, json: async () => body };
      }
    }
    return { ok: true, status: 200, json: async () => ({ records: [] }) };
  };
  return calls;
}

async function invoke(payload) {
  process.env.PREMIUM_PLUS_ADMIN_SECRET = SECRET;
  process.env.AIRTABLE_API_KEY = 'test-key';
  process.env.AIRTABLE_BASE_ID = 'appTEST';
  const mod = await import('../../../netlify/functions/admin-marketing.js');
  const res = await mod.handler({
    httpMethod: 'POST',
    headers: { 'x-admin-secret': SECRET },
    body: JSON.stringify(payload),
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body || '{}') };
}

const JOB_ID = 'mkt-marketing-canary-v2-abc12345-1';
const scheduledRecords = {
  records: [{
    id: 'recJOB0000000001',
    fields: {
      JobId: JOB_ID, Status: 'PENDING', ScheduledFor: '2026-08-02T00:00:00.000Z',
      RecipientCount: 1, TargetPlan: 'campaign:marketing-canary', CreatedBy: 'admin-marketing',
      Notes: 'marketing campaign marketing-canary v2',
    },
  }],
};
const deliveryRecords = {
  records: [{
    id: 'recDEL0000000001',
    fields: {
      ScheduledEmailJobId: JOB_ID, EmailType: 'campaign', CampaignType: 'marketing-canary:v2',
      Status: 'queued', QueuedAt: '2026-08-02T00:00:00.000Z',
    },
  }],
};

test('smoke: jobs は 200 を返し、ジョブ一覧を組み立てられる（import 漏れを検知）', async () => {
  stubFetch({ ScheduledEmails: scheduledRecords, CampaignDeliveries: deliveryRecords });
  const { statusCode, body } = await invoke({ action: 'jobs' });
  assert.equal(statusCode, 200, `jobs が ${statusCode} を返した: ${JSON.stringify(body).slice(0, 160)}`);
  assert.equal(Array.isArray(body.jobs), true);
  assert.equal(body.jobs.length, 1, 'マーケティングジョブを組み立てられていない');
  assert.equal(body.jobs[0].campaignId, 'marketing-canary');
  assert.equal(body.jobs[0].cancelable, true);
  assert.equal(typeof body.sendEnabled, 'boolean');
  assert.equal(typeof body.dispatchEnabled, 'boolean');
});

test('smoke: jobs の応答にメールアドレスを載せない', async () => {
  stubFetch({ ScheduledEmails: scheduledRecords, CampaignDeliveries: deliveryRecords });
  const { body } = await invoke({ action: 'jobs' });
  assert.equal(/@[a-z0-9.-]+\.[a-z]{2,}/i.test(JSON.stringify(body)), false, '応答にアドレスが含まれる');
});

test('smoke: cancelJob は operationId が無ければ 400（書き込みに到達しない）', async () => {
  const calls = stubFetch({ ScheduledEmails: scheduledRecords });
  const { statusCode } = await invoke({ action: 'cancelJob', jobId: JOB_ID });
  assert.equal(statusCode, 400);
  assert.equal(calls.some((c) => c.method === 'PATCH'), false, '検証前に書き込んでいる');
});

test('smoke: cancelJob は SENT のジョブを 409 で拒否する（送信済みを取り消さない）', async () => {
  const sent = { records: [{ ...scheduledRecords.records[0], fields: { ...scheduledRecords.records[0].fields, Status: 'SENT' } }] };
  const calls = stubFetch({ ScheduledEmails: sent });
  const { statusCode, body } = await invoke({ action: 'cancelJob', jobId: JOB_ID, operationId: 'op-1' });
  assert.equal(statusCode, 409);
  assert.equal(body.reason, 'already_sent');
  assert.equal(calls.some((c) => c.method === 'PATCH'), false, '送信済みジョブへ書き込んでいる');
});

test('smoke: cancelJob（PENDING）は queued の配信行とジョブだけを PATCH する', async () => {
  const calls = stubFetch({ ScheduledEmails: scheduledRecords, CampaignDeliveries: deliveryRecords });
  const { statusCode, body } = await invoke({ action: 'cancelJob', jobId: JOB_ID, operationId: 'op-2' });
  assert.equal(statusCode, 200);
  assert.equal(body.cancelled, true);
  assert.equal(body.cancelledDeliveries, 1);
  const patches = calls.filter((c) => c.method === 'PATCH');
  assert.equal(patches.length, 2, '想定外の書き込みがある');
  assert.equal(patches.some((c) => c.url.includes('Customers')), false, 'Customers を書き換えている');
});

test('smoke: 認証が無ければ 403（誰でも叩けない）', async () => {
  stubFetch({});
  process.env.PREMIUM_PLUS_ADMIN_SECRET = SECRET;
  const mod = await import('../../../netlify/functions/admin-marketing.js');
  const res = await mod.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ action: 'jobs' }) });
  assert.equal(res.statusCode, 403);
});
