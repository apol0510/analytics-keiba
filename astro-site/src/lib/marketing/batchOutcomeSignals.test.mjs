/**
 * batchOutcomeSignals.test.mjs — 健全性の入力は「前バッチで**起きたこと**」だけ
 *   node --test src/lib/marketing/batchOutcomeSignals.test.mjs
 *
 * 2026-08-17 に 2 度誤停止した:
 *   1 度目 … `byStopReason` の**累積**をそのまま苦情として渡した
 *            → コホートに元から居る停止リスト該当者 1 名で永久停止
 *   2 度目 … その**差分**を取った
 *            → 展開は 1 バッチ 500 名ずつ母集団が増えるので、
 *              以前から停止リストに載っていた人が母集団へ入るだけで差分が増える
 *
 * 正しい source は `EmailBlacklist`（Event Webhook が書く唯一の経路）。
 * **イベントが起きたときにだけ行が増える**ので、母集団が増えても増えない。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  summarizeBlacklistWindow, captureOutcomeSnapshot, diffOutcomeSnapshot,
  hasOutcomeBaseline, toStoredOutcome, blacklistWindowFormula, OUTCOME_FIELDS,
} from './batchOutcomeSignals.js';
import { canStartNextBatch, BATCH_STOP } from './batchHealth.js';
import { normalizeRolloutState, planRolloutTick, ROLLOUT_STAGE, ROLLOUT_BLOCK, jstDay } from './rolloutPlan.js';

const NOW = Date.UTC(2026, 7, 18, 1, 0, 0);
const bl = (types) => types.map((t) => ({ fields: { BounceType: t } }));

/** 健全性判定まで通す（しきい値は既存のまま） */
function judge({ baseline, current, previousOutstanding = 0, suppressionReadable = true }) {
  const d = diffOutcomeSnapshot(baseline, current);
  return canStartNextBatch({
    sent: d.counts.sent, failed: d.counts.failed, duplicates: d.counts.duplicates,
    bounces: d.counts.bounces, complaints: d.counts.complaints,
    unsubscribes: d.counts.unsubscribes,
    previousOutstanding, suppressionReadable,
  });
}

const snapshot = ({ sent, failed = 0, duplicates = 0, types }) => captureOutcomeSnapshot({
  jobsSent: sent, jobsFailed: failed, duplicates, blacklist: summarizeBlacklistWindow(bl(types)),
});

// ── 母集団が増えても増えない（今回の本題）──────────────────────────

test('【重要】既に provider suppression 該当の人が母集団へ入っても complaint=0', () => {
  // 前バッチ後: blacklist は「昨日の hard bounce 1 件」だけ
  const before = snapshot({ sent: 610, types: ['hard'] });
  // 次のバッチ前: 母集団が 500 名増え、その中に**以前から**停止リストに載っている人が 30 名居る。
  //              しかし EmailBlacklist の行は増えない（新しいイベントが起きていない）
  const after = snapshot({ sent: 1_110, types: ['hard'] });
  const d = diffOutcomeSnapshot(before, after);
  assert.equal(d.counts.complaints, 0, '母集団の増加を苦情として数えている');
  assert.equal(d.counts.unsubscribes, 0, '母集団の増加を配信停止として数えている');
  assert.equal(d.counts.bounces, 0);
  assert.equal(d.counts.sent, 500, '前バッチの送信数が取れていない');
  assert.equal(judge({ baseline: before, current: after }).ok, true);
});

test('【重要】not_sendable の人数は unsubscribe イベントとして数えない', () => {
  // 健全性の入力に `due`（現在状態の集計）を使っていないこと（実装の配線を固定）
  const src = readFileSyncRel('netlify/functions/cron-marketing-rollout.js');
  const call = src.slice(src.indexOf('const health = canStartNextBatch({'), src.indexOf('if (!health.ok)'));
  assert.ok(call.length > 0, '健全性判定の呼び出しが見つからない');
  assert.equal(/byStopReason/.test(call), false, '現在状態の停止理由を健全性へ渡している');
  // **件数**は 1 つも `due`（候補評価の集計）から取らない。
  // （`suppressionReadable` だけは「集計を読めたか」の確認なので `due` を見てよい）
  for (const field of ['sent', 'failed', 'duplicates', 'bounces', 'complaints', 'unsubscribes']) {
    const line = call.split('\n').find((l) => l.trim().startsWith(`${field}:`)) || '';
    assert.equal(/due\b/.test(line), false, `${field} を候補評価の集計から取っている: ${line.trim()}`);
    assert.ok(/delta\.counts\./.test(line), `${field} が前バッチの増分になっていない: ${line.trim()}`);
  }
  assert.ok(src.includes('readBlacklistWindow'), '実イベント源を読んでいない');
  const reader = readFileSyncRel('src/lib/marketing/blacklistWindowReader.js');
  assert.ok(reader.includes('summarizeBlacklistWindow'), '分類していない');
  assert.ok(reader.includes('EmailBlacklist'), '正本テーブルを読んでいない');
  // 現在状態の停止理由を健全性の入力に変換していない（コメント以外での使用が無い）
  const code = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
  assert.equal(/byStopReason/.test(code), false, 'コード中で停止理由を参照している');
});

test('【重要】soft bounce 履歴を hard bounce として数えない', () => {
  const s = summarizeBlacklistWindow(bl(['soft', 'soft', 'hard']));
  assert.equal(s.bounces, 1, 'soft を hard として数えている');
  assert.equal(s.softBounces, 2);
});

// ── 本当に起きたら止める（しきい値は既存のまま）────────────────────

test('【重要】本当に spam complaint が 1 件起きたら止める', () => {
  const before = snapshot({ sent: 610, types: [] });
  const after = snapshot({ sent: 1_110, types: ['spam'] });
  const d = diffOutcomeSnapshot(before, after);
  assert.equal(d.counts.complaints, 1);
  const h = judge({ baseline: before, current: after });
  assert.equal(h.ok, false, '新しい苦情を見逃している');
  assert.equal(h.reason, BATCH_STOP.COMPLAINTS);
});

test('【重要】unsubscribe が増えたら率で判定（2% 超で停止）', () => {
  const before = snapshot({ sent: 610, types: [] });
  const ok = snapshot({ sent: 1_110, types: Array(9).fill('unsubscribe') });      // 9/500 = 1.8%
  const ng = snapshot({ sent: 1_110, types: Array(11).fill('unsubscribe') });     // 11/500 = 2.2%
  assert.equal(judge({ baseline: before, current: ok }).ok, true);
  const h = judge({ baseline: before, current: ng });
  assert.equal(h.ok, false);
  assert.equal(h.reason, BATCH_STOP.UNSUBSCRIBE_RATE);
});

test('【重要】hard bounce が増えたら率で判定（2% 超で停止）', () => {
  const before = snapshot({ sent: 610, types: [] });
  const ng = snapshot({ sent: 1_110, types: [...Array(8).fill('hard'), ...Array(4).fill('blocked')] });
  const h = judge({ baseline: before, current: ng });   // 12/500 = 2.4%
  assert.equal(h.ok, false);
  assert.equal(h.reason, BATCH_STOP.BOUNCE_RATE);
});

test('【重要】送信失敗・二重送信の既存契約は維持', () => {
  const before = snapshot({ sent: 610, failed: 0, duplicates: 0, types: [] });
  const failed = snapshot({ sent: 1_110, failed: 30, duplicates: 0, types: [] });  // 30/500 = 6% > 5%
  assert.equal(judge({ baseline: before, current: failed }).reason, BATCH_STOP.FAILED_RATE);
  const dup = snapshot({ sent: 1_110, failed: 0, duplicates: 1, types: [] });
  assert.equal(judge({ baseline: before, current: dup }).reason, BATCH_STOP.DUPLICATES);
});

// ── 読めないときは 0 にしない ───────────────────────────────────

test('【重要】EmailBlacklist を読めなければ fail closed（0 件にしない）', () => {
  const unreadable = captureOutcomeSnapshot({
    jobsSent: 1_110, jobsFailed: 0, duplicates: 0, blacklist: null,
  });
  assert.equal(unreadable.complaints, null, '読めないものを 0 と書いている');
  assert.equal(summarizeBlacklistWindow(null), null);
  const before = snapshot({ sent: 610, types: [] });
  const h = judge({ baseline: before, current: unreadable });
  assert.equal(h.ok, false);
  assert.equal(h.reason, BATCH_STOP.UNREADABLE);
});

test('【重要】provider suppression が読めないときの fail closed は維持', () => {
  const before = snapshot({ sent: 610, types: [] });
  const after = snapshot({ sent: 1_110, types: [] });
  const h = judge({ baseline: before, current: after, suppressionReadable: false });
  assert.equal(h.ok, false);
  assert.equal(h.reason, BATCH_STOP.SUPPRESSION_UNREADABLE);
});

test('【重要】前バッチが片付いていなければ次バッチ 0（関所は維持）', () => {
  const before = snapshot({ sent: 610, types: [] });
  const after = snapshot({ sent: 1_110, types: [] });
  const h = judge({ baseline: before, current: after, previousOutstanding: 120 });
  assert.equal(h.ok, false);
  assert.equal(h.reason, BATCH_STOP.OUTSTANDING);

  // 計画側の関所も（新しいバッチは未処理 0 を要求する）
  const plan = planRolloutTick({
    state: {
      ...normalizeRolloutState({}), stage: ROLLOUT_STAGE.SCALE,
      dailyLimit: 15_000, batchSize: 500, alwaysArmed: true,
    },
    nowMs: NOW, remainingCandidates: 13_900, previousOutstanding: 120, envEnabled: true,
  });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, ROLLOUT_BLOCK.WAITING_PREVIOUS);
});

// ── 窓と保存形 ──────────────────────────────────────────────────

test('日付をまたいでも直前バッチのイベントが窓から外れない（当日 + 前日）', () => {
  const f = blacklistWindowFormula(NOW);
  assert.ok(f.includes("DATEADD(TODAY(), -2, 'days')"), `窓が狭すぎる: ${f}`);
  assert.ok(f.includes('{AddedAt}'));
});

test('累計が減っても差分はマイナスにしない（窓から古い行が外れる）', () => {
  const before = snapshot({ sent: 610, types: ['hard', 'hard', 'spam'] });
  const after = snapshot({ sent: 1_110, types: [] });   // 窓から外れて 0 件になった
  const d = diffOutcomeSnapshot(before, after);
  for (const f of OUTCOME_FIELDS) assert.ok(d.counts[f] >= 0, `${f} がマイナス`);
  assert.equal(d.counts.complaints, 0);
});

test('最初のバッチは比較相手が無いので判定しない', () => {
  assert.equal(hasOutcomeBaseline(null), false);
  assert.equal(hasOutcomeBaseline({}), false);
  assert.equal(hasOutcomeBaseline(toStoredOutcome(snapshot({ sent: 1, types: [] }), NOW)), true);
});

test('状態へ保存する形に PII も secret も入らない', () => {
  const stored = toStoredOutcome(snapshot({ sent: 610, types: ['spam'] }), NOW);
  const dump = JSON.stringify(stored);
  assert.equal(/@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(dump), false);
  assert.equal(/rec[A-Za-z0-9]{14}/.test(dump), false);
  assert.deepEqual(Object.keys(stored).sort(), [...OUTCOME_FIELDS, 'atMs'].sort());
  assert.equal(normalizeRolloutState({ healthBaseline: stored }).healthBaseline.complaints, 1);
});

test('【重要】EmailBlacklist からアドレスを取っていない（読む列は種別だけ）', () => {
  const reader = readFileSyncRel('src/lib/marketing/blacklistWindowReader.js');
  assert.ok(reader.includes("'BounceType'"), '種別を取っていない');
  assert.equal(/fields\[\]',\s*'Email'/.test(reader), false, 'アドレスを取得している');
  // 読むだけ（書き込み経路を増やさない）
  assert.equal(/method:\s*'(POST|PATCH|PUT|DELETE)'/.test(reader), false, '書き込みをしている');
  // 全件走査しない
  assert.ok(reader.includes('BLACKLIST_WINDOW_MAX_PAGES'), 'ページ上限が無い');
});

function readFileSyncRel(rel) {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '..', '..', '..', rel), 'utf8');
}
