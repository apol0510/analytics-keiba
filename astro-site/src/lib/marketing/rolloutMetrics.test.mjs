/**
 * rolloutMetrics.test.mjs — 増分集計（ダッシュボードの I/O を母集団から切り離す）
 *   node --test src/lib/marketing/rolloutMetrics.test.mjs
 *
 * 守る性質:
 *   - ダッシュボードの読み取りが **母集団の大きさに依存しない**
 *   - 集計が無い / 壊れている / 版違いは **partial**（0 件と書かない）
 *   - 加算は atomic（同時に走っても数が落ちない）
 *   - 鍵にも値にも PII を入れない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createRolloutMetrics, metricsKey, estimateDashboardIo, isSafeCampaignId,
  emptyTotals, emptySteps, normalizeDelta,
  METRICS_ROOT, METRICS_SCHEMA_VERSION, METRICS_FAIL, MetricsError,
} from './rolloutMetrics.js';

const CAMPAIGN = 'light-trial-to-premium-sequence';
const NOW = Date.parse('2026-08-16T00:00:00Z');

/** 偽 Redis（Lua の加算を JS で再現する） */
function fakeRedis(store = new Map(), { failOn = null } = {}) {
  return async (args) => {
    const op = String(args[0]).toUpperCase();
    if (failOn && op === failOn) throw new Error('boom');
    if (op === 'GET') return store.get(args[1]) ?? null;
    if (op === 'SET') { store.set(args[1], String(args[2])); return 'OK'; }
    if (op === 'DEL') { store.delete(args[1]); return 1; }
    if (op === 'EVAL') {
      const script = String(args[1]);
      const key = args[3];
      const delta = JSON.parse(args[4]);
      const schema = Number(args[5]);
      const at = Number(args[6]);
      const cur = store.get(key) ? JSON.parse(store.get(key)) : {};
      if (script.includes('byStopReason')) {
        for (const k of ['granted', 'notStarted', 'inProgress', 'purchased', 'stopped', 'completed']) {
          cur[k] = (Number(cur[k]) || 0) + (Number(delta[k]) || 0);
        }
        if (delta.byStopReason) {
          cur.byStopReason = cur.byStopReason || {};
          for (const [k, v] of Object.entries(delta.byStopReason)) {
            cur.byStopReason[k] = (Number(cur.byStopReason[k]) || 0) + (Number(v) || 0);
          }
        }
      } else {
        cur.steps = cur.steps || {};
        for (const [step, m] of Object.entries(delta)) {
          cur.steps[step] = cur.steps[step] || {};
          for (const k of ['sent', 'failed', 'opened', 'clicked', 'queued']) {
            cur.steps[step][k] = (Number(cur.steps[step][k]) || 0) + (Number(m[k]) || 0);
          }
        }
      }
      cur.schema = schema;
      cur.updatedAtMs = at;
      store.set(key, JSON.stringify(cur));
      return 'OK';
    }
    return null;
  };
}

// ── ダッシュボードの I/O ────────────────────────────────────────

test('【重要】ダッシュボードの読み取りは母集団の大きさに依存しない', async () => {
  const store = new Map();
  const calls = [];
  const m = createRolloutMetrics({
    cmd: async (args) => { calls.push(String(args[0]).toUpperCase()); return fakeRedis(store)(args); },
  });
  await m.reconcile({ campaignId: CAMPAIGN, totals: { granted: 14489 }, steps: {}, nowMs: NOW });
  calls.length = 0;
  await m.read(CAMPAIGN);
  // Redis GET 2 回だけ。Airtable は 1 ページも読まない
  assert.deepEqual(calls, ['GET', 'GET'], `読み取りが ${calls.join(',')}`);
});

test('【重要】14,489 名 × 24 Step でも I/O 回数が変わらない', () => {
  const small = estimateDashboardIo({ cohortSize: 10, stepCount: 4 });
  const huge = estimateDashboardIo({ cohortSize: 14_489, stepCount: 24 });
  assert.equal(huge.redisGets, small.redisGets, '母集団で I/O が増えている');
  assert.equal(huge.airtablePages, 0, 'Airtable を読んでいる');
  assert.equal(huge.redisGets, 2);
});

test('【重要】実測 156 秒の全件取得をダッシュボードから外す（回数で固定）', () => {
  // 14,489 件 = 145 ページ（100 件/ページ）。これを毎回読むと 26 秒に収まらない
  const naivePages = Math.ceil(14_489 / 100);
  assert.ok(naivePages > 100, '前提が変わっている');
  const io = estimateDashboardIo({ cohortSize: 14_489, stepCount: 24 });
  assert.ok(io.airtablePages < naivePages, '全件走査に戻っている');
  // 24 Step ぶんの配信行（約 35 万行）も読まない
  const deliveries = 14_489 * 24;
  assert.ok(deliveries > 300_000);
  assert.equal(io.airtablePages, 0);
});

// ── 欠測は「部分」と言う ──────────────────────────────────────

test('【重要】集計が無ければ partial（0 件と書かない）', async () => {
  const m = createRolloutMetrics({ cmd: fakeRedis() });
  const r = await m.read(CAMPAIGN);
  assert.equal(r.partial, true);
  assert.equal(r.reason, 'not_initialized');
  assert.equal(r.totals, null, '未計測を 0 件として返している');
});

test('【重要】壊れていれば partial（動かさない）', async () => {
  const store = new Map();
  store.set(metricsKey.totals(CAMPAIGN), '{壊れている');
  store.set(metricsKey.steps(CAMPAIGN), JSON.stringify(emptySteps()));
  const m = createRolloutMetrics({ cmd: fakeRedis(store) });
  const r = await m.read(CAMPAIGN);
  assert.equal(r.partial, true);
  assert.equal(r.reason, METRICS_FAIL.DATA_CORRUPT);
});

test('【重要】形式版が違えば partial（古い形を新しい意味で読まない）', async () => {
  const store = new Map();
  store.set(metricsKey.totals(CAMPAIGN), JSON.stringify({ ...emptyTotals(), schema: 0 }));
  store.set(metricsKey.steps(CAMPAIGN), JSON.stringify(emptySteps()));
  const m = createRolloutMetrics({ cmd: fakeRedis(store) });
  const r = await m.read(CAMPAIGN);
  assert.equal(r.partial, true);
  assert.equal(r.reason, METRICS_FAIL.SCHEMA_MISMATCH);
});

test('【重要】Redis へ届かなければ partial（推測で数字を作らない）', async () => {
  const m = createRolloutMetrics({ cmd: async () => { throw new Error('down'); } });
  const r = await m.read(CAMPAIGN);
  assert.equal(r.partial, true);
  assert.equal(r.reason, METRICS_FAIL.UNREACHABLE);
  assert.equal(r.steps, null);
});

// ── 加算 ────────────────────────────────────────────────────

test('付与・停止を加算でき、読み直せる', async () => {
  const store = new Map();
  const m = createRolloutMetrics({ cmd: fakeRedis(store) });
  await m.bumpTotals({ campaignId: CAMPAIGN, delta: { granted: 100, notStarted: 100 }, nowMs: NOW });
  await m.bumpTotals({
    campaignId: CAMPAIGN,
    delta: { stopped: 2, notStarted: 0, byStopReason: { unsubscribed: 1, hard_bounce: 1 } },
    nowMs: NOW,
  });
  const r = await m.read(CAMPAIGN);
  assert.equal(r.partial, false);
  assert.equal(r.totals.granted, 100);
  assert.equal(r.totals.stopped, 2);
  assert.deepEqual(r.totals.byStopReason, { unsubscribed: 1, hard_bounce: 1 });
});

test('【重要】同時に加算しても数が落ちない（読んで書くにしない）', async () => {
  const store = new Map();
  const m = createRolloutMetrics({ cmd: fakeRedis(store) });
  await Promise.all(Array.from({ length: 50 }, () => m.bumpTotals({
    campaignId: CAMPAIGN, delta: { granted: 1 }, nowMs: NOW,
  })));
  const r = await m.read(CAMPAIGN);
  assert.equal(r.totals.granted, 50, `50 回加算して ${r.totals.granted}`);
});

test('Step 別を加算でき、24 Step まで持てる', async () => {
  const store = new Map();
  const m = createRolloutMetrics({ cmd: fakeRedis(store) });
  const delta = {};
  for (let i = 1; i <= 24; i += 1) delta[i] = { sent: i, opened: 1 };
  await m.bumpSteps({ campaignId: CAMPAIGN, delta, nowMs: NOW });
  await m.bumpSteps({ campaignId: CAMPAIGN, delta: { 1: { sent: 10 } }, nowMs: NOW });
  const r = await m.read(CAMPAIGN);
  assert.equal(Object.keys(r.steps.steps).length, 24);
  assert.equal(r.steps.steps['1'].sent, 11);
  assert.equal(r.steps.steps['24'].sent, 24);
  assert.equal(r.steps.steps['24'].opened, 1);
});

test('【重要】負の差分・壊れた step 番号は受け付けない', async () => {
  const store = new Map();
  const m = createRolloutMetrics({ cmd: fakeRedis(store) });
  await m.bumpTotals({ campaignId: CAMPAIGN, delta: { granted: -5, stopped: 3 }, nowMs: NOW });
  const r = await m.read(CAMPAIGN);
  assert.equal(r.totals.granted, 0, '負の値で減らしている');
  assert.equal(r.totals.stopped, 3);
  const res = await m.bumpSteps({ campaignId: CAMPAIGN, delta: { 'a; DROP': { sent: 1 } }, nowMs: NOW });
  assert.equal(res.skipped, true, '壊れた step 番号を書き込んでいる');
});

test('normalizeDelta は負の値と壊れた値を落とす', () => {
  const d = normalizeDelta({ granted: -1, stopped: '3', purchased: 'x', completed: 2.7 });
  assert.equal(d.granted, 0);
  assert.equal(d.stopped, 3);
  assert.equal(d.purchased, 0);
  assert.equal(d.completed, 2);
});

// ── 復旧 ────────────────────────────────────────────────────

test('正本から作り直せる（ズレたときの復旧口）', async () => {
  const store = new Map();
  const m = createRolloutMetrics({ cmd: fakeRedis(store) });
  await m.bumpTotals({ campaignId: CAMPAIGN, delta: { granted: 999 }, nowMs: NOW });
  await m.reconcile({
    campaignId: CAMPAIGN,
    totals: { granted: 110, notStarted: 0, inProgress: 100, purchased: 3, stopped: 7, completed: 0 },
    steps: { steps: { 1: { sent: 110 } } },
    nowMs: NOW,
  });
  const r = await m.read(CAMPAIGN);
  assert.equal(r.totals.granted, 110, '作り直せていない');
  assert.equal(r.steps.steps['1'].sent, 110);
});

// ── 安全 ────────────────────────────────────────────────────

test('【重要】鍵は自分の名前空間の外へ出さない', () => {
  assert.match(metricsKey.totals(CAMPAIGN), new RegExp(`^${METRICS_ROOT}totals:`));
  assert.match(metricsKey.steps(CAMPAIGN), new RegExp(`^${METRICS_ROOT}steps:`));
  const m = createRolloutMetrics({ cmd: async () => 'OK' });
  assert.throws(() => m.assertKey('ak:marketing-rollout:state:x'), /rollout_metrics/);
  assert.throws(() => m.assertKey('ak:marketing-dispatch:lock:x'), /rollout_metrics/);
});

test('【重要】鍵にも値にも PII を入れない', async () => {
  assert.equal(isSafeCampaignId(CAMPAIGN), true);
  for (const bad of ['a@example.com', 'Camp Aign', '', null, 'x'.repeat(200)]) {
    assert.equal(isSafeCampaignId(bad), false, `${String(bad)} を通している`);
  }
  const m = createRolloutMetrics({ cmd: fakeRedis() });
  await assert.rejects(() => m.bumpTotals({ campaignId: 'a@example.com', delta: {}, nowMs: NOW }),
    (e) => e instanceof MetricsError && e.code === METRICS_FAIL.BAD_CAMPAIGN_ID);

  const store = new Map();
  const m2 = createRolloutMetrics({ cmd: fakeRedis(store) });
  await m2.bumpTotals({ campaignId: CAMPAIGN, delta: { granted: 1 }, nowMs: NOW });
  const raw = store.get(metricsKey.totals(CAMPAIGN));
  assert.equal(raw.includes('@'), false);
  assert.equal(/rec[A-Za-z0-9]{14}/.test(raw), false);
});

test('形式版が定義されている（形を変えたら上げる）', () => {
  assert.equal(emptyTotals().schema, METRICS_SCHEMA_VERSION);
  assert.equal(emptySteps().schema, METRICS_SCHEMA_VERSION);
});
