/**
 * rolloutJourney.integration.test.mjs — **人手ゼロで 1 通目 → 24 通目 → 完了**
 *
 * ⚠️ 24 通は **2 フェーズ**に分かれている:
 *      体験中     `light-trial-to-premium-sequence`（6 通 / 接点 1〜6）
 *      体験終了後 `light-trial-post-expiry-sequence`（18 通 / 接点 7〜24）
 *    無料体験は 30 日で終わるため、**実際の 30 日付与**で通しに回し、
 *    期限切れをまたいで 24 通そろうことを固定する。
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
import { JOURNEY_PHASES, MAX_TOUCHES, toTouch } from './journeyModel.js';
import { ROLLOUT_STAGE } from './rolloutPlan.js';

const CAMPAIGN_ID = 'light-trial-to-premium-sequence';
const DAY = 86400_000;
const START = Date.parse('2026-09-01T01:00:00Z');   // JST 10:00
const STEP_COUNT = MAX_TOUCHES;   // 通し番号の総数（体験中 6 + 終了後 18）

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
async function boot({ people = makePeople(), state: stateOverride = null } = {}) {
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
    state: {
      ...cur.state, stage: ROLLOUT_STAGE.STEADY, alwaysArmed: true, dailyLimit: 100,
      ...(stateOverride || {}),
    },
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

/**
 * 件名 → **通し番号（1〜24）**。配信行には step が入らないので、届いた文面から見る。
 * フェーズをまたいで 1 本に数えるため、`journeyModel` の変換を通す。
 */
const TOUCH_BY_SUBJECT = new Map();
for (const p of JOURNEY_PHASES) {
  const c = getCampaign(p.campaignId, { includeDisabled: true });
  for (const s of getSequenceSteps(c)) {
    TOUCH_BY_SUBJECT.set(resolveSequenceStep(c, s.stepNumber).subject, toTouch(p.campaignId, s.stepNumber));
  }
}
const sentSteps = (world) => [...new Set(world.sent.map((s) => TOUCH_BY_SUBJECT.get(s.subject)).filter(Boolean))];
/** その人が受け取った通し番号（昇順） */
const touchesFor = (world, email) => world.sent
  .filter((x) => x.to === email)
  .map((x) => TOUCH_BY_SUBJECT.get(x.subject))
  .filter(Boolean)
  .sort((a, b) => a - b);

// ── 通し（人手ゼロ）────────────────────────────────────────────

test('【重要】30 日の無料体験でも、期限切れをまたいで 24 通が人手ゼロで届く', async () => {
  // ⚠️ **実際の 30 日付与**で回す。体験中に入るのは 6 通前後で、
  //    期限が切れたら終了後フェーズへ移り、合計 24 通に到達する。
  const { world, tick, restore } = await boot({ people: makePeople(4, START - DAY, 30) });
  try {
    let day = 0;
    for (; day < 300 && sentSteps(world).length < MAX_TOUCHES; day += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + day * DAY);
    }
    const touches = sentSteps(world).sort((a, b) => a - b);
    assert.deepEqual(touches, Array.from({ length: MAX_TOUCHES }, (_, i) => i + 1),
      `1〜24 通目まで届いていない（届いた: ${touches.join(',')}）`);

    // 1 人あたり 24 通ちょうど・重複ゼロ
    for (const p of world.tables.Customers) {
      const mine = touchesFor(world, p.fields.Email);
      assert.equal(mine.length, MAX_TOUCHES, `${mine.length} 通しか届いていない人がいる`);
      assert.equal(new Set(mine).size, MAX_TOUCHES, '同じ通し番号を二度送っている');
    }
    assert.equal(world.sent.length, MAX_TOUCHES * 4, `送信数が合わない（${world.sent.length}）`);
  } finally { restore(); }
});

test('【重要】体験中 1〜6 → 期限切れ → 7 通目以降（順番が入れ替わらない）', async () => {
  const { world, tick, restore } = await boot({ people: makePeople(2, START - DAY, 30) });
  try {
    for (let d = 0; d < 300 && sentSteps(world).length < MAX_TOUCHES; d += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + d * DAY);
    }
    const mine = touchesFor(world, world.tables.Customers[0].fields.Email);
    assert.deepEqual(mine, [...mine].sort((a, b) => a - b), '順番が入れ替わっている');
    assert.ok(mine.includes(6) && mine.includes(7), 'フェーズをまたいでいない');
  } finally { restore(); }
});

test('【重要】24 通に達したら、その後いくら回しても 1 通も増えない', async () => {
  const { world, tick, restore } = await boot({ people: makePeople(2, START - DAY, 30) });
  try {
    let day = 0;
    for (; day < 300 && sentSteps(world).length < MAX_TOUCHES; day += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + day * DAY);
    }
    const afterAll = world.sent.length;
    assert.equal(afterAll, MAX_TOUCHES * 2);
    for (let d = day; d < day + 120; d += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + d * DAY);
    }
    assert.equal(world.sent.length, afterAll, `24 通の後に ${world.sent.length - afterAll} 通送っている`);
  } finally { restore(); }
});

test('【重要】無反応のままでも 24 通まで進む（反応が無いことを理由に止めない）', async () => {
  // 偽の世界には開封・クリックの記録が 1 件も無い = 完全な無反応
  const { world, tick, restore } = await boot({ people: makePeople(2, START - DAY, 30) });
  try {
    for (let d = 0; d < 300 && sentSteps(world).length < MAX_TOUCHES; d += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + d * DAY);
    }
    assert.equal(sentSteps(world).length, MAX_TOUCHES, '無反応を理由に途中で止まっている');
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

test('【重要】5 通目のあとに購入したら、体験中も終了後も 0 通', async () => {
  const { world, tick, restore } = await boot({ people: makePeople(4, START - DAY, 30) });
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
    // 終了後フェーズ（7 通目以降）も 1 通も来ていない
    assert.equal(touchesFor(world, buyerMail).filter((t) => t >= 7).length, 0,
      '購入者へ終了後フェーズを送っている');
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

test('【重要】期限切れの直前に購入 → 終了後フェーズは 0 通', async () => {
  const grantedAt = START - DAY;
  const { world, tick, restore } = await boot({ people: makePeople(3, grantedAt, 30) });
  try {
    const buyer = world.tables.Customers[0];
    const mail = buyer.fields.Email;
    // 期限（付与 + 30 日）の 1 日前まで進める
    const expiryDay = Math.floor((grantedAt + 30 * DAY - START) / DAY);
    for (let d = 0; d < expiryDay - 1; d += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + d * DAY);
    }
    world.setCustomer(buyer.id, { プラン: 'Premium', Status: 'active' });
    const before = touchesFor(world, mail).length;

    for (let d = expiryDay - 1; d < expiryDay + 90; d += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + d * DAY);
    }
    const mine = touchesFor(world, mail);
    assert.equal(mine.length, before, `購入後に ${mine.length - before} 通送っている`);
    assert.equal(mine.filter((t) => t >= 7).length, 0, '購入者へ終了後フェーズを送っている');
    // 購入していない人は 7 通目以降へ進んでいる
    const other = touchesFor(world, world.tables.Customers[1].fields.Email);
    assert.ok(other.some((t) => t >= 7), '購入していない人まで止めている');
  } finally { restore(); }
});

test('【重要】終了後フェーズの 3 通目のあとに購入 → 以降 0 通', async () => {
  const { world, tick, restore } = await boot({ people: makePeople(3, START - DAY, 30) });
  try {
    const buyer = world.tables.Customers[0];
    const mail = buyer.fields.Email;
    // 通し番号 9（= 終了後フェーズ 3 通目）まで進める
    let day = 0;
    for (; day < 300 && touchesFor(world, mail).filter((t) => t >= 7).length < 3; day += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + day * DAY);
    }
    const before = touchesFor(world, mail).length;
    assert.ok(before >= 9, `終了後フェーズ 3 通目まで届いていない（${before}）`);

    world.setCustomer(buyer.id, { プラン: 'Premium', Status: 'active' });
    for (let d = day; d < day + 120; d += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + d * DAY);
    }
    assert.equal(touchesFor(world, mail).length, before,
      `購入後に ${touchesFor(world, mail).length - before} 通送っている`);
  } finally { restore(); }
});

test('【重要】ハードバウンス / 苦情 / 配信基盤の停止リスト → 以降 0 通', async () => {
  for (const type of ['bounce', 'complaint', 'spam']) {
    // eslint-disable-next-line no-await-in-loop
    const { world, tick, restore } = await boot({ people: makePeople(3, START - DAY, 30) });
    try {
      let day = 0;
      for (; day < 30 && sentSteps(world).length < 2; day += 1) {
        // eslint-disable-next-line no-await-in-loop
        await runDay(tick, START + day * DAY);
      }
      const target = world.tables.Customers[0];
      const mail = target.fields.Email;
      world.addToBlacklist(mail, type);
      const before = touchesFor(world, mail).length;

      for (let d = day; d < day + 120; d += 1) {
        // eslint-disable-next-line no-await-in-loop
        await runDay(tick, START + d * DAY);
      }
      assert.equal(touchesFor(world, mail).length, before,
        `${type} のあとに ${touchesFor(world, mail).length - before} 通送っている`);
      // 他の人は進み続ける
      assert.ok(touchesFor(world, world.tables.Customers[1].fields.Email).length > before,
        `${type} で他の人まで止めている`);
    } finally { restore(); }
  }
});

test('【重要】フェーズ移行は毎 tick 導出（handoff の記録を二重に作らない）', async () => {
  const { world, tick, restore } = await boot({ people: makePeople(3, START - DAY, 30) });
  try {
    // 期限切れ直後を、同じ日に何度も回す（cron 再起動と同じ状況）
    let day = 0;
    for (; day < 300 && sentSteps(world).filter((t) => t >= 7).length < 1; day += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + day * DAY);
    }
    const jobsAfter = world.jobs().length;
    const deliveriesAfter = world.deliveries().length;
    const sentAfter = world.sent.length;

    // 同じ日をもう一度、しつこく回す
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await tick(START + day * DAY + i * 600_000);
    }
    assert.equal(world.jobs().length, jobsAfter, 'ジョブを二重に作っている');
    assert.equal(world.deliveries().length, deliveriesAfter, '配信行を二重に作っている');
    assert.equal(world.sent.length, sentAfter, '二重送信が起きている');

    // 通し番号にも重複が無い
    for (const p of world.tables.Customers) {
      const mine = touchesFor(world, p.fields.Email);
      assert.equal(new Set(mine).size, mine.length, '同じ通し番号を二度送っている');
    }
  } finally { restore(); }
});

test('【重要】one-shot: 武装が切れた翌日でも、積み残しの送信は完了する', async () => {
  // 100 名カナリアの形: `alwaysArmed: false` + `armedFor: <当日>`。
  // ⚠️ **当日のうちに片付かなかったぶん**（queue 済みで未送信）が、
  //    翌日以降に処理されることを確かめる。ここが止まると、
  //    付与だけされて案内が届かない人が残る。
  const { jstDay } = await import('./rolloutPlan.js');
  const { world, tick, restore } = await boot({
    people: makePeople(5, START - DAY, 30),
    state: {
      stage: ROLLOUT_STAGE.CANARY, dailyLimit: 100, alwaysArmed: false, armedFor: jstDay(START),
    },
  });
  try {
    // 当日は **queue まで**（1 tick だけ回して、送信を翌日へ持ち越す）
    await tick(START);
    assert.ok(world.jobs().length >= 1, '当日にキュー登録できていない');
    assert.equal(world.sent.length, 0, 'この tick で送信まで進んでいる（前提が崩れている）');

    // 翌日以降（**武装は切れている**）: 送信が完了する
    for (let d = 1; d <= 3; d += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + d * DAY);
    }
    assert.equal(world.sent.length, 5, `武装切れで送信が止まっている（${world.sent.length} 通）`);
    assert.ok(sentSteps(world).includes(1), '1 通目が届いていない');

    // 二重送信ゼロ
    const pairs = world.sent.map((x) => `${x.to}|${x.subject}`);
    assert.equal(new Set(pairs).size, pairs.length, '二重送信が起きている');
  } finally { restore(); }
});

test('【重要】one-shot: 送信が途中で切れても、翌日以降に残りだけ送る', async () => {
  const { jstDay } = await import('./rolloutPlan.js');
  const { world, tick, restore } = await boot({
    people: makePeople(5, START - DAY, 30),
    state: {
      stage: ROLLOUT_STAGE.CANARY, dailyLimit: 100, alwaysArmed: false, armedFor: jstDay(START),
    },
  });
  try {
    world.limitSends(2);                    // 当日は 2 通で詰まる
    await runDay(tick, START, 3);
    const firstRound = world.sent.length;
    assert.ok(firstRound <= 2, `詰まったのに ${firstRound} 通送っている`);

    world.clearSendLimit();                 // 送信基盤が回復（翌日・武装は切れている）
    for (let d = 1; d <= 3; d += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + d * DAY);
    }
    assert.equal(world.sent.length, 5, `残りが送られていない（${world.sent.length} 通）`);
    const pairs = world.sent.map((x) => `${x.to}|${x.subject}`);
    assert.equal(new Set(pairs).size, pairs.length, '再開で二重送信が起きている');
  } finally { restore(); }
});

test('【重要】one-shot の翌日以降、新規付与は自動で始まらない', async () => {
  const { jstDay } = await import('./rolloutPlan.js');
  const cron = await import('../../../netlify/functions/cron-marketing-rollout.js');
  const { world, tick, restore } = await boot({
    people: makePeople(3, START - DAY, 30),
    state: {
      stage: ROLLOUT_STAGE.CANARY, dailyLimit: 100, alwaysArmed: false, armedFor: jstDay(START),
    },
  });
  try {
    // 積み残しを片付けきる
    for (let d = 0; d <= 3; d += 1) {
      // eslint-disable-next-line no-await-in-loop
      await runDay(tick, START + d * DAY);
    }
    // 翌日以降の tick で `grant` が選ばれないこと（= 次の 100 名が自動で始まらない）
    for (let d = 4; d <= 10; d += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = await cron.runRolloutTick({ env: process.env, now: START + d * DAY });
      assert.notEqual(r.action, 'grant', `${d} 日目に自動で付与が始まっている`);
    }
  } finally { restore(); }
});
