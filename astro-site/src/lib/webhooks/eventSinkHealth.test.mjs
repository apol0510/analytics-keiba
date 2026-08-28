/**
 * eventSinkHealth.test.mjs — 「イベントが記録されているか」の判定
 *   node --test src/lib/webhooks/eventSinkHealth.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { judgeEventSinkHealth, RECORDING, FRESH_WINDOW_MS } from './eventSinkHealth.js';

const NOW = 1_800_000_000_000;
const base = { sinkMode: 'blob', ledgerEnabled: true, nowMs: NOW };

test('blob モードでは Airtable の期待行数が 0（0 行を異常と読ませない）', () => {
  const r = judgeEventSinkHealth({ ...base, lastEventAtMs: NOW - 1000, countersAvailable: true, counters: { blob_ok: '3' } });
  assert.equal(r.expectedAirtableRows, 0);
  assert.equal(r.recording, RECORDING.OK);
});

test('airtable モードでは期待行数を決めつけない（null）', () => {
  const r = judgeEventSinkHealth({ ...base, sinkMode: 'airtable', lastEventAtMs: NOW - 1000 });
  assert.equal(r.expectedAirtableRows, null);
});

test('gate が閉じていれば disabled（異常ではない）', () => {
  const r = judgeEventSinkHealth({ ...base, ledgerEnabled: false, lastEventAtMs: NOW });
  assert.equal(r.recording, RECORDING.DISABLED);
  assert.deepEqual(r.reasons, ['ledger_gate_closed']);
});

test('blob 書き込みが全滅なら failing', () => {
  const r = judgeEventSinkHealth({
    ...base, countersAvailable: true, counters: { blob_failed: '4', blob_ok: '0' }, lastEventAtMs: NOW,
  });
  assert.equal(r.recording, RECORDING.FAILING);
  assert.ok(r.reasons.includes('blob_write_failing'));
});

test('一部失敗は degraded として理由に残しつつ ok を潰さない', () => {
  const r = judgeEventSinkHealth({
    ...base, countersAvailable: true, counters: { blob_failed: '1', blob_ok: '99' }, lastEventAtMs: NOW - 5,
  });
  assert.equal(r.recording, RECORDING.OK);
  assert.ok(r.reasons.includes('blob_write_degraded'));
});

test('受信の記録が無ければ unknown（「記録されていない」と断定しない）', () => {
  const r = judgeEventSinkHealth({ ...base, lastEventAtMs: null });
  assert.equal(r.recording, RECORDING.UNKNOWN);
  assert.ok(r.reasons.includes('no_event_observed'));
});

test('受信が古ければ stale', () => {
  const r = judgeEventSinkHealth({ ...base, lastEventAtMs: NOW - FRESH_WINDOW_MS - 1 });
  assert.equal(r.recording, RECORDING.STALE);
});

test('カウンタを読めないときは失敗と見なさない', () => {
  const r = judgeEventSinkHealth({ ...base, countersAvailable: false, counters: null, lastEventAtMs: NOW - 10 });
  assert.equal(r.recording, RECORDING.OK);
  assert.equal(r.reasons.length, 0);
});

// ── guard ────────────────────────────────────────────────────
const ADMIN = readFileSync(new URL('../../../netlify/functions/admin-marketing.js', import.meta.url), 'utf8');

test('guard: eventSinkHealth は read-only（sideEffects:none・書き込み命令を持たない）', () => {
  const i = ADMIN.indexOf('async function handleEventSinkHealth');
  assert.ok(i > 0);
  const body = ADMIN.slice(i, ADMIN.indexOf('\n}\n', i));
  assert.match(body, /sideEffects: 'none'/);
  for (const w of ['HSET', 'HINCRBY', 'SADD', 'SREM', 'DEL', 'method: \'PATCH\'', 'method: \'POST\'', 'method: \'DELETE\'']) {
    assert.equal(body.includes(w), false, `${w} を含んではいけない`);
  }
});

test('guard: EmailEvents を全件走査しない（容量対策の恒久ルール）', () => {
  const i = ADMIN.indexOf('async function handleEventSinkHealth');
  const body = ADMIN.slice(i, ADMIN.indexOf('\n}\n', i));
  assert.equal(/fetchAll\(\{[^}]*EMAIL_EVENTS_TABLE/.test(body), false);
  assert.match(body, /pageSize', '1'/);
});

test('guard: 判定は単一源へ委ねる（handler 内で再実装しない）', () => {
  assert.match(ADMIN, /judgeEventSinkHealth\(\{/);
});
