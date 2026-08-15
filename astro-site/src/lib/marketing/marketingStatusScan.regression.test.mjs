/**
 * marketingStatusScan.regression.test.mjs — 台帳が 4,000 行を超えても取りこぼさない
 *   node --test src/lib/marketing/marketingStatusScan.regression.test.mjs
 *
 * ── 再現する事故（2026-08-15 本番）────────────────────────────
 * `CampaignDeliveries` が 4,000 行を超えた時点で（**本番実測 14,426 行**）、`admin-marketing` の
 * `fetchAll`（`MAX_PAGES=40` で **break**）が台帳を 4,000 行で打ち切っていた。
 * その結果 Step1 を 10 名ぶんキュー登録した直後に、
 *
 *   - `sequence` … 「送信済み 1 名 / 残り 9 名」（実際は 10 名とも queued）
 *   - `jobs`     … ジョブの配信件数が 1（実際は 10）
 *
 * と**過少表示**した。運用者が「まだ 9 名残っている」と誤読する。
 *
 * ここでは fetch を差し替えた偽 Airtable に **6,110 行 fixture の台帳**を持たせ、
 * ハンドラを実際に起動して「10 名を 10 名として数える」ことを確かめる。
 * 全件走査へ落ちた場合は偽サーバー側が検知してテストを落とす。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { computeCampaignDeliveryKey } from './campaignSend.js';
import { getCampaign } from './campaignCatalog.js';
import { resolveSequenceStep } from './campaignSequence.js';
import { getBrandConfig } from '../newsletter/brand-config.js';

const SECRET = 'test-admin-secret';
const BRAND = 'analytics-keiba';
const CAMPAIGN_ID = 'light-trial-to-premium-sequence';
const JOB_ID = 'mkt-light-trial-to-premium-sequence-v1-af3acf8c-1';
/**
 * **6,110 行 fixture**（本番実測値ではない）。
 * 目的は 4,000 行の打ち切り境界を確実に越えること。
 * 本番の実測は **14,426 行 / 145 ページ / 162 秒**（2026-08-15）。
 */
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
 * 6,110 行 fixture をページングで返す（＝旧実装なら 40 ページで打ち切られる）。
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

/** 台帳をページングで返す（100 行/ページ）。既定は 6,110 行 fixture = 62 ページ */
function paginatedLedger(url, rows = LEDGER_ROWS) {
  const page = Number(new URL(url).searchParams.get('offset') || 0);
  const start = page * 100;
  const records = Array.from({ length: Math.max(0, Math.min(100, rows - start)) }, (_, i) => ({
    id: `recOLD${String(start + i).padStart(10, '0')}`,
    fields: { EmailType: 'campaign', CampaignType: 'dormant-reactivation:v2', Status: 'sent' },
  }));
  const next = start + 100 < rows ? String(page + 1) : undefined;
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

test('【重要】台帳 6,110 行 fixture でも jobs が 10 名を 10 名として数える', async () => {
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

test('【重要】台帳 6,110 行 fixture でも sequence が Step1 送信済み 10 名を認識する', async () => {
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
  // 台帳を全件で読みに来たら 6,110 行 fixture を返す。旧実装ならここで 4,000 行に切れる
  let fullScans = 0;
  stubAirtable({ onFullScan: (u) => { fullScans += 1; return paginatedLedger(u); } });
  await invoke({ action: 'jobs' });
  assert.equal(fullScans, 0, '台帳を全件走査している（名指し取得へ直っていない）');
});

test('【重要】応答にメールアドレスを載せない', async () => {
  stubAirtable();
  const seq = await invoke({ action: 'sequence', campaignId: CAMPAIGN_ID });
  const jobs = await invoke({ action: 'jobs' });
  for (const r of [seq, jobs]) {
    assert.equal(/@example\.com/.test(JSON.stringify(r.body)), false, '応答にアドレスが含まれる');
  }
});

// ── 読む量が実データに耐えること（2026-08-15 / deploy 後に本番で 500 になった）──
//
// 名指しにしても **1 リクエストで名指しするジョブ数 × 100 行** を読む。
// 既定の 50 ジョブ × 20 ページ（2,000 行）では 5,000 行を読み切れず、
// fail closed が正しく働いた結果 `jobs` が 500 になった（＝表示できない）。
// 「安全に落ちる」だけでなく「実データで落ちない」ことも試験する。

test('【重要】1 リクエストで名指しするジョブ数ぶんのページを確保している', () => {
  const FN = readFileSync(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url), 'utf8');
  const chunk = Number((FN.match(/const JOB_ID_CHUNK = (\d+)/) || [])[1]);
  const pages = FN.match(/const JOB_ID_MAX_PAGES = JOB_ID_CHUNK \* (\d+)/);
  assert.ok(Number.isFinite(chunk) && chunk > 0, 'JOB_ID_CHUNK が無い');
  assert.ok(pages, 'JOB_ID_MAX_PAGES をチャンク数から導いていない');
  // 1 ジョブ = 最大 100 宛先 = 1 ページ。チャンク数ぶん以上のページが要る
  assert.ok(Number(pages[1]) >= 1, 'ページ上限がチャンク数を下回っている');
  // 既定値（50 × 20）をそのまま使っていないこと
  assert.equal(/fetchDeliveriesByJobIds[\s\S]{0,400}TARGETED_MAX_PAGES/.test(FN), false,
    '既定の上限を使っている（50 ジョブでは必ず溢れる）');
});

test('【重要】ジョブ一覧は件数を明示して切る（黙って切らない）', () => {
  const FN = readFileSync(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url), 'utf8');
  for (const k of ['jobsTotal', 'jobsShown', 'jobsTruncated', 'JOBS_VIEW_LIMIT']) {
    assert.ok(FN.includes(k), `${k} が無い`);
  }
  const UI = readFileSync(new URL('../../pages/admin/premium-plus-eligibility.astro', import.meta.url), 'utf8');
  assert.match(UI, /data\.jobsTruncated/, '画面が省略を伝えていない');
  assert.match(UI, /全 \$\{data\.jobsTotal\} 件/, '画面が総数を出していない');
});

test('【重要】必要な列だけを要求する（fields[] を送る）', () => {
  const FN = readFileSync(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url), 'utf8');
  assert.match(FN, /url\.searchParams\.append\('fields\[\]', f\)/, 'fields[] を送っていない');
});

// ── 実績集計は配信台帳から数えない（2026-08-15 / 台帳 14,426 行）──────
//
// `CampaignDeliveries` は 145 ページ・実測 162 秒。Function の 26 秒では読み切れない。
// ジョブ台帳（1 送信 = 1 行）へ集計元を移した。**数の意味が変わるので出所を明示する。**

test('【重要】history は配信台帳を読まずに 200 を返す', async () => {
  let ledgerReads = 0;
  stubAirtable({ onFullScan: (u) => { ledgerReads += 1; return paginatedLedger(u, 20000); } });
  const { statusCode, body } = await invoke({ action: 'history' });
  assert.equal(statusCode, 200, `落ちている: ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(ledgerReads, 0, '配信台帳を読んでいる（読み切れない規模）');
  assert.equal(body.source, 'scheduled-emails', '数の出所を出していない');
  assert.equal(Array.isArray(body.runs), true);
});

test('【重要】history はジョブ台帳の件数で集計する', async () => {
  stubAirtable();
  const { body } = await invoke({ action: 'history' });
  const run = body.runs.find((r) => r.campaignType.startsWith(CAMPAIGN_ID));
  assert.ok(run, '対象キャンペーンの行が無い');
  assert.equal(run.jobs, 1);
  assert.equal(run.recipients, 10, `対象人数が ${run.recipients}`);
  assert.equal(run.sent, 0);
  assert.equal(run.failed, 0);
  assert.equal(run.pending, 1, '送信待ちを数えていない');
});

test('【重要】分からない値を 0 で埋めない（skipped を出さない）', async () => {
  stubAirtable();
  const { body } = await invoke({ action: 'history' });
  for (const r of body.runs) {
    assert.equal('skipped' in r, false, 'ジョブから分からない skipped を出している');
    assert.equal('queued' in r, false, '配信行の状態を出している');
  }
  assert.match(body.notice, /送信ジョブ台帳/, '出所を説明していない');
  assert.match(body.notice, /skipped/, '出していない項目の理由を説明していない');
});

test('【重要】ジョブ台帳を取り切れなければ 500（部分集計を出さない）', async () => {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/ScheduledEmails')) {
      // 常に offset を返し続ける = 取り切れない
      return ok({ records: scheduledRows, offset: 'more' });
    }
    return ok({ records: [] });
  };
  const { statusCode, body } = await invoke({ action: 'history' });
  assert.equal(statusCode, 500);
  assert.equal(body.code, 'history_fetch_incomplete');
  assert.equal(body.sideEffects, 'none');
});

// ── 候補単位の重複確認（action=duplicateCheck / 2026-08-15）────────
//
// campaign 単位で「過去ジョブがあれば止める」判定は、1 回流したら二度と通らない。
// 見るのは候補ごとの DeliveryKey（campaign × version × step × 受信者）。

test('【重要】duplicateCheck は候補の鍵だけを名指しで見る（台帳を全件走査しない）', async () => {
  let fullScans = 0;
  const calls = stubAirtable({ onFullScan: (u) => { fullScans += 1; return paginatedLedger(u, 20000); } });
  const { statusCode, body } = await invoke({
    action: 'duplicateCheck', campaignId: CAMPAIGN_ID, step: 1,
    recordIds: PEOPLE.map((p) => p.id),
  });
  assert.equal(statusCode, 200, JSON.stringify(body).slice(0, 200));
  assert.equal(fullScans, 0, '台帳を全件走査している');
  assert.equal(body.sideEffects, 'none');
  assert.equal(body.candidates, 10);
  assert.equal(body.unresolved, 0);
  // 候補の鍵で引いた行が queued なので「既に出ている」と判定される
  assert.equal(body.alreadyDelivered, 10);
  // 顧客・配信行とも名指しで引いている
  const targeted = calls.filter((c) => c.url.includes('/CampaignDeliveries'));
  assert.ok(targeted.length > 0);
  assert.ok(targeted.every((c) => /DeliveryKey/.test(c.formula)), '鍵で名指ししていない');
});

test('【重要】duplicateCheck の応答に PII / 鍵を載せない', async () => {
  stubAirtable();
  const { body } = await invoke({
    action: 'duplicateCheck', campaignId: CAMPAIGN_ID, step: 1,
    recordIds: PEOPLE.map((p) => p.id),
  });
  const dump = JSON.stringify(body);
  assert.equal(/@example\.com/.test(dump), false, 'アドレスが出ている');
  assert.equal(/recCUST/.test(dump), false, 'recordId が出ている');
  assert.equal(/DeliveryKey"\s*:/.test(dump), false, 'DeliveryKey を返している');
});

test('【重要】duplicateCheck は対象未指定・未知ステップを拒否する', async () => {
  stubAirtable();
  assert.equal((await invoke({ action: 'duplicateCheck', campaignId: CAMPAIGN_ID, step: 1, recordIds: [] })).statusCode, 400);
  assert.equal((await invoke({ action: 'duplicateCheck', campaignId: CAMPAIGN_ID, step: 99, recordIds: ['recX'] })).statusCode, 400);
  assert.equal((await invoke({ action: 'duplicateCheck', campaignId: 'unknown', step: 1, recordIds: ['recX'] })).statusCode, 400);
});

test('【重要】duplicateCheck は書き込みを 1 件も行わない', async () => {
  const calls = stubAirtable();
  await invoke({
    action: 'duplicateCheck', campaignId: CAMPAIGN_ID, step: 1,
    recordIds: PEOPLE.map((p) => p.id),
  });
  const writes = calls.filter((c) => ['PATCH', 'PUT', 'DELETE'].includes(c.method));
  assert.deepEqual(writes, [], '書き込んでいる');
});
