/**
 * 週次（`cron-sendgrid-weekly.js`）へ元々の会員を足す配線の guard と、監視の要約。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { summarizeNativeWeekly, buildMarketingOverview } from './marketingOverview.js';
import { NATIVE_GATE_ENV, isNativeGateOpen, NATIVE_LIST_PREFIX } from './nativeWeeklyConfig.js';
import { isOnboardingPending, resolveNativeWeeklyEligibility, NATIVE_WEEKLY_SKIP } from './nativeWeeklyAudience.js';
import { SEQ_STATUS } from './sequenceProgress.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const CRON = read('../../../netlify/functions/cron-sendgrid-weekly.js');
const TOML = read('../../../netlify.toml');

test('gate は明示的な true だけ', () => {
  assert.equal(NATIVE_GATE_ENV, 'SENDGRID_WEEKLY_NATIVE_ENABLED');
  assert.equal(isNativeGateOpen({}), false);
  assert.equal(isNativeGateOpen({ [NATIVE_GATE_ENV]: '1' }), false);
  assert.equal(isNativeGateOpen({ [NATIVE_GATE_ENV]: 'true' }), true);
});

test('native の手順は gate が開いているときだけ呼ぶ', () => {
  const i = CRON.indexOf('if (isNativeGateOpen(process.env)) {');
  const call = CRON.indexOf('await runNativeStepForSlot(');
  assert.ok(i > 0 && call > i);
  assert.equal((CRON.match(/await runNativeStepForSlot\(/g) || []).length, 1);
});

test('gate が閉じていれば宛先は従来どおり ak-drm-engaged の 1 本だけ', () => {
  assert.match(CRON, /send_to: \{ list_ids: native\.enabled \? buildSendToListIds\(\{ engagedListId: plan\.slot\.listId, nativeListId: native\.listId, nativeReady: native\.ready \}\) : \[plan\.slot\.listId\] \}/);
  assert.match(CRON, /let native = \{ enabled: false \};/);
});

test('週次の既存の門（gate / engine / 許可パス）はそのまま', () => {
  assert.match(CRON, /WEEKLY_GATE_ENV\] \|\| ''\)\.trim\(\) !== 'true'/);
  assert.match(CRON, /resolveProspectEngine\(process\.env\) !== 'sendgrid'/);
  assert.ok(CRON.includes('/^\\/v3\\/marketing\\/(lists|singlesends)/'));
  assert.ok(!CRON.includes('/v3/mail/send'));
});

test('定期実行の式はコードと netlify.toml で同じ', () => {
  const code = /export const config = \{ schedule: '([^']+)' \}/.exec(CRON);
  const toml = /\[functions\."cron-sendgrid-weekly"\]\s*\n\s*schedule = "([^"]+)"/.exec(TOML);
  assert.ok(code && toml);
  assert.equal(code[1], toml[1]);
});

test('監視: AK の判定人数と list 人数が一致しているかを出す（読めなければ null）', () => {
  const s = summarizeNativeWeekly({
    enabled: true,
    state: { dateKey: '2026-09-30', status: 'ready', expected: 1400, listCount: 1400, rejected: 2, audience: { skip: { active_paid_member: 22 } } },
    lists: [{ name: `${NATIVE_LIST_PREFIX}2026-09-26`, contactCount: 1390 }, { name: `${NATIVE_LIST_PREFIX}2026-09-30`, contactCount: 1400 }, { name: 'ak-drm-engaged', contactCount: 808 }],
  });
  assert.equal(s['一致'], true);
  assert.equal(s['AK判定人数'], 1400);
  assert.deepEqual(s['最新list'], { list: `${NATIVE_LIST_PREFIX}2026-09-30`, 人数: 1400 });
  assert.equal(s['list数'], 2);
  assert.equal(summarizeNativeWeekly({ enabled: true, state: { expected: 5, listCount: 4 } })['一致'], false);
  const none = summarizeNativeWeekly({ enabled: false });
  assert.deepEqual([none['有効'], none['一致'], none['AK判定人数']], [false, null, null]);
  const o = buildMarketingOverview({ nativeEnabled: true, nativeState: { status: 'importing', expected: 3 } });
  assert.equal(o['週次']['元々の会員']['状態'], 'importing');
  assert.ok(!JSON.stringify(o).includes('@'));
});

test('これから始まる育成（自動開始の窓の中）は対象外・作成時刻不明も対象外', () => {
  const now = Date.parse('2026-09-30T00:00:00Z');
  const notStarted = { status: SEQ_STATUS.DUE, currentStep: 0 };
  assert.equal(isOnboardingPending({ progress: notStarted, createdTimeMs: now - 3 * 86400000, withinDays: 14, nowMs: now }), true);
  assert.equal(isOnboardingPending({ progress: notStarted, createdTimeMs: now - 30 * 86400000, withinDays: 14, nowMs: now }), false);
  assert.equal(isOnboardingPending({ progress: notStarted, createdTimeMs: null, withinDays: 14, nowMs: now }), true);
  assert.equal(isOnboardingPending({ progress: { status: SEQ_STATUS.STOPPED, currentStep: 0 }, createdTimeMs: now, withinDays: 14, nowMs: now }), false);
  const fields = { Email: 'm@example.jp' };
  const r = resolveNativeWeeklyEligibility({
    fields, marketing: {}, baseExclusion: null, onboardingProgress: notStarted,
    createdTimeMs: now - 30 * 86400000, onboardingWithinDays: 14, inEngagedList: true, nowMs: now,
  });
  assert.equal(r.reason, NATIVE_WEEKLY_SKIP.IN_ENGAGED_LIST);
});
