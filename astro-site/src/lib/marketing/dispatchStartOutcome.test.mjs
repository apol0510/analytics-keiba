/**
 * dispatchStartOutcome.test.mjs — 「1 件も起動しなかった」を**正当な 0 と異常な 0 に分ける**
 *
 * ── 2026-08-18 の本番 auto-stop ────────────────────────────────
 * 旧実装は `ok: started > 0` だけを見ていた。ところが `startDispatch` は
 * **`willSend === 0` のジョブを意図的に起動しない**（コード自身が
 * 「0 名は異常ではない。全員が既送信・配信停止・バウンス等」と明記）。
 * その結果、**送るべき人が正当にゼロ**の回が `started === 0` になり、
 * `dispatch_failed` として展開が自動停止した。
 *
 * 停止時の本番実測は PENDING **0** / mkt- 全 170 ジョブ **SENT** / failed **0** /
 * 重複 **0** / outstandingStep1 **0** ＝ **送信は成功していた**。
 * 止まったのは判定側だけ、という誤検知だった。
 *
 * ⚠️ ただし「正当な 0」と言えるのは**その通が台帳で終わっているとき**だけ。
 *    まだ `PENDING` のまま `willSend === 0` なら起動しない限り永久に終わらない
 *    （queue が溜まり続ける）ので、**従来どおり異常**として止める。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDispatchStart, BENIGN_DISPATCH_SKIP,
} from '../../../netlify/functions/cron-marketing-rollout.js';

const skips = (...reasons) => reasons.map((reason, i) => ({ jobId: `mkt-${i}`, reason }));

// ── 正当な 0（これが今回の修正）────────────────────────────────
test('【重要】全部 will_send_zero（台帳で完了済み）なら止めない', () => {
  const r = classifyDispatchStart({ started: 0, skipped: skips('will_send_zero', 'will_send_zero') });
  assert.equal(r.ok, true, '正当な 0 で dispatch_failed にしている');
  assert.equal(r.nothingToStart, true);
  assert.equal(r.failures, 0);
  assert.deepEqual(r.failureReasons, []);
});

test('【重要】正当な 0 を「起動した」とも言わない', () => {
  const r = classifyDispatchStart({ started: 0, skipped: skips('will_send_zero') });
  assert.equal(r.started, 0, '起動していないのに件数が立っている');
  assert.equal(r.nothingToStart, true);
});

// ── 異常な 0（従来どおり止める）─────────────────────────────────
test('【重要】willSend 0 でもジョブが未完了なら異常（queue が溜まる）', () => {
  const r = classifyDispatchStart({ started: 0, skipped: skips('will_send_zero_unfinished') });
  assert.equal(r.ok, false);
  assert.equal(r.nothingToStart, false);
  assert.equal(r.failures, 1);
});

test('【重要】起動そのものに失敗した 0 は従来どおり異常', () => {
  for (const reason of ['dry_run_failed', 'http_500', 'http_403', 'start_failed',
    'dry_run_shape_unknown', 'job_not_in_dry_run', 'will_send_unknown']) {
    const r = classifyDispatchStart({ started: 0, skipped: skips(reason) });
    assert.equal(r.ok, false, `${reason} を正当な 0 として通している`);
    assert.equal(r.nothingToStart, false);
  }
});

test('【重要】知らない skip 理由は異常側へ倒す（allow-list / fail closed）', () => {
  const r = classifyDispatchStart({ started: 0, skipped: skips('some_new_reason_added_later') });
  assert.equal(r.ok, false);
  assert.equal(r.failures, 1);
  assert.deepEqual(BENIGN_DISPATCH_SKIP, ['will_send_zero'], '正当扱いは 1 種類だけに保つ');
});

test('【重要】正当な 0 と異常が混ざったら異常を優先して止める', () => {
  const r = classifyDispatchStart({
    started: 0, skipped: skips('will_send_zero', 'dry_run_failed', 'will_send_zero'),
  });
  assert.equal(r.ok, false, '異常が 1 件でもあれば止める');
  assert.equal(r.failures, 1);
  assert.deepEqual(r.failureReasons, ['dry_run_failed']);
});

// ── 起動できた場合は従来どおり ───────────────────────────────
test('1 件でも起動できていれば止めない（従来挙動を維持）', () => {
  const r = classifyDispatchStart({ started: 2, skipped: skips('http_500') });
  assert.equal(r.ok, true);
  assert.equal(r.nothingToStart, false);
  assert.equal(r.failures, 1, '失敗は隠さず数える');
});

test('起動できて skip も無ければ当然 ok', () => {
  const r = classifyDispatchStart({ started: 3, skipped: [] });
  assert.equal(r.ok, true);
  assert.equal(r.nothingToStart, false);
  assert.equal(r.failures, 0);
});

// ── 入力が壊れていても落ちない ───────────────────────────────
test('引数が無い・壊れていても例外にせず異常側でもない（0 件 0 失敗）', () => {
  for (const input of [undefined, {}, { started: null, skipped: null }, { skipped: 'x' }]) {
    const r = classifyDispatchStart(input);
    assert.equal(r.started, 0);
    assert.equal(r.failures, 0);
    assert.equal(r.nothingToStart, true);
  }
});

test('failureReasons は重複を畳む（ログが膨らまない）', () => {
  const r = classifyDispatchStart({
    started: 0, skipped: skips('http_500', 'http_500', 'start_failed'),
  });
  assert.equal(r.failures, 3);
  assert.deepEqual([...r.failureReasons].sort(), ['http_500', 'start_failed']);
});

// ══════════════════════════════════════════════════════════════════
//  配線（`startDispatch` は非 export なのでソースで固定する）
// ══════════════════════════════════════════════════════════════════

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readRel(rel) {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, '..', '..', '..', rel), 'utf8');
}

const CRON = 'netlify/functions/cron-marketing-rollout.js';

test('【重要】運転手は `started === 0` を停止条件にしていない', () => {
  const src = readRel(CRON);
  const call = src.slice(src.indexOf('const res = await startDispatch('), src.indexOf("abort: 'dispatch_failed'"));
  assert.equal(
    /Number\(res\.started \|\| 0\) === 0/.test(call), false,
    '`started === 0` で止めている（正当な 0 でも停止してしまう）',
  );
  assert.ok(/res\.ok === false/.test(call), '`res.ok` で判断していない');
});

test('【重要】`startDispatch` の戻り値は分類関数を通している', () => {
  const src = readRel(CRON);
  assert.equal(
    /return \{ ok: started > 0,/.test(src), false,
    '`ok: started > 0` が残っている（正当な 0 を失敗にする）',
  );
  assert.ok(/classifyDispatchStart\(\{ started, skipped \}\)/.test(src), '分類関数を通していない');
});

test('【重要】willSend 0 は台帳の状態で正当 / 異常に分けている', () => {
  const src = readRel(CRON);
  const block = src.slice(src.indexOf('if (w.willSend === 0) {'), src.indexOf('// ② 起動（202 即返し）'));
  assert.ok(/byId.*get\(jobId\)/.test(block), '台帳の状態を見ていない');
  assert.ok(/status === 'PENDING'/.test(block), 'PENDING を異常側へ倒していない');
  assert.ok(/will_send_zero_unfinished/.test(block), '未完了ジョブを別理由にしていない');
  // 台帳で見えないジョブも異常側
  assert.ok(/!job \|\| job\.status === 'PENDING'/.test(block), '見えないジョブを正当扱いしている');
});

test('【重要】設定不備は `nothingToStart` にしない', () => {
  const src = readRel(CRON);
  const block = src.slice(src.indexOf('if (!secret || !site) {'), src.indexOf('let started = 0;'));
  assert.ok(/nothingToStart: false/.test(block), '設定不備を正当な 0 として通している');
  assert.ok(/ok: false/.test(block));
});

test('【重要】送信経路そのものは変えていない（起動条件を緩めない）', () => {
  const src = readRel(CRON);
  // willSend が 1 以上のときだけ起動する、という既存契約は維持
  assert.ok(/if \(w\.willSend === 0\) \{/.test(src), 'willSend 0 の分岐が消えている');
  assert.ok(/expectedWillSend: w\.willSend/.test(src), '起動直前の人数確定を外している');
});
