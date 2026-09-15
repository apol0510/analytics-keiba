/**
 * sequenceTickRotation.test.mjs — **後ろの campaign が永久に進まない**を直す
 *   node --test src/lib/marketing/sequenceTickRotation.test.mjs
 *
 * ## なぜ要るか（2026-09-15 本番実測）
 *
 * 1 tick の実行時間には上限がある（実測 **60,000 / 60,340 ms** で打ち切り）。
 * 「先頭から順に」だと先頭の `campaign-discount-free` で時間を使い切り、
 * **`campaign-discount-light` / `campaign-discount-premium` は 3 tick 連続で 1 度も走らなかった**
 * （両者の要約ログが 0 件。下見では light 2 名・premium 10 名が due）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  rotateCampaigns, hasTimeForAnother, TICK_TIME_BUDGET_MS, MIN_MS_FOR_NEXT_CAMPAIGN,
} from './sequenceTickRotation.js';

const CRON = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/cron-campaign-sequence.js', import.meta.url)),
  'utf8',
);
const IDS = ['campaign-discount-free', 'campaign-discount-light', 'campaign-discount-premium'];
const TICK = 10 * 60 * 1000;

test('【重要】tick ごとに先頭が回る（どの campaign にも番が来る）', () => {
  const heads = new Set();
  for (let i = 0; i < 6; i += 1) {
    heads.add(rotateCampaigns({ ids: IDS, nowMs: i * TICK })[0]);
  }
  assert.deepEqual([...heads].sort(), [...IDS].sort(), '先頭に来ない campaign がある');
});

test('【重要】並べ替えるだけ（増やさない・減らさない）', () => {
  for (let i = 0; i < 5; i += 1) {
    const out = rotateCampaigns({ ids: IDS, nowMs: i * TICK });
    assert.equal(out.length, IDS.length);
    assert.deepEqual([...out].sort(), [...IDS].sort());
  }
});

test('【重要】同じ時刻なら同じ並び（乱数を使わない・再現できる）', () => {
  const a = rotateCampaigns({ ids: IDS, nowMs: 3 * TICK });
  const b = rotateCampaigns({ ids: IDS, nowMs: 3 * TICK });
  assert.deepEqual(a, b);
  const lib = readFileSync(fileURLToPath(new URL('./sequenceTickRotation.js', import.meta.url)), 'utf8');
  assert.equal(lib.includes('Math.random'), false, '乱数を使っている');
});

test('1 本以下・壊れた入力でも落ちない', () => {
  assert.deepEqual(rotateCampaigns({ ids: [] }), []);
  assert.deepEqual(rotateCampaigns({ ids: ['a'] }), ['a']);
  assert.deepEqual(rotateCampaigns({}), []);
  assert.deepEqual(rotateCampaigns({ ids: IDS, nowMs: NaN }), IDS);
});

test('【重要】残り時間が足りなければ新しい campaign を始めない', () => {
  const t0 = 1_000_000;
  assert.equal(hasTimeForAnother({ startedAtMs: t0, nowMs: t0 }), true, '開始直後に始められない');
  // 予算 55 秒・最低 50 秒 → 6 秒経つと次は始めない
  assert.equal(hasTimeForAnother({ startedAtMs: t0, nowMs: t0 + 6000 }), false);
  assert.ok(TICK_TIME_BUDGET_MS > MIN_MS_FOR_NEXT_CAMPAIGN, '予算が最低所要より短い');
});

// ══════════════════════════════════════════════════════════════════
//  cron への配線
// ══════════════════════════════════════════════════════════════════

test('【重要】定期 cron は campaign を回してから進める', () => {
  assert.match(CRON, /rotateCampaigns\(\{ ids: declared, nowMs: startedAt \}\)/, '回していない');
  const iRot = CRON.indexOf('rotateCampaigns({');
  const iLoop = CRON.indexOf('for (const campaignId of ids)');
  assert.ok(iRot > 0 && iLoop > iRot, '回す前に回している');
});

test('【重要】時間切れの campaign を黙って落とさない', () => {
  assert.match(CRON, /hasTimeForAnother\(\{ startedAtMs: startedAt/, '残り時間を見ていない');
  assert.match(CRON, /skippedForTime\.push\(campaignId\)/, '始めなかった campaign を残していない');
  assert.match(CRON, /action: 'deferred', campaigns: skippedForTime/, 'ログへ残していない');
  assert.match(CRON, /deferred: skippedForTime,/, '応答へ出していない');
});

test('【重要】1 本目は必ず走る（時間切れで全部止まらない）', () => {
  assert.match(CRON, /if \(results\.length > 0 && !hasTimeForAnother/,
    '1 本目まで時間切れで飛ばしてしまう');
});
