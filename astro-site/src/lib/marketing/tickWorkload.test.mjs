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

import { boundQueueBatch, needsMorePhases } from './tickWorkload.js';
import { RECIPIENTS_PER_JOB, chunkRecipients } from './campaignSend.js';

const ids = (n, prefix = 'rec') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

// ── 1 tick の処理量が bounded ────────────────────────────────
test('【重要】593 名の due でも 1 tick で積むのは 1 ジョブぶんだけ', () => {
  const r = boundQueueBatch(ids(593));
  assert.equal(r.take.length, RECIPIENTS_PER_JOB, '1 tick で全件積もうとしている');
  assert.equal(r.remaining, 593 - RECIPIENTS_PER_JOB);
  assert.equal(r.bounded, true);
});

test('【重要】切ったぶんは数で分かる（黙って打ち切らない）', () => {
  assert.equal(boundQueueBatch(ids(593)).remaining, 493);
  assert.equal(boundQueueBatch(ids(120)).remaining, 20);
});

test('【重要】1 ジョブぶん以下ならそのまま全部積む（無意味に遅くしない）', () => {
  const r = boundQueueBatch(ids(48));
  assert.equal(r.take.length, 48);
  assert.equal(r.remaining, 0);
  assert.equal(r.bounded, false);
});

test('【重要】新しい件数仕様を作らない（既存の分割契約と同じ）', () => {
  const list = ids(250);
  assert.deepEqual(boundQueueBatch(list).take, chunkRecipients(list)[0]);
  assert.equal(boundQueueBatch(list).limit, RECIPIENTS_PER_JOB);
});

test('【重要】単一源が返した順序を変えない（独自の並べ替え・抽選をしない）', () => {
  const list = ids(300);
  assert.deepEqual(boundQueueBatch(list).take, list.slice(0, RECIPIENTS_PER_JOB));
});

test('【重要】残りは次の tick で続く（取り直した集合の先頭から積む）', () => {
  // 1 tick 目で積んだ 100 人は `queued` になり、単一源の due から外れる
  const all = ids(250);
  const first = boundQueueBatch(all).take;
  const remainAfterQueue = all.filter((id) => !first.includes(id));   // 単一源の再取得に相当
  const second = boundQueueBatch(remainAfterQueue).take;
  assert.equal(second.length, RECIPIENTS_PER_JOB);
  // ── 同一 recipient を次 tick で再 queue しない ──
  assert.equal(second.some((id) => first.includes(id)), false, '同じ人を二度積んでいる');
  const third = boundQueueBatch(remainAfterQueue.filter((id) => !second.includes(id))).take;
  assert.equal(third.length, 50);
  assert.equal(new Set([...first, ...second, ...third]).size, 250, '取りこぼし / 重複がある');
});

test('宛先ゼロは何も積まない', () => {
  for (const v of [[], null, undefined]) {
    const r = boundQueueBatch(v);
    assert.deepEqual(r.take, []);
    assert.equal(r.remaining, 0);
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
  assert.ok(/const bound = boundQueueBatch\(due\.recordIds\);/.test(fu), '絞っていない');
  assert.ok(/recordIds: bound\.take/.test(fu), '絞った結果を使っていない');
  assert.equal(/recordIds: due\.recordIds/.test(fu), false, 'due 全件を渡している');
  assert.ok(/dueRemaining: bound\.remaining/.test(fu), '残数を出していない（黙って打ち切っている）');
});

test('【重要】Step1 の救済も同じ単位で絞る', () => {
  const src = readRel(CRON);
  assert.ok(/const rescueBound = boundQueueBatch\(due\.recordIds\);/.test(src), '救済経路が絞られていない');
  assert.ok(/recordIds: rescueBound\.take/.test(src));
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
