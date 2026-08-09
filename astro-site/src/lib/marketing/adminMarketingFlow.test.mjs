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
import { clearProviderSuppressionCache } from './providerSuppression.js';
import { getCampaign } from './campaignCatalog.js';

const SECRET = 'test-secret';
const ENV_KEYS = ['PREMIUM_PLUS_ADMIN_SECRET', 'MARKETING_ADMIN_SECRET', 'AIRTABLE_API_KEY',
  'AIRTABLE_BASE_ID', 'MARKETING_CAMPAIGN_ENABLED', 'NEWSLETTER_AUTOMATION_ENABLED',
  'MARKETING_CAMPAIGN_DISPATCH_ENABLED', 'SENDGRID_API_KEY', 'NEWSLETTER_TEST_RECIPIENTS'];
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
  // Premium Plus 案内の追加絞り込み用: 三連複保有だが販売資格なし
  {
    id: 'rec10',
    fields: {
      Email: 'srp-noelig@example.com', 'プラン': 'Premium', PlanType: 'Annual',
      Status: 'active', '有効期限': '2099-01-01', LifetimeSanrenpuku: true,
    },
  },
  // 三連複保有 + eligible + PHASE 3 以上（販売許可から十分日数が経過）
  {
    id: 'rec11',
    fields: {
      Email: 'srp-elig@example.com', 'プラン': 'Premium', PlanType: 'Annual',
      Status: 'active', '有効期限': '2099-01-01', LifetimeSanrenpuku: true,
      PremiumPlusEligibility: 'eligible',
      PremiumPlusEligibleAt: new Date(Date.now() - 30 * 86400000).toISOString(),
    },
  },
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

/** SendGrid suppression の偽レスポンス（bounce に 1 件だけ載せる） */
let fakeSuppressed = ['bounced@example.com'];
/** true にすると suppression 取得が失敗する（fail closed の検証用） */
let suppressionFails = false;

function installFakeAirtable() {
  store = { deliveries: [], scheduled: [], writes: [], customerWrites: 0, mailSendCalls: 0, suppressionGets: 0 };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();

    // ── SendGrid ──
    if (u.includes('api.sendgrid.com')) {
      if (u.includes('/mail/send')) {
        // 実送信 API が呼ばれたら事故。テストで必ず検出する。
        store.mailSendCalls += 1;
        throw new Error('実送信 API (mail/send) が呼ばれた');
      }
      if (u.includes('/v3/suppression/')) {
        store.suppressionGets += 1;
        if (suppressionFails) return makeResponse({ errors: ['boom'] }, 500);
        const isBounces = u.includes('/bounces');
        return makeResponse(isBounces ? fakeSuppressed.map((email) => ({ email })) : []);
      }
      return makeResponse([], 404);
    }

    if (!u.includes('api.airtable.com')) {
      throw new Error(`想定外の外部通信: ${u}`);
    }
    // `POST /{table}/listRecords` は Airtable の **読み取り** API（長い formula を
    // URL に載せられないときに使う）。書き込みと数えない。
    const isListRecords = u.includes('/listRecords');
    const formula = isListRecords ? String(JSON.parse(init.body || '{}').filterByFormula || '') : '';
    /** formula から `key='value'` の value を全部拾う */
    const pick = (re) => [...formula.matchAll(re)].map((m) => m[1]);

    if (method !== 'GET' && !isListRecords) {
      store.writes.push({ table: u.split('/').pop().split('?')[0], method });
      if (u.includes('/Customers')) store.customerWrites += 1;
    }

    if (u.includes('/Customers')) {
      if (isListRecords) {
        // 名指し取得: RECORD_ID() で選ばれたものだけ返す（本番と同じ絞り込み）
        const ids = new Set(pick(/RECORD_ID\(\)='([^']*)'/g));
        return makeResponse({ records: CUSTOMERS.filter((r) => ids.has(r.id)) });
      }
      if (method !== 'GET') return makeResponse({ error: 'Customers への書き込みは禁止' }, 403);
      return makeResponse({ records: CUSTOMERS });
    }
    if (u.includes('/EmailBlacklist')) return makeResponse({ records: BLACKLIST });
    if (u.includes('/CampaignDeliveries')) {
      if (isListRecords) {
        const keys = new Set(pick(/\{DeliveryKey\}='([^']*)'/g));
        const mails = new Set(pick(/LOWER\(\{RecipientEmail\}\)='([^']*)'/g));
        const ct = (formula.match(/\{CampaignType\}='([^']*)'/) || [])[1] || null;
        return makeResponse({
          records: store.deliveries.filter((d) => {
            const f = d.fields || {};
            if (keys.size > 0) {
              if (!keys.has(String(f.DeliveryKey || ''))) return false;
              if (ct && String(f.CampaignType || '') !== ct) return false;
              return true;
            }
            if (mails.size > 0) {
              return mails.has(String(f.RecipientEmail || '').toLowerCase())
                && String(f.EmailType || '') === 'campaign';
            }
            return true;
          }),
        });
      }
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
  process.env.SENDGRID_API_KEY = 'fake-sg-key';
  delete process.env.MARKETING_CAMPAIGN_ENABLED;
  delete process.env.NEWSLETTER_AUTOMATION_ENABLED;
  delete process.env.MARKETING_CAMPAIGN_DISPATCH_ENABLED;
  delete process.env.NEWSLETTER_TEST_RECIPIENTS;
  fakeSuppressed = ['bounced@example.com'];
  suppressionFails = false;
  clearProviderSuppressionCache(); // テスト間で suppression をキャッシュさせない
  realFetch = globalThis.fetch;
  installFakeAirtable();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearProviderSuppressionCache();
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
  // 退会（rec8）は除外しない → suppressed は 配信停止 / バウンス の 2 名
  assert.equal(body.segments.marketing.suppressed, 2, '配信停止 / バウンス');
  assert.equal(body.segments.withdrawn.total, 1, '退会者が別枠で数えられていない');
  assert.equal(body.segments.withdrawn.sendable, 1, '退会者が送信可能として数えられていない');
  assert.equal(store.writes.length, 0, '一覧取得で書き込みが発生している');
});

test('セグメント絞り込みが効く（期限切れ かつ 送信可能）', async () => {
  const { body } = parse(await call({ action: 'customers', contract: 'expired', marketing: 'sendable' }));
  const ids = body.rows.map((r) => r.recordId).sort();
  // rec8 は Status=withdrawn だが課金停止なので送信可能
  assert.deepEqual(ids, ['rec1', 'rec2', 'rec8'], '除外対象が混ざっている / 退会者が落ちている');
  assert.equal(body.rows.find((r) => r.recordId === 'rec8').withdrawn, true, '退会フラグが返っていない');
  assert.equal(body.rows[0].sendable, true);
});

test('除外者は理由付きで一覧に出る（消さずに見せる）', async () => {
  const { body } = parse(await call({ action: 'customers', marketing: 'suppressed' }));
  const byId = Object.fromEntries(body.rows.map((r) => [r.recordId, r.suppressionReasons]));
  assert.deepEqual(byId.rec6, ['unsubscribed']);
  assert.deepEqual(byId.rec7, ['blacklist']);
  assert.equal(byId.rec8, undefined, '退会者が除外一覧に出ている');
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
  // 退会（rec8）は除外しないので 3 名（rec1 / rec2 / rec8）
  assert.equal(body.willSend, 3, '送信対象は期限切れかつ送信可能な 3 名（退会者含む）');
  assert.equal(body.excluded, 3);
  const reasons = Object.fromEntries(body.excludedDetail.map((e) => [e.reason, e.count]));
  assert.deepEqual(reasons, { unsubscribed: 1, blacklist: 1, contract_mismatch: 1 });
  assert.ok(body.planFingerprint.length === 64);
  assert.equal(store.writes.length, 0, 'dry-run で書き込みが発生している');
});

test('dry-run はメールアドレスを一覧返却しない（ドメイン集計のみ）', async () => {
  const { body } = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1'] }));
  assert.equal(JSON.stringify(body).includes('expired1@'), false);
  assert.deepEqual(body.recipientDomains, { 'example.com': 1 });
});

test('SendGrid で suppressed の宛先は dry-run で除外される（AK 台帳に無くても）', async () => {
  // rec1 は AK 側では完全に送信可能。SendGrid だけが suppress している状態を作る。
  fakeSuppressed = ['expired1@example.com'];
  clearProviderSuppressionCache();
  const { body } = parse(await call({
    action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'],
  }));
  assert.equal(body.willSend, 1, 'provider suppressed の宛先を送信対象に数えている');
  const reasons = Object.fromEntries(body.excludedDetail.map((e) => [e.reason, e.count]));
  assert.equal(reasons.provider_suppressed, 1);
  assert.ok(store.suppressionGets > 0, 'provider へ問い合わせていない');
  assert.equal(body.providerSuppression.available, true);
});

test('【fail closed】provider suppression を確認できないと dry-run 自体が 503', async () => {
  suppressionFails = true;
  clearProviderSuppressionCache();
  const { status, body } = parse(await call({
    action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1'],
  }));
  assert.equal(status, 503, '確認できないまま送信計画を返している');
  assert.equal(body.sideEffects, 'none');
  assert.equal(store.writes.length, 0);
});

test('【fail closed】provider suppression を確認できないと send も 503・書き込みゼロ', async () => {
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  const dry = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1'] }));
  suppressionFails = true;
  clearProviderSuppressionCache();
  const { status } = parse(await call({
    action: 'send', campaignId: 'expired-comeback', recordIds: ['rec1'],
    planFingerprint: dry.body.planFingerprint,
    contentHash: dry.body.contentHash,
    shellVersion: dry.body.shellVersion,
  }));
  assert.equal(status, 503);
  assert.equal(store.deliveries.length, 0);
  assert.equal(store.scheduled.length, 0);
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
    contentHash: dry.body.contentHash,
    shellVersion: dry.body.shellVersion,
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
    contentHash: dry.body.contentHash,
    shellVersion: dry.body.shellVersion,
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
    contentHash: dry.body.contentHash,
    shellVersion: dry.body.shellVersion,
  }));

  assert.equal(status, 200);
  assert.equal(body.mode, 'queued');
  assert.equal(body.queued, 2);
  assert.equal(store.customerWrites, 0, 'Customers へ書き込んでいる');
  assert.equal(store.mailSendCalls, 0, "実送信 API を呼んでいる");
  assert.equal(store.scheduled.length, 1, 'ScheduledEmails ジョブが 1 本');
  assert.equal(store.scheduled[0].fields.Status, 'PENDING');
  assert.equal(store.scheduled[0].fields.CreatedBy, 'admin-marketing');
  assert.equal(store.deliveries.length, 2);
  for (const d of store.deliveries) {
    assert.equal(d.fields.EmailType, 'campaign');
    assert.equal(d.fields.Status, 'queued');
    assert.equal(d.fields.CampaignType, 'expired-comeback:v2');
    assert.ok(d.fields.ScheduledEmailJobId.startsWith('mkt-expired-comeback-v2-'));
  }
  // 送信基盤が無効なことを応答で明示する
  assert.equal(body.dispatchEnabled, false);
  assert.ok(body.notice.includes('実送信されません'));
});

test('同じキャンペーンをもう一度送っても二重送信にならない', async () => {
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  const dry1 = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'] }));
  await call({ action: 'send', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'], planFingerprint: dry1.body.planFingerprint, contentHash: dry1.body.contentHash, shellVersion: dry1.body.shellVersion });
  const deliveriesAfterFirst = store.deliveries.length;

  // 2 回目: 台帳に queued があるので全員 already_delivered
  const dry2 = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'] }));
  assert.equal(dry2.body.willSend, 0);
  assert.equal(dry2.body.excludedDetail[0].reason, 'already_delivered');
  assert.equal(dry2.body.excludedDetail[0].count, 2);

  const send2 = parse(await call({
    action: 'send', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'],
    planFingerprint: dry2.body.planFingerprint,
    contentHash: dry2.body.contentHash,
    shellVersion: dry2.body.shellVersion,
  }));
  assert.equal(send2.status, 400, '対象 0 件で送信しようとしている');
  assert.equal(store.deliveries.length, deliveriesAfterFirst, '台帳が増えている');
  assert.equal(store.scheduled.length, 1, 'ジョブが増えている');
});

test('履歴はキャンペーン単位で集計される', async () => {
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  const dry = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'] }));
  await call({ action: 'send', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'], planFingerprint: dry.body.planFingerprint, contentHash: dry.body.contentHash, shellVersion: dry.body.shellVersion });

  const { body } = parse(await call({ action: 'history' }));
  assert.equal(body.runs.length, 1);
  assert.equal(body.runs[0].campaignType, 'expired-comeback:v2');
  assert.equal(body.runs[0].queued, 2);
  assert.equal(body.runs[0].sent, 0, 'provider 受理前に sent を数えている');
  assert.ok(body.notice.includes('実配信'));
});

// ── キャンペーン横断 頻度ガード（本番化前の必須条件）──────────────
test('【24h ガード】連続クリックで 2 つ目のキャンペーンが fail closed になる', async () => {
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';

  // 1 通目: 期限切れカムバックを rec1 / rec2 へ送る
  const dry1 = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'] }));
  assert.equal(dry1.body.willSend, 2);
  const send1 = parse(await call({
    action: 'send', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'],
    planFingerprint: dry1.body.planFingerprint,
    contentHash: dry1.body.contentHash,
    shellVersion: dry1.body.shellVersion,
  }));
  assert.equal(send1.body.queued, 2);
  const jobsAfterFirst = store.scheduled.length;
  const deliveriesAfterFirst = store.deliveries.length;

  // 2 通目: 続けて別キャンペーン（Premium 再契約）を同じ相手へ実行
  clearProviderSuppressionCache();
  const dry2 = parse(await call({ action: 'dryRun', campaignId: 'premium-renewal', recordIds: ['rec1', 'rec2'] }));
  assert.equal(dry2.body.willSend, 0, '24 時間以内に 2 通目が送れてしまう');
  const reasons = Object.fromEntries(dry2.body.excludedDetail.map((e) => [e.reason, e.count]));
  assert.equal(reasons.recent_marketing_contact, 2);

  // 送信を試みても 0 件で拒否され、キューは増えない
  const send2 = parse(await call({
    action: 'send', campaignId: 'premium-renewal', recordIds: ['rec1', 'rec2'],
    planFingerprint: dry2.body.planFingerprint,
    contentHash: dry2.body.contentHash,
    shellVersion: dry2.body.shellVersion,
  }));
  assert.equal(send2.status, 400, '対象 0 件のまま送信されている');
  assert.equal(store.scheduled.length, jobsAfterFirst, 'ジョブが増えている');
  assert.equal(store.deliveries.length, deliveriesAfterFirst, '台帳が増えている');
});

test('【24h ガード】24 時間より前の送信履歴なら次のキャンペーンを送れる', async () => {
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  // 25 時間前に別キャンペーンを送った履歴を台帳へ置く
  store.deliveries.push({
    id: 'cd-old',
    fields: {
      DeliveryKey: 'old-key', EmailType: 'campaign', CampaignType: 'other:v1',
      RecipientEmail: 'expired1@example.com', Status: 'sent',
      SentAt: new Date(Date.now() - 25 * 3600_000).toISOString(),
    },
  });
  const dry = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1'] }));
  assert.equal(dry.body.willSend, 1, '24 時間経過後も送れなくなっている');
});

test('取引メール（step 等）は 24h ガードの対象に含めない', async () => {
  // EmailType='step' の直近レコードがあっても、キャンペーンは送れる
  store.deliveries.push({
    id: 'cd-step',
    fields: {
      DeliveryKey: 'step-key', EmailType: 'step', StepSequenceId: 's1', StepNumber: 1,
      RecipientEmail: 'expired1@example.com', Status: 'sent', SentAt: new Date().toISOString(),
    },
  });
  const dry = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1'] }));
  assert.equal(dry.body.willSend, 1, 'ステップメールでキャンペーンが止まっている');
});

// ── 使用停止キャンペーン ────────────────────────────────────────
test('使用停止中のキャンペーンは理由付きで拒否される（dry-run も送信も）', async () => {
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  for (const id of ['sanrenpuku-offer', 'general-announcement']) {
    const dry = parse(await call({ action: 'dryRun', campaignId: id, recordIds: ['rec3'] }));
    assert.equal(dry.status, 409, `${id} が dry-run できてしまう`);
    assert.ok(dry.body.error.includes('使用停止中'), dry.body.error);
    assert.equal(dry.body.sideEffects, 'none');

    const send = parse(await call({ action: 'send', campaignId: id, recordIds: ['rec3'], planFingerprint: 'x' }));
    assert.equal(send.status, 409, `${id} が送信できてしまう`);
  }
  assert.equal(store.writes.length, 0);
});

test('キャンペーン一覧は停止中も理由付きで返す', async () => {
  const { body } = parse(await call({ action: 'campaigns' }));
  assert.equal(body.campaigns.length, 9, '停止中が一覧から消えている');
  const off = body.campaigns.filter((c) => !c.usable);
  assert.equal(off.length, 2, '停止中が 2 本でない');
  for (const c of off) assert.ok(c.disabledReason, `${c.campaignId} に理由が無い`);
});

test('停止中でも本文プレビューは確認できる（送信経路ではないため）', async () => {
  const { status, body } = parse(await call({ action: 'preview', campaignId: 'sanrenpuku-offer' }));
  assert.equal(status, 200);
  assert.ok(body.subject.includes('三連複'));
});

// ── 運用テスト専用カナリア（本番 gate 手前の検証経路）──────────────
test('カナリア: env 未設定なら誰にも送れない（fail closed）', async () => {
  delete process.env.NEWSLETTER_TEST_RECIPIENTS;
  const d = parse(await call({ action: 'dryRun', campaignId: 'marketing-canary', recordIds: ['rec3'] }));
  assert.equal(d.body.willSend, 0, 'env 未設定でカナリアが送れてしまう');
  const reasons = Object.fromEntries(d.body.excludedDetail.map((e) => [e.reason, e.count]));
  assert.equal(reasons.campaign_mismatch, 1);
});

test('カナリア: テスト受信者 1 名で selected=1 / willSend=1 / excluded=0', async () => {
  process.env.NEWSLETTER_TEST_RECIPIENTS = 'active@example.com';
  const d = parse(await call({ action: 'dryRun', campaignId: 'marketing-canary', recordIds: ['rec3'] }));
  assert.equal(d.status, 200);
  assert.equal(d.body.selected, 1);
  assert.equal(d.body.willSend, 1, 'テスト受信者へ送れない');
  assert.equal(d.body.excluded, 0);
  assert.deepEqual(d.body.excludedDetail, []);
  assert.equal(d.body.sideEffects, 'none');
});

test('カナリア: 一般顧客を選んでも送信対象にならない', async () => {
  process.env.NEWSLETTER_TEST_RECIPIENTS = 'active@example.com';
  // rec1 / rec2（期限切れの一般顧客）を選択
  const d = parse(await call({ action: 'dryRun', campaignId: 'marketing-canary', recordIds: ['rec1', 'rec2'] }));
  assert.equal(d.body.selected, 2);
  assert.equal(d.body.willSend, 0, '一般顧客へテストメールが送られる');
  const reasons = Object.fromEntries(d.body.excludedDetail.map((e) => [e.reason, e.count]));
  assert.equal(reasons.campaign_mismatch, 2);
});

test('カナリア: env が複数でも選択レコード以外へ広がらない', async () => {
  process.env.NEWSLETTER_TEST_RECIPIENTS = 'active@example.com, light@example.com, free@example.com';
  const d = parse(await call({ action: 'dryRun', campaignId: 'marketing-canary', recordIds: ['rec3'] }));
  assert.equal(d.body.selected, 1, '選択していないレコードが対象に入っている');
  assert.equal(d.body.willSend, 1);
});

test('カナリアもテスト受信者が suppression 該当なら送らない', async () => {
  process.env.NEWSLETTER_TEST_RECIPIENTS = 'bounced@example.com'; // AK blacklist(HARD) 該当
  const d = parse(await call({ action: 'dryRun', campaignId: 'marketing-canary', recordIds: ['rec7'] }));
  assert.equal(d.body.willSend, 0, 'テスト用だからと guard をバイパスしている');
  const reasons = Object.fromEntries(d.body.excludedDetail.map((e) => [e.reason, e.count]));
  assert.equal(reasons.blacklist, 1);
});

test('カナリアも配信停止のテスト受信者へは送らない', async () => {
  process.env.NEWSLETTER_TEST_RECIPIENTS = 'unsub@example.com';
  const d = parse(await call({ action: 'dryRun', campaignId: 'marketing-canary', recordIds: ['rec6'] }));
  assert.equal(d.body.willSend, 0);
  const reasons = Object.fromEntries(d.body.excludedDetail.map((e) => [e.reason, e.count]));
  assert.equal(reasons.unsubscribed, 1);
});

test('カナリアも 24 時間ガードの対象', async () => {
  process.env.NEWSLETTER_TEST_RECIPIENTS = 'active@example.com';
  store.deliveries.push({
    id: 'cd-recent',
    fields: {
      DeliveryKey: 'k-recent', EmailType: 'campaign', CampaignType: 'other:v1',
      RecipientEmail: 'active@example.com', Status: 'sent', SentAt: new Date().toISOString(),
    },
  });
  const d = parse(await call({ action: 'dryRun', campaignId: 'marketing-canary', recordIds: ['rec3'] }));
  assert.equal(d.body.willSend, 0);
  const reasons = Object.fromEntries(d.body.excludedDetail.map((e) => [e.reason, e.count]));
  assert.equal(reasons.recent_marketing_contact, 1);
});

test('カナリア: enqueue しても Customers write 0 / 実送信 0', async () => {
  process.env.NEWSLETTER_TEST_RECIPIENTS = 'active@example.com';
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  const dry = parse(await call({ action: 'dryRun', campaignId: 'marketing-canary', recordIds: ['rec3'] }));
  const out = parse(await call({
    action: 'send', campaignId: 'marketing-canary', recordIds: ['rec3'],
    planFingerprint: dry.body.planFingerprint,
    contentHash: dry.body.contentHash,
    shellVersion: dry.body.shellVersion,
  }));
  assert.equal(out.status, 200);
  assert.equal(out.body.queued, 1);
  assert.equal(store.customerWrites, 0, 'Customers へ書き込んでいる');
  assert.equal(store.mailSendCalls, 0, '実送信 API を呼んでいる');
  assert.equal(store.scheduled.length, 1);
  assert.equal(store.scheduled[0].fields.Status, 'PENDING');
  assert.equal(store.scheduled[0].fields.TargetPlan, 'campaign:marketing-canary');
  assert.equal(store.deliveries.length, 1);
  assert.equal(store.deliveries[0].fields.CampaignType,
    `marketing-canary:v${getCampaign('marketing-canary').version}`);
  assert.equal(store.deliveries[0].fields.Status, 'queued');
  // dispatcher gate は別なので、実送信はされない
  assert.equal(out.body.dispatchEnabled, false);
});

test('カナリアは一覧で運用テスト専用と分かる', async () => {
  const { body } = parse(await call({ action: 'campaigns' }));
  const c = body.campaigns.find((x) => x.campaignId === 'marketing-canary');
  assert.ok(c, 'カナリアが一覧に無い');
  assert.equal(c.usable, true);
  assert.equal(c.testOnly, true, '運用テスト専用の目印が無い');
  assert.equal(c.extraAudience, 'marketing_canary_recipient');
  // 他のキャンペーンは testOnly でない
  for (const x of body.campaigns.filter((y) => y.campaignId !== 'marketing-canary')) {
    assert.equal(x.testOnly, false, `${x.campaignId} が誤って運用テスト専用になっている`);
  }
});

// ── Premium Plus 案内の追加絞り込み ──────────────────────────────
test('Premium Plus 案内は eligible かつ PHASE 3 以上でないと送れない', async () => {
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  // rec10: 三連複保有だが Premium Plus 資格なし → campaign_mismatch
  const dry = parse(await call({ action: 'dryRun', campaignId: 'premium-plus-offer', recordIds: ['rec10'] }));
  assert.equal(dry.body.willSend, 0, '販売資格が無いのに Premium Plus 案内が送られる');
  const reasons = Object.fromEntries(dry.body.excludedDetail.map((e) => [e.reason, e.count]));
  assert.equal(reasons.campaign_mismatch, 1);
});

test('Premium Plus 案内は eligible かつ PHASE 3 到達なら送れる', async () => {
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  const dry = parse(await call({ action: 'dryRun', campaignId: 'premium-plus-offer', recordIds: ['rec11'] }));
  assert.equal(dry.body.willSend, 1, 'PHASE 3 到達者へ送れない');
});

test('送信後は顧客一覧に送信履歴が反映される', async () => {
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  const dry = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1'] }));
  await call({ action: 'send', campaignId: 'expired-comeback', recordIds: ['rec1'], planFingerprint: dry.body.planFingerprint, contentHash: dry.body.contentHash, shellVersion: dry.body.shellVersion });

  const { body } = parse(await call({ action: 'customers', contract: 'expired' }));
  const rec1 = body.rows.find((r) => r.recordId === 'rec1');
  assert.equal(rec1.sentCount, 1);
  assert.equal(rec1.lastCampaign, 'expired-comeback:v2');
});

// ── 退会（課金停止）とマーケティング配信の分離（2026-07-30 業務定義）──────────
test('【6】退会顧客を expired-comeback へ選択 → 対象になる（willSend=1）', async () => {
  // rec8: Status=withdrawn / 有効期限 2026-01-01（期限切れ）
  const d = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec8'] }));
  assert.equal(d.status, 200);
  assert.equal(d.body.selected, 1);
  assert.equal(d.body.willSend, 1, '退会顧客がカムバック対象から外れている');
  assert.equal(d.body.excluded, 0);
  assert.deepEqual(d.body.excludedDetail, []);
});

test('【2】退会 + 配信停止は引き続き除外', async () => {
  // rec6 は配信停止。退会でなくても除外されることを確認（明示的なメール拒否は維持）
  const d = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec6'] }));
  assert.equal(d.body.willSend, 0);
  assert.equal(d.body.excludedDetail[0].reason, 'unsubscribed');
});

test('【3/4】退会 + blacklist / provider suppression は引き続き除外', async () => {
  // rec7 は AK blacklist(HARD) かつ provider suppression にも載っている
  const d = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec7'] }));
  assert.equal(d.body.willSend, 0);
  const reasons = (d.body.excludedDetail || []).map((e) => e.reason);
  assert.ok(reasons.includes('blacklist') || reasons.includes('provider_suppressed'), JSON.stringify(reasons));
});

test('【5】退会 + 24h 以内にマーケ送信済み → 除外', async () => {
  store.deliveries.push({
    id: 'cd-wd',
    fields: {
      DeliveryKey: 'k-wd', EmailType: 'campaign', CampaignType: 'other:v1',
      RecipientEmail: 'gone@example.com', Status: 'sent', SentAt: new Date().toISOString(),
    },
  });
  const d = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec8'] }));
  assert.equal(d.body.willSend, 0, '24h ガードが効いていない');
  assert.equal(d.body.excludedDetail[0].reason, 'recent_marketing_contact');
});

test('【7/8】退会顧客へ送っても Customers / 権限・契約フィールドへ書き込まない', async () => {
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  const dry = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec8'] }));
  const out = parse(await call({
    action: 'send', campaignId: 'expired-comeback', recordIds: ['rec8'],
    planFingerprint: dry.body.planFingerprint,
    contentHash: dry.body.contentHash,
    shellVersion: dry.body.shellVersion,
  }));
  assert.equal(out.body.queued, 1);
  assert.equal(store.customerWrites, 0, 'Customers へ書き込んでいる');
  // 書き込み先は CampaignDeliveries / ScheduledEmails のみ
  for (const w of store.writes) {
    assert.ok(/CampaignDeliveries|ScheduledEmails/.test(w.table), `想定外の書き込み先: ${w.table}`);
  }
  // 会員権限・契約フィールドを含む payload を作っていない
  // ※ Status は ScheduledEmails / CampaignDeliveries 自身の列（PENDING / queued）なので対象外
  const serialized = JSON.stringify(store.scheduled.concat(store.deliveries));
  for (const f of ['プラン', 'PlanType', '有効期限', 'WithdrawalRequested',
    'UnsubscribedAnalyticsKeiba', 'LifetimeSanrenpuku', 'PaidAt', 'AccountStatus']) {
    assert.equal(serialized.includes(`"${f}"`), false, `${f} を書こうとしている`);
  }
  // Customers 由来の Status 値（withdrawn 等）を書いていないこと
  assert.equal(serialized.includes('withdrawn'), false, 'Customers の Status 値を書いている');
});

test('【9】取引メール（step 等）の判定に影響しない', async () => {
  // EmailType='step' の履歴はマーケの 24h ガードにも履歴集計にも入らない
  store.deliveries.push({
    id: 'cd-step-wd',
    fields: {
      DeliveryKey: 'k-step-wd', EmailType: 'step', StepSequenceId: 's1', StepNumber: 1,
      RecipientEmail: 'gone@example.com', Status: 'sent', SentAt: new Date().toISOString(),
    },
  });
  const d = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec8'] }));
  assert.equal(d.body.willSend, 1, 'ステップメール履歴でマーケが止まっている');
});

test('一覧で退会は「送信可能」かつ契約側に退会フラグが立つ', async () => {
  const { body } = parse(await call({ action: 'customers', contract: 'expired' }));
  const rec8 = body.rows.find((r) => r.recordId === 'rec8');
  assert.ok(rec8, '退会顧客が一覧に出ていない');
  assert.equal(rec8.sendable, true, '送信可能になっていない');
  assert.deepEqual(rec8.suppressionReasons, []);
  assert.equal(rec8.withdrawn, true, '契約側の退会フラグが返っていない');
  assert.equal(rec8.contract, 'expired', '契約状態は履歴として残す');
});

// =========================================================================
// シェル（組み立て方）の版（2026-08-03）
// dry-run で確認したあとに deploy でシェルが変わると、同じ campaign 定義でも
// 届く HTML が別物になる。旧確認結果ではキュー登録させない。
// =========================================================================

test('dry-run はシェルの版を返す', async () => {
  const dry = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1'] }));
  assert.equal(dry.status, 200);
  assert.equal(typeof dry.body.shellVersion, 'number', 'シェルの版を返していない');
  assert.ok(dry.body.shellVersion >= 1);
});

test('dry-run 後にシェルの版が変わったらキュー登録できない（旧確認結果は無効）', async () => {
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  const dry = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'] }));

  // deploy でシェルが更新された状況を、古い版を送ることで再現する
  const stale = parse(await call({
    action: 'send', campaignId: 'expired-comeback', recordIds: ['rec1', 'rec2'],
    planFingerprint: dry.body.planFingerprint,
    contentHash: dry.body.contentHash,
    shellVersion: dry.body.shellVersion - 1,
  }));
  assert.equal(stale.status, 409, '古い組み立て方のまま登録できてしまう');
  assert.equal(stale.body.sideEffects, 'none');
  assert.equal(store.scheduled.length, 0, 'キューへ積んでいる');
  assert.equal(store.deliveries.length, 0);
});

test('シェルの版を渡さない送信は受け付けない（fail closed）', async () => {
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  const dry = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1'] }));
  const noShell = parse(await call({
    action: 'send', campaignId: 'expired-comeback', recordIds: ['rec1'],
    planFingerprint: dry.body.planFingerprint, contentHash: dry.body.contentHash,
  }));
  assert.equal(noShell.status, 400);
  assert.equal(store.scheduled.length, 0);

  // 文面の hash を渡さない場合も同じく受け付けない
  const noHash = parse(await call({
    action: 'send', campaignId: 'expired-comeback', recordIds: ['rec1'],
    planFingerprint: dry.body.planFingerprint, shellVersion: dry.body.shellVersion,
  }));
  assert.equal(noHash.status, 400);
  assert.equal(store.scheduled.length, 0);
});

test('積んだジョブにシェルの版が残る（dispatcher が照合できる）', async () => {
  process.env.MARKETING_CAMPAIGN_ENABLED = 'true';
  const dry = parse(await call({ action: 'dryRun', campaignId: 'expired-comeback', recordIds: ['rec1'] }));
  const sent = parse(await call({
    action: 'send', campaignId: 'expired-comeback', recordIds: ['rec1'],
    planFingerprint: dry.body.planFingerprint,
    contentHash: dry.body.contentHash,
    shellVersion: dry.body.shellVersion,
  }));
  assert.equal(sent.status, 200);
  assert.equal(store.scheduled.length, 1);
  assert.match(store.scheduled[0].fields.Notes, /shell:v\d+/, 'Notes に組み立て方の版が無い');
});
