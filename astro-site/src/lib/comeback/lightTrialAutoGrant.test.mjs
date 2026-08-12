/**
 * lightTrialAutoGrant.test.mjs — Light 30日無料体験の自動付与（入口）
 *   node --test src/lib/comeback/lightTrialAutoGrant.test.mjs
 *
 * 重点:
 *   - **CSV 取り込みの会員だけ**が候補（従来からの無料会員は対象外）
 *   - 有料 / 期限なし付与 / 付与中 / 過去に付与済み / 配信不可 は除外
 *   - ゲートが 1 つでも欠ければ何も書かない
 *   - **付与に成功した人だけ**が Step1 の対象（順序保証）
 *   - コホートを観測できなければ誰にも付与しない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  readAutoGrantGates, checkAutoGrantCandidate, selectAutoGrantCandidates,
  planAutoGrantRun, recipientsAfterGrant, summarizeAutoGrantRun,
  AUTOGRANT_ENV, AUTOGRANT_ABORT, AUTOGRANT_SKIP, TRIAL_OFFER_ID, MAX_GRANTS_PER_RUN,
} from './lightTrialAutoGrant.js';
import { buildComebackPlan } from './comebackGrantPlan.js';
import { resolveOffer } from '../promotions/promotionOfferCatalog.js';
import { resolveCustomerMarketing } from '../marketing/customerMarketingAudience.js';
import { jstDateString } from '../marketing/campaignSend.js';

const DAY = 86400000;
const NOW = Date.UTC(2026, 7, 20, 3, 0);
const TODAY = jstDateString(NOW);
const OFFER = resolveOffer(TRIAL_OFFER_ID).offer;

const OPEN_ENV = {
  [AUTOGRANT_ENV.FIELDS_READY]: '1',
  [AUTOGRANT_ENV.GRANT_ENABLED]: 'true',
  [AUTOGRANT_ENV.ENABLED]: 'true',
  [AUTOGRANT_ENV.ARMED]: TODAY,
  [AUTOGRANT_ENV.ENQUEUE]: 'true',
  [AUTOGRANT_ENV.DISPATCH]: 'true',
};

const row = (email, over = {}) => {
  const fields = { Email: email, Status: 'active', Source: 'customer-import:imp-A', ...over };
  return { recordId: `rec-${email}`, fields, marketing: resolveCustomerMarketing({ fields, nowMs: NOW }) };
};

// ── ゲート ──────────────────────────────────────────────────
test('6 つ揃って初めて開く（既存の付与ゲートも要求する）', () => {
  assert.equal(readAutoGrantGates(OPEN_ENV, NOW).allOpen, true);
  for (const key of Object.values(AUTOGRANT_ENV)) {
    const env = { ...OPEN_ENV };
    delete env[key];
    assert.equal(readAutoGrantGates(env, NOW).allOpen, false, `${key} が無くても開いてしまう`);
  }
  // 手動付与と同じゲートを再利用している（抜け道を作らない）
  assert.equal(AUTOGRANT_ENV.FIELDS_READY, 'COMEBACK_GRANT_FIELDS_READY');
  assert.equal(AUTOGRANT_ENV.GRANT_ENABLED, 'COMEBACK_GRANT_ENABLED');
});

test('武装は当日の JST 日付のみ有効', () => {
  const stale = { ...OPEN_ENV, [AUTOGRANT_ENV.ARMED]: jstDateString(NOW - DAY) };
  assert.equal(readAutoGrantGates(stale, NOW).allOpen, false);
});

// ── 候補判定 ────────────────────────────────────────────────
test('【重要】CSV 取り込みの会員だけが候補', () => {
  const inCohort = checkAutoGrantCandidate({ ...row('a@example.com'), nowMs: NOW });
  assert.equal(inCohort.ok, true);

  const legacy = row('b@example.com');
  delete legacy.fields.Source;
  const outside = checkAutoGrantCandidate({ fields: legacy.fields, marketing: legacy.marketing, nowMs: NOW });
  assert.equal(outside.ok, false);
  assert.equal(outside.reason, AUTOGRANT_SKIP.NOT_IN_COHORT);
});

test('有料会員・期限なし付与・付与中・過去付与・配信不可は候補外', () => {
  const cases = [
    [{ 'プラン': 'Premium', '有効期限': '2027-01-01' }, AUTOGRANT_SKIP.PAID_MEMBER],
    [{ LightGrantLifetime: true }, AUTOGRANT_SKIP.GRANT_LIFETIME],
    [{ LightGrantUntil: new Date(NOW + 10 * DAY).toISOString() }, AUTOGRANT_SKIP.GRANT_ACTIVE],
    [{ LightGrantUntil: new Date(NOW - 10 * DAY).toISOString() }, AUTOGRANT_SKIP.GRANTED_BEFORE],
    [{ UnsubscribedAnalyticsKeiba: true }, AUTOGRANT_SKIP.NOT_SENDABLE],
  ];
  for (const [over, reason] of cases) {
    const r = row('c@example.com', over);
    const got = checkAutoGrantCandidate({ fields: r.fields, marketing: r.marketing, nowMs: NOW });
    assert.equal(got.ok, false, `候補にしてしまった: ${JSON.stringify(over)}`);
    assert.equal(got.reason, reason, JSON.stringify(over));
  }
});

test('【重要】過去に無料付与を受けた人へは再付与しない', () => {
  const past = row('d@example.com', { LightGrantedAt: new Date(NOW - 200 * DAY).toISOString() });
  const got = checkAutoGrantCandidate({ fields: past.fields, marketing: past.marketing, nowMs: NOW });
  assert.equal(got.ok, false);
  assert.equal(got.reason, AUTOGRANT_SKIP.GRANTED_BEFORE);
});

test('dry-run の内訳（コホート総数 / 候補 / 理由別）が出る', () => {
  const legacy = row('old@example.com');
  delete legacy.fields.Source;
  const sel = selectAutoGrantCandidates({
    records: [row('a@example.com'), legacy, row('paid@example.com', { 'プラン': 'Light', '有効期限': '2027-01-01' })],
    nowMs: NOW,
  });
  assert.equal(sel.counts.cohortTotal, 2, 'コホート総数');
  assert.equal(sel.counts.candidates, 1, '付与候補');
  assert.equal(sel.counts.byReason[AUTOGRANT_SKIP.NOT_IN_COHORT], 1);
  assert.equal(sel.counts.byReason[AUTOGRANT_SKIP.PAID_MEMBER], 1);
});

test('同一アドレスの重複レコードは 1 人ぶん', () => {
  const a = row('dup@example.com');
  const b = { ...row('dup@example.com'), recordId: 'rec-dup2' };
  const sel = selectAutoGrantCandidates({ records: [a, b], nowMs: NOW });
  assert.equal(sel.counts.candidates, 1);
});

// ── 実行計画 ────────────────────────────────────────────────
const selOf = (records) => selectAutoGrantCandidates({ records, nowMs: NOW });

test('【重要】ゲートが閉じていれば計画を作らない', () => {
  const plan = planAutoGrantRun({
    selection: selOf([row('a@example.com')]), gates: readAutoGrantGates({}, NOW), offer: OFFER,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, AUTOGRANT_ABORT.GATES_CLOSED);
});

test('【重要】コホートを観測できなければ誰にも付与しない', () => {
  const legacy = row('old@example.com');
  delete legacy.fields.Source;
  const plan = planAutoGrantRun({
    selection: selOf([legacy]), gates: readAutoGrantGates(OPEN_ENV, NOW), offer: OFFER,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, AUTOGRANT_ABORT.COHORT_UNVERIFIABLE);
});

test('上限超過は切り捨てずに中止', () => {
  const many = Array.from({ length: 3 }, (_, i) => row(`u${i}@example.com`));
  const plan = planAutoGrantRun({
    selection: selOf(many), gates: readAutoGrantGates(OPEN_ENV, NOW), offer: OFFER, maxGrants: 2,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, AUTOGRANT_ABORT.OVER_MAX);
  assert.equal(MAX_GRANTS_PER_RUN, 100);
});

test('別の特典では実行しない（30日無料のみ）', () => {
  const plan = planAutoGrantRun({
    selection: selOf([row('a@example.com')]), gates: readAutoGrantGates(OPEN_ENV, NOW),
    offer: resolveOffer('light-lifetime-free').offer,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.abort, AUTOGRANT_ABORT.OFFER_UNAVAILABLE);
});

// ── 既存 planner の再利用と順序保証 ─────────────────────────
test('付与の形は既存 planner が作る（このモジュールは複製しない）', () => {
  const sel = selOf([row('a@example.com')]);
  const plan = planAutoGrantRun({ selection: sel, gates: readAutoGrantGates(OPEN_ENV, NOW), offer: OFFER });
  assert.equal(plan.ok, true);

  const grantPlan = buildComebackPlan({
    grantOffers: [OFFER], purchaseOffer: null, selected: plan.candidates,
    nowMs: NOW, operationId: `light-trial-${TODAY}`, actor: 'cron-light-trial', source: 'light-trial-autogrant',
  });
  assert.equal(grantPlan.ok, true);
  assert.equal(grantPlan.targets.length, 1);
  const f = grantPlan.targets[0].grantFields;
  assert.ok(f.LightGrantUntil, '期限付きで付与される');
  assert.equal(f.LightGrantLifetime, false);
  assert.ok(String(f.LightGrantOp).includes('light-trial'), 'operationId が刻まれる（冪等性の要）');
});

test('【重要】付与に成功した人だけが Step1 の対象になる', () => {
  const targets = [{ recordId: 'rec-1' }, { recordId: 'rec-2' }, { recordId: 'rec-3' }];
  // rec-2 だけ書き込みに失敗した状況
  const ok = recipientsAfterGrant({ targets, writtenRecordIds: ['rec-1', 'rec-3'] });
  assert.deepEqual(ok, ['rec-1', 'rec-3']);
  // 1 件も成功しなければ誰にも送らない
  assert.deepEqual(recipientsAfterGrant({ targets, writtenRecordIds: [] }), []);
});

test('同じ operationId で 2 回計画しても付与内容は同じ（冪等）', () => {
  const sel = selOf([row('a@example.com')]);
  const mk = () => buildComebackPlan({
    grantOffers: [OFFER], purchaseOffer: null, selected: sel.candidates,
    nowMs: NOW, operationId: 'light-trial-2026-08-20', actor: 'cron-light-trial', source: 'x',
  });
  assert.deepEqual(mk().targets[0].grantFields, mk().targets[0].grantFields);
  assert.equal(mk().planFingerprint, mk().planFingerprint);
});

test('要約にアドレスも recordId も含めない', () => {
  const sel = selOf([row('a@example.com')]);
  const plan = planAutoGrantRun({ selection: sel, gates: readAutoGrantGates(OPEN_ENV, NOW), offer: OFFER });
  const json = JSON.stringify(summarizeAutoGrantRun({ plan, granted: 1, queued: 1 }));
  assert.equal(/@example\.com/.test(json), false);
  assert.equal(/rec-/.test(json), false);
});
