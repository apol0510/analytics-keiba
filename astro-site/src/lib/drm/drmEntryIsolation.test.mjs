/**
 * drmEntryIsolation.test.mjs — **DRM の入口が共有スケジューラから分離されている**
 *   node --test src/lib/drm/drmEntryIsolation.test.mjs
 *
 * 2026-09-14 の本番実測で分かったこと:
 *   `MARKETING_SEQUENCE_SCHEDULER_ENABLED` = false /
 *   `MARKETING_SEQUENCE_CAMPAIGN_ID` = 割引 3 本
 * のため、DRM の入口（15 名）を開けるには**共有スイッチ**を開けるしかなく、
 * その瞬間に割引 3 本（step2 保留中・step1 は 15,509 通配信済み）が tick される構造だった。
 *
 * ここで固定するのは「**入口を開けても割引 3 本は動かない**」こと。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  DRM_ENTRY_CAMPAIGN_IDS, DRM_ENTRY_ENV, DRM_ENTRY_BASE_ENV, FORBIDDEN_ENV, ENTRY_ABORT,
  isEntryCampaignAllowed, readDrmEntryGates, checkExpectedCount,
} from './drmEntryGates.js';
import { runDrmEntry } from '../../../netlify/functions/cron-drm-autostart.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const FN = read('../../../netlify/functions/cron-drm-autostart.js');
const SEQ_CRON = read('../../../netlify/functions/cron-campaign-sequence.js');
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

/** 送信の土台は開いている・入口だけ閉じている本番相当の env */
const PROD_LIKE = {
  MARKETING_SEQUENCE_SCHEDULER_ENABLED: 'false',
  MARKETING_SEQUENCE_CAMPAIGN_ID: 'campaign-discount-free,campaign-discount-light,campaign-discount-premium',
  MARKETING_CAMPAIGN_ENABLED: 'true',
  MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true',
};

/** 入口の鍵（#526 と同型）。テストでは差し替える */
const lockDeps = {
  createDispatchLock: () => ({ acquire: async () => ({ ok: true, token: 't' }), release: async () => {} }),
  makeRedisCmd: () => async () => null,
};

// ══════════════════════════════════════════════════════════════════
//  ① 対象は許可リストだけ（割引 3 本を構造的に排除）
// ══════════════════════════════════════════════════════════════════

test('【最重要】入口の対象は free-signup-onboarding だけ', () => {
  assert.deepEqual([...DRM_ENTRY_CAMPAIGN_IDS], ['free-signup-onboarding']);
  assert.equal(isEntryCampaignAllowed('free-signup-onboarding'), true);
  for (const id of ['campaign-discount-free', 'campaign-discount-light',
    'campaign-discount-premium', 'light-trial-to-premium-sequence']) {
    assert.equal(isEntryCampaignAllowed(id), false, `${id} が入口として撃てる`);
  }
});

test('【最重要】割引キャンペーンを名指しされても撃たない', async () => {
  let tickCalled = 0;
  for (const id of ['campaign-discount-free', 'campaign-discount-light', 'campaign-discount-premium']) {
    const r = await runDrmEntry({
      env: { ...PROD_LIKE, [DRM_ENTRY_ENV]: 'true' }, now: Date.now(), campaignId: id,
      dryRun: false, expectedCount: 0,
      deps: { runSequenceTick: async () => { tickCalled += 1; return {}; }, previewEntry: async () => ({ ok: true, wouldEnter: 0 }) },
    });
    assert.equal(r.ok, false);
    assert.equal(r.abort, ENTRY_ABORT.CAMPAIGN_NOT_ALLOWED, `${id} が拒否されていない`);
    assert.equal(r.sideEffects, 'none');
  }
  assert.equal(tickCalled, 0, '割引キャンペーンで tick が走った');
});

// ══════════════════════════════════════════════════════════════════
//  ② 入口は 1 つの env だけで制御する
// ══════════════════════════════════════════════════════════════════

test('【最重要】共有スケジューラの env を読まない', () => {
  const code = codeOnly(FN);
  for (const name of FORBIDDEN_ENV) {
    // 合成 env として **書く**のは許すが、入口の判断材料として**読まない**
    const readsIt = new RegExp(`env\\[['"\`]?${name}`).test(code)
      || new RegExp(`env\\.${name}`).test(code)
      || new RegExp(`process\\.env\\.${name}`).test(code);
    assert.equal(readsIt, false, `${name} を読んでいる（また共有スイッチに縛られる）`);
  }
  // 入口の判断は 1 つの env だけ
  assert.match(code, /readDrmEntryGates\(env\)/);
});

test('【重要】入口のスイッチが閉じていれば実行しない', async () => {
  let tickCalled = 0;
  const r = await runDrmEntry({
    env: { ...PROD_LIKE }, now: Date.now(), dryRun: false, expectedCount: 0,
    deps: { runSequenceTick: async () => { tickCalled += 1; return {}; } },
  });
  assert.equal(r.ok, false);
  assert.equal(r.abort, ENTRY_ABORT.GATE_CLOSED);
  assert.ok(r.missing.includes(DRM_ENTRY_ENV));
  assert.equal(tickCalled, 0);
  assert.equal(r.sideEffects, 'none');
});

test('【重要】送信の土台のゲートは迂回しない（既存の安全装置を通る）', () => {
  // 土台が閉じていれば、入口が開いていても実行しない
  const closed = readDrmEntryGates({ [DRM_ENTRY_ENV]: 'true' });
  assert.equal(closed.entryOpen, true);
  assert.equal(closed.allOpen, false);
  assert.ok(closed.missing.includes(DRM_ENTRY_BASE_ENV.ENQUEUE));
  assert.ok(closed.missing.includes(DRM_ENTRY_BASE_ENV.DISPATCH));
  // 3 つ揃って初めて開く
  const open = readDrmEntryGates({ ...PROD_LIKE, [DRM_ENTRY_ENV]: 'true' });
  assert.equal(open.allOpen, true);
  assert.deepEqual(open.missing, []);
});

test('【安全】"true" 以外では開かない', () => {
  for (const v of ['', 'false', '1', 'TRUE', 'yes']) {
    assert.equal(readDrmEntryGates({ [DRM_ENTRY_ENV]: v }).entryOpen, false, `"${v}" で開いている`);
  }
});

// ══════════════════════════════════════════════════════════════════
//  ③ 下見の人数を超えて送らない
// ══════════════════════════════════════════════════════════════════

test('【最重要】下見の人数と違えば 1 通も送らない', async () => {
  let tickCalled = 0;
  const deps = {
    previewEntry: async () => ({ ok: true, wouldEnter: 16, campaignId: 'free-signup-onboarding' }),
    runSequenceTick: async () => { tickCalled += 1; return { autoStart: { entered: 16 } }; },
  };
  const r = await runDrmEntry({
    env: { ...PROD_LIKE, [DRM_ENTRY_ENV]: 'true' }, now: Date.now(),
    dryRun: false, expectedCount: 15, deps,
  });
  assert.equal(r.ok, false);
  assert.equal(r.abort, ENTRY_ABORT.COUNT_MISMATCH);
  assert.equal(r.planned, 16);
  assert.equal(r.expected, 15);
  assert.equal(tickCalled, 0, '人数が違うのに送っている');
  assert.equal(r.sideEffects, 'none');
});

test('【重要】人数が一致すれば実行する', async () => {
  let passed = null;
  const deps = {
    previewEntry: async () => ({ ok: true, wouldEnter: 15, campaignId: 'free-signup-onboarding' }),
    runSequenceTick: async (args) => { passed = args; return { ok: true, autoStart: { entered: 15 } }; },
    ...lockDeps,
  };
  const r = await runDrmEntry({
    env: { ...PROD_LIKE, [DRM_ENTRY_ENV]: 'true' }, now: 1234,
    dryRun: false, expectedCount: 15, deps,
  });
  assert.equal(r.entered, 15);
  assert.equal(r.countDrift, null);
  assert.equal(passed.campaignId, 'free-signup-onboarding', '対象が差し替わっている');
});

test('【安全】実行なのに人数を伝えていなければ止める', () => {
  const r = checkExpectedCount({ planned: 15, expectedCount: undefined, manual: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, ENTRY_ABORT.COUNT_REQUIRED);
});

test('【安全】下見と実際がズレたら必ず報告する（黙って通さない）', async () => {
  const deps = {
    previewEntry: async () => ({ ok: true, wouldEnter: 15, campaignId: 'free-signup-onboarding' }),
    runSequenceTick: async () => ({ ok: true, autoStart: { entered: 16 } }),
    ...lockDeps,
  };
  const r = await runDrmEntry({
    env: { ...PROD_LIKE, [DRM_ENTRY_ENV]: 'true' }, now: 1,
    dryRun: false, expectedCount: 15, deps,
  });
  assert.deepEqual(r.countDrift, { expected: 15, entered: 16 });
});

// ══════════════════════════════════════════════════════════════════
//  ④ 下見は書かない・ゲートが閉じていても見られる
// ══════════════════════════════════════════════════════════════════

test('【重要】下見はゲートが閉じていても返り、tick を呼ばない', async () => {
  let tickCalled = 0;
  const r = await runDrmEntry({
    env: { ...PROD_LIKE }, now: Date.now(), dryRun: true,
    deps: {
      previewEntry: async () => ({ ok: true, wouldEnter: 15 }),
      runSequenceTick: async () => { tickCalled += 1; return {}; },
    },
  });
  assert.equal(r.dryRun, true);
  assert.equal(r.wouldEnter, 15);
  assert.equal(r.sideEffects, 'none');
  assert.equal(r.gates.entryOpen, false);
  assert.equal(tickCalled, 0);
});

// ══════════════════════════════════════════════════════════════════
//  ⑤ 既存の契約を作り直していない
// ══════════════════════════════════════════════════════════════════

test('【重要】キュー登録・DeliveryKey を作り直さず既存 tick に委ねる', () => {
  const code = codeOnly(FN);
  // 既存 tick を import して委ねている（呼び出しは deps 差し替え可能な変数経由）
  assert.match(FN, /import \{ runSequenceTick \} from '\.\/cron-campaign-sequence\.js'/,
    '既存 tick を import していない');
  assert.match(code, /deps\.runSequenceTick \|\| runSequenceTick/, '既存 tick に委ねていない');
  assert.match(code, /await tick\(\{ env: tickEnv, now, campaignId \}\)/, 'tick を呼んでいない');
  for (const bad of ['buildDeliveryRecords(', 'buildScheduledEmailFields(',
    'computeCampaignDeliveryKey(', 'buildCampaignPlan(', 'performUpsert']) {
    assert.equal(code.includes(bad), false, `${bad} を作り直している（安全装置のコピーになる）`);
  }
  // 入口の選定は既存の純粋関数
  assert.match(code, /planAutoStartEntries\(\{/);
});

test('【不変】共有の cron を変更していない（#521 / #523 の契約）', () => {
  const code = codeOnly(SEQ_CRON);
  // 既存の 4 ゲート判定と入口の配線はそのまま
  assert.match(code, /readSequenceGates\(env, now\)/);
  assert.match(code, /!gates\.allOpen/, 'ゲート判定が外れている');
  assert.match(code, /allowFirstStep: autoStartDecl !== null && autoStartGate\.open === true/);
  // 新しい Function を参照していない（依存の向きは DRM → 既存 の一方向）
  assert.equal(code.includes('cron-drm-autostart'), false);
  assert.equal(code.includes('runDrmEntry'), false);
});

test('【安全】この Function は Customers を書かない・メールを送らない', () => {
  const code = codeOnly(FN);
  assert.equal(/method: 'PATCH'/.test(code), false, 'Customers を書いている');
  assert.equal(/sendgrid|SENDGRID_API_KEY/i.test(code), false, '送信基盤を直接叩いている');
  // 読み取りは listRecords（POST だが読み取り専用の Airtable API）だけ
  const posts = code.match(/method: 'POST'/g) || [];
  const listRecords = code.match(/listRecords/g) || [];
  assert.equal(posts.length, listRecords.length, '読み取り以外の POST がある');
});

test('【安全】定期実行は 1 日 1 回（高頻度で回さない）', () => {
  assert.match(FN, /export const config = \{ schedule: '0 1 \* \* \*' \}/);
});
