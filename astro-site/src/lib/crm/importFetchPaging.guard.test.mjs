/**
 * importFetchPaging.guard.test.mjs — 全件取得の打ち切りで誤判定しない
 *   node --test src/lib/crm/importFetchPaging.guard.test.mjs
 *
 * 2026-08-09 の本実行: 総件数が 6,088 になった時点で MAX_PAGES=60（6,000 件）に
 * 達して**打ち切られ**、実測が過少になり created_matches_airtable が永久に落ちた。
 * 取り込みが進むほど必ず起きる構造だった。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FN = readFileSync(
  fileURLToPath(new URL('../../../netlify/functions/admin-customer-import-job.js', import.meta.url)), 'utf8');

test('MAX_PAGES が取り込み後の総件数を数え切れる', () => {
  const m = FN.match(/const MAX_PAGES = (\d+);/);
  assert.ok(m, 'MAX_PAGES が無い');
  const pages = Number(m[1]);
  // 取り込み後の想定総件数 ≒ 1,688 + 14,279 = 15,967 → 160 ページ必要
  assert.ok(pages * 100 >= 15967, `MAX_PAGES=${pages}（${pages * 100} 件）では足りない`);
});

test('打ち切ったら例外にする（少ない配列を突合に使わない）', () => {
  const i = FN.indexOf('async function fetchAllReadOnly');
  const body = FN.slice(i, i + 1200);
  assert.match(body, /pages >= MAX_PAGES/);
  assert.match(body, /throw new Error\(/, '打ち切りを黙って return している');
  assert.ok(!/pages >= MAX_PAGES\)\s*break;/.test(body), 'break で黙って打ち切っている');
});

test('打ち切り例外のメッセージに件数の手がかりがある（PII なし）', () => {
  const i = FN.indexOf('fetch truncated');
  assert.ok(i > -1, '打ち切りメッセージが無い');
  const line = FN.slice(FN.lastIndexOf('\n', i), FN.indexOf('\n', i));
  assert.match(line, /MAX_PAGES/);
  assert.ok(!/email|Email|氏名/.test(line), 'PII が混ざっている');
});
