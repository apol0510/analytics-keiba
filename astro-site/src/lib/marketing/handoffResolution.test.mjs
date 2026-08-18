/**
 * handoffResolution.test.mjs — 「対象 0 件」で引き継ぎを黙って捨てない
 *   node --test src/lib/marketing/handoffResolution.test.mjs
 *
 * #363 は 0 件を一律「もう積み終わっている」とみなして引き継ぎを消していた（**fail open**）。
 * 付与直後は Airtable の読み取りが追いつかず 0 件になることがあり、そのとき消すと
 * **付与済みなのに案内が来ない人**が黙って残る。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveEmptyHandoff, HANDOFF_ACTION, MAX_EMPTY_HANDOFF_ATTEMPTS,
} from './handoffResolution.js';
import { normalizeRolloutState } from './rolloutPlan.js';

test('【重要】案内待ちが 0 名なら畳んでよい（本当に積み終わっている）', () => {
  const r = resolveEmptyHandoff({ outstandingStep1: 0, attempts: 0 });
  assert.equal(r.action, HANDOFF_ACTION.CLEAR);
  assert.equal(r.attempts, 0, '再試行回数が残っている');
});

test('【重要】案内待ちが残っているなら畳まず、やり直す（fail open にしない）', () => {
  const r = resolveEmptyHandoff({ outstandingStep1: 199, attempts: 0 });
  assert.equal(r.action, HANDOFF_ACTION.RETRY, '案内待ちが居るのに引き継ぎを消している');
  assert.equal(r.attempts, 1);
});

test('【重要】やり直しても解決しなければ止める（人に見せる）', () => {
  let attempts = 0;
  let last = null;
  for (let i = 0; i < MAX_EMPTY_HANDOFF_ATTEMPTS + 1; i += 1) {
    last = resolveEmptyHandoff({ outstandingStep1: 199, attempts });
    attempts = last.attempts;
    if (last.action === HANDOFF_ACTION.STOP) break;
  }
  assert.equal(last.action, HANDOFF_ACTION.STOP, '永久にやり直し続けている');
  assert.equal(last.reason, 'handoff_unresolved');
  assert.ok(attempts <= MAX_EMPTY_HANDOFF_ATTEMPTS + 1, '止まるまでが長すぎる');
});

test('【重要】案内待ちが数えられないときも畳まない（推測で消さない）', () => {
  const r = resolveEmptyHandoff({ outstandingStep1: null, attempts: 0 });
  assert.equal(r.action, HANDOFF_ACTION.RETRY);
  const stop = resolveEmptyHandoff({ outstandingStep1: null, attempts: MAX_EMPTY_HANDOFF_ATTEMPTS });
  assert.equal(stop.action, HANDOFF_ACTION.STOP);
  assert.equal(stop.reason, 'handoff_unverifiable', '数えられない理由が残っていない');
});

test('再試行回数は状態へ保存できる（PII なし）', () => {
  const s = normalizeRolloutState({ handoffEmptyAttempts: 2 });
  assert.equal(s.handoffEmptyAttempts, 2);
  assert.equal(normalizeRolloutState({}).handoffEmptyAttempts, 0);
  assert.equal(normalizeRolloutState({ handoffEmptyAttempts: -5 }).handoffEmptyAttempts, 0);
});

test('【重要】運転手が「消す / やり直す / 止める」を使い分けている（配線）', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', '..', '..', 'netlify/functions/cron-marketing-rollout.js'), 'utf8');
  assert.ok(src.includes('resolveEmptyHandoff'), '判定を単一源に任せていない');
  assert.ok(src.includes('HANDOFF_ACTION.CLEAR'), '畳む分岐が無い');
  assert.ok(src.includes('HANDOFF_ACTION.RETRY'), 'やり直す分岐が無い');
  // 0 件で無条件に引き継ぎを消していない（#363 の形）
  const clearAll = /pendingHandoffOps: \[\], handoffEmptyAttempts: 0,\s*\};\s*const body = \{\s*ok: true[\s\S]{0,200}handoffsCleared/;
  assert.ok(clearAll.test(src) || src.includes('handoffsCleared'), '畳んだ記録が無い');
  assert.ok(src.includes('handoffRetry'), 'やり直しを記録していない');
});
