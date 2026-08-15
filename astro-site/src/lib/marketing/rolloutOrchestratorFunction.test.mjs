/**
 * rolloutOrchestratorFunction.test.mjs — 運転手 Function（`cron-marketing-rollout`）
 *   node --test src/lib/marketing/rolloutOrchestratorFunction.test.mjs
 *
 * 守る性質:
 *   - **ゲートが閉じていれば 1 バイトも読み書きしない**（Redis にも Airtable にも触らない）
 *   - 武装の判断は展開状態（Redis）で行い、env の日付書き換えを要求しない
 *   - 事実が読めなければ何もしない
 *   - **新しい書き込み経路を作っていない**（付与・queue・送信は既存の 1 本ずつ）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  runRolloutTick, isArmedByState, armEnvForTick, deriveFacts, collectFinishedJobs, ROLLOUT_CAMPAIGN_ID,
} from '../../../netlify/functions/cron-marketing-rollout.js';
import { defaultRolloutState, ROLLOUT_STAGE, jstDay } from './rolloutPlan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '../../../netlify/functions/cron-marketing-rollout.js'), 'utf8');
/** コメントを除いた本体（説明文に出てくる語で誤検知しないように） */
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '')).join('\n');

const NOW = Date.parse('2026-08-16T05:00:00Z'); // JST 14:00

// ── ゲート ──────────────────────────────────────────────────

test('【重要】ゲートが閉じていれば何にも接続しない', async () => {
  const orig = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('接続してはいけない'); };
  try {
    const out = await runRolloutTick({ env: {}, now: NOW });
    assert.equal(out.ok, false);
    assert.equal(out.abort, 'rollout_disabled');
    assert.equal(out.sideEffects, 'none');
    assert.equal(calls, 0, `${calls} 回接続している`);
  } finally { globalThis.fetch = orig; }
});

test('【重要】Redis が無ければ進めない（推測で付与しない）', async () => {
  const out = await runRolloutTick({ env: { MARKETING_ROLLOUT_ENABLED: 'true' }, now: NOW });
  assert.equal(out.ok, false);
  assert.equal(out.abort, 'redis_not_configured');
  assert.equal(out.sideEffects, 'none');
});

test('【重要】展開状態が読めなければ進めない', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('redis down'); };
  try {
    const out = await runRolloutTick({
      env: {
        MARKETING_ROLLOUT_ENABLED: 'true',
        UPSTASH_REDIS_REST_URL: 'https://example.invalid',
        UPSTASH_REDIS_REST_TOKEN: 'x',
      },
      now: NOW,
    });
    assert.equal(out.ok, false);
    assert.equal(out.abort, 'state_unreadable');
    assert.equal(out.sideEffects, 'none');
  } finally { globalThis.fetch = orig; }
});

// ── 武装（env の日付書き換えを不要にする本体）───────────────

test('【重要】停止中・緊急停止では武装しない', () => {
  assert.equal(isArmedByState(defaultRolloutState(), NOW), false, '既定（停止）で動いている');
  assert.equal(isArmedByState({ ...defaultRolloutState(), stage: ROLLOUT_STAGE.STEADY, killed: true, alwaysArmed: true }, NOW), false);
});

test('【重要】alwaysArmed なら毎日 env を置き直さずに動く', () => {
  const s = { ...defaultRolloutState(), stage: ROLLOUT_STAGE.STEADY, alwaysArmed: true };
  assert.equal(isArmedByState(s, NOW), true);
  // 何日経っても効き続ける（人手不要）
  assert.equal(isArmedByState(s, NOW + 60 * 86400_000), true);
});

test('日付指定での運用も従来どおり残る（翌日には閉じる）', () => {
  const s = { ...defaultRolloutState(), stage: ROLLOUT_STAGE.STEADY, armedFor: jstDay(NOW) };
  assert.equal(isArmedByState(s, NOW), true);
  assert.equal(isArmedByState(s, NOW + 86400_000), false);
});

test('【重要】武装しているときだけ当日日付を差し込む（他の env は変えない）', () => {
  const env = { A: '1', LIGHT_TRIAL_AUTOGRANT_ENABLED: 'true' };
  const paused = armEnvForTick(env, defaultRolloutState(), NOW);
  assert.equal(paused.LIGHT_TRIAL_AUTOGRANT_ARMED, undefined, '停止中なのに武装している');

  const armed = armEnvForTick(env, { ...defaultRolloutState(), stage: ROLLOUT_STAGE.STEADY, alwaysArmed: true }, NOW);
  assert.equal(armed.LIGHT_TRIAL_AUTOGRANT_ARMED, jstDay(NOW));
  assert.equal(armed.A, '1');
  assert.equal(armed.LIGHT_TRIAL_AUTOGRANT_ENABLED, 'true', '人の許可を書き換えている');
  assert.equal(env.LIGHT_TRIAL_AUTOGRANT_ARMED, undefined, '元の env を壊している');
});

test('【重要】人の許可（env）までは肩代わりしない', () => {
  const armed = armEnvForTick({}, { ...defaultRolloutState(), stage: ROLLOUT_STAGE.STEADY, alwaysArmed: true }, NOW);
  for (const k of ['COMEBACK_GRANT_FIELDS_READY', 'COMEBACK_GRANT_ENABLED', 'LIGHT_TRIAL_AUTOGRANT_ENABLED']) {
    assert.equal(armed[k], undefined, `${k} を自動で開けている`);
  }
});

// ── 事実の導出 ──────────────────────────────────────────────

test('【重要】関所が読めなければ全部 null（0 と書かない）', () => {
  const f = deriveFacts({ barrier: null, moreAvailable: true, pendingJobs: 0, cohortObserved: 100 });
  assert.equal(f.outstandingStep1, null);
  assert.equal(f.remainingCandidates, null);
});

test('【重要】ジョブ数が読めなければ全部 null', () => {
  const f = deriveFacts({ barrier: { outstanding: 0 }, moreAvailable: true, pendingJobs: null, cohortObserved: 100 });
  assert.equal(f.pendingJobs, null);
});

test('【重要】関所の値が空でも 0 と書かない', () => {
  for (const bad of [null, undefined, '']) {
    const f = deriveFacts({ barrier: { outstanding: bad }, moreAvailable: true, pendingJobs: 0, cohortObserved: 10 });
    assert.equal(f.outstandingStep1, null, `outstanding=${String(bad)} を 0 と扱っている`);
  }
});

test('【重要】送信待ちジョブがあるときは queue 対象を 0 にする（二重にジョブを積まない）', () => {
  const f = deriveFacts({ barrier: { outstanding: 100 }, moreAvailable: true, pendingJobs: 1, cohortObserved: 100 });
  assert.equal(f.grantedPendingQueue, 0);
  assert.equal(f.outstandingStep1, 100, '関所の事実まで消している');
});

test('ジョブが無ければ未処理をそのまま queue 対象にする', () => {
  const f = deriveFacts({ barrier: { outstanding: 100 }, moreAvailable: true, pendingJobs: 0, cohortObserved: 100 });
  assert.equal(f.grantedPendingQueue, 100);
});

test('候補が尽きていれば残数 0、不明なら null', () => {
  assert.equal(deriveFacts({ barrier: { outstanding: 0 }, moreAvailable: false, pendingJobs: 0 }).remainingCandidates, 0);
  assert.equal(deriveFacts({ barrier: { outstanding: 0 }, moreAvailable: null, pendingJobs: 0 }).remainingCandidates, null);
});

// ── 経路を増やしていないこと（ソース検査）────────────────────

test('【重要】付与は既存の 1 本を呼ぶ（自前で Customers を書かない）', () => {
  assert.ok(SOURCE.includes("import { runLightTrialGrant }"), '付与の単一源を使っていない');
  assert.equal(/method:\s*'PATCH'/.test(CODE), false, '自前で Customers を書いている');
  assert.equal(CODE.includes('/Customers'), false, 'Customers を直接触っている');
});

test('【重要】queue は管理画面と同じ関数を通す（自前で ScheduledEmails を作らない）', () => {
  assert.ok(SOURCE.includes("action: 'dryRun'") && SOURCE.includes("action: 'send'"), '既存の登録経路を通っていない');
  assert.equal(CODE.includes('ScheduledEmails'), false, '自前でジョブ行を作っている');
  assert.equal(CODE.includes('CampaignDeliveries'), false, '自前で台帳を書いている');
});

test('【重要】dry-run の指紋・文面・組み立て版をそのまま渡す（すり替え防止）', () => {
  for (const k of ['planFingerprint', 'contentHash', 'shellVersion']) {
    assert.ok(SOURCE.includes(k), `${k} を持ち回っていない`);
  }
});

test('【重要】送信は Background Function へ渡すだけ（自前で SendGrid を叩かない）', () => {
  assert.ok(SOURCE.includes('marketing-campaign-dispatch-background'), '送信起動が既存経路でない');
  assert.equal(/sendgrid|SG\./i.test(CODE), false, '自前で送信している');
});

test('【重要】1 tick 1 段階（同じ tick で付与から送信まで走り抜けない）', () => {
  // 付与したその足で queue まで進むと、失敗時にどこまで進んだか分からなくなる
  const grantBlock = SOURCE.slice(SOURCE.indexOf('TICK_ACTION.GRANT'), SOURCE.indexOf('TICK_ACTION.QUEUE'));
  assert.equal(grantBlock.includes('queueStep1'), false, '付与と queue を同じ tick で行っている');
  assert.equal(grantBlock.includes('startDispatch'), false, '付与と送信を同じ tick で行っている');
});

test('対象キャンペーンは 24 通の連続配信', () => {
  assert.equal(ROLLOUT_CAMPAIGN_ID, 'light-trial-to-premium-sequence');
});

test('【重要】スケジュール登録されている（人が叩かなくても進む）', () => {
  assert.ok(/export const config = \{\s*schedule:/.test(SOURCE), 'cron 登録が無い');
});

test('【重要】実績の写しは「進めない tick」でも行う（送ったのに 0 通のまま残さない）', () => {
  const skipBlock = CODE.slice(CODE.indexOf('TICK_ACTION.SKIP'), CODE.indexOf('TICK_ACTION.GRANT'));
  assert.ok(skipBlock.includes('settledJobs'), 'skip する tick で実績を写していない');
  // 写す前に return していないこと（順序の逆転を固定する）
  assert.ok(
    CODE.indexOf('collectFinishedJobs') < CODE.indexOf('TICK_ACTION.SKIP'),
    '実績を写す前に skip で戻っている',
  );
});

test('【重要】写し終えたジョブは追跡から外す（二重に数えない）', () => {
  const r = collectFinishedJobs({
    pendingJobIds: ['a', 'b', 'c'],
    byId: new Map([
      ['a', { status: 'COMPLETED', sentCount: 100, failedCount: 2 }],
      ['b', { status: 'PENDING', sentCount: 0, failedCount: 0 }],
    ]),
  });
  assert.equal(r.finished.length, 1);
  assert.equal(r.sent, 100);
  assert.equal(r.failed, 2);
  // 送信中と、見つからないジョブは**判断しない**（次 tick で見る）
  assert.deepEqual(r.stillRunning, ['b', 'c']);
});
