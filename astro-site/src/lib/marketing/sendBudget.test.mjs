/**
 * sendBudget.test.mjs — 送信の時間予算
 *   node --test src/lib/marketing/sendBudget.test.mjs
 *
 * 守る性質:
 *   - 上限を超えそうなら**次の 1 通を送らない**（kill されるより前に自分で止まる）
 *   - 途中で止めたことを「完了」と区別して返す
 *   - 遅い環境では自動的に早く止まる（実測で見積りを更新する）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createSendBudget, summarizeSendRun, estimateChunkSize,
  SYNC_FUNCTION_LIMIT_MS, BACKGROUND_FUNCTION_LIMIT_MS,
  DEFAULT_SYNC_BUDGET_MS, DEFAULT_BACKGROUND_BUDGET_MS,
} from './sendBudget.js';

test('既定の予算は Function の上限より小さい（応答・後片付けの余白）', () => {
  assert.ok(DEFAULT_SYNC_BUDGET_MS < SYNC_FUNCTION_LIMIT_MS,
    '同期の予算が上限以上（kill される）');
  assert.ok(DEFAULT_BACKGROUND_BUDGET_MS < BACKGROUND_FUNCTION_LIMIT_MS,
    'background の予算が上限以上');
  // 余白は 25% 以上
  assert.ok(SYNC_FUNCTION_LIMIT_MS - DEFAULT_SYNC_BUDGET_MS >= SYNC_FUNCTION_LIMIT_MS * 0.25);
});

test('【重要】予算を超えそうなら次の 1 通を送らない', () => {
  const t0 = 1_000_000;
  const b = createSendBudget({ limitMs: 10_000, nowMs: t0, initialPerSendMs: 1_000, safetyFactor: 1 });
  assert.equal(b.canSendAnother(t0), true);
  // 9 秒経過 → 残り 1 秒。見積り 1 秒なのでギリギリ可
  assert.equal(b.canSendAnother(t0 + 9_000), true);
  // 9.5 秒経過 → 残り 0.5 秒。1 通ぶん入らない
  assert.equal(b.canSendAnother(t0 + 9_500), false);
});

test('【重要】安全係数のぶん早めに止まる（ギリギリを狙わない）', () => {
  const t0 = 0;
  const b = createSendBudget({ limitMs: 10_000, nowMs: t0, initialPerSendMs: 1_000, safetyFactor: 1.5 });
  // 8.4 秒経過 → 8.4 + 1.5 = 9.9 ≤ 10 で可
  assert.equal(b.canSendAnother(8_400), true);
  // 8.6 秒経過 → 8.6 + 1.5 = 10.1 で不可
  assert.equal(b.canSendAnother(8_600), false);
});

test('【重要】遅い環境では実測に追従して早く止まる', () => {
  const t0 = 0;
  const b = createSendBudget({ limitMs: 20_000, nowMs: t0, initialPerSendMs: 100, safetyFactor: 1 });
  // 1 通に 3 秒かかった（見積り 100ms → 実測 3000ms へ更新される）
  b.record(3_000);
  assert.equal(b.averageMs, 3_000);
  // 18 秒経過なら、残り 2 秒 < 3 秒なので送らない
  assert.equal(b.canSendAnother(18_000), false);
  // 14 秒経過なら残り 6 秒 > 3 秒で送れる
  assert.equal(b.canSendAnother(14_000), true);
});

test('速い環境では多く送れる（見積りが下がる）', () => {
  const t0 = 0;
  const b = createSendBudget({ limitMs: 20_000, nowMs: t0, initialPerSendMs: 800, safetyFactor: 1 });
  for (let i = 1; i <= 10; i += 1) b.record(i * 50); // 1 通 50ms
  assert.equal(b.averageMs, 50);
  assert.equal(b.canSendAnother(19_000), true, '余裕があるのに止めている');
  assert.equal(b.sends, 10);
});

test('【重要】途中で止めたことを「完了」と区別する', () => {
  const partial = summarizeSendRun({ total: 100, sent: 40, stoppedByBudget: true });
  assert.equal(partial.complete, false);
  assert.equal(partial.remaining, 60);
  assert.equal(partial.stoppedByBudget, true);
  assert.match(partial.resumeHint, /残りから再開/);

  const done = summarizeSendRun({ total: 100, sent: 95, skipped: 3, failed: 2, stoppedByBudget: true });
  assert.equal(done.complete, true, '全部処理し終えたのに未完了と言っている');
  assert.equal(done.remaining, 0);
  assert.equal(done.stoppedByBudget, false, '完了なのに打ち切り扱いしている');
  assert.equal(done.resumeHint, null);
});

test('skipped / failed も「処理済み」として残数から引く', () => {
  const r = summarizeSendRun({ total: 10, sent: 3, skipped: 5, failed: 2 });
  assert.equal(r.remaining, 0);
  assert.equal(r.complete, true);
});

test('describe は件数と時間だけを返す（PII を含めない）', () => {
  const b = createSendBudget({ limitMs: 5_000, nowMs: 0 });
  b.record(200);
  const d = b.describe(1_000);
  assert.deepEqual(Object.keys(d).sort(), ['averageMs', 'elapsedMs', 'limitMs', 'sends']);
  assert.equal(d.sends, 1);
  assert.equal(d.elapsedMs, 1_000);
  assert.equal(JSON.stringify(d).includes('@'), false);
});

test('チャンクの目安を出せる（画面・計画用）', () => {
  assert.equal(estimateChunkSize({ limitMs: 18_000, perSendMs: 600 }), 30);
  assert.equal(estimateChunkSize({ limitMs: 8 * 60_000, perSendMs: 600 }), 800);
  // 壊れた入力でも 1 以上
  assert.ok(estimateChunkSize({ limitMs: -1, perSendMs: 0 }) >= 1);
});

test('【重要】予算 0 でも 1 通目から止まる（暴走しない）', () => {
  const b = createSendBudget({ limitMs: 0, nowMs: 0 });
  assert.equal(b.canSendAnother(0), false);
});
