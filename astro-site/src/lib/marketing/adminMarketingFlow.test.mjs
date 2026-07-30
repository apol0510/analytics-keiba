/**
 * adminMarketingFlow.test.mjs — 一覧 → dry-run → 送信 の統合テスト（mock Airtable / 実送信なし）
 *   node --test src/lib/marketing/adminMarketingFlow.test.mjs
 *
 * fetch を差し替えた偽 Airtable に対して Function ハンドラを直接呼ぶ。
 * ネットワークにも SendGrid にも本番 Airtable にも一切触れない。
 *
 * 確認する性質:
 *   - 認可（secret 不一致で 403）
 *   - セグメント一覧に期限切れ・Free・Light が出る
 *   - dry-run は 1 バイトも書かない
 *   - MARKETING_CAMPAIGN_ENABLED 未設定なら送信要求が 503 で書き込みゼロ
 *   - 有効化しても Customers へは書かず、CampaignDeliveries / ScheduledEmails だけを書く
 *   - 同じキャンペーンを再実行しても二重送信にならない
 *   - dry-run 後に対象が変わっていたら 409 で中止
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handler } from '../../../netlify/functions/admin-marketing.js';

const SECRET = 'test-secret';
const ENV_KEYS = ['PREMIUM_PLUS_ADMIN_SECRET', 'MARKETING_ADMIN_SECRET', 'AIRTABLE_API_KEY',
  'AIRTABLE_BASE_ID', 'MARKETING_CAMPAIGN_ENABLED', 'NEWSLETTER_AUTOMATION_ENABLED'];
const savedEnv = {};
let realFetch;

/** 偽 Customers（期限切れ / 有効 / Light / Free / 配信停止 / 退会） */
const CUSTOMERS = [
  { id: 'rec1', fields: { Email: 'expired1@example.com', 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2026-01-01' } },
  { id: 'rec2', fields: { Email: 'expired2@example.com', 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2026-02-01', '氏名': '山田太郎' } },
  { id: 'rec3', fields: { Email: 'active@example.com', 'プラン': 'Premium', PlanType: 'Annual', Status: 'active', '有効期限': '2099-01-01' } },
  { id: 'rec4', fields: { Email: 'light@example.com', 'プラン': 'Light', PlanType: 'Monthly', Status: 'active', '有効期限': '2099-01-01' } },
  { id: 'rec5', fields: { Email: 'free@example.com', 'プラン': 'Free', Status: 'active' } },
  { id: 'rec6', fields: { Email: 'unsub@example.com', 'プラン': 'Premium', Status: 'active', '有効期限': '2026-01-01', UnsubscribedAnalyticsKeiba: true } },
  { id: 'rec7', fields: { Email: 'bounced@example.com', 'プラン': 'Premium', Status: 'active', '有効期限': '2026-01-01' } },
  { id: 'rec8', fields: { Email: 'gone@example.com', 'プラン': 'Premium', Status: 'withdrawn', '有効期限': '2026-01-01' } },
  { id: 'rec9', fields: { Email: 'legacy@example.com', 'プラン': 'Premium', Status: 'active' } }, // 有効期限なし = unknown
];
const BLACKLIST = [{ id: 'b1', fields: { Email: 'bounced@example.com', Status: 'HARD_BOUNCE' } }];

/** 偽 Airtable の状態と書き込みログ */
let store;

function makeResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function installFakeAirtable() {
  store = { deliveries: [], scheduled: [], writes: [], customerWrites: 0, sendgridCalls: 0 };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();

    if (!u.includes('api.airtable.com')) {
      // Airtable 以外（＝ SendGrid など）への通信は事故。テストで検出する。
      store.sendgridCalls += 1;
      throw new Error(`外部送信 API が呼ばれた: ${u}`);
    }
    if (method !== 'GET') {
      store.writes.push({ table: u.split('/').pop().split('?')[0], method });
      if (u.includes('/Customers')) store.customerWrites += 1;
    }

    if (u.includes('/Customers')) {
      if (method !== 'GET') return makeResponse({ error: 'Customers への書き込みは禁止' }, 403);
      return makeResponse({ records: CUSTOMERS });
    }
    if (u.includes('/EmailBlacklist')) return makeResponse({ records: BLACKLIST });
    if (u.includes('/CampaignDeliveries')) {
      if (method === 'GET') {
        // filterByFormula の細かい解釈はせず、sent/queued の台帳をそのまま返す
        return makeResponse({ records: store.deliveries });
      }
      if (method === 'PATCH') {
        const body = JSON.parse(init.body);
        assert.deepEqual(body.performUpsert, { fieldsToMergeOn: ['DeliveryKey'] });
        for (const rec of body.records) {
          const key = rec.fields.DeliveryKey;
          const existing = store.deliveries.find((d) => d.fields.DeliveryKey === key);
          if (existing) existing.fields = { ...existing.fields, ...rec.fields };
          else store.deliveries.push({ id: `cd${store.deliveries.length + 1}`, fields: { ...rec.fields } });
        }
        return makeResponse({ records: body.records });
      }
    }
    if (u.includes('/ScheduledEmails')) {
      if (method === 'POST') {
        const body = JSON.parse(init.body);
        const rec = { id: `se${store.scheduled.length + 1}`, fields: body.fields };
        store.scheduled.push(rec);
        return makeResponse(rec);
      }
      return makeResponse({ records: store.scheduled });
    }
    return makeResponse({ records: [] });
  };
}

const call = (body, secret = SECRET) => handler({
  httpMethod: 'POST',
  headers: { 'x-admin-secret': secret },
  body: JSON.stringify(body),
});
const parse = (res) => ({ status: res.statusCode, body: JSON.parse(res.body) });

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.PREMIUM_PLUS_ADMIN_SECRET = SECRET;
  delete process.env.MARKETING_ADMIN_SECRET;
  process.env.AIRTABLE_API_KEY = 'fake-key';
  process.env.AIRTABLE_BASE_ID = 'appFAKE';
  delete process.env.MARKETING_CAMPAIGN_ENABLED;
  delete process.env.NEWSLETTER_AUTOMATION_ENABLED;
  realFetch = globalThis.fetch;
  installFakeAirtable();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ── 認可 ──────────────────────────────────────────────────────
test('secret 不一致は 403（Airtable にも触れない）', async () => {
  const { status } = parse(await call({ action: 'customers' }, 'wrong'));
  assert.equal(status, 403);
  assert.equal(store.writes.length, 0);
});

test('secret 未設定なら機能ごと無効（503）', async () => {
  delete process.env.PREMIUM_PLUS_ADMIN_SECRET;
  assert.equal(parse(await call({ action: 'customers' })).status, 503);
});

// ── 一覧 / セグメント ────────────────────────────────────────────
test('期限切れ・Light・Free・legacy を含めて母集団に出る', async () => {
  const { status, body } = parse(await call({ action: 'customers' }));
  assert.equal(status, 200);
  assert.equal(body.totalCustomers, CUSTOMERS.length);
  // rec1 / rec2 / rec6(配信停止) / rec7(バウンス) / rec8(退会) の 5 件
  assert.equal(body.segments.contract.expired, 5, '期限切れが母集団から落ちている');
  assert.equal(body.segments.contract.unknown, 1, '有効期限なし legacy が unknown で見える');
  assert.equal(body.segments.plan.light, 1);
  assert.equal(body.segments.plan.free, 1);
  assert.equal(body.segments.marketing.suppressed, 3, '配信停止 / バウンス / 退会');
  assert.equal(store.writes.length, 0, '一覧取得で書き込みが発生している');
});

test('セグメント絞り込みが効く（期限切れ かつ 送信可能）', async () => {
  const { body } = parse(await call({ action: 'customers', contract: 'expired', marketing: 'sendable' }));
  const ids = body.rows.map((r) => r.recordId).sort();
  assert.deepEqual(ids, ['rec1', 'rec2'], '除外対象が混ざっている');
  assert.equal(body.rows[0].sendable, true);
});

test('除外者は理由付きで一覧に出る（消さずに見せる）', async () => {
  const { body } = parse(await call({ action: 'customers', marketing: 'suppressed' }));
  const byId = Object.fromEntries(body.rows.map((r) => [r.recordId, r.suppressionReasons]));
  assert.deepEqual(byId.rec6, ['unsubscribed']);
  assert.deepEqual(byId.rec7, ['blacklist']);
  assert.deepEqual(byId.rec8, ['withdrawn']);
});

// ── キャンペーン / プレビュー ────────────────────────────────────
test('キャンペーン一覧と送信有効状態を返す', async () => {
  const { body } = parse(await call({ action: 'campaigns' }));
  assert.ok(body.campaigns.length >= 6);
  assert.equal(body.sendEnabled, false, '既定で送信が有効になっている');
  assert.equal(body.dispatchEnabled, false);
});

test('プレビューは Airtable にも触れない', async () => {
  const { status, body } = parse(await call({ action: 'preview', campaignId: 'expired-comeback', sampleName: '山田' }));
  assert.equal(status, 200);
  assert.ok(body.subject.includes('KEIBA Analytics'));
  assert.ok(body.html.includes('山田 様'));
  assert.equal(store.writes.length, 0);
});

// ── dry-run ───────────────────────────────────────────────────
test('dry-run は送信対象と除外理由を確定し、何も書かない', async () => {
  const { status, body } = parse(await call({
    action: 'dryRun', campaignId: 'expired-comeback',
    recordIds: ['rec1', 'rec2', 'rec6', 'rec7', 'rec8', 'rec3'],
  }));
  assert.equal(status, 200);
  assert.equal(body.mode, 'dry-run');
  assert.equal(body.sideEffects, 'none');
  assert.equal(body.selected, 6);
  assert.equal(body.willSend, 2, '送信対象は期限切れかつ送信可能な 2 名');
  assert.equal(body.excluded, 4);
  const reasons = Object.fromEntries(body.excludedDetail.map((e) => [e.reason, e.count]));
  assert.deepEqual(reasons, { unsubscribed: 1, blacklist: 1, withdrawn: 1, contract_mismatch: 1 });
  assert.ok(body.planFingerprint.length === 64);
  assert.equal(store.writes.length, 0, 'dry-run で書き込みが発生している');
});

test('dry-run はメールアドレスを一覧返却しない（ドメイン集計のみ）', async () => {
  const { body } = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1'] }));
  assert.equal(JSON.stringify(body).includes('expired1@'), false);
  assert.deepEqual(body.recipientDomains, { 'example.com': 1 });
});

test('選択なし / 未知キャンペーンは 400', async () => {
  assert.equal(parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: [] })).status, 400);
  assert.equal(parse(await call({ action: 'dryRun', campaignId: 'nope', recordIds: ['rec1'] })).status, 400);
});

// ── 送信（既定は無効）────────────────────────────────────────────
test('MARKETING_CAMPAIGN_ENABLED 未設定なら送信は 503・書き込みゼロ', async () => {
  const dry = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'] }));
  const { status, body } = parse(await call({
    action: 'send', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'],
    planFingerprint: dry.body.planFingerprint,
  }));
  assert.equal(status, 503);
  assert.equal(body.sideEffects, 'none');
  assert.equal(store.writes.length, 0);
  assert.equal(store.deliveries.length, 0);
  assert.equal(store.scheduled.length, 0);
});

test('確認トークンが無い / 古いと送信しない（TOCTOU 防止）', async () => {
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  const noToken = parse(await call({ action: 'send', campaignId: 'expired-comeback', recordIds: ['rec1'] }));
  assert.equal(noToken.status, 400);

  const dry = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'] }));
  // 対象を 1 名減らしてから、古いトークンで送信を試みる
  const stale = parse(await call({
    action: 'send', campaignId: 'expired-comeback', recordIds: ['rec1'],
    planFingerprint: dry.body.planFingerprint,
  }));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.sideEffects, 'none');
  assert.equal(store.writes.length, 0);
});

test('有効化しても Customers は書かず、キューだけを作る', async () => {
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  const dry = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'] }));
  const { status, body } = parse(await call({
    action: 'send', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'],
    planFingerprint: dry.body.planFingerprint,
  }));

  assert.equal(status, 200);
  assert.equal(body.mode, 'queued');
  assert.equal(body.queued, 2);
  assert.equal(store.customerWrites, 0, 'Customers へ書き込んでいる');
  assert.equal(store.sendgridCalls, 0, '外部送信 API を呼んでいる');
  assert.equal(store.scheduled.length, 1, 'ScheduledEmails ジョブが 1 本');
  assert.equal(store.scheduled[0].fields.Status, 'PENDING');
  assert.equal(store.scheduled[0].fields.CreatedBy, 'admin-marketing');
  assert.equal(store.deliveries.length, 2);
  for (const d of store.deliveries) {
    assert.equal(d.fields.EmailType, 'campaign');
    assert.equal(d.fields.Status, 'queued');
    assert.equal(d.fields.CampaignType, 'expired-comeback:v1');
    assert.ok(d.fields.ScheduledEmailJobId.startsWith('mkt-expired-comeback-v1-'));
  }
  // 送信基盤が無効なことを応答で明示する
  assert.equal(body.dispatchEnabled, false);
  assert.ok(body.notice.includes('実送信されません'));
});

test('同じキャンペーンをもう一度送っても二重送信にならない', async () => {
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  const dry1 = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'] }));
  await call({ action: 'send', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'], planFingerprint: dry1.body.planFingerprint });
  const deliveriesAfterFirst = store.deliveries.length;

  // 2 回目: 台帳に queued があるので全員 already_delivered
  const dry2 = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'] }));
  assert.equal(dry2.body.willSend, 0);
  assert.equal(dry2.body.excludedDetail[0].reason, 'already_delivered');
  assert.equal(dry2.body.excludedDetail[0].count, 2);

  const send2 = parse(await call({
    action: 'send', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'],
    planFingerprint: dry2.body.planFingerprint,
  }));
  assert.equal(send2.status, 400, '対象 0 件で送信しようとしている');
  assert.equal(store.deliveries.length, deliveriesAfterFirst, '台帳が増えている');
  assert.equal(store.scheduled.length, 1, 'ジョブが増えている');
});

test('履歴はキャンペーン単位で集計される', async () => {
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  const dry = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'] }));
  await call({ action: 'send', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'], planFingerprint: dry.body.planFingerprint });

  const { body } = parse(await call({ action: 'history' }));
  assert.equal(body.runs.length, 1);
  assert.equal(body.runs[0].campaignType, 'expired-comeback:v1');
  assert.equal(body.runs[0].queued, 2);
  assert.equal(body.runs[0].sent, 0, 'provider 受理前に sent を数えている');
  assert.ok(body.notice.includes('実配信'));
});

test('送信後は顧客一覧に送信履歴が反映される', async () => {
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  const dry = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1'] }));
  await call({ action: 'send', campaignId: 'expired-comeback', recordIds: ['rec1'], planFingerprint: dry.body.planFingerprint });

  const { body } = parse(await call({ action: 'customers', contract: 'expired' }));
  const rec1 = body.rows.find((r) => r.recordId === 'rec1');
  assert.equal(rec1.sentCount, 1);
  assert.equal(rec1.lastCampaign, 'expired-comeback:v1');
});
