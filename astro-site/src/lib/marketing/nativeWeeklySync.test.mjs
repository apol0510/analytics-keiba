/**
 * 元々の会員の週次 list の判定と計画（`nativeWeeklySync.js`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNativeAudience, planNativeStage, evaluateImport, buildSendToListIds, planListCleanup,
  nativeListName, dateKeyOfNativeList, emailSetDigest, summarizeNativeAudience,
  NATIVE_STAGE, NATIVE_STATUS, NATIVE_FAIL, BUILD_LEAD_MS, SCHEDULE_DEADLINE_MS,
} from './nativeWeeklySync.js';
import { NATIVE_WEEKLY_SKIP, ONBOARDING_CAMPAIGN_ID } from './nativeWeeklyAudience.js';
import { getCampaign } from './campaignCatalog.js';
import { resolveSequenceStep } from './campaignSequence.js';
import { computeCampaignDeliveryKey } from './campaignSend.js';
import { indexDeliveries } from './sequenceProgress.js';
import { IMPORT_SOURCE_PREFIX } from './importCohort.js';

const DAY = 86400000;
const NOW = Date.parse('2026-09-30T00:00:00Z');
const BRAND = 'analytics-keiba';
const FROM = 'noreply@keiba.link';
const CAMPAIGN = getCampaign(ONBOARDING_CAMPAIGN_ID, { includeDisabled: true });
const OLD = new Date(NOW - 400 * DAY).toISOString();

const rec = (n, extra = {}, createdTime = OLD) => ({ id: `rec${String(n).padStart(14, '0')}`, createdTime, fields: { Email: `m${n}@example.jp`, Status: 'active', ...extra } });
const delivered = (email, step) => ({
  fields: {
    EmailType: 'campaign', RecipientEmail: email, Status: 'sent', SentAt: new Date(NOW - 2 * DAY).toISOString(),
    DeliveryKey: computeCampaignDeliveryKey({ campaign: resolveSequenceStep(CAMPAIGN, step), recipientEmail: email, brand: BRAND, fromEmail: FROM }),
  },
});

const inputs = (customers, over = {}) => ({
  customers,
  nowMs: NOW,
  blacklistHard: new Set(),
  blacklistSoft: new Set(),
  providerSuppressed: new Set(),
  onboarding: { campaign: CAMPAIGN, deliveredIndex: indexDeliveries([]), brand: BRAND, fromEmail: FROM, withinDays: 14 },
  engagedEmails: new Set(),
  ...over,
});

const PREMIUM = { 'プラン': 'Premium', '有効期限': '2027-06-01' };
const LIGHT = { 'プラン': 'Light', '有効期限': '2027-06-01' };

test('対象: 元々の会員・基本的に送信可能・無料/期限切れ', () => {
  const b = buildNativeAudience(inputs([rec(1), rec(2, { 'プラン': 'Premium', '有効期限': '2026-01-01' })]));
  assert.equal(b.ok, true);
  assert.deepEqual(b.emails, ['m1@example.jp', 'm2@example.jp']);
});

test('対象外: 現役 Premium / Light・取り込み由来', () => {
  const b = buildNativeAudience(inputs([rec(1, PREMIUM), rec(2, LIGHT), rec(3, { Source: `${IMPORT_SOURCE_PREFIX}x` }), rec(4)]));
  assert.deepEqual(b.emails, ['m4@example.jp']);
  assert.equal(b.counts.skip[NATIVE_WEEKLY_SKIP.ACTIVE_PAID_MEMBER], 2);
  assert.equal(b.counts.skip.not_native, 1);
});

test('対象外: 配信停止・blacklist・配信基盤の停止リスト（基本的な送信可否）', () => {
  const b = buildNativeAudience(inputs(
    [rec(1, { UnsubscribedAnalyticsKeiba: true }), rec(2), rec(3), rec(4), rec(5)],
    { blacklistHard: new Set(['m2@example.jp']), blacklistSoft: new Set(['m2@example.jp', 'm3@example.jp']), providerSuppressed: new Set(['m4@example.jp']) },
  ));
  assert.deepEqual(b.emails, ['m5@example.jp']);
  assert.deepEqual(b.counts.baseExcluded, { unsubscribed: 1, blacklist_hard: 1, blacklist_soft: 1, provider_suppressed: 1 });
});

test('対象外: DRM 育成の受信中（1 通目のあと）と、これから始まる新規登録', () => {
  const idx = indexDeliveries([delivered('m1@example.jp', 1)]);
  const b = buildNativeAudience(inputs(
    [rec(1), rec(2, {}, new Date(NOW - 3 * DAY).toISOString()), rec(3)],
    { onboarding: { campaign: CAMPAIGN, deliveredIndex: idx, brand: BRAND, fromEmail: FROM, withinDays: 14 } },
  ));
  assert.deepEqual(b.emails, ['m3@example.jp']);
  assert.equal(b.counts.skip[NATIVE_WEEKLY_SKIP.DRM_ONBOARDING_ACTIVE], 1);
  assert.equal(b.counts.skip[NATIVE_WEEKLY_SKIP.DRM_ONBOARDING_PENDING], 1);
});

test('DRM 育成を 6 通終えた人は対象に戻る（受信歴だけで永久除外しない）', () => {
  const idx = indexDeliveries([1, 2, 3, 4, 5, 6].map((n) => delivered('m1@example.jp', n)));
  const b = buildNativeAudience(inputs([rec(1)], { onboarding: { campaign: CAMPAIGN, deliveredIndex: idx, brand: BRAND, fromEmail: FROM, withinDays: 14 } }));
  assert.deepEqual(b.emails, ['m1@example.jp']);
});

test('対象外: 既に ak-drm-engaged に入っている人（重複排除に頼らない）', () => {
  const b = buildNativeAudience(inputs([rec(1), rec(2)], { engagedEmails: new Set(['m1@example.jp']) }));
  assert.deepEqual(b.emails, ['m2@example.jp']);
  assert.equal(b.counts.skip[NATIVE_WEEKLY_SKIP.IN_ENGAGED_LIST], 1);
});

test('判定材料が 1 つでも無ければ list を作らない（fail closed）', () => {
  for (const [k, v] of [
    ['blacklistHard', null], ['providerSuppressed', null], ['engagedEmails', null],
    ['onboarding', { campaign: CAMPAIGN, deliveredIndex: null, withinDays: 14 }],
    ['onboarding', { campaign: CAMPAIGN, deliveredIndex: indexDeliveries([]), withinDays: null }],
    ['customers', null],
  ]) {
    const b = buildNativeAudience(inputs([rec(1)], { [k]: v }));
    assert.equal(b.ok, false, k);
    assert.equal(b.reason, NATIVE_FAIL.INPUT_UNAVAILABLE);
  }
});

test('同じアドレスが 2 件ある人は入れない・要約にアドレスを出さない', () => {
  const b = buildNativeAudience(inputs([rec(1), { ...rec(9), fields: { ...rec(9).fields, Email: 'm1@example.jp' } }, rec(2)]));
  assert.deepEqual(b.emails, ['m2@example.jp']);
  const s = JSON.stringify(summarizeNativeAudience(b));
  assert.ok(!s.includes('@'), s);
  assert.ok(!/rec\d{14}/.test(s));
});

test('digest は並び順に依らず、中身が変われば変わる', () => {
  assert.equal(emailSetDigest(['b@x.jp', 'a@x.jp']), emailSetDigest(['A@x.jp', 'b@x.jp']));
  assert.notEqual(emailSetDigest(['a@x.jp']), emailSetDigest(['a@x.jp', 'c@x.jp']));
});

// ─── 段階 ────────────────────────────────────────────────────

const SLOT = Date.parse('2026-09-30T10:00:00Z');
const at = (msBefore) => SLOT - msBefore;

test('段階: 枠の 12 時間前までは待つ → 作る → 確認 → ready なら足す', () => {
  assert.equal(planNativeStage({ nowMs: at(BUILD_LEAD_MS + 1), slotMs: SLOT, state: null }).stage, NATIVE_STAGE.WAIT);
  assert.equal(planNativeStage({ nowMs: at(BUILD_LEAD_MS), slotMs: SLOT, state: null }).stage, NATIVE_STAGE.BUILD);
  assert.equal(planNativeStage({ nowMs: at(6 * 3600e3), slotMs: SLOT, state: { status: NATIVE_STATUS.IMPORTING } }).stage, NATIVE_STAGE.CHECK);
  assert.equal(planNativeStage({ nowMs: at(6 * 3600e3), slotMs: SLOT, state: { status: NATIVE_STATUS.READY } }).stage, NATIVE_STAGE.SCHEDULE_WITH_NATIVE);
  assert.equal(planNativeStage({ nowMs: at(6 * 3600e3), slotMs: SLOT, state: { status: NATIVE_STATUS.SCHEDULED } }).stage, NATIVE_STAGE.WAIT);
});

test('段階: 枠の 2 時間前までに ready でなければ native を足さずに予約する', () => {
  for (const state of [null, { status: NATIVE_STATUS.IMPORTING }]) {
    const p = planNativeStage({ nowMs: at(SCHEDULE_DEADLINE_MS), slotMs: SLOT, state });
    assert.equal(p.stage, NATIVE_STAGE.SCHEDULE_WITHOUT_NATIVE, JSON.stringify(state));
  }
  // ready なら締め切り後でも足す
  assert.equal(planNativeStage({ nowMs: at(60e3), slotMs: SLOT, state: { status: NATIVE_STATUS.READY } }).stage, NATIVE_STAGE.SCHEDULE_WITH_NATIVE);
  assert.equal(planNativeStage({ nowMs: at(6 * 3600e3), slotMs: SLOT, state: { status: NATIVE_STATUS.FAILED } }).stage, NATIVE_STAGE.SCHEDULE_WITHOUT_NATIVE);
});

test('ready の条件: job が全部 completed かつ list 人数 = AK の判定人数', () => {
  assert.equal(evaluateImport({ jobs: [{ status: 'completed' }], listCount: 10, expected: 10 }).status, 'ready');
  assert.equal(evaluateImport({ jobs: [{ status: 'completed' }], listCount: 9, expected: 10 }).status, 'pending');
  assert.equal(evaluateImport({ jobs: [{ status: 'completed' }], listCount: null, expected: 10 }).status, 'pending');
  assert.equal(evaluateImport({ jobs: [{ status: 'pending' }, { status: 'completed' }], listCount: 10, expected: 10 }).status, 'pending');
  assert.equal(evaluateImport({ jobs: [{ status: 'failed' }], listCount: 10, expected: 10 }).status, 'failed');
  assert.equal(evaluateImport({ jobs: [], listCount: 10, expected: 10 }).status, 'failed');
});

test('宛先: native は ready のときだけ足す', () => {
  assert.deepEqual(buildSendToListIds({ engagedListId: 'E', nativeListId: 'N', nativeReady: true }), ['E', 'N']);
  assert.deepEqual(buildSendToListIds({ engagedListId: 'E', nativeListId: 'N', nativeReady: false }), ['E']);
  assert.deepEqual(buildSendToListIds({ engagedListId: 'E', nativeListId: null, nativeReady: true }), ['E']);
});

test('片付け: 7 日より前の native list だけ・参照中は残す・参照を読めなければ消さない', () => {
  const lists = [
    { id: '1', name: nativeListName('2026-09-01') },
    { id: '2', name: nativeListName('2026-09-25') },
    { id: '3', name: nativeListName('2026-09-02') },
    { id: '4', name: 'ak-drm-engaged' },
    { id: '5', name: 'ak-prospect-select-start-1' },
  ];
  assert.deepEqual(planListCleanup({ lists, referencedListIds: new Set(['3']), nowMs: NOW }), ['1']);
  assert.deepEqual(planListCleanup({ lists, referencedListIds: null, nowMs: NOW }), []);
  assert.equal(dateKeyOfNativeList('ak-drm-engaged'), null);
  assert.equal(dateKeyOfNativeList(nativeListName('2026-09-30')), '2026-09-30');
});
