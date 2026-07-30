/**
 * sharedExecutorMarketingSkip.test.mjs — 共有 executor が marketing job を送らないことの統合検証
 *   node --test src/lib/marketing/sharedExecutorMarketingSkip.test.mjs
 *
 * 実際の `execute-scheduled-emails-background` handler を、fetch を差し替えた偽 Airtable /
 * 偽 SendGrid に対して動かす。ネットワークにも本番にも触れない。
 *
 * 守る性質（2026-07-30 恒久化）:
 *   マーケティングジョブの**唯一の実送信経路は marketing-campaign-dispatch**。
 *   共有 executor は env の組み合わせに関係なく常に skip し、レコードの状態も変えない。
 *   非 marketing ジョブ（newsletter / step / race_main / expiry）の挙動は変えない。
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import handler from '../../../netlify/functions/execute-scheduled-emails-background.js';

const ENV_KEYS = ['NEWSLETTER_AUTOMATION_ENABLED', 'MARKETING_CAMPAIGN_DISPATCH_ENABLED',
  'MARKETING_CAMPAIGN_ENABLED', 'AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID', 'SENDGRID_API_KEY'];
const savedEnv = {};
let realFetch;
let store;

/** ScheduledEmails の偽レコード */
const job = (id, fields) => ({
  id,
  fields: {
    Subject: '件名', Content: '<p>本文</p>', Recipients: 'a@example.com',
    ScheduledFor: new Date(Date.now() - 60000).toISOString(), Status: 'PENDING',
    ...fields,
  },
});

function res(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function install(scheduled) {
  store = { scheduled, writes: [], mailSends: [], patched: [] };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (u.includes('api.sendgrid.com')) {
      store.mailSends.push(u);            // 実送信されたら記録（テストで検出）
      return res({}, 202);
    }
    if (u.includes('api.airtable.com')) {
      if (method !== 'GET') {
        store.writes.push({ url: u, method });
        if (u.includes('/ScheduledEmails')) store.patched.push(JSON.parse(init.body || '{}'));
        return res({ records: [] });
      }
      if (u.includes('/ScheduledEmails')) return res({ records: store.scheduled });
      if (u.includes('/EmailBlacklist')) return res({ records: [] });
      if (u.includes('/Customers')) return res({ records: [] });
      return res({ records: [] });
    }
    throw new Error(`想定外の外部通信: ${u}`);
  };
}

const run = () => handler(new Request('https://example.com/.netlify/functions/execute-scheduled-emails-background', { method: 'POST' }));

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.AIRTABLE_API_KEY = 'fake';
  process.env.AIRTABLE_BASE_ID = 'appFAKE';
  process.env.SENDGRID_API_KEY = 'fake';
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

/** マーケティングジョブ 3 種（識別の目印ごと） */
const MARKETING_JOBS = [
  job('se-mk1', { CreatedBy: 'admin-marketing', JobId: 'mkt-a-v1-x-1' }),
  job('se-mk2', { TargetPlan: 'campaign:marketing-canary', JobId: 'j2' }),
  job('se-mk3', { JobId: 'mkt-b-v1-y-1', CreatedBy: 'someone' }),
];

// ── A / B / C: env のどの組み合わせでも marketing job は送信 0 ────────────
const CASES = [
  ['A', { NEWSLETTER_AUTOMATION_ENABLED: 'true', MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true' }],
  ['B', { NEWSLETTER_AUTOMATION_ENABLED: 'true', MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'false' }],
  ['C', { NEWSLETTER_AUTOMATION_ENABLED: 'false', MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true' }],
];

for (const [label, env] of CASES) {
  test(`【${label}】newsletter=${env.NEWSLETTER_AUTOMATION_ENABLED} / dispatch=${env.MARKETING_CAMPAIGN_DISPATCH_ENABLED} → 共有 executor から marketing job は送信 0`, async () => {
    Object.assign(process.env, env);
    install([...MARKETING_JOBS]);
    await run();
    assert.equal(store.mailSends.length, 0, `${label}: 実送信が発生している`);
    assert.equal(store.patched.length, 0, `${label}: ScheduledEmails を書き換えている`);
    // レコードは PENDING のまま
    for (const j of store.scheduled) assert.equal(j.fields.Status, 'PENDING');
  });
}

test('【A】marketing job と 非 marketing job が混在しても、marketing だけが止まる', async () => {
  process.env.NEWSLETTER_AUTOMATION_ENABLED = 'true';
  process.env.MARKETING_CAMPAIGN_DISPATCH_ENABLED = 'true';
  install([...MARKETING_JOBS, job('se-nl', { CreatedBy: 'newsletter', JobId: 'nl-1' })]);
  await run();
  // 非 marketing は従来どおり処理されるので SendGrid へ到達する
  assert.ok(store.mailSends.length > 0, '非 marketing ジョブまで止まっている');
  // 送信されたのは 1 通（非 marketing の 1 宛先）だけ
  assert.equal(store.mailSends.length, 1, 'marketing ジョブが送信されている');
});

// ── D / E: 非 marketing ジョブの挙動は不変 ────────────────────────────
test('【D】通常 newsletter ジョブは既存条件どおり処理される', async () => {
  process.env.NEWSLETTER_AUTOMATION_ENABLED = 'true';
  install([job('se-nl', { CreatedBy: 'newsletter', JobId: 'nl-1' })]);
  await run();
  assert.equal(store.mailSends.length, 1, 'newsletter ジョブが送信されていない');
});

test('【D】NEWSLETTER_AUTOMATION_ENABLED != true なら従来どおり全体が no-op', async () => {
  process.env.NEWSLETTER_AUTOMATION_ENABLED = 'false';
  install([job('se-nl', { CreatedBy: 'newsletter', JobId: 'nl-1' })]);
  const r = await run();
  const body = await r.json();
  assert.equal(body.skipped, true);
  assert.equal(body.flag, 'NEWSLETTER_AUTOMATION_ENABLED');
  assert.equal(store.mailSends.length, 0);
  assert.equal(store.writes.length, 0, 'Airtable へ到達している');
});

test('【E】step / race_main 系のジョブを壊さない', async () => {
  process.env.NEWSLETTER_AUTOMATION_ENABLED = 'true';
  process.env.MARKETING_CAMPAIGN_DISPATCH_ENABLED = 'true';
  install([
    job('se-step', { CreatedBy: 'step-enqueue', JobId: 'step-seq-1' }),
    job('se-race', { CreatedBy: 'race-main', JobId: 'race-1' }),
    job('se-exp', { CreatedBy: 'expiry-notification', JobId: 'exp-1' }),
  ]);
  await run();
  assert.equal(store.mailSends.length, 3, 'step / race_main / expiry のいずれかが止まっている');
});

// ── G: Customers write 0 ──────────────────────────────────────────
test('【G】共有 executor は Customers を書き換えない', async () => {
  process.env.NEWSLETTER_AUTOMATION_ENABLED = 'true';
  process.env.MARKETING_CAMPAIGN_DISPATCH_ENABLED = 'true';
  install([...MARKETING_JOBS, job('se-nl', { CreatedBy: 'newsletter', JobId: 'nl-1' })]);
  await run();
  const customerWrites = store.writes.filter((w) => w.url.includes('/Customers'));
  assert.equal(customerWrites.length, 0, 'Customers へ書き込んでいる');
});
