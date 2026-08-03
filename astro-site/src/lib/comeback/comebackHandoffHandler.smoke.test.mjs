/**
 * comebackHandoffHandler.smoke.test.mjs — 引き継ぎ経路の**ハンドラを実際に呼ぶ**煙試験。
 *   node --test src/lib/comeback/comebackHandoffHandler.smoke.test.mjs
 *
 * ソース検査だけでは「実行して初めて落ちる欠陥」を拾えない。ここでは fetch を差し替え、
 * ネットワークなしで admin-marketing の handlePlan を起動し、
 *
 *   - 付与成功者だけが対象になるか
 *   - 画面が送ってきた recordId が無視されるか（改ざん耐性）
 *   - 期限切れ・0 件で先へ進めないか
 *   - suppression を確認できないときに止まるか（fail closed を緩めていないか）
 *
 * を実際の応答で確かめる。**書き込み（キュー登録）へは到達させない**（live gate は OFF のまま）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { HANDOFF_BLOCK, HANDOFF_TTL_MS } from './comebackEmailHandoff.js';

const SECRET = 'test-admin-secret';
const OP = 'cb-light-lifetime-2026-08-03-abcd1234';
const CAMPAIGN = 'dormant-reactivation';

/** 無料付与に成功した休眠顧客（Customers 1 行） */
const grantedCustomer = (id, email, { op = OP, grantedAtMs = Date.now() - 60_000, extra = {} } = {}) => ({
  id,
  fields: {
    Email: email,
    プラン: 'Free',
    Status: 'none',
    LightGrantLifetime: true,
    LightGrantedAt: new Date(grantedAtMs).toISOString(),
    LightGrantOp: op,
    ...extra,
  },
});

/** 付与されなかった顧客（選択はされたが skip / 失敗した相手） */
const plainCustomer = (id, email, extra = {}) => ({
  id,
  fields: { Email: email, プラン: 'Free', Status: 'none', ...extra },
});

/**
 * Airtable / SendGrid を差し替える。
 * `suppressed` に入れたアドレスは SendGrid 側の配信停止として返す。
 * **送信 API（v3/mail/send）を叩いたら試験を落とす**（admin は送信経路を持たない）。
 */
function stubFetch({ customers = [], suppressed = [], suppressionOk = true } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET' });
    if (/api\.sendgrid\.com\/v3\/mail\/send/.test(u)) throw new Error('admin must not call SendGrid send API');
    if (/api\.sendgrid\.com/.test(u)) {
      if (!suppressionOk) return { ok: false, status: 500, json: async () => ({}) };
      // bounces / blocks / spam_reports / invalid_emails などの一覧はいずれも配列
      const isBounces = /\/bounces/.test(u);
      return {
        ok: true, status: 200,
        json: async () => (isBounces ? suppressed.map((email) => ({ email })) : []),
      };
    }
    if (/Customers/.test(u)) return { ok: true, status: 200, json: async () => ({ records: customers }) };
    return { ok: true, status: 200, json: async () => ({ records: [] }) };
  };
  return calls;
}

async function invoke(payload) {
  process.env.PREMIUM_PLUS_ADMIN_SECRET = SECRET;
  process.env.AIRTABLE_API_KEY = 'test-key';
  process.env.AIRTABLE_BASE_ID = 'appTEST';
  // 実送信・キュー登録の gate は開けない（この試験は dry-run までしか進めない）
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

/**
 * suppression モジュールは成功結果を 5 分キャッシュする。
 * 同一プロセスの試験どうしで結果が漏れないよう、毎回捨てる。
 */
async function freshSuppression() {
  const m = await import('../../lib/marketing/providerSuppression.js');
  m.clearProviderSuppressionCache();
}

const dryRun = (extra) => invoke({ action: 'dryRun', campaignId: CAMPAIGN, ...extra });

// ── 引き継ぎ対象の導出 ──────────────────────────────────────────

test('smoke: 全件付与成功 → 成功者全員が引き継がれる', async () => {
  process.env.SENDGRID_API_KEY = 'test-sg';
  await freshSuppression();
  stubFetch({
    customers: [
      grantedCustomer('recA1', 'a@example.com'),
      grantedCustomer('recB2', 'b@example.com'),
      grantedCustomer('recC3', 'c@example.com'),
    ],
  });
  const { statusCode, body } = await dryRun({ grantOperationId: OP });
  assert.equal(statusCode, 200, `dryRun が ${statusCode}: ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(body.handoff.resolved, 3, '付与成功者を全員拾えていない');
  assert.equal(body.selected, 3);
  assert.equal(body.willSend, 3);
});

test('smoke: 一部付与成功 → 成功者だけが対象（失敗者は混ざらない）', async () => {
  process.env.SENDGRID_API_KEY = 'test-sg';
  await freshSuppression();
  stubFetch({
    customers: [
      grantedCustomer('recA1', 'a@example.com'),
      plainCustomer('recB2', 'b@example.com'),          // 付与できなかった
      plainCustomer('recC3', 'c@example.com'),          // 付与できなかった
      grantedCustomer('recD4', 'd@example.com'),
    ],
  });
  const { statusCode, body } = await dryRun({ grantOperationId: OP });
  assert.equal(statusCode, 200);
  assert.equal(body.handoff.resolved, 2);
  assert.equal(body.willSend, 2, '付与できなかった相手が対象に入っている');
});

test('smoke: 全件失敗 → メール工程へ進めない（409 / 書き込みなし）', async () => {
  process.env.SENDGRID_API_KEY = 'test-sg';
  await freshSuppression();
  const calls = stubFetch({
    customers: [plainCustomer('recA1', 'a@example.com'), plainCustomer('recB2', 'b@example.com')],
  });
  const { statusCode, body } = await dryRun({ grantOperationId: OP });
  assert.equal(statusCode, 409);
  assert.equal(body.reason, HANDOFF_BLOCK.NO_RECIPIENTS);
  assert.equal(body.sideEffects, 'none');
  assert.equal(calls.some((c) => c.method !== 'GET'), false, '書き込みへ到達している');
});

test('smoke: recordId 改ざん → 画面が送った recordId は 1 つも使われない', async () => {
  process.env.SENDGRID_API_KEY = 'test-sg';
  await freshSuppression();
  stubFetch({
    customers: [
      grantedCustomer('recA1', 'a@example.com'),
      plainCustomer('recVICTIM', 'victim@example.com'),   // 付与していない他人
    ],
  });
  const { statusCode, body } = await dryRun({
    grantOperationId: OP,
    // 攻撃者が任意の相手を注入しようとする
    recordIds: ['recVICTIM', 'recNOTEXIST'],
  });
  assert.equal(statusCode, 200);
  assert.equal(body.handoff.resolved, 1, '注入された recordId が対象に入っている');
  assert.equal(body.willSend, 1);
});

test('smoke: 期限切れの引き継ぎは 410（付与時刻から TTL 超過）', async () => {
  process.env.SENDGRID_API_KEY = 'test-sg';
  await freshSuppression();
  stubFetch({
    customers: [
      grantedCustomer('recA1', 'a@example.com', { grantedAtMs: Date.now() - HANDOFF_TTL_MS - 60_000 }),
    ],
  });
  const { statusCode, body } = await dryRun({ grantOperationId: OP });
  assert.equal(statusCode, 410);
  assert.equal(body.reason, HANDOFF_BLOCK.EXPIRED);
  assert.equal(body.sideEffects, 'none');
});

test('smoke: 別の操作 ID の付与は引き継がれない', async () => {
  process.env.SENDGRID_API_KEY = 'test-sg';
  await freshSuppression();
  stubFetch({
    customers: [grantedCustomer('recA1', 'a@example.com', { op: 'cb-other-2026-08-03-zzzz9999' })],
  });
  const { statusCode, body } = await dryRun({ grantOperationId: OP });
  assert.equal(statusCode, 409);
  assert.equal(body.reason, HANDOFF_BLOCK.NO_RECIPIENTS);
});

// ── 既存の除外判定を 1 ミリも緩めない ──────────────────────────────

test('smoke: suppression 対象は引き継いでも除外される', async () => {
  process.env.SENDGRID_API_KEY = 'test-sg';
  await freshSuppression();
  stubFetch({
    customers: [grantedCustomer('recA1', 'a@example.com'), grantedCustomer('recB2', 'b@example.com')],
    suppressed: ['b@example.com'],
  });
  const { statusCode, body } = await dryRun({ grantOperationId: OP });
  assert.equal(statusCode, 200);
  assert.equal(body.handoff.resolved, 2, '導出は 2 名');
  assert.equal(body.willSend, 1, 'suppression 対象が除外されていない');
  assert.equal(body.excluded, 1);
  assert.ok((body.excludedDetail || []).some((d) => d.count === 1), '除外理由が出ていない');
});

test('smoke: 配信停止フラグの顧客は引き継いでも除外される', async () => {
  process.env.SENDGRID_API_KEY = 'test-sg';
  await freshSuppression();
  stubFetch({
    customers: [
      grantedCustomer('recA1', 'a@example.com'),
      grantedCustomer('recB2', 'b@example.com', { extra: { UnsubscribedAnalyticsKeiba: true } }),
    ],
  });
  const { statusCode, body } = await dryRun({ grantOperationId: OP });
  assert.equal(statusCode, 200);
  assert.equal(body.willSend, 1, '配信停止が除外されていない');
});

test('smoke: suppression を確認できないときは引き継ぎでも中止する（fail closed）', async () => {
  process.env.SENDGRID_API_KEY = 'test-sg';
  await freshSuppression();
  stubFetch({ customers: [grantedCustomer('recA1', 'a@example.com')], suppressionOk: false });
  const { statusCode, body } = await dryRun({ grantOperationId: OP });
  assert.equal(statusCode, 503);
  assert.equal(body.sideEffects, 'none');
});

// ── 応答の安全性 ────────────────────────────────────────────────

test('smoke: 引き継ぎの応答にアドレスも recordId も載せない', async () => {
  process.env.SENDGRID_API_KEY = 'test-sg';
  await freshSuppression();
  stubFetch({ customers: [grantedCustomer('recA1', 'a@example.com')] });
  const { body } = await dryRun({ grantOperationId: OP });
  const s = JSON.stringify(body.handoff || {});
  assert.equal(/@[a-z0-9.-]+\.[a-z]{2,}/i.test(s), false, '引き継ぎ情報にアドレスが含まれる');
  assert.equal(/rec[A-Z0-9]{4,}/.test(s), false, '引き継ぎ情報に recordId が含まれる');
});

test('smoke: 通常の recordIds 指定は従来どおり動く（引き継ぎで壊していない）', async () => {
  process.env.SENDGRID_API_KEY = 'test-sg';
  await freshSuppression();
  stubFetch({ customers: [plainCustomer('recA1', 'a@example.com'), plainCustomer('recB2', 'b@example.com')] });
  const { statusCode, body } = await dryRun({ recordIds: ['recA1', 'recB2'] });
  assert.equal(statusCode, 200);
  assert.equal(body.handoff, null, '通常経路に引き継ぎ情報が混ざっている');
  assert.equal(body.willSend, 2);
});

test('smoke: 対象指定が無ければ従来どおり 400', async () => {
  process.env.SENDGRID_API_KEY = 'test-sg';
  await freshSuppression();
  stubFetch({ customers: [] });
  const { statusCode } = await dryRun({});
  assert.equal(statusCode, 400);
});
