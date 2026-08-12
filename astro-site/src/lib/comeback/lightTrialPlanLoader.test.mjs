/**
 * lightTrialPlanLoader.test.mjs — 下見と実行が**同じ 1 本**を通ることを固定する
 *   node --test src/lib/comeback/lightTrialPlanLoader.test.mjs
 *
 * Airtable は偽物に差し替える（**ネットワークへ出ない / 1 バイトも書かない**）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadAndPlanLightTrial, BRAND } from './lightTrialPlanLoader.js';
import { AUTOGRANT_ABORT, TRIAL_SEQUENCE_ID } from './lightTrialAutoGrant.js';
import { SELECTION_ABORT, PAGE_SIZE } from './lightTrialSelection.js';
import { AUTOGRANT_SOURCE } from './lightTrialBarrier.js';
import { getCampaign } from '../marketing/campaignCatalog.js';
import { computeCampaignDeliveryKey } from '../marketing/campaignSend.js';
import { resolveSequenceStep } from '../marketing/campaignSequence.js';
import { getBrandConfig } from '../newsletter/brand-config.js';

const NOW = Date.parse('2026-08-12T10:00:00Z');
const day = (n) => new Date(NOW + n * 86400000).toISOString();

const OPEN_ENV = {
  AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'b',
  COMEBACK_GRANT_FIELDS_READY: '1',
  COMEBACK_GRANT_ENABLED: 'true',
  LIGHT_TRIAL_AUTOGRANT_ENABLED: 'true',
  LIGHT_TRIAL_AUTOGRANT_ARMED: '2026-08-12',
};

const candidate = (i) => ({
  id: `rec${String(i).padStart(4, '0')}`,
  fields: {
    Email: `u${String(i).padStart(4, '0')}@example.com`,
    Source: 'customer-import:imp-2026-08-09-001',
  },
});

/**
 * Airtable の偽物。候補表と関所表を formula で振り分ける。
 * 書き込み API は**生やしていない**ので、書こうとすれば必ず落ちる。
 */
function makeDeps({ candidates = [], barrier = [], deliveries = [] } = {}) {
  const reads = [];
  return {
    reads,
    deps: {
      readPage: async ({ table, formula, sort, offset }) => {
        reads.push({ table, formula, sort });
        const rows = formula.includes('ComebackGrantSource') ? barrier : candidates;
        const start = offset ? Number(offset) : 0;
        const slice = rows.slice(start, start + PAGE_SIZE);
        const next = start + PAGE_SIZE;
        return { records: slice, offset: next < rows.length ? String(next) : undefined };
      },
      readDeliveries: async () => deliveries,
      loadBlacklistEmails: async () => ({ emails: new Set(), status: 'enabled' }),
      fetchProviderSuppression: async () => ({ ok: true, emails: new Set() }),
    },
  };
}

test('batch 10 なら 10 件だけ計画し、全件は読まない', async () => {
  const { deps, reads } = makeDeps({ candidates: Array.from({ length: 14489 }, (_, i) => candidate(i + 1)) });
  const out = await loadAndPlanLightTrial({
    env: { ...OPEN_ENV, LIGHT_TRIAL_AUTOGRANT_BATCH_SIZE: '10' }, nowMs: NOW, deps,
  });
  assert.equal(out.ok, true);
  assert.equal(out.planned.ok, true);
  assert.equal(out.planned.targets, 10);
  assert.equal(out.fetch.pagesFetched, 1);
  assert.equal(out.fetch.recordsFetched, 100);
  assert.equal(out.fetch.moreAvailable, true);
  assert.equal(out.fetch.remainingExact, null);
  assert.equal(out.planned.remaining, null, 'bounded では残数を出さない');
  // 候補 1 ページ + 関所 1 ページ だけ
  assert.ok(reads.length <= 2, `読み過ぎ: ${reads.length}`);
});

test('下見（override）と実行（env）が同じ指紋・同じ対象になる', async () => {
  const candidates = Array.from({ length: 500 }, (_, i) => candidate(i + 1));
  const a = await loadAndPlanLightTrial({
    env: { ...OPEN_ENV, LIGHT_TRIAL_AUTOGRANT_BATCH_SIZE: '10' }, nowMs: NOW,
    deps: makeDeps({ candidates }).deps,
  });
  const b = await loadAndPlanLightTrial({
    env: OPEN_ENV, nowMs: NOW, batchSizeOverride: 10,
    deps: makeDeps({ candidates }).deps,
  });
  assert.equal(a.planned.planFingerprint, b.planned.planFingerprint);
  assert.deepEqual(
    a.planned.plan.targets.map((t) => t.recordId),
    b.planned.plan.targets.map((t) => t.recordId),
  );
});

test('同じ本番状態なら同じ 10 名（決定的）', async () => {
  const candidates = Array.from({ length: 500 }, (_, i) => candidate(i + 1));
  const runs = [];
  for (let i = 0; i < 3; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    runs.push(await loadAndPlanLightTrial({
      env: OPEN_ENV, nowMs: NOW, batchSizeOverride: 10, deps: makeDeps({ candidates }).deps,
    }));
  }
  const fps = new Set(runs.map((r) => r.planned.planFingerprint));
  assert.equal(fps.size, 1, `指紋が揺れている: ${[...fps].join(' / ')}`);
});

test('関所に未案内が残っていれば次の batch は 0 件', async () => {
  const { deps } = makeDeps({
    candidates: Array.from({ length: 200 }, (_, i) => candidate(i + 1)),
    barrier: [{
      id: 'recGRANTED',
      fields: {
        Email: 'granted@example.com',
        Source: 'customer-import:imp-2026-08-09-001',
        ComebackGrantSource: AUTOGRANT_SOURCE,
        LightGrantUntil: day(20),
        LightGrantedAt: day(-1),
      },
    }],
    deliveries: [],
  });
  const out = await loadAndPlanLightTrial({ env: OPEN_ENV, nowMs: NOW, batchSizeOverride: 10, deps });
  assert.equal(out.planned.ok, false);
  assert.equal(out.planned.abort, AUTOGRANT_ABORT.WAITING_FOR_STEP1);
  assert.equal(out.planned.outstandingStep1, 1);
  assert.equal(out.planned.targets, 0);
  assert.equal(out.planned.planFingerprint, '');
});

test('Step1 が queue 済みなら関所は開いて次の batch へ進む', async () => {
  const campaign = getCampaign(TRIAL_SEQUENCE_ID);
  const step1 = resolveSequenceStep(campaign, 1);
  const email = 'granted@example.com';
  const key = computeCampaignDeliveryKey({
    campaign: step1, recipientEmail: email, brand: BRAND,
    fromEmail: getBrandConfig(BRAND).defaultFromEmail,
  });
  const { deps } = makeDeps({
    candidates: Array.from({ length: 200 }, (_, i) => candidate(i + 1)),
    barrier: [{
      id: 'recGRANTED',
      fields: {
        Email: email,
        Source: 'customer-import:imp-2026-08-09-001',
        ComebackGrantSource: AUTOGRANT_SOURCE,
        LightGrantUntil: day(20),
        LightGrantedAt: day(-1),
      },
    }],
    deliveries: [{ fields: { EmailType: 'campaign', Status: 'queued', DeliveryKey: key } }],
  });
  const out = await loadAndPlanLightTrial({ env: OPEN_ENV, nowMs: NOW, batchSizeOverride: 10, deps });
  assert.equal(out.planned.barrier.outstanding, 0);
  assert.equal(out.planned.barrier.nextBatchAllowed, true);
  assert.equal(out.planned.ok, true);
  assert.equal(out.planned.targets, 10);
});

test('ゲートが閉じていれば計画は作らない（副作用ゼロ）', async () => {
  const { deps } = makeDeps({ candidates: Array.from({ length: 200 }, (_, i) => candidate(i + 1)) });
  const out = await loadAndPlanLightTrial({
    env: { AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'b' }, nowMs: NOW, batchSizeOverride: 10, deps,
  });
  assert.equal(out.planned.ok, false);
  assert.equal(out.planned.abort, AUTOGRANT_ABORT.GATES_CLOSED);
  assert.ok((out.planned.gates.missing || []).includes('LIGHT_TRIAL_AUTOGRANT_ENABLED'));
  // 下見なので件数だけは出る
  assert.equal(out.planned.counts.batchSize, 10);
});

test('候補の取得上限に達したら fail closed（黙って少なく見せない）', async () => {
  const { deps } = makeDeps({
    candidates: Array.from({ length: 100000 }, (_, i) => ({
      ...candidate(i + 1),
      fields: { ...candidate(i + 1).fields, UnsubscribedAnalyticsKeiba: true },
    })),
  });
  const out = await loadAndPlanLightTrial({ env: OPEN_ENV, nowMs: NOW, batchSizeOverride: 10, deps });
  assert.equal(out.ok, false);
  assert.equal(out.abort, SELECTION_ABORT.CANDIDATE_SCAN_LIMIT);
  assert.equal(out.sideEffects, 'none');
});

test('関所の取得上限に達したら fail closed（outstanding=0 と言い切れない）', async () => {
  const { deps } = makeDeps({
    candidates: Array.from({ length: 200 }, (_, i) => candidate(i + 1)),
    barrier: Array.from({ length: 100000 }, (_, i) => ({
      id: `recB${i}`,
      fields: {
        Email: `b${i}@example.com`, ComebackGrantSource: AUTOGRANT_SOURCE, LightGrantUntil: day(20),
      },
    })),
  });
  const out = await loadAndPlanLightTrial({ env: OPEN_ENV, nowMs: NOW, batchSizeOverride: 10, deps });
  assert.equal(out.ok, false);
  assert.equal(out.abort, SELECTION_ABORT.BARRIER_SCAN_LIMIT);
  assert.equal(out.sideEffects, 'none');
});

test('Airtable 未設定なら何も読まない', async () => {
  const { deps, reads } = makeDeps({ candidates: [candidate(1)] });
  const out = await loadAndPlanLightTrial({ env: {}, nowMs: NOW, deps });
  assert.equal(out.ok, false);
  assert.equal(out.abort, 'airtable_not_configured');
  assert.equal(reads.length, 0);
});

test('読むのは Customers だけ（キュー登録・送信をしない）', async () => {
  const { deps, reads } = makeDeps({ candidates: Array.from({ length: 50 }, (_, i) => candidate(i + 1)) });
  await loadAndPlanLightTrial({ env: OPEN_ENV, nowMs: NOW, batchSizeOverride: 10, deps });
  for (const r of reads) assert.equal(r.table, 'Customers');
  // sort は必ず付く（決定的な順序）
  for (const r of reads) assert.deepEqual(r.sort, [{ field: 'Email', direction: 'asc' }]);
});
