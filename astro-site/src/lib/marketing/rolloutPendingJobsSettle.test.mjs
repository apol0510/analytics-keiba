/**
 * rolloutPendingJobsSettle.test.mjs — 追跡中ジョブ（`pendingJobIds`）が**必ず片付く**
 *   node --test src/lib/marketing/rolloutPendingJobsSettle.test.mjs
 *
 * ## 何を固定するか（2026-09-08 の本番調査）
 *
 * 運転手は起動したジョブを `pendingJobIds` で追いかけ、終わったら外す。
 * ところが外す代入が **「実績を写したときだけ」** の内側にあり、
 * さらにジョブ照会の失敗が `.catch(() => null)` で握り潰されていた。
 *
 * 実測: 2026-09-03T06:35Z に送信完了したジョブ `…-8baffb52-1` が
 * **5 日後もまだ `pendingJobIds` に残っていた**。同時刻以降、PENDING のまま
 * 送信されないジョブ（50 名）も残っており、外からは「静かに何もしていない」
 * としか見えなかった（理由がログに出ない）。
 *
 * 直した形:
 *   - ジョブを**読めた tick では必ず**追跡リストを書き戻す
 *   - 書き戻す必要がある SKIP tick では**状態を保存する**
 *   - 読めなかった理由を**ログに出す**（握り潰さない）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { collectFinishedJobs } from '../../../netlify/functions/cron-marketing-rollout.js';
import { tickRollout, TICK_ACTION } from './rolloutOrchestrator.js';
import { defaultRolloutState, ROLLOUT_STAGE } from './rolloutPlan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '../../../netlify/functions/cron-marketing-rollout.js'), 'utf8');
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');

test('【再現】送信完了したジョブは追跡から外れる', () => {
  const r = collectFinishedJobs({
    pendingJobIds: ['mkt-x-v1-8baffb52-1'],
    byId: new Map([['mkt-x-v1-8baffb52-1', { status: 'SENT', sentCount: 50, failedCount: 0 }]]),
    jobSteps: { 'mkt-x-v1-8baffb52-1': 4 },
  });
  assert.deepEqual(r.stillRunning, [], '完了ジョブが追跡に残っている');
  assert.equal(r.finished.length, 1);
  assert.equal(r.sent, 50);
  assert.deepEqual(r.byStep, { 4: { sent: 50, failed: 0 } });
});

test('まだ PENDING のジョブ・見えないジョブは残す（勝手に捨てない）', () => {
  const r = collectFinishedJobs({
    pendingJobIds: ['pending', 'unknown'],
    byId: new Map([['pending', { status: 'PENDING', sentCount: 0, failedCount: 0 }]]),
  });
  assert.deepEqual(r.stillRunning, ['pending', 'unknown']);
  assert.equal(r.finished.length, 0);
});

// ── 配線（この修正が実経路に入っていること）──────────────────────
test('【配線】ジョブを読めた tick では必ず追跡リストを書き戻す', () => {
  assert.match(
    CODE, /if \(jobs\) state\.pendingJobIds = settledJobs\.stillRunning;/,
    '「実績を写したときだけ」書き戻す旧実装へ戻っている',
  );
});

test('【配線】追跡リストが変わった SKIP tick は状態を保存する', () => {
  assert.match(CODE, /const pendingJobIdsChanged = Boolean\(jobs\)/);
  const skipBlock = CODE.slice(CODE.indexOf('TICK_ACTION.SKIP'), CODE.indexOf('TICK_ACTION.GRANT'));
  assert.ok(
    skipBlock.includes('pendingJobIdsChanged'),
    'SKIP tick で書き戻さないため、古い ID が残り続ける',
  );
});

test('【配線】ジョブ照会の失敗を握り潰さない（理由をログに出す）', () => {
  assert.equal(
    /\.catch\(\(\) => null\);\s*\n\s*reads\.push\(TICK_READ\.JOBS\)/.test(CODE), false,
    '理由を捨てる `.catch(() => null)` へ戻っている',
  );
  assert.match(CODE, /warn: 'jobs_unreadable'/, '読めなかった事実がログに出ない');
});

test('【不変】送信待ちがあれば一時停止中でも送信起動を優先する（積んだメールを放置しない）', () => {
  const state = { ...defaultRolloutState(), stage: ROLLOUT_STAGE.PAUSED, killed: false };
  const env = {
    MARKETING_ROLLOUT_ENABLED: 'true',
    MARKETING_CAMPAIGN_ENABLED: 'true',
    MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true',
    COMEBACK_GRANT_FIELDS_READY: 'true',
    COMEBACK_GRANT_ENABLED: 'true',
    LIGHT_TRIAL_AUTOGRANT_ENABLED: 'true',
  };
  const decision = tickRollout({
    state, nowMs: Date.parse('2026-09-08T02:00:00Z'), envEnabled: false,
    facts: { pendingJobs: 1 }, env,
  });
  assert.equal(
    decision.action, TICK_ACTION.DISPATCH,
    `一時停止中に送信待ちが放置される: ${decision.action} / ${decision.reason}`,
  );
});

test('【不変】緊急停止（killed）は送信起動より強い', () => {
  const state = { ...defaultRolloutState(), killed: true };
  const decision = tickRollout({
    state, nowMs: Date.now(), envEnabled: true, facts: { pendingJobs: 1 }, env: {},
  });
  assert.equal(decision.action, TICK_ACTION.SKIP);
});
