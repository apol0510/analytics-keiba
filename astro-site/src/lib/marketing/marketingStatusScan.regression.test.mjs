/**
 * marketingStatusScan.regression.test.mjs — 台帳が 4,000 行を超えても取りこぼさない
 *   node --test src/lib/marketing/marketingStatusScan.regression.test.mjs
 *
 * ── 再現する事故（2026-08-15 本番）────────────────────────────
 * `CampaignDeliveries` が 6,110 行になった時点で、`admin-marketing` の
 * `fetchAll`（`MAX_PAGES=40` で **break**）が台帳を 4,000 行で打ち切っていた。
 * その結果 Step1 を 10 名ぶんキュー登録した直後に、
 *
 *   - `sequence` … 「送信済み 1 名 / 残り 9 名」（実際は 10 名とも queued）
 *   - `jobs`     … ジョブの配信件数が 1（実際は 10）
 *
 * と**過少表示**した。運用者が「まだ 9 名残っている」と誤読する。
 *
 * ここでは fetch を差し替えた偽 Airtable に **6,110 行の台帳**を持たせ、
 * ハンドラを実際に起動して「10 名を 10 名として数える」ことを確かめる。
 * 全件走査へ落ちた場合は偽サーバー側が検知してテストを落とす。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeCampaignDeliveryKey } from './campaignSend.js';
import { getCampaign } from './campaignCatalog.js';
import { resolveSequenceStep } from './campaignSequence.js';
import { getBrandConfig } from '../newsletter/brand-config.js';

const SECRET = 'test-admin-secret';
const BRAND = 'analytics-keiba';
const CAMPAIGN_ID = 'light-trial-to-premium-sequence';
const JOB_ID = 'mkt-light-trial-to-premium-sequence-v1-af3acf8c-1';
/** 本番と同じ規模。4,000 行の打ち切り境界を確実に越える */
const LEDGER_ROWS = 6110;

const FROM = getBrandConfig(BRAND).defaultFromEmail;
const STEP1 = resolveSequenceStep(getCampaign(CAMPAIGN_ID, { includeDisabled: true }), 1);

/** 付与済み・コホート内の 10 名（本番の 10 名と同じ形） */
const PEOPLE = Array.from({ length: 10 }, (_, i) => ({
  id: `recCUST${String(i).padStart(9, '0')}`,
  email: `member${i}@example.com`,
}));

const customerRecords = PEOPLE.map((p) => ({
  id: p.id,
  fields: {
    Email: p.email,
    プラン: 'Free',
    Source: 'customer-import:imp-2026-08-09-001',
    LightGrantOp: 'light-trial-2026-08-13',
    LightGrantedAt: '2026-08-13T01:30:00.000Z',
    LightGrantUntil: '2026-09-12T01:30:00.000Z',
    ComebackGrantSource: 'light-trial-autogrant',
  },
}));

/** 10 名ぶんの Step1 配信行（キューに載った事実） */
const step1DeliveryRows = PEOPLE.map((p, i) => ({
  id: `recDEL${String(i).padStart(10, '0')}`,
  fields: {
    DeliveryKey: computeCampaignDeliveryKey({
      campaign: STEP1, recipientEmail: p.email, brand: BRAND, fromEmail: FROM,
    }),
    CampaignType: `${CAMPAIGN_ID}:v1`,
    EmailType: 'campaign',
    RecipientEmail: p.email,
    CustomerRecordId: p.id,
    Status: 'queued',
    QueuedAt: '2026-08-14T22:30:19.408Z',
    ScheduledEmailJobId: JOB_ID,
  },
}));

const scheduledRows = [{
  id: 'recJOB0000000001',
  fields: {
    JobId: JOB_ID, Status: 'PENDING', ScheduledFor: '2026-08-14T22:30:19.408Z',
    RecipientCount: 10, TargetPlan: `campaign:${CAMPAIGN_ID}`, CreatedBy: 'admin-marketing',
    Notes: `marketing campaign ${CAMPAIGN_ID} v1`,
  },
}];

/**
 * 偽 Airtable。**全件走査を検知する**のが肝。
 * `CampaignDeliveries` を絞り込み無し（= `{EmailType}='campaign'` だけ）で読みに来たら
 * 6,110 行をページングで返す（＝旧実装なら 40 ページで打ち切られる）。
 */
function stubAirtable({ onFullScan } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (/api\.sendgrid\.com/.test(u)) throw new Error('admin must not call SendGrid');
    const body = init.body ? String(init.body) : '';
    const formula = method === 'POST'
      ? (JSON.parse(body || '{}').filterByFormula || '')
      : (new URL(u).searchParams.get('filterByFormula') || '');
    calls.push({ url: u, method, formula });

    if (u.includes('/Customers')) return ok({ records: customerRecords });
    if (u.includes('/EmailBlacklist')) return ok({ records: [] });

    if (u.includes('/ScheduledEmails')) {
      if (!formula) throw new Error('ScheduledEmails を絞り込み無しで読んでいる');
      return ok({ records: scheduledRows });
    }

    if (u.includes('/CampaignDeliveries')) {
      // 名指し（JobId / RecipientEmail / DeliveryKey）なら該当行だけ返す
      if (/ScheduledEmailJobId|RecipientEmail|DeliveryKey/.test(formula)) {
        return ok({ records: step1DeliveryRows });
      }
      // 全件走査に落ちた = 直したはずの経路が復活している
      if (onFullScan) return onFullScan(u);
      throw new Error(`CampaignDeliveries を全件走査している: ${formula}`);
    }
    return ok({ records: [] });
  };
  return calls;
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

/** 6,110 行をページングで返す（100 行/ページ = 62 ページ） */
function paginatedLedger(url) {
  const page = Number(new URL(url).searchParams.get('offset') || 0);
  const start = page * 100;
  const records = Array.from({ length: Math.min(100, LEDGER_ROWS - start) }, (_, i) => ({
    id: `recOLD${String(start + i).padStart(10, '0')}`,
    fields: { EmailType: 'campaign', CampaignType: 'dormant-reactivation:v2', Status: 'sent' },
  }));
  const next = start + 100 < LEDGER_ROWS ? String(page + 1) : undefined;
  return ok(next ? { records, offset: next } : { records });
}

async function invoke(payload) {
  process.env.PREMIUM_PLUS_ADMIN_SECRET = SECRET;
  process.env.AIRTABLE_API_KEY = 'test-key';
  process.env.AIRTABLE_BASE_ID = 'appTEST';
  delete process.env.SENDGRID_API_KEY;      // 外部送信基盤へは触らせない
  delete process.env.MARKETING_CAMPAIGN_ENABLED;
  delete process.env.MARKETING_CAMPAIGN_DISPATCH_ENABLED;
  const mod = await import('../../../netlify/functions/admin-marketing.js');
  const res = await mod.handler({
    httpMethod: 'POST',
    headers: { 'x-admin-secret': SECRET },
    body: JSON.stringify(payload),
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body || '{}') };
}

// ── 本体 ──────────────────────────────────────────────────────

test('【重要】台帳 6,110 行でも jobs が 10 名を 10 名として数える', async () => {
  const calls = stubAirtable();
  const { statusCode, body } = await invoke({ action: 'jobs' });
  assert.equal(statusCode, 200, JSON.stringify(body).slice(0, 200));
  const job = (body.jobs || []).find((j) => j.jobId === JOB_ID);
  assert.ok(job, 'ジョブを組み立てられていない');
  assert.equal(job.status, 'PENDING');
  assert.equal(job.counts.queued, 10, `配信件数が過少（${job.counts.queued}）— 打ち切りが復活している`);
  assert.equal(job.counts.sent, 0);
  // 台帳を名指しで引いていること
  const ledgerReads = calls.filter((c) => c.url.includes('/CampaignDeliveries'));
  assert.ok(ledgerReads.length > 0);
  assert.ok(ledgerReads.every((c) => /ScheduledEmailJobId/.test(c.formula)),
    '配信行を名指しで引いていない');
});

test('【重要】台帳 6,110 行でも sequence が Step1 送信済み 10 名を認識する', async () => {
  stubAirtable();
  const { statusCode, body } = await invoke({ action: 'sequence', campaignId: CAMPAIGN_ID });
  assert.equal(statusCode, 200, JSON.stringify(body).slice(0, 300));
  assert.equal(body.summary.total, 10);
  assert.equal(body.summary.sentByStep['1'], 10,
    `Step1 の送信済みが ${body.summary.sentByStep['1']} 名（10 名でなければ打ち切りが復活している）`);
  assert.equal(body.summary.dueByStep['1'], 0, 'もう一度 Step1 を送ろうとしている');
  assert.equal(body.summary.balanced, true);
});

test('【重要】sequence / jobs / barrier の見え方が一致する（10 名で揃う）', async () => {
  stubAirtable();
  const seq = await invoke({ action: 'sequence', campaignId: CAMPAIGN_ID });
  const jobs = await invoke({ action: 'jobs' });
  const job = (jobs.body.jobs || []).find((j) => j.jobId === JOB_ID);
  assert.equal(seq.body.summary.sentByStep['1'], 10);
  assert.equal(job.counts.queued, 10);
  assert.equal(job.recipientCount, 10);
  // 「Step1 が片付いた人数」がどの経路でも 10
  assert.equal(seq.body.summary.total - seq.body.summary.due, 10);
});

test('【重要】全件走査へ落ちたら気付ける（この試験が空振りしない）', async () => {
  // 台帳を全件で読みに来たら 6,110 行を返す。旧実装ならここで 4,000 行に切れる
  let fullScans = 0;
  stubAirtable({ onFullScan: (u) => { fullScans += 1; return paginatedLedger(u); } });
  await invoke({ action: 'jobs' });
  assert.equal(fullScans, 0, '台帳を全件走査している（名指し取得へ直っていない）');
});

test('【重要】履歴は取り切れなければ 500（部分集計を実績として出さない）', async () => {
  // history は母数が台帳全体なので名指しにできない。打ち切りは例外になる
  stubAirtable({ onFullScan: (u) => paginatedLedger(u) });
  const { statusCode, body } = await invoke({ action: 'history' });
  assert.equal(statusCode, 500, `打ち切った集計を 200 で返している: ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(body.code, 'history_fetch_incomplete');
  assert.equal(body.sideEffects, 'none');
});

test('【重要】応答にメールアドレスを載せない', async () => {
  stubAirtable();
  const seq = await invoke({ action: 'sequence', campaignId: CAMPAIGN_ID });
  const jobs = await invoke({ action: 'jobs' });
  for (const r of [seq, jobs]) {
    assert.equal(/@example\.com/.test(JSON.stringify(r.body)), false, '応答にアドレスが含まれる');
  }
});
