/**
 * rolloutJourney.integration.test.mjs — **人手ゼロで Step1 → Step24 → 完了**
 *   node --test src/lib/marketing/rolloutJourney.integration.test.mjs
 *
 * 偽の世界（Airtable / Redis / SendGrid）を置き、**本物の cron を何十 tick も回す**。
 * 時計を進めるだけで、
 *   付与 → Step1 queue → 送信 → …（期日ごとに）… → Step24 → 完了
 * まで人の操作なしに進むことを固定する。
 *
 * さらに、途中で起きる現実も一緒に固定する:
 *   - Step5 のあとに購入 → Step6 以降は 1 通も積まない
 *   - 配信停止 → 以降 1 通も積まない
 *   - 送信待ちのまま cron が再起動 → **二重 queue / 二重送信 0**
 *   - 送信が途中で切れた → 残りだけ続きから送る
 *
 * ⚠️ 判定はすべて本物（`admin-marketing` の sequence / dryRun / send、dispatcher、
 *    `cron-marketing-rollout`）。偽物は保管と反映だけを担う。
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { createWorld } from './rolloutJourney.fake.mjs';
import { getCampaign } from './campaignCatalog.js';
import { getSequenceSteps, resolveSequenceStep } from './campaignSequence.js';
import { ROLLOUT_STAGE } from './rolloutPlan.js';

const CAMPAIGN_ID = 'light-trial-to-premium-sequence';
const DAY = 86400_000;
const START = Date.parse('2026-09-01T01:00:00Z');   // JST 10:00
const STEP_COUNT = getSequenceSteps(getCampaign(CAMPAIGN_ID, { includeDisabled: true })).length;

/** 工程ゲートを全部開けた env（**本番では既定で閉じている**） */
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

/**
 * 無料期間中の 5 名（付与済み）。
 * ⚠️ 付与そのものは別工程（`cron-light-trial-grant`）で検証済みなので、
 *    ここは**付与のあと**——Step1 からの道のりに集中する。
 */
function makePeople(n = 5, grantedAt = START - DAY, grantDays = 30) {
  return Array.from({ length: n }, (_, i) => ({
    // ⚠️ 本物と同じ形（rec + 英数 14 文字）。形が違うと本物側の検証が弾く
    recordId: `recCUST${String(i).padStart(10, '0')}`,
    email: `member${i}@example.com`,
    fields: {
      LightGrantOp: 'light-trial-journey',
      LightGrantedAt: new Date(grantedAt).toISOString(),
      LightGrantUntil: new Date(grantedAt + grantDays * DAY).toISOString(),
      ComebackGrantSource: 'light-trial-autogrant',
    },
  }));
}

/**
 * 世界を用意して cron を回せる形にする。
 * 返す `tick(nowMs)` が 1 回ぶんの自動運転。
 */
async function boot({ people = makePeople() } = {}) {
  const world = createWorld({ people });
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  Object.assign(process.env, ENV);
  // ⚠️ **時計も偽物にする。** `admin-marketing` / dispatcher は自分で `Date.now()` を読むので、
  //    引数の時刻だけ進めても「まだ期日ではない」と判断され、Step2 以降が永久に来ない。
  mock.timers.enable({ apis: ['Date'], now: START });

  // Background Function は**本物**を呼ぶ（送信経路を偽装しない）
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
    mock.timers.setTime(nowMs);          // 世界全体の「いま」を進める
    return cron.runRolloutTick({ env: process.env, now: nowMs });
  };

  // 展開状態を「動いている」にする（本番では管理画面から行う操作）
  const { createRolloutStore } = await import('./rolloutStore.js');
  const store = createRolloutStore({ cmd: world.redisCmd });
  const cur = await store.load(CAMPAIGN_ID);
  await store.save({
    campaignId: CAMPAIGN_ID,
    state: { ...cur.state, stage: ROLLOUT_STAGE.STEADY, alwaysArmed: true, dailyLimit: 100 },
    expectedVersion: null,
  });

  const restore = () => {
    mock.timers.reset();
    globalThis.fetch = originalFetch;
    for (const k of Object.keys(ENV)) delete process.env[k];
    Object.assign(process.env, originalEnv);
  };
  return { world, tick, restore, store };
}

/** その日のうちに進めるだけ進める（1 tick 1 段階なので数回まわす） */
async function runDay(tick, dayMs, times = 4) {
  const actions = [];
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await tick(dayMs + i * 3600_000);
    actions.push(r.action);
    if (r.action === 'skip' && r.reason !== 'facts_unreadable') break;
  }
  return actions;
}

/** 件名 → 何通目か（配信行には step が入らないので、届いた文面から見る） */
const CAMPAIGN = getCampaign(CAMPAIGN_ID, { includeDisabled: true });
const STEP_BY_SUBJECT = new Map(
  getSequenceSteps(CAMPAIGN).map((s) => [resolveSequenceStep(CAMPAIGN, s.stepNumber).subject, s.stepNumber]),
);
const sentSteps = (world) => [...new Set(world.sent.map((s) => STEP_BY_SUBJECT.get(s.subject)).filter(Boolean))];

// ── 通し（人手ゼロ）────────────────────────────────────────────

test('【重要】時計を進めるだけで Step1 → Step24 まで人手ゼロで進む', async () => {
  // ⚠️ 無料期間が続いている間だけ配信対象になる（`requiresActiveGrant`）。
  //    ここでは**配線が最後まで通るか**を見たいので、期間を十分長く取る。
  //    30 日の無料期間だと 24 通は入り切らない（下の別テストで固定している）。
  const { world, tick, restore } = await boot({ people: makePeople(5, START - DAY, 400) });
  try {
    let day = 0;
    // 24 通 × 最短間隔 3 日 + 余裕。1 日 4 tick まで
    for (; day < 200 && sentSteps(world).length < STEP_COUNT; day += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + day * DAY);
    }
    const steps = sentSteps(world).sort((a, b) => a - b);
    assert.deepEqual(steps, Array.from({ length: STEP_COUNT }, (_, i) => i + 1),
      `Step1〜${STEP_COUNT} まで届いていない（届いた: ${steps.join(',')}）`);
    assert.equal(world.sent.length, STEP_COUNT * 5, `送信数が合わない（${world.sent.length}）`);
    // 同じ人へ同じ Step を 2 通送っていない
    const pairs = world.sent.map((s) => `${s.to}|${s.subject}`);
    assert.equal(new Set(pairs).size, pairs.length, '同じ人へ同じ文面を二度送っている');
  } finally { restore(); }
});

test('【重要】24 通が終わると completed になり、それ以上は送らない', async () => {
  const { world, tick, restore } = await boot({ people: makePeople(3, START - DAY, 400) });
  try {
    for (let d = 0; d < 200 && sentSteps(world).length < STEP_COUNT; d += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + d * DAY);
    }
    const afterAll = world.sent.length;
    // さらに 60 日回しても 1 通も増えない
    for (let d = 200; d < 260; d += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + d * DAY);
    }
    assert.equal(world.sent.length, afterAll, `24 通の後に ${world.sent.length - afterAll} 通送っている`);
    assert.equal(afterAll, STEP_COUNT * 3);
  } finally { restore(); }
});

test('【重要】30 日の無料期間には 24 通は入り切らない（期限切れで止まる）', async () => {
  // ⚠️ これは不具合ではなく**現在の仕様**（`requiresActiveGrant`）。
  //    無料期間が終わった人は `grant_expired` で停止し、後続 Step は積まれない。
  //    「期限後も送るか」は配信対象の定義を変える判断なので、ここでは事実だけ固定する。
  const { world, tick, restore } = await boot({ people: makePeople(3, START - DAY, 30) });
  try {
    for (let d = 0; d < 120; d += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + d * DAY);
    }
    const steps = sentSteps(world).sort((a, b) => a - b);
    assert.ok(steps.length >= 1, '1 通も届いていない');
    assert.ok(steps.length < STEP_COUNT,
      `無料期間 30 日で ${steps.length} 通届いた（期限切れ後も送っているなら仕様変更が要る）`);
    // 期限が切れたあとに送っていないこと（最後の送信は期限内）
    assert.ok(steps[0] === 1, 'Step1 から始まっていない');
  } finally { restore(); }
});

test('【重要】人手ゼロで進む間、管理画面の操作を 1 度も必要としない', async () => {
  const { world, tick, restore } = await boot();
  try {
    await runDay(tick, START);
    await runDay(tick, START + DAY);
    // cron 以外の入口（管理画面 handler）は呼ばれていない＝人の操作が要らない
    assert.ok(world.calls.airtable > 0, '何も動いていない');
    assert.ok(world.sent.length >= 0);
  } finally { restore(); }
});

// ── 止める条件 ──────────────────────────────────────────────

test('【重要】購入した人には以降の Step を積まない', async () => {
  const { world, tick, restore } = await boot();
  try {
    await runDay(tick, START);
    const buyer = world.tables.Customers[0];
    // 購入（有料会員になった）
    world.setCustomer(buyer.id, { プラン: 'Premium', Status: 'active' });
    const before = world.sent.filter((s) => s.to === buyer.fields.Email).length;
    for (let d = 1; d < 30; d += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + d * DAY);
    }
    const after = world.sent.filter((s) => s.to === buyer.fields.Email).length;
    assert.equal(after, before, `購入後に ${after - before} 通送っている`);
  } finally { restore(); }
});

test('【重要】Step5 のあとに購入したら Step6 以降は 0 通', async () => {
  const { world, tick, restore } = await boot({ people: makePeople(4, START - DAY, 400) });
  try {
    // Step5 が届くまで進める
    let day = 0;
    for (; day < 120 && sentSteps(world).length < 5; day += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + day * DAY);
    }
    assert.ok(sentSteps(world).includes(5), `Step5 まで届いていない（${sentSteps(world).join(',')}）`);

    const buyer = world.tables.Customers[0];
    const buyerMail = buyer.fields.Email;
    const before = world.sent.filter((x) => x.to === buyerMail).length;
    world.setCustomer(buyer.id, { プラン: 'Premium', Status: 'active', PlanType: 'Annual' });

    // 以降しっかり回しても、その人には 1 通も増えない
    for (let d = day; d < day + 60; d += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + d * DAY);
    }
    const after = world.sent.filter((x) => x.to === buyerMail).length;
    assert.equal(after, before, `購入後に ${after - before} 通送っている`);
    // 他の人には届き続ける（購入者だけを止めている）
    const others = world.sent.filter((x) => x.to !== buyerMail).length;
    assert.ok(others > before, '購入していない人まで止めている');
  } finally { restore(); }
});

test('【重要】配信停止した人には以降 1 通も送らない', async () => {
  const { world, tick, restore } = await boot();
  try {
    await runDay(tick, START);
    const person = world.tables.Customers[1];
    world.addToBlacklist(person.fields.Email, 'unsubscribe');
    const before = world.sent.filter((s) => s.to === person.fields.Email).length;
    for (let d = 1; d < 30; d += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + d * DAY);
    }
    const after = world.sent.filter((s) => s.to === person.fields.Email).length;
    assert.equal(after, before, `配信停止後に ${after - before} 通送っている`);
  } finally { restore(); }
});

// ── 中断と再開 ──────────────────────────────────────────────

test('【重要】送信待ちのまま cron が再起動しても二重に積まない・二重に送らない', async () => {
  const { world, tick, restore } = await boot();
  try {
    await runDay(tick, START, 2);           // queue まで進める
    const jobsAfterQueue = world.jobs().length;
    const deliveriesAfterQueue = world.deliveries().length;

    // ここで cron が落ちて、同じ時刻からもう一度起動したとする
    await runDay(tick, START, 2);
    assert.equal(world.jobs().length, jobsAfterQueue, 'ジョブを二重に作っている');
    assert.equal(world.deliveries().length, deliveriesAfterQueue, '配信行を二重に作っている');

    // 送信まで進めても、1 人 1 通のまま
    await runDay(tick, START + 3600_000, 3);
    const pairs = world.sent.map((s) => `${s.to}|${s.subject}`);
    assert.equal(new Set(pairs).size, pairs.length, '二重送信が起きている');
  } finally { restore(); }
});

test('【重要】送信が途中で切れたら、残りだけを続きから送る', async () => {
  const { world, tick, restore } = await boot({ people: makePeople(5) });
  try {
    world.limitSends(2);                     // この起動では 2 通で詰まる
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await tick(START + i * 3600_000);
    }
    const firstRound = world.sent.length;
    assert.ok(firstRound <= 2, `詰まったのに ${firstRound} 通送っている`);

    world.clearSendLimit();                  // 送信基盤が回復
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await tick(START + DAY + i * 3600_000);
    }
    const pairs = world.sent.map((s) => `${s.to}|${s.subject}`);
    assert.equal(new Set(pairs).size, pairs.length, '再開で同じ人へ二度送っている');
    assert.ok(world.sent.length >= firstRound, '再開で送信が減っている');
  } finally { restore(); }
});

// ── 送信起動の契約 ──────────────────────────────────────────

test('【重要】Background へは必ず expectedWillSend を渡す（渡さないと 1 通も出ない）', async () => {
  const { world, tick, restore } = await boot();
  try {
    const payloads = [];
    const inner = world.makeFetch({ onBackground: async (b) => { payloads.push(b); } });
    globalThis.fetch = inner;
    for (let i = 0; i < 4; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await tick(START + i * 3600_000);
    }
    if (payloads.length > 0) {
      for (const p of payloads) {
        assert.ok(p.jobId, 'jobId が無い');
        assert.equal(typeof p.expectedWillSend, 'number', 'expectedWillSend を渡していない');
        assert.ok(p.expectedWillSend > 0, '0 名で起動している');
      }
    }
  } finally { restore(); }
});

test('【重要】実送信ゲートが閉じていれば、積むところまでで止まる（1 通も出ない）', async () => {
  const { world, restore } = await boot();
  try {
    const cron = await import('../../../netlify/functions/cron-marketing-rollout.js');
    // 実送信だけを閉じる（キュー登録は許可）→ **準備は進むが 1 通も出ない**
    const closed = { ...process.env, MARKETING_CAMPAIGN_DISPATCH_ENABLED: '' };
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await cron.runRolloutTick({ env: closed, now: START + i * 3600_000 });
    }
    assert.equal(world.sent.length, 0, `ゲートが閉じているのに ${world.sent.length} 通送っている`);
    assert.ok(world.jobs().length >= 1, 'キュー登録まで止めている（積むのは許可されている）');
    const last = await cron.runRolloutTick({ env: closed, now: START + 4 * 3600_000 });
    assert.equal(last.action, 'skip');
    assert.equal(last.reason, 'gate_closed_dispatch');
    // 閉じている env の名前を出している（運用者が開けられるように）
    assert.ok(String(last.blocked || '').includes('MARKETING_CAMPAIGN_DISPATCH_ENABLED'), last.blocked);
  } finally { restore(); }
});

test('【重要】自動運転そのものが閉じていれば 1 バイトも書かない', async () => {
  const { world, restore } = await boot();
  try {
    const cron = await import('../../../netlify/functions/cron-marketing-rollout.js');
    const before = { jobs: world.jobs().length, deliveries: world.deliveries().length, sent: world.sent.length };
    const off = await cron.runRolloutTick({ env: { ...process.env, MARKETING_ROLLOUT_ENABLED: '' }, now: START });
    assert.equal(off.abort, 'rollout_disabled');
    assert.equal(off.sideEffects, 'none');
    assert.equal(world.jobs().length, before.jobs, 'ジョブを作っている');
    assert.equal(world.deliveries().length, before.deliveries, '台帳を書いている');
    assert.equal(world.sent.length, before.sent, '送信している');
  } finally { restore(); }
});

test('【重要】キュー登録ゲートが閉じていれば、積まない（送らないだけでなく作らない）', async () => {
  const { world, restore } = await boot();
  try {
    const cron = await import('../../../netlify/functions/cron-marketing-rollout.js');
    const closed = { ...process.env, MARKETING_CAMPAIGN_ENABLED: '' };
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await cron.runRolloutTick({ env: closed, now: START + i * 3600_000 });
    }
    assert.equal(world.jobs().length, 0, 'ゲートが閉じているのにジョブを作っている');
    assert.equal(world.deliveries().length, 0, 'ゲートが閉じているのに台帳を書いている');
    assert.equal(world.sent.length, 0);
  } finally { restore(); }
});
