/**
 * drmEntryAllowlistCheck.test.mjs — **実送信 0 のまま**許可リストの効きを確かめる経路
 *   node --test src/lib/drm/drmEntryAllowlistCheck.test.mjs
 *
 * 2026-09-14 の事故（承認 16 名 → Recipients 50 / SentCount 46）の直しが
 * **最終 recipient 集合に効いているか**を、本番で 1 通も送らずに確認するための read-only 経路。
 *
 * ここで守るのは:
 *   - 下見は**その場で**作り直す（古い候補を使い回さない）
 *   - 渡すのは **recordId だけ**（候補データを渡して再検証を短絡させない）
 *   - `runSequenceTick` は **`dryRun: true`** で呼ぶ（予約より手前で return する）
 *   - ゲートを**合成しない**（開いていると誤解させない）
 *   - 書き込み系のいずれも起きない（`sideEffects: 'none'`）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkEntryAllowlist } from '../../../netlify/functions/cron-drm-autostart.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const DRM = read('../../../netlify/functions/cron-drm-autostart.js');
const CRON = read('../../../netlify/functions/cron-campaign-sequence.js');
const ADMIN = read('../../../netlify/functions/admin-marketing.js');

const CAMPAIGN = 'free-signup-onboarding';
const ENV = { AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'b' };

/** 下見（planner）の戻りを模す */
const preview = (recordIds, extra = {}) => async () => ({
  ok: true, campaignId: CAMPAIGN, version: 1,
  scanned: 16, considered: 16,
  wouldEnter: recordIds.length,
  recordIds: [...recordIds],
  capped: false, carriedOver: 0, skipped: { already_started: 13 },
  ...extra,
});

/** `runSequenceTick` の下見応答を模す（許可リスト適用後の姿） */
const tickDry = (calls, body) => async (args) => {
  calls.push(args);
  return {
    ok: true, dryRun: true, step: 1, campaignId: CAMPAIGN, sideEffects: 'none',
    gates: { allOpen: false, missing: ['MARKETING_SEQUENCE_SCHEDULER_ENABLED'] },
    'この tick の候補': 11973,
    'うち prospect': 11970,
    'うち Customers': 3,
    '絞り込み後に送る人数': 3,
    entryAllowlist: { 許可人数: 3, 許可リスト外で除外: 11970, 許可リスト外の残り: 0 },
    最終対象の出所: { prospect: 0, Customers: 3, 出所不明: 0 },
    ...body,
  };
};

const IDS = ['recA', 'recB', 'recC'];

// ══════════════════════════════════════════════════════════════════
//  ① 呼び方（fresh な下見 → 同じ呼び出しで dryRun tick）
// ══════════════════════════════════════════════════════════════════

test('【最重要】その場の下見が返した recordId をそのまま許可リストに渡す', async () => {
  const calls = [];
  await checkEntryAllowlist({
    env: ENV, now: 1, campaignId: CAMPAIGN,
    deps: { previewEntry: preview(IDS), runSequenceTick: tickDry(calls) },
  });
  assert.equal(calls.length, 1, 'tick は 1 回だけ');
  assert.deepEqual(calls[0].entryAllowlist, IDS);
});

test('【最重要】tick は必ず dryRun: true で呼ぶ（予約を取らせない）', async () => {
  const calls = [];
  await checkEntryAllowlist({
    env: ENV, now: 1, campaignId: CAMPAIGN,
    deps: { previewEntry: preview(IDS), runSequenceTick: tickDry(calls) },
  });
  assert.equal(calls[0].dryRun, true);
  assert.equal(calls[0].expectedCount, undefined, '送る前提の引数を渡さない');
});

test('【重要】候補データ（アドレス等）を tick へ渡さない', async () => {
  const calls = [];
  await checkEntryAllowlist({
    env: ENV, now: 1, campaignId: CAMPAIGN,
    deps: { previewEntry: preview(IDS), runSequenceTick: tickDry(calls) },
  });
  const payload = JSON.stringify(calls[0].entryAllowlist);
  assert.ok(!/@/.test(payload), 'アドレスが混ざっている');
  assert.ok(calls[0].entryAllowlist.every((v) => typeof v === 'string'));
});

test('【重要】ゲートを合成しない（開いていると誤解させない）', async () => {
  const calls = [];
  const env = { ...ENV, MARKETING_SEQUENCE_SCHEDULER_ENABLED: 'false' };
  const out = await checkEntryAllowlist({
    env, now: 1, campaignId: CAMPAIGN,
    deps: { previewEntry: preview(IDS), runSequenceTick: tickDry(calls) },
  });
  assert.equal(calls[0].env.MARKETING_SEQUENCE_SCHEDULER_ENABLED, 'false',
    'live 経路のように true を合成してはいけない');
  assert.equal(out.gates.entryOpen, false, '入口は閉じたまま');
});

test('【重要】campaignId を明示で渡す（割引 3 本を tick しない）', async () => {
  const calls = [];
  await checkEntryAllowlist({
    env: { ...ENV, MARKETING_SEQUENCE_CAMPAIGN_ID: 'campaign-discount-free' },
    now: 1, campaignId: CAMPAIGN,
    deps: { previewEntry: preview(IDS), runSequenceTick: tickDry(calls) },
  });
  assert.equal(calls[0].campaignId, CAMPAIGN);
});

test('【重要】許可リストの campaign 以外は下見すらしない', async () => {
  let called = false;
  const out = await checkEntryAllowlist({
    env: ENV, now: 1, campaignId: 'campaign-discount-premium',
    deps: {
      previewEntry: async () => { called = true; return { ok: true }; },
      runSequenceTick: async () => { throw new Error('呼んではいけない'); },
    },
  });
  assert.equal(out.ok, false);
  assert.equal(called, false);
  assert.equal(out.sideEffects, 'none');
});

// ══════════════════════════════════════════════════════════════════
//  ② 返す数字（本番で目視する 5 点）
// ══════════════════════════════════════════════════════════════════

test('【最重要】planner 3 / 最終 3 / prospect 0 / 許可リスト外 0 / 副作用なし', async () => {
  const out = await checkEntryAllowlist({
    env: ENV, now: 1, campaignId: CAMPAIGN,
    deps: { previewEntry: preview(IDS), runSequenceTick: tickDry([]) },
  });
  assert.equal(out.plannerCount, 3);
  assert.equal(out.finalRecipients, 3);
  assert.equal(out['最終対象の出所'].prospect, 0);
  assert.equal(out.entryAllowlist['許可リスト外の残り'], 0);
  assert.equal(out.sideEffects, 'none');
  assert.equal(out.withinPlanner, true);
});

test('【最重要】最終人数が planner を超えたら withinPlanner: false で分かる', async () => {
  const out = await checkEntryAllowlist({
    env: ENV, now: 1, campaignId: CAMPAIGN,
    deps: {
      previewEntry: preview(IDS),
      runSequenceTick: tickDry([], { '絞り込み後に送る人数': 50 }),   // 事故時の姿
    },
  });
  assert.equal(out.plannerCount, 3);
  assert.equal(out.finalRecipients, 50);
  assert.equal(out.withinPlanner, false, '超過を黙って通してはいけない');
});

test('下見が失敗したら数字を作らない', async () => {
  const out = await checkEntryAllowlist({
    env: ENV, now: 1, campaignId: CAMPAIGN,
    deps: {
      previewEntry: async () => { throw new Error('airtable down'); },
      runSequenceTick: async () => { throw new Error('呼んではいけない'); },
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.abort, 'preview_failed');
  assert.equal(out.sideEffects, 'none');
});

test('tick が落ちても副作用なしと言い切れる（下見は予約より手前）', async () => {
  const out = await checkEntryAllowlist({
    env: ENV, now: 1, campaignId: CAMPAIGN,
    deps: {
      previewEntry: preview(IDS),
      runSequenceTick: async () => { throw new Error('boom'); },
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.abort, 'tick_failed');
  assert.equal(out.sideEffects, 'none');
});

// ══════════════════════════════════════════════════════════════════
//  ③ 実装の形（新しい送信経路を作っていない）
// ══════════════════════════════════════════════════════════════════

function bodyOf(src, name) {
  const start = src.indexOf(`export async function ${name}(`);
  assert.ok(start > 0, `${name} が見つかりません`);
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start);
  return src.slice(start, end);
}

test('【重要】確認経路は既存 runSequenceTick だけを使う（送信処理を書かない）', () => {
  const fn = bodyOf(DRM, 'checkEntryAllowlist');
  assert.match(fn, /dryRun: true/);
  assert.match(fn, /entryAllowlist: allowlist/);
  for (const banned of [
    'buildDeliveryRecords', 'buildCampaignPlan', 'claimDelivered',
    'createDispatchLock', 'sendCampaign', 'fetch(',
  ]) {
    assert.ok(!fn.includes(banned), `${banned} を確認経路へ持ち込まない`);
  }
});

test('【重要】確認経路は排他ロックを取らない（live の邪魔をしない）', () => {
  const fn = bodyOf(DRM, 'checkEntryAllowlist');
  assert.ok(!fn.includes('acquire('), 'ロックを取ってはいけない');
});

test('【重要】下見の応答が許可リストの効きを数字で返す', () => {
  assert.match(CRON, /entryAllowlist: allowed\.constrained \? \{/);
  assert.match(CRON, /許可リスト外の残り: dryWithin\.outside \|\| 0/);
  assert.match(CRON, /最終対象の出所/);
});

test('【重要】許可リスト未指定なら下見の応答は従来どおり（共有 tick 不変）', () => {
  assert.match(CRON, /entryAllowlist: allowed\.constrained \? \{[\s\S]*?\} : null/);
});

test('【重要】管理画面の action は薄い（判定を作り直さない）', () => {
  const start = ADMIN.indexOf('async function handleDrmEntryAllowlistCheck(');
  assert.ok(start > 0);
  const fn = ADMIN.slice(start, ADMIN.indexOf('\n}\n', start));
  assert.match(fn, /checkEntryAllowlist\(/);
  for (const banned of ['planAutoStartEntries', 'runSequenceTick', 'expectedCount', 'dryRun: false']) {
    assert.ok(!fn.includes(banned), `${banned} をここで作り直さない`);
  }
});
