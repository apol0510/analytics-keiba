/**
 * sequenceLedgerScanRecovery.test.mjs — 走査カーソルの**自力復帰**
 *   node --test src/lib/marketing/sequenceLedgerScanRecovery.test.mjs
 *
 * ## 何を固定するか（2026-09-08 の障害）
 *
 * 台帳の走査は Airtable の `offset` を Redis に保存し、10 分後の tick で使う。
 * **offset は短命**なので失効しうる。旧実装は失効時に throw していたが、
 * throw はカーソル更新より前なので **失効値が保存されたまま**になり、
 * 以後の tick は永久に同じ場所で落ちた（自力復帰できない）。
 *
 * 本番実測: `campaign-discount-free` の集計が
 * **2026-08-27T20:50:48Z（pass 15 / 読み切り前）で凍結**し 10 日間動かなかった。
 * 台帳が小さく offset を持たない campaign だけが無傷だった。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  shouldResetCursorOnFailure, cursorAfterFailure, nextScanCursor,
  createSequenceScanStore, scanCursorKey, resolvePagesPerTick,
} from './sequenceLedgerScan.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const CRON = read('../../../netlify/functions/cron-campaign-sequence.js');

test('保存した offset で落ちたら先頭から読み直す', () => {
  for (const status of [400, 404, 422, 429]) {
    assert.equal(
      shouldResetCursorOnFailure({ hadOffset: true, status }), true,
      `status ${status} で自力復帰しない`,
    );
  }
});

test('先頭から読んで落ちたときは触らない（リセットで直らない）', () => {
  assert.equal(shouldResetCursorOnFailure({ hadOffset: false, status: 422 }), false);
  assert.equal(shouldResetCursorOnFailure({}), false);
});

test('5xx（Airtable 側の一時障害）ではカーソルを捨てない', () => {
  assert.equal(shouldResetCursorOnFailure({ hadOffset: true, status: 500 }), false);
  assert.equal(shouldResetCursorOnFailure({ hadOffset: true, status: 503 }), false);
});

test('status が読めない失敗でも、offset を持っていれば復帰を試す（固着させない）', () => {
  assert.equal(shouldResetCursorOnFailure({ hadOffset: true, status: undefined }), true);
});

test('復帰カーソルは offset を捨て、周回数は保つ', () => {
  assert.deepEqual(cursorAfterFailure({ pass: 15 }), { offset: null, pass: 15, completedPass: false });
  assert.deepEqual(cursorAfterFailure({}), { offset: null, pass: 0, completedPass: false });
});

test('通常のカーソル送りは従来どおり（読み切りで周回数 +1）', () => {
  assert.deepEqual(nextScanCursor({ offset: 'itr123', pass: 3 }), {
    offset: 'itr123', pass: 3, completedPass: false,
  });
  assert.deepEqual(nextScanCursor({ offset: null, pass: 3 }), {
    offset: null, pass: 4, completedPass: true,
  });
});

test('保存層は壊れた値を読んでも先頭から読み直す（誤送信にはならない）', async () => {
  const calls = [];
  const store = createSequenceScanStore({
    redisCmd: async (args) => {
      calls.push(args);
      if (args[0] === 'GET') return '{壊れた JSON';
      return 'OK';
    },
  });
  assert.deepEqual(await store.read('c:v1'), { offset: null, pass: 0 });
  await store.write('c:v1', cursorAfterFailure({ pass: 15 }));
  const set = calls.find((a) => a[0] === 'SET');
  assert.equal(set[1], scanCursorKey('c:v1'));
  assert.deepEqual(JSON.parse(set[2]), { offset: null, pass: 15 });
});

test('1 tick で読むページ数は env で決まる（壊れた値は既定へ）', () => {
  assert.equal(resolvePagesPerTick({ MARKETING_SEQUENCE_SCAN_PAGES: '5' }), 5);
  assert.equal(resolvePagesPerTick({ MARKETING_SEQUENCE_SCAN_PAGES: 'x' }), 20);
  assert.equal(resolvePagesPerTick({ MARKETING_SEQUENCE_SCAN_PAGES: '9999' }), 20);
});

// ── 配線（cron が実際にこの経路を通ること）──────────────────────
test('【配線】cron は失効した offset を捨てて読み直す', () => {
  assert.match(CRON, /shouldResetCursorOnFailure\(/, 'cron が復帰判定を使っていない');
  assert.match(CRON, /cursorAfterFailure\(/, 'cron が復帰カーソルを書いていない');
  // 失敗を握り潰していないこと（復帰できない失敗は投げ直す）
  assert.match(CRON, /if \(!reset\) throw e;/);
  // 復帰した事実をログへ出す（無言で直さない）
  assert.match(CRON, /走査カーソル復帰/);
});

test('【配線】fetch の失敗が status を持って投げられる（復帰判定の材料）', () => {
  assert.match(CRON, /err\.status = res\.status;/);
  assert.match(CRON, /err\.hadOffset = Boolean\(startOffset\);/);
});
