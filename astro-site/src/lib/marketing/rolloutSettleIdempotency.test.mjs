/**
 * rolloutSettleIdempotency.test.mjs — 完了ジョブを**二度数えない**（2026-09-08 の本番異常）
 *   node --test src/lib/marketing/rolloutSettleIdempotency.test.mjs
 *
 * ## 再現する異常（本番実測）
 *
 * `queue:unverified` が付いたまま残った **PENDING** ジョブがあると、送信起動の
 * 直前 dry-run が `willSend 0` を返す。ジョブは `SENT` ではないので
 * `will_send_zero_unfinished` = **異常側**に分類され、運転手は auto-stop 経路
 * （`dispatch_failed`）へ入って**状態を保存せずに return** していた。
 *
 * その結果、
 *   - 完了ジョブが `pendingJobIds` から**永久に消えない**
 *   - 毎 tick 同じ完了ジョブを settle し直して `bumpSteps` を呼ぶ
 *
 * 本番の step4 `sent` は **68,168 → 70,918（5 時間で +2,750）**まで膨らんだ。
 * 実際の step4 送信は 862 通しかない。
 *
 * ## ここで固定すること
 *
 *   1. 何 tick 回しても、完了ジョブの計上は **1 回だけ**
 *   2. 追跡リスト（`pendingJobIds`）は**決断より前に永続化**される
 *   3. `queue:unverified` の PENDING ジョブを**勝手に印を外さない（promote しない）**
 *   4. 一時停止中でも**誤送信しない**（この経路で 1 通も出ない）
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createWorld } from './rolloutJourney.fake.mjs';
import { ROLLOUT_STAGE } from './rolloutPlan.js';

const CAMPAIGN_ID = 'light-trial-to-premium-sequence';
const DAY = 86400_000;
const START = Date.parse('2026-09-08T02:00:00Z');

const FINISHED_JOB = 'mkt-light-trial-to-premium-sequence-v1-finished0-1';
const UNVERIFIED_JOB = 'mkt-light-trial-to-premium-sequence-v1-unverif0-1';
const STEP = 4;
const SENT_COUNT = 50;

const ENV = Object.freeze({
  MARKETING_ROLLOUT_ENABLED: 'true',
  COMEBACK_GRANT_FIELDS_READY: '1',
  COMEBACK_GRANT_ENABLED: 'true',
  LIGHT_TRIAL_AUTOGRANT_ENABLED: 'true',
  MARKETING_CAMPAIGN_ENABLED: 'true',
  MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true',
  MARKETING_ADMIN_SECRET: 'test-secret',
  AIRTABLE_API_KEY: 'test-key',
  AIRTABLE_BASE_ID: 'appTEST',
  SENDGRID_API_KEY: 'SG.test',
  UPSTASH_REDIS_REST_URL: 'https://redis.invalid',
  UPSTASH_REDIS_REST_TOKEN: 'token',
  URL: 'https://analytics.keiba.link',
});

const people = () => Array.from({ length: 3 }, (_, i) => ({
  recordId: `recIDEM${String(i).padStart(10, '0')}`,
  email: `idem${i}@example.com`,
  fields: {
    LightGrantOp: 'light-trial-idempotency',
    LightGrantedAt: new Date(START - 3 * DAY).toISOString(),
    LightGrantUntil: new Date(START + 27 * DAY).toISOString(),
    ComebackGrantSource: 'light-trial-autogrant',
  },
}));

/** 本番と同じ形の 2 本のジョブを置く（完了済み 1 本 + 印付き PENDING 1 本） */
function seedJobs(world) {
  world.tables.ScheduledEmails.push({
    id: 'recJOBFINISHED01',
    fields: {
      JobId: FINISHED_JOB,
      Status: 'SENT',
      TargetPlan: `campaign:${CAMPAIGN_ID}`,
      CreatedBy: 'admin-marketing',
      Notes: `marketing campaign ${CAMPAIGN_ID} v1 content:06c2941d1507`,
      RecipientCount: SENT_COUNT,
      SentCount: SENT_COUNT,
      FailedCount: 0,
      ScheduledFor: new Date(START - 2 * DAY).toISOString(),
      CompletedAt: new Date(START - 2 * DAY + 600_000).toISOString(),
    },
  });
  world.tables.ScheduledEmails.push({
    id: 'recJOBUNVERIF01',
    fields: {
      JobId: UNVERIFIED_JOB,
      Status: 'PENDING',
      TargetPlan: `campaign:${CAMPAIGN_ID}`,
      CreatedBy: 'admin-marketing',
      // ⚠️ 送信前の最後の栓。**この印が付いている間は dispatcher が block する**
      Notes: `marketing campaign ${CAMPAIGN_ID} v1 content:06c2941d1507 / queue:unverified`,
      RecipientCount: 50,
      SentCount: 0,
      FailedCount: 0,
      ScheduledFor: new Date(START - 5 * DAY).toISOString(),
    },
  });
}

async function boot({ stage = ROLLOUT_STAGE.PAUSED } = {}) {
  const world = createWorld({ people: people() });
  seedJobs(world);
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  Object.assign(process.env, ENV);
  mock.timers.enable({ apis: ['Date'], now: START });

  const bg = await import('../../../netlify/functions/marketing-campaign-dispatch-background.js');
  globalThis.fetch = world.makeFetch({
    onBackground: async (body) => {
      await bg.handler({
        httpMethod: 'POST',
        headers: { 'x-admin-secret': ENV.MARKETING_ADMIN_SECRET },
        body: JSON.stringify(body),
      });
    },
  });

  const cron = await import('../../../netlify/functions/cron-marketing-rollout.js');
  const { createRolloutStore } = await import('./rolloutStore.js');
  const { createRolloutMetrics } = await import('./rolloutMetrics.js');
  const store = createRolloutStore({ cmd: world.redisCmd });
  const metrics = createRolloutMetrics({ cmd: world.redisCmd });

  const cur = await store.load(CAMPAIGN_ID);
  await store.save({
    campaignId: CAMPAIGN_ID,
    state: {
      ...cur.state,
      stage,
      alwaysArmed: false,
      dailyLimit: 0,
      // 運転手が「起動したジョブ」として追いかけている状態を再現する
      pendingJobIds: [FINISHED_JOB],
      jobSteps: { [FINISHED_JOB]: STEP },
    },
    expectedVersion: null,
  });

  const tick = (nowMs) => {
    mock.timers.setTime(nowMs);
    return cron.runRolloutTick({ env: process.env, now: nowMs });
  };
  const restore = () => {
    mock.timers.reset();
    globalThis.fetch = originalFetch;
    for (const k of Object.keys(ENV)) delete process.env[k];
    Object.assign(process.env, originalEnv);
  };
  const stepSent = async () => {
    const m = await metrics.read(CAMPAIGN_ID);
    return Number(((m.steps || {}).steps || {})[String(STEP)]?.sent ?? 0);
  };
  const pending = async () => (await store.load(CAMPAIGN_ID)).state.pendingJobIds;
  const jobOf = (jobId) => world.jobs().find((j) => j.JobId === jobId);

  return {
    world, tick, restore, store, metrics, stepSent, pending, jobOf,
  };
}

test('【再現→修正】完了ジョブの計上は、何 tick 回しても 1 回だけ', async () => {
  const ctx = await boot();
  try {
    assert.equal(await ctx.stepSent(), 0, '前提: 集計は空から始まる');

    await ctx.tick(START);
    const afterFirst = await ctx.stepSent();
    assert.equal(afterFirst, SENT_COUNT, `1 tick 目で ${SENT_COUNT} 通が計上されない`);

    // 本番と同じく 5 分ごとに回す
    await ctx.tick(START + 5 * 60_000);
    await ctx.tick(START + 10 * 60_000);
    await ctx.tick(START + 15 * 60_000);

    assert.equal(
      await ctx.stepSent(), SENT_COUNT,
      `同じ完了ジョブを数え直している（68,168 → 70,918 型の異常増加）`,
    );
  } finally { ctx.restore(); }
});

test('【再現→修正】追跡リストは決断より前に永続化される（auto-stop 経路でも失われない）', async () => {
  const ctx = await boot();
  try {
    assert.deepEqual(await ctx.pending(), [FINISHED_JOB], '前提: 完了ジョブを追跡している');
    await ctx.tick(START);
    assert.equal(
      (await ctx.pending()).includes(FINISHED_JOB), false,
      '送信できない PENDING ジョブがあると、片付けが保存されないまま戻っている',
    );
    // 2 tick 目以降も戻らない
    await ctx.tick(START + 5 * 60_000);
    assert.equal((await ctx.pending()).includes(FINISHED_JOB), false);
  } finally { ctx.restore(); }
});

test('【安全】`queue:unverified` の PENDING ジョブを勝手に promote しない', async () => {
  const ctx = await boot();
  try {
    for (const t of [0, 5, 10]) await ctx.tick(START + t * 60_000);
    const job = ctx.jobOf(UNVERIFIED_JOB);
    assert.equal(job.Status, 'PENDING', 'PENDING のまま残っていない');
    assert.match(String(job.Notes), /queue:unverified/, '送信前の印が外れている');
    assert.equal(Number(job.SentCount) || 0, 0, '送信済みになっている');
  } finally { ctx.restore(); }
});

test('【安全】一時停止中は 1 通も送らない（この経路で誤送信しない）', async () => {
  const ctx = await boot({ stage: ROLLOUT_STAGE.PAUSED });
  try {
    for (const t of [0, 5, 10, 15]) await ctx.tick(START + t * 60_000);
    assert.equal(ctx.world.sent.length, 0, `${ctx.world.sent.length} 通 送信してしまった`);
    assert.equal(ctx.world.calls.background, 0, '送信 Function を起動している');
  } finally { ctx.restore(); }
});

test('【安全】展開中（steady）でも、印付き PENDING では送らない・二重計上もしない', async () => {
  const ctx = await boot({ stage: ROLLOUT_STAGE.STEADY });
  try {
    for (const t of [0, 5, 10]) await ctx.tick(START + t * 60_000);
    assert.equal(ctx.world.sent.length, 0, '印が付いたまま送信している');
    assert.equal(await ctx.stepSent(), SENT_COUNT, '完了ジョブを数え直している');
    assert.equal((await ctx.pending()).includes(FINISHED_JOB), false);
  } finally { ctx.restore(); }
});
