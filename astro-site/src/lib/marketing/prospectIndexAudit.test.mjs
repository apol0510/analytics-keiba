/**
 * prospectIndexAudit.test.mjs — **索引から丸ごと欠けている人**を検出する
 *   node --test src/lib/marketing/prospectIndexAudit.test.mjs
 *
 * 守る条件:
 *   1. 期待した hash が どの索引にも居ない なら `nowhere` として必ず出す
 *   2. アドレスを入出力に通さない
 *   3. 突き合わせは読み取りのみ（Function が書き込み命令を出していないこと）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  auditProspectIndex, normalizeHashes, safeRecordView, SAFE_RECORD_FIELDS, INDEX_PLACE,
} from './prospectIndexAudit.js';

const h = (n) => String(n).padStart(64, '0').slice(-64);
const many = (from, to) => Array.from({ length: to - from }, (_, i) => h(from + i));

/* ── 1. 欠けている人を出す ─────────────────────────────────── */

test('【要件】本番と同じ形: 期待 11,976 / 送信候補 11,975 なら nowhere を 1 件出す', () => {
  const expected = many(1, 11977);              // 11,976 件
  const active = many(1, 11976);                // 1 件足りない（11,975 件）
  const r = auditProspectIndex({ expected, active, engaged: [], blocked: [] });
  assert.equal(r.checked, 11976);
  assert.equal(r.counts.active, 11975);
  assert.equal(r.counts.nowhere, 1, '⚠️ どの索引にも居ない人を見落としている');
  assert.deepEqual(r.nowhere, [h(11976)]);
  assert.equal(r.notActive.length, 1);
  assert.equal(r.indexSizes.active, 11975);
});

test('⚠️ 反応済み・永久除外に居るなら nowhere ではない（正当な非候補と区別する）', () => {
  const r = auditProspectIndex({
    expected: [h(1), h(2), h(3), h(4)],
    active: [h(1)], engaged: [h(2)], blocked: [h(3)],
  });
  assert.equal(r.placeByHash.get(h(1)), INDEX_PLACE.ACTIVE);
  assert.equal(r.placeByHash.get(h(2)), INDEX_PLACE.ENGAGED);
  assert.equal(r.placeByHash.get(h(3)), INDEX_PLACE.BLOCKED);
  assert.equal(r.placeByHash.get(h(4)), INDEX_PLACE.NOWHERE);
  assert.deepEqual(r.nowhere, [h(4)], '⚠️ 正当な非候補まで nowhere に混ぜている');
  assert.equal(r.notActive.length, 3);
  assert.deepEqual(r.counts, {
    active: 1, engaged: 1, blocked: 1, nowhere: 1,
  });
});

test('全員が送信候補なら nowhere は 0（正常時に騒がない）', () => {
  const e = many(1, 501);
  const r = auditProspectIndex({ expected: e, active: e, engaged: [], blocked: [] });
  assert.equal(r.counts.nowhere, 0);
  assert.equal(r.counts.active, 500);
  assert.deepEqual(r.notActive, []);
  assert.deepEqual(r.unexpectedActive, []);
});

test('索引に居るが期待一覧に無い hash も出す（逆向きのズレ）', () => {
  const r = auditProspectIndex({
    expected: [h(1), h(2)], active: [h(1), h(2), h(99)], engaged: [], blocked: [],
  });
  assert.deepEqual(r.unexpectedActive, [h(99)]);
  assert.equal(r.counts.nowhere, 0);
});

test('⚠️ active と blocked の両方に居たら blocked ではなく active（送信候補かどうかが本体）', () => {
  const r = auditProspectIndex({ expected: [h(1)], active: [h(1)], blocked: [h(1)] });
  assert.equal(r.placeByHash.get(h(1)), INDEX_PLACE.ACTIVE);
  assert.equal(r.counts.nowhere, 0);
});

test('⚠️ 索引が空なら期待した全員が nowhere（fail closed 側に倒す）', () => {
  const r = auditProspectIndex({ expected: [h(1), h(2)], active: [], engaged: [], blocked: [] });
  assert.equal(r.counts.nowhere, 2);
});

test('⚠️ 引数が無くても例外にしない', () => {
  const r = auditProspectIndex();
  assert.equal(r.checked, 0);
  assert.deepEqual(r.nowhere, []);
});

/* ── 2. hash の正規化 ──────────────────────────────────────── */

test('64 桁 hex 以外は落とす（大文字は小文字へ・重複は 1 回）', () => {
  const ok = h(1);
  const r = normalizeHashes([ok, ok.toUpperCase(), 'zz', '', null, undefined, 'abc', ok, 123]);
  assert.deepEqual(r, [ok], '⚠️ 不正な hash や重複を通している（突き合わせがずれる）');
});

test('⚠️ アドレスを hash として通さない', () => {
  assert.deepEqual(normalizeHashes(['someone@example.com']), []);
});

/* ── 3. アドレスを返さない ────────────────────────────────── */

test('⚠️【要件】safeRecordView は email を絶対に返さない', () => {
  const rec = {
    email: 'someone@example.com', state: 'SENDING', sends: 2, delivered: 2, opens: 0,
    batchId: 'imp-2026-08-09-001', source: 'csv', addedAt: 1, suppressedReason: null,
  };
  const v = safeRecordView(rec);
  assert.equal('email' in v, false, '⚠️ アドレスが応答に混ざる');
  assert.equal(JSON.stringify(v).includes('@'), false);
  assert.equal(v.state, 'SENDING');
  assert.equal(v.delivered, 2);
  assert.equal(SAFE_RECORD_FIELDS.includes('email'), false);
});

test('レコードが無ければ null（「読めた空レコード」と混同しない）', () => {
  assert.equal(safeRecordView(null), null);
  assert.equal(safeRecordView(undefined), null);
  assert.equal(safeRecordView('x'), null);
});

/* ── 4. guard: Function 側 ────────────────────────────────── */

const adminSrc = readFileSync(fileURLToPath(
  new URL('../../../netlify/functions/admin-marketing.js', import.meta.url),
), 'utf8');

const handlerSrc = adminSrc.slice(
  adminSrc.indexOf('async function handleProspectIndexAudit'),
  adminSrc.indexOf('async function handleProspectSequenceCheck'),
);

test('⚠️ guard: 突き合わせ action が読み取りだけで、書き込み経路を持たない', () => {
  assert.ok(handlerSrc.length > 200, 'handler が見つからない');
  assert.match(adminSrc, /action === 'prospectIndexAudit'/);
  assert.match(handlerSrc, /sideEffects: 'none'/);
  for (const banned of [
    'addIfAbsent', 'addManyIfAbsent', 'recordSend', 'recordDelivered', 'recordEngagement',
    'purge', 'claimDelivered', 'markDelivered', 'SADD', 'SREM', 'DEL', 'SET ',
  ]) {
    assert.equal(handlerSrc.includes(banned), false, `⚠️ 書き込み経路が混ざっている: ${banned}`);
  }
});

test('⚠️ guard: 突き合わせ action はアドレスを受け取らず、hash を検証してから使う', () => {
  assert.match(handlerSrc, /normalizeHashes\(req\.hashes\)/, '⚠️ hash を検証せずに使っている');
  assert.match(handlerSrc, /safeRecordView\(/, '⚠️ 生レコードをそのまま返している（アドレスが漏れる）');
  assert.equal(/req\.email/.test(handlerSrc), false, '⚠️ アドレスを受け取っている');
});

test('⚠️ guard: 索引を読めなければ中止する（「居ない」と混同しない）', () => {
  assert.match(handlerSrc, /index_unavailable/);
});
