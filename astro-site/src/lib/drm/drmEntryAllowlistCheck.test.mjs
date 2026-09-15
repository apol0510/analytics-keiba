/**
 * drmEntryAllowlistCheck.test.mjs — **実送信 0 のまま**許可リストの効きを窓で確かめる経路
 *   node --test src/lib/drm/drmEntryAllowlistCheck.test.mjs
 *
 * 2026-09-14 の事故（承認 16 名 → Recipients 50 / SentCount 46）の直しが
 * **最終 recipient 集合に効いているか**を、本番で 1 通も送らずに確認するための read-only 経路。
 *
 * 2026-09-15 に窓を刻まず呼んで **504** になったので、`sequenceTickPreview` と
 * **同じ窓契約**（scope / offset / limit / digest / ledgerOffset / scanPages）へ寄せた。
 *
 * ここで守ること:
 *   - 窓ごとに**その場で**下見を作り直す（古い候補を使い回さない）
 *   - 渡すのは **recordId だけ**（候補データを渡して再検証を短絡させない）
 *   - `runSequenceTick` は **`dryRun: true`** で呼ぶ（予約より手前で return する）
 *   - planner の集合が動いたら **fail closed**（最初からやり直す）
 *   - prospect 索引が動いたら **fail closed**
 *   - 応答に **recordId もアドレスも出さない**
 *   - 書き込み系のいずれも起きない
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkEntryAllowlist } from '../../../netlify/functions/cron-drm-autostart.js';
import {
  digestRecordIds, emptyWindowRun, mergeWindowRun, finalizeWindowRun, judgeWindow, WINDOW_FAIL,
} from './drmAllowlistWindow.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const DRM = read('../../../netlify/functions/cron-drm-autostart.js');
const CRON = read('../../../netlify/functions/cron-campaign-sequence.js');
const ADMIN = read('../../../netlify/functions/admin-marketing.js');

const CAMPAIGN = 'free-signup-onboarding';
const ENV = { AIRTABLE_API_KEY: 'k', AIRTABLE_BASE_ID: 'b' };

/** 入口が「入れてよい」と数えた 3 名（事故後の実測と同じ人数） */
const IDS = ['recSIGNUP01', 'recSIGNUP02', 'recSIGNUP03'];
const DIGEST = digestRecordIds(IDS);

/** prospect 索引の規模（本番実測 約 11,973） */
const INDEX_SIZE = 11973;
const LIMIT = 2000;

const preview = (recordIds) => async () => ({
  ok: true, campaignId: CAMPAIGN, version: 1,
  scanned: 16, considered: 16,
  wouldEnter: recordIds.length,
  recordIds: [...recordIds],
  capped: false, carriedOver: 0, skipped: { already_started: 13 },
});

/**
 * `runSequenceTick` の下見応答（**許可リスト適用後**の姿）を、窓に応じて返す。
 * 窓ごとに prospect を読み進めるが、最終集合には 1 人も残らない。
 */
function tickWindowed(calls, opts = {}) {
  return async (args) => {
    calls.push(args);
    const win = args.preview || {};
    const offset = Number(win.offset) || 0;
    const scanned = Math.min(LIMIT, Math.max(0, INDEX_SIZE - offset));
    const nextOffset = offset + scanned < INDEX_SIZE ? offset + scanned : null;
    return {
      ok: true, dryRun: true, step: 1, campaignId: CAMPAIGN, sideEffects: 'none',
      gates: { allOpen: false, missing: ['MARKETING_SEQUENCE_SCHEDULER_ENABLED'] },
      'この tick の候補': scanned + 3,
      'うち prospect': scanned,
      'うち Customers': 3,
      // 許可リストを掛けたあとに残るのは入口の 3 名だけ
      '絞り込み後に送る人数': opts.finalRecipients ?? 3,
      entryAllowlist: {
        許可人数: 3,
        許可リスト外で除外: scanned,
        許可リスト外の残り: opts.outside ?? 0,
      },
      最終対象の出所: { prospect: opts.prospectInFinal ?? 0, Customers: 3, 出所不明: 0 },
      window: {
        scope: win.scope || null,
        ledgerPages: 2,
        nextLedgerOffset: opts.ledgerDone === false ? 'off1' : null,
        prospect: {
          indexSize: INDEX_SIZE, digest: opts.digest ?? 'dg1', scanned,
          offset, nextOffset,
        },
        prospectSkipped: opts.prospectSkipped ?? null,
      },
    };
  };
}

/** 全窓を歩く（呼び出し側の手順を機械に固定する） */
async function walkAllWindows({ previewFn, tickFn }) {
  let acc = emptyWindowRun();
  let expectPlanner = null;
  let window = { limit: LIMIT, scanPages: 2 };
  const seenWindows = [];
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop -- cursor 方式なので直列
    const out = await checkEntryAllowlist({
      env: ENV, now: 1, campaignId: CAMPAIGN, window, expectPlanner,
      deps: { previewEntry: previewFn, runSequenceTick: tickFn },
    });
    seenWindows.push(out);
    if (out.ok === false && out.abort) break;
    acc = mergeWindowRun(acc, {
      planner: { count: out.plannerCount, digest: out.plannerDigest },
      finalRecipients: out.finalRecipients,
      verdict: judgeWindow({
        plannerCount: out.plannerCount,
        finalRecipients: out.finalRecipients,
        outsideAllowlist: out.entryAllowlist ? out.entryAllowlist['許可リスト外の残り'] : 0,
        prospectInFinal: out['最終対象の出所'].prospect,
        prospectSkipped: out.window.prospectSkipped,
      }),
      done: out.next.done,
    });
    if (out.next.done) break;
    expectPlanner = { count: out.plannerCount, digest: out.plannerDigest };
    window = {
      limit: LIMIT, scanPages: 2,
      offset: out.next.offset ?? 0,
      digest: out.next.digest,
      ledgerOffset: out.next.ledgerOffset,
    };
  }
  return { run: finalizeWindowRun(acc), windows: seenWindows };
}

// ══════════════════════════════════════════════════════════════════
//  ① 本番相当の走査（planner 3 + prospect 約 12,000 を複数窓で）
// ══════════════════════════════════════════════════════════════════

test('【最重要】planner 3 + prospect 約 12,000 を複数窓で走査し、全窓で外へ出ない', async () => {
  const calls = [];
  const { run, windows } = await walkAllWindows({
    previewFn: preview(IDS), tickFn: tickWindowed(calls),
  });

  assert.ok(windows.length >= 6, `窓が刻まれていない（${windows.length} 窓）`);
  assert.equal(run.complete, true, '読み切っていない');
  assert.equal(run.allowlistHolds, true, '許可リストが効いていると言えない');
  assert.deepEqual(run.violations, []);

  // planner は 3 名で固定されたまま
  assert.equal(run.planner.count, 3);
  assert.equal(run.planner.digest, DIGEST);

  // ⚠️ 足していない（6 窓 × 3 名 = 18 にならない）
  assert.equal(run.maxFinalInWindow, 3);

  for (const w of windows) {
    assert.equal(w['最終対象の出所'].prospect, 0, '最終集合に prospect が残っている');
    assert.equal(w.entryAllowlist['許可リスト外の残り'], 0, '許可リスト外が残っている');
    assert.ok(w.finalRecipients <= w.plannerCount, 'planner を超えた');
    assert.equal(w.sideEffects, 'none');
    assert.equal(w.plannerDigest, DIGEST, 'plannerDigest が固定されていない');
  }

  // 索引は本当に読み進んでいる（同じ窓を何度も読んでいない）
  const offsets = calls.map((c) => Number(c.preview.offset) || 0);
  assert.deepEqual(offsets, [...new Set(offsets)].sort((a, b) => a - b), '窓が進んでいない');
  assert.equal(offsets[0], 0);
  assert.ok(offsets[offsets.length - 1] + LIMIT >= INDEX_SIZE, '索引を読み切っていない');
});

test('【最重要】窓ごとに下見を作り直し、毎回 dryRun で呼ぶ', async () => {
  const calls = [];
  let previews = 0;
  const countingPreview = async (a) => { previews += 1; return preview(IDS)(a); };
  await walkAllWindows({ previewFn: countingPreview, tickFn: tickWindowed(calls) });

  assert.equal(previews, calls.length, '窓ごとに下見を作り直していない');
  for (const c of calls) {
    assert.equal(c.dryRun, true);
    assert.deepEqual(c.entryAllowlist, IDS);
    assert.equal(c.campaignId, CAMPAIGN);
    assert.equal(c.expectedCount, undefined, '送る前提の引数を渡さない');
    assert.ok(c.preview && Number.isFinite(Number(c.preview.limit)), '窓を渡していない');
  }
});

test('【最重要】応答に recordId もメールアドレスも出さない', async () => {
  const { windows } = await walkAllWindows({
    previewFn: preview(IDS), tickFn: tickWindowed([]),
  });
  for (const w of windows) {
    const s = JSON.stringify(w);
    assert.ok(!/@/.test(s), 'アドレスが出ている');
    for (const id of IDS) assert.ok(!s.includes(id), 'recordId が出ている');
  }
});

// ══════════════════════════════════════════════════════════════════
//  ② fail closed（途中で前提が動いたら止める）
// ══════════════════════════════════════════════════════════════════

test('【最重要】planner が窓の途中で変わったら止めて最初からやり直させる', async () => {
  const out = await checkEntryAllowlist({
    env: ENV, now: 1, campaignId: CAMPAIGN,
    window: { offset: 2000, limit: LIMIT },
    expectPlanner: { count: 3, digest: digestRecordIds(['recX', 'recY', 'recZ']) },
    deps: {
      previewEntry: preview(IDS),
      runSequenceTick: async () => { throw new Error('ここまで来てはいけない'); },
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.abort, WINDOW_FAIL.PLANNER_CHANGED);
  assert.equal(out.sideEffects, 'none');
  assert.match(out.note, /最初の窓からやり直/);
});

test('【最重要】prospect 索引が途中で変わったら不合格にする', async () => {
  const { run, windows } = await walkAllWindows({
    previewFn: preview(IDS),
    tickFn: tickWindowed([], { prospectSkipped: WINDOW_FAIL.PROSPECT_INDEX_CHANGED }),
  });
  assert.equal(windows[0].ok, false);
  assert.ok(windows[0].violations.includes(WINDOW_FAIL.PROSPECT_INDEX_CHANGED));
  assert.equal(run.allowlistHolds, false);
});

test('【最重要】許可リスト外が 1 人でも残っていたら不合格', async () => {
  const { run, windows } = await walkAllWindows({
    previewFn: preview(IDS), tickFn: tickWindowed([], { outside: 1 }),
  });
  assert.equal(windows[0].ok, false);
  assert.ok(run.violations.includes(WINDOW_FAIL.OUTSIDE_ALLOWLIST));
  assert.equal(run.allowlistHolds, false);
});

test('【最重要】事故時の姿（最終 50 名）なら不合格になる', async () => {
  const { run } = await walkAllWindows({
    previewFn: preview(IDS), tickFn: tickWindowed([], { finalRecipients: 50 }),
  });
  assert.ok(run.violations.includes(WINDOW_FAIL.OVER_PLANNER));
  assert.equal(run.allowlistHolds, false);
});

test('台帳側が読み切れていなければ done にしない', async () => {
  const out = await checkEntryAllowlist({
    env: ENV, now: 1, campaignId: CAMPAIGN,
    window: { offset: INDEX_SIZE - 100, limit: LIMIT },
    deps: { previewEntry: preview(IDS), runSequenceTick: tickWindowed([], { ledgerDone: false }) },
  });
  assert.equal(out.next.offset, null, 'prospect は読み切っている');
  assert.equal(out.next.ledgerOffset, 'off1');
  assert.equal(out.next.done, false, '片方でも残っていれば done にしない');
});

test('許可リストの campaign 以外は下見すらしない', async () => {
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

test('ゲートを合成しない（開いていると誤解させない）', async () => {
  const calls = [];
  const out = await checkEntryAllowlist({
    env: { ...ENV, MARKETING_SEQUENCE_SCHEDULER_ENABLED: 'false' },
    now: 1, campaignId: CAMPAIGN, window: { limit: LIMIT },
    deps: { previewEntry: preview(IDS), runSequenceTick: tickWindowed(calls) },
  });
  assert.equal(calls[0].env.MARKETING_SEQUENCE_SCHEDULER_ENABLED, 'false');
  assert.equal(out.gates.entryOpen, false);
});

test('下見 / tick が落ちても副作用なしと言い切れる', async () => {
  const a = await checkEntryAllowlist({
    env: ENV, now: 1, campaignId: CAMPAIGN,
    deps: {
      previewEntry: async () => { throw new Error('airtable down'); },
      runSequenceTick: async () => { throw new Error('呼んではいけない'); },
    },
  });
  assert.equal(a.abort, 'preview_failed');
  assert.equal(a.sideEffects, 'none');

  const b = await checkEntryAllowlist({
    env: ENV, now: 1, campaignId: CAMPAIGN,
    deps: { previewEntry: preview(IDS), runSequenceTick: async () => { throw new Error('boom'); } },
  });
  assert.equal(b.abort, 'tick_failed');
  assert.equal(b.sideEffects, 'none');
});

// ══════════════════════════════════════════════════════════════════
//  ③ 実装の形（新しい経路を作っていない / 何も書かない）
// ══════════════════════════════════════════════════════════════════

function bodyOf(src, name, kind = 'export async function') {
  const start = src.indexOf(`${kind} ${name}(`);
  assert.ok(start > 0, `${name} が見つかりません`);
  const end = src.indexOf('\n}\n', start);
  assert.ok(end > start);
  return src.slice(start, end);
}

test('【重要】確認経路は既存 runSequenceTick の下見だけを使う', () => {
  const fn = bodyOf(DRM, 'checkEntryAllowlist');
  assert.match(fn, /dryRun: true/);
  assert.match(fn, /entryAllowlist: allowlist/);
  assert.match(fn, /preview: win/);
  for (const banned of [
    'buildDeliveryRecords', 'buildCampaignPlan', 'claimDelivered',
    'createDispatchLock', 'sendCampaign', 'fetch(', 'saveCursor', 'sequenceMetrics',
  ]) {
    assert.ok(!fn.includes(banned), `${banned} を確認経路へ持ち込まない`);
  }
});

test('【重要】確認経路は排他ロックを取らない（live の邪魔をしない）', () => {
  const fn = bodyOf(DRM, 'checkEntryAllowlist');
  assert.ok(!fn.includes('acquire('));
});

test('【重要】下見は予約より手前で返る（書き込みが構造的に起きない）', () => {
  const dry = CRON.indexOf('  if (isDry) {');
  // ⚠️ コメント中の `claimDelivered` ではなく**呼び出し**を見る
  const claim = CRON.indexOf('.claimDelivered(');
  assert.ok(dry > 0, '下見の分岐が見つからない');
  assert.ok(claim > dry, '下見の return が予約より後ろにある');
});

test('【重要】窓契約は sequenceTickPreview と同じ名前を使う', () => {
  const fn = bodyOf(ADMIN, 'handleDrmEntryAllowlistCheck', 'async function');
  for (const k of ['scope', 'offset', 'limit', 'digest', 'ledgerOffset', 'scanPages']) {
    assert.ok(fn.includes(`${k}: req.${k}`), `窓の ${k} を受け取っていない`);
  }
  assert.match(fn, /plannerDigest/);
  for (const banned of ['planAutoStartEntries', 'runSequenceTick', 'expectedCount', 'dryRun: false']) {
    assert.ok(!fn.includes(banned), `${banned} をここで作り直さない`);
  }
});
