/**
 * drmEntryAdminAction.test.mjs — **HTTP から到達できる入口**（`action: 'drmEntryRun'`）
 *   node --test src/lib/drm/drmEntryAdminAction.test.mjs
 *
 * ── なぜこの経路が要るか（2026-09-14 本番実測）────────────────
 * `export const config = { schedule }` を持つ Netlify Function は**定期実行専用**で、
 * 公開 URL への POST は **403・本文 0 バイト**（認証の有無に関係ない）。**payload も渡せない**。
 * 同型の `cron-light-trial-grant` でも同じ挙動だった。
 * したがって「下見して、人数を確認して撃つ」は **admin 経由でしか実行できない**。
 *
 * ここで固定するのは「**薄いこと**」と「**fail closed**」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ENTRY_ABORT, DRM_ENTRY_ENV } from './drmEntryGates.js';
import { runDrmEntry } from '../../../netlify/functions/cron-drm-autostart.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const ADMIN = read('../../../netlify/functions/admin-marketing.js');
const SEQ_CRON = read('../../../netlify/functions/cron-campaign-sequence.js');
const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');

const PROD_LIKE = {
  MARKETING_SEQUENCE_SCHEDULER_ENABLED: 'false',
  MARKETING_SEQUENCE_CAMPAIGN_ID: 'campaign-discount-free,campaign-discount-light,campaign-discount-premium',
  MARKETING_CAMPAIGN_ENABLED: 'true',
  MARKETING_CAMPAIGN_DISPATCH_ENABLED: 'true',
};
const OPEN = { ...PROD_LIKE, [DRM_ENTRY_ENV]: 'true' };

/** admin の薄いハンドラと同じ呼び方（`manual: true`）*/
const asAdmin = (over = {}) => runDrmEntry({
  env: OPEN, now: 1, manual: true, ...over,
});

// ══════════════════════════════════════════════════════════════════
//  ① 薄い（判定を作り直していない）
// ══════════════════════════════════════════════════════════════════

test('【重要】admin の経路は runDrmEntry をそのまま呼ぶだけ', () => {
  const code = codeOnly(ADMIN);
  assert.match(code, /action === 'drmEntryRun'/, '経路が無い');
  const i = code.indexOf('async function handleDrmEntryRun(');
  assert.ok(i > 0);
  const body = code.slice(i, code.indexOf('\nasync function ', i + 10));
  assert.match(body, /runDrmEntry\(\{/, '既存の単一源を呼んでいない');
  assert.match(body, /manual: true/, '人数の確認を必須にしていない');
  // 判定・選定・キュー登録を作り直していない
  for (const bad of ['planAutoStartEntries(', 'runSequenceTick(', 'isEntryCampaignAllowed(',
    'readDrmEntryGates(', 'checkExpectedCount(', 'buildDeliveryRecords(',
    'buildScheduledEmailFields(', 'computeCampaignDeliveryKey(']) {
    assert.equal(body.includes(bad), false, `${bad} を admin 側で作り直している`);
  }
});

test('【安全】admin の経路は共有スケジューラの env を読まない', () => {
  const code = codeOnly(ADMIN);
  const i = code.indexOf('async function handleDrmEntryRun(');
  const body = code.slice(i, code.indexOf('\nasync function ', i + 10));
  for (const name of ['MARKETING_SEQUENCE_SCHEDULER_ENABLED', 'MARKETING_SEQUENCE_ARMED',
    'MARKETING_SEQUENCE_CAMPAIGN_ID']) {
    assert.equal(body.includes(name), false, `${name} を読んでいる`);
  }
});

// ══════════════════════════════════════════════════════════════════
//  ② fail closed（drift / 未指定で queue 0・send 0）
// ══════════════════════════════════════════════════════════════════

test('【最重要】実行なのに expectedCount を付けなければ queue 0 / send 0 で止まる', async () => {
  let tickCalled = 0;
  const r = await asAdmin({
    dryRun: false, expectedCount: null,
    deps: {
      previewEntry: async () => ({ ok: true, wouldEnter: 15 }),
      runSequenceTick: async () => { tickCalled += 1; return {}; },
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.abort, ENTRY_ABORT.COUNT_REQUIRED);
  assert.equal(tickCalled, 0, 'キュー登録が走った');
  assert.equal(r.sideEffects, 'none');
});

test('【最重要】下見と人数が違えば queue 0 / send 0 で止まる', async () => {
  let tickCalled = 0;
  const r = await asAdmin({
    dryRun: false, expectedCount: 15,
    deps: {
      previewEntry: async () => ({ ok: true, wouldEnter: 16 }),
      runSequenceTick: async () => { tickCalled += 1; return {}; },
    },
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
  const r = await asAdmin({
    dryRun: false, expectedCount: 15,
    deps: {
      previewEntry: async () => ({ ok: true, wouldEnter: 15 }),
      runSequenceTick: async (a) => { passed = a; return { ok: true, autoStart: { entered: 15 } }; },
    },
  });
  assert.equal(r.entered, 15);
  assert.equal(r.countDrift, null);
  assert.equal(passed.campaignId, 'free-signup-onboarding');
});

test('【重要】下見はゲートが閉じていても返り、tick を呼ばない', async () => {
  let tickCalled = 0;
  const r = await runDrmEntry({
    env: PROD_LIKE, now: 1, manual: true, dryRun: true,
    deps: {
      previewEntry: async () => ({ ok: true, wouldEnter: 15 }),
      runSequenceTick: async () => { tickCalled += 1; return {}; },
    },
  });
  assert.equal(r.dryRun, true);
  assert.equal(r.wouldEnter, 15);
  assert.equal(r.gates.entryOpen, false);
  assert.equal(tickCalled, 0);
  assert.equal(r.sideEffects, 'none');
});

test('【重要】入口のスイッチが閉じていれば実行しない', async () => {
  let tickCalled = 0;
  const r = await runDrmEntry({
    env: PROD_LIKE, now: 1, manual: true, dryRun: false, expectedCount: 15,
    deps: {
      previewEntry: async () => ({ ok: true, wouldEnter: 15 }),
      runSequenceTick: async () => { tickCalled += 1; return {}; },
    },
  });
  assert.equal(r.abort, ENTRY_ABORT.GATE_CLOSED);
  assert.ok(r.missing.includes(DRM_ENTRY_ENV));
  assert.equal(tickCalled, 0);
});

test('【最重要】admin 経由でも割引 3 本は撃てない', async () => {
  let tickCalled = 0;
  for (const id of ['campaign-discount-free', 'campaign-discount-light', 'campaign-discount-premium']) {
    const r = await asAdmin({
      campaignId: id, dryRun: false, expectedCount: 0,
      deps: { runSequenceTick: async () => { tickCalled += 1; return {}; } },
    });
    assert.equal(r.abort, ENTRY_ABORT.CAMPAIGN_NOT_ALLOWED, `${id} が通っている`);
    assert.equal(r.sideEffects, 'none');
  }
  assert.equal(tickCalled, 0);
});

// ══════════════════════════════════════════════════════════════════
//  ③ 既存の契約は変えていない
// ══════════════════════════════════════════════════════════════════

test('【不変】共有の cron（#521 / #523）を変更していない', () => {
  const code = codeOnly(SEQ_CRON);
  assert.match(code, /readSequenceGates\(env, now\)/);
  assert.match(code, /if \(!gates\.allOpen\)/);
  assert.match(code, /allowFirstStep: autoStartDecl !== null && autoStartGate\.open === true/);
  assert.equal(code.includes('drmEntryRun'), false);
  assert.equal(code.includes('runDrmEntry'), false);
});

test('【不変】定期実行は従来どおり日次のまま', () => {
  const FN = read('../../../netlify/functions/cron-drm-autostart.js');
  assert.match(FN, /export const config = \{ schedule: '0 1 \* \* \*' \}/);
});

test('【記録】scheduled Function は HTTP から起動できないことが docs に固定されている', () => {
  const FN = read('../../../netlify/functions/cron-drm-autostart.js');
  assert.match(FN, /HTTP から起動できない/);
  assert.match(FN, /payload も渡せない/);
});
