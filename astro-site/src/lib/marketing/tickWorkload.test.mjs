/**
 * tickWorkload.test.mjs — 1 tick の仕事量が**既存の安全単位に収まる**ことを固定する
 *
 * ── 事故（2026-08-21）────────────────────────────────────────
 * `rolloutResume` 後、15 分・6 tick 連続で `skip / tick_busy` しか出ず、
 * ジョブも配信行も 1 件も作られなかった（各スロットで 1 本が排他を取り、
 * ログを残さず終了していた）。実測で `action=sequence` は 1 フェーズ 19〜21 秒、
 * tick は毎回**両フェーズ**を読み、さらに follow-up は **due 全件**（396〜593 名）を
 * 1 tick で dry-run → queue → 読み戻し → 印外し まで行っていた。
 *
 * ⚠️ 終了理由は**未確定**（当該 invocation のログが無い）。ここでは仕事量だけを減らす。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeQueueBatch, boundQueueBatch, needsMorePhases } from './tickWorkload.js';
import { RECIPIENTS_PER_JOB, chunkRecipients, MAX_RECIPIENTS_PER_SEND } from './campaignSend.js';
import { buildSequenceProgress, selectNextDueStep } from './sequenceProgress.js';

const ids = (n, prefix = 'rec') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

// ── 1 tick の処理量が bounded ────────────────────────────────
test('【重要】593 名の due でも 1 tick で積むのは 1 ジョブぶんだけ', () => {
  const r = describeQueueBatch({ recordIds: ids(593), totalDue: 593 });
  assert.equal(r.queued, RECIPIENTS_PER_JOB, '1 tick で全件積もうとしている');
  assert.equal(r.totalDueRemaining, 593 - RECIPIENTS_PER_JOB);
  assert.equal(r.boundedBy, RECIPIENTS_PER_JOB);
});

test('【重要】切ったぶんは数で分かる（黙って打ち切らない）', () => {
  assert.equal(describeQueueBatch({ recordIds: ids(593), totalDue: 593 }).totalDueRemaining,
    593 - RECIPIENTS_PER_JOB);
  assert.equal(describeQueueBatch({ recordIds: ids(120), totalDue: 120 }).totalDueRemaining,
    120 - RECIPIENTS_PER_JOB);
});

test('【重要】1 ジョブぶん以下ならそのまま全部積む（無意味に遅くしない）', () => {
  const r = describeQueueBatch({ recordIds: ids(48), totalDue: 48 });
  assert.equal(r.queued, 48);
  assert.equal(r.remainingInWindow, 0);
  assert.equal(r.totalDueRemaining, 0);
  assert.equal(r.boundedBy, null);
});

// ── 窓の残り と 全体の残り を混同しない ─────────────────────────
test('【重要】truncated=true のとき、窓の残りを「全体の残り」と出さない', () => {
  // 単一源: 総 due 593 / 窓 500（cap） / 今回 RECIPIENTS_PER_JOB 件を積む
  const r = describeQueueBatch({ recordIds: ids(MAX_RECIPIENTS_PER_SEND), truncated: true, totalDue: 593 });
  assert.equal(r.queued, RECIPIENTS_PER_JOB);
  assert.equal(r.remainingInWindow, MAX_RECIPIENTS_PER_SEND - RECIPIENTS_PER_JOB, '窓の残りが違う');
  assert.equal(r.totalDueRemaining, 593 - RECIPIENTS_PER_JOB, '全体の残りが違う');
  assert.notEqual(r.remainingInWindow, r.totalDueRemaining, '窓と全体を同じ値にしている');
  assert.equal(r.sourceTruncated, true, '窓が切られていることを出していない');
});

test('【重要】総数が分からなければ「全体の残り」を出さない（推測しない）', () => {
  const r = describeQueueBatch({ recordIds: ids(MAX_RECIPIENTS_PER_SEND), truncated: true });
  assert.equal(r.totalDueBefore, null);
  assert.equal(r.totalDueRemaining, null, '総数不明なのに残数を作っている');
  assert.equal(r.remainingInWindow, MAX_RECIPIENTS_PER_SEND - RECIPIENTS_PER_JOB);
});

test('【重要】窓が切られていなければ 窓の残り = 全体の残り', () => {
  const r = describeQueueBatch({ recordIds: ids(300), truncated: false, totalDue: 300 });
  assert.equal(r.remainingInWindow, 300 - RECIPIENTS_PER_JOB);
  assert.equal(r.totalDueRemaining, 300 - RECIPIENTS_PER_JOB);
  assert.equal(r.sourceTruncated, false);
});

// ── 全体 due 総数は単一源の同一 scope から取れる ────────────────
test('【重要】summary.dueByStep は窓（cap）に切られない＝全体 due の正本', () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({
    recordId: `rec${i}`, email: `u${i}@example.com`,
    status: 'due', nextStep: 2, currentStep: 1, sentSteps: [1],
  }));
  const progress = {
    ok: true, rows,
    summary: { due: 250, waiting: 0, completed: 0, stopped: 0, byStopReason: {},
      dueByStep: { 1: 0, 2: 250 }, sentByStep: { 1: 250, 2: 0 }, byCurrentStep: { 1: 250 } },
  };
  const picked = selectNextDueStep(progress, { maxRecipients: RECIPIENTS_PER_JOB });
  assert.equal(picked.recordIds.length, RECIPIENTS_PER_JOB, '窓が効いていない');
  assert.equal(picked.truncated, true);
  // **同じ progress から作られた集計**なので scope が一致する
  assert.equal(picked.counts[2], 250, 'dueByStep が窓に引きずられている');
  assert.equal(progress.summary.dueByStep[2], 250);
  const r = describeQueueBatch({
    recordIds: picked.recordIds, truncated: picked.truncated, totalDue: picked.counts[2],
  });
  assert.equal(r.totalDueRemaining, 250 - RECIPIENTS_PER_JOB);
  assert.equal(r.remainingInWindow, 0, '窓のぶんをすべて積んだのに窓の残りが 0 でない');
});

test('【重要】新しい件数仕様を作らない（既存の分割契約と同じ）', () => {
  const list = ids(250);
  assert.deepEqual(describeQueueBatch({ recordIds: list }).take, chunkRecipients(list)[0]);
  assert.equal(describeQueueBatch({ recordIds: list }).limit, RECIPIENTS_PER_JOB);
});

test('【重要】単一源が返した順序を変えない（独自の並べ替え・抽選をしない）', () => {
  const list = ids(300);
  assert.deepEqual(describeQueueBatch({ recordIds: list }).take, list.slice(0, RECIPIENTS_PER_JOB));
});

test('【重要】残りは次の tick で続く（取り直した集合の先頭から積む）', () => {
  /*
   * 1 tick で積むのは `RECIPIENTS_PER_JOB` 件まで。積んだぶんは `queued` になり
   * 単一源の due から外れるので、次の tick は**残りの先頭から**続く。
   * ⚠️ 何 tick で終わるかは `RECIPIENTS_PER_JOB` 次第なので、**尽きるまで回して**
   *    「取りこぼし 0 / 重複 0」を確かめる（定数を変えても壊れない書き方）。
   */
  const TOTAL = 250;
  let remaining = ids(TOTAL);
  const seen = [];
  for (let tick = 0; tick < 50 && remaining.length > 0; tick += 1) {
    const take = describeQueueBatch({ recordIds: remaining }).take;
    assert.ok(take.length > 0, `tick ${tick} で 1 件も積めていない（進まない）`);
    assert.ok(take.length <= RECIPIENTS_PER_JOB, '1 tick で 1 ジョブぶんを超えて積んでいる');
    // ── 同一 recipient を次 tick で再 queue しない ──
    assert.equal(take.some((id) => seen.includes(id)), false, '同じ人を二度積んでいる');
    seen.push(...take);
    remaining = remaining.filter((id) => !take.includes(id));   // 単一源の再取得に相当
  }
  assert.equal(remaining.length, 0, '積み残しがある');
  assert.equal(seen.length, TOTAL, '取りこぼし / 重複がある');
  assert.equal(new Set(seen).size, TOTAL, '重複がある');
});

test('宛先ゼロは何も積まない', () => {
  for (const v of [[], null, undefined]) {
    const r = describeQueueBatch({ recordIds: v });
    assert.deepEqual(r.take, []);
    assert.equal(r.remainingInWindow, 0);
    assert.equal(r.queued, 0);
  }
});

// ── フェーズ読みの省略（結論が変わらない読みだけ飛ばす）─────────
test('【重要】due があるフェーズを読んだら、それ以降のフェーズは読まない', () => {
  assert.equal(needsMorePhases({ step: 2, due: 593 }), false);
});

test('【重要】due が無いフェーズなら次のフェーズを必ず読む（取りこぼさない）', () => {
  assert.equal(needsMorePhases({ step: null, due: 0 }), true);
  assert.equal(needsMorePhases({ step: 2, due: 0 }), true);
});

test('【重要】読めなかったフェーズは「読み終わり」にしない（fail closed は呼び出し側）', () => {
  assert.equal(needsMorePhases(null), false, '呼び出し側が null を返す前提を壊している');
});

// ══════════════════════════════════════════════════════════════
//   配線（cron の実ファイルを読んで固定する）
// ══════════════════════════════════════════════════════════════

function readRel(rel) {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '..', '..', '..', rel), 'utf8');
}
const CRON = 'netlify/functions/cron-marketing-rollout.js';

test('【重要】follow-up は 1 tick 1 ジョブぶんに絞ってから queue する', () => {
  const src = readRel(CRON);
  const fu = src.slice(src.indexOf('if (decision.action === TICK_ACTION.FOLLOW_UP)'), src.indexOf('// ── ④ 付与'));
  assert.ok(/const bound = describeQueueBatch\(\{/.test(fu), '絞っていない');
  // queueStep へ渡すのは**絞った結果だけ**（due 全件を渡していない）
  const call = fu.slice(fu.indexOf('const res = await queueStep('), fu.indexOf('if (!res.ok)'));
  assert.ok(/recordIds: bound\.take/.test(call), '絞った結果を使っていない');
  assert.equal(/recordIds: due\.recordIds/.test(call), false, 'due 全件を queue へ渡している');
  assert.ok(/remainingInWindow: bound\.remainingInWindow/.test(fu), '窓の残りを出していない');
  assert.ok(/totalDueRemaining: bound\.totalDueRemaining/.test(fu), '全体の残りを出していない');
  assert.ok(/sourceTruncated: bound\.sourceTruncated/.test(fu), '窓が切られたことを出していない');
  assert.equal(/[^a-zA-Z]dueRemaining:/.test(fu), false, '窓と全体を混同する名前が残っている');
  assert.ok(/summary\.dueByStep\[due\.step\]/.test(fu), '全体 due を単一源の集計から取っていない');
});

test('【重要】Step1 の救済も同じ単位で絞る', () => {
  const src = readRel(CRON);
  assert.ok(/const rescueBound = describeQueueBatch\(\{/.test(src), '救済経路が絞られていない');
  const rc = src.slice(src.indexOf('const rescue = await queueStep('), src.indexOf('if (!rescue.ok)'));
  assert.ok(/recordIds: rescueBound\.take/.test(rc), '救済で絞った結果を使っていない');
  assert.equal(/recordIds: due\.recordIds/.test(rc), false, '救済が due 全件を渡している');
});

test('【重要】結論が変わらないフェーズ読みだけを飛ばす（fail closed は維持）', () => {
  const src = readRel(CRON);
  const fn = src.slice(src.indexOf('async function readNextDueStep()'), src.indexOf('/** 同期 dispatcher'));
  assert.ok(/if \(!r\) return null;/.test(fn), 'fail closed を壊している');
  assert.ok(/if \(!needsMorePhases\(r\)\) break;/.test(fn), 'フェーズ読みを省略していない');
  // 採用ロジック自体は変えない
  assert.ok(/phases\.find\(\(r\) => r\.step && r\.due > 0\)/.test(fn), '採用ロジックを変えている');
});

test('【重要】判定の順序（dispatch → queue → follow-up → 付与）を変えていない', () => {
  const src = readRel('src/lib/marketing/rolloutOrchestrator.js');
  const order = ['ROLLOUT_BLOCK.KILLED', 'TICK_ACTION.DISPATCH', 'TICK_ACTION.QUEUE',
    'TICK_ACTION.FOLLOW_UP', 'TICK_ACTION.GRANT'];
  let prev = -1;
  for (const token of order) {
    const i = src.indexOf(token);
    assert.ok(i > prev, `順序が変わっている: ${token}`);
    prev = i;
  }
});

test('【重要】tick 排他・kill・paused の意味を変えていない', () => {
  const src = readRel(CRON);
  assert.ok(/TICK_LOCK_ROOT/.test(src) && /'tick_busy'/.test(src), 'tick 排他が消えている');
  const busy = src.slice(src.indexOf("const reason = got.reason === LOCK_FAIL.BUSY"), src.indexOf('try {\n    return json(200, await runRolloutTick('));
  assert.ok(/sideEffects: 'none'/.test(busy), '重なった tick が副作用を持っている');
  const orch = readRel('src/lib/marketing/rolloutOrchestrator.js');
  assert.ok(/if \(s\.killed === true\) \{/.test(orch), 'kill switch が最優先でない');
  assert.equal(/stage === ROLLOUT_STAGE\.PAUSED/.test(orch), false, 'tick 側で paused を独自判定している');
});

// ── フェーズ読み省略が集計を壊さない ────────────────────────────
test('【重要】フェーズを省略した tick では集計を同期しない（0 件へ倒れない）', () => {
  const src = readRel(CRON);
  assert.ok(/due\.phasesComplete !== true/.test(src), '全フェーズを読んだかを見ていない');
  const block = src.slice(src.indexOf("warn: 'journey_totals_skipped'") - 700,
    src.indexOf("warn: 'journey_totals_skipped'") + 200);
  assert.ok(/reason: 'phase_read_skipped'/.test(block), '省略の理由を残していない');
  assert.ok(/sideEffects: 'none'/.test(block), '省略した tick が副作用を持っている');
  // 同期そのものは全フェーズを読んだときだけ
  const sync = src.slice(src.indexOf('const built = buildJourneyTotals('), src.indexOf('// 集計へ写す'));
  assert.ok(/reconcileTotals\(/.test(sync));
});

test('【重要】集計の単一源は欠けたフェーズを 0 と読み替えない（fail closed）', async () => {
  const { buildJourneyTotals } = await import('./journeyTotals.js');
  const active = { total: 10, due: 3, waiting: 7, completed: 0, stopped: 0, byStopReason: {} };
  const r = buildJourneyTotals({ active, postExpiry: null });
  assert.equal(r.ok, false, '終了後フェーズが無いのに集計を作っている');
  assert.equal(r.reason, 'post_expiry_summary_missing');
});

test('【重要】フェーズ省略は送信対象の選定に影響しない（採用は単一源の next のまま）', () => {
  const src = readRel(CRON);
  const fn = src.slice(src.indexOf('async function readNextDueStep()'), src.indexOf('/** 同期 dispatcher'));
  // 採用は「最初に due があるフェーズ」＝省略しても選ぶものは変わらない
  assert.ok(/phases\.find\(\(r\) => r\.step && r\.due > 0\)/.test(fn));
  assert.ok(/phasesComplete: phases\.length === JOURNEY_PHASES\.length/.test(fn), '読み切ったかを持ち回っていない');
});
