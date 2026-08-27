/**
 * rolloutApiBudget.test.mjs — **空振りの tick が高くつかない**ことを固定する
 *
 *   node --test src/lib/marketing/rolloutApiBudget.test.mjs
 *
 * ── なぜ要るか（2026-08 の事故）─────────────────────────────
 * `cron-marketing-rollout` は「決める前に事実を全部数える」形だったため、
 * **結論が SKIP になる tick でも**付与計画・ジョブ照会・進行読みを毎回走らせていた。
 * 2 分間隔 = 月 21,600 tick なので、空振りだけで Airtable の月間上限（100,000 回）を
 * 80 倍超えた（Public API calls **8,372,540 / 100,000**）。
 *
 * ここは「1 tick が何回 Airtable を叩くか」を偽の世界で**実際に数える**。
 * 上限を緩める変更を入れたら、送信の挙動が変わらなくてもここが落ちる。
 *
 * ⚠️ 数える対象は偽物の Airtable への到達回数（`world.calls.airtable`）。
 *    本物のページ数と 1 対 1 ではないが、**経路が増えたことは必ず現れる**。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createWorld } from './rolloutJourney.fake.mjs';
import { ROLLOUT_STAGE } from './rolloutPlan.js';

const CAMPAIGN_ID = 'light-trial-to-premium-sequence';
const DAY = 86400_000;
const START = Date.parse('2026-09-01T01:00:00Z');

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

function makePeople(n = 3, grantedAt = START - DAY, grantDays = 30) {
  return Array.from({ length: n }, (_, i) => ({
    recordId: `recBUDG${String(i).padStart(10, '0')}`,
    email: `budget${i}@example.com`,
    fields: {
      LightGrantOp: 'light-trial-budget',
      LightGrantedAt: new Date(grantedAt).toISOString(),
      LightGrantUntil: new Date(grantedAt + grantDays * DAY).toISOString(),
      ComebackGrantSource: 'light-trial-autogrant',
    },
  }));
}

async function boot({ env = ENV, state: stateOverride = null } = {}) {
  const world = createWorld({ people: makePeople() });
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  Object.assign(process.env, env);
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
  const tick = (nowMs) => {
    mock.timers.setTime(nowMs);
    return cron.runRolloutTick({ env: process.env, now: nowMs });
  };

  const { createRolloutStore } = await import('./rolloutStore.js');
  const store = createRolloutStore({ cmd: world.redisCmd });
  const cur = await store.load(CAMPAIGN_ID);
  await store.save({
    campaignId: CAMPAIGN_ID,
    state: {
      ...cur.state, stage: ROLLOUT_STAGE.STEADY, alwaysArmed: true, dailyLimit: 100,
      ...(stateOverride || {}),
    },
    expectedVersion: null,
  });

  const restore = () => {
    mock.timers.reset();
    globalThis.fetch = originalFetch;
    for (const k of Object.keys(env)) delete process.env[k];
    Object.assign(process.env, originalEnv);
  };
  return { world, tick, restore, store };
}

/** その tick が何回 Airtable を叩いたか */
async function costOf(world, run) {
  const before = world.calls.airtable;
  const res = await run();
  return { cost: world.calls.airtable - before, res };
}

test('【重要】工程ゲートが閉じている tick は、Airtable を 1 回も読まない', async () => {
  // 自動運転そのものは許可し、付与・queue・送信を全部閉じる
  const closed = { ...ENV };
  delete closed.COMEBACK_GRANT_ENABLED;
  delete closed.LIGHT_TRIAL_AUTOGRANT_ENABLED;
  delete closed.MARKETING_CAMPAIGN_ENABLED;
  delete closed.MARKETING_CAMPAIGN_DISPATCH_ENABLED;
  const { world, tick, restore } = await boot({ env: closed });
  try {
    const { cost, res } = await costOf(world, () => tick(START));
    assert.equal(res.action, 'skip');
    assert.equal(cost, 0, `閉じているのに ${cost} 回読んでいる`);
    assert.deepEqual(res.airtableReads, []);
  } finally { restore(); }
});

test('【重要】緊急停止中の tick は、Airtable を 1 回も読まない', async () => {
  const { world, tick, restore } = await boot({ state: { killed: true } });
  try {
    const { cost, res } = await costOf(world, () => tick(START));
    assert.equal(res.action, 'skip');
    assert.equal(cost, 0, `緊急停止中に ${cost} 回読んでいる`);
  } finally { restore(); }
});

test('【重要】展開が終わった（completed）あとの tick は、Airtable を 1 回も読まない', async () => {
  // completed でも queue / 送信の積み残しは流したいので、ゲートは付与だけ閉じる
  const grantOnly = { ...ENV };
  delete grantOnly.MARKETING_CAMPAIGN_ENABLED;
  delete grantOnly.MARKETING_CAMPAIGN_DISPATCH_ENABLED;
  delete grantOnly.COMEBACK_GRANT_ENABLED;
  delete grantOnly.LIGHT_TRIAL_AUTOGRANT_ENABLED;
  const { world, tick, restore } = await boot({
    env: grantOnly, state: { stage: ROLLOUT_STAGE.COMPLETED },
  });
  try {
    const { cost } = await costOf(world, () => tick(START));
    assert.equal(cost, 0, `完了後に ${cost} 回読んでいる`);
  } finally { restore(); }
});

test('【重要】送信待ちが残っている tick は、付与計画も進行読みもしない', async () => {
  const { world, tick, restore } = await boot();
  try {
    // 1 tick 目で Step1 を積む（ジョブができる）
    await tick(START);
    assert.ok(world.jobs().length >= 1, '前提が崩れている（キュー登録できていない）');
    // 次の tick は「送信待ちがある」ので送信起動へ進むはず
    const { res } = await costOf(world, () => tick(START + 60_000));
    assert.equal(res.action, 'dispatch', `送信起動にならなかった: ${res.action}/${res.reason}`);
    /**
     * ⚠️ 回数そのものは見ない。この tick は**実際に送信を起動する**ので、
     *    送信経路がその先で払う読み書きが混ざる（それは必要な仕事）。
     *    ここで固定したいのは「**判断のための**事実収集が jobs だけ」であること。
     */
    assert.deepEqual(res.airtableReads, ['jobs'],
      `送信待ちがあるのに余計な事実収集が走っている: ${JSON.stringify(res.airtableReads)}`);
  } finally { restore(); }
});

test('【重要】期日まで間があるあいだ、進行読み（最重量）を毎 tick 繰り返さない', async () => {
  const { world, tick, restore } = await boot();
  try {
    // 付与 → queue → 送信 まで進めて、次の期日待ちの状態にする
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await tick(START + i * 600_000);
    }
    // ここから先は「次の期日まで何もない」tick が続く
    const first = await costOf(world, () => tick(START + 2 * 3600_000));
    const second = await costOf(world, () => tick(START + 2 * 3600_000 + 300_000));
    const third = await costOf(world, () => tick(START + 2 * 3600_000 + 600_000));

    assert.equal(first.res.action, 'skip', `前提が崩れている: ${first.res.action}`);
    assert.equal(second.res.action, 'skip');
    assert.ok(
      !second.res.airtableReads.includes('sequence')
      || !third.res.airtableReads.includes('sequence'),
      '期日待ちのあいだ、進行読みを毎 tick 繰り返している',
    );
    assert.ok(second.cost <= first.cost, `据え置きが効いていない（${first.cost} → ${second.cost}）`);
  } finally { restore(); }
});

test('【重要】1 日ぶん回しても、Airtable 到達回数が跳ね上がらない', async () => {
  /**
   * 5 分間隔 = 1 日 288 tick。偽の世界は表が小さいので 1 回の読みが 1 リクエストに
   * 見えるが、**読む経路が増えれば必ずここに出る**。
   * 2026-08-27 の修正前は同じ条件（2 分間隔・720 tick）で 10,111 回だった。
   */
  const { world, tick, restore } = await boot();
  try {
    for (let i = 0; i < 288; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await tick(START + i * 300_000);
    }
    assert.ok(world.sent.length >= 1, '前提が崩れている（1 通も送っていない）');
    assert.ok(
      world.calls.airtable < 1000,
      `1 日ぶんの tick で ${world.calls.airtable} 回 Airtable を読んでいる`
      + '（読む経路が増えていないか確かめること）',
    );
  } finally { restore(); }
});

test('【重要】読み飛ばしても、24 通の道のりは最後まで進む（挙動を落としていない）', async () => {
  // 進行の完全性は rolloutJourney.integration.test.mjs が固定している。
  // ここでは「据え置きを挟んでも Step2 が来る」ことだけを短く確かめる。
  const { world, tick, restore } = await boot();
  try {
    for (let d = 0; d < 5; d += 1) {
      for (let i = 0; i < 4; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await tick(START + d * DAY + i * 3600_000);
      }
    }
    assert.ok(world.sent.length >= 2, `据え置きのせいで進んでいない（${world.sent.length} 通）`);
  } finally { restore(); }
});
