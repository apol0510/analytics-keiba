/**
 * rolloutControlHandler.test.mjs — 展開状態の書き換え action（本物のハンドラを起動する）
 *   node --test src/lib/marketing/rolloutControlHandler.test.mjs
 *
 * 守る性質:
 *   - **書くのは Redis の展開状態だけ**（Customers・台帳・SendGrid へ触らない）
 *   - env（`MARKETING_ROLLOUT_ENABLED`）が閉じているうちは状態も触らせない
 *   - 壊れた指定は 400 で**書かない**
 *   - CAS が競合したら 409 で**書かない**
 *   - kill は競合しても通る（止める操作は通したい）
 *   - 応答に PII / secret を入れない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { jstDay, defaultRolloutState } from './rolloutPlan.js';
import { rolloutKey } from './rolloutStore.js';

const SECRET = 'test-admin-secret';
const CAMPAIGN_ID = 'light-trial-to-premium-sequence';
const NOW = Date.now();
const TODAY = jstDay(NOW);

/** 偽 Redis（CAS の意味を保つ）+ 触られた外部 URL の記録 */
function stubWorld({ initial = null } = {}) {
  const redis = new Map();
  if (initial) redis.set(rolloutKey.state(CAMPAIGN_ID), JSON.stringify(initial));
  const touched = [];

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    touched.push(u);
    if (/api\.airtable\.com/.test(u)) throw new Error('Airtable を触ってはいけない');
    if (/api\.sendgrid\.com/.test(u)) throw new Error('SendGrid を触ってはいけない');
    // Upstash REST
    const args = JSON.parse(init.body || '[]');
    const op = String(args[0] || '').toUpperCase();
    let result = null;
    if (op === 'GET') result = redis.has(args[1]) ? redis.get(args[1]) : null;
    else if (op === 'SET') { redis.set(args[1], String(args[2])); result = 'OK'; }
    else if (op === 'DEL') { redis.delete(args[1]); result = 1; }
    else if (op === 'EVAL') {
      const key = args[3];
      const cur = redis.get(key);
      const expected = String(args[5] ?? '');
      if (cur) {
        const m = /"version":(\d+)/.exec(cur);
        result = (!m || m[1] !== expected) ? 'CONFLICT' : null;
      } else if (expected !== '') {
        result = 'MISSING';
      }
      if (result === null) { redis.set(key, args[4]); result = 'OK'; }
    }
    return { ok: true, status: 200, json: async () => ({ result }) };
  };
  return {
    redis,
    touched,
    state: () => {
      const raw = redis.get(rolloutKey.state(CAMPAIGN_ID));
      return raw ? JSON.parse(raw) : null;
    },
  };
}

async function invoke(payload, { rolloutEnabled = true } = {}) {
  process.env.PREMIUM_PLUS_ADMIN_SECRET = SECRET;
  process.env.AIRTABLE_API_KEY = 'test-key';
  process.env.AIRTABLE_BASE_ID = 'appTEST';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  if (rolloutEnabled) process.env.MARKETING_ROLLOUT_ENABLED = 'true';
  else delete process.env.MARKETING_ROLLOUT_ENABLED;
  const mod = await import('../../../netlify/functions/admin-marketing.js');
  const res = await mod.handler({
    httpMethod: 'POST',
    headers: { 'x-admin-secret': SECRET },
    body: JSON.stringify({ campaignId: CAMPAIGN_ID, ...payload }),
  });
  return { statusCode: res.statusCode, body: JSON.parse(res.body || '{}') };
}

const startPayload = (over = {}) => ({
  action: 'rolloutStart',
  stage: 'canary',
  dailyLimit: 100,
  alwaysArmed: false,
  armedFor: TODAY,
  expectedVersion: null,
  note: 'activation canary 100 (one-shot)',
  ...over,
});

// ── 開始 ──────────────────────────────────────────────────────

test('【重要】100 名 one-shot を新規作成できる（付与は 1 件もしない）', async () => {
  const w = stubWorld();
  const { statusCode, body } = await invoke(startPayload());
  assert.equal(statusCode, 200, JSON.stringify(body).slice(0, 200));
  assert.equal(body.stage, 'canary');
  assert.equal(body.dailyLimit, 100);
  assert.equal(body.alwaysArmed, false);
  assert.equal(body.armedFor, TODAY);
  assert.equal(body.killed, false);
  assert.ok(body.notice.includes('まだ 1 件も付与していません'));
  // 保存されている
  assert.equal(w.state().stage, 'canary');
  assert.equal(w.state().dailyLimit, 100);
});

test('【重要】書くのは展開状態だけ（Airtable / SendGrid を触らない）', async () => {
  const w = stubWorld();
  await invoke(startPayload());
  assert.equal(w.touched.some((u) => /airtable|sendgrid/.test(u)), false,
    `外部を触っている: ${w.touched.join(', ')}`);
  assert.ok(w.touched.every((u) => /redis\.invalid/.test(u)));
});

test('【重要】env が閉じていれば状態を触らせない', async () => {
  const w = stubWorld();
  const { statusCode, body } = await invoke(startPayload(), { rolloutEnabled: false });
  assert.equal(statusCode, 503);
  assert.equal(body.flag, 'MARKETING_ROLLOUT_ENABLED');
  assert.equal(body.sideEffects, 'none');
  assert.equal(w.state(), null, 'ゲートが閉じているのに書いている');
});

test('【重要】壊れた指定は 400 で、1 バイトも書かない', async () => {
  for (const bad of [
    { stage: 'canary10' },
    { dailyLimit: 99999 },
    { dailyLimit: '100' },
    { alwaysArmed: false, armedFor: undefined },
    { armedFor: '2020-01-01' },
    { expectedVersion: undefined },
  ]) {
    const w = stubWorld();
    // eslint-disable-next-line no-await-in-loop
    const { statusCode, body } = await invoke(startPayload(bad));
    assert.equal(statusCode, 400, `${JSON.stringify(bad)} を受け入れている`);
    assert.equal(body.sideEffects, 'none');
    assert.equal(w.state(), null, `${JSON.stringify(bad)} で書き込んでいる`);
  }
});

test('【重要】CAS が競合したら 409 で書かない', async () => {
  // 既存 version=5 なのに expectedVersion=2 で来た
  const w = stubWorld({ initial: { ...defaultRolloutState(), version: 5, stage: 'steady' } });
  const { statusCode, body } = await invoke(startPayload({ expectedVersion: 2 }));
  assert.equal(statusCode, 409, JSON.stringify(body).slice(0, 200));
  assert.equal(body.code, 'cas_conflict');
  assert.equal(body.sideEffects, 'none');
  assert.equal(w.state().stage, 'steady', '競合したのに書き換えている');
});

test('既存キーを正しい版で更新できる（500 名へ拡大する形）', async () => {
  const w = stubWorld({ initial: { ...defaultRolloutState(), version: 5, stage: 'canary' } });
  const { statusCode, body } = await invoke(startPayload({
    stage: 'scale', dailyLimit: 500, expectedVersion: 5,
  }));
  assert.equal(statusCode, 200, JSON.stringify(body).slice(0, 200));
  assert.equal(w.state().stage, 'scale');
  assert.equal(w.state().dailyLimit, 500);
  assert.equal(w.state().version, 6, '版が上がっていない');
});

// ── 緊急停止 / 一時停止 / 再開 ────────────────────────────────

test('【重要】kill で緊急停止できる（rollback の主手段）', async () => {
  const w = stubWorld({ initial: { ...defaultRolloutState(), version: 2, stage: 'canary', dailyLimit: 100 } });
  const { statusCode, body } = await invoke({ action: 'rolloutKill', note: 'incident' });
  assert.equal(statusCode, 200, JSON.stringify(body).slice(0, 200));
  assert.equal(body.killed, true);
  assert.equal(w.state().killed, true);
  assert.ok(body.notice.includes('次の cron tick'), body.notice);
  assert.ok(body.notice.includes('MARKETING_CAMPAIGN_DISPATCH_ENABLED'),
    '送信経路を閉じる最終手段が案内されていない');
});

test('kill は状態が無くても通る（まだ開始していなくても止められる）', async () => {
  stubWorld();
  const { statusCode, body } = await invoke({ action: 'rolloutKill' });
  assert.equal(statusCode, 200, JSON.stringify(body).slice(0, 200));
  assert.equal(body.killed, true);
});

test('pause は新規付与だけ止める（killed は立てない）', async () => {
  const w = stubWorld({ initial: { ...defaultRolloutState(), version: 1, stage: 'steady', alwaysArmed: true } });
  const { statusCode, body } = await invoke({ action: 'rolloutPause' });
  assert.equal(statusCode, 200, JSON.stringify(body).slice(0, 200));
  assert.equal(body.stage, 'paused');
  assert.equal(body.killed, false);
  assert.equal(w.state().alwaysArmed, false);
});

test('resume は停止を解除するが、段階は上げない', async () => {
  const w = stubWorld({ initial: { ...defaultRolloutState(), version: 1, stage: 'paused', killed: true } });
  const { statusCode, body } = await invoke({ action: 'rolloutResume' });
  assert.equal(statusCode, 200, JSON.stringify(body).slice(0, 200));
  assert.equal(body.killed, false);
  assert.equal(body.stage, 'paused', '再開だけで段階を上げている');
  assert.equal(w.state().killed, false);
});

// ── 入口の守り ────────────────────────────────────────────────

test('【重要】secret が違えば 403（誰でも配信量を変えられない）', async () => {
  stubWorld();
  process.env.PREMIUM_PLUS_ADMIN_SECRET = SECRET;
  process.env.MARKETING_ROLLOUT_ENABLED = 'true';
  const mod = await import('../../../netlify/functions/admin-marketing.js');
  const res = await mod.handler({
    httpMethod: 'POST',
    headers: { 'x-admin-secret': 'wrong' },
    body: JSON.stringify({ action: 'rolloutStart', campaignId: CAMPAIGN_ID }),
  });
  assert.equal(res.statusCode, 403);
});

test('連続配信でないキャンペーンは断る', async () => {
  stubWorld();
  const { statusCode } = await invoke({ action: 'rolloutStart', campaignId: 'marketing-canary' });
  assert.equal(statusCode, 400);
});

test('応答に PII / secret を入れない', async () => {
  stubWorld();
  const { body } = await invoke(startPayload());
  const dump = JSON.stringify(body);
  assert.equal(/@|rec[A-Za-z0-9]{14}|Bearer|token/i.test(dump), false, dump.slice(0, 200));
});

// ── 開始に必要な版を read-only で取れる（2026-08-16 追加）──────────
//    `rolloutStart` は CAS のため `expectedVersion` を要求する。
//    その値を読む手段が無いと、運用者は開始できない（8/17 の 500 名 one-shot で必要）。

test('【重要】rollout は展開状態の版を返す（expectedVersion に使える）', async () => {
  const w = stubWorld({ initial: { ...defaultRolloutState(), version: 7, stage: 'paused' } });
  const { statusCode, body } = await invoke({ action: 'rollout', campaignId: CAMPAIGN_ID });
  assert.equal(statusCode, 200, JSON.stringify(body).slice(0, 200));
  assert.equal(body.stateVersion, 7, '版を返していない（開始できない）');
  assert.equal(body.stateExists, true);
  assert.equal(w.state().version, 7, '読むだけで書き換えている');
});

test('【重要】状態が無ければ版は null（＝新規作成の合図）', async () => {
  stubWorld();
  const { body } = await invoke({ action: 'rollout', campaignId: CAMPAIGN_ID });
  assert.equal(body.stateVersion, null);
  assert.equal(body.stateExists, false);
});

test('【重要】返した版でそのまま開始できる（読み → 開始が繋がる）', async () => {
  stubWorld({ initial: { ...defaultRolloutState(), version: 3, stage: 'paused' } });
  const read = await invoke({ action: 'rollout', campaignId: CAMPAIGN_ID });
  const start = await invoke(startPayload({
    stage: 'scale', dailyLimit: 500, expectedVersion: read.body.stateVersion,
  }));
  assert.equal(start.statusCode, 200, JSON.stringify(start.body).slice(0, 200));
  assert.equal(start.body.stage, 'scale');
  assert.equal(start.body.dailyLimit, 500);
});

test('rollout は read-only のまま（版を返しても書かない）', async () => {
  const w = stubWorld({ initial: { ...defaultRolloutState(), version: 2 } });
  const { body } = await invoke({ action: 'rollout', campaignId: CAMPAIGN_ID });
  assert.equal(body.sideEffects, 'none');
  assert.equal(w.state().version, 2);
});
