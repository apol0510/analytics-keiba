/**
 * enqueueJobSize.test.mjs — **キュー登録が 1 回の実行時間に収まる**ことを固定する
 *   node --test src/lib/marketing/enqueueJobSize.test.mjs
 *
 * ## 背景（2026-08-27 の恒常バグ）
 *
 * `RECIPIENTS_PER_JOB = 100` のとき、配信行の書き込みが**毎回ちょうど 90 行で止まって**いた。
 * 配信行は Airtable の `performUpsert` 上限に合わせて **10 件ずつ**書き、
 * レート制限のため 1 batch ごとに待つ。100 名 = 10 batch は、キュー登録を行う
 * **同期の scheduled function** の実行時間を超える。
 *
 * 本番実測: 配信行 90 行を約 5 秒、実行開始から約 11 秒で停止
 * ＝ **10 batch 目に入る前にタイムアウト**。欠けるのは常に最後の 10 件で、
 * 宛先の中身とは無関係だった。
 *
 * 途中で殺されるため後始末（補完・巻き戻し）へ到達せず、
 * **PENDING ＋ `queue:unverified` ＋ 行が足りない**ジョブが毎 tick 積み上がっていた。
 *
 * 守る条件: **1 ジョブぶんの書き込みが予算に収まること**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  RECIPIENTS_PER_JOB, DELIVERY_BATCH_COST_MS, DELIVERY_WRITE_BUDGET_MS,
  DELIVERY_UPSERT_BATCH, chunkRecipients,
} from './campaignSend.js';

const batchesFor = (n) => Math.ceil(n / DELIVERY_UPSERT_BATCH);
const costFor = (n) => batchesFor(n) * DELIVERY_BATCH_COST_MS;

test('【要件】1 ジョブぶんの配信行の書き込みが予算に収まる', () => {
  const cost = costFor(RECIPIENTS_PER_JOB);
  assert.ok(
    cost <= DELIVERY_WRITE_BUDGET_MS,
    `⚠️ RECIPIENTS_PER_JOB=${RECIPIENTS_PER_JOB} は ${batchesFor(RECIPIENTS_PER_JOB)} batch = 約 ${cost}ms で、`
    + `予算 ${DELIVERY_WRITE_BUDGET_MS}ms を超える。途中で殺されて`
    + '「PENDING ＋ queue:unverified ＋ 行が足りない」ジョブが残る。'
    + '上げるなら先に 1 batch あたりの実測を取り直すこと',
  );
});

test('⚠️【要件】事故当時の 100 名は予算を超える（この guard が機能する証拠）', () => {
  assert.ok(costFor(100) > DELIVERY_WRITE_BUDGET_MS,
    '⚠️ 100 名が収まる計算になっている＝予算か実測値が甘い');
  assert.equal(batchesFor(100), 10, '100 名 = 10 batch（事故時の形）');
});

test('実測値は推測で置き換えない（本番で測った値が残っている）', () => {
  const src = readFileSync(fileURLToPath(new URL('./campaignSend.js', import.meta.url)), 'utf8');
  assert.match(src, /本番実測/, '⚠️ 実測の根拠が書かれていない');
  assert.match(src, /90 行/, '⚠️ どこで止まったかの実測が残っていない');
  assert.ok(DELIVERY_BATCH_COST_MS > 0 && DELIVERY_WRITE_BUDGET_MS > 0);
});

test('⚠️ 分割は 1 ジョブ = RECIPIENTS_PER_JOB 件（端数はそのまま）', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => `e${i}@example.com`);
  assert.deepEqual(chunkRecipients(mk(120)).map((x) => x.length),
    [RECIPIENTS_PER_JOB, RECIPIENTS_PER_JOB, 120 - RECIPIENTS_PER_JOB * 2]);
  assert.deepEqual(chunkRecipients(mk(RECIPIENTS_PER_JOB)).map((x) => x.length), [RECIPIENTS_PER_JOB]);
  assert.deepEqual(chunkRecipients([]).map((x) => x.length), []);
});

test('⚠️ 全員がいずれかのジョブへ入る（分割で取りこぼさない）', () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => `e${i}@example.com`);
  for (const n of [1, 49, 50, 51, 100, 137, 500]) {
    const flat = chunkRecipients(mk(n)).flat();
    assert.equal(flat.length, n, `${n} 件で取りこぼしている`);
    assert.equal(new Set(flat).size, n, `${n} 件で重複している`);
  }
});

test('⚠️ 1 ジョブの配信行は Airtable の 1 ページ（100）に収まる', () => {
  // 1 ページで読み切れないと、行の突き合わせがページングに依存して壊れやすくなる
  assert.ok(RECIPIENTS_PER_JOB <= 100, `⚠️ RECIPIENTS_PER_JOB=${RECIPIENTS_PER_JOB} は 1 ページを超える`);
});

test('⚠️ upsert の 1 回あたり件数は Airtable の上限（10）を超えない', () => {
  assert.ok(DELIVERY_UPSERT_BATCH <= 10);
  const admin = readFileSync(fileURLToPath(
    new URL('../../../netlify/functions/admin-marketing.js', import.meta.url),
  ), 'utf8');
  assert.match(admin, /i \+= 10/, '⚠️ upsert の刻みが 10 でない');
});
