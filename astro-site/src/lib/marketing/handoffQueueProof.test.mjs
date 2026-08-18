/**
 * handoffQueueProof.test.mjs — 引き継ぎの「証明」が**読み取り失敗で緩まない**ことを固定する
 *
 * ここで守りたい 1 点:
 *   `loadBlacklistEmails()` は**読めなくても例外を投げない**。
 *   `{ emails: new Set(), status: 'network-error' }` のように空 Set を返すため、
 *   `bl && bl.emails` で見ると **読み取り失敗が「ブラックリスト 0 件」として通る**。
 *   そうなると本当は除外されるはずの人が「解決済み」に混じり、
 *   引き継ぎを誤って畳む（付与済みなのに案内が来ない人が黙って残る）。
 *
 * mock は**実際の `loadBlacklistEmails` の戻り値の形**（`{ emails, status }`）に合わせる。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  proveHandoffQueued, acceptBlacklistResult, PROOF_FAIL,
} from './handoffQueueProof.js';
import { computeCampaignDeliveryKey } from './campaignSend.js';

const BRAND = 'analytics-keiba';          // AK は EmailBlacklist テーブルを**持つ**
const BRAND_NO_TABLE = 'keiba-intelligence'; // 既存契約でテーブル非対象
const FROM = 'info@example.com';
const OP = 'grant-op-test-001';
const NOW = Date.UTC(2026, 7, 18, 3, 0, 0);
const CAMPAIGN = { campaignId: 'light-trial-test', version: 1 };
const CAMPAIGN_TYPE = `${CAMPAIGN.campaignId}:v${CAMPAIGN.version}`;

const keyFor = (email) => computeCampaignDeliveryKey({
  campaign: CAMPAIGN, recipientEmail: email, brand: BRAND, fromEmail: FROM,
});

/** 自動付与で Light 体験中の 1 人（関所の対象になる形） */
function member(i, extra = {}) {
  return {
    id: `rec${String(i).padStart(4, '0')}`,
    fields: {
      Email: `user${i}@example.com`,
      LightGrantOp: OP,
      LightGrantedAt: new Date(NOW - 86400000).toISOString(),
      LightGrantUntil: new Date(NOW + 29 * 86400000).toISOString(),
      ComebackGrantSource: 'light-trial-autogrant',
      ...extra,
    },
  };
}

/** Step1 が届く経路に乗った配信行 */
const deliveryRow = (email) => ({
  id: `del-${email}`,
  fields: {
    DeliveryKey: keyFor(email), Status: 'queued',
    CampaignType: CAMPAIGN_TYPE, EmailType: 'campaign',
  },
});

/**
 * Airtable の 2 テーブルを返す fetch mock。
 * `readAll` は URL の path でテーブルを見分けられる形で叩く。
 */
function makeFetch({ members = [], deliveries = [] } = {}) {
  return async (url) => {
    const path = String(url.pathname || url);
    const isCustomers = path.includes('Customers');
    const records = isCustomers ? members : deliveries;
    return { ok: true, json: async () => ({ records }) };
  };
}

const blacklist = (status, emails = []) => async () => ({
  emails: new Set(emails), status,
});
const suppression = (emails = []) => async () => ({
  ok: true, emails: new Set(emails), counts: {}, total: emails.length,
});

function run({ members, deliveries, bl, sup }) {
  return proveHandoffQueued({
    apiKey: 'key', baseId: 'base', operationId: OP,
    campaign: CAMPAIGN, brand: BRAND, fromEmail: FROM, step: 1, nowMs: NOW,
    env: { SENDGRID_API_KEY: 'sg' },
    fetchImpl: makeFetch({ members, deliveries }),
    deps: { loadBlacklistEmails: bl, fetchProviderSuppression: sup },
  });
}

// ── 1. 正常に読めた（空 Set でも status=enabled なら証明してよい）───────────
test('blacklist が status=enabled なら、空 Set でも証明に使える', async () => {
  const ms = [member(1), member(2)];
  const res = await run({
    members: ms,
    deliveries: ms.map((m) => deliveryRow(m.fields.Email)),
    bl: blacklist('enabled'),
    sup: suppression(),
  });
  assert.equal(res.ok, true);
  assert.equal(res.reason, null);
  assert.equal(res.outstanding, 0);
  assert.equal(res.members, 2);
});

// ── 2〜5. 読み取り失敗はすべて fail closed ────────────────────────────
for (const status of ['network-error', 'permission-error', 'read-error', 'missing']) {
  test(`blacklist が status=${status} なら EXCLUSIONS_UNREADABLE（AK は not-applicable にしない）`, async () => {
    const ms = [member(1), member(2)];
    const res = await run({
      members: ms,
      // ⚠️ 他の材料は**全部揃っている**。それでも証明しないことを固定する
      deliveries: ms.map((m) => deliveryRow(m.fields.Email)),
      bl: blacklist(status),
      sup: suppression(),
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, PROOF_FAIL.EXCLUSIONS_UNREADABLE);
  });
}

// ── 6. 198 queued + 2 provider suppression でも「全員解決済み」は成立する ──
test('198 名 queued + 2 名 provider suppression で証明が成立する（正当な除外で止めない）', async () => {
  const ms = Array.from({ length: 200 }, (_, i) => member(i + 1));
  const suppressed = ms.slice(198).map((m) => m.fields.Email.toLowerCase());
  const res = await run({
    members: ms,
    deliveries: ms.slice(0, 198).map((m) => deliveryRow(m.fields.Email)),
    bl: blacklist('enabled'),
    sup: suppression(suppressed),
  });
  assert.equal(res.ok, true, `reason=${res.reason} outstanding=${res.outstanding}`);
  assert.equal(res.members, 200);
  assert.equal(res.resolved, 200);
  assert.equal(res.outstanding, 0);
  assert.equal(res.byReason.step1_queued, 198);
  assert.equal(res.byReason.provider_suppressed, 2);
});

// ── 7. blacklist が読めていれば、blacklist 対象者は not_sendable で解決する ──
test('blacklist を正常取得できたとき、blacklist 対象者は not_sendable として解決する', async () => {
  const ms = [member(1), member(2)];
  const res = await run({
    members: ms,
    // 2 人目は配信行が無い。blacklist 由来の not_sendable で解決するはず
    deliveries: [deliveryRow(ms[0].fields.Email)],
    bl: blacklist('enabled', [ms[1].fields.Email.toLowerCase()]),
    sup: suppression(),
  });
  assert.equal(res.ok, true, `reason=${res.reason}`);
  assert.equal(res.outstanding, 0);
  assert.equal(res.byReason.step1_queued, 1);
  assert.equal(res.byReason.not_sendable, 1);
});

// ── 8. 読めないときは、他の材料が揃っていても証明成功にしない ─────────────
test('blacklist が読めないときは、他が全部揃っていても ok:true にしない', async () => {
  const ms = Array.from({ length: 200 }, (_, i) => member(i + 1));
  const res = await run({
    members: ms,
    deliveries: ms.map((m) => deliveryRow(m.fields.Email)),   // 全員 queued
    bl: blacklist('network-error'),
    sup: suppression(),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, PROOF_FAIL.EXCLUSIONS_UNREADABLE);
  // 進捗の数字を「解決済み」として持ち出さない
  assert.equal(res.outstanding, 0);
  assert.equal(res.resolved, 0);
});

test('blacklist が例外を投げた場合も EXCLUSIONS_UNREADABLE', async () => {
  const ms = [member(1)];
  const res = await run({
    members: ms,
    deliveries: [deliveryRow(ms[0].fields.Email)],
    bl: async () => { throw new Error('boom'); },
    sup: suppression(),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, PROOF_FAIL.EXCLUSIONS_UNREADABLE);
});

// ── provider suppression 側の fail closed は現状維持 ─────────────────
test('provider suppression が ok:false なら EXCLUSIONS_UNREADABLE（現状維持）', async () => {
  const ms = [member(1)];
  const res = await run({
    members: ms,
    deliveries: [deliveryRow(ms[0].fields.Email)],
    bl: blacklist('enabled'),
    sup: async () => ({ ok: false, emails: new Set(), error: 'missing_api_key' }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, PROOF_FAIL.EXCLUSIONS_UNREADABLE);
});

// ── acceptBlacklistResult 単体（契約を直接固定する）────────────────────
test('acceptBlacklistResult: enabled は Set を返す', () => {
  const set = new Set(['a@example.com']);
  assert.equal(acceptBlacklistResult({ emails: set, status: 'enabled' }, BRAND), set);
});

test('acceptBlacklistResult: 読み取り失敗の status は全て null', () => {
  for (const status of ['missing', 'permission-error', 'network-error', 'read-error', '', undefined]) {
    assert.equal(
      acceptBlacklistResult({ emails: new Set(), status }, BRAND), null,
      `status=${status} を通してはいけない`,
    );
  }
});

test('acceptBlacklistResult: AK の not-applicable は通さない（テーブルを持つブランド）', () => {
  assert.equal(acceptBlacklistResult({ emails: new Set(), status: 'not-applicable' }, BRAND), null);
});

test('acceptBlacklistResult: テーブル非対象ブランドの not-applicable だけ許可する', () => {
  const set = new Set();
  assert.equal(
    acceptBlacklistResult({ emails: set, status: 'not-applicable' }, BRAND_NO_TABLE), set,
  );
});

test('acceptBlacklistResult: 未知・未指定ブランドの not-applicable は通さない', () => {
  for (const brand of ['', undefined, null, 'unknown-brand']) {
    assert.equal(
      acceptBlacklistResult({ emails: new Set(), status: 'not-applicable' }, brand), null,
      `brand=${brand} を「非対象と確認できた」ことにしてはいけない`,
    );
  }
});

test('acceptBlacklistResult: emails が Set でなければ null', () => {
  assert.equal(acceptBlacklistResult({ emails: null, status: 'enabled' }, BRAND), null);
  assert.equal(acceptBlacklistResult({ emails: [], status: 'enabled' }, BRAND), null);
  assert.equal(acceptBlacklistResult(null, BRAND), null);
});
